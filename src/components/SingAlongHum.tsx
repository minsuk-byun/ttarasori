"use client";

import { useEffect, useRef, useState } from "react";
import type { AudioSource } from "@/lib/store";
import { useYouTube } from "@/lib/useYouTube";

const MAX_SEC = 30; // 서버가 허밍을 30초까지 써요

const fmt = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, "0")}`;

/**
 * 고른 유튜브 원곡을 공식 플레이어로 틀면서 따라 부르기 → 그 녹음을 바로 '내 허밍'으로 써요.
 * 원곡 소리는 내려받거나 녹음하지 않고(이어폰 필수), 마이크로 들어온 내 목소리만 녹음해요.
 */
export default function SingAlongHum({
  video,
  onDone,
}: {
  video: { id: string; title: string };
  onDone: (src: AudioSource) => void;
}) {
  const yt = useYouTube(video.id);
  const [headphones, setHeadphones] = useState(false);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "rec"; since: number; level: number; from: number } | { kind: "error"; msg: string }>({
    kind: "idle",
  });
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  // 30초가 되면 자동으로 멈춰요
  const elapsed = state.kind === "rec" ? (performance.now() - state.since) / 1000 : 0;
  useEffect(() => {
    if (state.kind === "rec" && elapsed >= MAX_SEC) stopRef.current?.();
  }, [state, elapsed]);

  async function start() {
    const p = yt.player.current;
    if (!p) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      setState({ kind: "error", msg: "마이크를 쓸 수 없어요. 주소창의 마이크 권한을 허용한 뒤 다시 눌러 주세요." });
      return;
    }
    p.setPlaybackRate(1);
    const from = Math.max(0, p.getCurrentTime() || 0);
    const mr = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const since = performance.now();
    let raf = 0;
    const meter = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      setState({ kind: "rec", since, from, level: Math.min(1, Math.sqrt(s / buf.length) * 6) });
      raf = requestAnimationFrame(meter);
    };
    const stop = () => {
      stopRef.current = null;
      cancelAnimationFrame(raf);
      if (mr.state !== "inactive") mr.stop();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      yt.player.current?.pauseVideo();
    };
    mr.onstop = () => {
      const sec = (performance.now() - since) / 1000;
      if (sec < 5) {
        setState({ kind: "error", msg: "너무 짧아요. 10초 이상 따라 불러 주세요." });
        return;
      }
      setState({ kind: "idle" });
      onDone({
        name: `${video.title.slice(0, 30)} ${fmt(from)}부터 따라 부르기`,
        blob: new Blob(chunks, { type: mr.mimeType || "audio/webm" }),
        origin: "record",
      });
    };
    stopRef.current = stop;
    mr.start();
    p.playVideo();
    meter();
  }

  const recording = state.kind === "rec";
  return (
    <div className="rounded-xl bg-surface p-4">
      <div className="text-sm font-semibold">원곡 틀고 따라 부르기</div>
      <div className="mt-2 aspect-video w-full overflow-hidden rounded-lg bg-black" ref={yt.mount} />
      <p className="mt-2 text-xs leading-relaxed text-muted">
        부르고 싶은 곳(후렴 등)으로 옮겨 두고 녹음을 누르면, 그 위치부터 원곡이 나오고 내 목소리만 녹음돼요. 최대 {MAX_SEC}초, 끝나면 자동으로 멈춰요. 원곡은 유튜브 공식
        플레이어로 재생만 하고 내려받지 않아요.
      </p>
      <label className="mt-3 flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1 accent-mine" checked={headphones} onChange={(e) => setHeadphones(e.target.checked)} />
        <span>
          <b>이어폰(헤드폰)을 꼈어요.</b> 스피커로 들으면 원곡 소리가 녹음에 섞여서 멜로디를 잘못 읽어요.
        </span>
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        {!recording ? (
          <button
            type="button"
            disabled={!yt.ready || !headphones}
            onClick={start}
            className="rounded-xl bg-mine px-5 py-2.5 font-semibold text-white disabled:opacity-35"
          >
            {yt.ready ? `${fmt(yt.time)}부터 틀고 녹음 시작` : "플레이어 준비 중"}
          </button>
        ) : (
          <>
            <button type="button" onClick={() => stopRef.current?.()} className="rounded-xl bg-ink px-5 py-2.5 font-semibold text-white">
              녹음 끝내기
            </button>
            <span className="tabular-nums text-sm text-muted">
              {Math.floor(elapsed)} / {MAX_SEC}초
            </span>
            <span className="h-2 w-24 overflow-hidden rounded-full bg-line">
              <span className="block h-full bg-mine" style={{ width: `${Math.round(state.level * 100)}%` }} />
            </span>
          </>
        )}
      </div>
      {state.kind === "error" && <p className="mt-2 text-sm text-bad">{state.msg}</p>}
    </div>
  );
}
