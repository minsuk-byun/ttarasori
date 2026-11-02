"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import DrillRunner from "@/components/DrillRunner";
import PhraseRunner, { type PhraseScore } from "@/components/PhraseRunner";
import TrendChart from "@/components/TrendChart";
import { noteName } from "@/components/Charts";
import { makeDrill, pickDrills, type DrillKind, type DrillResult } from "@/lib/audio/drill.ts";
import {
  addSession,
  deletePhrase,
  listPhrases,
  listSessions,
  practicedToday,
  profileOf,
  recordPhraseScore,
  streakDays,
  weekMinutes,
  type Phrase,
  type Session,
} from "@/lib/progress";

const WEEK_GOAL = 30; // 분
const DAY = 24 * 60 * 60 * 1000;
const isToday = (t: number | null | undefined) => !!t && new Date(t).toDateString() === new Date().toDateString();
const dayOfYear = () => Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / DAY);

type Block = { id: string; type: "drill"; kind: DrillKind; why: string } | { id: string; type: "phrase"; phrase: Phrase; why: string };

export default function TrainPage() {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [s, p] = await Promise.all([listSessions(), listPhrases()]);
    setSessions(s);
    setPhrases(p);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  // 오늘 루틴은 어제까지의 기록으로 정해요 (하루 중에 연습할 때마다 루틴이 바뀌지 않게)
  const profile = useMemo(() => profileOf((sessions ?? []).filter((x) => !isToday(x.at))), [sessions]);
  const center = profile.range ? Math.round((profile.range.low + profile.range.high) / 2) : 60;

  // 오늘의 루틴: 약점 맞춤 드릴 3개 + 다시 연습할 구절 (오늘 할 차례인 것 최대 2개)
  const blocks: Block[] = useMemo(() => {
    const drills = pickDrills(profile.top, profile.offsetCents).map((d) => ({ id: `drill:${d.kind}`, type: "drill" as const, ...d }));
    const due = phrases.filter((p) => !p.mastered && (p.due <= Date.now() || isToday(p.lastAt))).slice(0, 2);
    const ph = due.map((p) => ({
      id: `phrase:${p.id}`,
      type: "phrase" as const,
      phrase: p,
      why: `「${p.songTitle}」에서 ${p.firstScore}점이 나왔던 구간이에요.`,
    }));
    return [...drills, ...ph];
  }, [profile.top, profile.offsetCents, phrases]);

  const doneIds = useMemo(() => {
    const s = new Set<string>();
    for (const x of sessions ?? []) if (isToday(x.at) && x.label?.startsWith("routine:")) s.add(x.label.slice(8));
    for (const p of phrases) if (isToday(p.lastAt)) s.add(`phrase:${p.id}`);
    return s;
  }, [sessions, phrases]);

  const doneCount = blocks.filter((b) => doneIds.has(b.id)).length;
  const streak = streakDays(sessions ?? []);
  const week = weekMinutes(sessions ?? []);

  async function saveDrill(kind: DrillKind, r: DrillResult, seconds: number) {
    await addSession({
      kind: "drill",
      label: `routine:drill:${kind}`,
      score: r.score,
      pitchAcc: r.pitchAcc,
      meanAbsCents: r.meanAbsCents,
      offsetCents: r.offsetCents,
      timingMs: r.timingMs ?? undefined,
      seconds,
      weak: r.weak,
      rangeLow: r.rangeLow,
      rangeHigh: r.rangeHigh,
    });
    await reload();
  }

  async function savePhrase(p: Phrase, r: PhraseScore) {
    await recordPhraseScore(p.id, r.score);
    await addSession({
      kind: "phrase",
      songKey: p.songKey,
      songTitle: p.songTitle,
      label: `phrase:${p.id}`,
      score: r.score,
      meanAbsCents: r.meanAbsCents,
      seconds: r.seconds,
      weak: r.weak,
    });
    await reload();
  }

  if (sessions === null) return <main className="mx-auto max-w-6xl px-4 py-10 text-muted sm:px-6">불러오는 중</main>;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">오늘의 연습</h1>
        <p className="mt-3 text-[17px] leading-relaxed text-muted">
          노래를 비교할수록 내 약점에 맞춘 연습이 만들어져요. 하루 10분, 꾸준히 하면 점수가 오르는 게 보여요.
        </p>
      </div>

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatCard label="연속 연습" value={`${streak}일`} sub={practicedToday(sessions) ? "오늘도 했어요!" : streak ? "오늘 하면 이어져요" : "오늘부터 시작해요"} />
        <div className="rounded-2xl bg-surface p-4">
          <div className="text-sm text-muted">이번 주 연습 시간</div>
          <div className="mt-1 text-2xl font-bold tabular-nums">
            {week}
            <span className="text-base font-semibold text-muted"> / {WEEK_GOAL}분</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-key">
            <div className="h-full rounded-full bg-good" style={{ width: `${Math.min(100, (week / WEEK_GOAL) * 100)}%` }} />
          </div>
        </div>
        <StatCard label="오늘의 루틴" value={`${doneCount} / ${blocks.length}`} sub={doneCount === blocks.length ? "오늘 루틴 완료!" : "하나씩 해 봐요"} />
      </section>

      {/* 루틴 */}
      <section className="mt-8">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-xl font-semibold">오늘의 루틴</h2>
          <p className="text-sm text-muted">
            {profile.samples
              ? `최근 기록 ${profile.samples}개를 보고 골랐어요.${profile.range ? ` 내 음역(${noteName(profile.range.low)}~${noteName(profile.range.high)})에 맞췄어요.` : ""}`
              : sessions.some((x) => isToday(x.at))
                ? "오늘 기록은 내일 루틴부터 반영돼요. 오늘은 기본 루틴이에요."
                : "아직 기록이 없어서 기본 루틴이에요. 내 노래 비교를 하면 약점에 맞춰져요."}
          </p>
        </div>
        <ol className="mt-4 space-y-3">
          {blocks.map((b, i) => {
            const done = doneIds.has(b.id);
            const isOpen = open === b.id;
            const drill = b.type === "drill" ? makeDrill(b.kind, center, dayOfYear(), profile.range?.high ?? center + 7) : null;
            const title = b.type === "drill" ? drill!.title : `다시 부르기: ${b.phrase.label}`;
            return (
              <li key={b.id} className={`rounded-2xl bg-surface p-4 sm:p-5 ${isOpen ? "ring-2 ring-ink" : ""}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold ${done ? "bg-good text-white" : "bg-key text-muted"}`}
                    aria-label={done ? "완료" : `${i + 1}번`}
                  >
                    {done ? "✓" : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{title}</div>
                    <div className="text-sm text-muted">{b.why}</div>
                  </div>
                  <button
                    onClick={() => setOpen(isOpen ? null : b.id)}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold ${isOpen ? "border border-line" : done ? "border border-line hover:border-ink" : "bg-ink text-white"}`}
                  >
                    {isOpen ? "접기" : done ? "한 번 더" : "하기"}
                  </button>
                </div>
                {isOpen && (
                  <div className="mt-4 border-t border-line pt-4">
                    {drill ? (
                      <>
                        <p className="text-[15px]">
                          <b>목표</b> {drill.goal}
                        </p>
                        <p className="mt-1 text-[15px] text-muted">
                          <b className="text-ink">방법</b> {drill.how}
                        </p>
                        <div className="mt-3">
                          <DrillRunner drill={drill} onResult={(r, sec) => saveDrill(drill.kind, r, sec)} />
                        </div>
                      </>
                    ) : (
                      b.type === "phrase" && <PhraseRunner phrase={b.phrase} onResult={(r) => savePhrase(b.phrase, r)} />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {!phrases.some((p) => !p.mastered) && (
          <p className="mt-3 text-sm text-muted">
            <Link href="/compare" className="font-semibold text-guide underline-offset-2 hover:underline">
              내 노래 비교
            </Link>
            를 하면 점수가 낮았던 구간이 &lsquo;다시 연습할 구절&rsquo;로 모여서 루틴에 들어와요.
          </p>
        )}
      </section>

      <Growth sessions={sessions} />
      <PhraseList phrases={phrases} onSave={savePhrase} onDelete={async (id) => (await deletePhrase(id), reload())} />
    </main>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-2xl bg-surface p-4">
      <div className="text-sm text-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-sm text-muted">{sub}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ 성장 기록 */

type Metric = "song" | "drill" | "pitch";

function Growth({ sessions }: { sessions: Session[] }) {
  const [metric, setMetric] = useState<Metric>("song");
  const songs = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) if (s.kind === "compare" && s.songKey) m.set(s.songKey, s.songTitle ?? "곡");
    return [...m.entries()];
  }, [sessions]);
  const [song, setSong] = useState<string>("all");

  const points = useMemo(() => {
    if (metric === "song")
      return sessions.filter((s) => s.kind === "compare" && (song === "all" || s.songKey === song)).map((s) => ({ t: s.at, v: s.score }));
    if (metric === "drill") {
      // 하루 평균 연습 점수
      const byDay = new Map<string, { t: number; sum: number; n: number }>();
      for (const s of sessions.filter((x) => x.kind === "drill" || x.kind === "phrase")) {
        const k = new Date(s.at).toDateString();
        const cur = byDay.get(k) ?? { t: s.at, sum: 0, n: 0 };
        cur.sum += s.score;
        cur.n++;
        byDay.set(k, cur);
      }
      return [...byDay.values()].map((d) => ({ t: d.t, v: d.sum / d.n }));
    }
    return sessions
      .filter((s) => (s.kind === "compare" || s.kind === "drill") && typeof s.pitchAcc === "number")
      .map((s) => ({ t: s.at, v: (s.pitchAcc ?? 0) * 100 }));
  }, [sessions, metric, song]);

  const recent = [...sessions].reverse().slice(0, 6);
  const KIND: Record<string, string> = { compare: "노래 비교", repeat: "구간 다시 부르기", drill: "연습", phrase: "구절 연습" };

  return (
    <section className="mt-10 rounded-2xl bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-xl font-semibold">성장 기록</h2>
        {(
          [
            ["song", "노래 점수"],
            ["drill", "연습 점수"],
            ["pitch", "음정 정확도"],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            onClick={() => setMetric(k)}
            className={`rounded-md px-2.5 py-1 text-sm font-semibold ${metric === k ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
          >
            {l}
          </button>
        ))}
      </div>
      {metric === "song" && songs.length > 1 && (
        <select value={song} onChange={(e) => setSong(e.target.value)} className="mt-3 rounded-lg border border-line bg-paper px-3 py-1.5 text-sm">
          <option value="all">모든 곡</option>
          {songs.map(([k, t]) => (
            <option key={k} value={k}>
              {t}
            </option>
          ))}
        </select>
      )}
      <div className="mt-3">
        <TrendChart points={points} unit={metric === "pitch" ? "%" : "점"} />
      </div>
      {recent.length > 0 && (
        <ul className="mt-4 divide-y divide-line text-sm">
          {recent.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2">
              <span className="w-24 shrink-0 text-muted">{new Date(s.at).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="min-w-0 flex-1 truncate">
                {KIND[s.kind]}
                {s.songTitle ? ` · ${s.songTitle}` : ""}
              </span>
              <b className="tabular-nums">{s.score}점</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ 다시 연습할 구절 */

function PhraseList({
  phrases,
  onSave,
  onDelete,
}: {
  phrases: Phrase[];
  onSave: (p: Phrase, r: PhraseScore) => void;
  onDelete: (id: string) => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const active = phrases.filter((p) => !p.mastered);
  const done = phrases.filter((p) => p.mastered);
  const list = showDone ? done : active;
  const when = (p: Phrase) => {
    if (p.mastered) return "졸업";
    const d = Math.ceil((p.due - Date.now()) / DAY);
    return d <= 0 ? "오늘" : `${d}일 뒤`;
  };
  return (
    <section className="mt-6 rounded-2xl bg-surface p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-xl font-semibold">다시 연습할 구절</h2>
        <button onClick={() => setShowDone(false)} className={`rounded-md px-2.5 py-1 text-sm font-semibold ${!showDone ? "bg-ink text-white" : "text-muted"}`}>
          연습 중 {active.length}
        </button>
        <button onClick={() => setShowDone(true)} className={`rounded-md px-2.5 py-1 text-sm font-semibold ${showDone ? "bg-ink text-white" : "text-muted"}`}>
          졸업 {done.length}
        </button>
      </div>
      <p className="mt-1 text-sm text-muted">
        비교에서 점수가 낮았던 구간이 자동으로 모여요. 85점 이상을 두 번 연속 받으면 졸업해요. 점수가 낮으면 다음 날, 높으면 며칠 뒤에 다시 나와요.
      </p>
      {list.length === 0 ? (
        <p className="mt-4 rounded-xl bg-paper p-4 text-sm text-muted">{showDone ? "아직 졸업한 구절이 없어요." : "연습할 구절이 없어요."}</p>
      ) : (
        <ul className="mt-4 divide-y divide-line">
          {list.map((p) => {
            return (
              <li key={p.id} className="py-3">
                <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{p.label}</div>
                  <div className="text-xs text-muted">
                    {p.songTitle} · 처음 {p.firstScore}점 · 최고 {p.bestScore}점{p.attempts ? ` · ${p.attempts}번 연습` : ""}
                  </div>
                </div>
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${when(p) === "오늘" ? "bg-mine-soft text-mine" : "bg-key text-muted"}`}>{when(p)}</span>
                <button
                  onClick={() => setOpenId(openId === p.id ? null : p.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${openId === p.id ? "border border-line" : "bg-ink text-white"}`}
                >
                  {openId === p.id ? "접기" : "연습"}
                </button>
                <button onClick={() => onDelete(p.id)} className="px-2 py-1.5 text-sm text-muted hover:text-bad">
                  삭제
                </button>
                </div>
                {openId === p.id && (
                  <div className="mt-3 rounded-xl bg-paper p-3">
                    <PhraseRunner phrase={p} onResult={(r) => onSave(p, r)} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
