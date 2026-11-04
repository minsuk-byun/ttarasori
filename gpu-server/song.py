"""
ACE-Step 1.5 로 노래 전체(보컬+반주)를 한 번에 만들기. 같은 GPU 서버 안의 ACE-Step API(127.0.0.1:8001)를 불러요.
- 허밍이 있으면 'cover' 작업: 허밍의 흐름을 따라가면서 새 가사·스타일로 완성된 노래로 바꿔요
  (audio_cover_strength: 1.0 이면 허밍을 거의 그대로, 낮을수록 자유롭게)
- 허밍이 없으면 'text2music': 스타일 설명과 가사로 새 노래
빠르기·조성은 허밍 분석값(hum.extract)을 그대로 넘겨요.
"""

import json
import os
import subprocess
import tempfile
import time
import urllib.request
import uuid
from pathlib import Path

API = os.environ.get("ACE_API", "http://127.0.0.1:8001")


def ready() -> bool:
    if not os.path.exists("/opt/ace-ok"):
        return False
    try:
        urllib.request.urlopen(API + "/v1/models", timeout=3)
        return True
    except Exception:  # noqa: BLE001
        return False


def _post(path: str, body: dict, timeout: float = 60) -> dict:
    req = urllib.request.Request(API + path, data=json.dumps(body).encode("utf-8"), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def lyrics_text(lyrics: str) -> str:
    """사용자 가사 → ACE-Step 형식 (구간 표시 [verse] / [chorus]). 줄이 4줄 넘으면 뒤쪽을 후렴으로"""
    lines = [ln.strip() for ln in (lyrics or "").split("\n") if ln.strip()]
    if not lines:
        return "[Instrumental]"
    if len(lines) <= 4:
        return "[verse]\n" + "\n".join(lines)
    half = len(lines) // 2
    return "[verse]\n" + "\n".join(lines[:half]) + "\n\n[chorus]\n" + "\n".join(lines[half:])


def caption_for(prompt: str, low: bool) -> str:
    voice = "warm male vocal" if low else "clear female vocal"
    return f"{prompt}, Korean pop, {voice}, expressive emotional singing, polished studio mix"


def generate(
    out: Path,
    prompt: str,
    lyrics: str,
    low: bool,
    seconds: float,
    bpm: int | None = None,
    keyscale: str = "",
    src_audio: Path | None = None,
    strength: float = 0.5,
    seed: int = -1,
    log=print,
) -> dict:
    """노래 한 곡을 out(wav)으로 저장하고 정보(dict)를 돌려줘요"""
    body: dict = {
        "prompt": caption_for(prompt, low),
        "lyrics": lyrics_text(lyrics),
        "vocal_language": "ko",
        "audio_format": "wav",
        "batch_size": 1,
        "inference_steps": 8,
        "audio_duration": round(max(15.0, min(90.0, seconds)), 1),
    }
    if bpm:
        body["bpm"] = int(bpm)
    if keyscale:
        body["key_scale"] = keyscale
    if seed >= 0:
        body.update(use_random_seed=False, seed=int(seed))
    tmp = None
    if src_audio is not None:
        # ACE-Step API 는 보안상 임시 폴더(/tmp) 안의 파일만 받아요 → wav 로 바꿔서 임시 폴더에 둬요
        tmp = Path(tempfile.gettempdir()) / f"ttarasori-ace-{uuid.uuid4().hex[:8]}.wav"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src_audio), "-ac", "2", "-ar", "44100", str(tmp)], check=True)
        body.update(task_type="cover", src_audio_path=str(tmp), audio_cover_strength=float(strength), thinking=False)
    else:
        body.update(task_type="text2music", thinking=True)

    t0 = time.time()
    try:
        return _run(body, out, t0, bpm, keyscale, strength if src_audio is not None else None, log)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def _run(body: dict, out: Path, t0: float, bpm, keyscale, strength, log) -> dict:
    r = _post("/release_task", body)
    data = r.get("data") or {}
    task_id = data.get("task_id") if isinstance(data, dict) else None
    if not task_id:
        raise RuntimeError(f"ACE-Step 작업을 만들지 못했어요: {str(r)[:300]}")
    log(f"[ttarasori] ACE-Step 작업 {task_id} ({body['task_type']}, {body['audio_duration']}초, bpm {bpm}, {keyscale}, 세기 {strength})")

    item = None
    while time.time() - t0 < 900:
        time.sleep(3)
        q = _post("/query_result", {"task_id_list": [task_id]}, timeout=30)
        rows = q.get("data") or []
        if not rows:
            continue
        row = rows[0]
        if row.get("status") == 2:
            raise RuntimeError(f"ACE-Step 생성 실패: {str(row)[:400]}")
        if row.get("status") == 1:
            res = row.get("result")
            items = json.loads(res) if isinstance(res, str) else (res or [])
            item = items[0] if items else None
            break
    if not item or not item.get("file"):
        raise RuntimeError("ACE-Step 결과를 기다리다 시간이 지났어요")

    url = item["file"]
    if url.startswith("/"):
        url = API + url
    with urllib.request.urlopen(url, timeout=120) as r2:
        out.write_bytes(r2.read())
    info = {
        "engine": "ace-step-1.5",
        "task": body["task_type"],
        "strength": strength,
        "seconds": round(time.time() - t0, 1),
        "metas": item.get("metas"),
        "lm_model": item.get("lm_model"),
        "dit_model": item.get("dit_model"),
    }
    log(f"[ttarasori] ACE-Step 완성 {info['seconds']}초: {json.dumps(item.get('metas'), ensure_ascii=False)[:200]}")
    return info
