#!/usr/bin/env bash
# VESSL Service 시작 시 한 번 실행: 의존성 설치 → Seed-VC 내려받기 → 서버 실행
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED_VC_COMMIT=51383efd921027683c89e5348211d93ff12ac2a8

if ! command -v ffmpeg >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null
fi

pip install -q --no-cache-dir -r "$HERE/requirements.txt"

if [ ! -d /root/seed-vc ]; then
  git clone -q https://github.com/Plachtaa/seed-vc /root/seed-vc
  git -C /root/seed-vc checkout -q "$SEED_VC_COMMIT"
fi

export SEED_VC_DIR=/root/seed-vc
export HF_HOME="${HF_HOME:-/root/.cache/huggingface}"
cd "$HERE"
exec uvicorn server:app --host 0.0.0.0 --port 8000 --timeout-keep-alive 75
