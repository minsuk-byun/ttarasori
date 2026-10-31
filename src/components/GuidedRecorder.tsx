"use client";

import { useEffect, useRef, useState } from "react";
import { GUIDE_PHRASES, beatSec, phraseSeconds, renderCue, renderPhrase } from "@/lib/audio/guide.ts";

type Range = "low" | "high";
type Stage = { kind: "idle" } | { kind: "run"; phrase: number; mode: "listen" | "sing"; startedAt: number } | { kind: "done" };

const SING_PAD = 0.9; // 내 차례에 소절 길이보다 여유를 주는 시간(초)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 가이드를 듣고 → 신호음 → 따라 부르기를 소절마다 반복하며 녹음.
 * 가이드가 나오는 동안에는 녹음을 멈춰서, 이어폰 없이도 가이드 소리가 섞이지 않아요.
 */
export default function GuidedRecorder({ onDone, onCancel }: { onDone: (blob: Blob) => void; onCancel: () => void }) {
  const [range, setRange] = useState<Range>("low");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [now, setNow] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<(() => void) | null>(null);

  useEffect(() => () => abort.current?.(), []);

  useEffect(() => {
    if (stage.kind !== "run") return;
    let raf = 0;
    const tick = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [stage.kind]);

  async function start() {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      setError("마이크를 쓸 수 없어요. 브라우저 주소창의 마이크 권한을 허용한 뒤 다시 눌러 주세요.");
      return;
    }

    const ctx = new AudioContext();
    const shift = range === "low" ? -12 : 0;
    const guides = GUIDE_PHRASES.map((p) => {
      const data = renderPhrase(p, ctx.sampleRate, shift);
      const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.getChannelData(0).set(data);
      return buf;
    });
    const cueData = renderCue(ctx.sampleRate);
    const cue = ctx.createBuffer(1, cueData.length, ctx.sampleRate);
    cue.getChannelData(0).set(cueData);

    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const meterBuf = new Float32Array(an.fftSize);
    let meterRaf = 0;
    const meter = () => {
      an.getFloatTimeDomainData(meterBuf);
      let s = 0;
      for (const v of meterBuf) s += v * v;
      setLevel(Math.min(1, Math.sqrt(s / meterBuf.length) * 6));
      meterRaf = requestAnimationFrame(meter);
    };
    meter();

    const mr = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    let cancelled = false;
    const play = (buf: AudioBuffer) =>
      new Promise<void>((res) => {
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.onended = () => res();
        src.start();
      });
    const cleanup = () => {
      cancelAnimationFrame(meterRaf);
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      setLevel(0);
    };
    abort.current = () => {
      cancelled = true;
      if (mr.state !== "inactive") mr.stop();
      cleanup();
    };

    mr.start();
    mr.pause();
    await sleep(400);

    for (let i = 0; i < GUIDE_PHRASES.length; i++) {
      if (cancelled) return;
      setStage({ kind: "run", phrase: i, mode: "listen", startedAt: performance.now() });
      await play(guides[i]);
      if (cancelled) return;
      await play(cue);
      setStage({ kind: "run", phrase: i, mode: "sing", startedAt: performance.now() });
      mr.resume();
      await sleep((phraseSeconds(GUIDE_PHRASES[i]) + SING_PAD) * 1000);
      mr.pause();
      if (cancelled) return;
      await sleep(350);
    }

    await new Promise<void>((res) => {
      mr.onstop = () => res();
      mr.stop();
    });
    cleanup();
    abort.current = null;
    const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
    setStage({ kind: "done" });
    onDone(blob);
  }

  function cancel() {
    abort.current?.();
    abort.current = null;
    setStage({ kind: "idle" });
    onCancel();
  }

  if (stage.kind === "idle" || stage.kind === "done") {
    return (
      <div className="rounded-2xl border-l-4 border-mine bg-surface p-5">
        <h3 className="text-[17px] font-semibold">따라 부르며 녹음하기</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          짧은 소절을 들려 드리면 바로 이어서 따라 불러 주세요. 다섯 소절이고 1분이면 끝나요. 가이드가 나올 때는 녹음이 멈춰서
          이어폰이 없어도 괜찮아요.
        </p>
        <fieldset className="mt-4">
          <legend className="text-sm font-semibold">내 목소리 높이</legend>
          <div className="mt-2 flex gap-2">
            {(
              [
                ["low", "낮은 목소리", "남성 음역"],
                ["high", "높은 목소리", "여성 음역"],
              ] as const
            ).map(([v, label, sub]) => (
              <label
                key={v}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                  range === v ? "border-mine bg-mine-soft" : "border-line"
                }`}
              >
                <input type="radio" name="range" value={v} checked={range === v} onChange={() => setRange(v)} className="accent-mine" />
                <span className="font-semibold">{label}</span>
                <span className="text-muted">{sub}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={start} className="rounded-lg bg-mine px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110">
            따라 부르기 시작
          </button>
          <button onClick={cancel} className="rounded-lg px-3 py-2.5 text-sm font-semibold text-muted hover:text-ink">
            다른 방법으로 등록
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      </div>
    );
  }

  const phrase = GUIDE_PHRASES[stage.phrase];
  const elapsed = Math.max(0, (now - stage.startedAt) / 1000);
  const listen = stage.mode === "listen";
  // 지금 몇 번째 음인지 (따라 부를 때도 같은 박자로 표시)
  let acc = 0;
  let active = -1;
  for (let k = 0; k < phrase.notes.length; k++) {
    const d = phrase.notes[k].beats * beatSec();
    if (elapsed >= acc && elapsed < acc + d) active = k;
    acc += d;
  }
  const turnLen = listen ? phraseSeconds(phrase) : phraseSeconds(phrase) + SING_PAD;
  const progress = Math.min(1, elapsed / turnLen);

  return (
    <div className="rounded-2xl bg-ink p-5 text-white" role="status" aria-live="polite">
      <div className="flex items-center gap-3">
        <span className="text-sm text-white/60">
          {stage.phrase + 1}/{GUIDE_PHRASES.length}소절, {phrase.title}
        </span>
        <button onClick={cancel} className="ml-auto rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
          그만하기
        </button>
      </div>

      <div className={`mt-4 text-lg font-bold ${listen ? "text-[#9fb0ff]" : "text-[#ff9bbf]"}`}>
        {listen ? "잘 들어 보세요" : "지금 따라 불러 주세요"}
      </div>

      <div className="mt-4 flex flex-wrap gap-2" aria-label="부를 가사">
        {phrase.notes.map((note, k) => (
          <span
            key={k}
            className={`grid min-w-12 place-items-center rounded-xl px-3 py-3 text-2xl font-bold transition-colors ${
              k === active ? (listen ? "bg-guide text-white" : "bg-mine text-white") : "bg-white/10 text-white/70"
            }`}
            style={{ flexGrow: note.beats }}
          >
            {note.syllable}
          </span>
        ))}
      </div>

      <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full ${listen ? "bg-guide" : "bg-mine"}`} style={{ width: `${progress * 100}%` }} />
      </div>

      <div className="mt-4 flex items-center gap-2 text-sm text-white/60">
        <span className={`h-2.5 w-2.5 rounded-full ${listen ? "bg-white/30" : "animate-pulse bg-mine"}`} aria-hidden />
        {listen ? "녹음 멈춤" : "녹음 중"}
        <div className="ml-2 h-1.5 w-28 overflow-hidden rounded-full bg-white/10" aria-hidden>
          <div className="h-full bg-white/70" style={{ width: `${(listen ? 0 : level) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
