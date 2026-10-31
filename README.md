# 따라소리 (데모)

내 목소리로 AI 커버를 만들고, 직접 부른 노래와 비교해 어느 구간을 어떻게 연습하면 좋을지 알려 주는 서비스의 데모예요.

## 기능

| 페이지 | 내용 | 데모 상태 |
| --- | --- | --- |
| `/cover` AI 커버 만들기 | 목소리 등록 → 노래 업로드·키 조절 → 커버 생성 | 화면 흐름만 구현 (변환 서버 미연결) |
| `/compare` 내 노래 비교 | AI 커버와 내 노래(업로드·마이크 녹음)를 분석해 음정 곡선, 음정 차이 그래프, 구간별 점수와 연습 팁 제공 | 실제 동작 (브라우저에서 분석) |

비교 분석이 하는 일 (`src/lib/audio`):

- **음정 추출**: YIN 알고리즘으로 20ms마다 음정(Hz)과 음량(dB) 측정
- **시간 맞추기**: 음량 곡선 상호상관으로 녹음 시작 시점 차이 자동 보정
- **옥타브·키 보정**: 남녀 옥타브 차이, 다른 키로 부른 경우 자동 감지 후 보정
- **프레이즈 분할**: AI 커버의 소리 나는 구간을 프레이즈로 나눔
- **구간별 평가**: 음 높낮이, 흔들림, 끊김, 박자, 강약, 비브라토 → 점수와 연습 팁

반주가 섞인 음원보다 **보컬만 있는 음원**에서 가장 정확해요.

## 로컬 실행

```bash
npm install
npm run dev
```

http://localhost:3000 에서 확인하고, 비교 페이지의 "샘플 음원으로 체험하기"로 바로 테스트할 수 있어요.

## Vercel 배포

1. 이 저장소를 GitHub에 올립니다.
2. https://vercel.com/new 에서 GitHub 저장소를 Import 합니다.
3. Framework Preset이 Next.js로 잡혀 있는지 확인하고 Deploy 를 누릅니다. 환경 변수는 필요 없어요.

이후 `main` 브랜치에 push 할 때마다 자동으로 다시 배포돼요.

## 실제 AI 커버 연결하려면

`src/app/api/cover/route.ts`에 연결 지점을 만들어 두었어요. 음성 변환(RVC, so-vits-svc 등)은 GPU가 필요하므로 Replicate·RunPod·Modal 같은 외부 GPU 서버에서 돌리고, 이 API는 작업 요청과 결과 조회만 맡기면 돼요. `src/app/cover/page.tsx`의 `useFakeJob`을 실제 API 호출로 바꾸면 됩니다.

## 내 PC에서 GPU 서버와 함께 쓰기 (Yonsei VPN)

VESSL Workspace의 포트는 학교 내부망 주소라서 Yonsei VPN을 켠 PC에서만 접속돼요.

1. Yonsei VPN을 켜요.
2. 프로젝트 폴더에 `.env.local` 파일을 만들어요.
   ```
   GPU_SERVER_URL=http://165.132.46.94:<api 포트>
   SERVICE_SECRET=<GPU 서버와 같은 값>
   ```
   api 포트는 VESSL Workspace 메타데이터의 포트 목록(api, 8000)에서 확인해요. Workspace를 다시 시작하면 바뀌어요.
3. `start-local.bat`을 더블클릭하거나 `npm install` 후 `npm run dev`를 실행하고 http://localhost:3000 을 열어요.
