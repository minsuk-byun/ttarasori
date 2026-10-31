"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AudioInput from "@/components/AudioInput";
import { DeviationChart, PianoRoll, scoreColor } from "@/components/Charts";
import { compareFeatures, fmtTime, type Comparison, type Issue, type Segment } from "@/lib/audio/compare.ts";
import { decodeToMono } from "@/lib/audio/decode.ts";
import { extractFeatures } from "@/lib/audio/features.ts";
import { SAMPLE_RATE } from "@/lib/audio/synth.ts";
import { getSample } from "@/lib/samples";
import { takePendingGuide, type AudioSource } from "@/lib/store";

type Status = { kind: "idle" } | { kind: "working"; step: string; p: number } | { kind: "error"; msg: string };

export default function ComparePage() {
  const [guide, setGuide] = useState<AudioSource | null>(null);
  const [mine, setMine] = useState<AudioSource | null>(null);
  const [playAlong, setPlayAlong] = useState<AudioSource | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [result, setResult] = useState<Comparison | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const p = takePendingGuide();
    if (p) {
      setGuide(p.guide);
      setPlayAlong(p.playAlong);
    }
  }, []);

  const run = useCallback(async (g: AudioSource, m: AudioSource) => {
    setResult(null);
    try {
      setStatus({ kind: "working", step: "음원 여는 중", p: 0.02 });
      const [gx, mx] = await Promise.all([decodeToMono(g.blob), decodeToMono(m.blob)]);
      if (gx.length < SAMPLE_RATE * 2 || mx.length < SAMPLE_RATE * 2) {
        throw new Error("음원이 너무 짧아요. 2초 이상인 음원으로 다시 시도해 주세요.");
      }
      const gf = await extractFeatures(gx, SAMPLE_RATE, (p) =>
        setStatus({ kind: "working", step: "AI 커버 음정 추출 중", p: 0.05 + p * 0.45 }),
      );
      const mf = await extractFeatures(mx, SAMPLE_RATE, (p) =>
        setStatus({ kind: "working", step: "내 노래 음정 추출 중", p: 0.5 + p * 0.45 }),
      );
      setStatus({ kind: "working", step: "구간별 비교 중", p: 0.97 });
      await new Promise((r) => setTimeout(r, 30));
      const c = compareFeatures(gf, mf);
      if (!c.segments.length) {
        throw new Error("AI 커버에서 노래 부분을 찾지 못했어요. 반주 없이 보컬만 있는 음원을 올리면 가장 정확해요.");
      }
      setResult(c);
      setStatus({ kind: "idle" });
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (e) {
      setStatus({ kind: "error", msg: e instanceof Error ? e.message : "분석하지 못했어요. 다른 음원으로 다시 시도해 주세요." });
    }
  }, []);

  const trySample = () => {
    const g = getSample("guide");
    const m = getSample("mine");
    setGuide(g);
    setMine(m);
    run(g, m);
  };

  const working = status.kind === "working";

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">내 노래 비교 분석</h1>
        <p className="mt-3 text-[17px] leading-relaxed text-muted">
          AI가 내 목소리로 부른 커버와 직접 부른 노래를 겹쳐 보고, 음정·박자·강약이 달라지는 구간과 연습 방법을 알려 드려요.
        </p>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <AudioInput
          label="AI 커버"
          hint="기준이 될 음원이에요. 반주 없는 보컬 음원이면 가장 정확해요."
          tone="guide"
          value={guide}
          onChange={(v) => {
            setGuide(v);
            setPlayAlong(null);
          }}
        />
        <AudioInput
          label="내가 부른 노래"
          hint="같은 곡을 직접 부른 녹음이에요. 시작 시점이 달라도 자동으로 맞춰요."
          tone="mine"
          value={mine}
          onChange={setMine}
          allowRecord
          playAlong={playAlong ?? guide}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          disabled={!guide || !mine || working}
          onClick={() => guide && mine && run(guide, mine)}
          className="rounded-xl bg-ink px-6 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-35"
        >
          비교 분석하기
        </button>
        <button onClick={trySample} disabled={working} className="rounded-xl px-4 py-3 font-semibold text-guide hover:bg-guide-soft disabled:opacity-40">
          샘플 음원으로 체험하기
        </button>
      </div>

      {status.kind === "working" && (
        <div className="mt-6 max-w-md" role="status">
          <div className="flex justify-between text-sm">
            <span>{status.step}</span>
            <span className="tabular-nums text-muted">{Math.round(status.p * 100)}%</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-key">
            <div className="h-full rounded-full bg-guide transition-[width]" style={{ width: `${status.p * 100}%` }} />
          </div>
        </div>
      )}
      {status.kind === "error" && <p className="mt-6 rounded-xl bg-mine-soft px-4 py-3 text-bad">{status.msg}</p>}

      {result && guide && mine && (
        <div ref={resultRef} className="scroll-mt-6">
          <Results result={result} guide={guide} mine={mine} />
        </div>
      )}
    </main>
  );
}

/* ------------------------------------------------------------------ */

function usePlayer(guide: AudioSource, mine: AudioSource, lagSec: number) {
  const g = useRef<HTMLAudioElement | null>(null);
  const m = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<"guide" | "mine" | null>(null);
  const [head, setHead] = useState<number | null>(null);
  const raf = useRef(0);
  const queue = useRef<(() => void) | null>(null);

  useEffect(() => {
    const gu = URL.createObjectURL(guide.blob);
    const mu = URL.createObjectURL(mine.blob);
    g.current = new Audio(gu);
    m.current = new Audio(mu);
    return () => {
      g.current?.pause();
      m.current?.pause();
      cancelAnimationFrame(raf.current);
      URL.revokeObjectURL(gu);
      URL.revokeObjectURL(mu);
    };
  }, [guide, mine]);

  const stop = useCallback(() => {
    g.current?.pause();
    m.current?.pause();
    cancelAnimationFrame(raf.current);
    queue.current = null;
    setPlaying(null);
    setHead(null);
  }, []);

  const play = useCallback(
    (which: "guide" | "mine", start: number, end: number, then?: () => void) => {
      g.current?.pause();
      m.current?.pause();
      cancelAnimationFrame(raf.current);
      const a = which === "guide" ? g.current : m.current;
      if (!a) return;
      const off = which === "mine" ? lagSec : 0;
      a.currentTime = Math.max(0, start + off);
      a.play();
      setPlaying(which);
      queue.current = then ?? null;
      const tick = () => {
        const t = a.currentTime - off;
        setHead(t);
        if (t >= end || a.ended) {
          a.pause();
          const next = queue.current;
          queue.current = null;
          if (next) next();
          else {
            setPlaying(null);
            setHead(null);
          }
          return;
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    },
    [lagSec],
  );

  return { play, stop, playing, head };
}

function Results({ result, guide, mine }: { result: Comparison; guide: AudioSource; mine: AudioSource }) {
  const [sel, setSel] = useState<number | null>(null);
  const player = usePlayer(guide, mine, result.lagSec);
  const seg = sel != null ? result.segments[sel] : null;
  const range: [number, number] | undefined = seg
    ? [Math.max(0, seg.start - 0.6), Math.min(result.duration, seg.end + 0.6)]
    : undefined;
  const worst = useMemo(() => [...result.segments].sort((a, b) => a.score - b.score).slice(0, 3), [result]);
  const o = result.overall;

  return (
    <div className="mt-12 space-y-6">
      {/* 요약 */}
      <section className="grid gap-6 rounded-2xl bg-ink p-6 text-white sm:p-8 lg:grid-cols-[auto_1fr]">
        <div className="flex items-end gap-3">
          <span className="text-7xl font-bold leading-none tabular-nums">{o.score}</span>
          <span className="pb-2 text-white/60">/ 100점</span>
        </div>
        <div className="grid grid-cols-3 gap-4 lg:pl-8">
          <Stat label="음정이 맞은 비율" value={`${Math.round(o.pitchAccuracy * 100)}%`} sub="±50센트 이내" />
          <Stat label="평균 음정 차이" value={`${Math.round(o.meanAbsCents)}센트`} sub="반음 = 100센트" />
          <Stat label="같이 소리 낸 비율" value={`${Math.round(Math.min(1, o.coverage) * 100)}%`} sub="끊김 없이 부른 정도" />
        </div>
        <ul className="space-y-1.5 text-[15px] leading-relaxed text-white/85 lg:col-span-2">
          {result.summary.map((s) => (
            <li key={s} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-white/50" aria-hidden />
              {s}
            </li>
          ))}
        </ul>
      </section>

      {/* 음정 곡선 */}
      <section className="rounded-2xl bg-surface p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <h2 className="text-xl font-semibold">음정 곡선</h2>
          <Legend />
          {seg && (
            <button onClick={() => setSel(null)} className="ml-auto rounded-lg border border-line px-3 py-1.5 text-sm hover:border-ink">
              전체 보기
            </button>
          )}
        </div>
        <p className="mt-1 text-sm text-muted">
          위쪽 색 막대는 프레이즈별 점수예요. 눌러서 확대하고 들어 볼 수 있어요.
        </p>
        <div className="mt-4">
          <PianoRoll
            refMidi={result.refMidi}
            userMidi={result.userMidi}
            hopSec={result.hopSec}
            segments={result.segments}
            selected={sel}
            onSelect={setSel}
            range={range}
            playhead={player.head}
            height={seg ? 360 : 320}
          />
          <h3 className="mb-1 mt-5 text-sm font-semibold">음정 차이</h3>
          <DeviationChart diffCents={result.diffCents} hopSec={result.hopSec} range={range} playhead={player.head} />
          <p className="mt-1 text-xs text-muted">
            회색 띠 안이면 정확해요. 빨간 막대는 낮게, 주황 막대는 높게 부른 곳이에요.
          </p>
        </div>
      </section>

      {/* 구간 상세 */}
      {seg ? (
        <SegmentDetail seg={seg} total={result.segments.length} player={player} onNav={setSel} />
      ) : (
        <section className="rounded-2xl bg-surface p-4 sm:p-6">
          <h2 className="text-xl font-semibold">먼저 연습할 구간</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {worst.map((s) => (
              <button
                key={s.index}
                onClick={() => setSel(s.index)}
                className="rounded-xl border border-line p-4 text-left hover:border-ink"
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-semibold">
                    {fmtTime(s.start)} ~ {fmtTime(s.end)}
                  </span>
                  <span className="text-2xl font-bold tabular-nums" style={{ color: scoreColor(s.score) }}>
                    {s.score}
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted">{s.issues.map((i) => i.title).join(", ")}</p>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-sm text-white/60">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums sm:text-3xl">{value}</div>
      <div className="text-xs text-white/45">{sub}</div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex gap-4 text-sm">
      <span className="flex items-center gap-1.5">
        <span className="h-1 w-5 rounded-full bg-guide" aria-hidden />
        AI 커버
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-5 rounded-full bg-mine" aria-hidden />
        내 노래
      </span>
    </div>
  );
}

const SEV_LABEL = ["", "조금", "보통", "많이"];

function SegmentDetail({
  seg,
  total,
  player,
  onNav,
}: {
  seg: Segment;
  total: number;
  player: ReturnType<typeof usePlayer>;
  onNav: (i: number) => void;
}) {
  const { play, stop, playing } = player;
  return (
    <section className="rounded-2xl bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">
          {seg.index + 1}번 구간 ({fmtTime(seg.start)} ~ {fmtTime(seg.end)})
        </h2>
        <span className="rounded-full px-3 py-1 text-sm font-bold text-white" style={{ background: scoreColor(seg.score) }}>
          {seg.score}점
        </span>
        <div className="ml-auto flex gap-1">
          <button
            disabled={seg.index === 0}
            onClick={() => onNav(seg.index - 1)}
            className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-30"
          >
            이전 구간
          </button>
          <button
            disabled={seg.index === total - 1}
            onClick={() => onNav(seg.index + 1)}
            className="rounded-lg border border-line px-3 py-1.5 text-sm disabled:opacity-30"
          >
            다음 구간
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <PlayBtn active={playing === "guide"} tone="guide" onClick={() => (playing ? stop() : play("guide", seg.start, seg.end))}>
          AI 커버 듣기
        </PlayBtn>
        <PlayBtn active={playing === "mine"} tone="mine" onClick={() => (playing ? stop() : play("mine", seg.start, seg.end))}>
          내 노래 듣기
        </PlayBtn>
        <button
          onClick={() => (playing ? stop() : play("guide", seg.start, seg.end, () => play("mine", seg.start, seg.end)))}
          className="rounded-lg border border-line px-4 py-2 text-sm font-semibold hover:border-ink"
        >
          {playing ? "멈추기" : "번갈아 듣기"}
        </button>
      </div>

      <ul className="mt-6 space-y-4">
        {seg.issues.map((is) => (
          <IssueRow key={is.kind} issue={is} />
        ))}
      </ul>
    </section>
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  const color = issue.kind === "good" ? "var(--color-good)" : issue.severity >= 2 ? "var(--color-bad)" : "var(--color-warn)";
  return (
    <li className="grid gap-1 border-l-4 pl-4 sm:grid-cols-[200px_1fr] sm:gap-6" style={{ borderColor: color }}>
      <div>
        <div className="font-semibold">{issue.title}</div>
        {issue.severity > 0 && <div className="text-sm text-muted">개선 필요: {SEV_LABEL[issue.severity]}</div>}
      </div>
      <div className="max-w-prose text-[15px] leading-relaxed">
        <p>{issue.detail}</p>
        <p className="mt-1.5 text-muted">
          <span className="font-semibold text-ink">이렇게 불러 보세요. </span>
          {issue.tip}
        </p>
      </div>
    </li>
  );
}

function PlayBtn({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: "guide" | "mine";
  onClick: () => void;
  children: React.ReactNode;
}) {
  const base = tone === "guide" ? "bg-guide" : "bg-mine";
  return (
    <button onClick={onClick} className={`flex items-center gap-2 rounded-lg ${base} px-4 py-2 text-sm font-semibold text-white hover:brightness-110`}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
        {active ? <rect x="2" y="2" width="8" height="8" fill="currentColor" /> : <path d="M2 1 L11 6 L2 11 Z" fill="currentColor" />}
      </svg>
      {active ? "멈추기" : children}
    </button>
  );
}
