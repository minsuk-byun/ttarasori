"""
발음 진단: 음성 인식(Whisper)이 노래를 어떤 글자로 알아듣는지 돌려줘요.
비교(어느 글자가 다르게 들리는지)는 브라우저에서 한글 자모 단위로 해요.

노래는 말보다 알아듣기 어려워서, 소리 나는 부분만 잘라 인식하고 같은 말이 끝없이 반복되는
음성 인식 특유의 오류(조용한 곳에서 '이. 이. 이.' 같은 헛소리)를 걸러요.
"""

import os
import threading

import numpy as np

ASR_ID = os.environ.get("ASR_MODEL", "openai/whisper-large-v3-turbo")  # MIT 라이선스, 한국어 성능이 small 보다 훨씬 좋아요
_asr = None
_lock = threading.Lock()

GEN_STRICT = {
    "language": "korean",
    "task": "transcribe",
    # 반복·헛소리가 나오면 온도를 올려 다시 시도
    "temperature": (0.0, 0.2, 0.4, 0.6),
    "compression_ratio_threshold": 2.0,
    "logprob_threshold": -1.0,
    "no_speech_threshold": 0.6,
}
GEN_BASIC = {"language": "korean", "task": "transcribe"}


def get_asr():
    global _asr
    with _lock:
        if _asr is None:
            import torch
            from transformers import pipeline

            cuda = torch.cuda.is_available()
            _asr = pipeline(
                "automatic-speech-recognition",
                model=ASR_ID,
                torch_dtype=torch.float16 if cuda else torch.float32,
                device=0 if cuda else -1,
            )
    return _asr


def ready() -> bool:
    return _asr is not None


def voiced_regions(x: np.ndarray, sr: int) -> list[tuple[int, int]]:
    """소리 나는 구간만 (0.6초 안쪽 쉼은 이어 붙이고, 앞뒤 0.2초 여유, 최대 28초씩)"""
    win = int(0.03 * sr)
    n = len(x) // win
    if n == 0:
        return []
    rms = np.sqrt(np.mean(x[: n * win].reshape(n, win) ** 2, axis=1))
    thr = max(0.006, float(np.percentile(rms, 95)) * 0.08)
    on = rms > thr
    regs: list[list[int]] = []
    for i, v in enumerate(on):
        if not v:
            continue
        if regs and i - regs[-1][1] <= int(0.6 / 0.03):
            regs[-1][1] = i
        else:
            regs.append([i, i])
    out = []
    pad = int(0.2 * sr)
    for a, b in regs:
        if (b - a) * 0.03 < 0.25:
            continue
        s = max(0, a * win - pad)
        e = min(len(x), (b + 1) * win + pad)
        # 너무 길면 28초씩 나눠요 (Whisper 한 번에 30초)
        while e - s > 28 * sr:
            out.append((s, s + 28 * sr))
            s += 28 * sr
        out.append((s, e))
    return out


def dedupe(words: list[dict]) -> list[dict]:
    """같은 말이 3번 넘게 연달아 나오면 헛소리로 보고 1번만 남겨요"""
    out: list[dict] = []
    run = 0
    for w in words:
        t = w["text"].strip(" .,!?~")
        if out and t and t == out[-1]["text"].strip(" .,!?~"):
            run += 1
            if run >= 2:
                continue
        else:
            run = 0
        out.append(w)
    return out


def _run(asr, audio: np.ndarray, sr: int):
    for gen in (GEN_STRICT, GEN_BASIC):
        for ts in ("word", True):
            try:
                return asr({"raw": audio.astype(np.float32), "sampling_rate": sr}, return_timestamps=ts, generate_kwargs=dict(gen))
            except Exception:  # noqa: BLE001  설정이 안 맞으면 더 단순한 설정으로
                continue
    return {"text": "", "chunks": []}


def transcribe(x: np.ndarray, sr: int = 16000) -> dict:
    """x: 16kHz 모노. 반환: {"text": 전체 글, "chunks": [{"text", "start", "end"}]}"""
    asr = get_asr()
    words: list[dict] = []
    for s, e in voiced_regions(x, sr):
        out = _run(asr, x[s:e], sr)
        off = s / sr
        for ch in out.get("chunks") or []:
            ts = ch.get("timestamp") or (None, None)
            a = None if ts[0] is None else round(ts[0] + off, 2)
            b = None if ts[1] is None else round(ts[1] + off, 2)
            if a is not None and a > (e / sr) + 0.5:
                continue  # 구간 밖 시간은 헛소리
            words.append({"text": (ch.get("text") or "").strip(), "start": a, "end": b})
        if not out.get("chunks") and out.get("text"):
            words.append({"text": out["text"].strip(), "start": round(off, 2), "end": round(e / sr, 2)})
    words = [w for w in dedupe(words) if w["text"]]
    return {"text": " ".join(w["text"] for w in words), "chunks": words}
