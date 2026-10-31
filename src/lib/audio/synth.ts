/**
 * 체험용 샘플 음원 합성 (자체 작곡한 짧은 멜로디)
 * - guide: "AI 커버" 역할의 깔끔한 보컬 (비브라토·강약 포함)
 * - mine : 일부러 실수를 섞은 "내 노래" (음 낮음, 늦음, 흔들림, 끊김, 단조로운 강약)
 */

export const SAMPLE_RATE = 16000;

type Note = [midi: number, beats: number];

const PHRASES: Note[][] = [
  [[64, 1], [67, 1], [69, 1.5], [67, 0.5], [64, 2]],
  [[62, 1], [64, 1], [65, 1], [67, 1], [69, 2]],
  [[71, 1], [72, 1], [71, 0.5], [69, 0.5], [67, 2]],
  [[65, 1], [64, 1], [62, 1], [64, 1], [60, 3]],
  [[67, 0.5], [69, 0.5], [71, 1], [72, 1], [74, 1], [72, 3]],
];
const BEAT = 0.6;

interface Ev {
  t: number;
  dur: number;
  midi: number;
  amp: number;
  cents: (tNote: number) => number;
  vib: number;
  legato: boolean;
}

/** 재현 가능한 의사난수 */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

function events(kind: "guide" | "mine"): Ev[] {
  const r = rng(kind === "guide" ? 7 : 42);
  const evs: Ev[] = [];
  let t = kind === "mine" ? 1.0 : 0.6; // 내 녹음은 시작이 0.4초 늦음
  PHRASES.forEach((phrase, p) => {
    const lastIdx = phrase.length - 1;
    phrase.forEach(([midi, beats], k) => {
      let dur = beats * BEAT - 0.03;
      let start = t;
      let offset = 0;
      let wobble = (_: number) => 0;
      let vib = dur > 0.8 ? 32 : 0;
      // 가이드의 강약: 프레이즈 안 첫음 강조 + 마지막 프레이즈 크레센도
      let amp = 0.55 + (k === 0 ? 0.25 : 0) + (p === 4 ? k * 0.08 : 0) - (k === lastIdx ? 0.15 : 0);

      if (kind === "mine") {
        offset = (r() - 0.5) * 14;
        if (p === 1) offset -= 48; // 음이 낮음
        if (p === 2) start += 0.16; // 박자 늦음
        if (p === 3) {
          const ph = r() * 6;
          wobble = (x) => 42 * Math.sin(2 * Math.PI * 1.6 * x + ph); // 흔들림
          if (k === lastIdx) dur *= 0.35; // 끝음 끊김
          if (k === 2) dur *= 0.4;
        }
        if (p === 4) {
          amp = 0.62; // 강약 없음
          vib = 0; // 비브라토 없음
        } else {
          vib *= 0.8;
        }
      }
      evs.push({
        t: start,
        dur,
        midi,
        amp,
        cents: (x) => offset + wobble(x),
        vib,
        legato: k > 0,
      });
      t += beats * BEAT;
    });
    t += BEAT * 1.5;
  });
  return evs;
}

export function renderSample(kind: "guide" | "mine"): Float32Array {
  const evs = events(kind);
  const total = evs[evs.length - 1].t + evs[evs.length - 1].dur + 1.2;
  const out = new Float32Array(Math.ceil(total * SAMPLE_RATE));
  const harmonics =
    kind === "guide" ? [1, 0.55, 0.35, 0.22, 0.14, 0.09, 0.05] : [1, 0.7, 0.3, 0.25, 0.08, 0.06, 0.03];
  const noise = rng(kind === "guide" ? 1 : 2);
  let prevHz = 0;

  for (const ev of evs) {
    const target = 440 * 2 ** ((ev.midi - 69) / 12);
    const from = ev.legato && prevHz ? prevHz : target;
    const n0 = Math.floor(ev.t * SAMPLE_RATE);
    const len = Math.floor((ev.dur + 0.08) * SAMPLE_RATE);
    let phase = 0;
    for (let s = 0; s < len; s++) {
      const x = s / SAMPLE_RATE;
      const glide = Math.min(1, x / 0.06);
      let hz = from + (target - from) * (1 - (1 - glide) ** 2);
      const vibOn = Math.min(1, Math.max(0, (x - 0.3) / 0.25));
      const c = ev.cents(x) + ev.vib * vibOn * Math.sin(2 * Math.PI * 5.5 * x);
      hz *= 2 ** (c / 1200);
      phase += (2 * Math.PI * hz) / SAMPLE_RATE;

      const att = Math.min(1, x / 0.04);
      const rel = x > ev.dur ? Math.max(0, 1 - (x - ev.dur) / 0.08) : 1;
      const env = att * rel * (1 - 0.15 * Math.min(1, x / 2));

      let v = 0;
      for (let h = 0; h < harmonics.length; h++) v += harmonics[h] * Math.sin((h + 1) * phase);
      v = v * 0.32 * ev.amp * env + (noise() - 0.5) * 0.004 * env;
      const idx = n0 + s;
      if (idx < out.length) out[idx] += v;
    }
    prevHz = target;
  }
  return out;
}

/** 16-bit PCM WAV 인코딩 */
export function encodeWav(samples: Float32Array, sr: number): Uint8Array {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
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
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** 소리 없이 음정 곡선만 계산 (홈 화면 미리보기용, 20ms 간격) */
export function sampleContour(kind: "guide" | "mine", hopSec = 0.02): (number | null)[] {
  const evs = events(kind);
  const shift = kind === "mine" ? 0.4 : 0; // 시간 정렬된 상태로 보여 줌
  const total = evs[evs.length - 1].t + evs[evs.length - 1].dur + 0.6;
  const out: (number | null)[] = [];
  for (let t = 0; t < total; t += hopSec) {
    const tt = t + shift;
    const ev = evs.find((e) => tt >= e.t && tt < e.t + e.dur);
    if (!ev) {
      out.push(null);
      continue;
    }
    const x = tt - ev.t;
    const vibOn = Math.min(1, Math.max(0, (x - 0.3) / 0.25));
    const c = ev.cents(x) + ev.vib * vibOn * Math.sin(2 * Math.PI * 5.5 * x);
    out.push(ev.midi + c / 100);
  }
  return out;
}
