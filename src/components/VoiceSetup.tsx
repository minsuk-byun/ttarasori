"use client";

import { useEffect, useRef, useState } from "react";
import GuidedRecorder from "@/components/GuidedRecorder";
import { decodeToMono } from "@/lib/audio/decode.ts";
import { extractFeatures } from "@/lib/audio/features.ts";
import { SAMPLE_RATE } from "@/lib/audio/synth.ts";
import { getSample } from "@/lib/samples";
import { setRegisteredVoice, type AudioSource } from "@/lib/store";
import { clearVoice, loadVoice, saveVoice } from "@/lib/voiceStore";

/** 따라소리가 쓴 읽기 문장 (모음과 받침을 고르게 담았어요) */
const SCRIPT = [
  "안녕하세요. 오늘은 제 목소리를 등록하고 있어요.",
  "맑은 하늘 아래에서 노래를 부르면 기분이 좋아져요.",
  "아, 에, 이, 오, 우. 하나, 둘, 셋, 넷, 다섯!",
];
const TARGET = 15; // 초
const MAX = 20;

interface Check {
  ok: boolean;
  voicedSec: number;
  issues: string[];
}

/** 녹음이 목소리 등록에 쓸 만한지 확인 */
async function checkVoice(blob: Blob): Promise<Check> {
  const x = await decodeToMono(blob);
  const f = await extractFeatures(x, SAMPLE_RATE);
  const voicedSec = Array.from(f.f0).filter((v) => v > 0).length * f.hopSec;
  let clip = 0;
  let peak = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > 0.98) clip++;
    if (a > peak) peak = a;
  }
  const issues: string[] = [];
  if (voicedSec < 5) issues.push(`목소리가 ${voicedSec.toFixed(0)}초만 들렸어요. 5초 넘게 소리 내 주세요.`);
  if (peak < 0.05) issues.push("소리가 너무 작아요. 마이크에 조금 더 가까이 대고 말해 주세요.");
  if (clip / x.length > 0.005) issues.push("소리가 너무 커서 찌그러졌어요. 마이크에서 조금 떨어져 주세요.");
  return { ok: issues.length === 0, voicedSec, issues };
}

type Mode =
  | { kind: "loading" }
  | { kind: "empty" }
  | { kind: "read"; phase: "count" | "rec"; n: number; elapsed: number; level: number }
  | { kind: "sing" }
  | { kind: "checking" }
  | { kind: "problem"; check: Check; blob: Blob; name: string }
  | { kind: "ready" };

/**
 * 내 목소리 등록 (커버·연습곡 공용)
 * 15초 읽기 → 자동 확인 → 바로 등록 + 브라우저에 저장. 노래로 따라 부르기·파일 올리기도 할 수 있어요.
 */
export default function VoiceSetup({ value, onChange }: { value: AudioSource | null; onChange: (v: AudioSource | null) => void }) {
  const [mode, setMode] = useState<Mode>({ kind: "loading" });
  const [meta, setMeta] = useState<{ createdAt: number; voicedSec: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const doneRef = useRef<(() => void) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 저장된 목소리 불러오기
  useEffect(() => {
    let alive = true;
    if (value) {
      setMode({ kind: "ready" });
      // 이미 받은 목소리가 저장된 것과 같으면 등록 날짜도 보여 줘요
      loadVoice().then((v) => alive && v && v.blob.size === value.blob.size && setMeta({ createdAt: v.createdAt, voicedSec: v.voicedSec }));
      return () => {
        alive = false;
      };
    }
    loadVoice().then((v) => {
      if (!alive) return;
      if (v) {
        const src: AudioSource = { name: v.name, blob: v.blob, origin: "record" };
        setMeta({ createdAt: v.createdAt, voicedSec: v.voicedSec });
        setRegisteredVoice(src);
        onChange(src);
        setMode({ kind: "ready" });
      } else setMode({ kind: "empty" });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!value) return setUrl(null);
    const u = URL.createObjectURL(value.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [value]);

  useEffect(() => () => stopRef.current?.(), []);

  async function register(blob: Blob, name: string, force = false) {
    setMode({ kind: "checking" });
    let check: Check;
    try {
      check = await checkVoice(blob);
    } catch {
      setError("녹음을 열지 못했어요. 다시 녹음하거나 다른 파일을 올려 주세요.");
      setMode({ kind: "empty" });
      return;
    }
    if (!check.ok && !force) {
      setMode({ kind: "problem", check, blob, name });
      return;
    }
    const createdAt = Date.now();
    await saveVoice({ blob, name, createdAt, voicedSec: check.voicedSec });
    const src: AudioSource = { name, blob, origin: "record" };
    setMeta({ createdAt, voicedSec: check.voicedSec });
    setRegisteredVoice(src);
    onChange(src);
    setMode({ kind: "ready" });
  }

  async function startReading() {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      setError("마이크를 쓸 수 없어요. 주소창의 마이크 권한을 허용한 뒤 다시 눌러 주세요.");
      return;
    }
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const mr = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    let raf = 0;
    let cancelled = false;
    const finish = () => {
      cancelAnimationFrame(raf);
      if (mr.state !== "inactive") mr.stop();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      stopRef.current = null;
    };
    stopRef.current = () => {
      cancelled = true;
      finish();
    };
    mr.onstop = () => {
      if (!cancelled) void register(new Blob(chunks, { type: mr.mimeType || "audio/webm" }), "읽기 녹음");
    };
    // 3, 2, 1 뒤에 녹음
    const t0 = performance.now();
    let started = 0;
    const tick = () => {
      const s = (performance.now() - t0) / 1000;
      an.getFloatTimeDomainData(buf);
      let e = 0;
      for (const v of buf) e += v * v;
      const level = Math.min(1, Math.sqrt(e / buf.length) * 6);
      if (s < 3) setMode({ kind: "read", phase: "count", n: 3 - Math.floor(s), elapsed: 0, level });
      else {
        if (!started) {
          started = performance.now();
          mr.start();
        }
        const el = (performance.now() - started) / 1000;
        setMode({ kind: "read", phase: "rec", n: 0, elapsed: el, level });
        if (el >= MAX) {
          finish();
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // '완료'를 누르면 녹음을 마치고 바로 확인·등록
    doneRef.current = () => finish();
  }

  const btn = "rounded-lg border border-line bg-paper px-3 py-2 text-sm font-semibold hover:border-ink";

  if (mode.kind === "loading") return <p className="text-sm text-muted">불러오는 중</p>;

  if (mode.kind === "ready" && value) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border-l-4 border-good bg-surface p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-good text-sm font-bold text-white" aria-hidden>
          ✓
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">내 목소리가 등록돼 있어요</div>
          <div className="text-sm text-muted">
            {value.name}
            {meta ? ` · ${new Date(meta.createdAt).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })} 등록 · 목소리 ${Math.round(meta.voicedSec)}초` : ""}
            {" · 이 브라우저에 저장돼서 다음에도 그대로 써요"}
          </div>
        </div>
        {url && <audio src={url} controls className="h-9 w-full max-w-xs" />}
        <button
          onClick={async () => {
            await clearVoice();
            setRegisteredVoice(null);
            onChange(null);
            setMeta(null);
            setMode({ kind: "empty" });
          }}
          className={btn}
        >
          다시 등록
        </button>
      </div>
    );
  }

  if (mode.kind === "read") {
    const left = Math.max(0, TARGET - mode.elapsed);
    return (
      <div className="rounded-2xl bg-ink p-5 text-white" role="status" aria-live="polite">
        <div className="flex items-center gap-3">
          <span className="text-sm text-white/60">{mode.phase === "count" ? "곧 녹음이 시작돼요" : left > 0 ? `${Math.ceil(left)}초만 더 읽어 주세요` : "좋아요! 완료를 눌러 주세요"}</span>
          <button onClick={() => (stopRef.current?.(), setMode({ kind: "empty" }))} className="ml-auto rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
            취소
          </button>
        </div>
        {mode.phase === "count" ? (
          <div className="py-8 text-center text-6xl font-bold">{mode.n}</div>
        ) : (
          <>
            <div className="mt-4 space-y-2 text-xl font-semibold leading-relaxed sm:text-2xl">
              {SCRIPT.map((l) => (
                <p key={l}>{l}</p>
              ))}
            </div>
            <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-mine transition-[width]" style={{ width: `${Math.min(100, (mode.elapsed / TARGET) * 100)}%` }} />
            </div>
            <div className="mt-4 flex items-center gap-3">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-mine" aria-hidden />
              <span className="text-sm text-white/70">{mode.level > 0.08 ? "목소리가 잘 들려요" : "조금 더 크게, 말하듯 편하게 읽어 주세요"}</span>
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10" aria-hidden>
                <div className="h-full bg-white/70" style={{ width: `${mode.level * 100}%` }} />
              </div>
              <button
                onClick={() => doneRef.current?.()}
                disabled={mode.elapsed < 8}
                className="ml-auto rounded-lg bg-white px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
              >
                완료
              </button>
            </div>
          </>
        )}
      </div>
    );
  }

  if (mode.kind === "sing") {
    return <GuidedRecorder onDone={(blob) => void register(blob, "따라 부르기 녹음")} onCancel={() => setMode({ kind: "empty" })} />;
  }

  if (mode.kind === "checking") return <p className="rounded-2xl bg-surface p-4 text-sm text-muted">녹음을 확인하는 중…</p>;

  if (mode.kind === "problem") {
    return (
      <div className="rounded-2xl border-l-4 border-warn bg-surface p-4">
        <div className="font-semibold">녹음을 한 번 더 해 볼까요?</div>
        <ul className="mt-1 list-disc pl-5 text-sm text-muted">
          {mode.check.issues.map((i) => (
            <li key={i}>{i}</li>
          ))}
        </ul>
        <div className="mt-3 flex flex-wrap gap-2">
          <button onClick={startReading} className="rounded-lg bg-mine px-4 py-2 text-sm font-semibold text-white">
            다시 녹음
          </button>
          <button onClick={() => void register(mode.blob, mode.name, true)} className={btn}>
            그래도 이걸로 등록
          </button>
        </div>
      </div>
    );
  }

  // 아직 등록 안 함
  return (
    <div className="rounded-2xl border-l-4 border-mine bg-surface p-5">
      <h3 className="text-[17px] font-semibold">내 목소리 등록</h3>
      <p className="mt-1 text-sm leading-relaxed text-muted">
        화면에 나오는 짧은 글을 <b className="text-ink">15초만 읽으면</b> 끝나요. 노래를 못 불러도 괜찮아요. 한 번 등록하면 이 브라우저에 저장돼서 다음에도 그대로 써요.
      </p>
      <button onClick={startReading} className="mt-4 w-full rounded-xl bg-mine px-5 py-3.5 text-base font-semibold text-white hover:brightness-110 sm:w-auto">
        15초 읽고 등록하기
      </button>
      <div className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2 text-sm">
        <span className="text-muted">다른 방법:</span>
        <button onClick={() => setMode({ kind: "sing" })} className="rounded-md px-2 py-1 font-semibold text-mine hover:bg-mine-soft">
          노래로 따라 부르기 (조금 더 정확)
        </button>
        <button onClick={() => fileRef.current?.click()} className="rounded-md px-2 py-1 font-semibold text-ink hover:bg-key">
          녹음 파일 올리기
        </button>
        <button
          onClick={() => {
            const s = getSample("mine");
            setRegisteredVoice(s);
            onChange(s);
            setMeta(null);
            setMode({ kind: "ready" });
          }}
          className="rounded-md px-2 py-1 font-semibold text-guide hover:bg-guide-soft"
        >
          샘플 목소리로 체험
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void register(f, f.name.replace(/\.[a-z0-9]+$/i, ""));
          e.target.value = "";
        }}
      />
    </div>
  );
}
