#!/usr/bin/env bash
# VESSL Workspace 시작 시 실행: https 터널 → 의존성 설치 → Seed-VC 내려받기 → 서버 실행
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SEED_VC_COMMIT=51383efd921027683c89e5348211d93ff12ac2a8

log() {
  # 워크스페이스 로그 화면(컨테이너 표준 출력)에도 보이도록 같이 씀
  echo "[ttarasori] $*"
  echo "[ttarasori] $*" > /proc/1/fd/1 2>/dev/null || true
}

download() { # url dest — 멈추지 않게 시간 제한과 재시도 (예전에 GitHub 다운로드가 1시간 넘게 멈춘 적이 있어요)
  for attempt in 1 2 3 4; do
    rm -f "$2"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --connect-timeout 15 --max-time 180 -o "$2" "$1" && return 0
    elif command -v wget >/dev/null 2>&1; then
      timeout 180 wget -q -T 15 -O "$2" "$1" && return 0
    else
      timeout 180 python3 -c "import sys,urllib.request;urllib.request.urlretrieve(sys.argv[1],sys.argv[2])" "$1" "$2" && return 0
    fi
    log "내려받기 실패 ($attempt/4), 다시 시도: $1"
    sleep $((attempt * 5))
  done
  return 1
}

start_tunnel() {
  # Cloudflare 임시 터널: 학교 내부망 서버를 https 공개 주소로 연결 (ENABLE_TUNNEL=0 이면 끔)
  [ "${ENABLE_TUNNEL:-1}" = "1" ] || return 0
  if [ ! -x /root/cloudflared ]; then
    log "cloudflared 내려받는 중"
    if ! download https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 /root/cloudflared; then
      log "cloudflared 를 내려받지 못했어요. 터널 없이 서버만 켜요 (VPN 안에서만 접속 가능)"
      return 0
    fi
    chmod +x /root/cloudflared
  fi
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  rm -f /root/tunnel-url.txt
  date +%s > /root/server-started-at
  nohup /root/cloudflared tunnel --no-autoupdate --url http://localhost:8000 > /root/cloudflared.log 2>&1 &
  (
    url=""
    for _ in $(seq 1 90); do
      url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /root/cloudflared.log | head -1 || true)
      [ -n "$url" ] && break
      sleep 2
    done
    if [ -z "$url" ]; then log "터널 주소를 만들지 못했어요. /root/cloudflared.log 를 확인해 주세요."; exit 0; fi
    echo "$url" > /root/tunnel-url.txt
    # 따라소리(Vercel)에 새 주소 자동 등록. 5분마다 다시 등록해서 한 번 실패해도 복구돼요.
    while true; do
      log "TUNNEL_URL=$url"
      log "$(python3 "$HERE/register.py" "$url" 2>&1 | tail -1)"
      sleep 300
    done
  ) &
}

start_tunnel

if ! command -v ffmpeg >/dev/null 2>&1; then
  log "ffmpeg 설치 중"
  apt-get update -qq && apt-get install -y -qq ffmpeg >/dev/null
fi

log "파이썬 패키지 설치 중"
pip install -q --no-cache-dir -r "$HERE/requirements.txt" || log "파이썬 패키지 설치 실패: 로그를 확인해 주세요"
# 가사 노래용 패키지는 따로 설치: 실패해도 서버는 '라'로 부르며 정상 동작
pip install -q --no-cache-dir pyworld==0.3.4 uroman || log "가사 노래 패키지 설치 실패 (가사 없이 동작)"

# 큰 파일(모델·캐시)은 /root 밖(/opt)에 둬요.
# /root 는 Workspace 를 중지할 때 저장·복원되는데, 모델까지 들어가면 복원하다 디스크가 가득 차서 서버가 못 떠요.
rm -rf /root/seed-vc /root/.cache/huggingface 2>/dev/null || true
if [ ! -d /opt/seed-vc ]; then
  log "Seed-VC 내려받는 중"
  git clone -q https://github.com/Plachtaa/seed-vc /opt/seed-vc
  git -C /opt/seed-vc checkout -q "$SEED_VC_COMMIT"
fi

# 컨테이너 기본 인코딩이 ASCII 라서 한글 가사를 파일에 쓰다 실패했던 문제 방지
export PYTHONUTF8=1 PYTHONIOENCODING=utf-8 LANG=C.UTF-8 LC_ALL=C.UTF-8
export SEED_VC_DIR=/opt/seed-vc
export HF_HOME=/opt/hf-cache
log "디스크 남은 용량: $(df -h /root | tail -1 | awk '{print $4}') (/root), $(df -h /opt | tail -1 | awk '{print $4}') (/opt)"
cd "$HERE"
log "서버 시작 (모델 로딩까지 몇 분 더 걸려요)"
# 서버 메시지도 VESSL 로그 화면에 보이도록 컨테이너 표준 출력으로 보냄
if [ -w /proc/1/fd/1 ]; then
  exec uvicorn server:app --host 0.0.0.0 --port 8000 --timeout-keep-alive 75 > /proc/1/fd/1 2>&1
fi
exec uvicorn server:app --host 0.0.0.0 --port 8000 --timeout-keep-alive 75
