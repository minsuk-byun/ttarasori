import Link from "next/link";
import HeroRoll from "@/components/HeroRoll";

const STEPS = [
  {
    href: "/practice",
    title: "연습곡 만들기",
    body: "유튜브에서 원곡을 찾아 느낌만 고르면, 저작권 걱정 없는 새 연습곡을 가사와 반주까지 만들어 드려요.",
    cta: "연습곡 만들기",
  },
  {
    href: "/cover",
    title: "AI 커버 만들기",
    body: "짧게 따라 불러 목소리를 등록하면, 연습곡이나 내가 올린 노래를 내 목소리로 불러 드려요.",
    cta: "AI 커버 만들기",
  },
  {
    href: "/compare",
    title: "불러 보고 비교·교정",
    body: "직접 부른 노래를 AI 커버와 겹쳐 보고, 글자별로 틀린 곳과 구간 반복 연습, 음정만 고친 내 목소리 교정본까지 받아요.",
    cta: "내 노래 비교하기",
  },
];

export default function Home() {
  return (
    <main>
      <section className="mx-auto grid max-w-6xl gap-10 px-4 pb-16 pt-14 sm:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center lg:pt-20">
        <div>
          <h1 className="text-[40px] font-bold leading-[1.15] tracking-tight sm:text-5xl">
            AI가 부른 내 노래와
            <br />
            직접 부른 내 노래,
            <br />
            어디가 다를까요?
          </h1>
          <p className="mt-5 max-w-md text-lg leading-relaxed text-muted">
            내 목소리로 만든 AI 커버를 가이드 삼아, 음이 낮아지는 곳과 박자가 밀리는 곳을 그래프로 짚어 드려요.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/practice" className="rounded-xl bg-ink px-6 py-3.5 font-semibold text-white hover:bg-ink/90">
              1단계부터 시작하기
            </Link>
            <Link href="/compare" className="rounded-xl border border-ink/20 px-6 py-3.5 font-semibold hover:border-ink">
              바로 비교해 보기
            </Link>
          </div>
        </div>
        <HeroRoll />
      </section>

      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight">이렇게 써요</h2>
          <p className="mt-2 text-muted">순서대로 하면 가장 편하지만, 이미 음원이 있으면 아무 단계에서나 시작해도 돼요.</p>
          <ol className="mt-8 grid gap-8 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex flex-col border-t-2 border-ink pt-4">
                <span className="text-sm font-semibold text-muted">{i + 1}단계</span>
                <h3 className="mt-1 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 flex-1 leading-relaxed text-muted">{s.body}</p>
                <Link href={s.href} className="mt-4 w-fit font-semibold text-guide underline-offset-4 hover:underline">
                  {s.cta} →
                </Link>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </main>
  );
}
