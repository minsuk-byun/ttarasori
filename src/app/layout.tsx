import type { Metadata } from "next";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "따라소리 – AI 커버와 내 노래 비교",
  description: "내 목소리로 AI 커버를 만들고, 직접 부른 노래와 비교해 어디를 어떻게 연습할지 알려 드려요.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
      </head>
      <body className="min-h-dvh">
        <Nav />
        {children}
        <footer className="mx-auto max-w-6xl px-4 pb-10 pt-16 text-sm text-muted sm:px-6">
          데모 버전이에요. 올린 음원은 브라우저 안에서만 분석되고 서버로 전송되지 않아요.
        </footer>
      </body>
    </html>
  );
}
