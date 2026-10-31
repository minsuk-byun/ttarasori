"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/cover", label: "AI 커버 만들기" },
  { href: "/compare", label: "내 노래 비교" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <header className="border-b border-line bg-surface/80 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-[17px] font-bold tracking-tight">
          <Logo />
          따라소리
        </Link>
        <div className="ml-auto flex gap-1 text-[15px]">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-3 py-1.5 transition-colors ${
                path === l.href ? "bg-ink text-white" : "text-muted hover:bg-key hover:text-ink"
              }`}
            >
              {l.label}
            </Link>
          ))}
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
