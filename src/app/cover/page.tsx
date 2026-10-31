"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AudioInput from "@/components/AudioInput";
import { createJob, fetchChunked, getGpuConfig, getJob, resultUrl, type GpuConfig } from "@/lib/gpu";
import { getSample } from "@/lib/samples";
import { setPendingGuide, type AudioSource } from "@/lib/store";

const COVER_STEPS = ["음원 올리기", "보컬과 반주 분리", "내 목소리로 변환", "반주와 합치기"];

type CoverState =
  | { kind: "idle" }
  | { kind: "running"; step: number; detail?: string }
  | { kind: "done"; mixUrl: string; vocals: Blob | null }
  | { kind: "error"; msg: string };

export default function CoverPage() {
  const router = useRouter();
  const [gpu, setGpu] = useState<GpuConfig | null>(null);
  const [voice, setVoice] = useState<AudioSource | null>(null);
  const [voiceReady, setVoiceReady] = useState(false);
  const [song, setSong] = useState<AudioSource | null>(null);
  const [key, setKey] = useState(0);
  const [state, setState] = useState<CoverState>({ kind: "idle" });
  const [moving, setMoving] = useState(false);
  const alive = useRef(true);
  const localUrl = useRef<string | null>(null);

  useEffect(() => {
    getGpuConfig().then(setGpu);
    return () => {
      alive.current = false;
      if (localUrl.current) URL.revokeObjectURL(localUrl.current);
    };
  }, []);

  const live = gpu?.enabled === true;
  const keyLabel = key === 0 ? "원키" : `${key > 0 ? "+" : ""}${key}키`;

  async function makeCover() {
    if (!voice || !song) return;
    if (!live) return fakeCover();
    try {
      const cfg = await getGpuConfig(); // 토큰 새로 받기
      if (!cfg.enabled) throw new Error("GPU 서버 설정이 꺼져 있어요.");
      setState({ kind: "running", step: 0, detail: "0%" });
      const id = await createJob(cfg, song.blob, song.name, voice.blob, voice.name, key, (p) =>
        setState({ kind: "running", step: 0, detail: `${Math.round(p * 100)}%` }),
      );
      while (alive.current) {
        await new Promise((r) => setTimeout(r, 2000));
        const s = await getJob(cfg, id);
        if (s.status === "error") throw new Error(s.error ?? "AI 커버를 만들지 못했어요.");
        if (s.status === "done") {
          setState({ kind: "running", step: 3, detail: "결과 받는 중" });
          const [mix, vocals] = await Promise.all([
            fetchChunked(resultUrl(cfg, id, "mix"), "audio/mpeg"),
            fetchChunked(resultUrl(cfg, id, "vocals"), "audio/wav"),
          ]);
          if (localUrl.current) URL.revokeObjectURL(localUrl.current);
          localUrl.current = URL.createObjectURL(mix);
          setState({ kind: "done", mixUrl: localUrl.current, vocals });
          return;
        }
        const step = s.status === "queued" ? 1 : s.step.includes("분리") ? 1 : s.step.includes("변환") ? 2 : 3;
        setState({
          kind: "running",
          step,
          detail: s.status === "queued" ? "앞선 작업을 기다리는 중" : step === 2 ? "곡 길이에 따라 몇 분 걸려요" : undefined,
        });
      }
    } catch (e) {
      setState({ kind: "error", msg: e instanceof Error ? e.message : "AI 커버를 만들지 못했어요." });
    }
  }

  /** GPU 서버가 연결되지 않았을 때: 흐름만 보여 주고 원곡을 결과로 돌려줌 */
  function fakeCover() {
    if (!song) return;
    let i = 0;
    setState({ kind: "running", step: 0 });
    const t = setInterval(() => {
      i++;
      if (!alive.current) return clearInterval(t);
      if (i < COVER_STEPS.length) setState({ kind: "running", step: i });
      else {
        clearInterval(t);
        if (localUrl.current) URL.revokeObjectURL(localUrl.current);
        localUrl.current = URL.createObjectURL(song.blob);
        setState({ kind: "done", mixUrl: localUrl.current, vocals: null });
      }
    }, 1000);
  }

  async function goCompare() {
    if (state.kind !== "done" || !song) return;
    setMoving(true);
    try {
      if (state.vocals) {
        setPendingGuide({ name: "ai-cover-vocals.wav", blob: state.vocals, origin: "cover" });
      } else {
        setPendingGuide({ ...song, name: `ai-cover-${song.name}`, origin: "cover" });
      }
      router.push("/compare");
    } catch {
      setMoving(false);
      setState({ kind: "error", msg: "AI 보컬을 불러오지 못했어요. 다시 시도해 주세요." });
    }
  }

  const running = state.kind === "running";

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">AI 커버 만들기</h1>
      <p className="mt-3 text-[17px] leading-relaxed text-muted">
        내 목소리 10~30초만 있으면, 어떤 노래든 내 목소리로 부른 커버를 만들 수 있어요.
      </p>
      {gpu && !live && (
        <p className="mt-4 rounded-xl bg-guide-soft px-4 py-3 text-sm leading-relaxed text-guide">
          지금은 음성 변환 서버가 연결되어 있지 않아, 진행 과정만 보여 주고 올린 노래를 그대로 결과로 돌려 드려요.
        </p>
      )}

      <ol className="mt-10 space-y-10">
        <Step n={1} title="내 목소리 등록" done={voiceReady}>
          <AudioInput
            label="목소리 샘플"
            hint="반주 없이 편하게 부른 노래를 10~30초 올리거나 녹음해 주세요. 조용한 곳에서 녹음할수록 결과가 좋아요."
            tone="mine"
            value={voice}
            onChange={(v) => {
              setVoice(v);
              setVoiceReady(false);
              setState({ kind: "idle" });
            }}
            allowRecord
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {!voiceReady && (
              <button
                disabled={!voice}
                onClick={() => setVoiceReady(true)}
                className="rounded-xl bg-ink px-5 py-2.5 font-semibold text-white disabled:opacity-35"
              >
                이 목소리로 등록하기
              </button>
            )}
            {!voice && (
              <button onClick={() => setVoice(getSample("mine"))} className="rounded-xl px-3 py-2.5 text-sm font-semibold text-guide hover:bg-guide-soft">
                샘플 목소리 쓰기
              </button>
            )}
          </div>
          {voiceReady && <p className="mt-3 text-sm text-good">목소리가 등록됐어요. 커버를 만들 때 이 음색을 써요.</p>}
        </Step>

        <Step n={2} title="부를 노래 고르기" done={state.kind === "done"} disabled={!voiceReady}>
          <AudioInput
            label="원곡"
            hint="커버하고 싶은 노래 파일을 올려 주세요(8분, 60MB 이하). 보컬은 자동으로 분리돼요."
            tone="guide"
            value={song}
            onChange={(v) => {
              setSong(v);
              setState({ kind: "idle" });
            }}
          />
          {!song && (
            <button onClick={() => setSong(getSample("guide"))} className="mt-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-guide hover:bg-guide-soft">
              샘플 노래 쓰기
            </button>
          )}
          <div className="mt-5 rounded-xl bg-surface p-5">
            <div className="flex items-center justify-between">
              <label htmlFor="key" className="font-semibold">
                키 조절
              </label>
              <span className="tabular-nums text-muted">{keyLabel}</span>
            </div>
            <input
              id="key"
              type="range"
              min={-12}
              max={12}
              value={key}
              disabled={running}
              onChange={(e) => setKey(Number(e.target.value))}
              className="mt-3 w-full accent-guide"
            />
            <p className="mt-1 text-sm text-muted">원곡이 내 음역대보다 높거나 낮으면 키를 맞춰 보세요. 남녀 키 차이는 보통 5~7키예요.</p>
          </div>
        </Step>

        <Step n={3} title="커버 만들기" disabled={!voiceReady || !song}>
          {state.kind !== "done" && (
            <button
              disabled={!voiceReady || !song || running}
              onClick={makeCover}
              className="rounded-xl bg-guide px-6 py-3 font-semibold text-white disabled:opacity-35"
            >
              내 목소리로 커버 만들기
            </button>
          )}
          {state.kind === "running" && <Progress step={state.step} detail={state.detail} />}
          {state.kind === "error" && <p className="mt-4 rounded-xl bg-mine-soft px-4 py-3 text-bad">{state.msg}</p>}
          {state.kind === "done" && (
            <div className="mt-4 rounded-2xl bg-ink p-5 text-white">
              <div className="font-semibold">커버가 완성됐어요</div>
              <div className="mt-0.5 text-sm text-white/60">
                {song?.name}, {keyLabel}
              </div>
              <audio src={state.mixUrl} controls className="mt-4 h-10 w-full" />
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  onClick={goCompare}
                  disabled={moving}
                  className="rounded-lg bg-mine px-4 py-2.5 text-sm font-semibold hover:brightness-110 disabled:opacity-50"
                >
                  이 커버와 내 노래 비교하기
                </button>
                <a
                  href={state.mixUrl}
                  download={`ttarasori-cover-${song?.name ?? "song"}`}
                  className="rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20"
                >
                  커버 다운로드
                </a>
                {state.vocals && <VocalsDownload blob={state.vocals} />}
                <button onClick={() => setState({ kind: "idle" })} className="rounded-lg px-4 py-2.5 text-sm font-semibold text-white/70 hover:text-white">
                  다시 만들기
                </button>
              </div>
            </div>
          )}
        </Step>
      </ol>
    </main>
  );
}

function Step({
  n,
  title,
  done,
  disabled,
  children,
}: {
  n: number;
  title: string;
  done?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className={`grid grid-cols-[36px_1fr] gap-4 transition-opacity ${disabled ? "pointer-events-none opacity-40" : ""}`} aria-disabled={disabled}>
      <span
        className={`grid h-9 w-9 place-items-center rounded-full text-sm font-bold ${done ? "bg-good text-white" : "border-2 border-ink"}`}
        aria-hidden
      >
        {done ? "✓" : n}
      </span>
      <div>
        <h2 className="pt-1 text-xl font-semibold">{title}</h2>
        <div className="mt-4">{children}</div>
      </div>
    </li>
  );
}

function Progress({ step, detail }: { step: number; detail?: string }) {
  return (
    <ul className="mt-4 space-y-2" role="status">
      {COVER_STEPS.map((s, i) => (
        <li key={s} className={`flex items-center gap-2 text-sm ${i > step ? "text-muted/60" : i === step ? "font-semibold" : "text-muted"}`}>
          <span
            className={`h-2 w-2 rounded-full ${i < step ? "bg-good" : i === step ? "animate-pulse bg-guide" : "bg-line"}`}
            aria-hidden
          />
          {s}
          {i < step && <span className="text-good">완료</span>}
          {i === step && detail && <span className="font-normal text-muted">{detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function VocalsDownload({ blob }: { blob: Blob }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  if (!url) return null;
  return (
    <a href={url} download="ttarasori-ai-vocals.wav" className="rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20">
      AI 보컬만 다운로드
    </a>
  );
}
