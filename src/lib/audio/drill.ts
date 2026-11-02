/**
 * 오늘의 연습 드릴: 목표 음 패턴 만들기 + 내가 부른 소리 채점
 * 듣기 → 박자 4번 → 따라 부르기 (듣고 따라 하는 방식이라 이어폰이 없어도 돼요)
 */
import { extractFeatures, hzToMidi } from "./features.ts";
import type { Weak } from "../progress.ts";

export type DrillKind = "scale" | "longtone" | "interval" | "rhythm" | "staccato";

export interface DrillNote {
  midi: number;
  /** 박 단위 */
  beat: number;
  beats: number;
}

export interface Drill {
  kind: DrillKind;
  title: string;
  /** 무엇을 위한 연습인지 */
  goal: string;
  /** 어떻게 부르는지 */
  how: string;
  bpm: number;
  notes: DrillNote[];
  /** 전체 길이 (박) */
  length: number;
  /** 부르는 동안 박자 소리 */
  clicks: boolean;
}

export interface DrillNoteResult {
  midi: number;
  start: number;
  dur: number;
  cents: number | null;
  spread: number;
  onsetMs: number | null;
  scoop: boolean;
  text: string;
  ok: boolean;
}

export interface DrillResult {
  score: number;
  notes: DrillNoteResult[];
  /** 그래프용: 내 음정 (목표와 같은 시간축, 옥타브 맞춤) */
  userMidi: (number | null)[];
  hopSec: number;
  summary: string;
  weak: Partial<Weak>;
  meanAbsCents: number;
  offsetCents: number;
  timingMs: number | null;
  pitchAcc: number;
  rangeLow?: number;
  rangeHigh?: number;
}

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

export const DRILL_INFO: Record<DrillKind, { title: string; goal: string; how: string }> = {
  scale: {
    title: "음계 워밍업",
    goal: "목을 풀고 오늘 목소리 상태를 확인해요.",
    how: "'아'로 도레미파솔파미레도를 들은 그대로 따라 불러요.",
  },
  longtone: {
    title: "롱톤 (긴 음 유지)",
    goal: "음이 처지거나 흔들리지 않게 한 음을 곧게 유지하는 힘을 길러요.",
    how: "각 음을 '아-'로 끝까지 같은 높이·같은 크기로 길게 내요. 배로 숨을 받쳐 주세요.",
  },
  interval: {
    title: "음 이동 (도약)",
    goal: "멀리 떨어진 음으로 옮겨 갈 때 정확히 착지하는 연습이에요.",
    how: "'아'로 따라 부르되, 높은 음을 미리 머릿속에 떠올리고 한 번에 옮겨 가요.",
  },
  rhythm: {
    title: "박자 맞춰 들어가기",
    goal: "박보다 늦거나 빨리 들어가는 습관을 고쳐요.",
    how: "박자 소리에 맞춰 '라'를 짧게 불러요. 자음을 박보다 살짝 먼저 시작하면 모음이 박에 맞아요.",
  },
  staccato: {
    title: "바로 꽂기 (짧은 음)",
    goal: "음 아래에서 끌어올리는 습관 없이 처음부터 정확한 음으로 시작하는 연습이에요.",
    how: "각 음을 '아!' 하고 짧고 가볍게, 처음부터 목표음에 바로 내요.",
  },
};

/** center: 편하게 낼 수 있는 가운데 음 (MIDI), seed: 날마다 조금씩 다르게 */
export function makeDrill(kind: DrillKind, center: number, seed = 0, high = center + 7): Drill {
  const info = DRILL_INFO[kind];
  const base = Math.round(center - 3 + (seed % 3) - 1); // 날마다 반음씩 위아래로
  const n = (midi: number, beat: number, beats: number): DrillNote => ({ midi, beat, beats });
  let notes: DrillNote[] = [];
  let bpm = 90;
  let clicks = true;
  switch (kind) {
    case "scale": {
      const sc = [0, 2, 4, 5, 7, 5, 4, 2, 0];
      notes = sc.map((s, i) => n(base + s, i, i === sc.length - 1 ? 2 : 0.9));
      bpm = 96;
      break;
    }
    case "longtone": {
      bpm = 60;
      const ps = [center - 2, center, center + 2];
      notes = ps.map((p, i) => n(p, i * 4, 3));
      break;
    }
    case "interval": {
      bpm = 84;
      const top = base + 12 <= high ? 12 : 9;
      const seq = [0, 7, 0, 4, 7, top, 7, 4, 0];
      notes = seq.map((s, i) => n(base + s, i, i === seq.length - 1 ? 2 : 0.9));
      break;
    }
    case "rhythm": {
      bpm = 92;
      const beats = [0, 1, 2, 3, 4, 5, 5.5, 6, 8, 8.5, 9.5, 10, 11, 12, 13, 13.5, 14.5];
      notes = beats.map((b) => n(center, b, 0.35));
      break;
    }
    case "staccato": {
      bpm = 88;
      const seq = [0, 4, 2, 5, 7, 4, 9, 7, 0];
      notes = seq.map((s, i) => n(base + s, i, 0.4));
      clicks = true;
      break;
    }
  }
  const last = notes[notes.length - 1];
  return { kind, ...info, bpm, notes, length: Math.ceil(last.beat + last.beats + 1), clicks };
}

/**
 * 채점. x: 부르기 시작 시점(첫 박) 앞 pre 초부터 녹음된 16kHz 소리.
 * latency: 소리를 듣고 부른 게 녹음에 들어오기까지의 지연 (박자 판단에서 빼요)
 */
export async function scoreDrill(drill: Drill, x: Float32Array, sr: number, pre: number, latency: number): Promise<DrillResult> {
  const f = await extractFeatures(x, sr);
  const hop = f.hopSec;
  const beat = 60 / drill.bpm;
  const raw: (number | null)[] = Array.from(f.f0, (v) => (v > 0 ? hzToMidi(v) : null));
  const at = (t: number) => raw[Math.round((t + pre) / hop)] ?? null; // t: 첫 박 기준 시간
  const targets = drill.notes.map((nt) => ({ midi: nt.midi, start: nt.beat * beat, dur: nt.beats * beat }));
  const timingDrill = drill.kind === "rhythm";

  // 옥타브: 남녀 음역 차이는 맞춰서 비교
  const octs: number[] = [];
  for (const t of targets)
    for (let s = t.start + t.dur * 0.3; s < t.start + t.dur * 0.8; s += hop) {
      const u = at(s + latency);
      if (u != null) octs.push(u - t.midi);
    }
  const oct = Math.round(median(octs) / 12) * 12;

  // 시간 맞추기: 음정 드릴은 지연을 넓게 찾고, 박자 드릴은 측정한 지연만 반영
  let shift = latency;
  if (!timingDrill) {
    let best = -1;
    for (let s = latency - 0.15; s <= latency + 0.35; s += hop) {
      let hit = 0;
      for (const t of targets)
        for (let q = t.start; q < t.start + t.dur; q += hop) {
          const u = at(q + s);
          if (u != null && Math.abs(u - oct - t.midi) < 1.5) hit++;
        }
      if (hit > best) {
        best = hit;
        shift = s;
      }
    }
  }

  const results: DrillNoteResult[] = targets.map((t, i) => {
    const core: number[] = [];
    // 박자 드릴은 늦게 들어와도 '부른 것'으로 보도록 음 끝 뒤까지 넓게 봐요
    const c0 = timingDrill ? t.start - 0.1 : t.start + t.dur * (drill.kind === "staccato" ? 0.05 : 0.25);
    const c1 = timingDrill ? t.start + t.dur + 0.2 : t.start + t.dur * (drill.kind === "staccato" ? 0.7 : 0.85);
    for (let q = c0; q < c1; q += hop) {
      const u = at(q + shift);
      if (u != null && Math.abs(u - oct - t.midi) < 4) core.push((u - oct - t.midi) * 100);
    }
    const need = timingDrill ? 2 : Math.max(2, Math.round(((c1 - c0) / hop) * 0.35));
    const cents = core.length >= need ? median(core) : null;
    const spread = core.length > 6 ? (pct(core, 0.84) - pct(core, 0.16)) / 2 : 0;

    // 들어온 타이밍
    let onsetMs: number | null = null;
    const prevEnd = i ? targets[i - 1].start + targets[i - 1].dur : -1;
    for (let q = Math.max(t.start - 0.25, prevEnd + 0.02); q < t.start + Math.min(0.4, t.dur + 0.2); q += hop) {
      const u = at(q + shift);
      const u2 = at(q + shift + hop);
      if (u != null && u2 != null && Math.abs(u - oct - t.midi) < (drill.kind === "staccato" ? 3 : 1.5)) {
        onsetMs = Math.round((q - t.start) * 1000);
        break;
      }
    }
    // 끌어올리기: 부르기 시작한 뒤 120ms 안에 목표보다 많이 낮았다가 올라감
    let low = 0;
    const from = onsetMs != null ? t.start + onsetMs / 1000 - 0.06 : t.start;
    for (let q = from; q < from + 0.14; q += hop) {
      const u = at(q + shift);
      if (u != null && (u - oct - t.midi) * 100 < -70) low++;
    }
    const scoop = cents != null && Math.abs(cents) < 50 && low >= 2;

    const parts: string[] = [];
    if (cents == null) parts.push("소리가 안 들렸어요");
    else {
      if (Math.abs(cents) >= 30) parts.push(`${Math.round(Math.abs(cents))}센트 ${cents < 0 ? "낮아요" : "높아요"}`);
      if (drill.kind === "longtone" && spread >= 30) parts.push(`±${Math.round(spread)}센트 흔들려요`);
      if (timingDrill && onsetMs != null && Math.abs(onsetMs) >= 90) parts.push(`${Math.abs(onsetMs)}ms ${onsetMs > 0 ? "늦어요" : "빨라요"}`);
      if (scoop) parts.push("아래에서 끌어올렸어요");
    }
    return { ...t, cents, spread, onsetMs, scoop, text: parts.length ? parts.join(", ") : "좋아요", ok: !parts.length };
  });

  const sung = results.filter((r) => r.cents != null);
  const missing = 1 - sung.length / results.length;
  const abs = sung.map((r) => Math.abs(r.cents!));
  const meanAbsCents = abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : 0;
  const offsetCents = sung.length ? sung.reduce((a, r) => a + r.cents!, 0) / sung.length : 0;
  const onsets = results.map((r) => r.onsetMs).filter((v): v is number => v != null);
  const timingMs = timingDrill && onsets.length >= 3 ? Math.round(median(onsets)) : null;
  const meanAbsOnset = onsets.length ? onsets.reduce((a, b) => a + Math.abs(b), 0) / onsets.length : 0;
  const meanSpread = sung.length ? sung.reduce((a, r) => a + r.spread, 0) / sung.length : 0;
  const scoops = results.filter((r) => r.scoop).length;

  let score = 100;
  if (drill.kind === "rhythm") score -= clamp((meanAbsOnset - 40) / 3, 0, 60);
  else score -= clamp((meanAbsCents - 10) * 0.9, 0, 55);
  if (drill.kind === "longtone") score -= clamp((meanSpread - 15) * 0.8, 0, 35);
  if (drill.kind === "staccato") score -= (scoops / results.length) * 30;
  score -= missing * 60;
  score = Math.round(clamp(score, 0, 100));

  const weak: Partial<Weak> = {
    flat: sung.filter((r) => r.cents! <= -30).length,
    sharp: sung.filter((r) => r.cents! >= 30).length,
    missing: results.length - sung.length,
    unstable: drill.kind === "longtone" ? sung.filter((r) => r.spread >= 30).length : 0,
    late: timingDrill ? onsets.filter((o) => o >= 90).length : 0,
    early: timingDrill ? onsets.filter((o) => o <= -90).length : 0,
    scoop: scoops,
  };

  let summary: string;
  if (!sung.length) summary = "소리가 들리지 않았어요. 마이크 가까이에서 다시 해 보세요.";
  else if (score >= 85 && sung.length === results.length && !scoops) summary = "아주 좋아요! 이 느낌을 기억해 두세요.";
  else if (sung.length < results.length)
    summary = `${results.length - sung.length}개 음에서 소리가 안 들렸어요. 숨을 미리 채우고 모든 음을 끝까지 불러 보세요.`;
  else if (drill.kind === "rhythm")
    summary =
      timingMs != null && Math.abs(timingMs) >= 60
        ? `박보다 평균 ${Math.abs(timingMs)}ms ${timingMs > 0 ? "늦게" : "빨리"} 들어가요. ${timingMs > 0 ? "자음을 조금 더 일찍 시작해 보세요." : "박을 한 번 기다렸다 들어가 보세요."}`
        : "들어가는 타이밍이 들쭉날쭉해요. 박자 소리를 몸으로 세면서 다시 해 보세요.";
  else if (drill.kind === "longtone" && meanSpread >= 25) summary = "음이 흔들려요. 숨을 배로 받치고 모음 모양을 끝까지 그대로 유지해 보세요.";
  else if (Math.abs(offsetCents) >= 25)
    summary = `전체적으로 ${Math.round(Math.abs(offsetCents))}센트 ${offsetCents < 0 ? "낮아요. 살짝 위에서 내려 잡는 느낌으로" : "높아요. 힘을 빼고"} 다시 해 보세요.`;
  else if (scoops) summary = "음을 아래에서 끌어올리는 습관이 보여요. 처음부터 목표음에 바로 내 보세요.";
  else summary = "조금 더 다듬으면 돼요. 틀린 음을 다시 듣고 한 번 더 해 보세요.";

  // 그래프용 시간축 (첫 박 = 0)
  const total = drill.length * beat;
  const userMidi: (number | null)[] = [];
  for (let q = 0; q < total; q += hop) {
    const u = at(q + shift);
    userMidi.push(u == null ? null : u - oct);
  }
  const mids = sung.map((r) => r.midi + r.cents! / 100 + oct);
  return {
    score,
    notes: results,
    userMidi,
    hopSec: hop,
    summary,
    weak,
    meanAbsCents,
    offsetCents,
    timingMs,
    pitchAcc: sung.length ? sung.filter((r) => Math.abs(r.cents!) < 30).length / results.length : 0,
    rangeLow: mids.length ? Math.round(Math.min(...mids)) : undefined,
    rangeHigh: mids.length ? Math.round(Math.max(...mids)) : undefined,
  };
}

/** 그래프용 목표 음 배열 */
export function drillTargetArray(drill: Drill, hop: number): (number | null)[] {
  const beat = 60 / drill.bpm;
  const total = drill.length * beat;
  const out: (number | null)[] = new Array(Math.ceil(total / hop)).fill(null);
  for (const nt of drill.notes) {
    const a = Math.round((nt.beat * beat) / hop);
    const b = Math.min(out.length, Math.round(((nt.beat + nt.beats) * beat) / hop));
    for (let i = a; i < b; i++) out[i] = nt.midi;
  }
  return out;
}

/** 약점 → 오늘 할 드릴 */
export function pickDrills(top: keyof Weak | null, offsetCents: number): { kind: DrillKind; why: string }[] {
  const list: { kind: DrillKind; why: string }[] = [{ kind: "scale", why: "매일 처음엔 목을 풀어요." }];
  switch (top) {
    case "late":
    case "early":
      list.push({ kind: "rhythm", why: `최근 노래에서 박보다 ${top === "late" ? "늦게" : "빨리"} 들어간 곳이 가장 많았어요.` });
      list.push({ kind: "longtone", why: "음정 기본기도 같이 다져요." });
      break;
    case "scoop":
      list.push({ kind: "staccato", why: "최근 노래에서 음 아래에서 끌어올리며 시작한 곳이 많았어요." });
      list.push({ kind: "interval", why: "음을 옮길 때도 바로 착지하는 연습이에요." });
      break;
    case "unstable":
    case "missing":
      list.push({ kind: "longtone", why: top === "unstable" ? "최근 노래에서 긴 음이 흔들린 곳이 많았어요." : "최근 노래에서 소리가 끊긴 곳이 많았어요. 숨을 오래 쓰는 연습이에요." });
      list.push({ kind: "staccato", why: "짧은 음으로 음정 감각도 같이 다져요." });
      break;
    case "flat":
    case "sharp":
      list.push({ kind: "longtone", why: `최근 노래에서 음이 ${top === "flat" ? "처진(낮은)" : "뜬(높은)"} 곳이 가장 많았어요. 정확한 음을 오래 유지하는 연습이에요.` });
      list.push({ kind: "interval", why: "음을 옮겨 갈 때 정확히 착지하는 연습이에요." });
      break;
    default:
      list.push({
        kind: "longtone",
        why: Math.abs(offsetCents) >= 15 ? "음이 조금씩 치우치는 경향이 있어요." : "아직 기록이 적어서 기본 연습부터 해요. 노래를 비교할수록 맞춤 연습이 돼요.",
      });
      list.push({ kind: "rhythm", why: "박자 감각도 같이 확인해요." });
  }
  return list;
}
