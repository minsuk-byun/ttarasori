import { NextResponse } from "next/server";

/**
 * AI 커버 생성 API 자리 (데모에서는 미구현)
 *
 * 실제 서비스 연결 예시:
 *   1) 클라이언트가 원곡과 목소리 모델 ID, 키 값을 보냄
 *   2) 여기서 GPU 추론 서버(Replicate, RunPod, Modal 등에 올린 RVC/so-vits-svc 모델)에 작업 요청
 *   3) 작업 ID를 돌려주고, 클라이언트는 완료될 때까지 상태를 조회
 *
 * Vercel 함수는 실행 시간·GPU 제약이 있으므로 변환 자체는 외부 서버에서 처리해야 해요.
 */
export async function POST() {
  return NextResponse.json(
    { error: "데모 버전에서는 AI 커버 생성 서버가 연결되어 있지 않아요." },
    { status: 501 },
  );
}
