/**
 * 연습곡 스타일: 원곡 정보(제목·설명·태그)에서 장르/분위기/빠르기를 추정하고,
 * 음악 생성 모델에 줄 영어 설명문을 만들어요. 가수·곡 이름은 설명문에 넣지 않아요.
 */

export const GENRES = [
  { id: "ballad", label: "발라드", en: "emotional ballad", bpm: 72, keys: ["발라드", "ballad", "이별", "고백"] },
  { id: "dance", label: "댄스팝", en: "dance pop", bpm: 118, keys: ["댄스", "dance", "kpop", "k-pop", "아이돌", "edm", "퍼포먼스"] },
  { id: "hiphop", label: "힙합", en: "laid-back hip hop beat", bpm: 90, keys: ["힙합", "hiphop", "hip hop", "랩", "rap", "trap"] },
  { id: "rock", label: "록", en: "energetic pop rock band", bpm: 128, keys: ["록", "락", "rock", "밴드", "band", "펑크"] },
  { id: "rnb", label: "R&B", en: "smooth r&b", bpm: 84, keys: ["r&b", "알앤비", "rnb", "soul", "소울"] },
  { id: "acoustic", label: "어쿠스틱", en: "warm acoustic folk", bpm: 88, keys: ["어쿠스틱", "acoustic", "통기타", "포크", "folk", "unplugged"] },
  { id: "jazz", label: "재즈", en: "mellow jazz", bpm: 96, keys: ["재즈", "jazz", "스윙", "swing", "bossa"] },
  { id: "citypop", label: "시티팝", en: "retro city pop", bpm: 108, keys: ["시티팝", "city pop", "citypop", "80s", "레트로"] },
  { id: "indie", label: "인디", en: "dreamy indie pop", bpm: 100, keys: ["인디", "indie", "홍대"] },
  { id: "trot", label: "트로트", en: "korean trot with brass", bpm: 110, keys: ["트로트", "trot", "뽕짝"] },
  { id: "lofi", label: "로파이", en: "chill lofi", bpm: 78, keys: ["lofi", "lo-fi", "로파이", "공부", "chill"] },
  { id: "ost", label: "OST", en: "cinematic drama soundtrack", bpm: 76, keys: ["ost", "드라마", "soundtrack", "영화"] },
] as const;

export const MOODS = [
  { id: "calm", label: "잔잔한", en: "calm", keys: ["잔잔", "calm", "편안", "새벽", "night"] },
  { id: "sad", label: "슬픈", en: "melancholic", keys: ["슬픈", "sad", "이별", "눈물", "그리움", "아픈"] },
  { id: "warm", label: "따뜻한", en: "warm and hopeful", keys: ["따뜻", "warm", "위로", "응원", "희망"] },
  { id: "romantic", label: "설레는", en: "romantic", keys: ["사랑", "love", "설렘", "고백", "romantic"] },
  { id: "upbeat", label: "신나는", en: "bright and upbeat", keys: ["신나", "upbeat", "party", "여름", "summer", "happy"] },
  { id: "dreamy", label: "몽환적인", en: "dreamy", keys: ["몽환", "dreamy", "꿈"] },
  { id: "intense", label: "강렬한", en: "powerful and intense", keys: ["강렬", "powerful", "intense", "고음"] },
] as const;

export const INSTRUMENTS = [
  { id: "piano", label: "피아노", en: "piano" },
  { id: "guitar", label: "기타", en: "acoustic guitar" },
  { id: "eguitar", label: "일렉기타", en: "electric guitar" },
  { id: "strings", label: "현악기", en: "strings" },
  { id: "synth", label: "신스", en: "synth pads" },
  { id: "drums", label: "드럼", en: "drums" },
  { id: "bass", label: "베이스", en: "bass" },
] as const;

const DEFAULT_INSTR: Record<string, string[]> = {
  ballad: ["piano", "strings"],
  dance: ["synth", "drums", "bass"],
  hiphop: ["drums", "bass", "piano"],
  rock: ["eguitar", "drums", "bass"],
  rnb: ["piano", "bass", "drums"],
  acoustic: ["guitar"],
  jazz: ["piano", "bass", "drums"],
  citypop: ["synth", "bass", "drums", "eguitar"],
  indie: ["guitar", "synth", "drums"],
  trot: ["drums", "bass", "synth"],
  lofi: ["piano", "drums"],
  ost: ["piano", "strings"],
};

export interface Style {
  genre: string;
  moods: string[];
  instruments: string[];
  bpm: number;
  minor: boolean;
}

export function inferStyle(text: string): Style {
  const t = text.toLowerCase();
  const score = (keys: readonly string[]) => keys.reduce((s, k) => s + (t.includes(k.toLowerCase()) ? 1 : 0), 0);
  const genre = [...GENRES].sort((a, b) => score(b.keys) - score(a.keys))[0];
  const g = score(genre.keys) > 0 ? genre : GENRES[0];
  const moods = MOODS.filter((m) => score(m.keys) > 0)
    .slice(0, 2)
    .map((m) => m.id);
  const finalMoods = moods.length ? moods : g.id === "dance" || g.id === "trot" ? ["upbeat"] : ["calm"];
  return {
    genre: g.id,
    moods: finalMoods,
    instruments: DEFAULT_INSTR[g.id] ?? ["piano"],
    bpm: g.bpm,
    minor: finalMoods.includes("sad") || finalMoods.includes("dreamy"),
  };
}

export function stylePrompt(s: Style): string {
  const g = GENRES.find((x) => x.id === s.genre) ?? GENRES[0];
  const moods = s.moods.map((id) => MOODS.find((m) => m.id === id)?.en).filter(Boolean);
  const inst = s.instruments.map((id) => INSTRUMENTS.find((i) => i.id === id)?.en).filter(Boolean);
  return [
    moods.length ? `${moods.join(", ")} ${g.en}` : g.en,
    inst.length ? `with ${inst.join(", ")}` : "",
    `${s.bpm} bpm`,
    s.minor ? "minor key" : "major key",
    "instrumental backing track, no vocals, clean mix",
  ]
    .filter(Boolean)
    .join(", ");
}
