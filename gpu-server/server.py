"""
따라소리 GPU 서버 (VESSL Service에서 실행)

POST /jobs              원곡 + 목소리 샘플 + 키 → 작업 ID
GET  /jobs/{id}         진행 상태
GET  /jobs/{id}/mix     완성된 AI 커버 (반주 포함, mp3)
GET  /jobs/{id}/vocals  AI 보컬만 (wav, 비교 분석용)

인증: Vercel의 /api/cover/token 이 SERVICE_SECRET 으로 서명한 짧은 수명 토큰을
      Authorization: Bearer <token> 또는 ?t=<token> 으로 전달.
"""

import base64
import json
import hashlib
import hmac
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from queue import Queue

import librosa
import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

SEED_VC_DIR = Path(os.environ.get("SEED_VC_DIR", "/root/seed-vc"))
WORK_DIR = Path(os.environ.get("WORK_DIR", "/tmp/ttarasori-jobs"))
SECRET = os.environ.get("SERVICE_SECRET", "")
ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
# 내 PC에서 npm run dev 로 띄운 따라소리(VPN 환경)도 항상 허용
if "*" not in ORIGINS:
    ORIGINS += ["http://localhost:3000", "http://127.0.0.1:3000"]
MAX_UPLOAD_MB = 60
MAX_SONG_SEC = 8 * 60
JOB_TTL_SEC = 2 * 60 * 60
SR = 44100

WORK_DIR.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(SEED_VC_DIR))

app = FastAPI(title="ttarasori-gpu")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

jobs: dict[str, dict] = {}
queue: "Queue[str]" = Queue()
vc_model = None
model_lock = threading.Lock()


# ---------------------------------------------------------------- 인증
def verify(token: str | None):
    if not SECRET:
        return  # 비밀키 미설정 시 인증 생략 (로컬 테스트용)
    if not token:
        raise HTTPException(401, "인증 토큰이 없어요.")
    try:
        exp_s, sig = token.split(".", 1)
        exp = int(exp_s)
    except ValueError:
        raise HTTPException(401, "인증 토큰 형식이 잘못됐어요.")
    good = base64.urlsafe_b64encode(hmac.new(SECRET.encode(), exp_s.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    if not hmac.compare_digest(sig, good) or exp < time.time():
        raise HTTPException(401, "인증 토큰이 만료됐거나 올바르지 않아요.")


def token_from(req: Request) -> str | None:
    auth = req.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:]
    return req.query_params.get("t")


# ---------------------------------------------------------------- 모델
def get_model():
    global vc_model
    with model_lock:
        if vc_model is None:
            cwd = os.getcwd()
            os.chdir(SEED_VC_DIR)  # Seed-VC 는 상대 경로로 설정·체크포인트를 읽음
            try:
                from seed_vc_wrapper import SeedVCWrapper

                vc_model = SeedVCWrapper()
            finally:
                os.chdir(cwd)
    return vc_model


def convert(source: Path, ref: Path, semitones: int, steps: int) -> np.ndarray:
    model = get_model()
    cwd = os.getcwd()
    os.chdir(SEED_VC_DIR)
    try:
        gen = model.convert_voice(
            str(source),
            str(ref),
            diffusion_steps=steps,
            f0_condition=True,
            auto_f0_adjust=False,
            pitch_shift=semitones,
            stream_output=False,
        )
        # convert_voice 는 제너레이터라 끝까지 돌려서 반환값을 받음
        try:
            while True:
                next(gen)
        except StopIteration as stop:
            return np.asarray(stop.value, dtype=np.float32)
    finally:
        os.chdir(cwd)


musicgen = None
musicgen_lock = threading.Lock()
MUSICGEN_ID = os.environ.get("MUSICGEN_MODEL", "facebook/musicgen-melody")


def get_musicgen():
    """멜로디 조건부 반주 생성 모델 (MusicGen-melody, 비상업 라이선스 CC-BY-NC 4.0)"""
    global musicgen
    with musicgen_lock:
        if musicgen is None:
            import torch
            from transformers import AutoProcessor, MusicgenMelodyForConditionalGeneration

            device = "cuda" if torch.cuda.is_available() else "cpu"
            processor = AutoProcessor.from_pretrained(MUSICGEN_ID)
            # fp16 에서는 무음/NaN 이 나오는 경우가 있어 fp32 로 실행 (RTX 3090 24GB 에 충분)
            model = MusicgenMelodyForConditionalGeneration.from_pretrained(MUSICGEN_ID, torch_dtype=torch.float32).to(device)
            musicgen = (processor, model, device)
    return musicgen


def generate_backing(melody: np.ndarray, melody_sr: int, prompt: str, seconds: float) -> tuple[np.ndarray, int]:
    import torch

    processor, model, device = get_musicgen()
    inputs = processor(audio=melody, sampling_rate=melody_sr, text=[prompt], padding=True, return_tensors="pt")
    inputs = {k: v.to(device) for k, v in inputs.items()}
    frame_rate = model.config.audio_encoder.frame_rate
    tokens = int(min(30.0, seconds) * frame_rate) + 8
    with torch.no_grad():
        audio = model.generate(**inputs, do_sample=True, guidance_scale=3.0, max_new_tokens=tokens)
    sr = model.config.audio_encoder.sampling_rate
    out = audio[0, 0].float().cpu().numpy()
    rms = float(np.sqrt(np.mean(np.square(np.nan_to_num(out)))))
    print(f"[ttarasori] backing len={len(out) / sr:.1f}s rms={rms:.4f} nan={int(np.isnan(out).sum())}", flush=True)
    if not np.isfinite(out).all() or rms < 1e-3:
        raise RuntimeError(f"반주 생성 결과가 비어 있어요 (rms={rms:.5f})")
    return out, sr


def separate(song: Path, out: Path) -> tuple[Path, Path]:
    """Demucs 로 보컬/반주 분리"""
    subprocess.run(
        [sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", str(out), str(song)],
        check=True,
        capture_output=True,
    )
    stem_dir = next(out.glob(f"htdemucs/{song.stem}"))
    return stem_dir / "vocals.wav", stem_dir / "no_vocals.wav"


def set_step(job_id: str, step: str, progress: float):
    jobs[job_id].update(step=step, progress=progress)


# ---------------------------------------------------------------- 작업 처리
def to_voice_ref(job: dict, d: Path) -> Path:
    """브라우저 녹음(webm/mp4)도 안정적으로 읽히도록 wav 로 변환"""
    voice_wav = d / "voice_ref.wav"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", job["voice"], "-ac", "1", "-ar", "44100", str(voice_wav)],
        check=True,
        capture_output=True,
    )
    return voice_wav


def write_outputs(d: Path, vocal: np.ndarray, backing: np.ndarray, backing_gain: float = 0.9):
    n = max(len(backing), len(vocal))
    mix = np.zeros(n, dtype=np.float32)
    mix[: len(backing)] += backing * backing_gain
    mix[: len(vocal)] += vocal
    peak = float(np.max(np.abs(mix))) or 1.0
    mix = mix / max(1.0, peak / 0.98)
    sf.write(d / "vocals.wav", vocal, SR)
    sf.write(d / "mix.wav", mix, SR)
    for src, dst in (("mix.wav", "mix.mp3"), ("vocals.wav", "vocals.mp3")):
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(d / src), "-b:a", "192k", str(d / dst)],
            check=True,
        )


def run_practice(job_id: str):
    from melody import make_melody, render_melody

    job = jobs[job_id]
    d = Path(job["dir"])
    import sing

    set_step(job_id, "새 멜로디 만들기", 0.05)
    notes, total, tonic = make_melody(job["bpm"], job["minor"], job["low"], job["seed"])
    syls = sing.syllables(job.get("lyrics") or "")
    if syls:
        notes = sing.fit_notes(notes, len(syls))
        for nt, sy in zip(notes, syls):
            nt["syllable"] = sy
    melody32 = render_melody(notes, total, 32000)
    melody44 = render_melody(notes, total, SR)

    # 가사가 있으면 글자마다 발음을 만들어 노래로 이어 붙이기 (실패하면 '라'로 부른 멜로디 사용)
    sung = False
    guide_src = melody44
    if syls:
        set_step(job_id, "가사로 노래 만들기", 0.1)
        try:
            guide_src = sing.sing(notes, total, SR)
            sung = True
        except Exception:  # noqa: BLE001
            print("[ttarasori] 가사 노래 실패:\n" + traceback.format_exc()[-1500:], flush=True)
    sf.write(d / "melody.wav", guide_src, SR)
    (d / "notes.json").write_text(
        json.dumps(
            {"notes": notes, "duration": total, "bpm": job["bpm"], "tonic": tonic, "lyrics": bool(syls), "sung": sung},
            ensure_ascii=False,
        )
    )

    set_step(job_id, "반주 만들기", 0.15)
    backing, bsr = generate_backing(melody32, 32000, job["prompt"], total)
    backing = librosa.resample(backing, orig_sr=bsr, target_sr=SR).astype(np.float32)
    backing = backing / max(1e-6, float(np.max(np.abs(backing)))) * 0.6
    # 반주가 멜로디보다 짧으면 페이드아웃, 길면 자르기
    want = int(total * SR)
    if len(backing) > want:
        backing = backing[:want]
    fade = min(len(backing), int(0.8 * SR))
    backing[-fade:] *= np.linspace(1, 0, fade, dtype=np.float32)

    if job.get("voice"):
        set_step(job_id, "내 목소리로 가이드 만들기", 0.6)
        vocal = convert(d / "melody.wav", to_voice_ref(job, d), 0, job["steps"])
        vpeak = float(np.max(np.abs(vocal))) or 1.0
        vocal = vocal / vpeak * 0.7
    else:
        vocal = guide_src if sung else melody44 * 2.2

    set_step(job_id, "합치기", 0.92)
    # 가이드 보컬이 반주를 덮지 않게 음량 맞추기 (보컬 RMS ≈ 반주 RMS × 1.4)
    b_rms = float(np.sqrt(np.mean(np.square(backing)))) or 1e-6
    v_rms = float(np.sqrt(np.mean(np.square(vocal)))) or 1e-6
    vocal = vocal * (b_rms * 1.4 / v_rms)
    write_outputs(d, vocal.astype(np.float32), backing, backing_gain=1.0)


def run_job(job_id: str):
    job = jobs[job_id]
    d = Path(job["dir"])
    try:
        if job.get("kind") == "practice":
            job["status"] = "running"
            run_practice(job_id)
            job.update(status="done", step="완료", progress=1.0)
            return
        job["status"] = "running"
        set_step(job_id, "보컬과 반주 분리", 0.1)
        vocals, inst = separate(Path(job["song"]), d / "sep")

        set_step(job_id, "내 목소리로 변환", 0.4)
        ai_vocal = convert(vocals, to_voice_ref(job, d), job["key"], job["steps"])

        set_step(job_id, "반주와 합치기", 0.85)
        acc, _ = librosa.load(str(inst), sr=SR, mono=True)
        if job["key"]:
            acc = librosa.effects.pitch_shift(acc, sr=SR, n_steps=job["key"])
        write_outputs(d, ai_vocal, acc.astype(np.float32))
        job.update(status="done", step="완료", progress=1.0)
    except subprocess.CalledProcessError as e:
        job.update(status="error", error="음원 처리 중 오류가 났어요.", detail=(e.stderr or b"")[-2000:].decode(errors="ignore"))
    except Exception as e:  # noqa: BLE001
        what = "연습곡을" if job.get("kind") == "practice" else "AI 커버를"
        job.update(status="error", error=f"{what} 만들지 못했어요.", detail="".join(traceback.format_exception(e))[-2000:])


def worker():
    while True:
        job_id = queue.get()
        try:
            run_job(job_id)
        finally:
            queue.task_done()


def janitor():
    while True:
        time.sleep(600)
        now = time.time()
        for jid, job in list(jobs.items()):
            if now - job["created"] > JOB_TTL_SEC:
                shutil.rmtree(job["dir"], ignore_errors=True)
                jobs.pop(jid, None)


@app.on_event("startup")
def startup():
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=janitor, daemon=True).start()
    # 첫 요청이 느리지 않도록 모델을 미리 올려 둠
    def warm():
        try:
            get_model()
            print("[ttarasori] 음성 변환 모델 준비 완료", flush=True)
            get_musicgen()
            print("[ttarasori] 반주 생성 모델 준비 완료", flush=True)
            import sing

            if sing.ready():
                sing.warm()
                print("[ttarasori] 가사 노래 모델 준비 완료", flush=True)
            else:
                print("[ttarasori] 가사 노래 패키지(pyworld)가 없어 '라'로만 불러요", flush=True)
        except Exception:  # noqa: BLE001
            traceback.print_exc()

    threading.Thread(target=warm, daemon=True).start()


# ---------------------------------------------------------------- API
def _lyrics_ready() -> bool:
    try:
        import sing

        return sing.ready() and sing._tts is not None
    except Exception:  # noqa: BLE001
        return False


@app.get("/health")
def health():
    tunnel = Path("/root/tunnel-url.txt")
    return {
        "ok": True,
        "model_loaded": vc_model is not None,
        "practice_ready": musicgen is not None,
        "lyrics_ready": _lyrics_ready(),
        "queue": queue.qsize(),
        "tunnel_url": tunnel.read_text().strip() if tunnel.exists() else None,
    }


async def save_upload(f: UploadFile, dest: Path):
    size = 0
    with dest.open("wb") as out:
        while chunk := await f.read(1 << 20):
            size += len(chunk)
            if size > MAX_UPLOAD_MB << 20:
                raise HTTPException(413, f"파일이 너무 커요. {MAX_UPLOAD_MB}MB 이하로 올려 주세요.")
            out.write(chunk)


@app.post("/jobs")
async def create_job(
    request: Request,
    song: UploadFile = File(...),
    voice: UploadFile = File(...),
    key: int = Form(0),
    steps: int = Form(30),
):
    verify(token_from(request))
    if not -12 <= key <= 12:
        raise HTTPException(400, "키는 -12에서 12 사이로 정해 주세요.")
    job_id = uuid.uuid4().hex[:12]
    d = WORK_DIR / job_id
    d.mkdir()
    song_path = d / f"song{Path(song.filename or '').suffix or '.mp3'}"
    voice_path = d / f"voice{Path(voice.filename or '').suffix or '.wav'}"
    await save_upload(song, song_path)
    await save_upload(voice, voice_path)

    try:
        dur = librosa.get_duration(path=str(song_path))
    except Exception:  # noqa: BLE001
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, "노래 파일을 열 수 없어요. mp3, wav, m4a 파일로 올려 주세요.")
    if dur > MAX_SONG_SEC:
        shutil.rmtree(d, ignore_errors=True)
        raise HTTPException(400, "노래가 너무 길어요. 8분 이하의 곡으로 올려 주세요.")

    jobs[job_id] = {
        "status": "queued",
        "step": "대기 중",
        "progress": 0.0,
        "dir": str(d),
        "song": str(song_path),
        "voice": str(voice_path),
        "key": key,
        "steps": max(10, min(50, steps)),
        "created": time.time(),
    }
    queue.put(job_id)
    return {"id": job_id, "position": queue.qsize()}


@app.get("/jobs/{job_id}")
def job_status(job_id: str, request: Request):
    verify(token_from(request))
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "작업을 찾을 수 없어요.")
    return {k: job.get(k) for k in ("status", "step", "progress", "error", "detail")}


def job_file(job_id: str, request: Request, name: str, media: str):
    verify(token_from(request))
    job = jobs.get(job_id)
    if not job or job["status"] != "done":
        raise HTTPException(404, "아직 결과가 없어요.")
    return FileResponse(Path(job["dir"]) / name, media_type=media, filename=f"ttarasori-{job_id}-{name}")


@app.get("/jobs/{job_id}/mix")
def job_mix(job_id: str, request: Request):
    return job_file(job_id, request, "mix.mp3", "audio/mpeg")


@app.get("/jobs/{job_id}/vocals")
def job_vocals(job_id: str, request: Request):
    # wav 는 무료 터널에서 일부 구간 전송이 실패하는 경우가 있어 mp3 로 제공
    return job_file(job_id, request, "vocals.mp3", "audio/mpeg")


@app.get("/jobs/{job_id}/vocals.wav")
def job_vocals_wav(job_id: str, request: Request):
    return job_file(job_id, request, "vocals.wav", "audio/wav")


@app.post("/practice")
async def create_practice(
    request: Request,
    prompt: str = Form(...),
    bpm: int = Form(80),
    minor: bool = Form(False),
    low: bool = Form(False),
    seed: int = Form(0),
    lyrics: str = Form(""),
    voice: UploadFile | None = File(None),
):
    """원곡 '느낌'(텍스트 설명)만으로 새 연습곡 만들기. 원곡 음원은 받지 않아요."""
    verify(token_from(request))
    if not 50 <= bpm <= 160:
        raise HTTPException(400, "빠르기는 50~160 BPM 사이로 정해 주세요.")
    prompt = prompt.strip()[:300]
    if not prompt:
        raise HTTPException(400, "스타일 설명이 비어 있어요.")
    job_id = uuid.uuid4().hex[:12]
    d = WORK_DIR / job_id
    d.mkdir()
    voice_path = None
    if voice is not None and voice.filename:
        voice_path = d / f"voice{Path(voice.filename).suffix or '.webm'}"
        await save_upload(voice, voice_path)
    jobs[job_id] = {
        "kind": "practice",
        "status": "queued",
        "step": "대기 중",
        "progress": 0.0,
        "dir": str(d),
        "voice": str(voice_path) if voice_path else None,
        "prompt": prompt,
        "bpm": bpm,
        "minor": minor,
        "low": low,
        "seed": seed,
        "lyrics": lyrics[:400],
        "steps": 30,
        "created": time.time(),
    }
    queue.put(job_id)
    return {"id": job_id, "position": queue.qsize()}


@app.get("/jobs/{job_id}/notes")
def job_notes(job_id: str, request: Request):
    return job_file(job_id, request, "notes.json", "application/json")
