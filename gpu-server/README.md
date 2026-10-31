# 따라소리 GPU 서버

원곡에서 보컬을 분리(Demucs)하고, 등록한 목소리 10~30초를 기준으로 보컬을 바꾼 뒤(Seed-VC, 학습 없이 바로 변환), 반주와 다시 합치는 서버예요. VESSL Service로 띄워요.

## VESSL Service 설정

| 항목 | 값 |
| --- | --- |
| 이미지 | `quay.io/vessl-ai/torch:2.3.1-cuda12.1-r5` (PyTorch + CUDA 포함) |
| 리소스 | GPU 1장짜리 프리셋 (VRAM 16GB 이상 권장) |
| 코드 | 이 저장소 (`git://github.com/minsuk-byun/ttarasori`) → `/root/ttarasori` |
| 실행 명령 | `bash /root/ttarasori/gpu-server/setup.sh` |
| 포트 | `8000` (HTTP) |
| 환경 변수 | `SERVICE_SECRET`: 임의의 긴 문자열 (Vercel에도 같은 값) |
|  | `ALLOWED_ORIGINS`: `https://ttarasori.vercel.app` |
| 오토스케일 | 최소 1, 최대 1 |

처음 시작할 때 패키지 설치와 모델 다운로드(약 2~3GB)로 5~10분 정도 걸려요. `/health`가 `{"ok": true, "model_loaded": true}`를 돌려주면 준비된 거예요.

## Vercel 환경 변수

| 이름 | 값 |
| --- | --- |
| `GPU_SERVER_URL` | VESSL Service 엔드포인트 주소 |
| `SERVICE_SECRET` | GPU 서버와 같은 값 |

설정 후 Redeploy 하면 커버 페이지가 실제 GPU 서버를 써요. 환경 변수가 없으면 데모 모드로 동작해요.

## 주의

- 서비스가 켜져 있는 동안 GPU 시간이 계속 차감돼요. 안 쓸 때는 VESSL에서 서비스를 멈춰 주세요.
- 작업 파일은 2시간 뒤 자동 삭제되고, 서버를 다시 시작하면 진행 중이던 작업은 사라져요.
- Seed-VC는 GPL-3.0 라이선스예요. 정식 서비스로 낼 때는 라이선스 조건을 확인해 주세요.

## 터널 주소 자동 등록

Workspace가 켜지면 Cloudflare 임시 터널 주소(https://○○○.trycloudflare.com)가 생기고, `register.py`가 이 주소를 따라소리의 `/api/gpu/register`에 서명과 함께 등록해요(5분마다 재등록). 따라소리는 Upstash Redis에 저장된 주소를 우선 쓰므로, 재시작해도 Vercel 설정을 바꿀 필요가 없어요.

필요한 것: Vercel 프로젝트에 Upstash Redis 연결(Storage 탭), `SERVICE_SECRET` 환경 변수.
