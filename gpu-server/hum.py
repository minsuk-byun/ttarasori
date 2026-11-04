"""
내 허밍 → 연습곡 멜로디.
사용자가 직접 부른(허밍·'라라라'·가사) 녹음에서 음 높이와 박자를 뽑아 음표로 바꿔요.
원곡 음원은 받지 않고, 사용자의 녹음만 써요.

반환 음표 형식은 melody.make_melody 와 같아요: {"midi", "start", "dur", "syllable"} (초 단위)
numpy·scipy·ffmpeg 만 써요 (YIN 음정 추적을 직접 구현).
"""

import subprocess
import tempfile
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.ndimage import median_filter

SR = 16000
HOP = 160  # 10ms
WIN = 1024
FMIN, FMAX = 70.0, 1000.0
MAX_SEC = 30.0  # 반주 생성(MusicGen)이 30초까지라 맞춰요

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]


class HumError(ValueError):
    """사용자에게 그대로 보여 줄 수 있는 오류"""


def load(path: Path, max_sec: float = MAX_SEC) -> np.ndarray:
    """어떤 형식이든 ffmpeg 로 16kHz 모노로 읽기 (허밍은 최대 30초)"""
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "hum.wav"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(path), "-t", str(max_sec), "-ac", "1", "-ar", str(SR), "-f", "wav", str(out)],
            check=True,
        )
        _, x = wavfile.read(out)
    if x.dtype == np.int16:
        return x.astype(np.float32) / 32768.0
    if x.dtype == np.int32:
        return x.astype(np.float32) / 2147483648.0
    return x.astype(np.float32)


def yin(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """프레임별 (f0 Hz 또는 0, 주기성 0~1, RMS)"""
    n = 1 + max(0, (len(x) - WIN) // HOP)
    if n < 2:
        return np.zeros(0), np.zeros(0), np.zeros(0)
    idx = np.arange(WIN)[None, :] + HOP * np.arange(n)[:, None]
    fr = x[idx]
    fr = fr - fr.mean(axis=1, keepdims=True)
    # 음량은 짧은 창(25ms, 프레임 가운데)으로 재야 같은 음을 끊어 부른 틈이 보여요
    c0 = WIN // 2 - 200
    rms = np.sqrt(np.mean(fr[:, c0 : c0 + 400] ** 2, axis=1))
    tau_max = int(SR / FMIN)
    tau_min = int(SR / FMAX)
    w = WIN - tau_max
    # 차이 함수 d(tau) = r(0)_0..w + r(0)_tau..tau+w - 2 r(tau)  (FFT 자기상관)
    nfft = 1 << int(np.ceil(np.log2(WIN + w)))
    F = np.fft.rfft(fr, nfft)
    G = np.fft.rfft(fr[:, :w][:, ::-1], nfft)
    cross = np.fft.irfft(F * G, nfft)[:, w - 1 : w - 1 + tau_max + 1]
    sq = np.cumsum(np.concatenate([np.zeros((n, 1)), fr**2], axis=1), axis=1)
    e0 = sq[:, w][:, None]
    taus = np.arange(tau_max + 1)
    et = sq[:, taus + w] - sq[:, taus]
    d = np.maximum(e0 + et - 2 * cross, 0)
    # 누적 평균 정규화
    cmnd = np.ones_like(d)
    cs = np.cumsum(d[:, 1:], axis=1)
    cmnd[:, 1:] = d[:, 1:] * taus[1:][None, :] / np.maximum(cs, 1e-12)

    f0 = np.zeros(n)
    per = np.zeros(n)
    th = 0.15
    for i in range(n):
        c = cmnd[i, tau_min : tau_max + 1]
        below = np.where(c < th)[0]
        if below.size:
            k = below[0]
            while k + 1 < len(c) and c[k + 1] < c[k]:
                k += 1
        else:
            k = int(np.argmin(c))
        ti = k + tau_min
        per[i] = 1 - float(cmnd[i, ti])
        # 포물선 보간으로 소수점 주기 다듬기. 거의 무음·평평한 프레임에서는 분모가 0에 가까워
        # 엉뚱한 값(수백만)이 나올 수 있어서, 이동은 ±0.5칸으로 묶고 숫자가 아니면 버려요
        t = float(ti)
        if 1 <= ti < tau_max:
            a, b, cc = cmnd[i, ti - 1], cmnd[i, ti], cmnd[i, ti + 1]
            den = a - 2 * b + cc
            if den > 1e-9:
                off = 0.5 * (a - cc) / den
                if np.isfinite(off):
                    t += float(np.clip(off, -0.5, 0.5))
        f0[i] = SR / t if t > 0 else 0.0
    return f0, per, rms


def _median(a):
    return float(np.median(a)) if len(a) else 0.0


def segment(midi: np.ndarray, rms: np.ndarray, hop: float) -> list[dict]:
    """음정 곡선을 음표로 나누기: 반음 넘게 바뀌거나, 소리가 끊기거나, 같은 음을 다시 부르면(음량이 꺼졌다 커지면) 새 음"""
    notes = []
    n = len(midi)
    min_len = max(3, int(round(0.1 / hop)))
    hold = 4
    i = 0
    while i < n:
        if np.isnan(midi[i]):
            i += 1
            continue
        a = i
        buf = [midi[i]]
        dipped, dip_ref = False, 0.0
        off = 0
        j = i + 1
        while True:
            v = midi[j] if j < n else np.nan
            if np.isnan(v):
                if j - a >= min_len:
                    notes.append((a, j, _median(buf)))
                break
            ref = _median(buf[-20:])
            split_at = None
            if abs(v - ref) > 0.7:
                off += 1
                if off >= hold:
                    split_at = j - hold + 1
            else:
                off = 0
            # 직전 0.25초의 최고 음량보다 깊게(-7.5dB) 꺼졌다가 다시 커지면 같은 음을 새로 부른 것
            # (비브라토·떨림의 음량 출렁임은 보통 이보다 얕아서 나누지 않아요)
            if not dipped:
                lm = float(np.max(rms[max(a, j - 25) : j]))
                if rms[j] < lm * 0.42:
                    dipped, dip_ref = True, lm
            elif rms[j] > dip_ref * 0.7 and j - a >= min_len:
                split_at = j
            if split_at is not None:
                if split_at - a >= min_len:
                    notes.append((a, split_at, _median(buf[: split_at - a])))
                a = split_at
                buf = [x for x in midi[split_at : j + 1] if not np.isnan(x)]
                dipped = False
                off = 0
                j += 1
                continue
            buf.append(v)
            j += 1
        i = j + 1
    return [{"start": a * hop, "end": b * hop, "pitch": p} for a, b, p in notes]


def clean_blips(notes: list[dict]) -> list[dict]:
    """자음·숨 때문에 생긴 아주 짧은 음(0.12초 미만) 정리:
    바로 붙은 이웃 음과 2반음 안쪽이면 그 음에 합쳐요(끌어올리기·글자 경계의 흔들림). 따로 떨어진 건 버려요."""
    out: list[dict] = []
    for nt in notes:
        short = nt["end"] - nt["start"] < 0.12
        if short and out and nt["start"] - out[-1]["end"] < 0.03 and abs(nt["pitch"] - out[-1]["pitch"]) <= 2:
            out[-1]["end"] = nt["end"]
            continue
        out.append(dict(nt))
    # 앞 음에 붙지 못한 짧은 음은 뒤 음의 시작으로 (끌어올리며 시작하는 경우)
    res: list[dict] = []
    for k, nt in enumerate(out):
        if nt["end"] - nt["start"] < 0.12:
            nxt = out[k + 1] if k + 1 < len(out) else None
            if nxt and nxt["start"] - nt["end"] < 0.03 and abs(nt["pitch"] - nxt["pitch"]) <= 2:
                nxt["start"] = nt["start"]
            continue
        res.append(nt)
    return res


def estimate_key(notes: list[dict]) -> tuple[int, bool]:
    """음표 길이로 가중한 음 이름 분포 → (으뜸음 음이름 0~11, 단조 여부) Krumhansl 프로필"""
    hist = np.zeros(12)
    for nt in notes:
        hist[int(round(nt["pitch"])) % 12] += nt["end"] - nt["start"]
    best = (-2.0, 0, False)
    for tonic in range(12):
        h = np.roll(hist, -tonic)
        for minor, prof in ((False, MAJOR_PROFILE), (True, MINOR_PROFILE)):
            if h.std() < 1e-9:
                continue
            c = float(np.corrcoef(h, prof)[0, 1])
            if c > best[0]:
                best = (c, tonic, minor)
    return best[1], best[2]


def snap(pitch: float, tonic_pc: int, minor: bool) -> int:
    """가장 가까운 음계음으로 (음계 밖 음이 확실하면 반음 그대로)"""
    near = int(round(pitch))
    scale = MINOR if minor else MAJOR
    cands = [m for m in range(near - 2, near + 3) if (m - tonic_pc) % 12 in scale]
    best = min(cands, key=lambda m: abs(m - pitch))
    # 반올림한 반음이 음계 밖이어도 0.3반음 안쪽으로 정확히 불렀으면 일부러 낸 음으로 봄
    if (near - tonic_pc) % 12 not in scale and abs(near - pitch) < 0.3 and abs(best - pitch) > 0.7:
        return near
    return best


def estimate_bpm(onsets: list[float], fallback: int) -> int:
    """음 시작 간격으로 빠르기 추정 (50~160). 간격들이 한 박의 정수배·절반에 가장 잘 맞는 값"""
    if len(onsets) < 4:
        return fallback
    iois = np.diff(onsets)
    iois = iois[(iois > 0.12) & (iois < 2.5)]
    if len(iois) < 3:
        return fallback
    best_bpm, best_err = fallback, 1e9
    for bpm in range(55, 156):
        grid = 60.0 / bpm / 2  # 8분음표
        r = iois / grid
        err = float(np.mean(np.abs(r - np.round(r)) ** 2))
        # 너무 잘게 쪼개진 박(빠른 bpm)일수록 대충 맞아 보여서 조금 불리하게
        err += 0.002 * (bpm - 55) / 100
        # 사용자가 고른 빠르기 근처를 조금 선호
        err += 0.01 * abs(np.log2(bpm / fallback))
        if err < best_err:
            best_bpm, best_err = bpm, err
    return int(best_bpm)


def quantize(notes: list[dict], bpm: int, div: int = 4) -> list[dict]:
    """박을 div 칸으로 나눈 격자에 시작·끝 맞추기 (겹치지 않게, 한 음은 최소 한 칸)"""
    g = 60.0 / bpm / div
    t0 = notes[0]["start"]
    out = []
    for nt in notes:
        s = round((nt["start"] - t0) / g)
        e = max(s + 1, round((nt["end"] - t0) / g))
        if out and s < out[-1]["e"]:
            s = out[-1]["e"]
            e = max(e, s + 1)
        out.append({"s": s, "e": e, "midi": nt["midi"]})
    # 이웃 음과의 짧은 틈(16분음표 하나)은 앞 음을 늘려 레가토로
    for a, b in zip(out, out[1:]):
        if b["s"] - a["e"] == 1:
            a["e"] = b["s"]
    return [{"midi": int(o["midi"]), "start": round(o["s"] * g, 4), "dur": round((o["e"] - o["s"]) * g, 4), "syllable": "라"} for o in out]


def extract(path: Path, fallback_bpm: int = 80, low: bool = True, max_sec: float = MAX_SEC) -> tuple[list[dict], float, int, dict]:
    """허밍 파일 → (notes, total, tonic_midi, info). max_sec: 읽을 최대 길이(초)"""
    x = load(path, max_sec)
    if len(x) < SR * 5:
        raise HumError("허밍이 너무 짧아요. 5초 이상 불러 주세요.")
    peak = float(np.max(np.abs(x)))
    if peak < 1e-3:
        raise HumError("허밍 녹음에 소리가 거의 없어요. 마이크를 확인하고 다시 불러 주세요.")
    x = x / peak * 0.9
    f0, per, rms = yin(x)
    hop = HOP / SR
    gate = max(0.02, float(np.percentile(rms, 95)) * 0.12)
    voiced = (f0 > FMIN) & (f0 < FMAX) & (per > 0.6) & (rms > gate)
    midi = np.full(len(f0), np.nan)
    midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440.0)
    # 옥타브 튐 고치기: 주변 중앙값보다 12반음 가까이 벗어나면 옥타브 내리거나 올림
    sm = median_filter(np.nan_to_num(midi, nan=0.0), size=25)
    for i in np.where(voiced)[0]:
        if sm[i] > 0:
            dd = midi[i] - sm[i]
            if abs(abs(dd) - 12) < 1.5:
                midi[i] -= 12 * np.sign(dd)
    # 짧은 떨림 정리
    filled = median_filter(np.nan_to_num(midi, nan=-1.0), size=5)
    midi = np.where(voiced & (filled > 0), filled, np.nan)

    raw = clean_blips(segment(midi, rms, hop))
    if len(raw) < 4:
        raise HumError("허밍에서 음을 충분히 찾지 못했어요. 조용한 곳에서 '라라라'처럼 음을 또렷하게 끊어 불러 주세요.")

    tonic_pc, minor = estimate_key(raw)
    for nt in raw:
        nt["midi"] = snap(nt["pitch"], tonic_pc, minor)

    # 연습곡 음역에 맞게 옥타브 이동 (목소리 없이 만드는 가이드·가사 노래가 편한 높이)
    center = 55 if low else 65
    med = float(np.median([nt["midi"] for nt in raw]))
    shift = 12 * int(round((center - med) / 12))
    for nt in raw:
        nt["midi"] += shift

    bpm = estimate_bpm([nt["start"] for nt in raw], fallback_bpm)
    div = 4
    iois = np.diff([nt["start"] for nt in raw])
    iois = iois[(iois > 0.08) & (iois < 2.5)]
    dense = len(iois) >= 4 and float(np.median(iois)) < 0.75 * 60.0 / bpm
    if bpm > 100 and dense:
        # 가사를 붙여 부르면 글자마다 음이 시작돼서 빠르기를 두 배로 읽기 쉬워요 (발라드 65 → 131).
        # 절반 빠르기로 보고, 격자는 그만큼 잘게(32분음표) 해서 타이밍은 그대로 지켜요
        bpm, div = bpm // 2, 8
    notes = quantize(raw, bpm, div)
    notes = notes[:120]
    total = notes[-1]["start"] + notes[-1]["dur"] + 0.6
    tonic = tonic_pc + 12 * int(round((center - tonic_pc) / 12))
    while tonic > center + 2:
        tonic -= 12
    info = {
        "source": "hum",
        "notes": len(notes),
        "bpm": bpm,
        "key": ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"][tonic_pc] + ("m" if minor else ""),
        "minor": minor,
        "octave_shift": shift,
        "hum_seconds": round(len(x) / SR, 1),
        "voiced_ratio": round(float(voiced.mean()), 2),
    }
    return notes, total, tonic, info
