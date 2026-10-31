import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { kvEnabled, kvGet, kvSet } from "@/lib/kv";

export const dynamic = "force-dynamic";

/**
 * GPU 서버(VESSL)가 켜질 때 자기 터널 주소를 등록하는 곳.
 * 서명: HMAC-SHA256(SERVICE_SECRET, `${url}|${ts}`) 를 base64url 로.
 */
export async function POST(req: Request) {
  const secret = process.env.SERVICE_SECRET;
  if (!secret) return NextResponse.json({ error: "SERVICE_SECRET 이 설정되지 않았어요." }, { status: 500 });
  if (!kvEnabled()) return NextResponse.json({ error: "저장소(Redis)가 연결되지 않았어요." }, { status: 500 });

  let body: { url?: string; ts?: number; started?: number; sig?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "잘못된 요청이에요." }, { status: 400 });
  }
  const { url, ts, sig } = body;
  const started = typeof body.started === "number" ? body.started : 0;
  if (typeof url !== "string" || typeof ts !== "number" || typeof sig !== "string") {
    return NextResponse.json({ error: "url, ts, sig 가 필요해요." }, { status: 400 });
  }
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) {
    return NextResponse.json({ error: "https 주소만 등록할 수 있어요." }, { status: 400 });
  }
  if (Math.abs(Date.now() / 1000 - ts) > 300) {
    return NextResponse.json({ error: "요청 시각이 너무 오래됐어요." }, { status: 401 });
  }
  const signed = body.started === undefined ? `${url}|${ts}` : `${url}|${ts}|${started}`;
  const good = createHmac("sha256", secret).update(signed).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(good);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "서명이 올바르지 않아요." }, { status: 401 });
  }

  // 이미 더 늦게 켜진 서버가 등록돼 있으면, 예전 서버의 재등록은 무시
  const current = await kvGet("gpu_url");
  const currentStarted = Number((await kvGet("gpu_started")) ?? 0);
  if (current && current !== url && started < currentStarted) {
    return NextResponse.json({ ok: false, reason: "newer_server_registered", current }, { status: 409 });
  }
  await kvSet("gpu_url", url);
  await kvSet("gpu_started", String(started));
  await kvSet("gpu_url_updated", new Date().toISOString());
  return NextResponse.json({ ok: true, url });
}
