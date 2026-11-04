"""
가사 부르기: 한국어 음성 합성(MMS-TTS)으로 글자마다 발음을 만들고,
WORLD 보코더로 각 글자의 음높이·길이를 멜로디 음표에 맞춰 노래처럼 이어 붙여요.
결과는 Seed-VC 로 내 목소리로 바꾸기 전의 '가이드 보컬 원본'이에요.
"""

import re
import threading

import numpy as np

TTS_ID = "facebook/mms-tts-kor"  # CC-BY-NC 4.0 (비상업)
FRAME_MS = 5.0

_tts = None
_lock = threading.Lock()

# ---------------------------------------------------------------- 가사 다루기
HANGUL = re.compile(r"[가-힣]")


def syllables(text: str, limit: int = 48) -> list[str]:
    """한글 음절만 순서대로 꺼내기 (공백·문장부호·영문은 건너뜀)"""
    return HANGUL.findall(text or "")[:limit]


def fit_notes(notes: list[dict], n: int) -> list[dict]:
    """음표 수를 가사 글자 수에 맞추기: 모자라면 긴 음을 둘로 나누고, 남으면 짧은 음을 앞 음에 합쳐요."""
    notes = [dict(x) for x in notes]
    while len(notes) < n:
        i = max(range(len(notes)), key=lambda k: notes[k]["dur"])
        a = notes[i]
        if a["dur"] < 0.2:
            break
        half = round(a["dur"] / 2, 4)
        notes[i:i + 1] = [dict(a, dur=half), dict(a, start=round(a["start"] + half, 4), dur=round(a["dur"] - half, 4))]
    while len(notes) > n and len(notes) > 1:
        i = min(range(1, len(notes)), key=lambda k: notes[k]["dur"])
        prev, cur = notes[i - 1], notes[i]
        prev["dur"] = round(cur["start"] + cur["dur"] - prev["start"], 4)
        del notes[i]
    return notes


def fit_notes_keep(notes: list[dict], n: int) -> list[dict]:
    """음표 수를 글자 수에 맞추되 멜로디는 그대로 지키기 (허밍 멜로디용).
    음이 남으면 합쳐서 없애지 않고, 한 글자를 여러 음에 걸쳐 끌어 부르게 해요(멜리스마).
    합친 음의 높이는 'bends': [[시작 시각(초), midi], …] 로 남겨서 노래·반주·화면이 모두 따라가요.
    어느 음을 앞 글자에 붙일지: 앞 음과 쉼 없이 이어지고(레가토) 짧은 음부터. 쉼 뒤의 음은 새 글자로 남겨요."""
    notes = [dict(x) for x in notes]
    for x in notes:
        x.setdefault("bends", [])
    if len(notes) <= n:
        return fit_notes(notes, n)

    def cost(i: int) -> float:
        prev, cur = notes[i - 1], notes[i]
        gap = cur["start"] - (prev["start"] + prev["dur"])
        c = cur["dur"]
        if gap > 0.08:
            c += 10.0  # 쉼 뒤에서 새로 시작하는 음은 되도록 새 글자로
        c += 0.25 * len(prev["bends"])  # 한 글자에 음이 너무 몰리지 않게 (고르게 나눠요)
        return c

    while len(notes) > n and len(notes) > 1:
        i = min(range(1, len(notes)), key=cost)
        prev, cur = notes[i - 1], notes[i]
        prev["bends"] = prev["bends"] + [[round(cur["start"], 4), cur["midi"]]] + cur["bends"]
        prev["dur"] = round(cur["start"] + cur["dur"] - prev["start"], 4)
        del notes[i]
    return notes


def pitch_at(nt: dict, t: float) -> float:
    """음표 안 t초(절대 시각)의 목표 음 높이 (bends 가 있으면 그 시각 이후의 음)"""
    m = nt["midi"]
    for bt, bm in nt.get("bends") or []:
        if t >= bt:
            m = bm
        else:
            break
    return m


def ensure_min(notes: list[dict], min_dur: float = 0.2, keep: float = 0.3) -> list[dict]:
    """글자마다 최소 길이 보장: 너무 짧은 음은 뒤 쉼표나 이웃한 긴 음에서 시간을 가져와요.
    짧은 음에 글자가 몰리면 자음·모음·받침이 들어갈 시간이 없어 발음이 뭉개져요 ('너는 잘했어').
    keep: 시간을 내주는 음이 지켜야 할 최소 길이. 음 순서와 높이는 그대로, 시작 시각만 조금 움직여요."""
    notes = [dict(x) for x in notes]
    n = len(notes)
    end = lambda k: notes[k]["start"] + notes[k]["dur"]  # noqa: E731
    for _ in range(3):
        for i in range(n):
            need = min_dur - notes[i]["dur"]
            if need <= 1e-4:
                continue
            # 1) 바로 뒤 쉼표에서
            if i + 1 < n:
                gap = notes[i + 1]["start"] - end(i)
                take = min(need, max(0.0, gap - 0.02))
                notes[i]["dur"] += take
                need -= take
            elif i == n - 1:
                notes[i]["dur"] += need
                need = 0
            # 2) 이웃한 긴 음에서 (뒤 음이면 그 시작을 늦추고, 앞 음이면 내 시작을 당겨요)
            for j in sorted([k for k in (i - 1, i + 1) if 0 <= k < n], key=lambda k: -notes[k]["dur"]):
                if need <= 1e-4:
                    break
                touching = abs((notes[j]["start"] - end(i)) if j > i else (notes[i]["start"] - end(j))) < 0.05
                take = min(need, max(0.0, notes[j]["dur"] - keep))
                if not touching or take <= 0:
                    continue
                if j > i:
                    notes[j]["start"] += take
                    notes[j]["dur"] -= take
                    notes[i]["dur"] += take
                else:
                    notes[j]["dur"] -= take
                    notes[i]["start"] -= take
                    notes[i]["dur"] += take
                need -= take
    for x in notes:
        x["start"], x["dur"] = round(x["start"], 4), round(x["dur"], 4)
    return notes


# ---------------------------------------------------------------- 로마자 변환 (MMS 한국어 모델 입력용)
_I = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"]
_V = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"]
_F = ["", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k", "t", "p", "t"]


def _rr(syl: str) -> str:
    c = ord(syl) - 0xAC00
    if not 0 <= c < 11172:
        return syl
    return _I[c // 588] + _V[(c % 588) // 28] + _F[c % 28]


def romanize(text: str) -> str:
    try:
        import uroman as ur  # MMS 학습에 쓰인 로마자 변환기

        return ur.Uroman().romanize_string(text)
    except Exception:  # noqa: BLE001
        return "".join(_rr(ch) for ch in text)


# ---------------------------------------------------------------- 음성 합성
def _get_tts():
    global _tts
    with _lock:
        if _tts is None:
            import torch
            from transformers import AutoTokenizer, VitsModel

            device = "cuda" if torch.cuda.is_available() else "cpu"
            tok = AutoTokenizer.from_pretrained(TTS_ID)
            model = VitsModel.from_pretrained(TTS_ID).to(device).eval()
            _tts = (tok, model, device)
    return _tts


def ready() -> bool:
    try:
        import pyworld  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return True


def warm():
    if ready():
        _get_tts()


def _speak(syl: str) -> tuple[np.ndarray, int]:
    import torch

    tok, model, device = _get_tts()
    text = romanize(syl) if getattr(tok, "is_uroman", False) else syl
    inputs = tok(text, return_tensors="pt").to(device)
    if inputs["input_ids"].shape[-1] == 0:
        inputs = tok(_rr(syl), return_tensors="pt").to(device)
    torch.manual_seed(0)
    with torch.no_grad():
        wav = model(**inputs).waveform[0].float().cpu().numpy()
    return wav.astype(np.float64), model.config.sampling_rate


def _trim(x: np.ndarray, sr: int) -> np.ndarray:
    win = int(0.01 * sr)
    e = np.sqrt(np.convolve(x**2, np.ones(win) / win, mode="same"))
    thr = max(1e-4, float(e.max()) * 0.06)
    idx = np.where(e > thr)[0]
    return x[idx[0] : idx[-1] + 1] if len(idx) else x


def _sing_one(syl: str, midi: float, dur: float, sr_out: int) -> np.ndarray:
    """한 글자를 지정한 음높이·길이로 노래하게 만들기"""
    import pyworld as pw

    x, sr = _speak(syl)
    x = _trim(x, sr)
    f0, t = pw.harvest(x, sr, frame_period=FRAME_MS, f0_floor=60, f0_ceil=700)
    sp = pw.cheaptrick(x, f0, t, sr)
    ap = pw.d4c(x, f0, t, sr)
    n = len(f0)
    voiced = np.where(f0 > 0)[0]
    target = max(4, int(round(dur * 1000 / FRAME_MS)))

    # 첫소리(자음)와 끝소리(받침)는 그대로 두고, 가운데(모음)만 늘리거나 줄여요
    head = int(voiced[0]) + 3 if len(voiced) else 0
    head = min(head, n // 3)
    tail = min(12, max(0, n - head - 4)) if syl and (ord(syl) - 0xAC00) % 28 else 4
    tail = min(tail, max(0, n - head - 2))
    mid_src = max(1, n - head - tail)
    mid_dst = target - head - tail
    if mid_dst < 2:  # 음이 아주 짧으면 전체를 비율대로 줄이기
        idx = np.linspace(0, n - 1, target)
    else:
        idx = np.concatenate([
            np.arange(head),
            head + np.linspace(0, mid_src - 1, mid_dst),
            head + mid_src + np.arange(tail),
        ])
    idx = np.clip(np.round(idx).astype(int), 0, n - 1)
    sp2 = np.ascontiguousarray(sp[idx])
    ap2 = np.ascontiguousarray(ap[idx])

    # 음높이: 유성음 구간은 음표 높이로, 긴 음에는 살짝 비브라토
    hz = 440.0 * 2 ** ((midi - 69) / 12)
    tt = np.arange(len(idx)) * FRAME_MS / 1000
    vib = np.clip((tt - 0.3) / 0.25, 0, 1) * (dur > 0.8)
    f0_target = hz * 2 ** ((25 * vib * np.sin(2 * np.pi * 5.4 * tt)) / 1200)
    was_voiced = f0[idx] > 0
    # 모음 구간은 원래 유성음이 아니었던 프레임도 유성음으로 이어 붙여 끊김 방지
    if mid_dst >= 2:
        was_voiced[head : head + mid_dst] = True
    f02 = np.where(was_voiced, f0_target, 0.0)

    y = pw.synthesize(f02, sp2, ap2, sr, FRAME_MS)
    if sr != sr_out:
        import librosa

        y = librosa.resample(y, orig_sr=sr, target_sr=sr_out)
    fade = min(len(y) // 4, int(0.012 * sr_out))
    if fade > 0:
        y[:fade] *= np.linspace(0, 1, fade)
        y[-fade:] *= np.linspace(1, 0, fade)
    return y.astype(np.float32)


def sing(notes: list[dict], total: float, sr: int) -> np.ndarray:
    """notes: start/dur/midi/syllable 가 들어 있는 음표 목록"""
    out = np.zeros(int(total * sr) + sr, dtype=np.float32)
    for nt in notes:
        y = _sing_one(nt["syllable"], nt["midi"], max(0.08, nt["dur"] - 0.02), sr)
        a = int(nt["start"] * sr)
        b = min(len(out), a + len(y))
        out[a:b] += y[: b - a]
    out = out[: int(total * sr)]
    peak = float(np.max(np.abs(out))) or 1.0
    return out / peak * 0.8
