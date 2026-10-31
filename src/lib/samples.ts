"use client";

import { encodeWav, renderSample, SAMPLE_RATE } from "./audio/synth.ts";
import type { AudioSource } from "./store";

const cache: Partial<Record<"guide" | "mine", AudioSource>> = {};

export function getSample(kind: "guide" | "mine"): AudioSource {
  if (!cache[kind]) {
    const wav = encodeWav(renderSample(kind), SAMPLE_RATE);
    cache[kind] = {
      name: kind === "guide" ? "sample-ai-cover.wav" : "sample-my-singing.wav",
      blob: new Blob([wav as BlobPart], { type: "audio/wav" }),
      origin: "sample",
    };
  }
  return cache[kind]!;
}
