/**
 * 실시간 음정 인식 (마이크 버퍼 한 조각 → Hz). YIN 을 16kHz 로 줄여서 매 화면마다 돌려도 가볍게.
 */
const THRESH = 0.15;
const W_SEC = 0.025;
const F0_MIN = 70;
const F0_MAX = 1000;

const d = new Float32Array(400);

/** buf: 최근 소리 (sr 샘플레이트), 반환: Hz (소리가 없거나 음정이 아니면 0) */
export function livePitch(buf: Float32Array, sr: number): number {
  // 16kHz 근처로 줄이기
  const step = Math.max(1, Math.round(sr / 16000));
  const s = sr / step;
  const n = Math.floor(buf.length / step);
  const x = new Float32Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < step; k++) v += buf[i * step + k];
    v /= step;
    x[i] = v;
    energy += v * v;
  }
  if (Math.sqrt(energy / n) < 0.008) return 0;
  const W = Math.round(s * W_SEC);
  const tauMax = Math.min(Math.floor(s / F0_MIN), n - W - 1, d.length - 2);
  const tauMin = Math.floor(s / F0_MAX);
  if (tauMax <= tauMin + 2) return 0;
  // 가장 최근 부분으로 계산 (지연을 줄이려고 버퍼 끝쪽 사용)
  const o = n - W - tauMax - 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    let acc = 0;
    for (let j = 0; j < W; j++) {
      const diff = x[o + j] - x[o + j + tau];
      acc += diff * diff;
    }
    d[tau] = acc;
  }
  d[0] = 1;
  let run = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    run += d[tau];
    d[tau] = run > 0 ? (d[tau] * tau) / run : 1;
  }
  for (let tau = tauMin; tau < tauMax; tau++) {
    if (d[tau] < THRESH) {
      while (tau + 1 < tauMax && d[tau + 1] < d[tau]) tau++;
      const a = d[tau - 1];
      const b = d[tau];
      const c = d[tau + 1];
      const den = a - 2 * b + c;
      const sh = den ? Math.max(-1, Math.min(1, (0.5 * (a - c)) / den)) : 0;
      return s / (tau + sh);
    }
  }
  return 0;
}

export const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
/** 남녀 음역 차이: 목표 음과 같은 옥타브로 옮겨서 비교 */
export const foldTo = (m: number, target: number) => m + 12 * Math.round((target - m) / 12);
