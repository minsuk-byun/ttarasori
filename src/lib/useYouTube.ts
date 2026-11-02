"use client";

import { useEffect, useRef, useState } from "react";

/**
 * 유튜브 공식 IFrame 플레이어 (재생·멈춤·이동·속도만 조절하고, 소리 자체에는 접근하지 않아요)
 * https://developers.google.com/youtube/iframe_api_reference
 */
export interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  setPlaybackRate(rate: number): void;
  getPlayerState(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string;
      host?: string;
      width?: string;
      height?: string;
      playerVars?: Record<string, number | string>;
      events?: { onReady?: () => void; onStateChange?: (e: { data: number }) => void };
    },
  ) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let loading: Promise<YTNamespace> | null = null;
function loadApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!loading) {
    loading = new Promise((resolve) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve(window.YT!);
      };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      document.head.appendChild(s);
    });
  }
  return loading;
}

export const YT_PLAYING = 1;

/** 유튜브 링크/ID 에서 영상 ID 꺼내기 */
export function parseVideoId(text: string): string | null {
  const t = text.trim();
  if (/^[\w-]{11}$/.test(t)) return t;
  const m =
    t.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/) ??
    t.match(/[?&]v=([\w-]{11})/);
  return m ? m[1] : null;
}

export function useYouTube(videoId: string | null) {
  const mount = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (!videoId || !mount.current) return;
    let alive = true;
    setReady(false);
    const el = document.createElement("div");
    mount.current.innerHTML = "";
    mount.current.appendChild(el);
    loadApi().then((YT) => {
      if (!alive) return;
      player.current = new YT.Player(el, {
        videoId,
        host: "https://www.youtube-nocookie.com",
        width: "100%",
        height: "100%",
        playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
        events: {
          onReady: () => {
            if (!alive) return;
            setReady(true);
            setDuration(player.current?.getDuration() ?? 0);
          },
          onStateChange: (e) => alive && setPlaying(e.data === YT_PLAYING),
        },
      });
    });
    const iv = window.setInterval(() => {
      const p = player.current;
      if (p && typeof p.getCurrentTime === "function") setTime(p.getCurrentTime() || 0);
    }, 100);
    return () => {
      alive = false;
      clearInterval(iv);
      try {
        player.current?.destroy();
      } catch {
        /* 무시 */
      }
      player.current = null;
      setReady(false);
      setPlaying(false);
    };
  }, [videoId]);

  return { mount, player, ready, playing, time, duration };
}
