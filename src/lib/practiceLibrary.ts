"use client";

/**
 * 만든 연습곡을 이 브라우저(IndexedDB)에 보관.
 * 서버에는 2시간 뒤 지워지지만, 여기 저장해 두면 AI 커버를 만들 때 다시 고를 수 있어요.
 */

export interface PracticeSong {
  id: string;
  title: string;
  createdAt: number;
  mix: Blob;
  vocals: Blob | null;
}

const DB = "ttarasori";
const STORE = "practice";
const MAX_SONGS = 20;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export async function listPracticeSongs(): Promise<PracticeSong[]> {
  try {
    const all = await tx<PracticeSong[]>("readonly", (s) => s.getAll() as IDBRequest<PracticeSong[]>);
    return all.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function savePracticeSong(song: Omit<PracticeSong, "id" | "createdAt">): Promise<PracticeSong | null> {
  const full: PracticeSong = { ...song, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now() };
  try {
    await tx("readwrite", (s) => s.put(full));
    const all = await listPracticeSongs();
    for (const old of all.slice(MAX_SONGS)) await tx("readwrite", (s) => s.delete(old.id));
    return full;
  } catch {
    return null; // 사생활 보호 모드 등에서 저장이 막혀도 앱은 계속 동작
  }
}

export async function deletePracticeSong(id: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* 무시 */
  }
}
