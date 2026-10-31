"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Segment } from "@/lib/audio/compare.ts";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export const noteName = (m: number) => `${NOTE_NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;
const isBlack = (m: number) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);

export const scoreColor = (s: number) => (s >= 85 ? "var(--color-good)" : s >= 70 ? "var(--color-warn)" : "var(--color-bad)");

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** 값 배열 → SVG path (null에서 끊김), 화면 픽셀당 1~2점으로 솎아냄 */
function buildPath(
  vals: (number | null)[],
  i0: number,
  i1: number,
  x: (i: number) => number,
  y: (v: number) => number,
  maxPts: number,
) {
  const step = Math.max(1, Math.floor((i1 - i0) / maxPts));
  let d = "";
  let pen = false;
  let prev: number | null = null;
  for (let i = i0; i < i1; i += step) {
    const v = vals[i];
    // 큰 점프(음 이탈/옥타브 튐)는 선을 끊어서 표시
    if (v == null || (prev != null && Math.abs(v - prev) > 3)) {
      pen = false;
      prev = v ?? null;
      if (v == null) continue;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
    prev = v;
  }
  return d;
}

const KEY_W = 46;

interface RollProps {
  refMidi: (number | null)[];
  userMidi: (number | null)[];
  hopSec: number;
  range?: [number, number];
  segments?: Segment[];
  selected?: number | null;
  onSelect?: (i: number) => void;
  playhead?: number | null;
  height?: number;
  animate?: boolean;
}

/** 피아노 롤 위에 두 목소리의 음정 곡선을 겹쳐 그림 */
export function PianoRoll({
  refMidi,
  userMidi,
  hopSec,
  range,
  segments,
  selected,
  onSelect,
  playhead,
  height = 320,
  animate,
}: RollProps) {
  const [box, width] = useWidth<HTMLDivElement>();
  const n = refMidi.length;
  const t0 = range?.[0] ?? 0;
  const t1 = range?.[1] ?? n * hopSec;
  const i0 = Math.max(0, Math.floor(t0 / hopSec));
  const i1 = Math.min(n, Math.ceil(t1 / hopSec));

  const [lo, hi] = useMemo(() => {
    let a = Infinity;
    let b = -Infinity;
    for (let i = i0; i < i1; i++) {
      for (const v of [refMidi[i], userMidi[i]]) {
        if (v == null) continue;
        if (v < a) a = v;
        if (v > b) b = v;
      }
    }
    if (!isFinite(a)) return [55, 72];
    return [Math.floor(a) - 2, Math.ceil(b) + 2];
  }, [refMidi, userMidi, i0, i1]);

  const band = segments ? 22 : 0;
  const plotW = Math.max(0, width - KEY_W);
  const plotH = height - band - 22;
  const x = (i: number) => KEY_W + ((i * hopSec - t0) / (t1 - t0)) * plotW;
  const xt = (t: number) => KEY_W + ((t - t0) / (t1 - t0)) * plotW;
  const rowH = plotH / (hi - lo + 1);
  const y = (m: number) => band + (hi - m + 0.5) * rowH;

  const refPath = width ? buildPath(refMidi, i0, i1, x, y, plotW * 1.5) : "";
  const userPath = width ? buildPath(userMidi, i0, i1, x, y, plotW * 1.5) : "";

  const rows = [];
  for (let m = lo; m <= hi; m++) rows.push(m);

  const tickStep = t1 - t0 > 60 ? 10 : t1 - t0 > 20 ? 5 : t1 - t0 > 6 ? 1 : 0.5;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / tickStep) * tickStep; t <= t1; t += tickStep) ticks.push(t);

  return (
    <div ref={box} className="w-full select-none">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="AI 커버와 내 노래의 음정 곡선 비교">
          {/* 건반 줄 */}
          {rows.map((m) => (
            <g key={m}>
              <rect x={KEY_W} y={y(m) - rowH / 2} width={plotW} height={rowH} fill={isBlack(m) ? "var(--color-key)" : "transparent"} />
              <rect
                x={0}
                y={y(m) - rowH / 2}
                width={KEY_W - 6}
                height={rowH}
                fill={isBlack(m) ? "var(--color-ink)" : "#fff"}
                stroke="var(--color-line)"
                strokeWidth={0.5}
              />
              {m % 12 === 0 && rowH >= 7 && (
                <text x={KEY_W - 10} y={y(m) + 4} textAnchor="end" fontSize={10} fill="var(--color-muted)">
                  {noteName(m)}
                </text>
              )}
              {m % 12 === 0 && <line x1={KEY_W} x2={width} y1={y(m) + rowH / 2} y2={y(m) + rowH / 2} stroke="var(--color-line)" />}
            </g>
          ))}

          {/* 프레이즈 구간 */}
          {segments?.map((s) => {
            if (s.end < t0 || s.start > t1) return null;
            const a = Math.max(KEY_W, xt(s.start));
            const b = Math.min(width, xt(s.end));
            const on = selected === s.index;
            return (
              <g
                key={s.index}
                onClick={() => onSelect?.(s.index)}
                className="cursor-pointer"
                role="button"
                aria-label={`${s.index + 1}번 구간, ${s.score}점`}
              >
                <rect x={a} y={band} width={b - a} height={plotH} fill={on ? "rgba(47,79,216,0.07)" : "transparent"} />
                <rect x={a + 1} y={2} width={Math.max(0, b - a - 2)} height={band - 6} rx={4} fill={scoreColor(s.score)} opacity={on ? 1 : 0.75} />
                {b - a > 34 && (
                  <text x={(a + b) / 2} y={band - 9} textAnchor="middle" fontSize={11} fontWeight={700} fill="#fff">
                    {s.score}
                  </text>
                )}
              </g>
            );
          })}

          <path
            d={refPath}
            fill="none"
            stroke="var(--color-guide)"
            strokeWidth={4}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.85}
            pathLength={animate ? 1 : undefined}
            style={animate ? ({ strokeDasharray: 1, ["--len" as string]: 1, animation: "draw 2.4s ease-out both" } as React.CSSProperties) : undefined}
          />
          <path
            d={userPath}
            fill="none"
            stroke="var(--color-mine)"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
            pathLength={animate ? 1 : undefined}
            style={animate ? ({ strokeDasharray: 1, ["--len" as string]: 1, animation: "draw 2.4s 0.3s ease-out both" } as React.CSSProperties) : undefined}
          />

          {playhead != null && playhead >= t0 && playhead <= t1 && (
            <line x1={xt(playhead)} x2={xt(playhead)} y1={band} y2={band + plotH} stroke="var(--color-ink)" strokeWidth={1.5} />
          )}

          {ticks.map((t) => (
            <text key={t} x={xt(t)} y={height - 6} textAnchor="middle" fontSize={10} fill="var(--color-muted)">
              {fmt(t)}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

const fmt = (t: number) => {
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${(Number.isInteger(s) ? s.toString() : s.toFixed(1)).padStart(2, "0")}`;
};

/** 음정 차이(센트) 막대 그래프 */
export function DeviationChart({
  diffCents,
  hopSec,
  range,
  playhead,
  height = 120,
}: {
  diffCents: (number | null)[];
  hopSec: number;
  range?: [number, number];
  playhead?: number | null;
  height?: number;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const n = diffCents.length;
  const t0 = range?.[0] ?? 0;
  const t1 = range?.[1] ?? n * hopSec;
  const i0 = Math.max(0, Math.floor(t0 / hopSec));
  const i1 = Math.min(n, Math.ceil(t1 / hopSec));
  const plotW = Math.max(0, width - KEY_W);
  const LIM = 150;
  const mid = height / 2;
  const y = (c: number) => mid - (Math.max(-LIM, Math.min(LIM, c)) / LIM) * (height / 2 - 6);
  const xt = (t: number) => KEY_W + ((t - t0) / (t1 - t0)) * plotW;

  const bars = useMemo(() => {
    if (!plotW) return [];
    const bins = Math.max(1, Math.floor(plotW / 3));
    const per = (i1 - i0) / bins;
    const out: { x: number; v: number }[] = [];
    for (let b = 0; b < bins; b++) {
      const a = Math.floor(i0 + b * per);
      const e = Math.max(a + 1, Math.floor(i0 + (b + 1) * per));
      let s = 0;
      let c = 0;
      for (let i = a; i < e; i++) {
        const d = diffCents[i];
        if (d == null || Math.abs(d) > 600) continue;
        s += d;
        c++;
      }
      if (c) out.push({ x: KEY_W + (b / bins) * plotW, v: s / c });
    }
    return out;
  }, [diffCents, i0, i1, plotW]);

  return (
    <div ref={box} className="w-full">
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="구간별 음정 차이 그래프">
          <rect x={KEY_W} y={y(50)} width={plotW} height={y(-50) - y(50)} fill="var(--color-key)" />
          <line x1={KEY_W} x2={width} y1={mid} y2={mid} stroke="var(--color-muted)" strokeWidth={0.75} />
          {[100, -100].map((c) => (
            <text key={c} x={KEY_W - 8} y={y(c) + 4} textAnchor="end" fontSize={10} fill="var(--color-muted)">
              {c > 0 ? "+반음" : "-반음"}
            </text>
          ))}
          <text x={KEY_W - 8} y={mid + 4} textAnchor="end" fontSize={10} fill="var(--color-muted)">
            0
          </text>
          {bars.map((b, k) => (
            <rect
              key={k}
              x={b.x}
              width={2}
              y={Math.min(mid, y(b.v))}
              height={Math.max(1, Math.abs(y(b.v) - mid))}
              fill={Math.abs(b.v) < 50 ? "var(--color-good)" : b.v > 0 ? "var(--color-warn)" : "var(--color-bad)"}
            />
          ))}
          {playhead != null && playhead >= t0 && playhead <= t1 && (
            <line x1={xt(playhead)} x2={xt(playhead)} y1={0} y2={height} stroke="var(--color-ink)" strokeWidth={1.5} />
          )}
        </svg>
      )}
    </div>
  );
}
