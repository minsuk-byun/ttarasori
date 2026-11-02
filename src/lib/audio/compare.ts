/**
 * 가이드(AI 커버) vs 내 노래 비교 분석
 * 1) 음량 곡선 상호상관으로 전체 시간차 보정
 * 2) 옥타브/키 차이 보정
 * 3) 가이드 기준 프레이즈 분할 → 구간별 음정·안정성·끊김·박자·강약·비브라토 평가
 * 4) 구간별 연습 팁 생성
 */
import { type Features, hzToMidi } from "./features.ts";

export type IssueKind =
  | "flat"
  | "sharp"
  | "unstable"
  | "dropout"
  | "late"
  | "early"
  | "dynamics"
  | "vibrato"
  | "good";

export interface Issue {
  kind: IssueKind;
  severity: 0 | 1 | 2 | 3;
  title: string;
  detail: string;
  tip: string;
}

export interface Segment {
  index: number;
  start: number;
  end: number;
  i0: number;
  i1: number;
  score: number;
  pitchMean: number;
  pitchAbs: number;
  pitchStd: number;
  coverage: number;
  timingMs: number;
  dynRef: number;
  dynUser: number;
  vibRef: number;
  vibUser: number;
  issues: Issue[];
}

export interface Comparison {
  hopSec: number;
  duration: number;
  /** 가이드 음정 (MIDI 실수), 무성은 null */
  refMidi: (number | null)[];
  /** 시간·옥타브·키 보정된 내 음정 */
  userMidi: (number | null)[];
  refDb: number[];
  userDb: number[];
  /** 음정 차이 (센트), 둘 다 유성일 때만 */
  diffCents: (number | null)[];
  lagSec: number;
  octaveShift: number;
  keyShift: number;
  segments: Segment[];
  overall: {
    score: number;
    pitchAccuracy: number;
    meanAbsCents: number;
    timingMs: number;
    coverage: number;
  };
  summary: string[];
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a: number[]) => (a.length ? a.reduce((p, c) => p + c, 0) / a.length : 0);
const std = (a: number[]) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
};
const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 음량 + 유성 여부를 섞은 정렬용 곡선 */
function alignCurve(f: Features): Float32Array {
  const n = f.db.length;
  const db = Array.from(f.db);
  const top = pct(db, 0.95);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(f.db[i], top - 40) + (f.f0[i] > 0 ? 8 : 0);
  const m = mean(Array.from(out));
  const s = std(Array.from(out)) || 1;
  for (let i = 0; i < n; i++) out[i] = (out[i] - m) / s;
  return out;
}

function bestLag(
  a: Float32Array,
  b: Float32Array,
  lo: number,
  hi: number,
  from = 0,
  to = a.length,
  baseLag = 0,
) {
  let best = 0;
  let bestScore = -Infinity;
  let zeroScore = 0;
  for (let L = lo; L <= hi; L++) {
    let acc = 0;
    let cnt = 0;
    for (let i = from; i < to; i++) {
      const j = i + L;
      if (j < 0 || j >= b.length) continue;
      acc += a[i] * b[j];
      cnt++;
    }
    if (cnt < (to - from) * 0.5) continue;
    const sc = acc / cnt;
    if (L === baseLag) zeroScore = sc;
    if (sc > bestScore) {
      bestScore = sc;
      best = L;
    }
  }
  return { lag: best, gain: bestScore - zeroScore };
}

/** 가이드의 유성 구간을 프레이즈로 묶기 */
function findPhrases(voiced: boolean[], hop: number) {
  const gapMax = Math.round(0.4 / hop);
  const minLen = Math.round(0.6 / hop);
  const maxLen = Math.round(8 / hop);
  const runs: [number, number][] = [];
  let i = 0;
  while (i < voiced.length) {
    if (!voiced[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < voiced.length && voiced[j]) j++;
    const last = runs[runs.length - 1];
    if (last && i - last[1] <= gapMax) last[1] = j;
    else runs.push([i, j]);
    i = j;
  }
  const out: [number, number][] = [];
  for (const [a, b] of runs) {
    if (b - a < minLen) continue;
    const parts = Math.ceil((b - a) / maxLen);
    const step = Math.ceil((b - a) / parts);
    for (let s = a; s < b; s += step) out.push([s, Math.min(b, s + step)]);
  }
  return out;
}

/** 비브라토 깊이: 300ms 이동평균에서 벗어난 정도 (음 이동 프레임 제외) */
function vibratoDepth(cents: (number | null)[]): number {
  const w = 7;
  const res: number[] = [];
  for (let i = w; i < cents.length - w; i++) {
    const c = cents[i];
    if (c == null) continue;
    let s = 0;
    let n = 0;
    let ok = true;
    for (let k = -w; k <= w; k++) {
      const v = cents[i + k];
      if (v == null || Math.abs(v - c) > 120) {
        ok = false;
        break;
      }
      s += v;
      n++;
    }
    if (ok) res.push(c - s / n);
  }
  return res.length > 10 ? std(res) : 0;
}

const fmtTime = (t: number) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

function buildIssues(s: Omit<Segment, "issues" | "score" | "index">): Issue[] {
  const issues: Issue[] = [];
  const semis = (c: number) => (Math.abs(c) >= 80 ? ` (약 ${(Math.abs(c) / 100).toFixed(1)}음)` : "");

  if (s.pitchMean <= -25) {
    const sev = s.pitchMean <= -100 ? 3 : s.pitchMean <= -50 ? 2 : 1;
    issues.push({
      kind: "flat",
      severity: sev,
      title: "음이 낮아요",
      detail: `가이드보다 평균 ${Math.round(-s.pitchMean)}센트 낮게 불렀어요${semis(s.pitchMean)}. 반음은 100센트예요.`,
      tip: "목표음보다 살짝 위를 생각하고 내려 잡아 보세요. 숨을 배로 받쳐 주면 음이 처지는 걸 막을 수 있어요. 프레이즈 끝으로 갈수록 낮아진다면 숨이 모자란 신호예요.",
    });
  } else if (s.pitchMean >= 25) {
    const sev = s.pitchMean >= 100 ? 3 : s.pitchMean >= 50 ? 2 : 1;
    issues.push({
      kind: "sharp",
      severity: sev,
      title: "음이 높아요",
      detail: `가이드보다 평균 ${Math.round(s.pitchMean)}센트 높게 불렀어요${semis(s.pitchMean)}.`,
      tip: "고음을 의식해서 목에 힘이 들어가면 음이 뜨기 쉬워요. 턱과 어깨 힘을 빼고, 소리를 위로 밀기보다 앞으로 보낸다는 느낌으로 불러 보세요.",
    });
  }

  if (s.pitchStd >= 35) {
    issues.push({
      kind: "unstable",
      severity: s.pitchStd >= 60 ? 3 : 2,
      title: "음정이 흔들려요",
      detail: `가이드 대비 음정 차이가 ±${Math.round(s.pitchStd)}센트 범위로 출렁여요.`,
      tip: "이 구간의 긴 음들을 '아-' 모음으로 4박씩 롱톤 연습해 보세요. 모음 모양을 끝까지 일정하게 유지하면 음이 덜 흔들려요.",
    });
  }

  if (s.coverage < 0.75) {
    issues.push({
      kind: "dropout",
      severity: s.coverage < 0.5 ? 3 : 2,
      title: "소리가 끊겨요",
      detail: `가이드가 소리 내는 구간 중 ${Math.round(s.coverage * 100)}%만 같이 소리를 냈어요.`,
      tip: "프레이즈 시작 전에 미리 숨을 채우고, 끝음을 가이드 길이만큼 끝까지 유지해 보세요. 가사가 빠르면 가사만 리듬에 맞춰 읽는 연습부터 해 보세요.",
    });
  }

  if (s.timingMs >= 70) {
    issues.push({
      kind: "late",
      severity: s.timingMs >= 150 ? 2 : 1,
      title: "박자가 늦어요",
      detail: `가이드보다 약 ${Math.round(s.timingMs)}ms 늦게 들어갔어요.`,
      tip: "첫 자음을 박보다 살짝 먼저 시작하고, 모음이 정박에 떨어지게 해 보세요. 들어가기 한 박 전에 숨을 먼저 쉬어 두면 늦지 않아요.",
    });
  } else if (s.timingMs <= -70) {
    issues.push({
      kind: "early",
      severity: s.timingMs <= -150 ? 2 : 1,
      title: "박자가 빨라요",
      detail: `가이드보다 약 ${Math.round(-s.timingMs)}ms 먼저 들어갔어요.`,
      tip: "반주의 드럼이나 베이스를 들으면서 박을 기다렸다 들어가 보세요. 빠른 구간일수록 서두르기 쉬워요.",
    });
  }

  if (s.dynRef >= 2.5 && s.dynUser < s.dynRef * 0.6) {
    issues.push({
      kind: "dynamics",
      severity: 1,
      title: "강약이 단조로워요",
      detail: `가이드의 음량 변화폭은 ${Math.round(s.dynRef)}dB, 내 노래는 ${Math.round(s.dynUser)}dB예요.`,
      tip: "강조할 단어는 조금 더 세게, 프레이즈 끝은 힘을 빼며 작게 불러 보세요. 같은 음량으로만 부르면 감정 전달이 약해져요.",
    });
  }

  if (s.vibRef >= 12 && s.vibUser < s.vibRef * 0.6) {
    issues.push({
      kind: "vibrato",
      severity: 1,
      title: "비브라토가 부족해요",
      detail: `가이드는 긴 음에서 ±${Math.round(s.vibRef)}센트 정도 떨어주는데, 내 노래는 ±${Math.round(s.vibUser)}센트예요.`,
      tip: "긴 음을 곧게 낸 뒤 끝부분에서 자연스럽게 떨어 보세요. 억지로 떨기보다 호흡을 '하-하-하' 하고 가볍게 끊어 주는 연습이 도움이 돼요.",
    });
  }

  if (!issues.length) {
    issues.push({
      kind: "good",
      severity: 0,
      title: "잘 불렀어요",
      detail: "음정, 박자, 강약 모두 가이드와 거의 일치해요.",
      tip: "지금 느낌을 유지하면서 다른 구간을 연습해 보세요.",
    });
  }
  return issues.sort((a, b) => b.severity - a.severity);
}

export function compareFeatures(ref: Features, user: Features, opts: { maxLagSec?: number; minLagSec?: number } = {}): Comparison {
  const hop = ref.hopSec;
  const n = ref.f0.length;

  // 1) 전체 시간차
  const aRef = alignCurve(ref);
  const aUser = alignCurve(user);
  // 시작 시점 차이 탐색 범위 (구간 다시 부르기처럼 시작 시점을 아는 경우엔 좁게)
  const maxLag = Math.round((opts.maxLagSec ?? 3) / hop);
  const minLag = Math.round((opts.minLagSec ?? -(opts.maxLagSec ?? 3)) / hop);
  const { lag } = bestLag(aRef, aUser, minLag, maxLag);

  const userAt = (i: number) => {
    const j = i + lag;
    return j >= 0 && j < user.f0.length ? j : -1;
  };

  // 2) 옥타브·키 보정
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = userAt(i);
    if (j < 0 || !ref.f0[i] || !user.f0[j]) continue;
    raw.push(1200 * Math.log2(user.f0[j] / ref.f0[i]));
  }
  const octaveShift = Math.round(median(raw) / 1200) * 12;
  const afterOct = raw.map((c) => c - octaveShift * 100);
  const residual = median(afterOct);
  const keyShift = Math.abs(residual) >= 250 ? Math.round(residual / 100) : 0;
  const totalShift = octaveShift + keyShift; // 반음 단위

  // 음량 기준 맞추기 (마이크 거리·녹음 레벨 차이 제거)
  const refLoud = pct(Array.from(ref.db), 0.9);
  const userLoud = pct(Array.from(user.db), 0.9);
  const gain = refLoud - userLoud;

  const refMidi: (number | null)[] = [];
  const userMidi: (number | null)[] = [];
  const refDb: number[] = [];
  const userDb: number[] = [];
  const diffCents: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const j = userAt(i);
    const rm = ref.f0[i] ? hzToMidi(ref.f0[i]) : null;
    const um = j >= 0 && user.f0[j] ? hzToMidi(user.f0[j]) - totalShift : null;
    refMidi.push(rm);
    userMidi.push(um);
    refDb.push(ref.db[i]);
    userDb.push(j >= 0 ? user.db[j] + gain : -120);
    diffCents.push(rm != null && um != null ? (um - rm) * 100 : null);
  }

  // 3) 프레이즈별 평가
  const phrases = findPhrases(refMidi.map((v) => v != null), hop);
  const segments: Segment[] = phrases.map(([i0, i1], index) => {
    // 구간별 박자: 전체 보정 이후 남은 시간차
    const pad = Math.round(0.3 / hop);
    const lo = Math.max(0, i0 - pad);
    const hi = Math.min(n, i1 + pad);
    const local = bestLag(aRef, aUser, lag - 15, lag + 15, lo, hi, lag);
    const localLag = local.gain > 0.03 ? local.lag : lag;
    const timingMs = (localLag - lag) * hop * 1000;

    // 음정은 박자 차이를 뺀 상태(구간 내 재정렬)에서 비교, 음이 바뀌는 순간은 제외
    const diffs: number[] = [];
    let refVoiced = 0;
    let userVoiced = 0;
    for (let i = i0; i < i1; i++) {
      const rm = refMidi[i];
      if (rm == null) continue;
      refVoiced++;
      const prev = refMidi[i - 2];
      const next = refMidi[i + 2];
      const transition = prev == null || next == null || Math.abs(prev - rm) > 0.5 || Math.abs(next - rm) > 0.5;
      const j = i + localLag;
      const uf = j >= 0 && j < user.f0.length ? user.f0[j] : 0;
      if (!uf) continue;
      userVoiced++;
      if (transition) continue;
      const d = (hzToMidi(uf) - totalShift - rm) * 100;
      if (Math.abs(d) < 600) diffs.push(d);
    }
    const coverage = refVoiced ? userVoiced / refVoiced : 0;
    const pitchMean = median(diffs);
    const pitchAbs = mean(diffs.map(Math.abs));
    // 흔들림: 오프셋과 무관한 퍼짐 (분위수 기반이라 튐에 강함)
    const pitchStd = diffs.length > 5 ? (pct(diffs, 0.84) - pct(diffs, 0.16)) / 2 : 0;

    const rDb: number[] = [];
    const uDb: number[] = [];
    for (let i = i0; i < i1; i++) {
      if (refMidi[i] != null) rDb.push(refDb[i]);
      if (userMidi[i] != null) uDb.push(userDb[i]);
    }
    const dynRef = rDb.length > 5 ? pct(rDb, 0.9) - pct(rDb, 0.1) : 0;
    const dynUser = uDb.length > 5 ? pct(uDb, 0.9) - pct(uDb, 0.1) : 0;

    const toCents = (arr: (number | null)[]) => arr.slice(i0, i1).map((v) => (v == null ? null : v * 100));
    const vibRef = vibratoDepth(toCents(refMidi));
    const vibUser = vibratoDepth(toCents(userMidi));

    let score = 100;
    score -= clamp((pitchAbs - 15) * 0.6, 0, 45);
    score -= clamp((pitchStd - 25) * 0.4, 0, 15);
    score -= (1 - coverage) * 40;
    score -= clamp((Math.abs(timingMs) - 40) / 10, 0, 15);
    score -= dynRef >= 2.5 ? clamp((1 - dynUser / dynRef) * 12, 0, 8) : 0;
    score -= vibRef >= 12 ? clamp((1 - vibUser / vibRef) * 6, 0, 4) : 0;
    score = Math.round(clamp(score, 0, 100));

    const base = {
      start: i0 * hop,
      end: i1 * hop,
      i0,
      i1,
      pitchMean,
      pitchAbs,
      pitchStd,
      coverage,
      timingMs,
      dynRef,
      dynUser,
      vibRef,
      vibUser,
    };
    return { ...base, index, score, issues: buildIssues(base) };
  });

  // 4) 전체 요약
  const allDiffs = diffCents.filter((d): d is number => d != null && Math.abs(d) < 600);
  const totalLen = segments.reduce((s, g) => s + (g.end - g.start), 0) || 1;
  const overallScore = Math.round(
    segments.reduce((s, g) => s + g.score * (g.end - g.start), 0) / totalLen,
  );
  const refVoicedTotal = refMidi.filter((v) => v != null).length || 1;

  const summary: string[] = [];
  if (octaveShift) {
    summary.push(
      `가이드와 ${Math.abs(octaveShift / 12)}옥타브 ${octaveShift < 0 ? "아래" : "위"}로 불러서, 옥타브를 맞춘 뒤 비교했어요.`,
    );
  }
  if (keyShift) {
    summary.push(
      `가이드보다 ${Math.abs(keyShift)}키 ${keyShift < 0 ? "낮은" : "높은"} 키로 부른 것 같아요. 키 차이를 보정해서 비교했어요. 내 키에 맞춘 가이드가 필요하면 커버를 만들 때 키 조절을 ${keyShift > 0 ? "+" : ""}${keyShift}키로 맞춰 보세요.`,
    );
  }
  if (Math.abs(lag * hop) >= 0.05) {
    summary.push(`녹음 시작 시점이 ${Math.abs(lag * hop).toFixed(2)}초 차이 나서 자동으로 맞췄어요.`);
  }
  const kinds = new Map<IssueKind, Segment[]>();
  for (const g of segments)
    for (const is of g.issues)
      if (is.kind !== "good" && is.severity >= 1) kinds.set(is.kind, [...(kinds.get(is.kind) ?? []), g]);
  const ranked = [...kinds.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 3);
  for (const [kind, segs] of ranked) {
    const where = segs
      .slice(0, 3)
      .map((g) => `${fmtTime(g.start)}~${fmtTime(g.end)}`)
      .join(", ");
    const label = segs[0].issues.find((x) => x.kind === kind)!.title;
    summary.push(`${label}: ${segs.length}개 구간 (${where}${segs.length > 3 ? " 외" : ""})`);
  }
  if (!ranked.length) summary.push("전체적으로 가이드와 아주 비슷하게 불렀어요.");

  return {
    hopSec: hop,
    duration: n * hop,
    refMidi,
    userMidi,
    refDb,
    userDb,
    diffCents,
    lagSec: lag * hop,
    octaveShift,
    keyShift,
    segments,
    overall: {
      score: overallScore,
      pitchAccuracy: allDiffs.length ? allDiffs.filter((d) => Math.abs(d) < 50).length / allDiffs.length : 0,
      meanAbsCents: mean(allDiffs.map(Math.abs)),
      timingMs: median(segments.map((g) => g.timingMs)),
      coverage: allDiffs.length / refVoicedTotal,
    },
    summary,
  };
}

export { fmtTime };
