/**
 * 한글 글자 단위 비교 (발음 진단용)
 * 기대 가사와 음성 인식이 알아들은 글자를 첫소리·모음·받침으로 나눠 정렬해요.
 */
const CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
const JUNG = ["ㅏ", "ㅐ", "ㅑ", "ㅒ", "ㅓ", "ㅔ", "ㅕ", "ㅖ", "ㅗ", "ㅘ", "ㅙ", "ㅚ", "ㅛ", "ㅜ", "ㅝ", "ㅞ", "ㅟ", "ㅠ", "ㅡ", "ㅢ", "ㅣ"];
const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];
// 소리로는 같은 받침 (대표음)
const JONG_SOUND: Record<string, string> = {
  ㄱ: "ㄱ", ㄲ: "ㄱ", ㄳ: "ㄱ", ㅋ: "ㄱ", ㄺ: "ㄱ",
  ㄴ: "ㄴ", ㄵ: "ㄴ", ㄶ: "ㄴ",
  ㄷ: "ㄷ", ㅅ: "ㄷ", ㅆ: "ㄷ", ㅈ: "ㄷ", ㅊ: "ㄷ", ㅌ: "ㄷ", ㅎ: "ㄷ",
  ㄹ: "ㄹ", ㄼ: "ㄹ", ㄽ: "ㄹ", ㄾ: "ㄹ", ㅀ: "ㄹ",
  ㅁ: "ㅁ", ㄻ: "ㅁ",
  ㅂ: "ㅂ", ㅍ: "ㅂ", ㅄ: "ㅂ", ㄿ: "ㅂ",
  ㅇ: "ㅇ",
};
// 비슷하게 들리는 모음 묶음
const VOWEL_GROUP: Record<string, number> = { ㅐ: 1, ㅔ: 1, ㅒ: 2, ㅖ: 2, ㅙ: 3, ㅞ: 3, ㅚ: 3 };

export interface Jamo {
  cho: string;
  jung: string;
  jong: string;
}

export function split(s: string): Jamo | null {
  const c = s.charCodeAt(0) - 0xac00;
  if (c < 0 || c >= 11172) return null;
  return { cho: CHO[Math.floor(c / 588)], jung: JUNG[Math.floor((c % 588) / 28)], jong: JONG[c % 28] };
}

export const hangulOnly = (t: string) => t.match(/[가-힣]/g) ?? [];

const jongSound = (j: string) => (j ? JONG_SOUND[j] ?? j : "");
const sameVowel = (a: string, b: string) => a === b || (VOWEL_GROUP[a] != null && VOWEL_GROUP[a] === VOWEL_GROUP[b]);

/** 두 글자 차이 (0 같음 ~ 1 완전히 다름) */
function cost(a: string, b: string): number {
  if (a === b) return 0;
  const x = split(a);
  const y = split(b);
  if (!x || !y) return 1;
  let c = 0;
  if (x.cho !== y.cho) c += 0.35;
  if (!sameVowel(x.jung, y.jung)) c += 0.4;
  if (jongSound(x.jong) !== jongSound(y.jong)) c += 0.3;
  return Math.min(1, c);
}

export type SylStatus = "ok" | "jong" | "vowel" | "cho" | "other" | "missing";

export interface SylResult {
  expected: string;
  heard: string | null;
  status: SylStatus;
  text: string;
}

const eul = (j: string) => `${j}이`; // 받침 이름 뒤 (ㄱ이, ㄴ이 …)
/** 글자 뒤 조사: 받침 있으면 a(이/을), 없으면 b(가/를) */
const josa = (w: string, a: string, b: string) => `'${w}'${split(w)?.jong ? a : b}`;

function explain(e: string, h: string | null): { status: SylStatus; text: string } {
  if (!h) return { status: "missing", text: `${josa(e, "이", "가")} 들리지 않았어요` };
  if (cost(e, h) === 0) return { status: "ok", text: "또렷해요" };
  const x = split(e)!;
  const y = split(h);
  if (!y) return { status: "other", text: `${josa(e, "이", "가")} 다르게 들려요` };
  const choOk = x.cho === y.cho;
  const vowOk = sameVowel(x.jung, y.jung);
  const jongOk = jongSound(x.jong) === jongSound(y.jong);
  if (choOk && vowOk && !jongOk) {
    if (x.jong && !y.jong) return { status: "jong", text: `${josa(e, "이", "가")} '${h}'처럼 들려요. 받침 ${eul(x.jong)} 약해요 — 끝까지 닫아 주세요` };
    if (!x.jong && y.jong) return { status: "jong", text: `${josa(e, "이", "가")} '${h}'처럼 들려요. 받침 없이 열린 소리로 끝내 보세요` };
    return { status: "jong", text: `'${e}'의 받침이 ${y.jong}처럼 들려요` };
  }
  if (choOk && !vowOk) return { status: "vowel", text: `${josa(e, "이", "가")} '${h}'처럼 들려요. 모음 ${x.jung} 입 모양을 더 분명하게 해 보세요` };
  if (!choOk && vowOk) return { status: "cho", text: `${josa(e, "이", "가")} '${h}'처럼 들려요. 첫소리 ${x.cho}을(를) 또렷하게 시작해 보세요` };
  return { status: "other", text: `${josa(e, "이", "가")} '${h}'처럼 들려요` };
}

/** 기대 글자열과 들린 글자열 정렬 (편집 거리) → 기대 글자마다 결과 */
export function alignSyllables(expected: string[], heard: string[]): SylResult[] {
  const n = expected.length;
  const m = heard.length;
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 0 대각, 1 위(빠짐), 2 왼쪽(덧붙음)
  for (let i = 1; i <= n; i++) {
    D[i][0] = i;
    B[i][0] = 1;
  }
  for (let j = 1; j <= m; j++) {
    D[0][j] = j * 0.8;
    B[0][j] = 2;
  }
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const diag = D[i - 1][j - 1] + cost(expected[i - 1], heard[j - 1]);
      const up = D[i - 1][j] + 1;
      const left = D[i][j - 1] + 0.8;
      if (diag <= up && diag <= left) {
        D[i][j] = diag;
        B[i][j] = 0;
      } else if (up <= left) {
        D[i][j] = up;
        B[i][j] = 1;
      } else {
        D[i][j] = left;
        B[i][j] = 2;
      }
    }
  const out: SylResult[] = new Array(n);
  let i = n;
  let j = m;
  while (i > 0) {
    const b = j === 0 ? 1 : B[i][j];
    if (b === 0) {
      const e = expected[i - 1];
      const h = heard[j - 1];
      // 너무 다르면 '다르게 들림'보다 '안 들림'에 가까움
      out[i - 1] = { expected: e, heard: h, ...explain(e, h) };
      i--;
      j--;
    } else if (b === 1) {
      out[i - 1] = { expected: expected[i - 1], heard: null, ...explain(expected[i - 1], null) };
      i--;
    } else j--;
  }
  return out;
}
