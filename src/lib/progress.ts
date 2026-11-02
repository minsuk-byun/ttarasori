"use client";

/**
 * 연습 기록 (이 브라우저의 IndexedDB 에만 저장)
 * - sessions: 비교 분석·구간 다시 부르기·오늘의 연습 드릴 결과
 * - phrases:  다시 연습할 구절 모음 (점수가 낮았던 구간, 가이드 조각 음원 포함)
 */

export type SessionKind = "compare" | "repeat" | "drill" | "phrase" | "game";

export interface Weak {
  flat: number;
  sharp: number;
  late: number;
  early: number;
  missing: number;
  unstable: number;
  scoop: number;
}

export interface Session {
  id: string;
  at: number;
  kind: SessionKind;
  songKey?: string;
  songTitle?: string;
  /** 드릴 종류 등 */
  label?: string;
  score: number;
  /** ±50센트(비교) 또는 ±30센트(드릴) 안에 들어온 비율 */
  pitchAcc?: number;
  meanAbsCents?: number;
  /** 평균 음정 치우침 (센트, -면 낮게) */
  offsetCents?: number;
  timingMs?: number;
  /** 연습에 쓴 시간 (초) */
  seconds: number;
  weak?: Partial<Weak>;
  /** 내가 낸 음역 (MIDI, 10%/90% 분위) */
  rangeLow?: number;
  rangeHigh?: number;
  /** 음정 게임 결과 */
  stars?: number;
  maxCombo?: number;
  perfects?: number;
}

export interface Phrase {
  id: string;
  songKey: string;
  songTitle: string;
  /** 가사 또는 음 이름 */
  label: string;
  /** 원래 곡에서의 위치 (초) */
  songStart: number;
  /** 가이드 조각 (wav) — 앞뒤 여유 포함 */
  clip: Blob;
  /** 조각 안에서 연습 구간이 시작하는 위치·길이 (초) */
  clipStart: number;
  segDur: number;
  /** 목표 음 (조각 기준 시간) */
  tones: { midi: number; start: number; dur: number }[];
  createdAt: number;
  lastAt: number | null;
  firstScore: number;
  bestScore: number;
  lastScore: number | null;
  attempts: number;
  /** 연속으로 85점 이상 받은 횟수 (2번이면 졸업) */
  streakGood: number;
  mastered: boolean;
  /** 다음에 다시 연습할 때 */
  due: number;
}

const DB = "ttarasori-progress";
const DAY = 24 * 60 * 60 * 1000;
const MAX_PHRASES = 40;
const MAX_SESSIONS = 1000;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("sessions")) db.createObjectStore("sessions", { keyPath: "id" });
      if (!db.objectStoreNames.contains("phrases")) db.createObjectStore("phrases", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(store: "sessions" | "phrases", mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        t.oncomplete = () => db.close();
      }),
  );
}

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

/** 같은 곡인지 알아보는 열쇠 (이름 + 파일 크기) */
export const songKeyOf = (name: string, size: number) => `${name}|${size}`;
export const songTitleOf = (name: string) =>
  name
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/ \(보컬\)$/, "")
    .slice(0, 40) || "이름 없는 곡";

/* ------------------------------------------------------------------ 기록 */

export async function addSession(s: Omit<Session, "id" | "at">): Promise<void> {
  try {
    await run("sessions", "readwrite", (st) => st.put({ ...s, id: newId(), at: Date.now() }));
    const all = await listSessions();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_SESSIONS))) await run("sessions", "readwrite", (st) => st.delete(old.id));
  } catch {
    /* 사생활 보호 모드 등에서는 저장 없이 계속 */
  }
}

/** 오래된 것부터 */
export async function listSessions(): Promise<Session[]> {
  try {
    const all = await run<Session[]>("sessions", "readonly", (s) => s.getAll() as IDBRequest<Session[]>);
    return all.sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ 구절 모음 */

export async function listPhrases(): Promise<Phrase[]> {
  try {
    const all = await run<Phrase[]>("phrases", "readonly", (s) => s.getAll() as IDBRequest<Phrase[]>);
    return all.sort((a, b) => a.due - b.due);
  } catch {
    return [];
  }
}

const samePlace = (p: Phrase, songKey: string, start: number) => p.songKey === songKey && Math.abs(p.songStart - start) < 1;

/** 점수가 낮았던 구간 추가 (이미 있으면 점수만 반영) */
export async function addPhrase(
  p: Omit<Phrase, "id" | "createdAt" | "lastAt" | "bestScore" | "lastScore" | "attempts" | "streakGood" | "mastered" | "due">,
): Promise<void> {
  try {
    const all = await listPhrases();
    const old = all.find((x) => samePlace(x, p.songKey, p.songStart));
    if (old) {
      await recordPhraseScore(old.id, p.firstScore);
      return;
    }
    const full: Phrase = {
      ...p,
      id: newId(),
      createdAt: Date.now(),
      lastAt: null,
      bestScore: p.firstScore,
      lastScore: null,
      attempts: 0,
      streakGood: 0,
      mastered: false,
      due: Date.now(),
    };
    await run("phrases", "readwrite", (st) => st.put(full));
    // 너무 많으면 졸업한 것 → 오래된 것 순으로 정리
    const after = await listPhrases();
    if (after.length > MAX_PHRASES) {
      const drop = [...after].sort((a, b) => Number(b.mastered) - Number(a.mastered) || a.createdAt - b.createdAt).slice(0, after.length - MAX_PHRASES);
      for (const d of drop) await run("phrases", "readwrite", (st) => st.delete(d.id));
    }
  } catch {
    /* 무시 */
  }
}

/** 연습 결과 반영: 점수에 따라 다음 연습 날짜를 정하고, 85점 이상 두 번 연속이면 졸업 */
export async function recordPhraseScore(id: string, score: number): Promise<Phrase | null> {
  try {
    const p = await run<Phrase | undefined>("phrases", "readonly", (s) => s.get(id) as IDBRequest<Phrase | undefined>);
    if (!p) return null;
    const good = score >= 85;
    const streakGood = good ? p.streakGood + 1 : 0;
    const next: Phrase = {
      ...p,
      attempts: p.attempts + 1,
      lastAt: Date.now(),
      lastScore: score,
      bestScore: Math.max(p.bestScore, score),
      streakGood,
      mastered: streakGood >= 2,
      due: Date.now() + (score < 70 ? 0 : good ? 3 * DAY : DAY),
    };
    await run("phrases", "readwrite", (s) => s.put(next));
    return next;
  } catch {
    return null;
  }
}

/** 비교 화면의 구간 다시 부르기 결과를 같은 구절에 반영 */
export async function recordPhraseByPlace(songKey: string, start: number, score: number) {
  const all = await listPhrases();
  const p = all.find((x) => samePlace(x, songKey, start));
  if (p) await recordPhraseScore(p.id, score);
}

export async function deletePhrase(id: string) {
  try {
    await run("phrases", "readwrite", (s) => s.delete(id));
  } catch {
    /* 무시 */
  }
}

/* ------------------------------------------------------------------ 분석 */

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** 연속 연습일 (오늘이나 어제까지 이어진 날 수) */
export function streakDays(sessions: Session[]): number {
  const days = new Set(sessions.map((s) => dayKey(s.at)));
  let n = 0;
  const now = Date.now();
  // 오늘 아직 안 했으면 어제부터 셈
  let t = days.has(dayKey(now)) ? now : now - DAY;
  while (days.has(dayKey(t))) {
    n++;
    t -= DAY;
  }
  return n;
}

/** 이번 주(월요일부터) 연습 시간 (분) */
export function weekMinutes(sessions: Session[]): number {
  const d = new Date();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  return Math.round(sessions.filter((s) => s.at >= monday).reduce((sum, s) => sum + s.seconds, 0) / 60);
}

export const practicedToday = (sessions: Session[]) => sessions.some((s) => dayKey(s.at) === dayKey(Date.now()));

export interface Profile {
  /** 약점 비중 (0~1) — 최근 기록 기준 */
  weak: Weak;
  /** 가장 큰 약점 */
  top: keyof Weak | null;
  offsetCents: number;
  timingMs: number;
  /** 편하게 낼 수 있는 음역 (MIDI) */
  range: { low: number; high: number } | null;
  /** 판단에 쓴 기록 수 */
  samples: number;
}

export function profileOf(sessions: Session[]): Profile {
  const recent = sessions.filter((s) => s.kind === "compare" || s.kind === "drill" || s.kind === "phrase" || s.kind === "game").slice(-12);
  const w: Weak = { flat: 0, sharp: 0, late: 0, early: 0, missing: 0, unstable: 0, scoop: 0 };
  for (const s of recent) for (const k of Object.keys(w) as (keyof Weak)[]) w[k] += s.weak?.[k] ?? 0;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  const weak = { ...w };
  if (total) for (const k of Object.keys(weak) as (keyof Weak)[]) weak[k] = weak[k] / total;
  const top = total ? (Object.entries(weak).sort((a, b) => b[1] - a[1])[0][0] as keyof Weak) : null;
  const avg = (vals: (number | undefined)[]) => {
    const v = vals.filter((x): x is number => typeof x === "number");
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const lows = recent.map((s) => s.rangeLow).filter((x): x is number => typeof x === "number");
  const highs = recent.map((s) => s.rangeHigh).filter((x): x is number => typeof x === "number");
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return {
    weak,
    top,
    offsetCents: avg(recent.map((s) => s.offsetCents)),
    timingMs: avg(recent.map((s) => s.timingMs)),
    range: lows.length && highs.length ? { low: Math.round(med(lows)), high: Math.round(med(highs)) } : null,
    samples: recent.length,
  };
}

/* ------------------------------------------------------------------ 음원 */

/** PCM → 16bit wav (구절 조각 저장용) */
export function encodeWav(x: Float32Array, sr: number): Blob {
  const buf = new ArrayBuffer(44 + x.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, "RIFF");
  v.setUint32(4, 36 + x.length * 2, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), true);
  return new Blob([buf], { type: "audio/wav" });
}
