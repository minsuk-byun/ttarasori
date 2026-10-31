import { NextResponse } from "next/server";
import { inferStyle } from "@/lib/style";

export const dynamic = "force-dynamic";

const decode = (t: string) =>
  t.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/**
 * 유튜브 공식 Data API v3 로 곡 검색 (음원은 받지 않고 정보만 사용).
 * 환경 변수: YOUTUBE_API_KEY
 */
export async function GET(req: Request) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return NextResponse.json({ error: "no_key" }, { status: 503 });
  const q = new URL(req.url).searchParams.get("q")?.trim();
  if (!q) return NextResponse.json({ items: [] });

  const search = new URL("https://www.googleapis.com/youtube/v3/search");
  search.search = new URLSearchParams({
    part: "snippet",
    type: "video",
    videoCategoryId: "10", // 음악
    maxResults: "6",
    regionCode: "KR",
    q,
    key,
  }).toString();
  const sr = await fetch(search, { cache: "no-store" });
  if (!sr.ok) return NextResponse.json({ error: "search_failed", status: sr.status }, { status: 502 });
  const sj = (await sr.json()) as { items?: { id: { videoId: string } }[] };
  const ids = (sj.items ?? []).map((i) => i.id.videoId).filter(Boolean);
  if (!ids.length) return NextResponse.json({ items: [] });

  const videos = new URL("https://www.googleapis.com/youtube/v3/videos");
  videos.search = new URLSearchParams({ part: "snippet", id: ids.join(","), key }).toString();
  const vr = await fetch(videos, { cache: "no-store" });
  if (!vr.ok) return NextResponse.json({ error: "search_failed", status: vr.status }, { status: 502 });
  const vj = (await vr.json()) as {
    items?: {
      id: string;
      snippet: {
        title: string;
        channelTitle: string;
        description?: string;
        tags?: string[];
        thumbnails?: { medium?: { url: string } };
      };
    }[];
  };

  const items = (vj.items ?? []).map((v) => {
    const text = [v.snippet.title, v.snippet.description ?? "", (v.snippet.tags ?? []).join(" ")].join(" ");
    return {
      id: v.id,
      title: decode(v.snippet.title),
      channel: decode(v.snippet.channelTitle),
      thumbnail: v.snippet.thumbnails?.medium?.url ?? null,
      style: inferStyle(text),
    };
  });
  return NextResponse.json({ items });
}
