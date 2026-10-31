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

export const resultUrl = (cfg: GpuConfig, id: string, kind: "mix" | "vocals") =>
  `${cfg.url}/jobs/${id}/${kind}?t=${encodeURIComponent(cfg.token ?? "")}`;
