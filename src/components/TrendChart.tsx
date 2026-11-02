"use client";

/** 날짜별 점수 변화 (간단한 꺾은선) */
export default function TrendChart({ points, unit = "점", max = 100 }: { points: { t: number; v: number }[]; unit?: string; max?: number }) {
  const W = 640;
  const H = 200;
  const L = 34;
  const R = 12;
  const T = 14;
  const B = 26;
  if (points.length < 2) {
    return (
      <div className="grid h-40 place-items-center rounded-xl bg-paper text-sm text-muted">
        {points.length ? "기록이 하나뿐이에요. 한 번 더 하면 변화가 보여요." : "아직 기록이 없어요."}
      </div>
    );
  }
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const x = (t: number) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
  const y = (v: number) => T + (1 - Math.max(0, Math.min(max, v)) / max) * (H - T - B);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const fmt = (t: number) => new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
  const first = points[0].v;
  const lastV = points[points.length - 1].v;
  const best = Math.max(...points.map((p) => p.v));

  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <span>
          처음 <b className="tabular-nums">{Math.round(first)}</b>
          {unit}
        </span>
        <span>
          최근 <b className="tabular-nums">{Math.round(lastV)}</b>
          {unit}
          <span className={`ml-1 font-semibold ${lastV >= first ? "text-good" : "text-bad"}`}>
            ({lastV >= first ? "+" : ""}
            {Math.round(lastV - first)})
          </span>
        </span>
        <span>
          최고 <b className="tabular-nums">{Math.round(best)}</b>
          {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`처음 ${Math.round(first)}${unit}에서 최근 ${Math.round(lastV)}${unit}`}>
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y((v / 100) * max)} y2={y((v / 100) * max)} stroke="var(--color-line)" />
            <text x={L - 6} y={y((v / 100) * max) + 4} textAnchor="end" fontSize="11" fill="var(--color-muted)">
              {Math.round((v / 100) * max)}
            </text>
          </g>
        ))}
        <path d={d} fill="none" stroke="var(--color-guide)" strokeWidth="2.5" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle key={i} cx={x(p.t)} cy={y(p.v)} r="3.5" fill="var(--color-surface)" stroke="var(--color-guide)" strokeWidth="2">
            <title>
              {fmt(p.t)} {Math.round(p.v)}
              {unit}
            </title>
          </circle>
        ))}
        <text x={L} y={H - 6} fontSize="11" fill="var(--color-muted)">
          {fmt(t0)}
        </text>
        <text x={W - R} y={H - 6} fontSize="11" textAnchor="end" fill="var(--color-muted)">
          {fmt(t1)}
        </text>
      </svg>
    </div>
  );
}
