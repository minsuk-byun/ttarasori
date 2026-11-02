"use client";

import { useMemo, useState } from "react";
import { PROBLEM_TIP, splitLines, type NoteProblem, type NoteResult } from "@/lib/audio/notes.ts";
import { noteName } from "@/components/Charts";
import type { Player } from "@/lib/usePlayer";

interface Props {
  notes: NoteResult[];
  /** 연습곡처럼 글자 정보가 있으면 true */
  hasLyrics: boolean;
  player: Player;
  hasTuned: boolean;
  /** 이 시간 범위의 음만 보여 주기 (구간 상세용) */
  range?: [number, number];
}

const MARK: Record<NoteProblem, string> = { flat: "↓", sharp: "↑", late: "늦음", early: "빠름", missing: "✕", scoop: "↗" };

function chipStyle(n: NoteResult): React.CSSProperties {
  if (n.problems.includes("missing"))
    return { background: "var(--color-key)", color: "var(--color-muted)", borderColor: "var(--color-line)", borderStyle: "dashed" };
  if (n.severity === 0) return { background: "#e3f4ed", color: "var(--color-good)", borderColor: "transparent" };
  if (n.severity === 1) return { background: "#fbf0de", color: "#9a6210", borderColor: "transparent" };
  return { background: "#fbe4e4", color: "var(--color-bad)", borderColor: "transparent" };
}

/** 글자(음표)마다 맞았는지 색으로 보여 주고, 누르면 무엇이 어떻게 틀렸는지와 들어 보기 */
export default function NoteFeedback({ notes, hasLyrics, player, hasTuned, range }: Props) {
  const [sel, setSel] = useState<number | null>(null);
  const shown = useMemo(
    () => (range ? notes.filter((n) => n.start + n.dur > range[0] && n.start < range[1]) : notes),
    [notes, range],
  );
  const lines = useMemo(() => splitLines(shown, hasLyrics ? 12 : 16, hasLyrics ? 0.3 : 0.5), [shown, hasLyrics]);
  const counts = useMemo(() => {
    const c = { good: 0, flat: 0, sharp: 0, timing: 0, missing: 0 };
    for (const n of shown) {
      if (n.problems.includes("missing")) c.missing++;
      else if (n.problems.includes("flat")) c.flat++;
      else if (n.problems.includes("sharp")) c.sharp++;
      else if (n.problems.includes("late") || n.problems.includes("early")) c.timing++;
      else if (n.severity === 0) c.good++;
    }
    return c;
  }, [shown]);
  const worst = useMemo(
    () =>
      [...shown]
        .filter((n) => n.severity >= 2)
        .sort((a, b) => b.severity - a.severity || Math.abs(b.cents ?? 999) - Math.abs(a.cents ?? 999))
        .slice(0, 5),
    [shown],
  );

  if (!shown.length) return null;
  const unit = hasLyrics ? "글자" : "음";
  const label = (n: NoteResult) => (hasLyrics && n.syllable ? n.syllable : noteName(n.target));
  const cur = sel != null ? notes[sel] : null;
  const head = player.head;
  const clip = (n: NoteResult): [number, number] => [Math.max(0, n.start - 0.45), n.start + n.dur + 0.25];

  return (
    <section className="rounded-2xl bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="text-xl font-semibold">{hasLyrics ? "글자별 피드백" : "음별 피드백"}</h2>
        <p className="text-sm text-muted">
          정확 {counts.good} · 낮음 {counts.flat} · 높음 {counts.sharp} · 박자 {counts.timing} · 빠짐 {counts.missing}
        </p>
      </div>
      <p className="mt-1 text-sm text-muted">
        {hasLyrics
          ? "글자마다 음정과 들어온 타이밍을 따로 확인했어요. 글자를 누르면 무엇이 틀렸는지 듣고 비교할 수 있어요."
          : "가사 정보가 없는 음원이라 가이드 음정을 음 단위로 나눠서 확인했어요. 연습곡으로 비교하면 글자별로 보여 드려요."}
      </p>

      <div className="mt-4 space-y-2.5">
        {lines.map((line, li) => (
          <div key={li} className="flex flex-wrap gap-1.5">
            {line.map((k) => {
              const n = shown[k];
              const active = head != null && head >= n.start && head < n.start + n.dur;
              const mark = n.problems[0] ? MARK[n.problems[0]] : "";
              return (
                <button
                  key={n.index}
                  onClick={() => setSel(sel === n.index ? null : n.index)}
                  title={n.text}
                  aria-label={`${label(n)}: ${n.text}`}
                  className={`flex min-w-[2.6rem] flex-col items-center rounded-lg border px-2 pb-1 pt-1.5 leading-none transition ${
                    sel === n.index ? "ring-2 ring-ink" : ""
                  } ${active ? "scale-110 shadow-md" : ""}`}
                  style={chipStyle(n)}
                >
                  <span className={hasLyrics ? "text-lg font-bold" : "text-sm font-bold"}>{label(n)}</span>
                  <span className="mt-1 h-3 text-[10px] font-semibold">{mark}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>↓ 낮음</span>
        <span>↑ 높음</span>
        <span>늦음/빠름 박자</span>
        <span>↗ 아래에서 끌어올림</span>
        <span>✕ 소리 빠짐</span>
      </div>

      {cur && (
        <div className="mt-4 rounded-xl border border-line p-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-2xl font-bold">{label(cur)}</span>
            <span className="text-sm text-muted">
              목표음 {noteName(cur.target)} · {cur.start.toFixed(1)}초
            </span>
            <span className="font-semibold" style={{ color: chipStyle(cur).color }}>
              {cur.text}
            </span>
          </div>
          {cur.problems.map((p) => (
            <p key={p} className="mt-2 max-w-prose text-[15px] leading-relaxed text-muted">
              <span className="font-semibold text-ink">이렇게 해 보세요. </span>
              {PROBLEM_TIP[p]}
            </p>
          ))}
          <div className="mt-3 flex flex-wrap gap-2">
            <Btn onClick={() => player.play("guide", ...clip(cur))} tone="guide">
              AI 커버
            </Btn>
            <Btn onClick={() => player.play("mine", ...clip(cur))} tone="mine">
              내 노래
            </Btn>
            {hasTuned && (
              <Btn onClick={() => player.play("tuned", ...clip(cur))} tone="good">
                교정본
              </Btn>
            )}
            <button
              onClick={() => {
                const [a, b] = clip(cur);
                player.play("guide", a, b, { then: () => player.play("mine", a, b) });
              }}
              className="rounded-lg border border-line px-3 py-1.5 text-sm font-semibold hover:border-ink"
            >
              번갈아 듣기
            </button>
          </div>
        </div>
      )}

      {!cur && worst.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">먼저 고칠 {unit}</h3>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {worst.map((n) => (
              <li key={n.index}>
                <button onClick={() => setSel(n.index)} className="flex w-full items-center gap-3 rounded-lg border border-line p-2.5 text-left hover:border-ink">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md font-bold" style={chipStyle(n)}>
                    {label(n)}
                  </span>
                  <span className="text-sm">{n.text}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Btn({ onClick, tone, children }: { onClick: () => void; tone: "guide" | "mine" | "good"; children: React.ReactNode }) {
  const bg = tone === "guide" ? "bg-guide" : tone === "mine" ? "bg-mine" : "bg-good";
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 rounded-lg ${bg} px-3 py-1.5 text-sm font-semibold text-white hover:brightness-110`}>
      <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
        <path d="M2 1 L11 6 L2 11 Z" fill="currentColor" />
      </svg>
      {children}
    </button>
  );
}
