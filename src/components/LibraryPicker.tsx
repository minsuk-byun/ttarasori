"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { KIND_LABEL, deleteFromLibrary, listLibrary, type LibraryItem, type LibraryKind } from "@/lib/practiceLibrary";

interface Props {
  kinds: LibraryKind[];
  pickLabel: string;
  onPick: (item: LibraryItem) => void;
  onClose?: () => void;
  tone?: "guide" | "mine";
  empty?: React.ReactNode;
}

/** 이 브라우저에 저장된 음원(연습곡·AI 커버·내 녹음) 고르기 */
export default function LibraryPicker({ kinds, pickLabel, onPick, onClose, tone = "guide", empty }: Props) {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  const key = kinds.join(",");

  useEffect(() => {
    listLibrary(key.split(",") as LibraryKind[]).then(setItems);
  }, [key]);

  useEffect(
    () => () => {
      if (playing) URL.revokeObjectURL(playing.url);
    },
    [playing],
  );

  const accent = tone === "guide" ? "border-guide" : "border-mine";
  const btn = tone === "guide" ? "bg-guide" : "bg-mine";
  const soft = tone === "guide" ? "bg-guide-soft text-guide" : "bg-mine-soft text-mine";

  return (
    <div className={`rounded-2xl border-l-4 ${accent} bg-surface p-4`}>
      <div className="flex items-center">
        <h3 className="font-semibold">저장된 음원</h3>
        {onClose && (
          <button onClick={onClose} className="ml-auto text-sm text-muted hover:text-ink">
            닫기
          </button>
        )}
      </div>
      {items === null ? (
        <p className="mt-2 text-sm text-muted">불러오는 중</p>
      ) : !items.length ? (
        <div className="mt-2 text-sm text-muted">{empty ?? "이 브라우저에 저장된 음원이 아직 없어요."}</div>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {items.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-3 py-3">
              <button
                onClick={() => setPlaying((p) => (p?.id === s.id ? null : { id: s.id, url: URL.createObjectURL(s.mix) }))}
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-full ${soft}`}
                aria-label={playing?.id === s.id ? "미리듣기 멈추기" : "미리듣기"}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                  {playing?.id === s.id ? (
                    <rect x="2" y="2" width="8" height="8" fill="currentColor" />
                  ) : (
                    <path d="M2 1 L11 6 L2 11 Z" fill="currentColor" />
                  )}
                </svg>
              </button>
              <div className="min-w-0 flex-1">
                <div className="truncate font-semibold">{s.title}</div>
                <div className="text-xs text-muted">
                  {kinds.length > 1 && <span className="mr-1.5 font-semibold">{KIND_LABEL[s.kind]}</span>}
                  {new Date(s.createdAt).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" })}
                </div>
              </div>
              <button onClick={() => onPick(s)} className={`rounded-lg ${btn} px-3 py-1.5 text-sm font-semibold text-white hover:brightness-110`}>
                {pickLabel}
              </button>
              <button
                onClick={async () => {
                  await deleteFromLibrary(s.id);
                  setItems((all) => all?.filter((x) => x.id !== s.id) ?? null);
                }}
                className="rounded-lg px-2 py-1.5 text-sm text-muted hover:text-bad"
              >
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
      {playing && <audio src={playing.url} autoPlay onEnded={() => setPlaying(null)} className="hidden" />}
    </div>
  );
}

export function PracticeEmpty() {
  return (
    <>
      아직 만든 연습곡이 없어요. 원곡 느낌의 새 연습곡을 만들면 여기에서 바로 고를 수 있어요.
      <Link href="/practice" className="mt-3 block w-fit rounded-lg bg-ink px-4 py-2 font-semibold text-white">
        연습곡 만들러 가기
      </Link>
    </>
  );
}
