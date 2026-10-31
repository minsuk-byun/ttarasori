"use client";

/** 페이지 이동 사이에 음원을 넘기기 위한 간단한 메모리 저장소 (데모용) */
export interface AudioSource {
  name: string;
  blob: Blob;
  origin: "file" | "record" | "sample" | "cover";
}

let pendingGuide: AudioSource | null = null;

export function setPendingGuide(src: AudioSource) {
  pendingGuide = src;
}

export function takePendingGuide(): AudioSource | null {
  const s = pendingGuide;
  pendingGuide = null;
  return s;
}
