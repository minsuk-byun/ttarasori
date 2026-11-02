"use client";

import { useEffect, useRef, useState } from "react";
import { compareFeatures, type Segment } from "@/lib/audio/compare.ts";
import { decodeToMono } from "@/lib/audio/decode.ts";
import { extractFeatures, type Features } from "@/lib/audio/features.ts";
import { SAMPLE_RATE } from "@/lib/audio/synth.ts";
import { scoreColor } from "@/components/Charts";
import type { Player } from "@/lib/usePlayer";

interface Props {
  seg: Segment;
  refFeatures: Features;
  /** 다시 부를 때 틀어 줄 음원 (반주 포함 연습곡이면 그걸, 없으면 가이드) */
  backing: Blob;
  /** 음만 듣기용 목표 음 (가이드 기준 시간) */
  tones: { midi: number; start: number; dur: number }[];
  player: Player;
}

interface Attempt {
  n: number;
  score: number;
  note: string;
  url: string;
}

const SPEEDS = [1, 0.85, 0.7];
const PRE_ROLL = 2; // 다시 부르기 전에 앞부분을 2초 들려줘요

function sliceFeatures(f: Features, t0: number, t1: number): Features {
  const i0 = Math.max(0, Math.round(t0 / f.hopSec));
  const i1 = Math.min(f.f0.length, Math.round(t1 / f.hopSec));
  return { hopSec: f.hopSec, f0: f.f0.slice(i0, i1), db: f.db.slice(i0, i1), duration: (i1 - i0) * f.hopSec };
}

/** 목표 음을 순수한 소리(삼각파)로 들려주기 */
function playTones(tones: Props["tones"], from: number, to: number, rate: number, onEnd: () => void) {
  const ctx = new AudioContext();
  const t0 = ctx.currentTime + 0.05;
  for (const n of tones) {
    const a = Math.max(n.start, from);
    const b = Math.min(n.start + n.dur, to);
    if (b - a < 0.05) continue;
    const s = t0 + (a - from) / rate;
    const e = t0 + (b - from) / rate;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 440 * 2 ** ((n.midi - 69) / 12);
    g.gain.setValueAtTime(0, s);
    g.gain.linearRampToValueAtTime(0.25, s + 0.02);
    g.gain.setValueAtTime(0.25, Math.max(s + 0.02, e - 0.04));
    g.gain.linearRampToValueAtTime(0, e);
    osc.connect(g).connect(ctx.destination);
    osc.start(s);
    osc.stop(e + 0.02);
  }
  const ms = ((to - from) / rate) * 1000 + 150;
  const timer = window.setTimeout(() => {
    void ctx.close();
    onEnd();
  }, ms);
  return () => {
    clearTimeout(timer);
    void ctx.close();
  };
}

/** 고른 구간만 반복해서 듣고, 다시 불러서 점수가 오르는지 바로 확인 */
export default function RepeatPractice({ seg, refFeatures, backing, tones, player }: Props) {
  const [speed, setSpeed] = useState(1);
  const [mode, setMode] = useState<"idle" | "loop" | "tones" | "ready" | "recording" | "scoring">("idle");
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const cleanup = useRef<(() => void) | null>(null);
  const from = Math.max(0, seg.start - 0.4);
  const to = seg.end + 0.3;

  const stopAll = () => {
    cleanup.current?.();
    cleanup.current = null;
    player.stop();
    setMode("idle");
  };

  // 다른 구간으로 바꾸면 기록·재생 초기화
  useEffect(() => {
    stopAll();
    setAttempts((a) => {
      a.forEach((x) => URL.revokeObjectURL(x.url));
      return [];
    });
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seg.index]);
  useEffect(() => () => cleanup.current?.(), []);

  const loop = () => {
    if (mode === "loop") return stopAll();
    stopAll();
    setMode("loop");
    player.play("guide", from, to, { loop: true, rate: speed });
  };

  const tonesOnly = () => {
    if (mode === "tones") return stopAll();
    stopAll();
    setMode("tones");
    cleanup.current = playTones(tones, from, to, speed, () => setMode("idle"));
  };

  async function sing() {
    stopAll();
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      setError("마이크를 쓸 수 없어요. 주소창의 마이크 권한을 허용한 뒤 다시 눌러 주세요.");
      return;
    }
    const start = Math.max(0, seg.start - PRE_ROLL);
    const end = seg.end + 0.6;
    const url = URL.createObjectURL(backing);
    const audio = new Audio(url);
    const mr = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let raf = 0;
    const finish = () => {
      cancelAnimationFrame(raf);
      audio.pause();
      if (mr.state !== "inactive") mr.stop();
      stream.getTracks().forEach((t) => t.stop());
      URL.revokeObjectURL(url);
      cleanup.current = null;
    };
    cleanup.current = () => {
      mr.onstop = null;
      finish();
    };
    mr.onstop = async () => {
      setMode("scoring");
      try {
        const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
        const x = await decodeToMono(blob);
        const uf = await extractFeatures(x, SAMPLE_RATE);
        // 녹음은 음악 재생과 동시에 시작하니 시간차는 마이크 지연(녹음이 0~0.45초 늦음)만 찾으면 돼요
        // 앞부분(듣기만 하는 2초)은 빼고 연습 구간 바로 앞부터 비교
        const from0 = Math.max(start, seg.start - 0.3);
        const c = compareFeatures(sliceFeatures(refFeatures, from0, end), sliceFeatures(uf, from0 - start, uf.duration), {
          minLagSec: -0.1,
          maxLagSec: 0.45,
        });
        // 연습 구간과 겹치는 프레이즈만 점수에 반영
        const a = seg.start - from0;
        const b = seg.end - from0;
        const inSeg = c.segments.filter((s) => s.end > a && s.start < b);
        const voiced = c.userMidi.some((v) => v != null);
        let score = 0;
        let note = "소리가 거의 들리지 않았어요. 마이크 가까이에서 다시 불러 보세요.";
        if (inSeg.length && voiced) {
          const len = inSeg.reduce((s, g) => s + (g.end - g.start), 0) || 1;
          score = Math.round(inSeg.reduce((s, g) => s + g.score * (g.end - g.start), 0) / len);
          const top = inSeg.flatMap((g) => g.issues).sort((p, q) => q.severity - p.severity)[0];
          note = top ? (top.kind === "good" ? "잘 불렀어요" : top.title) : "잘 불렀어요";
        }
        setAttempts((all) => [...all, { n: all.length + 1, score, note, url: URL.createObjectURL(blob) }]);
      } catch {
        setError("녹음을 분석하지 못했어요. 다시 한번 불러 주세요.");
      }
      setMode("idle");
    };

    audio.currentTime = start;
    setMode("ready");
    mr.start();
    void audio.play();
    const tick = () => {
      const t = audio.currentTime;
      if (t < seg.start) {
        setLeft(Math.max(0, seg.start - t));
        setMode("ready");
      } else setMode("recording");
      if (t >= end || audio.ended) {
        finish();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  const best = attempts.length ? Math.max(...attempts.map((a) => a.score)) : null;
  const busy = mode === "ready" || mode === "recording" || mode === "scoring";

  return (
    <div className="mt-6 rounded-xl bg-paper p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">구간 반복 연습</h3>
        <div className="ml-auto flex items-center gap-1 text-sm" role="group" aria-label="재생 속도">
          {SPEEDS.map((s) => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              disabled={busy}
              className={`rounded-md px-2.5 py-1 font-semibold ${speed === s ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
            >
              {s === 1 ? "보통" : `${s}배`}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={loop}
          disabled={busy}
          className="rounded-lg bg-guide px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          {mode === "loop" ? "반복 멈추기" : "AI 커버 반복 듣기"}
        </button>
        <button
          onClick={tonesOnly}
          disabled={busy || !tones.length}
          className="rounded-lg border border-line bg-surface px-4 py-2 text-sm font-semibold hover:border-ink disabled:opacity-40"
        >
          {mode === "tones" ? "멈추기" : "음만 듣기"}
        </button>
        <button
          onClick={busy ? stopAll : sing}
          disabled={mode === "scoring"}
          className="rounded-lg bg-mine px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          {mode === "ready" || mode === "recording" ? "그만 부르기" : mode === "scoring" ? "채점 중" : "이 구간 다시 불러 보기"}
        </button>
      </div>

      {mode === "ready" && (
        <p className="mt-3 font-semibold text-mine" role="status">
          준비하세요… {left.toFixed(1)}초 뒤 시작
        </p>
      )}
      {mode === "recording" && (
        <p className="mt-3 flex items-center gap-2 font-semibold text-mine" role="status">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-mine" aria-hidden /> 지금 부르세요
        </p>
      )}
      <p className="mt-2 text-xs text-muted">
        다시 부를 때는 앞부분 {PRE_ROLL}초를 먼저 들려줘요. 이어폰을 끼면 음악 소리가 녹음에 섞이지 않아 더 정확해요. 다시 부르기는 항상 보통 속도예요.
      </p>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}

      {attempts.length > 0 && (
        <div className="mt-4">
          <div className="flex items-baseline gap-2 text-sm">
            <span className="text-muted">처음 점수</span>
            <span className="font-bold tabular-nums" style={{ color: scoreColor(seg.score) }}>
              {seg.score}점
            </span>
            {best != null && (
              <>
                <span className="text-muted">→ 최고</span>
                <span className="font-bold tabular-nums" style={{ color: scoreColor(best) }}>
                  {best}점
                </span>
                <span className={`font-semibold ${best >= seg.score ? "text-good" : "text-bad"}`}>
                  ({best >= seg.score ? "+" : ""}
                  {best - seg.score})
                </span>
              </>
            )}
          </div>
          <ul className="mt-2 divide-y divide-line rounded-lg bg-surface">
            {attempts
              .slice()
              .reverse()
              .map((a) => (
                <li key={a.n} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <span className="w-10 text-muted">{a.n}번째</span>
                  <span className="w-12 text-lg font-bold tabular-nums" style={{ color: scoreColor(a.score) }}>
                    {a.score}
                  </span>
                  <span className="min-w-0 flex-1">{a.note}</span>
                  <audio src={a.url} controls className="h-8 w-48 max-w-full" />
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
