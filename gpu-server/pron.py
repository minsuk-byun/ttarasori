"""
가사를 '소리 나는 대로' 바꾸기 (표준 발음법의 주요 규칙만, 한 글자는 한 글자로 유지)
예: 괜찮다고 → 괜찬타고, 웃을 거야 → 우슬 꺼야, 국물 → 궁물, 신라 → 실라
노래 합성(TTS)에 넣는 글자이고, 화면에는 원래 가사를 그대로 보여 줘요.
"""

CHO = ["ㄱ", "ㄲ", "ㄴ", "ㄷ", "ㄸ", "ㄹ", "ㅁ", "ㅂ", "ㅃ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅉ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"]
JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"]

# 겹받침: (남는 받침, 다음 글자로 넘어가는 받침)
SPLIT = {"ㄳ": ("ㄱ", "ㅅ"), "ㄵ": ("ㄴ", "ㅈ"), "ㄶ": ("ㄴ", "ㅎ"), "ㄺ": ("ㄹ", "ㄱ"), "ㄻ": ("ㄹ", "ㅁ"), "ㄼ": ("ㄹ", "ㅂ"),
         "ㄽ": ("ㄹ", "ㅅ"), "ㄾ": ("ㄹ", "ㅌ"), "ㄿ": ("ㄹ", "ㅍ"), "ㅀ": ("ㄹ", "ㅎ"), "ㅄ": ("ㅂ", "ㅅ")}
# 받침의 대표 소리
REP = {"ㄱ": "ㄱ", "ㄲ": "ㄱ", "ㅋ": "ㄱ", "ㄳ": "ㄱ", "ㄺ": "ㄱ", "ㄴ": "ㄴ", "ㄵ": "ㄴ", "ㄶ": "ㄴ", "ㄷ": "ㄷ", "ㅅ": "ㄷ", "ㅆ": "ㄷ",
       "ㅈ": "ㄷ", "ㅊ": "ㄷ", "ㅌ": "ㄷ", "ㅎ": "ㄷ", "ㄹ": "ㄹ", "ㄼ": "ㄹ", "ㄽ": "ㄹ", "ㄾ": "ㄹ", "ㅀ": "ㄹ", "ㅁ": "ㅁ", "ㄻ": "ㅁ",
       "ㅂ": "ㅂ", "ㅍ": "ㅂ", "ㅄ": "ㅂ", "ㄿ": "ㅂ", "ㅇ": "ㅇ", "": ""}
TENSE = {"ㄱ": "ㄲ", "ㄷ": "ㄸ", "ㅂ": "ㅃ", "ㅅ": "ㅆ", "ㅈ": "ㅉ"}
ASPIR = {"ㄱ": "ㅋ", "ㄷ": "ㅌ", "ㅂ": "ㅍ", "ㅈ": "ㅊ"}
NASAL = {"ㄱ": "ㅇ", "ㄷ": "ㄴ", "ㅂ": "ㅁ"}
# 받침 'ㄹ' 뒤에서 된소리가 나는 흔한 말 (관형사형 -ㄹ 뒤: 할 거야 → 할 꺼야)
AFTER_L_TENSE = {"거", "게", "걸", "것", "건", "께", "수", "지", "데", "줄", "적", "때"}


def _split(s: str):
    c = ord(s) - 0xAC00
    if not 0 <= c < 11172:
        return None
    return [CHO[c // 588], (c % 588) // 28, JONG[c % 28]]


def _join(cho: str, jung: int, jong: str) -> str:
    return chr(0xAC00 + CHO.index(cho) * 588 + jung * 28 + JONG.index(jong))


def pronounce(syls: list[str]) -> list[str]:
    """한 줄(또는 이어 부르는 구간)의 글자들 → 소리 나는 글자들 (개수 같음)"""
    j = [_split(s) for s in syls]
    for i in range(len(j) - 1):
        a, b = j[i], j[i + 1]
        if a is None or b is None or not a[2]:
            continue
        jong, nxt = a[2], b[0]
        if nxt == "ㅇ":  # 연음: 받침이 다음 글자 첫소리로
            if jong == "ㅇ":
                continue
            if jong == "ㅎ":
                a[2] = ""
                continue
            if jong in SPLIT:
                keep, move = SPLIT[jong]
                if move == "ㅎ":
                    a[2], b[0] = "", keep
                else:
                    a[2], b[0] = keep, ("ㅆ" if move == "ㅅ" else move)
            else:
                # 구개음화: ㄷ·ㅌ 받침 + 이 → 지·치 (같이 → 가치, 굳이 → 구지)
                if b[1] == 20 and jong in ("ㄷ", "ㅌ"):
                    a[2], b[0] = "", ("ㅈ" if jong == "ㄷ" else "ㅊ")
                else:
                    a[2], b[0] = "", jong
            continue
        # ㅎ 받침 + ㄱㄷㅈ → 거센소리 (좋다 → 조타, 괜찮다 → 괜찬타)
        if jong in ("ㅎ", "ㄶ", "ㅀ") and nxt in ASPIR:
            a[2] = "" if jong == "ㅎ" else SPLIT[jong][0]
            b[0] = ASPIR[nxt]
            continue
        rep = REP.get(jong, jong)
        # 받침 ㄱㄷㅂ + ㅎ → 거센소리 (축하 → 추카)
        if nxt == "ㅎ" and rep in ASPIR:
            a[2] = "" if jong not in SPLIT else SPLIT[jong][0]
            b[0] = ASPIR[rep]
            continue
        # 비음화 (국물 → 궁물, 믿는 → 민는)
        if rep in NASAL and nxt in ("ㄴ", "ㅁ"):
            a[2] = NASAL[rep]
            continue
        # 유음화 (신라 → 실라, 설날 → 설랄)
        if rep == "ㄴ" and nxt == "ㄹ":
            a[2] = "ㄹ"
            continue
        if rep == "ㄹ" and nxt == "ㄴ":
            b[0] = "ㄹ"
            continue
        # 된소리 (학교 → 학꾜, 할 거야 → 할 꺼야)
        if rep in ("ㄱ", "ㄷ", "ㅂ") and nxt in TENSE:
            b[0] = TENSE[nxt]
            continue
        if jong == "ㄹ" and nxt in TENSE and syls[i + 1] in AFTER_L_TENSE:
            b[0] = TENSE[nxt]
            continue
    out = []
    for s, x in zip(syls, j):
        if x is None:
            out.append(s)
            continue
        jong = x[2]
        # 남은 받침은 대표 소리로 (꽃 → 꼳, 부엌 → 부억)
        if jong in SPLIT:
            jong = SPLIT[jong][0] if jong not in ("ㄺ", "ㄻ", "ㄿ") else REP[jong]
        jong = REP.get(jong, jong)
        out.append(_join(x[0], x[1], jong))
    return out
