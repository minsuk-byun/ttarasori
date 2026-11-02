"use client";

/** VESSL GPU 서버와 통신 */

export interface GpuConfig {
  enabled: boolean;
  url?: string;
  token?: string;
}

export interface JobStatus {
  status: "queued" | "running" | "done" | "error";
  step: string;
  progress: number;
  error?: string | null;
  stats?: { fixed_ratio: number; mean_cents_before: number; mean_cents_after: number } | null;
}

export async function getGpuConfig(): Promise<GpuConfig> {
  try {
    const r = await fetch("/api/cover/token", { cache: "no-store" });
    if (!r.ok) return { enabled: false };
    return (await r.json()) as GpuConfig;
  } catch {
    return { enabled: false };
  }
}

/** 업로드 진행률을 보여 주려고 XHR 사용 */
export function createJob(
  cfg: GpuConfig,
  song: Blob,
  songName: string,
  voice: Blob,
  voiceName: string,
  key: number,
  onUpload: (p: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("song", song, songName);
    fd.append("voice", voice, voiceName.includes(".") ? voiceName : `${voiceName}.webm`);
    fd.append("key", String(key));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${cfg.url}/jobs`);
    xhr.setRequestHeader("Authorization", `Bearer ${cfg.token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onUpload(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body.id);
        else reject(new Error(body.detail ?? "AI 커버 요청이 거절됐어요."));
      } catch {
        reject(new Error(`GPU 서버 응답을 읽지 못했어요 (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("GPU 서버에 연결하지 못했어요. VESSL 서비스가 켜져 있는지 확인해 주세요."));
    xhr.send(fd);
  });
}

export async function getJob(cfg: GpuConfig, id: string): Promise<JobStatus> {
  const r = await fetch(`${cfg.url}/jobs/${id}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!r.ok) throw new Error("작업 상태를 불러오지 못했어요.");
  return (await r.json()) as JobStatus;
}

export const resultUrl = (cfg: GpuConfig, id: string, kind: "mix" | "vocals" | "tuned") =>
  `${cfg.url}/jobs/${id}/${kind}?t=${encodeURIComponent(cfg.token ?? "")}`;

/**
 * 결과 파일을 256KB씩 나눠 받기.
 * 무료 터널에서 큰 응답이 중간에 끊기는 경우가 있어서 Range 요청으로 나눠 받고, 실패한 조각은 다시 받아요.
 */
export async function fetchChunked(url: string, type: string, chunk = 256 * 1024): Promise<Blob> {
  const parts: ArrayBuffer[] = [];
  for (let start = 0; ; start += chunk) {
    let buf: ArrayBuffer | null = null;
    let status = 0;
    for (let attempt = 0; attempt < 5 && !buf; attempt++) {
      try {
        const r = await fetch(url, { headers: { Range: `bytes=${start}-${start + chunk - 1}` }, cache: "no-store" });
        status = r.status;
        if (r.status === 416) break; // 파일 끝을 넘김
        if (r.ok) buf = await r.arrayBuffer();
      } catch {
        buf = null;
      }
      if (!buf && status !== 416) await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
    if (status === 416) break;
    if (!buf) throw new Error("결과 파일을 받는 중 연결이 끊겼어요. 다시 만들기를 눌러 주세요.");
    if (status === 200) return new Blob([buf], { type }); // 서버가 Range를 무시하고 전체를 줌
    parts.push(buf);
    if (buf.byteLength < chunk) break;
  }
  return new Blob(parts, { type });
}

export interface PracticeRequest {
  prompt: string;
  bpm: number;
  minor: boolean;
  low: boolean;
  seed: number;
  lyrics?: string;
  voice?: { blob: Blob; name: string } | null;
}

export function createPracticeJob(cfg: GpuConfig, req: PracticeRequest, onUpload: (p: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("prompt", req.prompt);
    fd.append("bpm", String(req.bpm));
    fd.append("minor", String(req.minor));
    fd.append("low", String(req.low));
    fd.append("seed", String(req.seed));
    if (req.lyrics) fd.append("lyrics", req.lyrics);
    if (req.voice) fd.append("voice", req.voice.blob, req.voice.name.includes(".") ? req.voice.name : `${req.voice.name}.webm`);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${cfg.url}/practice`);
    xhr.setRequestHeader("Authorization", `Bearer ${cfg.token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onUpload(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body.id);
        else if (xhr.status === 404) reject(new Error("GPU 서버가 아직 연습곡 기능을 모르는 버전이에요. 서버를 새로 시작해야 해요."));
        else reject(new Error(body.detail ?? "연습곡 요청이 거절됐어요."));
      } catch {
        reject(new Error(`GPU 서버 응답을 읽지 못했어요 (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("GPU 서버에 연결하지 못했어요. VESSL 서비스가 켜져 있는지 확인해 주세요."));
    xhr.send(fd);
  });
}

export interface PracticeNotes {
  notes: { midi: number; start: number; dur: number; syllable: string }[];
  duration: number;
  bpm: number;
  tonic: number;
  lyrics?: boolean;
  sung?: boolean;
  /** 가사 노래 정보: 쓴 읽기 모델, 음성 인식으로 잰 또렷함(0~1) */
  sing_info?: { engine: string; clarity: number; tried: number; pron: string } | null;
}

export async function getNotes(cfg: GpuConfig, id: string): Promise<PracticeNotes> {
  const r = await fetch(`${cfg.url}/jobs/${id}/notes`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!r.ok) throw new Error("멜로디 정보를 불러오지 못했어요.");
  return (await r.json()) as PracticeNotes;
}

/** 내 녹음의 음정만 고친 교정본 만들기. target.midi 는 내 녹음 시간축 기준 목표 음 */
export function createTuneJob(
  cfg: GpuConfig,
  mine: Blob,
  target: { hop: number; midi: (number | null)[] },
  onUpload: (p: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    // 예전 서버는 업로드를 mine.<확장자> 로 저장한 뒤 mine.wav 로 변환해서, .wav 로 보내면 이름이 겹쳐 실패했어요.
    // 서버가 내용을 보고 형식을 알아내므로 wav 는 .wave 로 보내요.
    const ext = mine.type.includes("mpeg") ? "mp3" : mine.type.includes("wav") ? "wave" : mine.type.includes("mp4") ? "m4a" : "webm";
    fd.append("mine", mine, `mine.${ext}`);
    fd.append("target", JSON.stringify({ hop: target.hop, midi: target.midi.map((v) => (v == null ? null : Math.round(v * 100) / 100)) }));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${cfg.url}/tune`);
    xhr.setRequestHeader("Authorization", `Bearer ${cfg.token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onUpload(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body.id);
        else if (xhr.status === 404) reject(new Error("GPU 서버가 아직 교정본 기능을 모르는 버전이에요. 서버를 새로 시작해야 해요."));
        else reject(new Error(body.detail ?? "교정본 요청이 거절됐어요."));
      } catch {
        reject(new Error(`GPU 서버 응답을 읽지 못했어요 (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("GPU 서버에 연결하지 못했어요. VESSL 서버가 켜져 있는지 확인해 주세요."));
    xhr.send(fd);
  });
}

export interface Transcript {
  text: string;
  chunks: { text: string; start: number | null; end: number | null }[];
}

/** 발음 진단: 내 녹음(필수)과 가이드 보컬(가사를 모를 때)을 음성 인식 */
export function createPronounceJob(cfg: GpuConfig, mine: Blob, guide: Blob | null, onUpload: (p: number) => void): Promise<string> {
  const ext = (b: Blob) => (b.type.includes("mpeg") ? "mp3" : b.type.includes("wav") ? "wave" : b.type.includes("mp4") ? "m4a" : "webm");
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("mine", mine, `mine.${ext(mine)}`);
    if (guide) fd.append("guide", guide, `guide.${ext(guide)}`);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${cfg.url}/pronounce`);
    xhr.setRequestHeader("Authorization", `Bearer ${cfg.token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onUpload(e.loaded / e.total);
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(body.id);
        else if (xhr.status === 404) reject(new Error("GPU 서버가 아직 발음 진단 기능을 모르는 버전이에요. 서버를 새로 시작해야 해요."));
        else reject(new Error(body.detail ?? "발음 진단 요청이 거절됐어요."));
      } catch {
        reject(new Error(`GPU 서버 응답을 읽지 못했어요 (HTTP ${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("GPU 서버에 연결하지 못했어요. VESSL 서버가 켜져 있는지 확인해 주세요."));
    xhr.send(fd);
  });
}

export async function getPronounceResult(cfg: GpuConfig, id: string): Promise<{ mine: Transcript; guide?: Transcript }> {
  const r = await fetch(`${cfg.url}/jobs/${id}/result`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!r.ok) throw new Error("발음 진단 결과를 불러오지 못했어요.");
  return r.json();
}
