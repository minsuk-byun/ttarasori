/**
 * 발성·음색 특징 (프레임별, extractFeatures 와 같은 20ms 간격)
 * - centroid: 소리의 밝기 (스펙트럼 무게중심, Hz)
 * - tilt:     고음역(2~5kHz) 에너지 - 저음역(100Hz~1kHz) 에너지 (dB) → 높으면 소리가 납작·날카로움(조임)
 * - cpp:      켑스트럼 피크 돌출도 (dB) → 낮을수록 숨이 섞인 흐린 소리
 */
export interface Timbre {
  hopSec: number;
  centroid: Float32Array;
  tilt: Float32Array;
  cpp: Float32Array;
}

const N = 512;

function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

const hann = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));

export async function extractTimbre(x: Float32Array, sr = 16000, hopSec = 0.02): Promise<Timbre> {
  const hop = Math.round(sr * hopSec);
  const n = Math.max(0, Math.floor((x.length - N) / hop) + 1);
  const centroid = new Float32Array(n);
  const tilt = new Float32Array(n);
  const cpp = new Float32Array(n);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const mag = new Float64Array(N / 2);
  const binHz = sr / N;
  const b100 = Math.round(100 / binHz);
  const b1k = Math.round(1000 / binHz);
  const b2k = Math.round(2000 / binHz);
  const b5k = Math.min(N / 2 - 1, Math.round(5000 / binHz));
  // 켑스트럼에서 볼 범위: 70~1000Hz 기본음
  const q0 = Math.floor(sr / 1000);
  const q1 = Math.min(N / 2 - 1, Math.ceil(sr / 70));
  for (let f = 0; f < n; f++) {
    const o = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = x[o + i] * hann[i];
      im[i] = 0;
    }
    fft(re, im);
    let num = 0;
    let den = 0;
    let lo = 0;
    let hi = 0;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mag[k] = m;
      const p = m * m;
      num += k * binHz * p;
      den += p;
      if (k >= b100 && k < b1k) lo += p;
      else if (k >= b2k && k <= b5k) hi += p;
    }
    centroid[f] = den > 0 ? num / den : 0;
    tilt[f] = 10 * Math.log10((hi + 1e-12) / (lo + 1e-12));
    // CPP: 로그 스펙트럼의 스펙트럼(켑스트럼)에서 기본음 피크가 기준선보다 얼마나 솟았는지
    for (let k = 0; k < N; k++) {
      const kk = k < N / 2 ? k : N - k;
      re[k] = 20 * Math.log10((kk === 0 ? mag[1] : mag[Math.min(kk, N / 2 - 1)]) + 1e-9);
      im[k] = 0;
    }
    fft(re, im);
    let peak = -Infinity;
    let pq = q0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let cnt = 0;
    for (let q = q0; q <= q1; q++) {
      const c = Math.sqrt(re[q] * re[q] + im[q] * im[q]) / N;
      const v = 20 * Math.log10(c + 1e-9);
      if (v > peak) {
        peak = v;
        pq = q;
      }
      sx += q;
      sy += v;
      sxx += q * q;
      sxy += q * v;
      cnt++;
    }
    const slope = (cnt * sxy - sx * sy) / (cnt * sxx - sx * sx || 1);
    const icpt = (sy - slope * sx) / cnt;
    cpp[f] = peak - (icpt + slope * pq);
    if (f % 500 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return { hopSec: hop / sr, centroid, tilt, cpp };
}
