"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Which = "guide" | "mine" | "tuned";

export interface PlayOptions {
  /** 끝나면 이어서 할 일 (번갈아 듣기) */
  then?: () => void;
  /** 재생 속도 (음높이는 그대로) */
  rate?: number;
  /** 구간 반복 */
  loop?: boolean;
}

/**
 * AI 커버(가이드) · 내 노래 · 교정본을 같은 시간축(가이드 기준)으로 구간 재생.
 * 내 노래와 교정본은 녹음 시작 시점 차이(lagSec)만큼 밀어서 재생해요.
 */
export function usePlayer(sources: { guide: Blob; mine: Blob; tuned?: Blob | null }, lagSec: number) {
  const els = useRef<Partial<Record<Which, HTMLAudioElement>>>({});
  const [playing, setPlaying] = useState<Which | null>(null);
  const [head, setHead] = useState<number | null>(null);
  const raf = useRef(0);
  const queue = useRef<(() => void) | null>(null);

  const attach = (which: Which, blob: Blob | null | undefined) => {
    if (!blob) return () => {};
    const u = URL.createObjectURL(blob);
    const a = new Audio(u);
    a.preload = "auto";
    els.current[which] = a;
    return () => {
      a.pause();
      URL.revokeObjectURL(u);
      if (els.current[which] === a) delete els.current[which];
    };
  };

  useEffect(() => attach("guide", sources.guide), [sources.guide]);
  useEffect(() => attach("mine", sources.mine), [sources.mine]);
  useEffect(() => attach("tuned", sources.tuned), [sources.tuned]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const pauseAll = () => Object.values(els.current).forEach((a) => a?.pause());

  const stop = useCallback(() => {
    pauseAll();
    cancelAnimationFrame(raf.current);
    queue.current = null;
    setPlaying(null);
    setHead(null);
  }, []);

  const play = useCallback(
    (which: Which, start: number, end: number, opts: PlayOptions = {}) => {
      pauseAll();
      cancelAnimationFrame(raf.current);
      const a = els.current[which];
      if (!a) return;
      const off = which === "guide" ? 0 : lagSec;
      const seekTo = Math.max(0, start + off);
      a.playbackRate = opts.rate ?? 1;
      a.preservesPitch = true;
      a.currentTime = seekTo;
      void a.play();
      setPlaying(which);
      queue.current = opts.then ?? null;
      const tick = () => {
        const t = a.currentTime - off;
        setHead(t);
        if (t >= end || a.ended) {
          if (opts.loop) {
            a.currentTime = seekTo;
            void a.play();
          } else {
            a.pause();
            const next = queue.current;
            queue.current = null;
            if (next) next();
            else {
              setPlaying(null);
              setHead(null);
            }
            return;
          }
        }
        raf.current = requestAnimationFrame(tick);
      };
      raf.current = requestAnimationFrame(tick);
    },
    [lagSec],
  );

  return { play, stop, playing, head };
}

export type Player = ReturnType<typeof usePlayer>;
