"use client";

/**
 * 재생과 같은 시계(AudioContext)로 마이크 녹음.
 * 언제 소리를 틀었는지와 언제 녹음된 소리인지를 같은 기준으로 알 수 있어서 박자 채점이 정확해요.
 */
export interface Capture {
  ctx: AudioContext;
  /** from~to (ctx 시간) 구간의 녹음을 16kHz 로 돌려줌 */
  take: (from: number, to: number) => Promise<Float32Array>;
  level: () => number;
  close: () => void;
  /** 내가 소리를 듣고 반응해 부른 소리가 녹음에 들어오기까지의 대략 지연 (초) */
  latency: number;
}

export async function openCapture(): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = new AudioContext();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: { t: number; data: Float32Array }[] = [];
  let lastLevel = 0;
  proc.onaudioprocess = (e) => {
    const d = new Float32Array(e.inputBuffer.getChannelData(0));
    // playbackTime 은 이 버퍼의 시작 시각 (ctx 시간). 입력 버퍼는 그만큼 전에 녹음된 소리
    chunks.push({ t: e.playbackTime - d.length / ctx.sampleRate, data: d });
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i] * d[i];
    lastLevel = Math.min(1, Math.sqrt(s / (d.length / 4)) * 6);
    if (chunks.length > 4000) chunks.shift();
  };
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute).connect(ctx.destination); // ScriptProcessor 는 출력에 연결돼야 돌아가요 (소리는 0)

  const sr = ctx.sampleRate;
  const latency = (ctx.outputLatency || ctx.baseLatency || 0.02) + 0.03;

  const take = async (from: number, to: number) => {
    while (ctx.currentTime < to + 0.15) await new Promise((r) => setTimeout(r, 50));
    const n = Math.round((to - from) * sr);
    const out = new Float32Array(n);
    for (const c of chunks) {
      const off = Math.round((c.t - from) * sr);
      for (let i = 0; i < c.data.length; i++) {
        const j = off + i;
        if (j >= 0 && j < n) out[j] = c.data[i];
      }
    }
    // 16kHz 로 줄이기 (간단한 평균 필터)
    const step = sr / 16000;
    const m = Math.floor(n / step);
    const y = new Float32Array(m);
    for (let k = 0; k < m; k++) {
      const a = Math.floor(k * step);
      const b = Math.max(a + 1, Math.floor((k + 1) * step));
      let s = 0;
      for (let i = a; i < b; i++) s += out[i];
      y[k] = s / (b - a);
    }
    return y;
  };

  return {
    ctx,
    take,
    level: () => lastLevel,
    latency,
    close: () => {
      proc.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

/** 목표 음을 소리로 (삼각파 + 살짝 사인) */
export function scheduleTone(ctx: AudioContext, midi: number, at: number, dur: number, gain = 0.22) {
  const f = 440 * 2 ** ((midi - 69) / 12);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.02);
  g.gain.setValueAtTime(gain, Math.max(at + 0.02, at + dur - 0.05));
  g.gain.linearRampToValueAtTime(0, at + dur);
  g.connect(ctx.destination);
  for (const [type, mul, amp] of [
    ["triangle", 1, 1],
    ["sine", 2, 0.25],
  ] as const) {
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = type;
    o.frequency.value = f * mul;
    og.gain.value = amp;
    o.connect(og).connect(g);
    o.start(at);
    o.stop(at + dur + 0.02);
  }
}

/** 박자 소리 (짧은 클릭, 녹음에 섞여도 음정으로 잡히지 않을 만큼 짧아요) */
export function scheduleClick(ctx: AudioContext, at: number, accent = false) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.value = accent ? 1600 : 1100;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(accent ? 0.25 : 0.15, at + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
  o.connect(g).connect(ctx.destination);
  o.start(at);
  o.stop(at + 0.04);
}
