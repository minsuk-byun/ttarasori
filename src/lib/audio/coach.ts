/**
 * 더 잘 부르기 코칭: 음정·박자 너머의 호흡·강약·발성 분석
 * 가이드는 '내 목소리로 부른 AI 커버'라 음색 자체는 같아요. 그래서 차이는 부르는 방법의 차이로 볼 수 있어요.
 */
import type { Comparison } from "./compare.ts";
import type { NoteInfo } from "./notes.ts";
import type { Timbre } from "./timbre.ts";

export type CoachKind = "breath" | "dynamics" | "voice";

export interface CoachItem {
  kind: CoachKind;
  type: string;
  t0: number;
  t1: number;
  /** 가사 또는 음 이름 */
  label: string;
  title: string;
  detail: string;
  tip: string;
  severity: 1 | 2;
}

export interface SheetMark {
  /** 이 글자 뒤에서 숨 쉬기 */
  breathAfter: boolean;
  /** 힘주어 부를 글자 */
  emphasis: boolean;
  /** 비브라토 넣을 긴 음 */
  vibrato: boolean;
  /** 숨을 섞어 부드럽게 줄일 음 (문장 끝) */
  release: boolean;
}

export interface Coach {
  items: CoachItem[];
  marks: SheetMark[];
  hardRange: { from: number; text: string } | null;
  summary: Record<CoachKind, string>;
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
const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const nn = (m: number) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;

export function coach(c: Comparison, notes: NoteInfo[], hasLyrics: boolean, G: Timbre | null, U: Timbre | null): Coach {
  const hop = c.hopSec;
  const n = c.refMidi.length;
  const fr = (t: number) => Math.max(0, Math.min(n - 1, Math.round(t / hop)));
  const lag = Math.round(c.lagSec / hop);
  // 구간마다 남은 박자 차이까지 반영한 내 노래 위치
  const shiftAt = new Int32Array(n);
  const pad = Math.round(0.3 / hop);
  for (const s of c.segments) {
    const d = Math.round(s.timingMs / 1000 / hop);
    for (let i = Math.max(0, s.i0 - pad); i < Math.min(n, s.i1 + pad); i++) shiftAt[i] = d;
  }
  const uMidi = (i: number) => c.userMidi[i + shiftAt[Math.min(n - 1, Math.max(0, i))]] ?? null;
  const uDb = (i: number) => c.userDb[i + shiftAt[Math.min(n - 1, Math.max(0, i))]] ?? -120;
  const uRaw = (i: number) => i + lag + shiftAt[Math.min(n - 1, Math.max(0, i))];
  const label = (k: number) => (hasLyrics ? notes[k].syllable : nn(notes[k].midi));
  const phraseLabel = (a: number, b: number) =>
    hasLyrics ? notes.slice(a, b + 1).map((x) => x.syllable).join("").slice(0, 16) : `${nn(notes[a].midi)}~${nn(notes[b].midi)}`;

  const items: CoachItem[] = [];
  const marks: SheetMark[] = notes.map(() => ({ breathAfter: false, emphasis: false, vibrato: false, release: false }));

  // ---------------------------------------------------------------- 프레이즈(숨 단위) 나누기
  const phrases: [number, number][] = [];
  let ps = 0;
  notes.forEach((nt, k) => {
    const next = notes[k + 1];
    const gap = next ? next.start - (nt.start + nt.dur) : Infinity;
    if (gap >= 0.22 || !next) {
      phrases.push([ps, k]);
      if (next) marks[k].breathAfter = true;
      ps = k + 1;
    }
  });

  // 음 하나의 가운데 부분 소리 크기 (각자 전체 기준으로 맞춰서)
  const refLoud = pct(c.refDb.filter((_, i) => c.refMidi[i] != null), 0.9);
  const usrVoiced: number[] = [];
  for (let i = 0; i < n; i++) if (uMidi(i) != null) usrVoiced.push(uDb(i));
  const usrLoud = pct(usrVoiced, 0.9);
  const noteDb = (k: number, who: "ref" | "usr") => {
    const nt = notes[k];
    const a = fr(nt.start + nt.dur * 0.2);
    const b = Math.max(a + 1, fr(nt.start + nt.dur * 0.8));
    const v: number[] = [];
    for (let i = a; i < b; i++) {
      if (who === "ref" && c.refMidi[i] != null) v.push(c.refDb[i] - refLoud);
      if (who === "usr" && uMidi(i) != null) v.push(uDb(i) - usrLoud);
    }
    return v.length >= 2 ? median(v) : null;
  };

  // ---------------------------------------------------------------- 호흡·프레이징
  let shortEnds = 0;
  let fades = 0;
  let breaks = 0;
  for (const [a, b] of phrases) {
    const last = notes[b];
    const lbl = phraseLabel(a, b);
    // 끝음 길이
    if (last.dur >= 0.4) {
      let tg = -1;
      let tu = -1;
      for (let i = fr(last.start); i <= fr(last.start + last.dur + 0.3); i++) if (c.refMidi[i] != null) tg = i;
      for (let i = fr(last.start - 0.2); i <= fr(last.start + last.dur + 0.5); i++) if (uMidi(i) != null) tu = i;
      if (tg > 0 && tu > 0) {
        const short = (tg - tu) * hop;
        if (short >= Math.max(0.25, last.dur * 0.3)) {
          shortEnds++;
          items.push({
            kind: "breath",
            type: "shortEnd",
            t0: notes[a].start,
            t1: last.start + last.dur,
            label: lbl,
            title: "끝음을 짧게 끊었어요",
            detail: `'${label(b)}'를 가이드보다 ${short.toFixed(1)}초 짧게 냈어요.`,
            tip: "숨이 모자라면 끝음이 짧아져요. 앞의 쉼표(∨)에서 배까지 숨을 깊게 채우고, 끝음은 박을 세며 끝까지 유지해 보세요.",
            severity: short >= 0.5 ? 2 : 1,
          });
        }
      }
      // 끝으로 갈수록 작아짐
      const seg = (who: "ref" | "usr", p0: number, p1: number) => {
        const v: number[] = [];
        for (let i = fr(last.start + last.dur * p0); i < fr(last.start + last.dur * p1); i++) {
          if (who === "ref" && c.refMidi[i] != null) v.push(c.refDb[i]);
          if (who === "usr" && uMidi(i) != null) v.push(uDb(i));
        }
        return v.length >= 2 ? median(v) : null;
      };
      const r0 = seg("ref", 0.15, 0.4);
      const r1 = seg("ref", 0.65, 0.9);
      const u0 = seg("usr", 0.15, 0.4);
      const u1 = seg("usr", 0.65, 0.9);
      if (r0 != null && r1 != null && u0 != null && u1 != null && u0 - u1 - (r0 - r1) >= 6) {
        fades++;
        items.push({
          kind: "breath",
          type: "fadeEnd",
          t0: last.start,
          t1: last.start + last.dur,
          label: lbl,
          title: "끝음이 점점 작아져요",
          detail: `'${label(b)}'에서 가이드보다 소리가 ${Math.round(u0 - u1 - (r0 - r1))}dB 더 빨리 줄어들어요.`,
          tip: "숨을 다 써 버리면 끝음이 힘없이 줄어요. 문장 앞부분에서 숨을 아끼고, 끝음까지 같은 힘으로 배를 받쳐 주세요.",
          severity: 1,
        });
      }
    }
    // 문장 중간에서 끊김 (가이드는 이어 부르는데 나는 끊음)
    const s0 = fr(notes[a].start + 0.15);
    // 마지막 음은 '끝음 짧음'에서 따로 봐요
    const s1 = fr(last.start - 0.05);
    let run = 0;
    for (let i = s0; i <= s1; i++) {
      const gapHere = uMidi(i) == null && c.refMidi[i] != null;
      run = gapHere ? run + 1 : 0;
      if (run === Math.round(0.2 / hop)) {
        const t = i * hop;
        const k = notes.findIndex((x) => x.start + x.dur >= t);
        breaks++;
        items.push({
          kind: "breath",
          type: "midBreak",
          t0: Math.max(notes[a].start, t - 0.8),
          t1: Math.min(last.start + last.dur, t + 0.8),
          label: lbl,
          title: "문장 중간에서 소리가 끊겼어요",
          detail: `'${k >= 0 ? label(k) : lbl}' 근처에서 가이드는 이어 부르는데, 0.2초 넘게 소리가 끊겼어요. 숨을 쉰 것 같아요.`,
          tip: "숨 쉬는 곳은 가사지의 ∨ 표시예요. 그 사이에서는 숨을 쉬지 말고 한 호흡으로 이어 불러 보세요. 어려우면 문장을 천천히 읽으며 숨 위치부터 몸에 익혀요.",
          severity: 1,
        });
        break; // 한 문장에 하나만
      }
    }
    // 문장 끝은 부드럽게 줄이기 표시
    if (last.dur >= 0.5) marks[b].release = true;
  }

  // ---------------------------------------------------------------- 강약·표현
  let flat = 0;
  let missedEmph = 0;
  let abrupt = 0;
  let vibNeed = 0;
  let vibTooMuch = 0;
  for (const [a, b] of phrases) {
    if (b - a < 2) continue;
    const rs: number[] = [];
    const us: number[] = [];
    const ks: number[] = [];
    for (let k = a; k <= b; k++) {
      const r = noteDb(k, "ref");
      const u = noteDb(k, "usr");
      if (r != null && u != null) {
        rs.push(r);
        us.push(u);
        ks.push(k);
      }
    }
    if (rs.length < 3) continue;
    const rMed = median(rs);
    const uMed = median(us);
    const rSpread = pct(rs, 0.9) - pct(rs, 0.1);
    const uSpread = pct(us, 0.9) - pct(us, 0.1);
    const lbl = phraseLabel(a, b);
    // 강조할 글자: 가이드에서 문장 평균보다 3dB 이상 큰 음 (문장마다 최대 2개)
    const emph = ks
      .map((k, i) => ({ k, r: rs[i] - rMed, u: us[i] - uMed }))
      .filter((x) => x.r >= 3)
      .sort((p, q) => q.r - p.r)
      .slice(0, 2);
    for (const e of emph) {
      marks[e.k].emphasis = true;
      if (e.u < 1.5) {
        missedEmph++;
        items.push({
          kind: "dynamics",
          type: "emphasis",
          t0: Math.max(0, notes[e.k].start - 0.6),
          t1: notes[e.k].start + notes[e.k].dur + 0.4,
          label: label(e.k),
          title: `'${label(e.k)}'에 힘을 더 주세요`,
          detail: `가이드는 '${label(e.k)}'를 문장에서 ${Math.round(e.r)}dB 크게 부르는데, 내 노래는 ${e.u >= 0 ? `${Math.round(e.u)}dB 정도만` : "오히려 작게"} 냈어요.`,
          tip: "말할 때 중요한 단어에 힘이 들어가듯, 이 글자의 첫소리를 조금 더 세게 시작하고 모음을 크게 열어 보세요.",
          severity: 1,
        });
      }
    }
    if (rSpread >= 5 && uSpread < rSpread * 0.5) {
      flat++;
      items.push({
        kind: "dynamics",
        type: "flat",
        t0: notes[a].start,
        t1: notes[b].start + notes[b].dur,
        label: lbl,
        title: "강약이 밋밋해요",
        detail: `이 문장에서 가이드는 소리 크기를 ${Math.round(rSpread)}dB 오르내리는데, 내 노래는 ${Math.round(uSpread)}dB예요.`,
        tip: "같은 크기로만 부르면 감정이 덜 전해져요. 가사지의 굵은 글자는 크게, 문장 끝(〰)은 숨을 섞어 작게 불러 보세요.",
        severity: 1,
      });
    }
    // 끝 처리: 가이드는 천천히 줄이는데 나는 툭 끊음
    const last = notes[b];
    if (last.dur >= 0.4) {
      const rel = (who: "ref" | "usr") => {
        let end = -1;
        for (let i = fr(last.start); i <= fr(last.start + last.dur + 0.4); i++) if ((who === "ref" ? c.refMidi[i] : uMidi(i)) != null) end = i;
        if (end < 0) return null;
        const db = (i: number) => (who === "ref" ? c.refDb[i] : uDb(i));
        const core = median(Array.from({ length: 6 }, (_, q) => db(end - 12 + q)));
        let k = end;
        while (k > end - 15 && db(k) < core - 3) k--;
        return (end - k) * hop;
      };
      const gr = rel("ref");
      const ur = rel("usr");
      if (gr != null && ur != null && gr >= 0.12 && ur <= 0.04) {
        abrupt++;
        items.push({
          kind: "dynamics",
          type: "abrupt",
          t0: last.start,
          t1: last.start + last.dur + 0.3,
          label: label(b),
          title: "끝을 툭 끊어요",
          detail: `'${label(b)}' 끝에서 가이드는 소리를 천천히 줄이는데, 내 노래는 갑자기 멈춰요.`,
          tip: "끝음은 숨을 조금씩 빼면서 작게 줄여 마무리해 보세요. 촛불을 천천히 끄듯 '하-' 하고 흘려보내는 느낌이에요.",
          severity: 1,
        });
      }
    }
  }
  // 비브라토: 긴 음 뒷부분의 떨림
  const vib = (k: number, who: "ref" | "usr") => {
    const nt = notes[k];
    const v: number[] = [];
    for (let i = fr(nt.start + nt.dur * 0.4); i < fr(nt.start + nt.dur * 0.95); i++) {
      const m = who === "ref" ? c.refMidi[i] : uMidi(i);
      if (m != null) v.push(m * 100);
    }
    if (v.length < 10) return null;
    const res: number[] = [];
    for (let i = 3; i < v.length - 3; i++) res.push(v[i] - (v[i - 3] + v[i - 2] + v[i - 1] + v[i] + v[i + 1] + v[i + 2] + v[i + 3]) / 7);
    return Math.sqrt(res.reduce((s, x) => s + x * x, 0) / Math.max(1, res.length));
  };
  notes.forEach((nt, k) => {
    if (nt.dur < 0.7) return;
    const g = vib(k, "ref");
    const u = vib(k, "usr");
    if (g == null || u == null) return;
    if (g >= 9) marks[k].vibrato = true;
    if (g >= 9 && u < 4) {
      vibNeed++;
      if (vibNeed <= 3)
        items.push({
          kind: "dynamics",
          type: "vibrato",
          t0: nt.start,
          t1: nt.start + nt.dur,
          label: label(k),
          title: `긴 음 '${label(k)}'에 비브라토를 넣어 보세요`,
          detail: "가이드는 이 긴 음 뒷부분을 자연스럽게 떨어 주는데, 내 노래는 곧게만 냈어요.",
          tip: "음을 곧게 낸 뒤 뒷부분에서 배를 '하-하-하' 가볍게 튕기듯 떨어 보세요. 억지로 목을 흔들면 안 돼요.",
          severity: 1,
        });
    } else if (u >= 22 && g < 8) {
      vibTooMuch++;
      if (vibTooMuch <= 2)
        items.push({
          kind: "dynamics",
          type: "vibratoTooMuch",
          t0: nt.start,
          t1: nt.start + nt.dur,
          label: label(k),
          title: `'${label(k)}'에서 떨림이 과해요`,
          detail: "가이드는 곧게 내는 음인데 내 노래는 많이 흔들려요.",
          tip: "긴 음 앞부분은 곧게 유지하고, 떨림은 꼭 필요한 곳에만 짧게 넣어 보세요.",
          severity: 1,
        });
    }
  });

  // ---------------------------------------------------------------- 발성·음색 (같은 내 음색끼리 비교)
  let strain = 0;
  let breathy = 0;
  let dark = 0;
  const flagged: { midi: number; bad: boolean }[] = [];
  if (G && U) {
    const relStats = (T: Timbre, idx: number[]) => {
      const cs = idx.map((i) => Math.log2(Math.max(50, T.centroid[i] || 50)));
      return { c: median(cs), t: median(idx.map((i) => T.tilt[i])), p: median(idx.map((i) => T.cpp[i])) };
    };
    const gIdx: number[] = [];
    const uIdx: number[] = [];
    for (let i = 0; i < n; i++) {
      if (c.refMidi[i] != null && i < G.cpp.length) gIdx.push(i);
      const j = uRaw(i);
      if (uMidi(i) != null && j >= 0 && j < U.cpp.length) uIdx.push(j);
    }
    if (gIdx.length > 50 && uIdx.length > 50) {
      const gb = relStats(G, gIdx);
      const ub = relStats(U, uIdx);
      const hiPitch = pct(notes.map((x) => x.midi), 0.7);
      const perNote = notes.map((nt, k) => {
        if (nt.dur < 0.25) return null;
        const gi: number[] = [];
        const ui: number[] = [];
        for (let i = fr(nt.start + nt.dur * 0.2); i < fr(nt.start + nt.dur * 0.8); i++) {
          if (c.refMidi[i] != null && i < G.cpp.length) gi.push(i);
          const j = uRaw(i);
          if (uMidi(i) != null && j >= 0 && j < U.cpp.length) ui.push(j);
        }
        if (gi.length < 4 || ui.length < 4) return null;
        const g = relStats(G, gi);
        const u = relStats(U, ui);
        return {
          k,
          dC: u.c - ub.c - (g.c - gb.c), // 옥타브
          dT: u.t - ub.t - (g.t - gb.t), // dB
          dP: u.p - ub.p - (g.p - gb.p), // dB
        };
      });
      const groups: Record<string, number[]> = { strain: [], breathy: [], dark: [] };
      for (const x of perNote) {
        if (!x) continue;
        const isStrain = x.dT >= 4 && x.dP > -2;
        const isBreathy = x.dP <= -3;
        const isDark = x.dC <= -0.3 && x.dT < 2;
        if (isStrain) groups.strain.push(x.k);
        if (isBreathy) groups.breathy.push(x.k);
        if (isDark) groups.dark.push(x.k);
        flagged.push({ midi: notes[x.k].midi, bad: isStrain || isBreathy || isDark });
      }
      const enough = (a: number[]) => a.length >= 2 && a.length >= flagged.length * 0.12;
      const where = (a: number[]) => {
        const high = a.filter((k) => notes[k].midi >= hiPitch).length;
        return high >= a.length * 0.6 ? "주로 높은 음" : "여러 곳";
      };
      const sample = (a: number[]) => a.slice(0, 3).map((k) => `'${label(k)}'`).join(", ");
      if (enough(groups.strain)) {
        strain = groups.strain.length;
        const k0 = groups.strain[0];
        items.push({
          kind: "voice",
          type: "strain",
          t0: Math.max(0, notes[k0].start - 0.5),
          t1: notes[k0].start + notes[k0].dur + 0.3,
          label: sample(groups.strain),
          title: "목에 힘이 들어가는 것 같아요",
          detail: `${where(groups.strain)}(${sample(groups.strain)} 등)에서 가이드보다 소리가 납작하고 날카로워져요. 목을 조일 때 나는 소리 특징이에요.`,
          tip: "고음은 목을 조여 밀어 올리면 안 돼요. 하품하듯 목 안을 넓히고, 턱과 어깨 힘을 뺀 채 '립트릴(입술 떨기)'로 같은 멜로디를 먼저 불러 본 뒤 가사로 불러 보세요.",
          severity: groups.strain.length >= 4 ? 2 : 1,
        });
      }
      if (enough(groups.breathy)) {
        breathy = groups.breathy.length;
        const k0 = groups.breathy[0];
        items.push({
          kind: "voice",
          type: "breathy",
          t0: Math.max(0, notes[k0].start - 0.5),
          t1: notes[k0].start + notes[k0].dur + 0.3,
          label: sample(groups.breathy),
          title: "숨이 새서 소리가 흐려요",
          detail: `${where(groups.breathy)}(${sample(groups.breathy)} 등)에서 가이드보다 소리에 숨이 많이 섞여요.`,
          tip: "성대가 덜 닫히면 숨이 새요. '음-' 허밍으로 코와 입술이 울리는 느낌을 찾은 뒤, 그 울림을 유지한 채 '마-'로 열어 불러 보세요. 일부러 숨을 섞는 부분이라면 괜찮아요.",
          severity: 1,
        });
      }
      if (enough(groups.dark)) {
        dark = groups.dark.length;
        const k0 = groups.dark[0];
        items.push({
          kind: "voice",
          type: "dark",
          t0: Math.max(0, notes[k0].start - 0.5),
          t1: notes[k0].start + notes[k0].dur + 0.3,
          label: sample(groups.dark),
          title: "소리가 뒤로 먹혀요",
          detail: `${where(groups.dark)}(${sample(groups.dark)} 등)에서 가이드보다 소리가 어둡고 답답하게 들려요.`,
          tip: "소리를 목 뒤가 아니라 앞니 뒤쪽으로 보낸다고 생각해 보세요. 입꼬리를 살짝 올리고 모음을 앞으로 내면 소리가 밝아져요.",
          severity: 1,
        });
      }
    }
  }
  // 힘든 음역: 이 높이부터 문제(음정·발성)가 몰려요
  let hardRange: Coach["hardRange"] = null;
  if (flagged.length >= 8) {
    const cands = [...new Set(flagged.map((f) => Math.round(f.midi)))].sort((a, b) => a - b);
    let best = { p: 0, diff: 0, above: 0 };
    for (const p of cands) {
      const up = flagged.filter((f) => f.midi >= p);
      const dn = flagged.filter((f) => f.midi < p);
      if (up.length < 3 || dn.length < 3) continue;
      const ru = up.filter((f) => f.bad).length / up.length;
      const rd = dn.filter((f) => f.bad).length / dn.length;
      if (ru - rd > best.diff) best = { p, diff: ru - rd, above: ru };
    }
    if (best.diff >= 0.3 && best.above >= 0.5)
      hardRange = {
        from: best.p,
        text: `${nn(best.p)} 이상의 높은 음에서 발성이 흔들려요. 오늘의 연습의 롱톤·음 이동 연습으로 이 음 근처를 집중해서 연습해 보세요.`,
      };
  }

  const say = (parts: string[], ok: string) => (parts.length ? parts.join(", ") : ok);
  return {
    items,
    marks,
    hardRange,
    summary: {
      breath: say(
        [shortEnds ? `끝음 짧음 ${shortEnds}곳` : "", fades ? `끝음 작아짐 ${fades}곳` : "", breaks ? `중간 끊김 ${breaks}곳` : ""].filter(Boolean),
        "숨 쉬는 위치와 끝음 길이가 가이드와 잘 맞아요.",
      ),
      dynamics: say(
        [missedEmph ? `강조 놓침 ${missedEmph}곳` : "", flat ? `밋밋한 문장 ${flat}개` : "", abrupt ? `툭 끊는 끝 ${abrupt}곳` : "", vibNeed ? `비브라토 필요 ${vibNeed}곳` : "", vibTooMuch ? `과한 떨림 ${vibTooMuch}곳` : ""].filter(Boolean),
        "강약과 끝 처리가 가이드와 비슷해요.",
      ),
      voice: G && U ? say([strain ? "목 조임 경향" : "", breathy ? "숨 샘 경향" : "", dark ? "소리 어두움 경향" : ""].filter(Boolean), "가이드와 비슷한 발성으로 불렀어요.") : "발성 분석을 할 수 없었어요.",
    },
  };
}
