"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import AudioInput from "@/components/AudioInput";
import { PianoRoll } from "@/components/Charts";
import GuidedRecorder from "@/components/GuidedRecorder";
import {
  createPracticeJob,
  fetchChunked,
  getGpuConfig,
  getJob,
  getNotes,
  resultUrl,
  type GpuConfig,
  type PracticeNotes,
} from "@/lib/gpu";
import { savePracticeSong } from "@/lib/practiceLibrary";
import { getRegisteredVoice, setPendingGuide, setRegisteredVoice, type AudioSource } from "@/lib/store";
import { LYRICS_MAX, LYRICS_MIN, countSyllables, sampleLyrics } from "@/lib/lyrics";
import { GENRES, INSTRUMENTS, MOODS, inferStyle, stylePrompt, type Style } from "@/lib/style";

interface Video {
  id: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  style: Style;
}

const STEPS = ["요청 보내기", "새 멜로디 만들기", "가사로 노래 만들기", "반주 만들기", "가이드 보컬 만들기", "합치기"];

type Gen =
  | { kind: "idle" }
  | { kind: "running"; step: number; detail?: string }
  | { kind: "done"; mixUrl: string; mix: Blob; vocals: Blob | null; notes: PracticeNotes | null }
  | { kind: "error"; msg: string };

export default function PracticePage() {
  const router = useRouter();
  const [gpu, setGpu] = useState<GpuConfig | null>(null);
  // 1. 원곡 찾기
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<Video[] | null>(null);
  const [searchMsg, setSearchMsg] = useState<string | null>(null);
  const [picked, setPicked] = useState<Video | null>(null);
  // 2. 스타일
  const [style, setStyle] = useState<Style>(() => inferStyle(""));
  const [low, setLow] = useState(true);
  // 3. 가사
  const [lyricsOn, setLyricsOn] = useState(true);
  const [lyrics, setLyrics] = useState(() => sampleLyrics(["calm"]));
  const [lyricsTouched, setLyricsTouched] = useState(false);
  const [sampleIdx, setSampleIdx] = useState(0);
  // 4. 목소리
  const [voice, setVoice] = useState<AudioSource | null>(null);
  const [voiceMode, setVoiceMode] = useState<"guided" | "file" | "none">("guided");
  // 5. 만들기
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 100000));
  const [gen, setGen] = useState<Gen>({ kind: "idle" });
  const alive = useRef(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [head, setHead] = useState<number | null>(null);

  useEffect(() => {
    getGpuConfig().then(setGpu);
    const v = getRegisteredVoice();
    if (v) setVoice(v);
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (gen.kind !== "done") return;
    return () => URL.revokeObjectURL(gen.mixUrl);
  }, [gen]);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (!q.trim()) return;
    setSearching(true);
    setSearchMsg(null);
    try {
      const r = await fetch(`/api/youtube/search?q=${encodeURIComponent(q.trim())}`);
      const j = await r.json();
      if (j.error === "no_key") {
        setResults([]);
        setSearchMsg("유튜브 검색이 아직 설정되지 않았어요. 아래에서 스타일을 직접 골라 연습곡을 만들 수 있어요.");
      } else if (!r.ok) {
        setResults([]);
        setSearchMsg("검색하지 못했어요. 잠시 뒤 다시 시도해 주세요.");
      } else {
        setResults(j.items);
        if (!j.items.length) setSearchMsg("검색 결과가 없어요. 곡 제목과 가수 이름을 함께 넣어 보세요.");
      }
    } catch {
      setSearchMsg("검색하지 못했어요. 인터넷 연결을 확인해 주세요.");
    } finally {
      setSearching(false);
    }
  }

  function pick(v: Video) {
    setPicked(v);
    setStyle(v.style);
  }

  const prompt = useMemo(() => stylePrompt(style), [style]);
  const moodKey = style.moods.join(",");
  useEffect(() => {
    // 직접 고치기 전까지는 분위기에 맞는 예시 가사로 바꿔 줘요
    if (!lyricsTouched) setLyrics(sampleLyrics(moodKey ? moodKey.split(",") : ["calm"], sampleIdx));
  }, [moodKey, sampleIdx, lyricsTouched]);
  const syllableCount = countSyllables(lyrics);
  const lyricsOk = !lyricsOn || (syllableCount >= LYRICS_MIN && syllableCount <= LYRICS_MAX);
  const live = gpu?.enabled === true;
  const voiceOk = voiceMode === "none" || !!voice;

  async function make(nextSeed = seed) {
    try {
      const cfg = await getGpuConfig();
      if (!cfg.enabled) throw new Error("GPU 서버가 연결되어 있지 않아 연습곡을 만들 수 없어요.");
      setGen({ kind: "running", step: 0 });
      const id = await createPracticeJob(
        cfg,
        {
          prompt,
          bpm: style.bpm,
          minor: style.minor,
          low,
          seed: nextSeed,
          lyrics: lyricsOn ? lyrics : undefined,
          voice: voiceMode !== "none" && voice ? { blob: voice.blob, name: voice.name } : null,
        },
        (p) => setGen({ kind: "running", step: 0, detail: `${Math.round(p * 100)}%` }),
      );
      while (alive.current) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await getJob(cfg, id);
        if (s.status === "error") throw new Error(s.error ?? "연습곡을 만들지 못했어요.");
        if (s.status === "done") {
          setGen({ kind: "running", step: 5, detail: "결과 받는 중" });
          const mix = await fetchChunked(resultUrl(cfg, id, "mix"), "audio/mpeg");
          const vocals = await fetchChunked(resultUrl(cfg, id, "vocals"), "audio/mpeg").catch(() => null);
          const notes = await getNotes(cfg, id).catch(() => null);
          setGen({ kind: "done", mixUrl: URL.createObjectURL(mix), mix, vocals, notes });
          const genre = GENRES.find((g) => g.id === style.genre)?.label ?? "연습곡";
          const firstLine = lyricsOn ? lyrics.split("\n")[0].trim().slice(0, 20) : "";
          const title = firstLine
            ? `「${firstLine}」 ${genre} 연습곡`
            : picked
              ? `${picked.title.slice(0, 40)} 느낌 연습곡`
              : `${genre} 연습곡 (${style.bpm} BPM)`;
          savePracticeSong({ title, mix, vocals });
          return;
        }
        const step =
          s.status === "queued"
            ? 0
            : s.step.includes("멜로디")
              ? 1
              : s.step.includes("가사")
                ? 2
                : s.step.includes("반주")
                  ? 3
                  : s.step.includes("가이드")
                    ? 4
                    : 5;
        setGen({
          kind: "running",
          step,
          detail:
            s.status === "queued"
              ? "앞선 작업을 기다리는 중"
              : step === 2
                ? "글자마다 발음을 만들고 있어요"
                : step === 3
                  ? "1분 안팎 걸려요"
                  : step === 4
                    ? "곧 끝나요"
                    : undefined,
        });
      }
    } catch (e) {
      setGen({ kind: "error", msg: e instanceof Error ? e.message : "연습곡을 만들지 못했어요." });
    }
  }

  function goCompare() {
    if (gen.kind !== "done") return;
    const mixSrc: AudioSource = { name: "practice-song.mp3", blob: gen.mix, origin: "cover" };
    const guide: AudioSource = gen.vocals ? { name: "practice-guide-vocals.mp3", blob: gen.vocals, origin: "cover" } : mixSrc;
    setPendingGuide(guide, mixSrc);
    router.push("/compare");
  }

  const roll = useMemo(() => {
    if (gen.kind !== "done" || !gen.notes) return null;
    const hop = 0.02;
    const n = Math.ceil(gen.notes.duration / hop);
    const arr: (number | null)[] = new Array(n).fill(null);
    for (const nt of gen.notes.notes) {
      const a = Math.floor(nt.start / hop);
      const b = Math.min(n, Math.floor((nt.start + nt.dur - 0.03) / hop));
      for (let i = a; i < b; i++) arr[i] = nt.midi;
    }
    return { ref: arr, empty: new Array(n).fill(null) as (number | null)[] };
  }, [gen]);

  const running = gen.kind === "running";

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">연습곡 만들기</h1>
      <p className="mt-3 text-[17px] leading-relaxed text-muted">
        부르고 싶은 노래를 찾으면, 그 노래와 분위기가 닮은 <strong className="font-semibold text-ink">새 연습곡</strong>을 만들어 드려요.
        원곡의 음원이나 멜로디는 쓰지 않고, 장르·분위기·빠르기만 참고해요.
      </p>
      {gpu && !live && (
        <p className="mt-4 rounded-xl bg-guide-soft px-4 py-3 text-sm leading-relaxed text-guide">
          지금은 GPU 서버가 연결되어 있지 않아 연습곡을 만들 수 없어요. VESSL에서 서버를 켜면 바로 쓸 수 있어요.
        </p>
      )}

      <ol className="mt-10 space-y-10">
        <Step n={1} title="원곡 찾기" done={!!picked}>
          <form onSubmit={search} className="flex gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="곡 제목이나 가수 이름"
              className="min-w-0 flex-1 rounded-xl border border-line bg-surface px-4 py-3 text-[15px] outline-none focus:border-ink"
              aria-label="유튜브에서 원곡 검색"
            />
            <button disabled={searching || !q.trim()} className="rounded-xl bg-ink px-5 py-3 font-semibold text-white disabled:opacity-35">
              {searching ? "검색 중" : "검색"}
            </button>
          </form>
          {searchMsg && <p className="mt-3 text-sm text-muted">{searchMsg}</p>}

          {picked && (
            <div className="mt-4 overflow-hidden rounded-2xl bg-ink">
              <div className="relative aspect-video">
                <iframe
                  className="absolute inset-0 h-full w-full"
                  src={`https://www.youtube-nocookie.com/embed/${picked.id}`}
                  title={picked.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
                  allowFullScreen
                />
              </div>
              <div className="flex items-center gap-3 p-4 text-white">
                <div className="min-w-0">
                  <div className="truncate font-semibold">{picked.title}</div>
                  <div className="text-sm text-white/60">{picked.channel}</div>
                </div>
                <button onClick={() => setPicked(null)} className="ml-auto shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
                  다른 곡 고르기
                </button>
              </div>
            </div>
          )}

          {!picked && results && results.length > 0 && (
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {results.map((v) => (
                <li key={v.id}>
                  <button onClick={() => pick(v)} className="flex w-full gap-3 rounded-xl border border-line bg-surface p-2 text-left hover:border-ink">
                    {v.thumbnail && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={v.thumbnail} alt="" className="h-16 w-28 shrink-0 rounded-lg object-cover" />
                    )}
                    <div className="min-w-0 py-1">
                      <div className="line-clamp-2 text-sm font-semibold">{v.title}</div>
                      <div className="mt-0.5 truncate text-xs text-muted">{v.channel}</div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">검색과 미리듣기는 유튜브 공식 플레이어로만 이뤄지고, 음원을 내려받지 않아요.</p>
        </Step>

        <Step n={2} title="스타일 정하기">
          <p className="-mt-2 mb-4 text-sm text-muted">
            {picked ? "원곡 정보로 골라 둔 스타일이에요. 마음대로 바꿔도 돼요." : "원곡을 고르지 않아도 직접 골라서 만들 수 있어요."}
          </p>
          <ChipGroup label="장르">
            {GENRES.map((g) => (
              <Chip
                key={g.id}
                on={style.genre === g.id}
                onClick={() => setStyle({ ...inferStyle(g.keys[0]), moods: style.moods, minor: style.minor, genre: g.id })}
              >
                {g.label}
              </Chip>
            ))}
          </ChipGroup>
          <ChipGroup label="분위기 (2개까지)">
            {MOODS.map((m) => {
              const on = style.moods.includes(m.id);
              return (
                <Chip
                  key={m.id}
                  on={on}
                  onClick={() =>
                    setStyle({
                      ...style,
                      moods: on ? style.moods.filter((x) => x !== m.id) : [...style.moods, m.id].slice(-2),
                    })
                  }
                >
                  {m.label}
                </Chip>
              );
            })}
          </ChipGroup>
          <ChipGroup label="악기">
            {INSTRUMENTS.map((i) => {
              const on = style.instruments.includes(i.id);
              return (
                <Chip
                  key={i.id}
                  on={on}
                  onClick={() =>
                    setStyle({ ...style, instruments: on ? style.instruments.filter((x) => x !== i.id) : [...style.instruments, i.id] })
                  }
                >
                  {i.label}
                </Chip>
              );
            })}
          </ChipGroup>

          <div className="mt-5 grid gap-5 rounded-xl bg-surface p-5 sm:grid-cols-2">
            <div>
              <div className="flex justify-between">
                <label htmlFor="bpm" className="font-semibold">
                  빠르기
                </label>
                <span className="tabular-nums text-muted">{style.bpm} BPM</span>
              </div>
              <input
                id="bpm"
                type="range"
                min={60}
                max={140}
                value={style.bpm}
                onChange={(e) => setStyle({ ...style, bpm: Number(e.target.value) })}
                className="mt-3 w-full accent-guide"
              />
            </div>
            <div className="space-y-3">
              <Toggle
                label="조성"
                options={[
                  ["밝게(장조)", !style.minor, () => setStyle({ ...style, minor: false })],
                  ["어둡게(단조)", style.minor, () => setStyle({ ...style, minor: true })],
                ]}
              />
              <Toggle
                label="내 음역"
                options={[
                  ["낮은 목소리", low, () => setLow(true)],
                  ["높은 목소리", !low, () => setLow(false)],
                ]}
              />
            </div>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted">AI에 전달되는 설명: {prompt}</p>
        </Step>

        <Step n={3} title="가사" done={lyricsOn && lyricsOk}>
          <label className="-mt-2 mb-3 flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-guide" checked={lyricsOn} onChange={(e) => setLyricsOn(e.target.checked)} />
            AI가 가사를 붙여서 불러요
          </label>
          {lyricsOn && (
            <>
              <textarea
                value={lyrics}
                onChange={(e) => {
                  setLyrics(e.target.value);
                  setLyricsTouched(true);
                }}
                rows={4}
                className="w-full resize-y rounded-xl border border-line bg-surface px-4 py-3 text-[17px] leading-relaxed outline-none focus:border-ink"
                aria-label="연습곡 가사"
              />
              <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
                <span className={syllableCount < LYRICS_MIN || syllableCount > LYRICS_MAX ? "text-bad" : "text-muted"}>
                  {syllableCount}글자 (한글 {LYRICS_MIN}~{LYRICS_MAX}글자, 한 글자에 음 하나)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setLyricsTouched(false);
                    setSampleIdx((i) => i + 1);
                  }}
                  className="ml-auto rounded-lg px-3 py-1.5 font-semibold text-guide hover:bg-guide-soft"
                >
                  다른 예시 가사
                </button>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                예시 가사는 따라소리가 새로 쓴 가사예요. 원곡 가사는 저작권이 있어서 넣지 말아 주세요. 글자 수가 음표 수와 다르면 멜로디를 자동으로
                맞춰요.
              </p>
            </>
          )}
        </Step>

        <Step n={4} title="가이드를 부를 목소리" done={voiceOk}>
          {voice && voiceMode !== "none" ? (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-mine text-sm font-bold text-white" aria-hidden>
                나
              </span>
              <div className="min-w-0">
                <div className="font-semibold">내 목소리로 가이드를 불러요</div>
                <div className="truncate text-sm text-muted">{voice.name}</div>
              </div>
              <button
                onClick={() => {
                  setVoice(null);
                  setVoiceMode("guided");
                }}
                className="ml-auto rounded-lg border border-line px-3 py-1.5 text-sm hover:border-ink"
              >
                다시 등록
              </button>
            </div>
          ) : voiceMode === "guided" ? (
            <GuidedRecorder
              onDone={(blob) => {
                const v: AudioSource = { name: "따라 부르기 녹음", blob, origin: "record" };
                setVoice(v);
                setRegisteredVoice(v);
              }}
              onCancel={() => setVoiceMode("file")}
            />
          ) : voiceMode === "file" ? (
            <AudioInput
              label="목소리 샘플"
              hint="반주 없이 부른 노래를 10~30초 올리거나 녹음해 주세요."
              tone="mine"
              value={voice}
              onChange={(v) => {
                setVoice(v);
                if (v) setRegisteredVoice(v);
              }}
              allowRecord
            />
          ) : (
            <p className="rounded-xl bg-surface p-4 text-sm text-muted">목소리 없이, 부드러운 합성음으로 가이드 멜로디를 넣어요.</p>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              className="accent-mine"
              checked={voiceMode === "none"}
              onChange={(e) => setVoiceMode(e.target.checked ? "none" : voice ? "file" : "guided")}
            />
            목소리 없이 만들기 (더 빨라요)
          </label>
        </Step>

        <Step n={5} title="연습곡 만들기" disabled={!voiceOk || !lyricsOk}>
          {gen.kind !== "done" && (
            <button
              disabled={!voiceOk || !lyricsOk || running || !live}
              onClick={() => make()}
              className="rounded-xl bg-guide px-6 py-3 font-semibold text-white disabled:opacity-35"
            >
              연습곡 만들기
            </button>
          )}
          {gen.kind === "running" && (
            <ul className="mt-4 space-y-2" role="status">
              {STEPS.map((s, i) => (
                <li key={s} className={`flex items-center gap-2 text-sm ${i > gen.step ? "text-muted/60" : i === gen.step ? "font-semibold" : "text-muted"}`}>
                  <span
                    className={`h-2 w-2 rounded-full ${i < gen.step ? "bg-good" : i === gen.step ? "animate-pulse bg-guide" : "bg-line"}`}
                    aria-hidden
                  />
                  {s}
                  {i < gen.step && <span className="text-good">완료</span>}
                  {i === gen.step && gen.detail && <span className="font-normal text-muted">{gen.detail}</span>}
                </li>
              ))}
            </ul>
          )}
          {gen.kind === "error" && <p className="mt-4 rounded-xl bg-mine-soft px-4 py-3 text-bad">{gen.msg}</p>}
          {gen.kind === "done" && (
            <div className="mt-2 rounded-2xl bg-ink p-5 text-white">
              <div className="font-semibold">연습곡이 완성됐어요</div>
              <div className="mt-0.5 text-sm text-white/60">이 브라우저에 저장했어요. AI 커버 만들기에서 &quot;내 연습곡에서 고르기&quot;로 다시 쓸 수 있어요.</div>
              <div className="mt-0.5 text-sm text-white/60">
                {GENRES.find((g) => g.id === style.genre)?.label}, {style.bpm} BPM{picked ? `, "${picked.title}" 느낌` : ""}
              </div>
              <audio
                ref={audioRef}
                src={gen.mixUrl}
                controls
                className="mt-4 h-10 w-full"
                onTimeUpdate={(e) => setHead(e.currentTarget.currentTime)}
                onPause={() => setHead(null)}
              />
              {gen.notes?.lyrics && (
                <Karaoke notes={gen.notes} audio={audioRef} sung={!!gen.notes.sung} />
              )}
              {roll && (
                <div className="mt-4 rounded-xl bg-surface p-3 text-ink">
                  <div className="mb-1 text-sm font-semibold">따라 부를 멜로디</div>
                  <PianoRoll refMidi={roll.ref} userMidi={roll.empty} hopSec={0.02} height={200} playhead={head} />
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button onClick={goCompare} className="rounded-lg bg-mine px-4 py-2.5 text-sm font-semibold hover:brightness-110">
                  따라 부르고 비교하기
                </button>
                <button
                  onClick={() => {
                    const s = seed + 1;
                    setSeed(s);
                    make(s);
                  }}
                  className="rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20"
                >
                  다른 멜로디로 다시 만들기
                </button>
                <a href={gen.mixUrl} download="ttarasori-practice.mp3" className="rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20">
                  다운로드
                </a>
              </div>
            </div>
          )}
          <p className="mt-4 text-xs leading-relaxed text-muted">
            반주는 MusicGen 모델로 만들어요. 이 모델은 비상업용 라이선스라 수업·시연용으로만 써 주세요.
          </p>
        </Step>
      </ol>
    </main>
  );
}

function Step({ n, title, done, disabled, children }: { n: number; title: string; done?: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <li className={`grid grid-cols-[36px_1fr] gap-4 transition-opacity ${disabled ? "opacity-40" : ""}`}>
      <span
        className={`grid h-9 w-9 place-items-center rounded-full text-sm font-bold ${done ? "bg-good text-white" : "border-2 border-ink"}`}
        aria-hidden
      >
        {done ? "✓" : n}
      </span>
      <div className="min-w-0">
        <h2 className="pt-1 text-xl font-semibold">{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </li>
  );
}

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="mt-4 first:mt-0">
      <legend className="text-sm font-semibold">{label}</legend>
      <div className="mt-2 flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`rounded-full border px-3.5 py-1.5 text-sm ${on ? "border-guide bg-guide text-white" : "border-line bg-surface hover:border-ink"}`}
    >
      {children}
    </button>
  );
}

function Toggle({ label, options }: { label: string; options: [string, boolean, () => void][] }) {
  return (
    <div>
      <div className="text-sm font-semibold">{label}</div>
      <div className="mt-1.5 inline-flex rounded-lg border border-line p-0.5">
        {options.map(([text, on, fn]) => (
          <button
            key={text}
            type="button"
            aria-pressed={on}
            onClick={fn}
            className={`rounded-md px-3 py-1.5 text-sm ${on ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 재생 위치에 맞춰 가사를 한 글자씩 강조 (노래방처럼) */
function Karaoke({ notes, audio, sung }: { notes: PracticeNotes; audio: React.RefObject<HTMLAudioElement | null>; sung: boolean }) {
  const [t, setT] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (audio.current) setT(audio.current.currentTime);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [audio]);

  // 쉼(0.3초 이상 비는 곳)마다 줄을 나눠요
  const lines: PracticeNotes["notes"][] = [];
  notes.notes.forEach((n, i) => {
    const prev = notes.notes[i - 1];
    if (!prev || n.start - (prev.start + prev.dur) > 0.3 || (lines[lines.length - 1]?.length ?? 0) >= 12) lines.push([]);
    lines[lines.length - 1].push(n);
  });
  const cur = lines.findIndex((l) => t < l[l.length - 1].start + l[l.length - 1].dur);
  const show = cur < 0 ? lines.slice(-2) : lines.slice(cur, cur + 2);

  return (
    <div className="mt-4 rounded-xl bg-white/5 px-4 py-4" aria-label="가사">
      {show.map((line, li) => (
        <p key={li} className={`flex flex-wrap gap-x-0.5 ${li === 0 ? "text-2xl font-bold" : "mt-1 text-lg text-white/45"}`}>
          {line.map((n, k) => {
            const done = t >= n.start + n.dur;
            const now = t >= n.start && !done;
            return (
              <span key={k} className={li === 0 ? (now ? "text-[#ff9bbf]" : done ? "text-white" : "text-white/45") : undefined}>
                {n.syllable}
              </span>
            );
          })}
        </p>
      ))}
      {!sung && <p className="mt-2 text-xs text-white/50">이번에는 가사 발음을 만들지 못해 &quot;라&quot;로 불렀어요. 가사를 보며 직접 붙여 불러 보세요.</p>}
    </div>
  );
}
