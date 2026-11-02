"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 실제 사용 순서대로: 부를 노래 만들기 → 내 목소리 커버 → 불러 보고 비교
const LINKS = [
  { href: "/practice", label: "연습곡 만들기", short: "연습곡" },
  { href: "/cover", label: "AI 커버 만들기", short: "AI 커버" },
  { href: "/compare", label: "내 노래 비교", short: "비교·교정" },
];
// 단계를 마친 뒤 매일 돌아와서 하는 곳
const TRAIN = { href: "/train", label: "오늘의 연습", short: "연습" };


export default function Nav() {
  const path = usePathname();
  return (
    <header className="border-b border-line bg-surface/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
          <Logo />
          따라소리
        </Link>
        <div className="ml-auto flex gap-1 overflow-x-auto text-[15px] [scrollbar-width:none]">
          {LINKS.map((l, i) => {
            // 원곡으로 가이드 만들기는 3단계(비교·교정)에 속한 화면
            const on = path === l.href || (l.href === "/compare" && path === "/original");
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={on ? "page" : undefined}
                className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition-colors sm:px-3 ${
                  on ? "bg-ink text-white" : "text-muted hover:bg-key hover:text-ink"
                }`}
              >
                <span
                  className={`grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold ${
                    on ? "bg-white text-ink" : "bg-key text-muted"
                  }`}
                  aria-hidden
                >
                  {i + 1}
                </span>
                <span className="hidden sm:inline">{l.label}</span>
                <span className="sm:hidden">{l.short}</span>
              </Link>
            );
          })}
          <span className="mx-1 my-2 w-px shrink-0 bg-line" aria-hidden />
          <Link
            href={TRAIN.href}
            aria-current={path === TRAIN.href ? "page" : undefined}
            className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-semibold transition-colors sm:px-3 ${
              path === TRAIN.href ? "bg-good text-white" : "text-good hover:bg-key"
            }`}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M8 1.5 9.9 5.6l4.4.5-3.3 3 .9 4.4L8 11.3 4.1 13.5 5 9.1 1.7 6.1l4.4-.5Z" fill="currentColor" />
            </svg>
            <span className="hidden sm:inline">{TRAIN.label}</span>
            <span className="sm:hidden">{TRAIN.short}</span>
          </Link>
        </div>
      </nav>
    </header>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <path d="M2 14 C6 4, 9 4, 11 11 S16 18, 20 8" fill="none" stroke="#2f4fd8" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M2 16 C6 7, 9 8, 11 13 S16 19, 20 11" fill="none" stroke="#d93d76" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
