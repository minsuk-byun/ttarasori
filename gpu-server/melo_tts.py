"""MeloTTS 한국어로 가사 줄 읽기 (별도 가상환경에서 실행: 패키지 버전이 서버와 달라서)"""

import json
import sys

import torch
from melo.api import TTS

cfg = json.load(open(sys.argv[1], encoding="utf-8"))
model = TTS(language="KR", device="cuda" if torch.cuda.is_available() else "cpu")
spk = model.hps.data.spk2id["KR"]
for i, text in enumerate(cfg["lines"]):
    model.tts_to_file(text, spk, f"{cfg['out']}/line{i}.wav", speed=cfg.get("speed", 0.9), quiet=True)
