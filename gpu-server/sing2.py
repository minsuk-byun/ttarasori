"""
가사 부르기 v2: 또렷한 발음을 위해 '문장 단위'로 합성해요.

1) 가사를 소리 나는 대로 바꾸고(pron.py) 한 줄을 통째로 읽게 해요 → 글자 사이가 자연스럽게 이어져요.
2) 강제 정렬(MMS_FA)로 각 글자가 녹음 어디에 있는지 찾아요.
3) WORLD 보코더로 첫소리(자음)는 원래 길이 그대로, 모음만 음표 길이에 맞게 늘려요.
   자음은 박보다 살짝 앞에 두어서 모음이 박에 떨어지게 해요 (가수들이 부르는 방식).
4) 읽기 모델(MMS·MeloTTS)과 설정을 바꿔 몇 가지를 만들고, 음성 인식으로 가장 또렷한 걸 골라요.
"""

import json
import os
import subprocess
import tempfile
import threading
from difflib import SequenceMatcher
from pathlib import Path

import numpy as np

import sing
from pron import pronounce

FRAME = 0.005  # WORLD 프레임 (초)
SRW = 24000  # 분석·합성 샘플레이트
MELO_PY = "/opt/melo-venv/bin/python"
MELO_OK = "/opt/melo-ok"
HERE = Path(__file__).parent

_fa = None
_fa_lock = threading.Lock()


# ---------------------------------------------------------------- 읽기(TTS)
def tts_mms(text: str, rate: float, noise: float) -> tuple[np.ndarray, int]:
    import torch

    tok, model, device = sing._get_tts()
    old = (getattr(model, "speaking_rate", 1.0), getattr(model, "noise_scale", 0.667))
    model.speaking_rate = rate
    model.noise_scale = noise
    try:
        t = sing.romanize(text) if getattr(tok, "is_uroman", False) else text
        inputs = tok(t, return_tensors="pt").to(device)
        torch.manual_seed(0)
        with torch.no_grad():
            wav = model(**inputs).waveform[0].float().cpu().numpy()
    finally:
        model.speaking_rate, model.noise_scale = old
    return wav.astype(np.float64), model.config.sampling_rate


def melo_ready() -> bool:
    return os.path.exists(MELO_OK) and os.path.exists(MELO_PY)


def tts_melo(lines: list[str], speed: float) -> list[tuple[np.ndarray, int]]:
    import soundfile as sf

    with tempfile.TemporaryDirectory() as d:
        cfg = Path(d) / "cfg.json"
        cfg.write_text(json.dumps({"lines": lines, "speed": speed, "out": d}, ensure_ascii=False), encoding="utf-8")
        subprocess.run([MELO_PY, str(HERE / "melo_tts.py"), str(cfg)], check=True, capture_output=True, timeout=300)
        out = []
        for i in range(len(lines)):
            x, sr = sf.read(str(Path(d) / f"line{i}.wav"), dtype="float64")
            if x.ndim > 1:
                x = x.mean(axis=1)
            out.append((x, sr))
        return out


# ---------------------------------------------------------------- 강제 정렬
def _get_fa():
    global _fa
    with _fa_lock:
        if _fa is None:
            import torch
            import torchaudio

            bundle = torchaudio.pipelines.MMS_FA  # CC-BY-NC 4.0
            dev = "cuda" if torch.cuda.is_available() else "cpu"
            model = bundle.get_model(with_star=False).to(dev).eval()
            _fa = (bundle, model, bundle.get_tokenizer(), bundle.get_aligner(), dev)
    return _fa


def _roman(s: str) -> str:
    r = sing.romanize(s).lower()
    r = "".join(ch for ch in r if ch in "abcdefghijklmnopqrstuvwxyz'")
    return r or "a"


def align(x: np.ndarray, sr: int, syls: list[str]) -> list[float]:
    """글자마다 시작 시각(초). (정렬 결과는 순간만 찍혀서, 글자 구간은 '다음 글자 시작까지'로 써요)"""
    import torch
    import torchaudio

    bundle, model, tokenizer, aligner, dev = _get_fa()
    w = torch.tensor(x, dtype=torch.float32)[None]
    if sr != bundle.sample_rate:
        w = torchaudio.functional.resample(w, sr, bundle.sample_rate)
    with torch.inference_mode():
        emission, _ = model(w.to(dev))
    tokens = tokenizer([_roman(s) for s in syls])
    spans = aligner(emission[0], tokens)
    sec = w.size(1) / emission.size(1) / bundle.sample_rate
    return [sp[0].start * sec for sp in spans]


# ---------------------------------------------------------------- 노래로 맞추기
def _has_jong(s: str) -> bool:
    c = ord(s) - 0xAC00
    return 0 <= c < 11172 and c % 28 != 0


def render(lines_audio: list[tuple[np.ndarray, int]], groups: list[list[int]], notes: list[dict], pron: list[str], total: float, sr_out: int) -> np.ndarray:
    import librosa
    import pyworld as pw

    n_out = int((total + 0.5) / FRAME)
    fft = pw.get_cheaptrick_fft_size(SRW)
    out_f0 = np.zeros(n_out)
    out_sp = np.full((n_out, fft // 2 + 1), 1e-12)
    out_ap = np.ones((n_out, fft // 2 + 1))
    mask = np.zeros(n_out)
    prev_end = -1.0
    prev_hz = None

    for (x, sr), idxs in zip(lines_audio, groups):
        if not idxs:
            continue
        if sr != SRW:
            x = librosa.resample(x, orig_sr=sr, target_sr=SRW)
        x = np.nan_to_num(x.astype(np.float64))
        # 완전한 무음(0)이 있으면 분석값이 0 이 되어 합성 때 NaN 이 생겨요 → 아주 작은 잡음을 더해요
        x = x + np.random.default_rng(0).standard_normal(len(x)) * 1e-6
        starts = align(x, SRW, [pron[k] for k in idxs])
        # dio+stonemask: harvest 보다 훨씬 빨라요 (읽기 음성이라 정확도도 충분)
        f0, t = pw.dio(x, SRW, f0_floor=60, f0_ceil=600, frame_period=FRAME * 1000)
        f0 = pw.stonemask(x, f0, t, SRW)
        sp = np.maximum(np.nan_to_num(pw.cheaptrick(x, f0, t, SRW), nan=1e-12), 1e-12)
        ap = np.clip(np.nan_to_num(pw.d4c(x, f0, t, SRW), nan=1.0), 0.0, 1.0)
        f0 = np.nan_to_num(f0)
        nf = len(f0)
        # 마지막 글자는 목소리가 끝나는 곳까지
        hop = int(SRW * FRAME)
        rms = np.array([np.sqrt(np.mean(x[i * hop:(i + 1) * hop] ** 2) + 1e-12) if i * hop < len(x) else 0.0 for i in range(nf)])
        loud = np.where(rms > max(1e-4, float(rms.max()) * 0.05))[0]
        end_t = (loud[-1] + 2) * FRAME if len(loud) else nf * FRAME
        segs = [(starts[j], starts[j + 1] if j + 1 < len(starts) else max(starts[j] + 0.1, end_t)) for j in range(len(starts))]
        for k, (s, e) in zip(idxs, segs):
            nt = notes[k]
            fs = int(s / FRAME)
            fe = max(fs + 3, min(nf, int(e / FRAME) + 1))
            voiced = f0[fs:fe] > 0
            first_v = int(np.argmax(voiced)) if voiced.any() else 0
            on = min(first_v, int(0.12 / FRAME))  # 첫소리(자음) 길이, 최대 120ms
            coda = min(int(0.07 / FRAME), max(2, int((fe - fs) * 0.3))) if _has_jong(pron[k]) else 2
            nuc_src = np.arange(fs + on, max(fs + on + 1, fe - coda))
            coda_src = np.arange(max(fs + on + 1, fe - coda), fe)

            dur = max(0.08, nt["dur"] - 0.02)
            want = int(dur / FRAME)
            # 자음은 박 앞에 (앞 음과 겹치지 않을 만큼만)
            room = int(max(0.0, nt["start"] - max(prev_end, nt["start"] - on * FRAME)) / FRAME)
            on_out = min(on, room)
            on_idx = np.round(np.linspace(fs, fs + on - 1, on_out)).astype(int) if on_out > 0 else np.array([], dtype=int)
            # 음이 너무 짧으면 받침·모음을 비율대로 줄여요
            coda_n = min(len(coda_src), max(1, want // 4))
            nuc_n = max(2, want - coda_n)
            nuc_idx = np.round(np.linspace(nuc_src[0], nuc_src[-1], nuc_n)).astype(int)
            coda_idx = np.round(np.linspace(coda_src[0], coda_src[-1], coda_n)).astype(int) if len(coda_src) else np.array([], dtype=int)
            src = np.concatenate([on_idx, nuc_idx, coda_idx]).clip(0, nf - 1)
            start_frame = int(round(nt["start"] / FRAME)) - on_out
            hz = 440.0 * 2 ** ((nt["midi"] - 69) / 12)
            legato = prev_hz is not None and abs(prev_end - nt["start"]) < 0.05
            for q, si in enumerate(src):
                o = start_frame + q
                if o < 0 or o >= n_out:
                    continue
                out_sp[o] = sp[si]
                out_ap[o] = ap[si]
                in_nuc = on_out <= q < on_out + nuc_n
                tt = (q - on_out) * FRAME
                h = hz
                if in_nuc and legato and tt < 0.04:  # 앞 음에서 부드럽게 이어 올라가기
                    h = prev_hz * (hz / prev_hz) ** (tt / 0.04)
                if in_nuc and dur > 0.8 and tt > 0.35:  # 긴 음 비브라토
                    h *= 2 ** ((22 * min(1, (tt - 0.35) / 0.25) * np.sin(2 * np.pi * 5.4 * tt)) / 1200)
                out_f0[o] = h if (in_nuc or f0[si] > 0) else 0.0
                mask[o] = 1.0
            prev_end = nt["start"] + dur
            prev_hz = hz

    y = np.nan_to_num(pw.synthesize(out_f0, out_sp, out_ap, SRW, FRAME * 1000), nan=0.0, posinf=0.0, neginf=0.0)
    # 노래하는 곳만 남기고 경계는 10ms 로 부드럽게
    m = np.convolve(mask, np.ones(3) / 3, mode="same")
    env = np.interp(np.arange(len(y)) / SRW, np.arange(n_out) * FRAME, m)
    y = y * env
    y = librosa.resample(np.nan_to_num(y), orig_sr=SRW, target_sr=sr_out)[: int(total * sr_out)]
    peak = float(np.max(np.abs(y))) or 1.0
    return (y / peak * 0.8).astype(np.float32)


# ---------------------------------------------------------------- 또렷함 검사
def clarity(y: np.ndarray, sr: int, orig: list[str], pron: list[str]) -> float | None:
    try:
        import librosa
        import pronounce

        if not pronounce.ready():
            return None
        heard = sing.HANGUL.findall(pronounce.transcribe(librosa.resample(y, orig_sr=sr, target_sr=16000), 16000)["text"])
        return max(SequenceMatcher(None, orig, heard).ratio(), SequenceMatcher(None, pron, heard).ratio())
    except Exception:  # noqa: BLE001
        return None


def sing_best(notes: list[dict], total: float, sr: int, line_syls: list[list[str]], line_texts: list[str]) -> tuple[np.ndarray, dict]:
    """여러 방법으로 불러 보고 가장 또렷한 걸 골라요. 반환: (오디오, 정보)"""
    groups: list[list[int]] = []
    k = 0
    for ls in line_syls:
        groups.append(list(range(k, min(len(notes), k + len(ls)))))
        k += len(ls)
    orig = [nt["syllable"] for nt in notes]
    pron: list[str] = []
    for g in groups:
        pron += pronounce([orig[i] for i in g])
    pron_lines = ["".join(pron[i] for i in g) for g in groups]

    # MeloTTS 가 있으면 먼저, 충분히 또렷하면(60% 이상) 거기서 끝내요. 아니면 MMS 로 한 번 더.
    candidates = []
    if melo_ready():
        candidates.append(("melo", 0.85))
    candidates.append(("mms", (0.8, 0.4)))
    results = []
    errors = []
    for engine, opt in candidates:
        try:
            if engine == "melo":
                audio = tts_melo(line_texts, opt)
            else:
                audio = [tts_mms(t, *opt) for t in pron_lines]
            y = render(audio, groups, notes, pron, total, sr)
            c = clarity(y, sr, orig, pron)
            results.append((c if c is not None else (0.5 if engine == "melo" else 0.4), engine, opt, y))
            print(f"[ttarasori] 가사 노래 후보 {engine} {opt}: 또렷함 {c}", flush=True)
            if c is not None and c >= 0.6:
                break  # 충분히 또렷하면 더 안 만들어요
        except Exception as e:  # noqa: BLE001
            errors.append(f"{engine}: {type(e).__name__}: {e}"[:200])
            print(f"[ttarasori] 가사 노래 후보 {engine} 실패: {e}", flush=True)
    if not results:
        raise RuntimeError("; ".join(errors) or "가사 노래를 만들지 못했어요")
    best = max(results, key=lambda r: r[0])
    return best[3], {"engine": best[1], "clarity": round(best[0], 3), "tried": len(results), "pron": "".join(pron), "errors": errors}
