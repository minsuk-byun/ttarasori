@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [따라소리] Yonsei VPN이 켜져 있어야 GPU 서버에 연결돼요.
if not exist node_modules (
  echo [따라소리] 처음 실행이라 패키지를 설치해요. 몇 분 걸려요...
  call npm install || (echo npm install 실패. Node.js가 설치되어 있는지 확인해 주세요. & pause & exit /b 1)
)
start "" http://localhost:3000/cover
call npm run dev
