"use client";

import { useEffect, useRef, useState } from "react";
import { PianoRoll, scoreColor } from "@/components/Charts";
import { openCapture, scheduleClick, type Capture } from "@/lib/audio/capture.ts";
import { compareFeatures, type Comparison } from "@/lib/audio/compare.ts";
import { decodeToMono } from "@/lib/audio/decode.ts";
import { extractFeatures, type Features } from "@/lib/audio/features.ts";
import type { Phrase, Weak } from "@/lib/progress";

type Phase = { kind: "idle" } | { kind: "listen" } | { kind: "count"; n: number } | { kind: "sing" } | { kind: "scoring" } | { kind: "error"; msg: string };

function slice(f: Features, t0: number, t1: number): Features {
  const i0 = Math.max(0, Math.round(t0 / f.hopSec));
  const i1 = Math.min(f.f0.length, Math.round(t1 / f.hopSec));
  return { hopSec: f.hopSec, f0: f.f0.slice(i0, i1), db: f.db.slice(i0, i1), duration: (i1 - i0) * f.hopSec };
}

export interface PhraseScore {
  score: number;
  seconds: number;
  weak: Partial<Weak>;
  meanAbsCents: number;
  note: string;
}

/** 다시 연습할 구절: 가이드 듣기 → 3, 2, 1 → 혼자 불러 보기 → 채점 */
export default function PhraseRunner({ phrase, onResult }: { phrase: Phrase; onResult: (r: PhraseScore) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [ref, setRef] = useState<Features | null>(null);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [last, setLast] = useState<PhraseScore | null>(null);
  const cap = useRef<Capture | null>(null);
  const raf = useRef(0);
  const PRE = 0.3;

  useEffect(() => {
    let alive = true;
    decodeToMono(phrase.clip)
      .then((x) => extractFeatures(x, 16000))
      .then((f) => alive && setRef(f))
      .catch(() => alive && setPhase({ kind: "error", msg: "구절 음원을 열지 못했어요." }));
    return () => {
      alive = false;
      cancelAnimationFrame(raf.current);
      cap.current?.close();
    };
    // 기록을 다시 불러와도 같은 구절이면 결과를 유지
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phrase.id]);

  async function start() {
    if (!ref) return;
    let c: Capture;
    try {
      c = await openCapture();
    } catch {
      setPhase({ kind: "error", msg: "마이크를 쓸 수 없어요. 주소창의 마이크 권한을 허용한 뒤 다시 눌러 주세요." });
      return;
    }
    cap.current = c;
    const ctx = c.ctx;
    const buf = await ctx.decodeAudioData(await phrase.clip.arrayBuffer());
    const t0 = ctx.currentTime + 0.2;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(t0);
    const listenEnd = t0 + buf.duration;
    const gap = 0.6;
    const countStart = listenEnd + 0.3;
    for (let k = 0; k < 3; k++) scheduleClick(ctx, countStart + k * gap, k === 0);
    const singStart = countStart + 3 * gap;
    const singEnd = singStart + phrase.segDur + 0.8;

    const tick = () => {
      const now = ctx.currentTime;
      if (now < listenEnd) setPhase({ kind: "listen" });
      else if (now < singStart) setPhase({ kind: "count", n: Math.max(1, 3 - Math.floor((now - countStart) / gap)) });
      else if (now < singEnd) setPhase({ kind: "sing" });
      else return;
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    const x = await c.take(singStart - PRE, singEnd);
    cancelAnimationFrame(raf.current);
    c.close();
    cap.current = null;
    setPhase({ kind: "scoring" });
    try {
      const uf = await extractFeatures(x, 16000);
      const r = compareFeatures(slice(ref, phrase.clipStart - PRE, phrase.clipStart + phrase.segDur + 0.5), uf, {
        minLagSec: -0.4,
        maxLagSec: 0.9,
      });
      const a = PRE;
      const b = PRE + phrase.segDur;
      const ins = r.segments.filter((s) => s.end > a && s.start < b);
      const voiced = r.userMidi.some((v) => v != null);
      let score = 0;
      let note = "소리가 거의 들리지 않았어요. 마이크 가까이에서 다시 불러 보세요.";
      const weak: Partial<Weak> = {};
      if (ins.length && voiced) {
        const len = ins.reduce((s, g) => s + (g.end - g.start), 0) || 1;
        score = Math.round(ins.reduce((s, g) => s + g.score * (g.end - g.start), 0) / len);
        const issues = ins.flatMap((g) => g.issues).filter((i) => i.kind !== "good");
        for (const is of issues) {
          const k = is.kind === "dropout" ? "missing" : is.kind;
          if (k in { flat: 1, sharp: 1, late: 1, early: 1, missing: 1, unstable: 1 }) weak[k as keyof Weak] = (weak[k as keyof Weak] ?? 0) + 1;
        }
        const top = issues.sort((p, q) => q.severity - p.severity)[0];
        note = top ? `${top.title} — ${top.tip}` : "잘 불렀어요! 가이드와 거의 같아요.";
      }
      setCmp(r);
      const res = { score, seconds: singEnd - t0, weak, meanAbsCents: r.overall.meanAbsCents, note };
      setLast(res);
      setPhase({ kind: "idle" });
      onResult(res);
    } catch {
      setPhase({ kind: "error", msg: "채점하지 못했어요. 다시 해 주세요." });
    }
  }

  async function listenOnly() {
    const a = new Audio(URL.createObjectURL(phrase.clip));
    a.onended = () => URL.revokeObjectURL(a.src);
    void a.play();
  }

  const busy = phase.kind !== "idle" && phase.kind !== "error";

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={start} disabled={busy || !ref} className="rounded-xl bg-mine px-5 py-2.5 font-semibold text-white hover:brightness-110 disabled:opacity-40">
          {last ? "다시 하기" : "시작"}
        </button>
        <button onClick={listenOnly} disabled={busy} className="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm font-semibold hover:border-ink disabled:opacity-40">
          가이드만 듣기
        </button>
        <span className="text-sm font-semibold" role="status">
          {phase.kind === "listen" && <span className="text-guide">가이드를 들어 보세요…</span>}
          {phase.kind === "count" && <span className="text-2xl tabular-nums text-mine">{phase.n}</span>}
          {phase.kind === "sing" && (
            <span className="flex items-center gap-2 text-mine">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-mine" aria-hidden /> 지금 불러 보세요
            </span>
          )}
          {phase.kind === "scoring" && <span className="text-muted">채점 중</span>}
          {phase.kind === "idle" && !last && <span className="text-muted">가이드를 듣고, 박자 3번 뒤에 혼자 불러요.</span>}
        </span>
      </div>
      {phase.kind === "error" && <p className="mt-2 text-sm text-bad">{phase.msg}</p>}
      {cmp && (
        <div className="mt-3">
          <PianoRoll refMidi={cmp.refMidi} userMidi={cmp.userMidi} hopSec={cmp.hopSec} height={170} />
        </div>
      )}
      {last && (
        <div className="mt-3 flex flex-wrap items-baseline gap-3 rounded-xl bg-paper p-4">
          <span className="text-3xl font-bold tabular-nums" style={{ color: scoreColor(last.score) }}>
            {last.score}점
          </span>
          <span className="text-[15px]">{last.note}</span>
        </div>
      )}
    </div>
  );
}
