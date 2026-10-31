"use client";

import { useMemo } from "react";
import { PianoRoll } from "./Charts";
import { sampleContour } from "@/lib/audio/synth.ts";

/** 홈 화면: 샘플 멜로디의 두 음정 곡선 미리보기 */
export default function HeroRoll() {
  const { guide, mine } = useMemo(() => ({ guide: sampleContour("guide"), mine: sampleContour("mine") }), []);
  return (
    <figure className="rounded-2xl bg-surface p-4 shadow-[0_1px_0_var(--color-line),0_20px_40px_-24px_rgba(27,30,60,0.25)] sm:p-5">
      <PianoRoll refMidi={guide} userMidi={mine} hopSec={0.02} range={[3.6, 16.5]} height={300} animate />
      <figcaption className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
        <Callout color="var(--color-guide)" title="AI 커버" body="내 목소리로 만든 가이드" />
        <Callout color="var(--color-mine)" title="내 노래" body="직접 부른 녹음" />
        <Callout color="var(--color-bad)" title="0:05 구간" body="평균 46센트 낮게 불렀어요" />
      </figcaption>
    </figure>
  );
}

function Callout({ color, title, body }: { color: string; title: string; body: string }) {
  return (
    <div className="flex gap-2.5">
      <span className="mt-1 h-3 w-1 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
      <div>
        <div className="font-semibold">{title}</div>
        <div className="text-muted">{body}</div>
      </div>
    </div>
  );
}
