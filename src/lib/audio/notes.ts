/**
 * 글자(음표) 단위 피드백
 * - 연습곡: 서버가 알려 준 음표(글자·시작·길이)를 그대로 사용
 * - 일반 AI 커버: 가이드 음정 곡선에서 음표를 자동으로 나눠서 사용
 * 비교 결과(compareFeatures)의 refMidi / userMidi 는 이미 시간·옥타브·키가 보정돼 있어요.
 */
import type { Comparison } from "./compare.ts";

export interface NoteInfo {
  midi: number;
  start: number;
  dur: number;
  syllable: string;
}

export type NoteProblem = "flat" | "sharp" | "late" | "early" | "missing" | "scoop";

export interface NoteResult {
  index: number;
  start: number;
  dur: number;
  syllable: string;
  /** 목표 음 (MIDI) */
  target: number;
  /** 목표 대비 음정 차이 (센트), 소리가 없으면 null */
  cents: number | null;
  /** 들어온 타이밍 차이 (ms, +면 늦게), 판단할 수 없으면 null */
  onsetMs: number | null;
  /** 이 음 동안 소리를 낸 비율 */
  coverage: number;
  problems: NoteProblem[];
  severity: 0 | 1 | 2 | 3;
  /** 한 줄 설명 */
  text: string;
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 가이드 음정 곡선을 음표로 나누기 (가사 정보가 없는 AI 커버용) */
export function autoNotes(refMidi: (number | null)[], hop: number, opts: { thresh?: number; hold?: number } = {}): NoteInfo[] {
  const thresh = opts.thresh ?? 0.7; // 이만큼(반음) 벗어나면 다른 음
  const hold = opts.hold ?? 3; // 이 프레임 수만큼 계속 벗어나야 음이 바뀐 것으로 봄
  const out: NoteInfo[] = [];
  const minLen = Math.max(3, Math.round(0.12 / hop));
  let i = 0;
  while (i < refMidi.length) {
    if (refMidi[i] == null) {
      i++;
      continue;
    }
    let a = i;
    let buf: number[] = [refMidi[i]!];
    let off = 0; // 기준에서 벗어난 연속 프레임 수
    let j = i + 1;
    const flush = (end: number) => {
      if (end - a >= minLen) out.push({ midi: median(buf), start: a * hop, dur: (end - a) * hop, syllable: "" });
    };
    for (; j <= refMidi.length; j++) {
      const v = j < refMidi.length ? refMidi[j] : null;
      if (v == null) {
        flush(j);
        break;
      }
      const ref = median(buf.slice(-15));
      if (Math.abs(v - ref) > thresh) {
        off++;
        if (off >= hold) {
          const b = j - hold + 1;
          flush(b);
          a = b;
          buf = refMidi.slice(b, j + 1).filter((x): x is number => x != null);
          off = 0;
          continue;
        }
      } else off = 0;
      buf.push(v);
    }
    i = j + 1;
  }
  return out;
}

/** 센트 차이를 말로 */
export function centsWords(c: number): string {
  const a = Math.abs(c);
  if (a < 50) return "살짝";
  if (a < 80) return "반음 가까이";
  if (a < 140) return "반음쯤";
  return `약 ${Math.round(a / 100)}반음`;
}

export function analyzeNotes(c: Comparison, notes: NoteInfo[]): NoteResult[] {
  const hop = c.hopSec;
  const n = c.refMidi.length;
  const fr = (t: number) => Math.max(0, Math.min(n, Math.round(t / hop)));

  return notes.map((nt, index) => {
    const i0 = fr(nt.start);
    const i1 = Math.max(i0 + 1, fr(nt.start + nt.dur));
    const len = i1 - i0;
    // 음의 앞 25%(들어가는 부분)와 뒤 15%(빠지는 부분)는 빼고 가운데로 음정 판단
    let c0 = i0 + Math.floor(len * 0.25);
    let c1 = i1 - Math.floor(len * 0.15);
    if (c1 - c0 < 2) {
      c0 = i0;
      c1 = i1;
    }

    const refCore: number[] = [];
    for (let i = c0; i < c1; i++) if (c.refMidi[i] != null) refCore.push(c.refMidi[i]!);
    const target = refCore.length >= 2 ? median(refCore) : nt.midi;

    const diffs: number[] = [];
    for (let i = c0; i < c1; i++) {
      const u = c.userMidi[i];
      if (u == null) continue;
      const d = (u - target) * 100;
      if (Math.abs(d) < 600) diffs.push(d);
    }
    const cents = diffs.length >= 2 ? median(diffs) : null;

    // 소리 낸 비율: 조금 늦게 들어와도 인정되도록 끝을 0.1초 늘려서 봄
    const cvEnd = Math.min(n, i1 + Math.round(0.1 / hop));
    let voiced = 0;
    for (let i = i0; i < cvEnd; i++) if (c.userMidi[i] != null) voiced++;
    const coverage = Math.min(1, voiced / len);

    // 들어온 타이밍: 앞 음과 이어 부르는(같은 높이 레가토) 경우에는 판단하지 않음
    const prev = notes[index - 1];
    const gapBefore = prev ? nt.start - (prev.start + prev.dur) : 1;
    const jump = prev ? Math.abs(prev.midi - nt.midi) : 12;
    let onsetMs: number | null = null;
    if (cents != null && (gapBefore > 0.08 || jump >= 1)) {
      const tol = Math.max(100, Math.abs(cents) + 60) / 100;
      const near = (arr: (number | null)[], i: number, t: number) => arr[i] != null && Math.abs(arr[i]! - target) <= t;
      let tr = -1;
      for (let i = Math.max(0, i0 - fr(0.1)); i < Math.min(n, i0 + fr(0.25)); i++)
        if (near(c.refMidi, i, 0.6)) {
          tr = i;
          break;
        }
      let tu = -1;
      const from = Math.max(0, i0 - fr(0.3), prev ? fr(prev.start + prev.dur * 0.5) : 0);
      for (let i = from; i < Math.min(n, i0 + fr(0.45)); i++)
        if (near(c.userMidi, i, tol) && near(c.userMidi, i + 1, tol)) {
          tu = i;
          break;
        }
      if (tr >= 0 && tu >= 0) onsetMs = Math.round((tu - tr) * hop * 1000);
    }

    // 아래에서 끌어올리기: 들어가는 순간 많이 낮았다가 목표음으로 올라감
    let scoop = false;
    if (cents != null && Math.abs(cents) < 50 && len * hop >= 0.25) {
      let low = 0;
      for (let i = i0; i < Math.min(i1, i0 + fr(0.15)); i++) {
        const u = c.userMidi[i];
        if (u != null && (u - target) * 100 < -120) low++;
      }
      scoop = low >= 3;
    }

    const problems: NoteProblem[] = [];
    const parts: string[] = [];
    let severity: 0 | 1 | 2 | 3 = 0;
    const bump = (s: 1 | 2 | 3) => {
      if (s > severity) severity = s;
    };

    if (coverage < 0.35 || cents == null) {
      problems.push("missing");
      parts.push("소리가 거의 안 났어요");
      bump(3);
    } else {
      if (cents <= -30 || cents >= 30) {
        const flat = cents < 0;
        problems.push(flat ? "flat" : "sharp");
        parts.push(`${centsWords(cents)} ${flat ? "낮아요" : "높아요"} (${cents > 0 ? "+" : "−"}${Math.round(Math.abs(cents))}센트)`);
        bump(Math.abs(cents) >= 100 ? 3 : Math.abs(cents) >= 50 ? 2 : 1);
      }
      if (onsetMs != null && Math.abs(onsetMs) >= 120) {
        const late = onsetMs > 0;
        problems.push(late ? "late" : "early");
        parts.push(`${(Math.abs(onsetMs) / 1000).toFixed(2)}초 ${late ? "늦게" : "빨리"} 들어왔어요`);
        bump(Math.abs(onsetMs) >= 250 ? 2 : 1);
      }
      if (scoop) {
        problems.push("scoop");
        parts.push("아래에서 끌어올리며 시작했어요");
        bump(1);
      }
    }

    return {
      index,
      start: nt.start,
      dur: nt.dur,
      syllable: nt.syllable,
      target,
      cents,
      onsetMs,
      coverage,
      problems,
      severity,
      text: parts.length ? parts.join(", ") : "정확해요",
    };
  });
}

/** 한 줄씩 끊어 보여 주기 (쉼이 길거나 글자가 많으면 줄바꿈) */
export function splitLines(notes: { start: number; dur: number }[], maxPerLine = 12, gap = 0.3): number[][] {
  const lines: number[][] = [];
  notes.forEach((nt, i) => {
    const prev = notes[i - 1];
    const cur = lines[lines.length - 1];
    if (!cur || !prev || nt.start - (prev.start + prev.dur) > gap || cur.length >= maxPerLine) lines.push([i]);
    else cur.push(i);
  });
  return lines;
}

export const PROBLEM_TIP: Record<NoteProblem, string> = {
  flat: "목표음을 머릿속으로 먼저 떠올리고, 살짝 위에서 내려 잡는다는 느낌으로 불러 보세요. 숨을 배로 받쳐 주면 음이 덜 처져요.",
  sharp: "목과 턱 힘을 빼고 소리를 위로 밀지 말고 앞으로 보내 보세요. 고음 직전에 힘이 들어가면 음이 뜨기 쉬워요.",
  late: "첫 자음을 박보다 조금 먼저 시작해서 모음이 박에 딱 떨어지게 해 보세요. 들어가기 전에 숨을 미리 쉬어 두면 늦지 않아요.",
  early: "반주를 들으며 박을 한 번 기다렸다 들어가 보세요. 빠른 부분일수록 서두르기 쉬워요.",
  missing: "이 글자에서 소리가 끊겼어요. 앞 글자에서 숨을 아끼고, 이 글자까지 소리를 이어서 내 보세요.",
  scoop: "음 아래에서 미끄러져 올라가는 습관이에요. 처음부터 목표음에 바로 '꽂는다'는 느낌으로 짧게 '아!' 하고 시작해 보세요.",
};
