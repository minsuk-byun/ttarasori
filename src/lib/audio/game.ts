/**
 * 음정 게임 판정: 음 하나가 끝날 때마다 PERFECT / GREAT / GOOD / MISS
 */
import { foldTo } from "./livePitch.ts";

export interface GameNote {
  midi: number;
  start: number;
  dur: number;
  syllable?: string;
}

export type Judge = "PERFECT" | "GREAT" | "GOOD" | "MISS";

export interface Judged {
  index: number;
  judge: Judge;
  /** 평균 음정 차이 (센트), 소리가 없었으면 null */
  cents: number | null;
}

export interface GameResult {
  score: number;
  stars: 0 | 1 | 2 | 3;
  counts: Record<Judge, number>;
  maxCombo: number;
  /** 음 안에서 ±50센트 안에 있던 비율 */
  hitRatio: number;
  offsetCents: number;
  judged: Judged[];
  weak: { flat: number; sharp: number; missing: number };
}

const POINTS: Record<Judge, number> = { PERFECT: 100, GREAT: 80, GOOD: 50, MISS: 0 };

export class GameJudge {
  private stats: { frames: number; hit: number; perfect: number; cents: number[] }[];
  private next = 0;
  judged: Judged[] = [];
  combo = 0;
  maxCombo = 0;

  private notes: GameNote[];

  constructor(notes: GameNote[]) {
    this.notes = notes;
    this.stats = notes.map(() => ({ frames: 0, hit: 0, perfect: 0, cents: [] }));
  }

  /** t: 노래 시간 (마이크 지연 보정 후), midi: 지금 부르는 음 (없으면 null) */
  feed(t: number, midi: number | null): Judged[] {
    for (let i = this.next; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.start > t) break;
      // 앞뒤 끝 60ms 는 넘어가는 순간이라 판정에서 빼요
      if (t >= n.start + 0.06 && t < n.start + n.dur - 0.06) {
        const s = this.stats[i];
        s.frames++;
        if (midi != null) {
          const c = (foldTo(midi, n.midi) - n.midi) * 100;
          s.cents.push(c);
          if (Math.abs(c) < 50) s.hit++;
          if (Math.abs(c) < 25) s.perfect++;
        }
      }
    }
    return this.close(t);
  }

  /** t 까지 끝난 음 판정 */
  close(t: number): Judged[] {
    const out: Judged[] = [];
    while (this.next < this.notes.length) {
      const n = this.notes[this.next];
      if (t < n.start + n.dur + 0.05) break;
      const s = this.stats[this.next];
      const hr = s.frames ? s.hit / s.frames : 0;
      const pr = s.frames ? s.perfect / s.frames : 0;
      const judge: Judge = hr >= 0.7 && pr >= 0.45 ? "PERFECT" : hr >= 0.5 ? "GREAT" : hr >= 0.25 ? "GOOD" : "MISS";
      const sorted = [...s.cents].sort((a, b) => a - b);
      const j: Judged = { index: this.next, judge, cents: sorted.length >= 3 ? sorted[Math.floor(sorted.length / 2)] : null };
      this.judged.push(j);
      out.push(j);
      if (judge === "MISS") this.combo = 0;
      else {
        this.combo++;
        this.maxCombo = Math.max(this.maxCombo, this.combo);
      }
      this.next++;
    }
    return out;
  }

  liveScore(): number {
    if (!this.judged.length) return 0;
    return Math.round(this.judged.reduce((a, j) => a + POINTS[j.judge], 0) / this.judged.length);
  }

  result(): GameResult {
    this.close(Infinity);
    const counts: Record<Judge, number> = { PERFECT: 0, GREAT: 0, GOOD: 0, MISS: 0 };
    for (const j of this.judged) counts[j.judge]++;
    const score = this.liveScore();
    const frames = this.stats.reduce((a, s) => a + s.frames, 0) || 1;
    const hit = this.stats.reduce((a, s) => a + s.hit, 0);
    const cs = this.judged.map((j) => j.cents).filter((c): c is number => c != null);
    return {
      score,
      stars: score >= 88 ? 3 : score >= 75 ? 2 : score >= 60 ? 1 : 0,
      counts,
      maxCombo: this.maxCombo,
      hitRatio: hit / frames,
      offsetCents: cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : 0,
      judged: this.judged,
      weak: {
        flat: cs.filter((c) => c <= -30).length,
        sharp: cs.filter((c) => c >= 30).length,
        missing: this.judged.filter((j) => j.cents == null).length,
      },
    };
  }
}
