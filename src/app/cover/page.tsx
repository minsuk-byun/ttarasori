"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AudioInput from "@/components/AudioInput";
import { getSample } from "@/lib/samples";
import { setPendingGuide, type AudioSource } from "@/lib/store";

const VOICE_STEPS = ["목소리 특징 분석", "음색 모델 학습", "모델 저장"];
const COVER_STEPS = ["보컬과 반주 분리", "원곡 음정 추출", "내 목소리로 변환", "반주와 합치기"];

/**
 * 실제 서비스에서는 각 단계에서 /api/voice, /api/cover 를 호출해
 * GPU 서버(예: RVC·so-vits-svc 모델)에서 학습·변환한 결과를 받아오면 돼요.
 * 데모에서는 화면 흐름만 보여 주기 위해 진행 상황을 흉내 내요.
 */
function useFakeJob(steps: string[], msPerStep: number) {
  const [state, setState] = useState<{ step: number; running: boolean; done: boolean }>({
    step: -1,
    running: false,
    done: false,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const start = () => {
    setState({ step: 0, running: true, done: false });
    const next = (i: number) => {
      timer.current = setTimeout(() => {
        if (i + 1 < steps.length) {
          setState({ step: i + 1, running: true, done: false });
          next(i + 1);
        } else setState({ step: steps.length, running: false, done: true });
      }, msPerStep);
    };
    next(0);
  };
  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    setState({ step: -1, running: false, done: false });
  };
  return { ...state, start, reset };
}

export default function CoverPage() {
  const router = useRouter();
  const [voice, setVoice] = useState<AudioSource | null>(null);
  const [song, setSong] = useState<AudioSource | null>(null);
  const [key, setKey] = useState(0);
  const voiceJob = useFakeJob(VOICE_STEPS, 900);
  const coverJob = useFakeJob(COVER_STEPS, 1100);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!coverJob.done || !song) return setCoverUrl(null);
    const u = URL.createObjectURL(song.blob);
    setCoverUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [coverJob.done, song]);

  const goCompare = () => {
    if (!song) return;
    setPendingGuide({ ...song, name: `ai-cover-${song.name}`, origin: "cover" });
    router.push("/compare");
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">AI 커버 만들기</h1>
      <p className="mt-3 text-[17px] leading-relaxed text-muted">
        내 목소리를 한 번 등록해 두면, 어떤 노래든 내 목소리로 부른 커버를 만들 수 있어요.
      </p>
      <p className="mt-4 rounded-xl bg-guide-soft px-4 py-3 text-sm leading-relaxed text-guide">
        데모 버전에서는 음성 변환 서버가 연결되어 있지 않아, 진행 과정만 보여 주고 올린 노래를 그대로 결과로 돌려 드려요.
      </p>

      <ol className="mt-10 space-y-10">
        {/* 1. 목소리 등록 */}
        <Step n={1} title="내 목소리 등록" done={voiceJob.done}>
          <AudioInput
            label="목소리 샘플"
            hint="반주 없이 편하게 부른 노래나 책 읽은 녹음을 1분 이상 올려 주세요. 길수록 더 비슷해져요."
            tone="mine"
            value={voice}
            onChange={(v) => {
              setVoice(v);
              voiceJob.reset();
            }}
            allowRecord
          />
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {!voiceJob.done && (
              <button
                disabled={!voice || voiceJob.running}
                onClick={voiceJob.start}
                className="rounded-xl bg-ink px-5 py-2.5 font-semibold text-white disabled:opacity-35"
              >
                목소리 모델 만들기
              </button>
            )}
            {!voice && (
              <button onClick={() => setVoice(getSample("mine"))} className="rounded-xl px-3 py-2.5 text-sm font-semibold text-guide hover:bg-guide-soft">
                샘플 목소리 쓰기
              </button>
            )}
          </div>
          <Progress steps={VOICE_STEPS} step={voiceJob.step} />
          {voiceJob.done && (
            <div className="mt-4 flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-mine text-white" aria-hidden>
                <svg width="18" height="18" viewBox="0 0 18 18">
                  <rect x="6" y="1" width="6" height="11" rx="3" fill="currentColor" />
                  <path d="M3 8a6 6 0 0 0 12 0M9 14v3" stroke="currentColor" strokeWidth="1.6" fill="none" />
                </svg>
              </span>
              <div>
                <div className="font-semibold">내 목소리 모델이 준비됐어요</div>
                <div className="text-sm text-muted">{voice?.name}로 만들었어요</div>
              </div>
            </div>
          )}
        </Step>

        {/* 2. 노래 고르기 */}
        <Step n={2} title="부를 노래 고르기" done={coverJob.done} disabled={!voiceJob.done}>
          <AudioInput
            label="원곡"
            hint="커버하고 싶은 노래 파일을 올려 주세요. 보컬은 자동으로 분리돼요."
            tone="guide"
            value={song}
            onChange={(v) => {
              setSong(v);
              coverJob.reset();
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
              <span className="tabular-nums text-muted">{key === 0 ? "원키" : `${key > 0 ? "+" : ""}${key}키`}</span>
            </div>
            <input
              id="key"
              type="range"
              min={-6}
              max={6}
              value={key}
              onChange={(e) => setKey(Number(e.target.value))}
              className="mt-3 w-full accent-guide"
            />
            <p className="mt-1 text-sm text-muted">원곡이 내 음역대보다 높거나 낮으면 키를 맞춰 보세요. 남녀 키 차이는 보통 5~7키예요.</p>
          </div>
        </Step>

        {/* 3. 커버 만들기 */}
        <Step n={3} title="커버 만들기" disabled={!voiceJob.done || !song}>
          {!coverJob.done && (
            <button
              disabled={!voiceJob.done || !song || coverJob.running}
              onClick={coverJob.start}
              className="rounded-xl bg-guide px-6 py-3 font-semibold text-white disabled:opacity-35"
            >
              내 목소리로 커버 만들기
            </button>
          )}
          <Progress steps={COVER_STEPS} step={coverJob.step} />
          {coverJob.done && coverUrl && (
            <div className="mt-4 rounded-2xl bg-ink p-5 text-white">
              <div className="font-semibold">커버가 완성됐어요</div>
              <div className="mt-0.5 text-sm text-white/60">
                {song?.name}, {key === 0 ? "원키" : `${key > 0 ? "+" : ""}${key}키`}
              </div>
              <audio src={coverUrl} controls className="mt-4 h-10 w-full" />
              <div className="mt-4 flex flex-wrap gap-2">
                <button onClick={goCompare} className="rounded-lg bg-mine px-4 py-2.5 text-sm font-semibold hover:brightness-110">
                  이 커버와 내 노래 비교하기
                </button>
                <a href={coverUrl} download={`ai-cover-${song?.name ?? "song"}`} className="rounded-lg bg-white/10 px-4 py-2.5 text-sm font-semibold hover:bg-white/20">
                  다운로드
                </a>
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

function Progress({ steps, step }: { steps: string[]; step: number }) {
  if (step < 0) return null;
  return (
    <ul className="mt-4 space-y-2" role="status">
      {steps.map((s, i) => (
        <li key={s} className={`flex items-center gap-2 text-sm ${i > step ? "text-muted/60" : i === step ? "font-semibold" : "text-muted"}`}>
          <span
            className={`h-2 w-2 rounded-full ${i < step ? "bg-good" : i === step ? "animate-pulse bg-guide" : "bg-line"}`}
            aria-hidden
          />
          {s}
          {i < step && <span className="text-good">완료</span>}
        </li>
      ))}
    </ul>
  );
}
