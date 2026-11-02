/**
 * 원곡 음원 없이 내 녹음만으로 채점 (원곡 따라 부르기 모드)
 * - 음정: 각 음이 정확한 음 높이(평균율, A4=440Hz)에 얼마나 붙어 있는지
 * - 키: 부른 음들의 분포로 장조/단조 추정 → 음계 밖 음 찾기
 * - 흔들림: 긴 음 안에서 음정이 출렁이는 정도
 * - 음역: 낸 음 중 가장 낮은/높은 음
 * - 박자: 사용자가 원곡에 맞춰 두드린 박이 있으면 그 박 기준으로 늦는/빠른 경향
 */
import { autoNotes } from "./notes.ts";
import { hzToMidi, type Features } from "./features.ts";

export interface BeatGrid {
  /** 한 박 길이 (초) */
  period: number;
  /** 원곡 영상 시간 기준 아무 박 하나의 위치 (초) */
  phase: number;
}

export type SelfProblem = "flat" | "sharp" | "unstable" | "outOfScale";

export interface SelfNote {
  index: number;
  start: number;
  dur: number;
  /** 부른 음 (MIDI 실수, 음 가운데 부분의 중앙값) */
  midi: number;
  /** 가장 가까운 정확한 음 */
  target: number;
  /** 정확한 음과의 차이 (센트) */
  cents: number;
  /** 음 안에서 출렁인 폭 (센트) */
  spread: number;
  inScale: boolean;
  problems: SelfProblem[];
  severity: 0 | 1 | 2 | 3;
  text: string;
}

export interface SelfCheck {
  hopSec: number;
  duration: number;
  midi: (number | null)[];
  notes: SelfNote[];
  key: { tonic: number; minor: boolean; name: string; confidence: number } | null;
  range: { low: number; high: number } | null;
  overall: {
    score: number;
    /** ±30센트 안에 들어온 음 비율 (길이 가중) */
    accuracy: number;
    meanAbsCents: number;
    /** 전체적으로 높게/낮게 부르는 경향 (센트) */
    offsetCents: number;
    unstableRatio: number;
    outOfScaleCount: number;
    /** 박 기준 들어오는 타이밍 경향 (ms, +면 늦음), 박 정보가 없으면 null */
    timingMs: number | null;
  };
  summary: string[];
}

const PC_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const PC_KO = ["도", "도#", "레", "미b", "미", "파", "파#", "솔", "라b", "라", "시b", "시"];
// Krumhansl–Kessler 조성 프로파일
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10, 11]; // 자연단음계 + 화성단음계 7음

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pc = (m: number) => ((Math.round(m) % 12) + 12) % 12;

export const pitchLabel = (m: number) => {
  const r = Math.round(m);
  return `${PC_NAMES[pc(r)]}${Math.floor(r / 12) - 1}`;
};

function corr(a: number[], b: number[]) {
  const ma = a.reduce((s, v) => s + v, 0) / a.length;
  const mb = b.reduce((s, v) => s + v, 0) / b.length;
  let n = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    n += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? n / Math.sqrt(da * db) : 0;
}

function detectKey(notes: { midi: number; dur: number }[]) {
  const hist = new Array(12).fill(0);
  for (const n of notes) hist[pc(n.midi)] += n.dur;
  if (hist.reduce((s, v) => s + v, 0) < 2) return null;
  let best = { tonic: 0, minor: false, r: -2 };
  let second = -2;
  for (let t = 0; t < 12; t++)
    for (const minor of [false, true]) {
      const prof = minor ? MINOR : MAJOR;
      const rot = hist.map((_, i) => hist[(i + t) % 12]);
      const r = corr(rot, prof);
      if (r > best.r) {
        second = best.r;
        best = { tonic: t, minor, r };
      } else if (r > second) second = r;
    }
  return {
    tonic: best.tonic,
    minor: best.minor,
    name: `${PC_NAMES[best.tonic]} ${best.minor ? "단조" : "장조"} (${PC_KO[best.tonic]}${best.minor ? " 단조" : " 장조"})`,
    confidence: clamp((best.r - Math.max(0, second)) * 4 + best.r * 0.5, 0, 1),
  };
}

export function selfCheck(f: Features, opts: { beats?: BeatGrid | null; videoStart?: number } = {}): SelfCheck {
  const hop = f.hopSec;
  const midi: (number | null)[] = Array.from(f.f0, (v) => (v > 0 ? hzToMidi(v) : null));
  // 비브라토·흔들림으로 음이 쪼개지지 않게 넉넉하게 (0.85반음 이상, 0.1초 넘게 벗어나야 다른 음)
  const raw = autoNotes(midi, hop, { thresh: 0.85, hold: Math.max(3, Math.round(0.1 / hop)) });

  // 음마다 가운데 부분 음정과 출렁임 계산
  const base = raw.map((nt) => {
    const i0 = Math.round(nt.start / hop);
    const i1 = Math.round((nt.start + nt.dur) / hop);
    const len = i1 - i0;
    const c0 = i0 + Math.floor(len * 0.2);
    const c1 = Math.max(c0 + 2, i1 - Math.floor(len * 0.1));
    const vals: number[] = [];
    for (let i = c0; i < c1; i++) if (midi[i] != null) vals.push(midi[i]!);
    const m = vals.length ? median(vals) : nt.midi;
    const cents = vals.map((v) => (v - m) * 100);
    const spread = cents.length > 5 ? (pct(cents, 0.84) - pct(cents, 0.16)) / 2 : 0;
    return { start: nt.start, dur: nt.dur, midi: m, spread };
  });

  const key = detectKey(base);
  const scale = key ? (key.minor ? MINOR_SCALE : MAJOR_SCALE).map((s) => (s + key.tonic) % 12) : null;

  const notes: SelfNote[] = base.map((b, index) => {
    const target = Math.round(b.midi);
    const cents = (b.midi - target) * 100;
    const inScale = !scale || (key!.confidence < 0.35 ? true : scale.includes(pc(target)));
    const problems: SelfProblem[] = [];
    const parts: string[] = [];
    let severity: 0 | 1 | 2 | 3 = 0;
    const bump = (s: 1 | 2 | 3) => {
      if (s > severity) severity = s;
    };
    if (Math.abs(cents) >= 25) {
      problems.push(cents < 0 ? "flat" : "sharp");
      parts.push(`${pitchLabel(target)}보다 ${Math.round(Math.abs(cents))}센트 ${cents < 0 ? "낮아요" : "높아요"}`);
      bump(Math.abs(cents) >= 40 ? 2 : 1);
    }
    if (b.dur >= 0.45 && b.spread >= 35) {
      problems.push("unstable");
      parts.push(`음이 ±${Math.round(b.spread)}센트 흔들려요`);
      bump(b.spread >= 60 ? 2 : 1);
    }
    if (!inScale && b.dur >= 0.2) {
      problems.push("outOfScale");
      parts.push(`${key!.name.split(" (")[0]} 음계 밖의 음이에요`);
      bump(1);
    }
    return {
      index,
      start: b.start,
      dur: b.dur,
      midi: b.midi,
      target,
      cents,
      spread: b.spread,
      inScale,
      problems,
      severity,
      text: parts.length ? parts.join(", ") : `${pitchLabel(target)} 정확해요`,
    };
  });

  const total = notes.reduce((s, n) => s + n.dur, 0) || 1;
  const accuracy = notes.reduce((s, n) => s + (Math.abs(n.cents) < 30 ? n.dur : 0), 0) / total;
  const meanAbsCents = notes.reduce((s, n) => s + Math.abs(n.cents) * n.dur, 0) / total;
  const offsetCents = notes.reduce((s, n) => s + n.cents * n.dur, 0) / total;
  const longNotes = notes.filter((n) => n.dur >= 0.45);
  const unstableRatio = longNotes.length ? longNotes.filter((n) => n.problems.includes("unstable")).length / longNotes.length : 0;
  const outOfScaleCount = notes.filter((n) => n.problems.includes("outOfScale")).length;

  // 박자 경향: 사용자가 두드린 박의 8분음표 격자 기준
  let timingMs: number | null = null;
  if (opts.beats && opts.videoStart != null && notes.length >= 6) {
    const sub = opts.beats.period / 2;
    const offs: number[] = [];
    notes.forEach((n, i) => {
      const prev = notes[i - 1];
      const fresh = !prev || n.start - (prev.start + prev.dur) > 0.06 || Math.abs(prev.target - n.target) >= 1;
      if (!fresh || n.dur < 0.15) return;
      const tv = opts.videoStart! + n.start - 0.04; // 마이크 입력 지연 보정(대략)
      let o = (tv - opts.beats!.phase) % sub;
      if (o < 0) o += sub;
      if (o > sub / 2) o -= sub;
      offs.push(o * 1000);
    });
    if (offs.length >= 5) timingMs = Math.round(median(offs));
  }

  const mids = notes.filter((n) => n.dur >= 0.15).map((n) => n.midi);
  const range = mids.length >= 3 ? { low: Math.round(pct(mids, 0.05)), high: Math.round(pct(mids, 0.95)) } : null;

  let score = 100;
  score -= clamp((meanAbsCents - 10) * 0.9, 0, 45);
  score -= unstableRatio * 20;
  score -= clamp((outOfScaleCount / Math.max(1, notes.length)) * 60, 0, 20);
  if (timingMs != null) score -= clamp((Math.abs(timingMs) - 50) / 8, 0, 10);
  score = Math.round(clamp(score, 0, 100));

  const summary: string[] = [];
  if (!notes.length) summary.push("노래 소리를 찾지 못했어요. 마이크 가까이에서 다시 불러 보세요.");
  else {
    summary.push(`부른 음 ${notes.length}개 중 ${Math.round(accuracy * 100)}%가 정확한 음 높이(±30센트)에 들어왔어요.`);
    if (Math.abs(offsetCents) >= 15)
      summary.push(
        `전체적으로 평균 ${Math.round(Math.abs(offsetCents))}센트 ${offsetCents < 0 ? "낮게" : "높게"} 부르는 경향이 있어요. ${
          offsetCents < 0 ? "음이 처지지 않게 숨을 받쳐 주세요." : "목에 힘을 빼고 불러 보세요."
        }`,
      );
    if (unstableRatio >= 0.25) summary.push(`긴 음 중 ${Math.round(unstableRatio * 100)}%에서 음이 흔들렸어요. 롱톤 연습이 도움이 돼요.`);
    if (key && key.confidence >= 0.35) summary.push(`${key.name}로 부른 것 같아요.`);
    if (outOfScaleCount) summary.push(`음계 밖 음이 ${outOfScaleCount}개 있어요. 원곡에 없는 음이라면 틀린 음일 수 있어요.`);
    if (timingMs != null && Math.abs(timingMs) >= 60)
      summary.push(`두드린 박보다 평균 ${Math.abs(timingMs)}ms ${timingMs > 0 ? "늦게" : "빨리"} 들어가는 경향이 있어요.`);
    if (range) summary.push(`이번에 낸 음역은 ${pitchLabel(range.low)} ~ ${pitchLabel(range.high)}예요.`);
  }

  return {
    hopSec: hop,
    duration: f.duration,
    midi,
    notes,
    key: key && key.confidence >= 0.35 ? key : null,
    range,
    overall: { score, accuracy, meanAbsCents, offsetCents, unstableRatio, outOfScaleCount, timingMs },
    summary,
  };
}

/** 교정본 목표: 각 음을 가장 가까운 정확한 음으로 (내 녹음 시간축) */
export function snapTarget(c: SelfCheck): { hop: number; midi: (number | null)[] } {
  const out: (number | null)[] = new Array(c.midi.length).fill(null);
  for (const n of c.notes) {
    const i0 = Math.round(n.start / c.hopSec);
    const i1 = Math.min(out.length, Math.round((n.start + n.dur) / c.hopSec));
    for (let i = i0; i < i1; i++) out[i] = n.target;
  }
  return { hop: c.hopSec, midi: out };
}

/** 박자 두드리기 → 박 길이와 위치 */
export function beatsFromTaps(taps: number[]): (BeatGrid & { bpm: number }) | null {
  if (taps.length < 4) return null;
  const recent = taps.slice(-12);
  const iv: number[] = [];
  for (let i = 1; i < recent.length; i++) iv.push(recent[i] - recent[i - 1]);
  const period = median(iv.filter((d) => d > 0.25 && d < 1.5));
  if (!period) return null;
  // 박 위치: 각 탭을 박 격자에 맞춰 원형 평균
  let sx = 0;
  let sy = 0;
  for (const t of recent) {
    const a = ((t % period) / period) * 2 * Math.PI;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  const phase = (((Math.atan2(sy, sx) / (2 * Math.PI)) * period) % period + period) % period;
  return { period, phase, bpm: Math.round(60 / period) };
}
