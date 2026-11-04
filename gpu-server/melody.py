"""
연습곡용 새 멜로디 자동 작곡 + 합성음 렌더링.
원곡 음원은 전혀 쓰지 않고, 정해진 화성 진행 위에서 무작위(시드 고정)로 새 멜로디를 만들어요.
"""

import random

import numpy as np

MAJOR = [0, 2, 4, 5, 7, 9, 11]
MINOR = [0, 2, 3, 5, 7, 8, 10]
# 마디별 화음(으뜸음 기준 반음). 4마디 진행을 두 번 반복해 8마디.
PROG_MAJOR = [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]]  # I  V  vi IV
PROG_MINOR = [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]]  # i  VI III VII
RHYTHMS = [
    [1, 1, 1, 1],
    [1.5, 0.5, 1, 1],
    [0.5, 0.5, 1, 2],
    [2, 1, 1],
    [1, 0.5, 0.5, 2],
    [1, 1, 2],
]
CADENCE = [[2, 2], [1, 3], [1, 1, 2]]


def make_melody(bpm: int, minor: bool, low: bool, seed: int, bars: int = 8):
    """반환: notes(list of dict midi/start/dur/syllable, 초 단위), 전체 길이(초), 으뜸음 midi"""
    rnd = random.Random(seed)
    beat = 60.0 / bpm
    tonic = (48 if low else 60) + rnd.choice([0, 2, -1, 3, -3])
    scale = MINOR if minor else MAJOR
    prog = PROG_MINOR if minor else PROG_MAJOR
    lo, hi = tonic - 1, tonic + 14
    scale_notes = [tonic + o + 12 * k for k in (-1, 0, 1, 2) for o in scale]
    scale_notes = sorted(n for n in scale_notes if lo <= n <= hi)

    notes = []
    prev = tonic + scale[2]
    t = 0.0
    for bar in range(bars):
        chord = prog[bar % 4]
        chord_notes = [n for n in scale_notes if (n - tonic) % 12 in {c % 12 for c in chord}]
        phrase_end = bar % 4 == 3
        rhythm = rnd.choice(CADENCE if phrase_end else RHYTHMS)
        pos = 0.0
        for i, beats in enumerate(rhythm):
            last_of_song = bar == bars - 1 and i == len(rhythm) - 1
            if last_of_song:
                tonics = [n for n in scale_notes if (n - tonic) % 12 == 0]
                pitch = min(tonics, key=lambda n: abs(n - prev))
            elif pos in (0.0, 2.0):  # 강박: 화음 구성음
                cands = sorted(chord_notes, key=lambda n: abs(n - prev))[:3]
                pitch = rnd.choice(cands[:2] if len(cands) > 1 else cands)
            else:  # 약박: 음계에서 1~2칸 이동
                idx = min(range(len(scale_notes)), key=lambda k: abs(scale_notes[k] - prev))
                step = rnd.choice([-2, -1, -1, 1, 1, 2])
                pitch = scale_notes[max(0, min(len(scale_notes) - 1, idx + step))]
            dur = beats * beat
            syllable = "아" if beats >= 2 else "라"
            notes.append({"midi": int(pitch), "start": round(t + pos * beat, 4), "dur": round(dur, 4), "syllable": syllable})
            prev = pitch
            pos += beats
        t += 4 * beat
    total = t + 0.6
    return notes, total, tonic


def expand_bends(notes):
    """한 글자에 여러 음(bends)이 있는 음표를 음 하나씩으로 펼치기 (합성음·반주 조건용, 레가토로 이어 붙임)"""
    out = []
    for nt in notes:
        pts = [(nt["start"], nt["midi"])] + [(float(t), m) for t, m in (nt.get("bends") or [])]
        end = nt["start"] + nt["dur"]
        for k, (t, m) in enumerate(pts):
            t2 = pts[k + 1][0] if k + 1 < len(pts) else end
            if t2 - t > 0.02:
                out.append({"midi": m, "start": round(t, 4), "dur": round(t2 - t, 4), "syllable": nt.get("syllable", "")})
    return out


def render_melody(notes, total: float, sr: int) -> np.ndarray:
    """부드러운 배음 합성음 (레가토 글라이드·긴 음 비브라토)"""
    out = np.zeros(int(total * sr), dtype=np.float32)
    harmonics = np.array([1, 0.5, 0.3, 0.18, 0.1, 0.06], dtype=np.float32)
    prev_hz = None
    for k, nt in enumerate(notes):
        hz = 440.0 * 2 ** ((nt["midi"] - 69) / 12)
        dur = nt["dur"] - 0.03
        n0 = int(nt["start"] * sr)
        n = int((dur + 0.06) * sr)
        x = np.arange(n) / sr
        legato = prev_hz is not None and k > 0 and abs(notes[k - 1]["start"] + notes[k - 1]["dur"] - nt["start"]) < 1e-3
        start_hz = prev_hz if legato else hz
        glide = np.clip(x / 0.05, 0, 1)
        f = start_hz + (hz - start_hz) * (1 - (1 - glide) ** 2)
        vib_on = np.clip((x - 0.35) / 0.3, 0, 1) if dur > 0.9 else 0
        f = f * 2 ** ((25 * vib_on * np.sin(2 * np.pi * 5.4 * x)) / 1200)
        phase = 2 * np.pi * np.cumsum(f) / sr
        env = np.clip(x / 0.03, 0, 1) * np.where(x > dur, np.clip(1 - (x - dur) / 0.06, 0, 1), 1)
        v = np.zeros(n, dtype=np.float32)
        for h, a in enumerate(harmonics):
            v += a * np.sin((h + 1) * phase).astype(np.float32)
        seg = (v * 0.25 * env).astype(np.float32)
        end = min(len(out), n0 + n)
        out[n0:end] += seg[: end - n0]
        prev_hz = hz
    return out
