import { NextResponse } from "next/server";
import { kvEnabled, kvGet, kvSet } from "@/lib/kv";

export const dynamic = "force-dynamic";

/**
 * 주간 챌린지 랭킹
 * GET  ?week=2026-W45            → 점수 순위, 향상 순위
 * POST {week, id, name, score}   → 내 기록 반영 (최고 점수·첫 점수 보관)
 * 개인 정보는 받지 않고, 브라우저가 만든 임의 기기 ID와 닉네임만 저장해요.
 */
interface Entry {
  name: string;
  best: number;
  first: number;
  plays: number;
  at: number;
}
type Board = Record<string, Entry>;

const WEEK = /^\d{4}-W\d{2}$/;
const ID = /^[A-Za-z0-9-]{8,40}$/;

function currentWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const wk = 1 + Math.round(((t.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

async function load(week: string): Promise<Board> {
  const raw = await kvGet(`challenge:${week}`);
  try {
    return raw ? (JSON.parse(raw) as Board) : {};
  } catch {
    return {};
  }
}

function view(board: Board, me?: string) {
  const rows = Object.entries(board).map(([id, e]) => ({ id, ...e, gain: e.best - e.first }));
  const top = [...rows].sort((a, b) => b.best - a.best || a.at - b.at);
  const improved = rows.filter((r) => r.plays >= 2 && r.gain > 0).sort((a, b) => b.gain - a.gain || b.best - a.best);
  const strip = (r: (typeof rows)[number], i: number) => ({ rank: i + 1, name: r.name, best: r.best, gain: r.gain, plays: r.plays, me: r.id === me });
  const myRank = me ? top.findIndex((r) => r.id === me) : -1;
  return {
    players: rows.length,
    top: top.slice(0, 10).map(strip),
    improved: improved.slice(0, 5).map(strip),
    me: myRank >= 0 ? strip(top[myRank], myRank) : null,
  };
}

export async function GET(req: Request) {
  if (!kvEnabled()) return NextResponse.json({ error: "no_store" }, { status: 503 });
  const u = new URL(req.url);
  const week = u.searchParams.get("week") ?? currentWeek();
  if (!WEEK.test(week)) return NextResponse.json({ error: "bad_week" }, { status: 400 });
  const me = u.searchParams.get("me") ?? undefined;
  return NextResponse.json({ week, ...view(await load(week), me && ID.test(me) ? me : undefined) });
}

export async function POST(req: Request) {
  if (!kvEnabled()) return NextResponse.json({ error: "no_store" }, { status: 503 });
  let body: { week?: string; id?: string; name?: string; score?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_body" }, { status: 400 });
  }
  const week = String(body.week ?? "");
  const id = String(body.id ?? "");
  const name = String(body.name ?? "")
    .replace(/[<>\u0000-\u001f]/g, "")
    .trim()
    .slice(0, 12);
  const score = Math.round(Number(body.score));
  // 이번 주 곡만 받아요 (주가 바뀌는 순간을 위해 앞뒤 한 주도 허용)
  const now = currentWeek();
  const last = currentWeek(new Date(Date.now() - 7 * 86400000));
  // 서버는 세계 표준시라, 한국 월요일 새벽에는 브라우저가 한 주 앞서 있을 수 있어요
  const next = currentWeek(new Date(Date.now() + 7 * 86400000));
  if (!WEEK.test(week) || ![now, last, next].includes(week)) return NextResponse.json({ error: "bad_week" }, { status: 400 });
  if (!ID.test(id) || !name || !Number.isFinite(score) || score < 0 || score > 100) return NextResponse.json({ error: "bad_input" }, { status: 400 });

  const board = await load(week);
  const prev = board[id];
  if (prev && Date.now() - prev.at < 15_000) return NextResponse.json({ error: "too_fast" }, { status: 429 });
  if (!prev && Object.keys(board).length >= 2000) return NextResponse.json({ error: "full" }, { status: 503 });
  board[id] = prev
    ? { name, best: Math.max(prev.best, score), first: prev.first, plays: prev.plays + 1, at: Date.now() }
    : { name, best: score, first: score, plays: 1, at: Date.now() };
  await kvSet(`challenge:${week}`, JSON.stringify(board));
  return NextResponse.json({ week, ...view(board, id) });
}
