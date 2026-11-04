"""
연습곡 믹싱·마스터링 (numpy + scipy 만 사용).
읽기 음성을 노래로 늘이고 다시 합성하면 1kHz 위(발음·밝기 대역)가 거의 사라져서 '답답하게' 들려요
(잰 값: 1~6kHz 1.4%, 보통 노래 10~25%). 그래서
- 보컬: 저음 정리, 웅웅대는 300~500Hz 줄이기, 3kHz 근처(또렷함)·고음 올리기, 배음 살리기(익사이터), 압축
- 반주: 저음 정리, 고음 조금, 스테레오로 넓히기
- 섞기: 보컬에만 약한 공간감(리버브), 스테레오로 내보내고 음량 맞추기
비교·채점에 쓰는 vocals 는 리버브 없이(마른 소리로) 내보내요. 리버브가 있으면 음정 분석이 흐려져요.
"""

import numpy as np
from scipy.signal import lfilter, sosfilt


# ---------------------------------------------------------------- 필터 (RBJ 오디오 EQ 쿡북)
def _biquad(kind: str, f0: float, sr: int, q: float = 0.707, gain_db: float = 0.0) -> np.ndarray:
    a_ = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / sr
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2 * q)
    if kind == "hp":
        b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2]
        a = [1 + alpha, -2 * cw, 1 - alpha]
    elif kind == "peak":
        b = [1 + alpha * a_, -2 * cw, 1 - alpha * a_]
        a = [1 + alpha / a_, -2 * cw, 1 - alpha / a_]
    elif kind == "hshelf":
        sq = 2 * np.sqrt(a_) * alpha
        b = [a_ * ((a_ + 1) + (a_ - 1) * cw + sq), -2 * a_ * ((a_ - 1) + (a_ + 1) * cw), a_ * ((a_ + 1) + (a_ - 1) * cw - sq)]
        a = [(a_ + 1) - (a_ - 1) * cw + sq, 2 * ((a_ - 1) - (a_ + 1) * cw), (a_ + 1) - (a_ - 1) * cw - sq]
    else:
        raise ValueError(kind)
    b, a = np.array(b) / a[0], np.array(a) / a[0]
    return np.concatenate([b, a])[None, :]


def eq(x: np.ndarray, sr: int, bands: list[tuple]) -> np.ndarray:
    sos = np.concatenate([_biquad(*bd[:1], bd[1], sr, *bd[2:]) for bd in bands])
    return sosfilt(sos, x).astype(np.float32)


def _env(x: np.ndarray, sr: int, attack: float, release: float) -> np.ndarray:
    """피크 따라가는 음량 곡선 (빠르게 올라가고 천천히 내려가요). 블록 단위로 계산해서 빠르게"""
    hop = max(1, int(sr * 0.002))
    n = len(x) // hop + 1
    pad = np.zeros(n * hop, dtype=np.float32)
    pad[: len(x)] = np.abs(x)
    blk = pad.reshape(n, hop).max(axis=1)
    ga = np.exp(-hop / (sr * attack))
    gr = np.exp(-hop / (sr * release))
    out = np.empty(n, dtype=np.float32)
    e = 0.0
    for i, v in enumerate(blk):
        g = ga if v > e else gr
        e = g * e + (1 - g) * v
        out[i] = e
    return np.repeat(out, hop)[: len(x)]


def compress(x: np.ndarray, sr: int, thresh_db: float = -20, ratio: float = 3.0, attack: float = 0.005, release: float = 0.12) -> np.ndarray:
    e = _env(x, sr, attack, release)
    lvl = 20 * np.log10(np.maximum(e, 1e-6))
    over = np.maximum(0.0, lvl - thresh_db)
    gain_db = -over * (1 - 1 / ratio)
    return (x * 10 ** (gain_db / 20)).astype(np.float32)


def excite(x: np.ndarray, sr: int, amount: float = 0.35) -> np.ndarray:
    """고음 배음 만들기 (익사이터). 다시 합성한 보컬은 고음 자체가 거의 없어서 EQ 로 올려도 안 살아나요.
    그래서 소리가 남아 있는 800Hz 위 대역을 살짝 찌그러뜨려 새 배음을 만들고, 그중 3kHz 위만 섞어요."""
    mid = eq(x, sr, [("hp", 800, 0.707), ("hp", 800, 0.707)])
    ref = float(np.sqrt(np.mean(mid**2))) or 1e-6
    sat = np.tanh(mid / (ref * 2.5)) * ref * 2.5 - mid  # 찌그러진 부분(새 배음)만
    sat = eq(sat, sr, [("hp", 3000, 0.707), ("hp", 3000, 0.707)])
    # 원래 소리 크기에 비례하게: 새 배음의 RMS 를 mid 대역 RMS 의 amount 배로
    srms = float(np.sqrt(np.mean(sat**2))) or 1e-9
    return (x + sat * (ref * amount / srms)).astype(np.float32)


# ---------------------------------------------------------------- 공간감
def _comb(x: np.ndarray, d: int, fb: float, damp: float) -> np.ndarray:
    """감쇠 있는 빗살 필터 (Freeverb): y[n] = x[n] + fb·LP(y[n-d]), LP 는 1차 저역 통과(고음이 먼저 사라져요).
    지연 d 보다 짧은 덩어리 안에서는 앞 덩어리 출력만 쓰므로, d 샘플씩 묶어서 한 번에 계산해요 (빠름)"""
    out = np.zeros(len(x), dtype=np.float32)
    prev = np.zeros(d, dtype=np.float32)
    zi = np.zeros(1)
    for s0 in range(0, len(x), d):
        e = min(len(x), s0 + d)
        lp, zi = lfilter([1 - damp], [1, -damp], prev[: e - s0], zi=zi)
        cur = x[s0:e] + fb * lp.astype(np.float32)
        out[s0:e] = cur
        prev = np.zeros(d, dtype=np.float32)
        prev[: e - s0] = cur
    return out


def _allpass(x: np.ndarray, d: int, g: float = 0.5) -> np.ndarray:
    """y[n] = -g·x[n] + x[n-d] + g·y[n-d] 를 d 샘플씩 묶어서 계산"""
    out = np.zeros(len(x), dtype=np.float32)
    xp = np.zeros(d, dtype=np.float32)
    yp = np.zeros(d, dtype=np.float32)
    for s0 in range(0, len(x), d):
        e = min(len(x), s0 + d)
        k = e - s0
        cur = -g * x[s0:e] + xp[:k] + g * yp[:k]
        out[s0:e] = cur
        xp = np.zeros(d, dtype=np.float32)
        yp = np.zeros(d, dtype=np.float32)
        xp[:k], yp[:k] = x[s0:e], cur
    return out


def reverb(x: np.ndarray, sr: int, size: float = 0.82, damp: float = 0.35) -> tuple[np.ndarray, np.ndarray]:
    """작은 방 리버브 (좌우 지연을 조금 다르게 해서 스테레오로)"""
    sc = sr / 44100
    combs = [1116, 1188, 1277, 1356, 1422, 1491]
    aps = [556, 441, 341]
    outs = []
    for spread in (0, 23):
        acc = np.zeros(len(x), dtype=np.float32)
        for c in combs:
            acc += _comb(x, int((c + spread) * sc), size, damp)
        acc /= len(combs)
        for a_ in aps:
            acc = _allpass(acc, int((a_ + spread) * sc))
        outs.append(acc)
    return outs[0], outs[1]


def widen(x: np.ndarray, sr: int, amount: float = 0.35) -> tuple[np.ndarray, np.ndarray]:
    """모노 반주를 스테레오로: 300Hz 위만 살짝 늦춘 성분을 좌우 반대로 더해요 (L+R 은 원래 소리 그대로라 모노로 들어도 안전)"""
    d = int(sr * 0.011)
    side = np.zeros_like(x)
    side[d:] = x[:-d]
    side = eq(side, sr, [("hp", 300, 0.707)]) * amount
    return (x + side).astype(np.float32), (x - side).astype(np.float32)


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x)))) or 1e-9


# ---------------------------------------------------------------- 전체
def vocal_chain(v: np.ndarray, sr: int) -> np.ndarray:
    """마른 보컬 다듬기 (비교·채점에도 쓰는 소리)"""
    v = eq(
        v,
        sr,
        [
            ("hp", 110, 0.707),
            ("peak", 380, 1.0, -3.5),  # 웅웅·답답한 대역
            ("peak", 2800, 0.8, 6.0),  # 발음 또렷함
            ("hshelf", 6000, 0.707, 6.0),  # 공기감
        ],
    )
    v = excite(v, sr, 0.6)
    v = compress(v, sr, -20, 3.0)
    return v


def master_practice(vocal: np.ndarray, backing: np.ndarray, sr: int, vocal_ratio: float = 1.15) -> tuple[np.ndarray, np.ndarray]:
    """반환: (스테레오 믹스 [n, 2], 마른 보컬 모노). vocal_ratio: 보컬 RMS ÷ 반주 RMS"""
    n = max(len(vocal), len(backing))
    v = np.zeros(n, dtype=np.float32)
    b = np.zeros(n, dtype=np.float32)
    v[: len(vocal)] = vocal
    b[: len(backing)] = backing

    v = vocal_chain(v, sr)
    b = eq(b, sr, [("hp", 40, 0.707), ("peak", 3000, 1.0, -1.5), ("hshelf", 8000, 0.707, 2.5)])  # 보컬 자리를 조금 비워 줘요
    bl, br = widen(b, sr)

    # 보컬 음량을 반주에 맞추기 (예전 1.4배는 가이드가 너무 앞에 나와 '노래'보다 '안내 음성'처럼 들렸어요)
    v = v * (_rms(b) * vocal_ratio / _rms(v))
    pre = np.zeros(int(sr * 0.025), dtype=np.float32)  # 25ms 늦게 울리기 시작해서 발음이 안 흐려지게
    wet_src = eq(np.concatenate([pre, v])[:n], sr, [("hp", 250, 0.707), ("hshelf", 6000, 0.707, -4)])
    rl, rr = reverb(wet_src, sr)
    wet = 0.22
    left = bl + v + wet * rl
    right = br + v + wet * rr
    mix = np.stack([left, right], axis=1)

    # 음량 맞추기: 평균 약 -14dBFS, 넘치는 꼭대기는 부드럽게 눌러요
    target = 10 ** (-14 / 20)
    mix *= target / _rms(mix)
    mix = np.tanh(mix / 0.95) * 0.95
    return mix.astype(np.float32), v.astype(np.float32)
