"use client";

/** 페이지 이동 사이에 음원을 넘기기 위한 간단한 메모리 저장소 (데모용) */
export interface AudioSource {
  name: string;
  blob: Blob;
  origin: "file" | "record" | "sample" | "cover";
}

let pendingGuide: AudioSource | null = null;
let pendingPlayAlong: AudioSource | null = null;

/** guide: 비교 기준(보컬), playAlong: 녹음할 때 틀어 줄 음원(반주 포함 연습곡 등) */
export function setPendingGuide(src: AudioSource, playAlong: AudioSource | null = null) {
  pendingGuide = src;
  pendingPlayAlong = playAlong;
}

export function takePendingGuide(): { guide: AudioSource; playAlong: AudioSource | null } | null {
  if (!pendingGuide) return null;
  const s = { guide: pendingGuide, playAlong: pendingPlayAlong };
  pendingGuide = null;
  pendingPlayAlong = null;
  return s;
}

/** 커버 페이지에서 등록한 목소리를 연습곡 페이지에서도 쓰기 위해 보관 (새로고침하면 사라져요) */
let registeredVoice: AudioSource | null = null;

export function setRegisteredVoice(src: AudioSource | null) {
  registeredVoice = src;
}

export function getRegisteredVoice(): AudioSource | null {
  return registeredVoice;
}
