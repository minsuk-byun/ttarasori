/**
 * 내 목소리 능력치 · 레벨 · 칭호 · 매일 미션 (연습 기록으로 계산)
 */
import type { Phrase, Session } from "./progress.ts";

const DAY = 24 * 60 * 60 * 1000;
const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));
const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const isToday = (t: number) => new Date(t).toDateString() === new Date().toDateString();

export type Stat = "pitch" | "rhythm" | "stability" | "range" | "stamina";
export const STAT_LABEL: Record<Stat, string> = { pitch: "음정", rhythm: "박자", stability: "안정감", range: "음역", stamina: "지구력" };
export const STAT_TIP: Record<Stat, string> = {
  pitch: "롱톤과 음 이동 연습, 음정 게임을 하면 올라요.",
  rhythm: "박자 맞춰 들어가기 연습을 하면 올라요.",
  stability: "롱톤 연습으로 긴 음을 곧게 유지하면 올라요.",
  range: "편하게 낼 수 있는 가장 낮은 음과 높은 음이 넓어지면 올라요.",
  stamina: "소리가 끊기지 않고 끝까지 부르면 올라요.",
};

export type Stats = Record<Stat, number | null>;

/** 기간 안의 기록으로 능력치 (0~100, 기록이 없으면 null) */
export function statsOf(sessions: Session[], from: number, to: number): Stats {
  const s = sessions.filter((x) => x.at >= from && x.at < to);
  const pitchVals = s
    .filter((x) => x.kind !== "repeat")
    .map((x) => (typeof x.pitchAcc === "number" ? x.pitchAcc * 100 : typeof x.meanAbsCents === "number" ? 100 - (x.meanAbsCents - 10) * 1.2 : null))
    .filter((v): v is number => v != null);
  const rhythmVals = s
    .filter((x) => typeof x.timingMs === "number" && (x.kind === "compare" || x.label?.includes("rhythm")))
    .map((x) => 100 - (Math.abs(x.timingMs!) - 30) / 2);
  const stabVals = s.filter((x) => x.label?.includes("longtone")).map((x) => x.score);
  const unstable = s.filter((x) => x.kind === "compare" && x.weak).map((x) => 100 - (x.weak!.unstable ?? 0) * 12);
  const lows = s.map((x) => x.rangeLow).filter((v): v is number => typeof v === "number");
  const highs = s.map((x) => x.rangeHigh).filter((v): v is number => typeof v === "number");
  const stamina = s
    .filter((x) => x.weak && (x.kind === "compare" || x.kind === "game" || x.kind === "drill"))
    .map((x) => 100 - (x.weak!.missing ?? 0) * 8);
  const st = avg([...stabVals, ...unstable]);
  return {
    pitch: pitchVals.length ? clamp(avg(pitchVals)!) : null,
    rhythm: rhythmVals.length ? clamp(avg(rhythmVals)!) : null,
    stability: st == null ? null : clamp(st),
    // 한 옥타브(12반음) = 50, 두 옥타브 = 100
    range: lows.length && highs.length ? clamp(((Math.max(...highs) - Math.min(...lows)) / 24) * 100) : null,
    stamina: stamina.length ? clamp(avg(stamina)!) : null,
  };
}

/** 최근 2주 vs 그 전 2주 */
export function statsNowAndBefore(sessions: Session[]) {
  const now = Date.now();
  return { now: statsOf(sessions, now - 14 * DAY, now + 1), before: statsOf(sessions, now - 28 * DAY, now - 14 * DAY) };
}

/* ------------------------------------------------------------------ 레벨 */

export function xpOf(sessions: Session[], phrases: Phrase[]): number {
  let xp = 0;
  for (const s of sessions) {
    xp += Math.round(s.seconds / 6); // 1분 = 10점
    xp += s.score >= 85 ? 15 : s.score >= 70 ? 8 : 3;
    if (s.stars) xp += s.stars * 10;
  }
  xp += phrases.filter((p) => p.mastered).length * 50;
  return xp;
}

const TITLES = ["새싹 보컬", "콧노래 탐험가", "샤워실 가수", "노래방 에이스", "골목 버스커", "무대 체질", "따라소리 마스터"];

export function levelOf(xp: number) {
  // 필요한 경험치가 조금씩 늘어나요: 100, 150, 200, ...
  let level = 1;
  let need = 100;
  let rest = xp;
  while (rest >= need) {
    rest -= need;
    level++;
    need += 50;
  }
  return { level, into: rest, need, title: TITLES[Math.min(TITLES.length - 1, Math.floor((level - 1) / 3))] };
}

/* ------------------------------------------------------------------ 칭호 */

export interface Badge {
  id: string;
  name: string;
  desc: string;
  got: boolean;
}

function streakMax(sessions: Session[]): number {
  const days = [...new Set(sessions.map((s) => new Date(s.at).toDateString()))].map((d) => new Date(d).getTime()).sort((a, b) => a - b);
  let best = 0;
  let cur = 0;
  for (let i = 0; i < days.length; i++) {
    cur = i && Math.round((days[i] - days[i - 1]) / DAY) === 1 ? cur + 1 : 1;
    best = Math.max(best, cur);
  }
  return best;
}

export function badgesOf(sessions: Session[], phrases: Phrase[]): Badge[] {
  const by = (label: string) => sessions.filter((s) => s.label?.includes(label));
  const games = sessions.filter((s) => s.kind === "game");
  const streak = streakMax(sessions);
  const lows = sessions.map((s) => s.rangeLow).filter((v): v is number => typeof v === "number");
  const highs = sessions.map((s) => s.rangeHigh).filter((v): v is number => typeof v === "number");
  const firstWidth = sessions.find((s) => s.rangeLow != null && s.rangeHigh != null);
  const width = lows.length && highs.length ? Math.max(...highs) - Math.min(...lows) : 0;
  const grew = firstWidth ? width - (firstWidth.rangeHigh! - firstWidth.rangeLow!) : 0;
  const compares = sessions.filter((s) => s.kind === "compare");
  const songUp = (() => {
    const m = new Map<string, number[]>();
    for (const s of compares) if (s.songKey) m.set(s.songKey, [...(m.get(s.songKey) ?? []), s.score]);
    return Math.max(0, ...[...m.values()].map((v) => Math.max(...v) - v[0]));
  })();
  const list: [string, string, string, boolean][] = [
    ["first", "첫 걸음", "처음으로 연습 기록을 남겼어요", sessions.length > 0],
    ["streak3", "사흘 연속", "3일 연속으로 연습했어요", streak >= 3],
    ["streak7", "일주일 개근", "7일 연속으로 연습했어요", streak >= 7],
    ["longtone", "롱톤 마스터", "롱톤 연습에서 90점 이상", by("longtone").some((s) => s.score >= 90)],
    ["rhythm", "박자 장인", "박자 연습에서 90점 이상", by("rhythm").some((s) => s.score >= 90)],
    ["sniper", "음정 저격수", "음정 게임에서 별 3개", games.some((s) => (s.stars ?? 0) >= 3)],
    ["combo", "콤보 행진", "음정 게임에서 20 콤보", games.some((s) => (s.maxCombo ?? 0) >= 20)],
    ["grad5", "구절 졸업생", "다시 연습할 구절 5개 졸업", phrases.filter((p) => p.mastered).length >= 5],
    ["range3", "음역 확장", "처음보다 음역이 3반음 넓어졌어요", grew >= 3],
    ["songup", "역전의 명수", "같은 곡 점수를 15점 이상 올렸어요", songUp >= 15],
    ["perfect", "백점 만점", "어떤 연습이든 100점", sessions.some((s) => s.score >= 100)],
    ["hour", "한 시간의 노력", "모두 합쳐 60분 연습", sessions.reduce((a, s) => a + s.seconds, 0) >= 3600],
  ];
  return list.map(([id, name, desc, got]) => ({ id, name, desc, got }));
}

/* ------------------------------------------------------------------ 매일 미션 */

export interface Mission {
  id: string;
  text: string;
  done: boolean;
  progress: string;
}

export function missionsOf(sessions: Session[], weakTop: string | null): Mission[] {
  const today = sessions.filter((s) => isToday(s.at));
  const minutes = Math.round(today.reduce((a, s) => a + s.seconds, 0) / 60);
  const games = today.filter((s) => s.kind === "game");
  const drills = today.filter((s) => s.kind === "drill");
  const pool: Mission[] = [
    { id: "min10", text: "오늘 10분 연습하기", done: minutes >= 10, progress: `${Math.min(minutes, 10)}/10분` },
    { id: "star2", text: "음정 게임에서 별 2개 이상", done: games.some((s) => (s.stars ?? 0) >= 2), progress: `최고 별 ${Math.max(0, ...games.map((s) => s.stars ?? 0))}개` },
    { id: "combo10", text: "음정 게임 10 콤보", done: games.some((s) => (s.maxCombo ?? 0) >= 10), progress: `최고 ${Math.max(0, ...games.map((s) => s.maxCombo ?? 0))} 콤보` },
    { id: "drill85", text: "연습 하나에서 85점 넘기기", done: drills.some((s) => s.score >= 85), progress: `최고 ${Math.max(0, ...drills.map((s) => s.score))}점` },
    { id: "phrase1", text: "다시 연습할 구절 1개 부르기", done: today.some((s) => s.kind === "phrase" || s.kind === "repeat"), progress: today.some((s) => s.kind === "phrase" || s.kind === "repeat") ? "완료" : "0/1" },
    { id: "compare1", text: "내 노래 비교 한 번 하기", done: today.some((s) => s.kind === "compare"), progress: today.some((s) => s.kind === "compare") ? "완료" : "0/1" },
    { id: "long85", text: "롱톤 연습 85점 넘기기", done: drills.some((s) => s.label?.includes("longtone") && s.score >= 85), progress: `최고 ${Math.max(0, ...drills.filter((s) => s.label?.includes("longtone")).map((s) => s.score))}점` },
    { id: "rhythm85", text: "박자 연습 85점 넘기기", done: drills.some((s) => s.label?.includes("rhythm") && s.score >= 85), progress: `최고 ${Math.max(0, ...drills.filter((s) => s.label?.includes("rhythm")).map((s) => s.score))}점` },
  ];
  // 날마다 3개: 기본 1개 + 약점 관련 1개 + 날짜로 고른 1개
  const day = Math.floor(Date.now() / DAY);
  const weakPick = weakTop === "late" || weakTop === "early" ? "rhythm85" : weakTop === "unstable" || weakTop === "flat" || weakTop === "sharp" ? "long85" : "drill85";
  const rest = pool.filter((m) => !["min10", weakPick].includes(m.id));
  const third = rest[day % rest.length];
  return [pool.find((m) => m.id === "min10")!, pool.find((m) => m.id === weakPick)!, third];
}
