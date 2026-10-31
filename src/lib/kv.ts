/**
 * Upstash Redis(REST) 최소 클라이언트. 추가 패키지 없이 fetch만 사용.
 * Vercel Storage에서 Upstash를 연결하면 아래 환경 변수 중 한 쌍이 자동으로 들어와요.
 */
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

export const kvEnabled = () => Boolean(KV_URL && KV_TOKEN);

async function call(cmd: (string | number)[]): Promise<unknown> {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(KV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`KV 요청 실패 (HTTP ${r.status})`);
  const j = (await r.json()) as { result?: unknown };
  return j.result ?? null;
}

export async function kvGet(key: string): Promise<string | null> {
  try {
    const v = await call(["GET", key]);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: string): Promise<void> {
  await call(["SET", key, value]);
}
