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
import time
import uuid
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


_melo = None
_melo_lock = threading.Lock()


def _melo_proc():
    """MeloTTS 를 한 번만 불러 두고 계속 쓰는 작업자 (매번 불러오면 1~2분씩 걸려요)"""
    global _melo
    if _melo is not None and _melo.poll() is None:
        return _melo
    log = open("/opt/melo-worker.log", "a")
    _melo = subprocess.Popen(
        [MELO_PY, str(HERE / "melo_tts.py"), "--serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=log,
        text=True,
        bufsize=1,
    )
    t1 = time.time()
    msg = _melo_read(_melo, 600)
    print(f"[ttarasori] MeloTTS 작업자 시작 {time.time() - t1:.0f}초, 장치 {msg.get('device')}", flush=True)
    if not msg.get("ready"):
        raise RuntimeError("MeloTTS 작업자가 준비되지 않았어요")
    return _melo


def _melo_read(p, timeout: float) -> dict:
    import select

    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([p.stdout], [], [], max(0.1, end - time.time()))
        if not r:
            break
        line = p.stdout.readline()
        if not line:
            raise RuntimeError("MeloTTS 작업자가 멈췄어요")
        if line.startswith("@@"):
            return json.loads(line[2:])
    raise TimeoutError("MeloTTS 응답이 없어요")


def warm_melo():
    """서버 시작 뒤 MeloTTS 설치가 끝나면(최대 40분) 작업자를 미리 띄워 둬요"""
    for _ in range(720):  # 설치를 여러 번 다시 시도할 수 있어 최대 60분까지 기다려요
        if melo_ready():
            with _melo_lock:
                _melo_proc()
            return True
        time.sleep(5)
    return False


def tts_melo_line(text: str, speed: float) -> tuple[np.ndarray, int]:
    import soundfile as sf

    with _melo_lock:
        p = _melo_proc()
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "line.wav")
            rid = uuid.uuid4().hex[:8]
            p.stdin.write(json.dumps({"text": text, "speed": speed, "out": out, "id": rid}, ensure_ascii=False) + "\n")
            p.stdin.flush()
            try:
                # 앞 요청이 늦게 끝나 남은 응답은 건너뛰고, 내 요청(id)의 응답만 받아요
                end = time.time() + 120
                while True:
                    res = _melo_read(p, max(1.0, end - time.time()))
                    if res.get("id") in (rid, None) and "ready" not in res:
                        break
            except Exception:
                # 응답이 없으면 작업자를 끄고 다음에 새로 띄워요 (예전엔 늦은 응답이 다음 요청과 엇갈려 줄줄이 실패했어요)
                global _melo
                try:
                    p.kill()
                except Exception:  # noqa: BLE001
                    pass
                _melo = None
                raise
            if not res.get("ok"):
                raise RuntimeError(res.get("error", "MeloTTS 실패"))
            x, sr = sf.read(out, dtype="float64")
    if x.ndim > 1:
        x = x.mean(axis=1)
    return x, sr


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


def render(lines_audio: list[tuple[np.ndarray, int]], groups: list[list[int]], notes: list[dict], pron: list[str], total: float, sr_out: int, memo: dict | None = None) -> np.ndarray:
    import librosa
    import pyworld as pw

    n_out = int((total + 0.5) / FRAME)
    fft = pw.get_cheaptrick_fft_size(SRW)
    out_f0 = np.zeros(n_out)
    out_sp = np.full((n_out, fft // 2 + 1), 1e-12)
    out_ap = np.ones((n_out, fft // 2 + 1))
    mask = np.zeros(n_out)
    prev_end = -1.0
    prev_start = -1.0
    prev_hz = None

    for (x, sr), idxs in zip(lines_audio, groups):
        if not idxs:
            continue
        # 줄마다 분석(정렬·WORLD)은 한 번만: 다른 줄만 바꿔 다시 부를 때 이전 분석을 그대로 써요 (예전엔 매번 처음부터 해서 느렸어요)
        mkey = (id(x), tuple(idxs))
        if memo is not None and mkey in memo:
            starts, f0, sp, ap, nf, segs = memo[mkey]
        else:
            if sr != SRW:
                x = librosa.resample(x, orig_sr=sr, target_sr=SRW)
            x = np.nan_to_num(x.astype(np.float64))
            # 완전한 무음(0)이 있으면 분석값이 0 이 되어 합성 때 NaN 이 생겨요 → 아주 작은 잡음을 더해요
            x = x + np.random.default_rng(0).standard_normal(len(x)) * 1e-6
            _ta = time.time()
            starts = align(x, SRW, [pron[k] for k in idxs])
            _tb = time.time()
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
            print(f"[ttarasori] 시간: 줄 분석 정렬 {_tb - _ta:.1f}초, WORLD {time.time() - _tb:.1f}초 ({len(x) / SRW:.1f}초 음성)", flush=True)
            if memo is not None:
                memo[mkey] = (starts, f0, sp, ap, nf, segs)
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
            # 자음은 박 앞에. 앞 음과 붙어 있으면 앞 음 끝을 최대 60ms(앞 음 길이의 35%)까지 빌려서라도
            # 자음 길이를 지켜요. 자음이 눌리면 '너는 잘했어' 같은 빽빽한 곳이 뭉개져요.
            borrow = min(0.06, max(0.0, (prev_end - prev_start) * 0.35)) if prev_end > 0 else 0.0
            room = int(max(0.0, nt["start"] - max(prev_end - borrow, nt["start"] - on * FRAME)) / FRAME)
            on_out = min(on, room)
            on_idx = np.round(np.linspace(fs, fs + on - 1, on_out)).astype(int) if on_out > 0 else np.array([], dtype=int)
            # 짧은 음: 받침은 최대한 지키고 모음을 줄여요 (모음은 최소 30ms 또는 40%).
            # 예전엔 받침도 같이 줄여서 '잘했어'의 '잘'처럼 받침 있는 글자가 뭉개졌어요.
            nuc_min = max(6, int(want * 0.4))
            coda_n = min(len(coda_src), max(1 if len(coda_src) else 0, want - nuc_min))
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
            prev_start = nt["start"]
            prev_end = nt["start"] + dur
            prev_hz = hz

    _ts = time.time()
    y = np.nan_to_num(pw.synthesize(out_f0, out_sp, out_ap, SRW, FRAME * 1000), nan=0.0, posinf=0.0, neginf=0.0)
    print(f"[ttarasori] 시간: WORLD 합성 {time.time() - _ts:.1f}초", flush=True)
    # 노래하는 곳만 남기고 경계는 10ms 로 부드럽게
    m = np.convolve(mask, np.ones(3) / 3, mode="same")
    env = np.interp(np.arange(len(y)) / SRW, np.arange(n_out) * FRAME, m)
    y = y * env
    y = librosa.resample(np.nan_to_num(y), orig_sr=SRW, target_sr=sr_out)[: int(total * sr_out)]
    peak = float(np.max(np.abs(y))) or 1.0
    return (y / peak * 0.8).astype(np.float32)


# ---------------------------------------------------------------- 또렷함 검사
def _heard(y: np.ndarray, sr: int) -> list[str] | None:
    try:
        import librosa
        import pronounce

        if not pronounce.ready():
            return None
        return sing.HANGUL.findall(pronounce.transcribe(librosa.resample(y, orig_sr=sr, target_sr=16000), 16000)["text"])
    except Exception:  # noqa: BLE001
        return None


def _ratio(expect_orig: list[str], expect_pron: list[str], heard: list[str]) -> float:
    return max(SequenceMatcher(None, expect_orig, heard).ratio(), SequenceMatcher(None, expect_pron, heard).ratio())


def clarity(y: np.ndarray, sr: int, orig: list[str], pron: list[str]) -> float | None:
    h = _heard(y, sr)
    return None if h is None else _ratio(orig, pron, h)


LINE_GOOD = 0.75
RETRY_BUDGET = float(os.environ.get("SING_RETRY_BUDGET", "75"))  # 초


def sing_best(notes: list[dict], total: float, sr: int, line_syls: list[list[str]], line_texts: list[str]) -> tuple[np.ndarray, dict]:
    """
    한 가지 방법으로 먼저 불러 보고, 음성 인식으로 줄마다 또렷함을 재요.
    덜 또렷한 줄만 다른 방법(더 천천히 읽기, 다른 읽기 모델)으로 바꿔 보고 나아지면 그 줄을 바꿔요.
    """
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

    methods: list[tuple[str, object]] = []
    if melo_ready():
        # 천천히(0.7) 읽은 쪽이 노래로 늘였을 때 훨씬 또렷했어요 (테스트: 1줄 0.27→0.94, 2줄 0.31→0.78) → 먼저 써서 다시 부르기를 줄여요
        methods += [("melo", 0.7), ("melo", 0.85)]
    methods += [("mms", (0.8, 0.4)), ("mms", (0.7, 0.33))]
    errors: list[str] = []
    cache: dict[tuple, tuple[np.ndarray, int] | None] = {}
    memo: dict = {}
    t0 = time.time()

    def line_audio(m, li):
        key = (m[0], str(m[1]), li)
        if key not in cache:
            try:
                t1 = time.time()
                cache[key] = tts_melo_line(line_texts[li], m[1]) if m[0] == "melo" else tts_mms(pron_lines[li], *m[1])
                print(f"[ttarasori] 시간: {li + 1}줄 읽기 {m} {time.time() - t1:.1f}초", flush=True)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{m[0]}: {type(e).__name__}: {e}"[:200])
                print(f"[ttarasori] 가사 줄 읽기 실패 {m}: {e}", flush=True)
                cache[key] = None
        return cache[key]

    # 1) 기본 방법: 모든 줄을 읽을 수 있는 첫 방법
    choice: list[tuple[str, object]] = []
    for li in range(len(groups)):
        for m in methods:
            if line_audio(m, li) is not None:
                choice.append(m)
                break
        else:
            raise RuntimeError("; ".join(errors) or "가사 노래를 만들지 못했어요")

    def build(ch):
        t1 = time.time()
        try:
            return render([line_audio(m, li) for li, m in enumerate(ch)], groups, notes, pron, total, sr, memo)
        finally:
            print(f"[ttarasori] 시간: 노래 합성 {time.time() - t1:.1f}초", flush=True)

    def line_score(y, li):
        g = groups[li]
        a = max(0, int((notes[g[0]]["start"] - 0.35) * sr))
        b = min(len(y), int((notes[g[-1]]["start"] + notes[g[-1]]["dur"] + 0.35) * sr))
        t1 = time.time()
        h = _heard(y[a:b], sr)
        print(f"[ttarasori] 시간: {li + 1}줄 듣기 {time.time() - t1:.1f}초", flush=True)
        return None if h is None else _ratio([orig[i] for i in g], [pron[i] for i in g], h)

    y = build(choice)
    scores = [line_score(y, li) for li in range(len(groups))]
    swaps = 0
    # 2) 덜 또렷한 줄만 다른 방법으로
    if all(s is not None for s in scores):
        for li in range(len(groups)):
            for m in methods:
                if scores[li] >= LINE_GOOD:
                    break
                if time.time() - t0 > RETRY_BUDGET:  # 너무 오래 걸리지 않게: 시간 예산을 넘으면 그만
                    print("[ttarasori] 가사 다시 부르기: 시간 예산 초과로 멈춤", flush=True)
                    break
                if m == choice[li] or line_audio(m, li) is None:
                    continue
                trial = choice[:li] + [m] + choice[li + 1:]
                y2 = build(trial)
                s2 = line_score(y2, li)
                print(f"[ttarasori] 가사 {li + 1}줄 {choice[li]}→{m}: {scores[li]:.2f}→{s2}", flush=True)
                if s2 is not None and s2 > scores[li] + 0.05:
                    choice, y, scores[li] = trial, y2, s2
                    swaps += 1
    total_c = clarity(y, sr, orig, pron)
    print(f"[ttarasori] 가사 노래 완성: 또렷함 {total_c}, 줄별 {scores}, 바꾼 줄 {swaps}, {time.time() - t0:.0f}초", flush=True)
    engines = sorted({m[0] for m in choice})
    return y, {
        "engine": "+".join(engines),
        "clarity": round(total_c if total_c is not None else 0.5, 3),
        "lines": [None if s is None else round(s, 3) for s in scores],
        "tried": len({(k2[0], k2[1]) for k2 in cache}) or 1,
        "swaps": swaps,
        "pron": "".join(pron),
        "errors": errors,
    }
