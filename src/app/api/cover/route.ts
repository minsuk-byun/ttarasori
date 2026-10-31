import { NextResponse } from "next/server";

/** 커버 생성은 브라우저 → GPU 서버로 직접 요청해요. 토큰은 /api/cover/token 에서 받아요. */
export async function POST() {
  return NextResponse.json({ error: "/api/cover/token 으로 토큰을 받아 GPU 서버에 직접 요청해 주세요." }, { status: 410 });
}
