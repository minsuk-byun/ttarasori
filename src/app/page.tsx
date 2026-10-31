import Link from "next/link";
import HeroRoll from "@/components/HeroRoll";

const STEPS = [
  {
    title: "목소리 등록",
    body: "1분 정도 부른 노래나 읽은 녹음을 올리면 내 음색을 배운 목소리 모델이 만들어져요.",
  },
  {
    title: "AI 커버 만들기",
    body: "부르고 싶은 노래를 올리면 보컬을 분리하고, 내 목소리로 바꿔 다시 합쳐 드려요.",
  },
  {
    title: "직접 부르고 비교",
    body: "같은 노래를 직접 불러 올리면 AI 커버와 음정 곡선을 겹쳐 보고, 구간별로 고칠 점을 알려 드려요.",
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
            <Link href="/compare" className="rounded-xl bg-ink px-6 py-3.5 font-semibold text-white hover:bg-ink/90">
              내 노래 비교해 보기
            </Link>
            <Link href="/cover" className="rounded-xl border border-ink/20 px-6 py-3.5 font-semibold hover:border-ink">
              AI 커버 만들기
            </Link>
          </div>
        </div>
        <HeroRoll />
      </section>

      <section className="border-t border-line bg-surface">
        <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-bold tracking-tight">이렇게 써요</h2>
          <ol className="mt-8 grid gap-8 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title} className="border-t-2 border-ink pt-4">
                <span className="text-sm font-semibold text-muted">{i + 1}단계</span>
                <h3 className="mt-1 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </main>
  );
}
