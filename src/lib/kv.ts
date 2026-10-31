/**
 * GPU 주소 저장소.
 * - Upstash REST 변수(KV_REST_API_URL/TOKEN 등)가 있으면 fetch 로 사용
 * - 없고 REDIS_URL 만 있으면(Vercel Storage의 Redis) redis 클라이언트로 접속
 */
function findEnv(suffixes: string[]): string | undefined {
  for (const suf of suffixes) {
    if (process.env[suf]) return process.env[suf];
    const key = Object.keys(process.env).find((k) => k.endsWith(`_${suf}`) && process.env[k]);
    if (key) return process.env[key];
  }
  return undefined;
}
const REST_URL = findEnv(["KV_REST_API_URL", "UPSTASH_REDIS_REST_URL", "REDIS_REST_URL"]);
const REST_TOKEN = findEnv(["KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN", "REDIS_REST_TOKEN"]);
const REDIS_URL = findEnv(["REDIS_URL", "KV_URL"]);

export const kvEnabled = () => Boolean((REST_URL && REST_TOKEN) || REDIS_URL);

async function rest(cmd: (string | number)[]): Promise<unknown> {
  const r = await fetch(REST_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${REST_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`KV 요청 실패 (HTTP ${r.status})`);
  const j = (await r.json()) as { result?: unknown };
  return j.result ?? null;
}

type MiniRedis = {
  get(k: string): Promise<string | null>;
  set(k: string, v: string): Promise<unknown>;
  isOpen: boolean;
};
const g = globalThis as unknown as { __ttarasoriRedis?: Promise<MiniRedis> };

async function tcp(): Promise<MiniRedis> {
  if (!g.__ttarasoriRedis) {
    g.__ttarasoriRedis = (async () => {
      const { createClient } = await import("redis");
      const client = createClient({ url: REDIS_URL, socket: { connectTimeout: 5000 } });
      client.on("error", () => {});
      await client.connect();
      return client as unknown as MiniRedis;
    })().catch((e) => {
      g.__ttarasoriRedis = undefined;
      throw e;
    });
  }
  const c = await g.__ttarasoriRedis;
  if (!c.isOpen) {
    g.__ttarasoriRedis = undefined;
    return tcp();
  }
  return c;
}

export async function kvGet(key: string): Promise<string | null> {
  try {
    if (REST_URL && REST_TOKEN) {
      const v = await rest(["GET", key]);
      return typeof v === "string" ? v : null;
    }
    if (REDIS_URL) return await (await tcp()).get(key);
  } catch {
    /* 저장소 오류 시 환경 변수 주소로 대체 */
  }
  return null;
}

export async function kvSet(key: string, value: string): Promise<void> {
  if (REST_URL && REST_TOKEN) {
    await rest(["SET", key, value]);
    return;
  }
  if (REDIS_URL) {
    await (await tcp()).set(key, value);
    return;
  }
  throw new Error("저장소가 설정되지 않았어요.");
}
