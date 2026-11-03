"""
MeloTTS 한국어로 가사 줄 읽기 (별도 가상환경에서 실행: 패키지 버전이 서버와 달라서)

- 파일 모드:  melo_tts.py cfg.json          → 한 번에 여러 줄 읽고 끝
- 대기 모드:  melo_tts.py --serve           → 모델을 한 번만 불러 두고, 표준 입력으로 요청을 계속 받아요
  요청 한 줄: {"text": "...", "speed": 0.85, "out": "/tmp/x.wav"}
  응답 한 줄: @@{"ok": true} 또는 @@{"ok": false, "error": "..."}  (라이브러리가 찍는 다른 출력과 구분하려고 @@ 를 붙여요)
"""

import json
import sys

import torch
from melo.api import TTS

model = TTS(language="KR", device="cuda" if torch.cuda.is_available() else "cpu")
spk = model.hps.data.spk2id["KR"]


def say(obj):
    sys.stdout.write("@@" + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if len(sys.argv) > 1 and sys.argv[1] == "--serve":
    # 첫 읽기 때 발음용 언어 모델(BERT)을 내려받고 불러와서 몇 분씩 걸려요 → 준비 단계에서 미리 한 번 읽어 둬요
    try:
        import tempfile, os as _os

        _w = _os.path.join(tempfile.gettempdir(), "melo-warm.wav")
        model.tts_to_file("안녕하세요. 오늘도 잘했어.", spk, _w, speed=0.9, quiet=True)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"warm failed: {e}\n")
    say({"ready": True, "device": str(model.device) if hasattr(model, "device") else ("cuda" if torch.cuda.is_available() else "cpu")})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            model.tts_to_file(req["text"], spk, req["out"], speed=float(req.get("speed", 0.9)), quiet=True)
            say({"ok": True, "id": req.get("id")})
        except Exception as e:  # noqa: BLE001
            say({"ok": False, "id": req.get("id") if isinstance(req, dict) else None, "error": f"{type(e).__name__}: {e}"[:300]})
else:
    cfg = json.load(open(sys.argv[1], encoding="utf-8"))
    for i, text in enumerate(cfg["lines"]):
        model.tts_to_file(text, spk, f"{cfg['out']}/line{i}.wav", speed=cfg.get("speed", 0.9), quiet=True)
