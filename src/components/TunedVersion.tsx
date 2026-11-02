"use client";

import { useEffect, useRef, useState } from "react";
import type { Comparison } from "@/lib/audio/compare.ts";
import { createTuneJob, fetchChunked, getGpuConfig, getJob, resultUrl } from "@/lib/gpu";

/**
 * 내 녹음 시간축 기준 목표 음 만들기.
 * 가이드 프레임 i 는 내 녹음 프레임 i + lag 에 해당하고, 구간마다 남은 박자 차이도 반영해요.
 * 목표 음은 내가 부른 옥타브·키로 옮겨서 보내요 (키를 바꿔 부른 경우에도 내 키 그대로 교정).
 */
export function tuneTarget(c: Comparison): { hop: number; midi: (number | null)[] } {
  const hop = c.hopSec;
  const lag = Math.round(c.lagSec / hop);
  const shift = c.octaveShift + c.keyShift;
  const n = c.refMidi.length;
  const len = n + Math.max(0, lag) + 50;
  const midi: (number | null)[] = new Array(len).fill(null);
  const lagAt = new Int32Array(n).fill(lag);
  const pad = Math.round(0.3 / hop);
  for (const s of c.segments) {
    const local = lag + Math.round(s.timingMs / 1000 / hop);
    for (let i = Math.max(0, s.i0 - pad); i < Math.min(n, s.i1 + pad); i++) lagAt[i] = local;
  }
  for (let i = 0; i < n; i++) {
    const r = c.refMidi[i];
    const j = i + lagAt[i];
    if (r != null && j >= 0 && j < len) midi[j] = r + shift;
  }
  // 끝의 빈 칸 정리
  let last = midi.length;
  while (last > 0 && midi[last - 1] == null) last--;
  return { hop, midi: midi.slice(0, last) };
}

type State =
  | { kind: "idle" }
  | { kind: "working"; step: string; p: number }
  | { kind: "done"; url: string; before: number; after: number }
  | { kind: "error"; msg: string };

interface Props {
  /** 내 녹음 시간축 기준 목표 음 만들기 */
  makeTarget: () => { hop: number; midi: (number | null)[] };
  mine: Blob;
  onReady: (b: Blob | null) => void;
  /** 이 값이 바뀌면 처음 상태로 */
  resetKey: unknown;
  /** 설명 문구 (기본: AI 커버에 맞추기) */
  description?: React.ReactNode;
}

export default function TunedVersion({ makeTarget, mine, onReady, resetKey, description }: Props) {
  const [gpu, setGpu] = useState<boolean | null>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    getGpuConfig().then((c) => alive.current && setGpu(c.enabled));
    return () => {
      alive.current = false;
    };
  }, []);

  // 다른 비교 결과로 바뀌면 처음 상태로
  useEffect(() => {
    setState((s) => {
      if (s.kind === "done") URL.revokeObjectURL(s.url);
      return { kind: "idle" };
    });
    onReady(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, mine]);

  async function make() {
    try {
      setState({ kind: "working", step: "GPU 서버 연결 중", p: 0.02 });
      const cfg = await getGpuConfig();
      if (!cfg.enabled) throw new Error("GPU 서버가 꺼져 있어서 지금은 만들 수 없어요.");
      const id = await createTuneJob(cfg, mine, makeTarget(), (p) =>
        setState({ kind: "working", step: "내 녹음 올리는 중", p: 0.02 + p * 0.18 }),
      );
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        if (!alive.current) return;
        const s = await getJob(cfg, id);
        if (s.status === "error") throw new Error(s.error ?? "교정본을 만들지 못했어요.");
        if (s.status === "done") {
          setState({ kind: "working", step: "결과 받는 중", p: 0.95 });
          const blob = await fetchChunked(resultUrl(cfg, id, "tuned"), "audio/mpeg");
          if (!alive.current) return;
          onReady(blob);
          setState({
            kind: "done",
            url: URL.createObjectURL(blob),
            before: s.stats?.mean_cents_before ?? 0,
            after: s.stats?.mean_cents_after ?? 0,
          });
          return;
        }
        setState({ kind: "working", step: s.status === "queued" ? "앞선 작업을 기다리는 중" : s.step, p: 0.2 + s.progress * 0.75 });
      }
    } catch (e) {
      setState({ kind: "error", msg: e instanceof Error ? e.message : "교정본을 만들지 못했어요." });
    }
  }

  return (
    <section className="rounded-2xl border-l-4 border-good bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="max-w-2xl flex-1">
          <h2 className="text-xl font-semibold">내 목소리 교정본</h2>
          <p className="mt-1 text-[15px] leading-relaxed text-muted">
            {description ?? (
              <>
                내가 부른 녹음에서 <b className="text-ink">음정만</b> AI 커버에 맞게 고쳐서 내 목소리 그대로 들려드려요. 박자·발음·음색은 그대로라서
                &ldquo;이렇게 부르면 된다&rdquo;를 내 목소리로 확인할 수 있어요.
              </>
            )}
          </p>
        </div>
        {state.kind !== "done" && (
          <button
            onClick={make}
            disabled={state.kind === "working" || gpu === false}
            className="rounded-xl bg-good px-5 py-3 font-semibold text-white hover:brightness-110 disabled:opacity-40"
          >
            {state.kind === "working" ? "만드는 중" : "교정본 만들기"}
          </button>
        )}
      </div>

      {gpu === false && state.kind === "idle" && (
        <p className="mt-3 text-sm text-muted">GPU 서버가 꺼져 있어서 지금은 만들 수 없어요. 서버를 켠 뒤 다시 열어 주세요.</p>
      )}
      {state.kind === "working" && (
        <div className="mt-4 max-w-md" role="status">
          <div className="flex justify-between text-sm">
            <span>{state.step}</span>
            <span className="tabular-nums text-muted">{Math.round(state.p * 100)}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-key">
            <div className="h-full rounded-full bg-good transition-[width]" style={{ width: `${state.p * 100}%` }} />
          </div>
        </div>
      )}
      {state.kind === "error" && <p className="mt-3 rounded-lg bg-mine-soft px-3 py-2 text-sm text-bad">{state.msg}</p>}
      {state.kind === "done" && (
        <div className="mt-4 space-y-3">
          {state.before > 0 && (
            <p className="text-sm">
              평균 음정 차이 <b className="tabular-nums">{Math.round(state.before)}센트</b> →{" "}
              <b className="tabular-nums text-good">{Math.round(state.after)}센트</b>
            </p>
          )}
          <audio src={state.url} controls className="h-10 w-full max-w-xl" />
          <div className="flex flex-wrap gap-3 text-sm">
            <a href={state.url} download="ttarasori-교정본.mp3" className="font-semibold text-guide underline-offset-2 hover:underline">
              교정본 내려받기
            </a>
            <span className="text-muted">구간이나 글자를 골라 &lsquo;교정본&rsquo; 버튼으로 내 노래와 비교해 보세요.</span>
          </div>
        </div>
      )}
    </section>
  );
}
