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
def run_job(job_id: str):
    job = jobs[job_id]
    d = Path(job["dir"])
    try:
        job["status"] = "running"
        set_step(job_id, "보컬과 반주 분리", 0.1)
        vocals, inst = separate(Path(job["song"]), d / "sep")

        set_step(job_id, "내 목소리로 변환", 0.4)
        ai_vocal = convert(vocals, Path(job["voice"]), job["key"], job["steps"])

        set_step(job_id, "반주와 합치기", 0.85)
        acc, _ = librosa.load(str(inst), sr=SR, mono=True)
        if job["key"]:
            acc = librosa.effects.pitch_shift(acc, sr=SR, n_steps=job["key"])
        n = max(len(acc), len(ai_vocal))
        mix = np.zeros(n, dtype=np.float32)
        mix[: len(acc)] += acc * 0.9
        mix[: len(ai_vocal)] += ai_vocal
        peak = float(np.max(np.abs(mix))) or 1.0
        mix = mix / max(1.0, peak / 0.98)

        sf.write(d / "vocals.wav", ai_vocal, SR)
        sf.write(d / "mix.wav", mix, SR)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(d / "mix.wav"), "-b:a", "192k", str(d / "mix.mp3")],
            check=True,
        )
        job.update(status="done", step="완료", progress=1.0)
    except subprocess.CalledProcessError as e:
        job.update(status="error", error="음원 처리 중 오류가 났어요.", detail=(e.stderr or b"")[-2000:].decode(errors="ignore"))
    except Exception as e:  # noqa: BLE001
        job.update(status="error", error="AI 커버를 만들지 못했어요.", detail="".join(traceback.format_exception(e))[-2000:])


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
    threading.Thread(target=get_model, daemon=True).start()


# ---------------------------------------------------------------- API
@app.get("/health")
def health():
    return {"ok": True, "model_loaded": vc_model is not None, "queue": queue.qsize()}


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
    return job_file(job_id, request, "vocals.wav", "audio/wav")
