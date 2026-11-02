"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PianoRoll, noteName, scoreColor } from "@/components/Charts";
import { openCapture, scheduleClick, scheduleTone, type Capture } from "@/lib/audio/capture.ts";
import { drillTargetArray, scoreDrill, type Drill, type DrillResult } from "@/lib/audio/drill.ts";

type Phase = { kind: "idle" } | { kind: "listen" } | { kind: "count"; n: number } | { kind: "sing" } | { kind: "scoring" } | { kind: "error"; msg: string };

const PRE = 0.3;

/** 드릴 한 개: 듣기 → 박자 4번 → 따라 부르기 → 채점 */
export default function DrillRunner({ drill, onResult }: { drill: Drill; onResult: (r: DrillResult, seconds: number) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [head, setHead] = useState<number | null>(null);
  const [result, setResult] = useState<DrillResult | null>(null);
  const [level, setLevel] = useState(0);
  const cap = useRef<Capture | null>(null);
  const raf = useRef(0);
  const hop = 0.02;
  const target = useMemo(() => drillTargetArray(drill, hop), [drill]);
  const empty = useMemo(() => target.map(() => null), [target]);

  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      cap.current?.close();
    },
    [],
  );

  async function start() {
    setResult(null);
    let c: Capture;
    try {
      c = await openCapture();
    } catch {
      setPhase({ kind: "error", msg: "마이크를 쓸 수 없어요. 주소창의 마이크 권한을 허용한 뒤 다시 눌러 주세요." });
      return;
    }
    cap.current = c;
    const ctx = c.ctx;
    const beat = 60 / drill.bpm;
    const t0 = ctx.currentTime + 0.3;
    // 1) 듣기
    for (const nt of drill.notes) scheduleTone(ctx, nt.midi, t0 + nt.beat * beat, nt.beats * beat * 0.95);
    for (let k = 0; k < drill.length; k++) scheduleClick(ctx, t0 + k * beat, k % 4 === 0);
    const listenEnd = t0 + drill.length * beat;
    // 2) 박자 4번
    const countStart = listenEnd + 0.4;
    for (let k = 0; k < 4; k++) scheduleClick(ctx, countStart + k * beat, k === 0);
    // 3) 따라 부르기 (박자 소리만)
    const singStart = countStart + 4 * beat;
    if (drill.clicks) for (let k = 0; k < drill.length; k++) scheduleClick(ctx, singStart + k * beat, k % 4 === 0);
    const singEnd = singStart + drill.length * beat;

    const tick = () => {
      const now = ctx.currentTime;
      setLevel(c.level());
      if (now < listenEnd) {
        setPhase({ kind: "listen" });
        setHead(now - t0);
      } else if (now < singStart) {
        setPhase({ kind: "count", n: Math.max(1, 4 - Math.floor((now - countStart) / beat)) });
        setHead(null);
      } else if (now < singEnd) {
        setPhase({ kind: "sing" });
        setHead(now - singStart);
      } else {
        setHead(null);
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    const x = await c.take(singStart - PRE, singEnd + 0.4);
    cancelAnimationFrame(raf.current);
    setPhase({ kind: "scoring" });
    const lat = c.latency;
    c.close();
    cap.current = null;
    try {
      const r = await scoreDrill(drill, x, 16000, PRE, lat);
      setResult(r);
      setPhase({ kind: "idle" });
      onResult(r, singEnd - t0);
    } catch {
      setPhase({ kind: "error", msg: "채점하지 못했어요. 다시 해 주세요." });
    }
  }

  const busy = phase.kind === "listen" || phase.kind === "count" || phase.kind === "sing" || phase.kind === "scoring";
  const bad = result?.notes.filter((n) => !n.ok) ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={start}
          disabled={busy}
          className="rounded-xl bg-mine px-5 py-2.5 font-semibold text-white hover:brightness-110 disabled:opacity-40"
        >
          {result ? "다시 하기" : "시작"}
        </button>
        <span className="text-sm font-semibold" role="status">
          {phase.kind === "listen" && <span className="text-guide">먼저 들어 보세요…</span>}
          {phase.kind === "count" && <span className="text-2xl tabular-nums text-mine">{phase.n}</span>}
          {phase.kind === "sing" && (
            <span className="flex items-center gap-2 text-mine">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-mine" aria-hidden /> 지금 따라 부르세요
              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-key">
                <span className="block h-full bg-mine" style={{ width: `${level * 100}%` }} />
              </span>
            </span>
          )}
          {phase.kind === "scoring" && <span className="text-muted">채점 중</span>}
          {phase.kind === "idle" && !result && <span className="text-muted">듣기 → 박자 4번 → 따라 부르기 순서예요. 이어폰 없이도 돼요.</span>}
        </span>
      </div>
      {phase.kind === "error" && <p className="mt-2 text-sm text-bad">{phase.msg}</p>}

      <div className="mt-3">
        <PianoRoll refMidi={target} userMidi={result?.userMidi.slice(0, target.length) ?? empty} hopSec={hop} height={170} playhead={head} />
      </div>

      {result && (
        <div className="mt-3 rounded-xl bg-paper p-4">
          <div className="flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-bold tabular-nums" style={{ color: scoreColor(result.score) }}>
              {result.score}점
            </span>
            <span className="text-[15px]">{result.summary}</span>
          </div>
          {bad.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {bad.slice(0, 8).map((n, i) => (
                <li key={i} className="rounded-md bg-surface px-2 py-1">
                  <b>{noteName(n.midi)}</b> {n.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
