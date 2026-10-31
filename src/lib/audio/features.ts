/**
 * 프레임 단위 음향 특징 추출 (브라우저/Node 공용, 외부 의존성 없음)
 * - 음정: YIN 알고리즘 (de Cheveigné & Kawahara, 2002)
 * - 음량: 프레임 RMS (dB)
 */

export interface Features {
  /** 프레임 간격 (초) */
  hopSec: number;
  /** 기본 주파수 Hz, 무성(소리 없음/잡음) 구간은 0 */
  f0: Float32Array;
  /** 프레임 음량 dB */
  db: Float32Array;
  duration: number;
}

const HOP_SEC = 0.02; // 20ms
const WIN_SEC = 0.025; // 25ms
const F0_MIN = 70;
const F0_MAX = 1100;
const YIN_THRESHOLD = 0.12;

const yieldToUI = () => new Promise<void>((r) => setTimeout(r, 0));

export async function extractFeatures(
  x: Float32Array,
  sr: number,
  onProgress?: (p: number) => void,
): Promise<Features> {
  const hop = Math.round(sr * HOP_SEC);
  const W = Math.round(sr * WIN_SEC);
  const tauMax = Math.floor(sr / F0_MIN);
  const tauMin = Math.max(2, Math.floor(sr / F0_MAX));
  const frameLen = W + tauMax + 2;
  const nFrames = Math.max(0, Math.floor((x.length - frameLen) / hop) + 1);

  const f0 = new Float32Array(nFrames);
  const db = new Float32Array(nFrames);
  const d = new Float32Array(tauMax + 2);

  for (let fi = 0; fi < nFrames; fi++) {
    const start = fi * hop;

    // RMS
    let sum = 0;
    for (let j = 0; j < W; j++) {
      const v = x[start + j];
      sum += v * v;
    }
    db[fi] = 10 * Math.log10(sum / W + 1e-12);

    // YIN difference function
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      let acc = 0;
      const o = start + tau;
      for (let j = 0; j < W; j++) {
        const diff = x[start + j] - x[o + j];
        acc += diff * diff;
      }
      d[tau] = acc;
    }
    // Cumulative mean normalized difference
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax + 1; tau++) {
      running += d[tau];
      d[tau] = running > 0 ? (d[tau] * tau) / running : 1;
    }
    // Absolute threshold
    let tauEst = -1;
    for (let tau = tauMin; tau <= tauMax; tau++) {
      if (d[tau] < YIN_THRESHOLD) {
        while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
        tauEst = tau;
        break;
      }
    }
    if (tauEst > 0) {
      // Parabolic interpolation
      const a = d[tauEst - 1];
      const b = d[tauEst];
      const c = d[tauEst + 1];
      const denom = a - 2 * b + c;
      const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
      const t = tauEst + Math.max(-1, Math.min(1, shift));
      f0[fi] = sr / t;
    }

    if (fi % 400 === 0) {
      onProgress?.(fi / nFrames);
      await yieldToUI();
    }
  }

  // 음량 게이트: 상위 음량 대비 30dB 이상 작은 프레임은 무성 처리
  const sorted = Array.from(db).sort((p, q) => p - q);
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  for (let i = 0; i < nFrames; i++) if (db[i] < loud - 30) f0[i] = 0;

  const cleaned = removeIslands(medianFilter(f0, 5), 4);
  onProgress?.(1);
  return { hopSec: hop / sr, f0: cleaned, db, duration: x.length / sr };
}

/** 유성 프레임끼리만 중앙값 필터 (옥타브 튐 제거) */
function medianFilter(f: Float32Array, size: number): Float32Array {
  const out = new Float32Array(f.length);
  const h = Math.floor(size / 2);
  const buf: number[] = [];
  for (let i = 0; i < f.length; i++) {
    if (f[i] === 0) continue;
    buf.length = 0;
    for (let k = -h; k <= h; k++) {
      const v = f[i + k];
      if (v) buf.push(v);
    }
    buf.sort((a, b) => a - b);
    out[i] = buf[Math.floor(buf.length / 2)];
  }
  return out;
}

/** 너무 짧은 유성 구간(잡음) 제거 */
function removeIslands(f: Float32Array, minLen: number): Float32Array {
  let i = 0;
  while (i < f.length) {
    if (f[i] === 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < f.length && f[j] !== 0) j++;
    if (j - i < minLen) f.fill(0, i, j);
    i = j;
  }
  return f;
}

export const hzToMidi = (hz: number) => 69 + 12 * Math.log2(hz / 440);
