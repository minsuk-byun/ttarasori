"use client";

import { SAMPLE_RATE } from "./synth.ts";

/** 음원 파일(Blob)을 16kHz 모노 PCM으로 디코딩 */
export async function decodeToMono(blob: Blob, sr = SAMPLE_RATE): Promise<Float32Array> {
  const data = await blob.arrayBuffer();
  const AC: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  let buf: AudioBuffer;
  try {
    buf = await ctx.decodeAudioData(data);
  } catch {
    throw new Error("이 파일 형식은 열 수 없어요. mp3, wav, m4a 파일로 다시 올려 주세요.");
  } finally {
    ctx.close();
  }
  const maxSec = 8 * 60;
  const length = Math.ceil(Math.min(buf.duration, maxSec) * sr);
  const off = new OfflineAudioContext(1, length, sr);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination); // 다채널 → 모노 다운믹스는 자동
  src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}
