"use client";

import { useEffect, useRef, useState } from "react";
import type { AudioSource } from "@/lib/store";

interface Props {
  label: string;
  hint: string;
  tone: "guide" | "mine";
  value: AudioSource | null;
  onChange: (v: AudioSource | null) => void;
  allowRecord?: boolean;
  /** 녹음하는 동안 함께 틀어 줄 가이드 음원 */
  playAlong?: AudioSource | null;
  /** 저장된 음원에서 고르기 버튼을 눌렀을 때 */
  onOpenLibrary?: () => void;
}

export default function AudioInput({ label, hint, tone, value, onChange, allowRecord, playAlong, onOpenLibrary }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<"idle" | "recording">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [withGuide, setWithGuide] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<{ stop: () => void } | null>(null);

  useEffect(() => {
    if (!value) return setUrl(null);
    const u = URL.createObjectURL(value.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [value]);

  useEffect(() => () => rec.current?.stop(), []);

  const accent = tone === "guide" ? "border-guide" : "border-mine";
  const dot = tone === "guide" ? "bg-guide" : "bg-mine";

  async function startRecording() {
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
    const mr = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    let raf = 0;
    const started = performance.now();
    const tick = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      setLevel(Math.min(1, Math.sqrt(s / buf.length) * 6));
      setElapsed((performance.now() - started) / 1000);
      raf = requestAnimationFrame(tick);
    };

    let guideAudio: HTMLAudioElement | null = null;
    let guideUrl: string | null = null;
    if (withGuide && playAlong) {
      guideUrl = URL.createObjectURL(playAlong.blob);
      guideAudio = new Audio(guideUrl);
      guideAudio.onended = () => rec.current?.stop();
    }

    const stop = () => {
      if (mr.state !== "inactive") mr.stop();
      cancelAnimationFrame(raf);
      stream.getTracks().forEach((t) => t.stop());
      ctx.close();
      guideAudio?.pause();
      if (guideUrl) URL.revokeObjectURL(guideUrl);
      setMode("idle");
      setLevel(0);
      rec.current = null;
    };
    mr.onstop = () => {
      const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
      if (blob.size) onChange({ name: "my-recording", blob, origin: "record" });
    };
    rec.current = { stop };
    mr.start();
    guideAudio?.play();
    setMode("recording");
    tick();
  }

  return (
    <section className={`rounded-2xl border-l-4 ${accent} bg-surface p-5 shadow-[0_1px_0_var(--color-line)]`}>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${dot}`} aria-hidden />
        <h3 className="text-[17px] font-semibold">{label}</h3>
      </div>
      <p className="mt-1 text-sm text-muted">{hint}</p>

      {mode === "recording" ? (
        <div className="mt-4 rounded-xl bg-mine-soft p-4">
          <div className="flex items-center gap-3">
            <span className="h-3 w-3 animate-pulse rounded-full bg-mine" aria-hidden />
            <span className="font-semibold tabular-nums">녹음 중 {elapsed.toFixed(1)}초</span>
            <button onClick={() => rec.current?.stop()} className="ml-auto rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white">
              녹음 끝내기
            </button>
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white">
            <div className="h-full bg-mine transition-[width] duration-75" style={{ width: `${level * 100}%` }} />
          </div>
        </div>
      ) : value ? (
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="truncate font-medium">{value.name}</span>
            <button onClick={() => onChange(null)} className="ml-auto shrink-0 text-muted underline-offset-2 hover:text-ink hover:underline">
              다시 고르기
            </button>
          </div>
          {url && <audio src={url} controls className="h-10 w-full" />}
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="rounded-lg border border-line bg-paper px-4 py-2.5 text-sm font-semibold hover:border-ink"
          >
            음원 파일 올리기
          </button>
          {allowRecord && (
            <button onClick={startRecording} className="rounded-lg bg-mine px-4 py-2.5 text-sm font-semibold text-white hover:brightness-110">
              마이크로 녹음하기
            </button>
          )}
          {onOpenLibrary && (
            <button
              onClick={onOpenLibrary}
              className="rounded-lg border border-line bg-paper px-4 py-2.5 text-sm font-semibold hover:border-ink"
            >
              저장된 음원에서 고르기
            </button>
          )}
          {allowRecord && playAlong && (
            <label className="flex w-full items-center gap-2 pt-1 text-sm text-muted">
              <input type="checkbox" checked={withGuide} onChange={(e) => setWithGuide(e.target.checked)} className="accent-mine" />
              가이드를 틀어 놓고 녹음 (이어폰을 끼면 가이드 소리가 녹음에 섞이지 않아요)
            </label>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onChange({ name: f.name, blob: f, origin: "file" });
          e.target.value = "";
        }}
      />
    </section>
  );
}
