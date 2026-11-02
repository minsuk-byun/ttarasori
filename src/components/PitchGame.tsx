"use client";

import { useEffect, useRef, useState } from "react";
import { scheduleClick, scheduleTone } from "@/lib/audio/capture.ts";
import { GameJudge, type GameNote, type GameResult, type Judge } from "@/lib/audio/game.ts";
import { foldTo, livePitch, midiOf } from "@/lib/audio/livePitch.ts";

interface Props {
  title: string;
  notes: GameNote[];
  /** 같이 틀어 줄 음원 (반주+가이드). 없으면 목표 음을 합성음으로 들려줘요 */
  backing?: Blob | null;
  /** 음원과 함께 목표 음도 작게 들려줄지 */
  guideTones?: boolean;
  onFinish: (r: GameResult, seconds: number) => void;
}

const JUDGE_COLOR: Record<Judge, string> = { PERFECT: "#1d936a", GREAT: "#2f4fd8", GOOD: "#d9922c", MISS: "#d14848" };
const JUDGE_KO: Record<Judge, string> = { PERFECT: "퍼펙트", GREAT: "그레이트", GOOD: "굿", MISS: "미스" };
const PX_PER_SEC = 170;
const COUNT_IN = 3;

type Phase = "idle" | "loading" | "playing" | "done" | "error";

export default function PitchGame({ title, notes, backing, guideTones = !backing, onFinish }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState({ score: 0, combo: 0, count: 0, last: null as { judge: Judge; at: number } | null });
  const [result, setResult] = useState<GameResult | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  // 화면 크기 맞추기
  useEffect(() => {
    const el = wrap.current;
    const c = canvas.current;
    if (!el || !c) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      c.width = Math.round(el.clientWidth * dpr);
      c.height = Math.round(260 * dpr);
      c.style.height = "260px";
      drawStatic();
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  const lo = Math.min(...notes.map((n) => n.midi)) - 3;
  const hi = Math.max(...notes.map((n) => n.midi)) + 3;
  const end = Math.max(...notes.map((n) => n.start + n.dur)) + 0.8;

  function draw(now: number, trail: { t: number; m: number }[], judged: Map<number, Judge>, active: number, liveMidi: number | null) {
    const c = canvas.current;
    if (!c) return;
    const g = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    const W = c.width / dpr;
    const H = c.height / dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const headX = Math.min(160, W * 0.28);
    const x = (t: number) => headX + (t - now) * PX_PER_SEC;
    const y = (m: number) => 14 + (1 - (m - lo) / (hi - lo)) * (H - 28);
    // 배경 줄 (반음마다)
    for (let m = Math.ceil(lo); m <= hi; m++) {
      g.fillStyle = [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12) ? "rgba(27,30,60,0.04)" : "rgba(27,30,60,0)";
      g.fillRect(0, y(m + 0.5), W, y(m - 0.5) - y(m + 0.5));
    }
    // 목표 음 막대
    const bh = Math.max(10, (H - 28) / (hi - lo) * 0.8);
    notes.forEach((n, i) => {
      const x0 = x(n.start);
      const x1 = x(n.start + n.dur);
      if (x1 < -10 || x0 > W + 10) return;
      const j = judged.get(i);
      g.fillStyle = j ? JUDGE_COLOR[j] : i === active ? "#1b1e3c" : "#c9cee4";
      g.globalAlpha = j ? 0.85 : 1;
      const r = 5;
      const yy = y(n.midi) - bh / 2;
      g.beginPath();
      g.roundRect(x0, yy, Math.max(4, x1 - x0 - 2), bh, r);
      g.fill();
      g.globalAlpha = 1;
      if (n.syllable && x1 - x0 > 18) {
        g.fillStyle = j || i === active ? "#fff" : "#1b1e3c";
        g.font = "bold 13px system-ui, sans-serif";
        g.textBaseline = "middle";
        g.fillText(n.syllable, x0 + 6, y(n.midi));
      }
    });
    // 내 목소리 자취
    g.fillStyle = "#d93d76";
    for (const p of trail) {
      const px = x(p.t);
      if (px < 0 || px > headX + 2) continue;
      g.globalAlpha = Math.max(0.15, 1 - (headX - px) / headX);
      g.beginPath();
      g.arc(px, y(p.m), 3, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    // 현재 위치 선
    g.strokeStyle = "rgba(27,30,60,0.35)";
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(headX, 0);
    g.lineTo(headX, H);
    g.stroke();
    if (liveMidi != null) {
      g.fillStyle = "#d93d76";
      g.beginPath();
      g.arc(headX, y(Math.max(lo, Math.min(hi, liveMidi))), 7, 0, Math.PI * 2);
      g.fill();
    }
  }

  function drawStatic() {
    draw(-0.5, [], new Map(), -1, null);
  }

  async function start() {
    setError(null);
    setResult(null);
    setPhase("loading");
    let stream: MediaStream;
    try {
      // 반주 소리가 마이크로 다시 들어가 점수를 올리지 않게 에코 제거를 켜요
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    } catch {
      setError("마이크를 쓸 수 없어요. 주소창의 마이크 권한을 허용한 뒤 다시 눌러 주세요.");
      setPhase("error");
      return;
    }
    const ctx = new AudioContext();
    await ctx.resume();
    const an = ctx.createAnalyser();
    an.fftSize = 2048;
    const mic = ctx.createMediaStreamSource(stream);
    mic.connect(an);
    const buf = new Float32Array(an.fftSize);

    const t0 = ctx.currentTime + COUNT_IN + 0.2;
    for (let k = 0; k < COUNT_IN; k++) scheduleClick(ctx, t0 - COUNT_IN + k, k === 0);
    let src: AudioBufferSourceNode | null = null;
    if (backing) {
      try {
        const ab = await ctx.decodeAudioData(await backing.arrayBuffer());
        src = ctx.createBufferSource();
        src.buffer = ab;
        const gn = ctx.createGain();
        gn.gain.value = 0.9;
        src.connect(gn).connect(ctx.destination);
        src.start(t0);
      } catch {
        /* 음원을 못 열면 합성음으로 */
      }
    }
    if (guideTones || !src) for (const n of notes) scheduleTone(ctx, n.midi, t0 + n.start, n.dur * 0.95, src ? 0.08 : 0.2);

    const latency = (ctx.outputLatency || ctx.baseLatency || 0.02) + 0.06;
    const judge = new GameJudge(notes);
    const judgedMap = new Map<number, Judge>();
    const trail: { t: number; m: number }[] = [];
    let raf = 0;
    let lastHud = 0;
    let lastJudge: { judge: Judge; at: number } | null = null;
    let smooth: number | null = null;
    setPhase("playing");

    const stop = () => {
      cancelAnimationFrame(raf);
      try {
        src?.stop();
      } catch {
        /* 무시 */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      stopRef.current = null;
    };
    stopRef.current = () => {
      stop();
      setPhase("idle");
    };

    const frame = () => {
      const now = ctx.currentTime - t0;
      an.getFloatTimeDomainData(buf);
      const hz = livePitch(buf, ctx.sampleRate);
      const tSing = now - latency;
      // 지금 부를 음 (또는 다음 음) 기준으로 옥타브 맞추기
      const target = notes.find((n) => n.start + n.dur > tSing) ?? notes[notes.length - 1];
      let m: number | null = hz ? foldTo(midiOf(hz), target.midi) : null;
      if (m != null) {
        smooth = smooth == null || Math.abs(m - smooth) > 1 ? m : smooth * 0.6 + m * 0.4;
        m = smooth;
        trail.push({ t: now, m });
        if (trail.length > 400) trail.shift();
      } else smooth = null;
      for (const j of judge.feed(tSing, m)) {
        judgedMap.set(j.index, j.judge);
        lastJudge = { judge: j.judge, at: performance.now() };
      }
      const active = notes.findIndex((n) => now >= n.start && now < n.start + n.dur);
      draw(now, trail, judgedMap, active, m);
      if (performance.now() - lastHud > 90) {
        lastHud = performance.now();
        setHud({ score: judge.liveScore(), combo: judge.combo, count: now < 0 ? Math.ceil(-now) : 0, last: lastJudge });
      }
      if (now > end + latency) {
        stop();
        const r = judge.result();
        setResult(r);
        setPhase("done");
        onFinish(r, end + COUNT_IN);
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
  }

  const showJudge = hud.last && performance.now() - hud.last.at < 700;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{title}</div>
          <div className="text-sm text-muted">흘러오는 막대 높이에 맞춰 불러요. 분홍 점이 내 목소리예요.</div>
        </div>
        {phase === "playing" ? (
          <button onClick={() => stopRef.current?.()} className="rounded-xl border border-line px-4 py-2 font-semibold">
            그만하기
          </button>
        ) : (
          <button
            onClick={start}
            disabled={phase === "loading"}
            className="rounded-xl bg-mine px-5 py-2.5 font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {phase === "loading" ? "준비 중" : result ? "다시 도전" : "게임 시작"}
          </button>
        )}
      </div>

      <div ref={wrap} className="relative mt-3 overflow-hidden rounded-xl bg-paper">
        <canvas ref={canvas} className="block w-full" aria-label="음정 게임 화면" />
        {phase === "playing" && (
          <>
            <div className="pointer-events-none absolute right-3 top-2 text-right">
              <div className="text-2xl font-bold tabular-nums">{hud.score}</div>
              {hud.combo >= 3 && <div className="text-sm font-bold text-mine">{hud.combo} 콤보</div>}
            </div>
            {hud.count > 0 && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-6xl font-bold text-ink/70">{hud.count}</div>
            )}
            {showJudge && hud.last && (
              <div
                className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 text-xl font-extrabold"
                style={{ color: JUDGE_COLOR[hud.last.judge] }}
              >
                {JUDGE_KO[hud.last.judge]}
              </div>
            )}
          </>
        )}
      </div>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      <p className="mt-2 text-xs text-muted">이어폰을 끼면 더 정확해요. 남녀 음역이 달라도 옥타브를 맞춰서 판정해요.</p>

      {result && (
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl bg-ink p-4 text-white">
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-bold tabular-nums">{result.score}</span>
            <span className="text-white/60">점</span>
            <span className="ml-1 text-2xl tracking-widest text-[#f5c542]" aria-label={`별 ${result.stars}개`}>
              {"★".repeat(result.stars)}
              <span className="text-white/25">{"★".repeat(3 - result.stars)}</span>
            </span>
          </div>
          <div className="flex flex-wrap gap-3 text-sm">
            {(Object.keys(JUDGE_KO) as Judge[]).map((k) => (
              <span key={k}>
                <b style={{ color: k === "MISS" ? "#ff8a8a" : k === "GOOD" ? "#f5c542" : k === "GREAT" ? "#9fb3ff" : "#7ee0b5" }}>{JUDGE_KO[k]}</b>{" "}
                {result.counts[k]}
              </span>
            ))}
            <span>
              최대 콤보 <b>{result.maxCombo}</b>
            </span>
          </div>
          <p className="w-full text-sm text-white/75">
            {result.score >= 88
              ? "완벽해요! 다음엔 더 어려운 곡에 도전해 보세요."
              : Math.abs(result.offsetCents) >= 25
                ? `전체적으로 음이 ${result.offsetCents < 0 ? "낮아요. 살짝 위에서 내려 잡는 느낌으로" : "높아요. 힘을 빼고"} 다시 도전해 보세요.`
                : result.weak.missing > result.counts.PERFECT / 2
                  ? "소리가 빠진 음이 많아요. 막대가 지나가는 동안 끝까지 소리를 내 보세요."
                  : "조금만 더! 미스가 난 막대 높이를 기억하고 다시 도전해 보세요."}
          </p>
        </div>
      )}
    </div>
  );
}
