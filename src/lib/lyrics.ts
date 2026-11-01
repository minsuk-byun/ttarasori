/**
 * 연습곡용 예시 가사 (따라소리에서 새로 쓴 가사예요. 원곡 가사는 쓰지 않아요.)
 * 분위기별로 2~3개씩, 한 곡에 18~30글자 정도.
 */
export const SAMPLE_LYRICS: Record<string, string[]> = {
  calm: ["고요한 밤 창가에 기대어\n작은 별빛 하나 세어 보네", "느린 바람 따라 걷다 보면\n마음도 천천히 쉬어 가네"],
  sad: ["멀어지는 너의 뒷모습에\n하지 못한 말만 남아 있어", "비 내리는 거리 위에 서서\n너의 이름 한 번 불러 본다"],
  warm: ["괜찮다고 말해 줄게\n오늘도 너는 잘했어\n내일은 더 웃을 거야", "따뜻한 차 한 잔처럼\n네 곁에 오래 있을게"],
  romantic: ["너를 처음 본 그날부터\n내 하루는 온통 너야\n두근대는 이 마음을", "살며시 잡은 너의 손\n이대로 시간이 멈췄으면"],
  upbeat: ["여름 바람 타고 달려\n신나는 노래 불러 봐\n오늘은 우리 세상", "손뼉 치며 하나 둘 셋\n다 같이 뛰어올라 봐"],
  dreamy: ["구름 위를 걷는 꿈속에\n반짝이는 길을 따라가", "달빛이 내린 호숫가에\n너와 나 둘이 춤을 춰"],
  intense: ["멈추지 마 끝까지\n소리 높여 외쳐 봐\n지금 이 순간 우리의 노래", "넘어져도 다시 일어나\n더 높이 날아오를 거야"],
};

export const countSyllables = (t: string) => (t.match(/[가-힣]/g) ?? []).length;

export function sampleLyrics(moods: string[], index = 0): string {
  const pool = moods.flatMap((m) => SAMPLE_LYRICS[m] ?? []);
  const list = pool.length ? pool : SAMPLE_LYRICS.calm;
  return list[index % list.length];
}

export const LYRICS_MIN = 10;
export const LYRICS_MAX = 40;
