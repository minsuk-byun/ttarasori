"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { deletePracticeSong, listPracticeSongs, type PracticeSong } from "@/lib/practiceLibrary";

/** AI 커버의 "부를 노래"로 내가 만든 연습곡을 고르는 목록 */
export default function PracticePicker({ onPick }: { onPick: (song: PracticeSong) => void }) {
  const [songs, setSongs] = useState<PracticeSong[] | null>(null);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);

  useEffect(() => {
    listPracticeSongs().then(setSongs);
  }, []);

  useEffect(() => () => {
    if (playing) URL.revokeObjectURL(playing.url);
  }, [playing]);

  if (songs === null) return <p className="text-sm text-muted">불러오는 중</p>;

  if (!songs.length) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-surface p-5 text-sm">
        <p className="text-muted">아직 만든 연습곡이 없어요. 원곡 느낌의 새 연습곡을 만들면 여기에서 바로 고를 수 있어요.</p>
        <Link href="/practice" className="mt-3 inline-block rounded-lg bg-ink px-4 py-2 font-semibold text-white">
          연습곡 만들러 가기
        </Link>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border-l-4 border-guide bg-surface p-4">
      <ul className="divide-y divide-line">
        {songs.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
            <button
              onClick={() =>
                setPlaying((p) => (p?.id === s.id ? null : { id: s.id, url: URL.createObjectURL(s.mix) }))
              }
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-guide-soft text-guide"
              aria-label={playing?.id === s.id ? "미리듣기 멈추기" : "미리듣기"}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                {playing?.id === s.id ? <rect x="2" y="2" width="8" height="8" fill="currentColor" /> : <path d="M2 1 L11 6 L2 11 Z" fill="currentColor" />}
              </svg>
            </button>
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{s.title}</div>
              <div className="text-xs text-muted">{new Date(s.createdAt).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}</div>
            </div>
            <button onClick={() => onPick(s)} className="rounded-lg bg-guide px-3 py-1.5 text-sm font-semibold text-white hover:brightness-110">
              이 곡으로 커버
            </button>
            <button
              onClick={async () => {
                await deletePracticeSong(s.id);
                setSongs((all) => all?.filter((x) => x.id !== s.id) ?? null);
              }}
              className="rounded-lg px-2 py-1.5 text-sm text-muted hover:text-bad"
            >
              삭제
            </button>
          </li>
        ))}
      </ul>
      {playing && <audio src={playing.url} autoPlay onEnded={() => setPlaying(null)} className="hidden" />}
      <Link href="/practice" className="mt-2 inline-block text-sm font-semibold text-guide hover:underline">
        새 연습곡 만들기
      </Link>
    </div>
  );
}
