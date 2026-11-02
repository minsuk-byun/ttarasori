"""
발음 진단: 음성 인식(Whisper)이 노래를 어떤 글자로 알아듣는지 돌려줘요.
비교(어느 글자가 다르게 들리는지)는 브라우저에서 한글 자모 단위로 해요.
"""

import threading

import numpy as np

ASR_ID = "openai/whisper-small"  # MIT 라이선스
_asr = None
_lock = threading.Lock()


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


def transcribe(x: np.ndarray, sr: int = 16000) -> dict:
    """x: 16kHz 모노. 반환: {"text": 전체 글, "chunks": [{"text", "start", "end"}]}"""
    asr = get_asr()
    kw = dict(chunk_length_s=30, batch_size=4, generate_kwargs={"language": "korean", "task": "transcribe"})
    audio = {"raw": x.astype(np.float32), "sampling_rate": sr}
    try:
        out = asr(dict(audio), return_timestamps="word", **kw)
    except Exception:  # noqa: BLE001  단어 단위 시간이 안 되면 문장 단위로
        out = asr(dict(audio), return_timestamps=True, **kw)
    chunks = []
    for ch in out.get("chunks") or []:
        ts = ch.get("timestamp") or (None, None)
        chunks.append({"text": ch.get("text", "").strip(), "start": ts[0], "end": ts[1]})
    return {"text": (out.get("text") or "").strip(), "chunks": chunks}
