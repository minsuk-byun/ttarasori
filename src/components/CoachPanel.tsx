"use client";

import { useMemo, useState } from "react";
import { noteName } from "@/components/Charts";
import type { Coach, CoachItem, CoachKind } from "@/lib/audio/coach.ts";
import { splitLines, type NoteInfo } from "@/lib/audio/notes.ts";
import { createPronounceJob, getGpuConfig, getJob, getPronounceResult, type Transcript } from "@/lib/gpu";
import { alignSyllables, hangulOnly, type SylResult } from "@/lib/hangul";
import type { Player } from "@/lib/usePlayer";

interface Props {
  coach: Coach;
  notes: NoteInfo[];
  hasLyrics: boolean;
  player: Player;
  /** 발음 진단에 보낼 음원 */
  guideBlob: Blob;
  mineBlob: Blob;
}

type Tab = CoachKind | "pron";
const TAB_LABEL: Record<Tab, string> = { breath: "호흡·프레이징", dynamics: "강약·표현", voice: "발성", pron: "발음" };

interface PronSyl extends SylResult {
  t0: number;
  t1: number;
}
type PronState =
  | { kind: "idle" }
  | { kind: "working"; step: string; p: number }
  | { kind: "done"; syl: PronSyl[]; heardText: string; source: "lyrics" | "guide" }
  | { kind: "error"; msg: string };

const STATUS_COLOR: Record<string, string> = { ok: "var(--color-good)", jong: "#9a6210", vowel: "#9a6210", cho: "#9a6210", other: "var(--color-bad)", missing: "var(--color-bad)" };

export default function CoachPanel({ coach, notes, hasLyrics, player, guideBlob, mineBlob }: Props) {
  const [tab, setTab] = useState<Tab>("breath");
  const [pron, setPron] = useState<PronState>({ kind: "idle" });
  const lines = useMemo(() => splitLines(notes, hasLyrics ? 12 : 16, 0.22), [notes, hasLyrics]);
  const pronByNote = pron.kind === "done" && pron.source === "lyrics" ? pron.syl : null;
  const counts = (k: CoachKind) => coach.items.filter((i) => i.kind === k).length;

  async function runPron() {
    try {
      setPron({ kind: "working", step: "GPU 서버 연결 중", p: 0.02 });
      const cfg = await getGpuConfig();
      if (!cfg.enabled) throw new Error("GPU 서버가 꺼져 있어서 지금은 발음 진단을 할 수 없어요.");
      const lyricSyls = hasLyrics ? notes.filter((n) => /[가-힣]/.test(n.syllable)) : [];
      const useLyrics = lyricSyls.length >= 4;
      const id = await createPronounceJob(cfg, mineBlob, useLyrics ? null : guideBlob, (p) =>
        setPron({ kind: "working", step: "녹음 올리는 중", p: 0.02 + p * 0.2 }),
      );
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const s = await getJob(cfg, id);
        if (s.status === "error") throw new Error(s.error ?? "발음 진단을 하지 못했어요.");
        if (s.status === "done") break;
        setPron({ kind: "working", step: s.status === "queued" ? "앞선 작업을 기다리는 중" : s.step, p: 0.25 + s.progress * 0.7 });
      }
      const res = await getPronounceResult(cfg, id);
      // 기대 글자와 위치: 연습곡이면 가사 글자, 아니면 가이드를 알아들은 글자
      let expected: { s: string; t0: number; t1: number }[];
      if (useLyrics) expected = lyricSyls.map((n) => ({ s: n.syllable, t0: n.start, t1: n.start + n.dur }));
      else expected = sylsFromTranscript(res.guide);
      if (expected.length < 4) throw new Error("가이드에서 가사를 충분히 알아듣지 못했어요. 가사가 있는 연습곡으로 해 보세요.");
      const heard = hangulOnly(dedupeWords(res.mine.text));
      const syl = alignSyllables(
        expected.map((e) => e.s),
        heard,
      ).map((r, i) => ({ ...r, t0: expected[i].t0, t1: expected[i].t1 }));
      setPron({ kind: "done", syl, heardText: res.mine.text, source: useLyrics ? "lyrics" : "guide" });
    } catch (e) {
      setPron({ kind: "error", msg: e instanceof Error ? e.message : "발음 진단을 하지 못했어요." });
    }
  }

  // 가사지에서 글자별 발음 결과 찾기 (가사 글자 순서대로)
  const pronForNote = useMemo(() => {
    if (!pronByNote) return null;
    const map = new Map<number, PronSyl>();
    let q = 0;
    notes.forEach((n, k) => {
      if (/[가-힣]/.test(n.syllable) && q < pronByNote.length) map.set(k, pronByNote[q++]);
    });
    return map;
  }, [pronByNote, notes]);

  const items = tab === "pron" ? [] : coach.items.filter((i) => i.kind === tab);

  return (
    <section className="rounded-2xl bg-surface p-4 sm:p-6">
      <h2 className="text-xl font-semibold">더 잘 부르기 코칭</h2>
      <p className="mt-1 text-sm text-muted">
        음정·박자 너머로 숨, 강약, 발성, 발음을 봐요. 가이드가 내 목소리라서 음색이 아니라 <b className="text-ink">부르는 방법</b>의 차이만 짚어요.
      </p>

      {/* 부르는 법 가사지 */}
      <div className="mt-5 rounded-xl bg-paper p-4">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h3 className="font-semibold">부르는 법 {hasLyrics ? "가사지" : "악보"}</h3>
          <span className="flex flex-wrap gap-x-3 text-xs text-muted">
            <span>
              <b className="text-guide">∨</b> 숨 쉬기
            </span>
            <span>
              <b className="text-mine underline decoration-2 underline-offset-4">굵게</b> 힘주기
            </span>
            <span>~ 비브라토</span>
            <span>〰 숨 섞어 줄이기</span>
            {pronForNote && <span className="text-bad">밑줄 색: 발음</span>}
          </span>
        </div>
        <div className="mt-3 space-y-2">
          {lines.map((line, li) => (
            <p key={li} className={`flex flex-wrap items-end gap-x-0.5 gap-y-2 ${hasLyrics ? "text-xl" : "text-sm"} leading-none`}>
              {line.map((k) => {
                const m = coach.marks[k];
                const pr = pronForNote?.get(k);
                return (
                  <span key={k} className="inline-flex items-end">
                    <button
                      onClick={() => player.play("guide", Math.max(0, notes[k].start - 0.3), notes[k].start + notes[k].dur + 0.2)}
                      title={pr && pr.status !== "ok" ? pr.text : "가이드로 듣기"}
                      className={`relative rounded px-0.5 py-1 hover:bg-key ${m.emphasis ? "font-extrabold text-mine underline decoration-2 underline-offset-4" : "font-medium"}`}
                      style={pr && pr.status !== "ok" ? { textDecoration: "underline wavy", textDecorationColor: STATUS_COLOR[pr.status], textUnderlineOffset: 6 } : undefined}
                    >
                      {hasLyrics ? notes[k].syllable : noteName(notes[k].midi)}
                      {m.vibrato && <sup className="ml-0.5 text-xs text-guide">~</sup>}
                    </button>
                    {m.release && <span className="pb-1 text-xs text-muted">〰</span>}
                    {m.breathAfter && <span className="px-1 pb-1 text-base font-bold text-guide">∨</span>}
                  </span>
                );
              })}
            </p>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted">글자를 누르면 그 부분을 가이드로 들려 드려요.</p>
      </div>

      {coach.hardRange && <p className="mt-4 rounded-xl border border-warn/40 bg-[#fbf0de] p-3 text-sm">{coach.hardRange.text}</p>}

      {/* 항목별 */}
      <div className="mt-5 flex flex-wrap gap-1 border-b border-line" role="tablist">
        {(Object.keys(TAB_LABEL) as Tab[]).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === k ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"}`}
          >
            {TAB_LABEL[k]}
            {k !== "pron" && counts(k) > 0 && <span className="ml-1 rounded-full bg-mine-soft px-1.5 text-xs text-mine">{counts(k)}</span>}
          </button>
        ))}
      </div>

      {tab !== "pron" ? (
        <div className="mt-4">
          <p className="text-sm text-muted">{coach.summary[tab]}</p>
          {tab === "voice" && <p className="mt-1 text-xs text-muted">발성은 마이크와 방 울림의 영향을 받아서 &lsquo;이런 경향이 보여요&rsquo; 정도로 참고해 주세요.</p>}
          <ul className="mt-3 space-y-3">
            {items.map((it, i) => (
              <ItemRow key={i} it={it} player={player} />
            ))}
          </ul>
          {!items.length && <p className="mt-3 rounded-xl bg-paper p-4 text-sm">잘했어요! 이 부분은 가이드와 거의 같아요.</p>}
        </div>
      ) : (
        <div className="mt-4">
          <p className="text-sm text-muted">
            음성 인식이 내 노래를 어떤 글자로 알아듣는지 봐서, 뭉개지는 받침·흐린 모음·약한 첫소리를 찾아요.
            {hasLyrics ? " 연습곡 가사와 비교해요." : " 가사를 모르는 곡이라 가이드를 알아들은 글자와 비교해요."} 노래는 말보다 알아듣기 어려워서 참고용이에요.
          </p>
          {pron.kind !== "done" && (
            <button
              onClick={runPron}
              disabled={pron.kind === "working"}
              className="mt-3 rounded-xl bg-ink px-5 py-2.5 font-semibold text-white disabled:opacity-40"
            >
              {pron.kind === "working" ? "진단 중" : "발음 진단하기 (GPU)"}
            </button>
          )}
          {pron.kind === "working" && (
            <div className="mt-3 max-w-md" role="status">
              <div className="flex justify-between text-sm">
                <span>{pron.step}</span>
                <span className="tabular-nums text-muted">{Math.round(pron.p * 100)}%</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-key">
                <div className="h-full rounded-full bg-ink transition-[width]" style={{ width: `${pron.p * 100}%` }} />
              </div>
            </div>
          )}
          {pron.kind === "error" && <p className="mt-3 rounded-lg bg-mine-soft px-3 py-2 text-sm text-bad">{pron.msg}</p>}
          {pron.kind === "done" && <PronResult syl={pron.syl} heard={pron.heardText} player={player} />}
        </div>
      )}
    </section>
  );
}

function ItemRow({ it, player }: { it: CoachItem; player: Player }) {
  return (
    <li className="grid gap-2 border-l-4 pl-4 sm:grid-cols-[1fr_auto]" style={{ borderColor: it.severity >= 2 ? "var(--color-bad)" : "var(--color-warn)" }}>
      <div>
        <div className="font-semibold">
          {it.title} <span className="ml-1 text-sm font-normal text-muted">{it.label}</span>
        </div>
        <p className="mt-0.5 text-[15px]">{it.detail}</p>
        <p className="mt-1 text-[15px] text-muted">
          <span className="font-semibold text-ink">이렇게 해 보세요. </span>
          {it.tip}
        </p>
      </div>
      <div className="flex gap-1.5 sm:flex-col">
        <button onClick={() => player.play("guide", it.t0, it.t1)} className="rounded-lg bg-guide px-3 py-1.5 text-sm font-semibold text-white">
          가이드
        </button>
        <button onClick={() => player.play("mine", it.t0, it.t1)} className="rounded-lg bg-mine px-3 py-1.5 text-sm font-semibold text-white">
          내 노래
        </button>
      </div>
    </li>
  );
}

function PronResult({ syl, heard, player }: { syl: PronSyl[]; heard: string; player: Player }) {
  const ok = syl.filter((s) => s.status === "ok").length;
  const bad = syl.filter((s) => s.status !== "ok");
  const byType = (t: string[]) => bad.filter((s) => t.includes(s.status)).length;
  return (
    <div className="mt-3 space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <span>
          또렷하게 들린 글자 <b className="text-2xl tabular-nums">{Math.round((ok / Math.max(1, syl.length)) * 100)}%</b>
          <span className="text-sm text-muted">
            {" "}
            ({ok}/{syl.length})
          </span>
        </span>
        <span className="text-sm text-muted">
          받침 {byType(["jong"])} · 모음 {byType(["vowel"])} · 첫소리 {byType(["cho"])} · 다르게/안 들림 {byType(["other", "missing"])}
        </span>
      </div>
      <p className="flex flex-wrap gap-0.5 text-lg leading-loose">
        {syl.map((s, i) => (
          <button
            key={i}
            onClick={() => player.play("mine", Math.max(0, s.t0 - 0.3), s.t1 + 0.2)}
            title={s.text}
            className="rounded px-0.5 hover:bg-key"
            style={{ color: STATUS_COLOR[s.status], fontWeight: s.status === "ok" ? 500 : 800 }}
          >
            {s.expected}
          </button>
        ))}
      </p>
      {bad.length > 0 && (
        <ul className="space-y-2">
          {bad.slice(0, 10).map((s, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-paper px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">{s.text}</span>
              <button onClick={() => player.play("guide", Math.max(0, s.t0 - 0.4), s.t1 + 0.3)} className="rounded-md bg-guide px-2.5 py-1 text-xs font-semibold text-white">
                가이드
              </button>
              <button onClick={() => player.play("mine", Math.max(0, s.t0 - 0.4), s.t1 + 0.3)} className="rounded-md bg-mine px-2.5 py-1 text-xs font-semibold text-white">
                내 노래
              </button>
            </li>
          ))}
        </ul>
      )}
      <details className="text-sm text-muted">
        <summary className="cursor-pointer">음성 인식이 알아들은 내 노래</summary>
        <p className="mt-1">{heard || "(알아들은 글자가 없어요)"}</p>
      </details>
      {bad.some((s) => s.status === "jong") && (
        <p className="rounded-xl bg-paper p-3 text-sm">
          <b>받침 연습:</b> 받침이 있는 글자는 모음을 길게 끌다가 마지막에 받침을 확실히 닫아요. 예를 들어 &lsquo;줄&rsquo;은 &lsquo;주-울&rsquo;처럼 끝에서 혀를 입천장에
          붙여 마무리해요.
        </p>
      )}
    </div>
  );
}

/** 가이드 음성 인식 결과 → 글자와 대략 위치 */
function sylsFromTranscript(t?: Transcript): { s: string; t0: number; t1: number }[] {
  if (!t) return [];
  const out: { s: string; t0: number; t1: number }[] = [];
  for (const ch of t.chunks) {
    const syls = hangulOnly(dedupeWords(ch.text));
    if (!syls.length) continue;
    const a = ch.start ?? (out.length ? out[out.length - 1].t1 : 0);
    const b = ch.end ?? a + syls.length * 0.3;
    const step = Math.max(0.05, (b - a) / syls.length);
    syls.forEach((s, i) => out.push({ s, t0: a + i * step, t1: a + (i + 1) * step }));
  }
  if (!out.length) hangulOnly(t.text).forEach((s, i) => out.push({ s, t0: i * 0.3, t1: (i + 1) * 0.3 }));
  return out;
}

/** 음성 인식이 같은 말을 끝없이 반복하는 오류 걸러내기 (3번 넘게 연달아 나오면 1번만) */
function dedupeWords(text: string): string {
  const out: string[] = [];
  let run = 0;
  for (const w of text.split(/\s+/)) {
    const k = w.replace(/[.,!?~]/g, "");
    if (out.length && k && k === out[out.length - 1].replace(/[.,!?~]/g, "")) {
      if (++run >= 2) continue;
    } else run = 0;
    out.push(w);
  }
  return out.join(" ");
}
