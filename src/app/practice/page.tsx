"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import AudioInput from "@/components/AudioInput";
import SingAlongHum from "@/components/SingAlongHum";
import { PianoRoll } from "@/components/Charts";
import VoiceSetup from "@/components/VoiceSetup";
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
import { getRegisteredVoice, setPendingGuide, setRegisteredVoice, takePendingHum, type AudioSource } from "@/lib/store";
import { LYRICS_MAX, LYRICS_MIN, countSyllables, sampleLyrics } from "@/lib/lyrics";
import { GENRES, INSTRUMENTS, MOODS, inferStyle, stylePrompt, type Style } from "@/lib/style";

interface Video {
  id: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  style: Style;
}

const STEPS = ["요청 보내기", "멜로디 만들기", "가사로 노래 만들기", "반주 만들기", "가이드 보컬 만들기", "합치기"];

type Gen =
  | { kind: "idle" }
  | { kind: "running"; step: number; detail?: string }
  | { kind: "done"; mixUrl: string; mix: Blob; vocals: Blob | null; notes: PracticeNotes | null; warn?: string; myVoice: boolean }
  | { kind: "error"; msg: string };

/** 예상 걸리는 시간(초). GPU 서버(RTX 3090)에서 잰 값 기준:
 *  가사 노래 포함 163~180초, 가사 없이 반주만이면 1분 남짓, 내 목소리 변환은 조금 더. */
function estimateSeconds(o: { lyrics: boolean; voice: boolean; hum: boolean }): number {
  let t = o.lyrics ? 175 : 90;
  if (o.hum) t += 5;
  if (o.voice) t += 45;
  return t;
}

function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r >= 10 ? `${m}분 ${r}초` : `${m}분`;
}

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
  const [melodyMode, setMelodyMode] = useState<"new" | "hum">("new");
  // 노래 엔진: 서버에 ACE-Step 이 준비돼 있으면 'AI 노래'를 고를 수 있어요
  const [songReady, setSongReady] = useState(false);
  const [engine, setEngine] = useState<"classic" | "ace">("classic");
  const [humStrength, setHumStrength] = useState(0.5);
  const [hum, setHum] = useState<AudioSource | null>(null);

  const [voice, setVoice] = useState<AudioSource | null>(null);
  const [voiceMode, setVoiceMode] = useState<"guided" | "file" | "none">("guided");
  // 5. 만들기
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 100000));
  const [gen, setGen] = useState<Gen>({ kind: "idle" });
  // 예상 시간: 시작 시각과 예상 총 시간(초). 1초마다 다시 그려서 남은 시간을 보여 줘요
  const [eta, setEta] = useState<{ start: number; total: number } | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (gen.kind !== "running") return;
    const iv = window.setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(iv);
  }, [gen.kind]);
  const alive = useRef(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [head, setHead] = useState<number | null>(null);

  useEffect(() => {
    getGpuConfig().then((cfg) => {
      setGpu(cfg);
      if (!cfg.enabled || !cfg.url) return;
      fetch(`${cfg.url}/health`)
        .then((r) => r.json())
        .then((h) => {
          if (h.song_ready) {
            setSongReady(true);
            setEngine("ace");
          }
        })
        .catch(() => {});
    });
    const v = getRegisteredVoice();
    if (v) setVoice(v);
    // 원곡 페이지에서 원곡을 들으며 부른 녹음을 넘겨받았으면 그 멜로디로 만들어요
    const h = takePendingHum();
    if (h) {
      setMelodyMode("hum");
      setHum(h.source);
      if (h.video) {
        const st = inferStyle(h.video.title);
        setPicked({ ...h.video, thumbnail: h.video.thumbnail ?? null, style: st });
        setStyle(st);
      }
    }
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
    // 원곡을 고르면 바로 따라 불러서 멜로디로 쓸 수 있게 '내 허밍으로'를 먼저 보여 줘요
    setMelodyMode("hum");
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
  const humOk = melodyMode === "new" || !!hum;

  async function make(nextSeed = seed) {
    try {
      const cfg = await getGpuConfig();
      if (!cfg.enabled) throw new Error("GPU 서버가 연결되어 있지 않아 연습곡을 만들 수 없어요.");
      setGen({ kind: "running", step: 0 });
      const one =
        songReady && engine === "ace"
          ? 90 + (voiceMode !== "none" && voice ? 45 : 0)
          : estimateSeconds({ lyrics: lyricsOn, voice: voiceMode !== "none" && !!voice, hum: melodyMode === "hum" });
      // 앞에 기다리는 작업이 있으면 그만큼 더 (한 작업당 같은 시간으로 어림)
      const ahead = await fetch(`${cfg.url}/health`)
        .then((r) => r.json())
        .then((h) => Number(h.queue) || 0)
        .catch(() => 0);
      setEta({ start: Date.now(), total: one * (1 + ahead) });
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
          hum: melodyMode === "hum" && hum ? { blob: hum.blob, name: hum.name } : null,
          engine: songReady ? engine : "classic",
          humStrength: melodyMode === "hum" ? humStrength : undefined,
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
          // 예전 서버는 허밍을 모르고 그냥 새 멜로디로 만들어요 → 알려 주기
          const warn =
            melodyMode === "hum" && notes && notes.melody_source !== "hum"
              ? "GPU 서버가 아직 허밍 기능을 모르는 버전이라, 허밍 대신 새 멜로디로 만들었어요. 서버를 새로 시작하면 허밍을 쓸 수 있어요."
              : undefined;
          const myVoice = voiceMode !== "none" && !!voice;
          setGen({ kind: "done", mixUrl: URL.createObjectURL(mix), mix, vocals, notes, warn, myVoice });
          const genre = GENRES.find((g) => g.id === style.genre)?.label ?? "연습곡";
          const firstLine = lyricsOn ? lyrics.split("\n")[0].trim().slice(0, 20) : "";
          const title = firstLine
            ? `「${firstLine}」 ${genre} 연습곡`
            : notes?.melody_source === "hum"
              ? `내 허밍 ${genre} 연습곡`
              : picked
              ? `${picked.title.slice(0, 40)} 느낌 연습곡`
              : `${genre} 연습곡 (${style.bpm} BPM)`;
          savePracticeSong({ title: myVoice ? `${title} · 내 목소리` : title, mix, vocals, notes: notes?.notes ?? null });
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
    const notes = gen.notes?.notes ?? null;
    const mixSrc: AudioSource = { name: "practice-song.mp3", blob: gen.mix, origin: "cover", notes };
    const guide: AudioSource = gen.vocals ? { name: "practice-guide-vocals.mp3", blob: gen.vocals, origin: "cover", notes } : mixSrc;
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
      // 한 글자를 여러 음으로 끌어 부르는 곳(bends)은 그 시각부터 바뀐 음으로 그려요
      const bends = nt.bends ?? [];
      for (let i = a; i < b; i++) {
        const t = i * hop;
        let m = nt.midi;
        for (const [bt, bm] of bends) if (t >= bt) m = bm;
        arr[i] = m;
      }
    }
    return { ref: arr, empty: new Array(n).fill(null) as (number | null)[] };
  }, [gen]);

  const running = gen.kind === "running";

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">연습곡 만들기</h1>
      <p className="mt-3 text-[17px] leading-relaxed text-muted">
        부르고 싶은 노래를 찾으면, 그 노래와 분위기가 닮은 <strong className="font-semibold text-ink">새 연습곡</strong>을 만들어 드려요.
        원곡 음원은 쓰지 않고 장르·분위기·빠르기만 참고해요. 멜로디는 새로 짓거나, 원하면 <strong className="font-semibold text-ink">내가 직접 부른 허밍</strong>에서 가져와요.
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
                <a
                  href={`/original?v=${picked.id}&title=${encodeURIComponent(picked.title)}&channel=${encodeURIComponent(picked.channel)}`}
                  className="ml-auto shrink-0 rounded-lg bg-white px-3 py-1.5 text-sm font-semibold text-ink hover:bg-white/90"
                >
                  이 원곡으로 가이드 만들기
                </a>
                <button onClick={() => setPicked(null)} className="shrink-0 rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20">
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
          <div className="mb-5 rounded-xl border border-line p-4">
            <Toggle
              label="멜로디"
              options={[
                ["내 허밍으로", melodyMode === "hum", () => setMelodyMode("hum")],
                ["새로 짓기", melodyMode === "new", () => setMelodyMode("new")],
              ]}
            />
            {songReady && (
              <div className="mt-4">
                <Toggle
                  label="노래 엔진"
                  options={[
                    ["AI 노래 (새 엔진)", engine === "ace", () => setEngine("ace")],
                    ["기본", engine === "classic", () => setEngine("classic")],
                  ]}
                />
                <p className="mt-1 text-xs text-muted">
                  {engine === "ace"
                    ? "AI가 반주와 노래를 한 번에 만들어 진짜 노래처럼 들려요. 멜로디는 허밍을 참고해서 AI가 다듬어요(시험 중)."
                    : "멜로디를 그대로 지키지만, 읽기 음성을 늘여 부르는 방식이라 기계음처럼 들릴 수 있어요."}
                </p>
              </div>
            )}
            {melodyMode === "hum" && songReady && engine === "ace" && (
              <div className="mt-4">
                <div className="flex justify-between text-sm">
                  <label htmlFor="humStrength" className="font-semibold">
                    허밍 따르기
                  </label>
                  <span className="text-muted">{humStrength >= 0.75 ? "허밍 그대로" : humStrength <= 0.35 ? "AI가 자유롭게" : "균형"}</span>
                </div>
                <input
                  id="humStrength"
                  type="range"
                  min={0.2}
                  max={1}
                  step={0.05}
                  value={humStrength}
                  onChange={(e) => setHumStrength(Number(e.target.value))}
                  className="mt-2 w-full accent-guide"
                />
              </div>
            )}
            {melodyMode === "hum" && (
              <div className="mt-4 space-y-3">
                {picked ? (
                  <SingAlongHum video={picked} onDone={setHum} />
                ) : (
                  <p className="rounded-xl bg-surface p-3 text-sm text-muted">1단계에서 유튜브 원곡을 고르면, 여기서 원곡을 틀고 바로 따라 불러서 쓸 수 있어요.</p>
                )}
                <AudioInput
                  label="내 허밍"
                  hint={
                    hum
                      ? "이 녹음의 멜로디로 연습곡을 만들어요. 들어 보고 마음에 안 들면 다시 불러 주세요."
                      : "원곡 없이 직접 녹음하거나 파일을 올려도 돼요. '라라라'나 '음~'으로 10~30초, 음마다 살짝 끊어 부르면 더 정확해요."
                  }
                  tone="mine"
                  value={hum}
                  onChange={setHum}
                  allowRecord
                />
                <ul className="mt-3 space-y-1 text-xs leading-relaxed text-muted">
                  <li>· 원곡 소리가 녹음에 섞이면 멜로디를 잘못 읽어요. 이어폰을 끼거나 원곡을 끄고 조용한 곳에서 불러 주세요. 처음 30초까지 써요.</li>
                  <li>· 빠르기와 조성은 허밍을 따라가요. 아래 빠르기·조성 설정은 허밍에서 알아내기 어려울 때만 써요.</li>
                  <li>· 내가 부른 멜로디가 원곡과 같다면 그 멜로디는 원곡 작곡가의 것이에요. 혼자 연습할 때만 써 주세요.</li>
                </ul>
              </div>
            )}
          </div>
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
          {voiceMode !== "none" ? (
            <VoiceSetup value={voice} onChange={setVoice} />
          ) : (
            <p className="rounded-xl bg-surface p-4 text-sm text-muted">목소리 없이, 부드러운 합성음으로 가이드 멜로디를 넣어요.</p>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              className="accent-mine"
              checked={voiceMode === "none"}
              onChange={(e) => setVoiceMode(e.target.checked ? "none" : "guided")}
            />
            목소리 없이 만들기 (더 빨라요)
          </label>
        </Step>

        <Step n={5} title="연습곡 만들기" disabled={!voiceOk || !lyricsOk || !humOk}>
          {gen.kind !== "done" && (
            <button
              disabled={!voiceOk || !lyricsOk || !humOk || running || !live}
              onClick={() => make()}
              className="rounded-xl bg-guide px-6 py-3 font-semibold text-white disabled:opacity-35"
            >
              연습곡 만들기
            </button>
          )}
          {gen.kind !== "done" && gen.kind !== "running" && (
            <p className="mt-2 text-sm text-muted">
              예상 시간 약{" "}
              {fmtDuration(
                songReady && engine === "ace"
                  ? 90 + (voiceMode !== "none" && voice ? 45 : 0)
                  : estimateSeconds({ lyrics: lyricsOn, voice: voiceMode !== "none" && !!voice, hum: melodyMode === "hum" }),
              )}
              {lyricsOn ? " (가사 노래 만들기가 대부분이에요)" : ""}. 다른 사람 작업이 먼저 있으면 더 걸려요.
            </p>
          )}
          {gen.kind === "running" && eta && (
            <EtaBar start={eta.start} total={eta.total} />
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
              <div className="mt-0.5 text-sm text-white/60">
                {gen.myVoice
                  ? "내 목소리로 부른 가이드라서 이미 내 목소리 AI 커버예요. AI 커버를 따로 만들 필요 없이 바로 따라 부르고 비교하면 돼요. 이 브라우저에 저장했어요."
                  : "합성 목소리로 부른 가이드예요. 이 브라우저에 저장했고, 내 목소리로 바꾸고 싶으면 아래 'AI 커버로 내 목소리 입히기'를 눌러 주세요."}
              </div>
              <div className="mt-0.5 text-sm text-white/60">
                {GENRES.find((g) => g.id === style.genre)?.label}, {gen.notes?.bpm ?? style.bpm} BPM
                {gen.notes?.melody_source === "hum" ? ", 내 허밍 멜로디" : picked ? `, "${picked.title}" 느낌` : ""}
              </div>
              <audio
                ref={audioRef}
                src={gen.mixUrl}
                controls
                className="mt-4 h-10 w-full"
                onTimeUpdate={(e) => setHead(e.currentTarget.currentTime)}
                onPause={() => setHead(null)}
              />
              {gen.warn && <p className="mt-3 rounded-lg bg-white/10 px-3 py-2 text-sm text-[#f5c542]">{gen.warn}</p>}
              {gen.notes?.melody_source === "hum" && gen.notes.hum_info && (
                <p className="mt-3 text-sm text-white/70">
                  내 허밍에서 음 {gen.notes.hum_info.notes}개를 읽었어요 · {gen.notes.hum_info.key.replace("m", " 단조")}
                  {gen.notes.hum_info.minor ? "" : " 장조"} · {gen.notes.hum_info.bpm} BPM
                </p>
              )}
              {gen.notes?.lyrics && (
                <Karaoke notes={gen.notes} audio={audioRef} sung={!!gen.notes.sung} />
              )}
              {gen.notes?.sing_info && (
                <p className="mt-2 text-sm text-white/70">
                  가이드 발음 또렷함{" "}
                  <b className={gen.notes.sing_info.clarity >= 0.7 ? "text-[#7ee0b5]" : gen.notes.sing_info.clarity >= 0.45 ? "text-[#f5c542]" : "text-[#ff8a8a]"}>
                    {Math.round(gen.notes.sing_info.clarity * 100)}%
                  </b>{" "}
                  (음성 인식이 알아들은 비율, {gen.notes.sing_info.tried}가지 방법 중 가장 또렷한 걸 골랐어요)
                </p>
              )}
              {roll && (
                <div className="mt-4 rounded-xl bg-surface p-3 text-ink">
                  <div className="mb-1 text-sm font-semibold">따라 부를 멜로디</div>
                  <PianoRoll refMidi={roll.ref} userMidi={roll.empty} hopSec={0.02} height={200} playhead={head} />
                </div>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={goCompare}
                  className={
                    gen.myVoice
                      ? "rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-ink hover:bg-white/90"
                      : "rounded-lg bg-mine px-4 py-2.5 text-sm font-semibold hover:brightness-110"
                  }
                >
                  바로 따라 부르고 비교하기
                </button>
                {!gen.myVoice && (
                  <button
                    onClick={() => router.push("/cover?from=practice")}
                    className="rounded-lg bg-white px-4 py-2.5 text-sm font-semibold text-ink hover:bg-white/90"
                  >
                    AI 커버로 내 목소리 입히기
                  </button>
                )}
                <a href="/train?tab=game" className="rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20">
                  음정 게임으로 부르기
                </a>
                <button
                  onClick={() => {
                    const s = seed + 1;
                    setSeed(s);
                    make(s);
                  }}
                  className="rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20"
                >
                  {gen.notes?.melody_source === "hum" ? "같은 허밍으로 다시 만들기" : "다른 멜로디로 다시 만들기"}
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

/** 남은 예상 시간 막대. 예상을 넘기면 '거의 다 됐어요'로 바꿔서 숫자가 음수가 되지 않게 해요 */
function EtaBar({ start, total }: { start: number; total: number }) {
  const elapsed = (Date.now() - start) / 1000;
  const left = total - elapsed;
  const pct = Math.min(97, (elapsed / total) * 100);
  return (
    <div className="mt-4">
      <div className="flex justify-between text-sm">
        <span className="font-semibold">{left > 5 ? `남은 시간 약 ${fmtDuration(left)}` : "거의 다 됐어요"}</span>
        <span className="tabular-nums text-muted">
          {fmtDuration(elapsed)} / 예상 {fmtDuration(total)}
        </span>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-guide transition-[width] duration-1000" style={{ width: `${pct}%` }} />
      </div>
      {left <= 5 && elapsed > total + 30 && (
        <p className="mt-1 text-xs text-muted">예상보다 조금 더 걸리고 있어요. 서버가 바쁘거나 가사 노래를 한 번 더 다듬는 중일 수 있어요.</p>
      )}
    </div>
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
