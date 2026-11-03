"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import TunedVersion from "@/components/TunedVersion";
import { scoreColor } from "@/components/Charts";
import { decodeToMono } from "@/lib/audio/decode.ts";
import { extractFeatures } from "@/lib/audio/features.ts";
import { splitLines } from "@/lib/audio/notes.ts";
import { beatsFromTaps, pitchLabel, selfCheck, snapTarget, type SelfCheck, type SelfNote } from "@/lib/audio/selfcheck.ts";
import { SAMPLE_RATE } from "@/lib/audio/synth.ts";
import { parseVideoId, useYouTube } from "@/lib/useYouTube";
import { saveToLibrary } from "@/lib/practiceLibrary";
import { setPendingGuide, setPendingHum } from "@/lib/store";

interface Video {
  id: string;
  title: string;
  channel: string;
  thumbnail?: string | null;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, "0")}`;

export default function OriginalPage() {
  const [video, setVideo] = useState<Video | null>(null);

  // 연습곡 화면 등에서 ?v=영상ID&title=제목 으로 넘어온 경우
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const id = q.get("v");
    if (id && /^[\w-]{11}$/.test(id)) setVideo({ id, title: q.get("title") ?? "", channel: q.get("channel") ?? "" });
  }, []);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="max-w-2xl">
        <Link href="/compare" className="text-sm font-semibold text-muted hover:text-ink">
          ← 내 노래 비교
        </Link>
        <h1 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">원곡으로 내 목소리 가이드 만들기</h1>
        <p className="mt-3 text-[17px] leading-relaxed text-muted">
          비교할 AI 커버가 없어도 괜찮아요. 유튜브 원곡을 들으며 한 번 불러 보면, 음정만 정확하게 고친 <b className="text-ink">내 목소리 가이드</b>를 만들어 드려요.
          그 가이드를 기준으로 다시 부르며 글자별 피드백과 구간 반복 연습을 할 수 있어요.
        </p>
      </div>
      <ol className="mt-5 grid gap-2 text-sm sm:grid-cols-4">
        {["원곡 고르기", "원곡 들으며 한 번 부르기", "음정 고친 내 목소리 가이드 만들기", "가이드로 비교 연습"].map((t, i) => (
          <li key={t} className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2.5">
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink text-xs font-bold text-white">{i + 1}</span>
            {t}
          </li>
        ))}
      </ol>
      <ul className="mt-3 flex flex-wrap gap-2 text-sm">
        {["원곡은 유튜브 공식 플레이어로 재생만 해요", "원곡 소리는 내려받거나 분석하지 않아요", "녹음은 이 브라우저 안에서만 써요"].map((t) => (
          <li key={t} className="rounded-full bg-guide-soft px-3 py-1 font-medium text-guide">
            {t}
          </li>
        ))}
      </ul>

      {video ? <Studio video={video} onChange={() => setVideo(null)} /> : <Picker onPick={setVideo} />}
    </main>
  );
}

/* ------------------------------------------------------------------ 원곡 고르기 */

function Picker({ onPick }: { onPick: (v: Video) => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [items, setItems] = useState<Video[] | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const text = q.trim();
    if (!text) return;
    setMsg(null);
    setBusy(true);
    try {
      const id = parseVideoId(text);
      if (id) {
        const r = await fetch(`/api/youtube/info?id=${id}`);
        const j = r.ok ? ((await r.json()) as Video) : null;
        onPick({ id, title: j?.title || "유튜브 영상", channel: j?.channel ?? "", thumbnail: j?.thumbnail });
        return;
      }
      const r = await fetch(`/api/youtube/search?q=${encodeURIComponent(text)}`);
      if (r.status === 503) {
        setMsg("검색 기능이 아직 준비되지 않았어요. 유튜브에서 원곡을 찾아 주소(링크)를 복사해서 붙여 넣어 주세요.");
        setItems(null);
        return;
      }
      if (!r.ok) throw new Error();
      const j = (await r.json()) as { items: Video[] };
      setItems(j.items);
      if (!j.items.length) setMsg("검색 결과가 없어요. 다른 검색어나 유튜브 링크로 시도해 주세요.");
    } catch {
      setMsg("검색하지 못했어요. 유튜브 링크를 붙여 넣어 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8 max-w-3xl rounded-2xl bg-surface p-5 sm:p-6">
      <h2 className="text-xl font-semibold">원곡 고르기</h2>
      <p className="mt-1 text-sm text-muted">
        곡 이름으로 검색하거나, 유튜브 영상 주소를 그대로 붙여 넣어도 돼요. 가수 공식 채널의 가사(Lyric) 영상이나 가사 자막이 있는 영상을 고르면 따라 부르기 편해요.
      </p>
      <form onSubmit={submit} className="mt-4 flex gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="예: 곡 이름 가수 이름, 또는 https://youtu.be/…"
          className="min-w-0 flex-1 rounded-xl border border-line bg-paper px-4 py-3 outline-none focus:border-ink"
        />
        <button disabled={busy || !q.trim()} className="rounded-xl bg-ink px-5 py-3 font-semibold text-white disabled:opacity-35">
          {busy ? "찾는 중" : parseVideoId(q) ? "열기" : "검색"}
        </button>
      </form>
      {msg && <p className="mt-3 text-sm text-muted">{msg}</p>}
      {items && items.length > 0 && (
        <ul className="mt-4 divide-y divide-line">
          {items.map((v) => (
            <li key={v.id}>
              <button onClick={() => onPick(v)} className="flex w-full items-center gap-3 py-3 text-left hover:bg-paper">
                {v.thumbnail && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={v.thumbnail} alt="" className="h-14 w-24 shrink-0 rounded-md object-cover" />
                )}
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{v.title}</span>
                  <span className="block text-sm text-muted">{v.channel}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ 듣기·녹음 */

type RecState =
  | { kind: "idle" }
  | { kind: "recording"; since: number; level: number }
  | { kind: "analyzing" }
  | { kind: "error"; msg: string };

interface Take {
  blob: Blob;
  url: string;
  videoStart: number;
  check: SelfCheck;
  timed: boolean;
}

function Studio({ video, onChange }: { video: Video; onChange: () => void }) {
  const yt = useYouTube(video.id);
  const [rate, setRate] = useState(1);
  const [captions, setCaptions] = useState(true);
  const [a, setA] = useState<number | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [loop, setLoop] = useState(false);
  const [taps, setTaps] = useState<number[]>([]);
  const [headphones, setHeadphones] = useState(false);
  const [rec, setRec] = useState<RecState>({ kind: "idle" });
  const [take, setTake] = useState<Take | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const recInfo = useRef<{ startedAt: number; videoStart: number | null } | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const beats = useMemo(() => beatsFromTaps(taps), [taps]);
  const hasSection = a != null && b != null && b > a + 1;
  const recording = rec.kind === "recording";

  // 구간 반복 / 녹음 중 구간 끝에서 멈추기 / 녹음 시작 시점 기록
  useEffect(() => {
    const p = yt.player.current;
    if (!p || !yt.ready) return;
    const t = yt.time;
    if (recording) {
      const info = recInfo.current;
      if (info && info.videoStart == null && yt.playing) {
        info.videoStart = t - (performance.now() - info.startedAt) / 1000;
      }
      if (hasSection && t >= b!) stopRef.current?.();
      return;
    }
    if (loop && hasSection && yt.playing && (t >= b! || t < a! - 0.5)) p.seekTo(a!, true);
  }, [yt.time, yt.playing, yt.ready, yt.player, loop, hasSection, a, b, recording]);

  useEffect(() => {
    yt.player.current?.setPlaybackRate?.(rate);
  }, [rate, yt.ready, yt.player]);

  useEffect(() => () => stopRef.current?.(), []);

  const tap = () => {
    if (!yt.playing) return;
    const t = yt.player.current?.getCurrentTime() ?? 0;
    setTaps((all) => {
      const last = all[all.length - 1];
      // 앞뒤로 이동했거나 2초 넘게 쉬었으면 새로 시작
      return last != null && (t < last || t - last > 2) ? [t] : [...all, t];
    });
  };

  async function startRecording() {
    const p = yt.player.current;
    if (!p) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      setRec({ kind: "error", msg: "마이크를 쓸 수 없어요. 주소창의 마이크 권한을 허용한 뒤 다시 눌러 주세요." });
      return;
    }
    setLoop(false);
    setRate(1); // 박자 분석을 위해 녹음은 보통 속도로
    p.setPlaybackRate(1);
    if (hasSection) p.seekTo(Math.max(0, a! - 1.5), true);

    const mr = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const ctx = new AudioContext();
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const since = performance.now();
    let raf = 0;
    const meter = () => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      setRec({ kind: "recording", since, level: Math.min(1, Math.sqrt(s / buf.length) * 6) });
      raf = requestAnimationFrame(meter);
    };

    const stop = () => {
      stopRef.current = null;
      cancelAnimationFrame(raf);
      if (mr.state !== "inactive") mr.stop();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      yt.player.current?.pauseVideo();
    };
    mr.onstop = () => analyze(new Blob(chunks, { type: mr.mimeType || "audio/webm" }));
    stopRef.current = stop;
    recInfo.current = { startedAt: performance.now(), videoStart: null };
    mr.start();
    p.playVideo();
    meter();
  }

  async function analyze(blob: Blob) {
    setRec({ kind: "analyzing" });
    try {
      const x = await decodeToMono(blob);
      if (x.length < SAMPLE_RATE * 2) throw new Error("녹음이 너무 짧아요. 2초 이상 불러 주세요.");
      const f = await extractFeatures(x, SAMPLE_RATE);
      const videoStart = recInfo.current?.videoStart ?? 0;
      const timed = !!beats && recInfo.current?.videoStart != null;
      const check = selfCheck(f, { beats: timed ? beats : null, videoStart });
      if (!check.notes.length) throw new Error("노래 소리를 찾지 못했어요. 마이크 가까이에서 다시 불러 주세요.");
      setTake((old) => {
        if (old) URL.revokeObjectURL(old.url);
        return { blob, url: URL.createObjectURL(blob), videoStart, check, timed };
      });
      setRec({ kind: "idle" });
      requestAnimationFrame(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (e) {
      setRec({ kind: "error", msg: e instanceof Error ? e.message : "녹음을 분석하지 못했어요." });
    }
  }

  const p = yt.player.current;
  const btn = "rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-semibold hover:border-ink disabled:opacity-40";

  return (
    <div className="mt-8 space-y-6">
      <section className="grid gap-6 rounded-2xl bg-surface p-4 sm:p-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <div className="aspect-video overflow-hidden rounded-xl bg-ink" ref={yt.mount} />
          <div className="mt-3 flex items-center gap-3">
            <div className="min-w-0">
              <div className="truncate font-semibold">{video.title || "유튜브 영상"}</div>
              <div className="text-sm text-muted">{video.channel}</div>
            </div>
            <button onClick={onChange} disabled={recording} className={`${btn} ml-auto shrink-0`}>
              다른 곡
            </button>
          </div>
        </div>

        <div className="space-y-5">
          <div>
            <h3 className="font-semibold">듣기</h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">속도</span>
              {[1, 0.75].map((r) => (
                <button
                  key={r}
                  onClick={() => setRate(r)}
                  disabled={recording}
                  className={`rounded-md px-2.5 py-1 text-sm font-semibold ${rate === r ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
                >
                  {r === 1 ? "보통" : "0.75배"}
                </button>
              ))}
              <span className="ml-auto text-sm tabular-nums text-muted">
                {fmt(yt.time)} / {fmt(yt.duration)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted">가사 자막</span>
              {[true, false].map((on) => (
                <button
                  key={String(on)}
                  onClick={() => {
                    setCaptions(on);
                    yt.setCaptions(on);
                  }}
                  disabled={!yt.ready}
                  className={`rounded-md px-2.5 py-1 text-sm font-semibold ${captions === on ? "bg-ink text-white" : "text-muted hover:text-ink"}`}
                >
                  {on ? "켜기" : "끄기"}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">
              영상에 올라온 가사 자막을 유튜브 플레이어가 보여 줘요. 자막이 없는 영상이면 안 나와요. 검색할 때 &lsquo;가사&rsquo;나 &lsquo;lyrics&rsquo;를 붙이면 가사가 나오는 공식 영상을 찾기 쉬워요.
            </p>
          </div>

          <div>
            <h3 className="font-semibold">연습 구간</h3>
            <p className="text-sm text-muted">원곡을 들으며 원하는 곳에서 시작·끝을 찍어요. 후렴만 반복 연습할 때 좋아요.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button className={btn} disabled={!yt.ready || recording} onClick={() => setA(p?.getCurrentTime() ?? 0)}>
                시작 {a != null ? fmt(a) : "찍기"}
              </button>
              <button className={btn} disabled={!yt.ready || recording || a == null} onClick={() => setB(p?.getCurrentTime() ?? 0)}>
                끝 {b != null ? fmt(b) : "찍기"}
              </button>
              <button
                className={`${btn} ${loop ? "!border-guide bg-guide-soft text-guide" : ""}`}
                disabled={!hasSection || recording}
                onClick={() => {
                  const on = !loop;
                  setLoop(on);
                  if (on && p) {
                    p.seekTo(a!, true);
                    p.playVideo();
                  }
                }}
              >
                {loop ? "반복 중" : "구간 반복"}
              </button>
              {(a != null || b != null) && (
                <button
                  className="px-2 text-sm text-muted hover:text-ink"
                  disabled={recording}
                  onClick={() => {
                    setA(null);
                    setB(null);
                    setLoop(false);
                  }}
                >
                  지우기
                </button>
              )}
            </div>
            {a != null && b != null && !hasSection && <p className="mt-1 text-xs text-bad">끝 지점을 시작보다 1초 이상 뒤로 찍어 주세요.</p>}
          </div>

          <div>
            <h3 className="font-semibold">박자 두드리기 (선택)</h3>
            <p className="text-sm text-muted">원곡을 재생하면서 박에 맞춰 8번 이상 눌러 주면 박자가 늦는지 빠른지도 알려 드려요.</p>
            <div className="mt-2 flex items-center gap-3">
              <button
                onPointerDown={tap}
                disabled={!yt.playing || recording}
                className="h-12 w-28 rounded-xl bg-guide font-semibold text-white active:scale-95 disabled:opacity-40"
              >
                탁!
              </button>
              <div className="text-sm">
                {beats ? (
                  <span>
                    <b className="text-lg tabular-nums">{beats.bpm}</b> BPM <span className="text-muted">({taps.length}번)</span>
                  </span>
                ) : (
                  <span className="text-muted">{yt.playing ? `${taps.length}/4번 이상 눌러 주세요` : "먼저 원곡을 재생해 주세요"}</span>
                )}
              </div>
              {taps.length > 0 && (
                <button onClick={() => setTaps([])} className="text-sm text-muted hover:text-ink">
                  다시
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-surface p-4 sm:p-6">
        <h2 className="text-xl font-semibold">따라 불러서 녹음하기</h2>
        <p className="mt-1 text-sm text-muted">
          {hasSection
            ? `연습 구간(${fmt(a!)} ~ ${fmt(b!)})을 1.5초 앞에서부터 틀어 주고, 구간이 끝나면 녹음도 멈춰요.`
            : "지금 위치부터 원곡을 틀면서 녹음해요. 다 부르면 '녹음 끝내기'를 눌러 주세요."}
        </p>
        <label className="mt-4 flex items-start gap-2 rounded-lg bg-paper p-3 text-sm">
          <input type="checkbox" checked={headphones} onChange={(e) => setHeadphones(e.target.checked)} className="mt-0.5 accent-mine" />
          <span>
            <b>이어폰(헤드폰)을 꼈어요.</b> 스피커로 들으면 원곡 소리가 녹음에 섞여서 채점이 틀리고, 원곡을 녹음하는 것이 돼요.
          </span>
        </label>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {recording ? (
            <>
              <button onClick={() => stopRef.current?.()} className="rounded-xl bg-ink px-6 py-3 font-semibold text-white">
                녹음 끝내기
              </button>
              <span className="flex items-center gap-2 font-semibold text-mine">
                <span className="h-3 w-3 animate-pulse rounded-full bg-mine" aria-hidden /> 녹음 중 {((performance.now() - rec.since) / 1000).toFixed(0)}초
              </span>
              <div className="h-1.5 w-32 overflow-hidden rounded-full bg-key">
                <div className="h-full bg-mine transition-[width] duration-75" style={{ width: `${rec.level * 100}%` }} />
              </div>
            </>
          ) : (
            <button
              onClick={startRecording}
              disabled={!yt.ready || !headphones || rec.kind === "analyzing"}
              className="rounded-xl bg-mine px-6 py-3 font-semibold text-white hover:brightness-110 disabled:opacity-35"
            >
              {rec.kind === "analyzing" ? "분석 중" : "원곡 틀고 녹음 시작"}
            </button>
          )}
          {!headphones && !recording && <span className="text-sm text-muted">이어폰을 끼고 위 칸에 체크해 주세요.</span>}
        </div>
        {rec.kind === "error" && <p className="mt-3 rounded-lg bg-mine-soft px-3 py-2 text-sm text-bad">{rec.msg}</p>}
      </section>

      {take && (
        <div ref={resultRef} className="scroll-mt-6">
          <Result take={take} video={video} seekOriginal={(t, d) => {
            const pl = yt.player.current;
            if (!pl) return;
            pl.setPlaybackRate(1);
            pl.seekTo(Math.max(0, t), true);
            pl.playVideo();
            window.setTimeout(() => pl.pauseVideo(), d * 1000);
          }} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ 결과 */

function chip(n: SelfNote): React.CSSProperties {
  if (n.severity === 0) return { background: "#e3f4ed", color: "var(--color-good)" };
  if (n.severity === 1) return { background: "#fbf0de", color: "#9a6210" };
  return { background: "#fbe4e4", color: "var(--color-bad)" };
}

const TIPS: Record<string, string> = {
  flat: "음이 처졌어요. 목표음을 살짝 위에서 내려 잡는 느낌으로, 숨을 배로 받쳐서 불러 보세요.",
  sharp: "음이 떴어요. 턱과 목 힘을 빼고 소리를 위로 밀지 말고 앞으로 보내 보세요.",
  unstable: "긴 음이 흔들렸어요. 이 음을 '아-'로 4박씩 길게 내며 모음 모양을 끝까지 유지하는 연습을 해 보세요.",
  outOfScale: "이 곡의 음계에 없는 음이에요. 원곡에서 이 부분을 다시 듣고 같은 음인지 확인해 보세요.",
};

function Result({ take, video, seekOriginal }: { take: Take; video: Video; seekOriginal: (t: number, dur: number) => void }) {
  const title = video.title;
  const router = useRouter();
  const c = take.check;
  const o = c.overall;
  const [sel, setSel] = useState<number | null>(null);
  const [tuned, setTuned] = useState<Blob | null>(null);
  const [tunedUrl, setTunedUrl] = useState<string | null>(null);
  const mineEl = useRef<HTMLAudioElement | null>(null);
  const tunedEl = useRef<HTMLAudioElement | null>(null);
  const lines = useMemo(() => splitLines(c.notes, 14, 0.5), [c]);
  const cur = sel != null ? c.notes[sel] : null;

  useEffect(() => {
    mineEl.current = new Audio(take.url);
    return () => mineEl.current?.pause();
  }, [take.url]);
  useEffect(() => {
    if (!tuned) return setTunedUrl(null);
    const u = URL.createObjectURL(tuned);
    setTunedUrl(u);
    tunedEl.current = new Audio(u);
    return () => {
      tunedEl.current?.pause();
      URL.revokeObjectURL(u);
    };
  }, [tuned]);

  const playClip = (el: HTMLAudioElement | null, n: SelfNote) => {
    if (!el) return;
    mineEl.current?.pause();
    tunedEl.current?.pause();
    el.currentTime = Math.max(0, n.start - 0.4);
    void el.play();
    const end = n.start + n.dur + 0.3;
    const check = () => {
      if (el.currentTime >= end || el.paused) el.pause();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  };

  return (
    <div className="space-y-6">
      <section className="grid gap-6 rounded-2xl bg-ink p-6 text-white sm:p-8 lg:grid-cols-[auto_1fr]">
        <div className="flex items-end gap-3">
          <span className="text-7xl font-bold leading-none tabular-nums">{o.score}</span>
          <span className="pb-2 text-white/60">/ 100점</span>
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:pl-8">
          <Stat label="정확한 음 비율" value={`${Math.round(o.accuracy * 100)}%`} sub="±30센트 이내" />
          <Stat label="평균 음정 차이" value={`${Math.round(o.meanAbsCents)}센트`} sub="반음 = 100센트" />
          <Stat label="음역" value={c.range ? `${pitchLabel(c.range.low)}~${pitchLabel(c.range.high)}` : "-"} sub={c.key ? c.key.name.split(" (")[0] : "키 판단 어려움"} />
          <Stat
            label="박자 경향"
            value={o.timingMs == null ? "-" : Math.abs(o.timingMs) < 60 ? "잘 맞아요" : `${Math.abs(o.timingMs)}ms ${o.timingMs > 0 ? "늦음" : "빠름"}`}
            sub={take.timed ? "두드린 박 기준" : "박자를 두드리면 알려 드려요"}
          />
        </div>
        <ul className="space-y-1.5 text-[15px] leading-relaxed text-white/85 lg:col-span-2">
          {c.summary.map((s) => (
            <li key={s} className="flex gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-white/50" aria-hidden />
              {s}
            </li>
          ))}
        </ul>
        <p className="text-xs text-white/50 lg:col-span-2">
          원곡 음원은 분석하지 않기 때문에, 원곡과 &lsquo;다른 음&rsquo;을 불렀는지는 알 수 없어요. 각 음이 정확한 음 높이에 붙어 있는지와 흔들림·박자를 봐요.
        </p>
      </section>

      <TunedVersion
        makeTarget={() => snapTarget(c)}
        resetKey={c}
        mine={take.blob}
        onReady={setTuned}
        title="내 목소리 가이드 만들기"
        actionLabel="가이드 만들기"
        description={
          <>
            내 녹음의 각 음을 <b className="text-ink">가장 가까운 정확한 음</b>으로 맞춰서 내 목소리 가이드를 만들어요. 원곡 음원은 쓰지 않고, 박자·발음·음색은
            그대로예요. 처음에 원곡과 다른 음을 불렀다면 가이드에도 그 음이 남으니, 아래 음별 피드백에서 &lsquo;원곡 이 부분&rsquo;과 비교해 확인해 보세요.
          </>
        }
      />

      {tuned && (
        <section className="flex flex-wrap items-center gap-4 rounded-2xl bg-ink p-5 text-white sm:p-6">
          <div className="max-w-xl flex-1">
            <div className="text-sm font-semibold text-white/60">다음 단계</div>
            <h2 className="mt-0.5 text-xl font-semibold">이 가이드로 비교 연습하기</h2>
            <p className="mt-1 text-sm text-white/70">
              내 목소리 가이드를 들으며 다시 부르면, 기존 비교 화면에서 음정 곡선·글자별 피드백·구간 반복·점수 변화를 볼 수 있어요. 가이드는 이 브라우저에 저장돼서 나중에도 고를 수
              있어요.
            </p>
          </div>
          <button
            onClick={() => {
              const name = `${(title || "원곡").slice(0, 30)} 내 목소리 가이드`;
              saveToLibrary({ kind: "cover", title: name, mix: tuned, vocals: tuned });
              setPendingGuide({ name, blob: tuned, origin: "cover" }, null);
              router.push("/compare");
            }}
            className="rounded-xl bg-white px-5 py-3 font-semibold text-ink hover:bg-white/90"
          >
            가이드로 비교 연습 →
          </button>
        </section>
      )}

      <section className="flex flex-wrap items-center gap-4 rounded-2xl border border-line p-5 sm:p-6">
        <div className="max-w-xl flex-1">
          <div className="text-sm font-semibold text-muted">다른 방법</div>
          <h2 className="mt-0.5 text-xl font-semibold">이 녹음의 멜로디로 연습곡 만들기</h2>
          <p className="mt-1 text-sm text-muted">
            방금 부른 멜로디를 그대로 읽어서 반주와 가이드 노래가 붙은 연습곡을 만들어요. 원곡 음원은 쓰지 않고 내 녹음만 써요(처음 30초까지).
            {tuned ? " 음정을 고친 가이드가 있어서 그걸로 읽어요." : ""} 원곡 멜로디를 따라 불렀다면 그 멜로디는 원곡 작곡가의 것이니, 혼자 연습이나 과제용으로만 써 주세요.
          </p>
        </div>
        <button
          onClick={() => {
            setPendingHum({
              source: { name: `${title.slice(0, 30)} 따라 부르기`, blob: tuned ?? take.blob, origin: "record" },
              video,
            });
            router.push("/practice");
          }}
          className="rounded-xl bg-guide px-5 py-3 font-semibold text-white hover:opacity-90"
        >
          연습곡 만들기 →
        </button>
      </section>

      <section className="rounded-2xl bg-surface p-4 sm:p-6">
        <h2 className="text-xl font-semibold">음별 피드백</h2>
        <p className="mt-1 text-sm text-muted">부른 음을 순서대로 보여 드려요. 눌러서 내 노래·교정본·원곡의 같은 부분을 들어 보세요.</p>
        <div className="mt-4 space-y-2.5">
          {lines.map((line, li) => (
            <div key={li} className="flex flex-wrap gap-1.5">
              {line.map((k) => {
                const n = c.notes[k];
                return (
                  <button
                    key={k}
                    onClick={() => setSel(sel === k ? null : k)}
                    title={n.text}
                    className={`flex min-w-[2.8rem] flex-col items-center rounded-lg px-2 pb-1 pt-1.5 leading-none ${sel === k ? "ring-2 ring-ink" : ""}`}
                    style={chip(n)}
                  >
                    <span className="text-sm font-bold">{pitchLabel(n.target)}</span>
                    <span className="mt-1 h-3 text-[10px] font-semibold">
                      {n.problems.includes("flat") ? "↓" : n.problems.includes("sharp") ? "↑" : n.problems.includes("unstable") ? "~" : n.problems.includes("outOfScale") ? "?" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span>↓ 낮음</span>
          <span>↑ 높음</span>
          <span>~ 흔들림</span>
          <span>? 음계 밖</span>
        </div>

        {cur && (
          <div className="mt-4 rounded-xl border border-line p-4">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-2xl font-bold">{pitchLabel(cur.target)}</span>
              <span className="text-sm text-muted">녹음 {cur.start.toFixed(1)}초 · 원곡 {fmt(take.videoStart + cur.start)}</span>
              <span className="font-semibold" style={{ color: chip(cur).color }}>
                {cur.text}
              </span>
            </div>
            {cur.problems.map((pr) => (
              <p key={pr} className="mt-2 max-w-prose text-[15px] leading-relaxed text-muted">
                <span className="font-semibold text-ink">이렇게 해 보세요. </span>
                {TIPS[pr]}
              </p>
            ))}
            <div className="mt-3 flex flex-wrap gap-2">
              <button onClick={() => playClip(mineEl.current, cur)} className="rounded-lg bg-mine px-3 py-1.5 text-sm font-semibold text-white">
                내 노래
              </button>
              {tunedUrl && (
                <button onClick={() => playClip(tunedEl.current, cur)} className="rounded-lg bg-good px-3 py-1.5 text-sm font-semibold text-white">
                  교정본
                </button>
              )}
              <button
                onClick={() => seekOriginal(take.videoStart + cur.start - 0.8, cur.dur + 1.4)}
                className="rounded-lg bg-guide px-3 py-1.5 text-sm font-semibold text-white"
              >
                원곡 이 부분
              </button>
            </div>
          </div>
        )}
        <div className="mt-5">
          <div className="mb-1 text-sm font-semibold">이번 녹음</div>
          <audio src={take.url} controls className="h-10 w-full max-w-xl" />
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div>
      <div className="text-sm text-white/60">{label}</div>
      <div className="mt-1 text-xl font-bold tabular-nums sm:text-2xl">{value}</div>
      <div className="text-xs text-white/45">{sub}</div>
    </div>
  );
}
