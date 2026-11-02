import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** 붙여 넣은 유튜브 링크의 제목·채널 (공개 oEmbed, API 키 필요 없음) */
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[\w-]{11}$/.test(id)) return NextResponse.json({ error: "bad_id" }, { status: 400 });
  const u = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
  try {
    const r = await fetch(u, { cache: "no-store" });
    if (!r.ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const j = (await r.json()) as { title?: string; author_name?: string; thumbnail_url?: string };
    return NextResponse.json({ id, title: j.title ?? "", channel: j.author_name ?? "", thumbnail: j.thumbnail_url ?? null });
  } catch {
    return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  }
}
