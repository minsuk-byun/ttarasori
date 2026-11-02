"""
내 목소리 교정본: 내가 부른 녹음의 음정만 가이드에 맞게 고쳐서, 내 목소리 그대로 다시 들려줘요.
WORLD 보코더로 음정(f0)·음색(스펙트럼)·숨소리(비주기성)를 나눈 뒤 음정만 바꿔 다시 합성해요.
박자·발음·음색은 그대로라서 "내가 이렇게 불렀으면" 하는 소리가 나와요.
"""

import numpy as np

FRAME_MS = 5.0


def _smooth_valid(d: np.ndarray, valid: np.ndarray, win: int) -> np.ndarray:
    """유효한 프레임끼리만 이동 평균 (비브라토 같은 빠른 떨림은 남기고, 느린 음정 어긋남만 남김)"""
    k = np.ones(win)
    num = np.convolve(np.where(valid, d, 0.0), k, mode="same")
    den = np.convolve(valid.astype(float), k, mode="same")
    out = np.where(den > 0, num / np.maximum(den, 1e-9), 0.0)
    return out


def tune(x: np.ndarray, sr: int, target_hop: float, target_midi: list, strength: float = 1.0) -> tuple[np.ndarray, dict]:
    """
    x: 내 녹음 (mono float)
    target_midi: 내 녹음 시간축 기준 목표 음 (target_hop 초 간격, 소리 없는 곳은 None)
    """
    import pyworld as pw

    x = x.astype(np.float64)
    f0, t = pw.dio(x, sr, f0_floor=70, f0_ceil=1100, frame_period=FRAME_MS)
    f0 = pw.stonemask(x, f0, t, sr)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)

    tgt = np.full(len(f0), np.nan)
    arr = np.array([np.nan if v is None else float(v) for v in target_midi])
    idx = np.round(t / target_hop).astype(int)
    ok = (idx >= 0) & (idx < len(arr))
    tgt[ok] = arr[idx[ok]]

    voiced = f0 > 0
    user_m = np.full(len(f0), np.nan)
    user_m[voiced] = 69 + 12 * np.log2(f0[voiced] / 440.0)
    d = user_m - tgt
    # 3.5반음 넘게 다르면 다른 음을 부른 것(또는 박자 차이)이라 손대지 않음
    valid = np.isfinite(d) & (np.abs(d) < 3.5)
    # 가이드 음이 바뀌는 순간(앞뒤 40ms 안에 반음 넘게 변함)은 박자 차이와 섞여서 제외
    sh = int(40 / FRAME_MS)
    prev_t = np.concatenate([np.full(sh, np.nan), tgt[:-sh]])
    next_t = np.concatenate([tgt[sh:], np.full(sh, np.nan)])
    moving = (np.abs(tgt - prev_t) > 0.5) | (np.abs(tgt - next_t) > 0.5)
    valid &= ~moving

    win = max(3, int(150 / FRAME_MS))  # 150ms
    corr = _smooth_valid(np.nan_to_num(d), valid, win)
    corr = np.where(valid, corr, 0.0) * strength
    # 고친 구간 경계가 툭 끊기지 않게 한 번 더 부드럽게
    corr = np.convolve(corr, np.ones(5) / 5, mode="same")

    new_f0 = f0.copy()
    new_f0[voiced] = 440.0 * 2 ** ((user_m[voiced] - corr[voiced] - 69) / 12)
    y = pw.synthesize(new_f0, sp, ap, sr, FRAME_MS)

    peak_in = float(np.max(np.abs(x))) or 1.0
    peak_out = float(np.max(np.abs(y))) or 1.0
    y = y / peak_out * min(0.95, peak_in)

    before = np.abs(d[valid]) * 100
    after = np.abs((d - corr)[valid]) * 100
    stats = {
        "fixed_ratio": float(valid.sum() / max(1, voiced.sum())),
        "mean_cents_before": float(before.mean()) if before.size else 0.0,
        "mean_cents_after": float(after.mean()) if after.size else 0.0,
    }
    return y.astype(np.float32), stats
