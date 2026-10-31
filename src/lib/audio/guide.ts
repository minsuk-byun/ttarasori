/**
 * 목소리 등록용 "따라 부르기" 가이드 (자체 작곡한 짧은 소절)
 * 모음(아·에·이·오·우)과 음높이를 고르게 담아서 음색 샘플로 쓰기 좋게 구성했어요.
 */

export interface GuideNote {
  midi: number;
  beats: number;
  syllable: string;
}

export interface GuidePhrase {
  title: string;
  notes: GuideNote[];
}

const n = (midi: number, beats: number, syllable: string): GuideNote => ({ midi, beats, syllable });

/** 기준 음높이(높은 목소리). 낮은 목소리는 한 옥타브 아래로 */
export const GUIDE_PHRASES: GuidePhrase[] = [
  { title: "올라가는 계이름", notes: [n(60, 1, "도"), n(62, 1, "레"), n(64, 1, "미"), n(65, 1, "파"), n(67, 2, "솔")] },
  { title: "내려오는 계이름", notes: [n(67, 1, "솔"), n(65, 1, "파"), n(64, 1, "미"), n(62, 1, "레"), n(60, 2, "도")] },
  { title: "다섯 모음", notes: [n(64, 1.5, "아"), n(67, 1.5, "에"), n(69, 1.5, "이"), n(67, 1.5, "오"), n(64, 2, "우")] },
  { title: "짧은 멜로디", notes: [n(60, 0.5, "랄"), n(64, 0.5, "라"), n(67, 1, "랄"), n(69, 1, "라"), n(67, 1, "라"), n(64, 2, "라")] },
  { title: "길게 한 음", notes: [n(67, 4, "아")] },
];

export const GUIDE_BPM = 92;
export const beatSec = () => 60 / GUIDE_BPM;

export const phraseSeconds = (p: GuidePhrase) => p.notes.reduce((s, x) => s + x.beats, 0) * beatSec();

/** 가이드 소절을 부드러운 사인파 합성음으로 렌더링 */
export function renderPhrase(p: GuidePhrase, sr: number, shift: number): Float32Array {
  const beat = beatSec();
  const total = phraseSeconds(p) + 0.3;
  const out = new Float32Array(Math.ceil(total * sr));
  const harmonics = [1, 0.5, 0.3, 0.18, 0.1, 0.06];
  let t = 0;
  for (const note of p.notes) {
    const dur = note.beats * beat - 0.04;
    const hz = 440 * 2 ** ((note.midi + shift - 69) / 12);
    const n0 = Math.floor(t * sr);
    const len = Math.floor((dur + 0.06) * sr);
    let phase = 0;
    for (let s = 0; s < len; s++) {
      const x = s / sr;
      const vibOn = dur > 1 ? Math.min(1, Math.max(0, (x - 0.35) / 0.3)) : 0;
      const f = hz * 2 ** ((22 * vibOn * Math.sin(2 * Math.PI * 5.3 * x)) / 1200);
      phase += (2 * Math.PI * f) / sr;
      const env = Math.min(1, x / 0.04) * (x > dur ? Math.max(0, 1 - (x - dur) / 0.06) : 1);
      let v = 0;
      for (let h = 0; h < harmonics.length; h++) v += harmonics[h] * Math.sin((h + 1) * phase);
      const idx = n0 + s;
      if (idx < out.length) out[idx] += v * 0.22 * env;
    }
    t += note.beats * beat;
  }
  return out;
}

/** 내 차례를 알리는 짧은 신호음 */
export function renderCue(sr: number): Float32Array {
  const len = Math.floor(0.12 * sr);
  const out = new Float32Array(len);
  for (let s = 0; s < len; s++) {
    const x = s / sr;
    out[s] = Math.sin(2 * Math.PI * 1320 * x) * 0.15 * Math.min(1, x / 0.005) * (1 - x / 0.12);
  }
  return out;
}
