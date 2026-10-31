import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { kvGet } from "@/lib/kv";

export const dynamic = "force-dynamic";

/**
 * 브라우저가 GPU 서버(VESSL)에 직접 업로드할 수 있도록 짧은 수명의 토큰을 발급.
 * 큰 음원 파일이 Vercel 함수를 거치지 않게 하려는 구조예요.
 *
 * 필요한 환경 변수 (Vercel → Settings → Environment Variables)
 *   GPU_SERVER_URL  (선택) GPU 서버 주소. GPU 서버가 /api/gpu/register 로 등록한 주소가 있으면 그걸 먼저 써요.
 *   SERVICE_SECRET  GPU 서버와 같은 값의 비밀키
 */
export async function GET() {
  const registered = await kvGet("gpu_url");
  const url = (registered || process.env.GPU_SERVER_URL)?.replace(/\/+$/, "");
  const secret = process.env.SERVICE_SECRET;
  if (!url || !secret) return NextResponse.json({ enabled: false });

  const exp = String(Math.floor(Date.now() / 1000) + 2 * 60 * 60);
  const sig = createHmac("sha256", secret).update(exp).digest("base64url");
  return NextResponse.json({ enabled: true, url, token: `${exp}.${sig}` });
}
