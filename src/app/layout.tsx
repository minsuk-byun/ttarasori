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
          데모 버전이에요. 비교 분석은 브라우저 안에서만 이뤄지고, AI 커버를 만들 때만 음원이 GPU 서버로 전송돼요. 서버의 파일은 2시간 뒤 자동으로 지워져요.
        </footer>
      </body>
    </html>
  );
}
