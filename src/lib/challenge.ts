"use client";

/**
 * 주간 챌린지 곡: 주 번호를 씨앗으로 모두에게 같은 새 곡을 브라우저에서 만들어요.
 * (원곡 없이 정해진 화성 진행 위에 자동 작곡 — 저작권 걱정 없음)
 */
import type { GameNote } from "./audio/game.ts";
import { encodeWav } from "./progress.ts";

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const PROG_MAJOR = [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]];
const PROG_MINOR = [[0, 3, 7], [8, 12, 15], [3, 7, 10], [10, 14, 17]];
const RHYTHMS = [[1, 1, 1, 1], [1.5, 0.5, 1, 1], [0.5, 0.5, 1, 2], [2, 1, 1], [1, 0.5, 0.5, 2], [1, 1, 2]];
const CADENCE = [[2, 2], [1, 3], [1, 1, 2]];
const ADJ = ["반짝이는", "느긋한", "설레는", "따뜻한", "푸른", "한밤의", "바람 부는", "노을 진", "첫눈 오는", "두근대는", "잔잔한", "신나는"];
const NOUN = ["산책", "골목", "기차", "편지", "바다", "옥상", "정류장", "여름밤", "아침", "창가", "자전거", "노래"];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 월요일 시작 주 번호 (예: 2026-W45) */
export function weekKey(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const wk = 1 + Math.round(((t.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${t.getUTCFullYear()}-W${String(wk).padStart(2, "0")}`;
}

export interface ChallengeSong {
  week: string;
  title: string;
  bpm: number;
  minor: boolean;
  tonic: number;
  notes: GameNote[];
  chords: number[][];
  total: number;
}

export function makeChallenge(week = weekKey()): ChallengeSong {
  let seed = 0;
  for (const ch of week) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const r = rng(seed);
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const minor = r() < 0.35;
  const bpm = 76 + Math.floor(r() * 30);
  const beat = 60 / bpm;
  // 남녀 모두 부르기 편한 가운데 음역 (옥타브는 판정에서 맞춰요)
  const tonic = 60 + pick([0, 2, -1, -3, 3]);
  const scale = minor ? MINOR : MAJOR;
  const prog = minor ? PROG_MINOR : PROG_MAJOR;
  const lo = tonic - 1;
  const hi = tonic + 12;
  const scaleNotes = [-1, 0, 1]
    .flatMap((k) => scale.map((o) => tonic + o + 12 * k))
    .filter((n) => n >= lo && n <= hi)
    .sort((a, b) => a - b);
  const notes: GameNote[] = [];
  const chords: number[][] = [];
  let prev = tonic + scale[2];
  let t = 0;
  const bars = 8;
  const syl = ["라", "라", "라", "아", "라", "랄", "라", "아"];
  for (let bar = 0; bar < bars; bar++) {
    const chord = prog[bar % 4];
    chords.push(chord.map((c) => tonic + c));
    const cset = new Set(chord.map((c) => c % 12));
    const chordNotes = scaleNotes.filter((n) => cset.has((((n - tonic) % 12) + 12) % 12));
    const phraseEnd = bar % 4 === 3;
    const rhythm = pick(phraseEnd ? CADENCE : RHYTHMS);
    let pos = 0;
    rhythm.forEach((beats, i) => {
      const lastOfSong = bar === bars - 1 && i === rhythm.length - 1;
      let pitch: number;
      if (lastOfSong) {
        const ts = scaleNotes.filter((n) => (n - tonic) % 12 === 0);
        pitch = ts.reduce((a, b) => (Math.abs(b - prev) < Math.abs(a - prev) ? b : a));
      } else if (pos === 0 || pos === 2) {
        const c = [...chordNotes].sort((a, b) => Math.abs(a - prev) - Math.abs(b - prev)).slice(0, 2);
        pitch = pick(c.length ? c : [prev]);
      } else {
        const idx = scaleNotes.reduce((bi, n, k) => (Math.abs(n - prev) < Math.abs(scaleNotes[bi] - prev) ? k : bi), 0);
        const step = pick([-2, -1, -1, 1, 1, 2]);
        pitch = scaleNotes[Math.max(0, Math.min(scaleNotes.length - 1, idx + step))];
      }
      notes.push({ midi: pitch, start: t + pos * beat, dur: beats * beat * 0.94, syllable: beats >= 2 ? "아" : syl[(bar + i) % syl.length] });
      prev = pitch;
      pos += beats;
    });
    t += 4 * beat;
  }
  return { week, title: `${pick(ADJ)} ${pick(NOUN)}`, bpm, minor, tonic, notes, chords, total: t + 1 };
}

/** 반주(화음·베이스·드럼)를 만들어 wav 로. 가이드 멜로디는 게임에서 따로 작게 들려줘요 */
export async function renderChallenge(song: ChallengeSong): Promise<Blob> {
  const sr = 32000;
  const lead = 0;
  const ctx = new OfflineAudioContext(1, Math.ceil((song.total + lead) * sr), sr);
  const beat = 60 / song.bpm;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(ctx.destination);
  const hz = (m: number) => 440 * 2 ** ((m - 69) / 12);
  const tone = (m: number, at: number, dur: number, type: OscillatorType, amp: number, attack = 0.02) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = hz(m);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(amp, at + attack);
    g.gain.setTargetAtTime(amp * 0.6, at + attack, dur * 0.4);
    g.gain.linearRampToValueAtTime(0, at + dur);
    o.connect(g).connect(master);
    o.start(at);
    o.stop(at + dur + 0.02);
  };
  // 노이즈 (하이햇·스네어)
  const noise = ctx.createBuffer(1, sr, sr);
  const nd = noise.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const hit = (at: number, dur: number, amp: number, hp: number) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.value = hp;
    const g = ctx.createGain();
    g.gain.setValueAtTime(amp, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + dur);
    s.connect(f).connect(g).connect(master);
    s.start(at);
    s.stop(at + dur);
  };
  const kick = (at: number) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(120, at);
    o.frequency.exponentialRampToValueAtTime(45, at + 0.12);
    g.gain.setValueAtTime(0.7, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + 0.25);
    o.connect(g).connect(master);
    o.start(at);
    o.stop(at + 0.26);
  };
  song.chords.forEach((ch, bar) => {
    const at = lead + bar * 4 * beat;
    for (const m of ch) tone(m - 12, at, 4 * beat - 0.05, "triangle", 0.07, 0.08);
    for (let b = 0; b < 4; b++) {
      tone(ch[0] - 24, at + b * beat, beat * 0.8, "sine", 0.22);
      if (b % 2 === 0) kick(at + b * beat);
      else hit(at + b * beat, 0.12, 0.18, 1800);
      hit(at + b * beat + beat / 2, 0.04, 0.06, 7000);
    }
  });
  const out = await ctx.startRendering();
  return encodeWav(out.getChannelData(0), sr);
}

/** 이 기기 이름표 (랭킹용, 이 브라우저에만 저장) */
export function deviceId(): string {
  try {
    let id = localStorage.getItem("ttarasori-device");
    if (!id) {
      id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9-]/g, "").slice(0, 36);
      localStorage.setItem("ttarasori-device", id);
    }
    return id;
  } catch {
    return "anon";
  }
}

export function getNickname(): string {
  try {
    return localStorage.getItem("ttarasori-nickname") ?? "";
  } catch {
    return "";
  }
}
export function setNickname(n: string) {
  try {
    localStorage.setItem("ttarasori-nickname", n);
  } catch {
    /* 무시 */
  }
}
