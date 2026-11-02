"use client";

/**
 * 등록한 내 목소리를 이 브라우저(IndexedDB)에 보관해서, 다음에 와도 다시 녹음하지 않아도 되게 해요.
 */
export interface SavedVoice {
  blob: Blob;
  name: string;
  createdAt: number;
  /** 소리가 난 길이 (초) */
  voicedSec: number;
}

const DB = "ttarasori-voice";
const KEY = "me";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("voice");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function loadVoice(): Promise<SavedVoice | null> {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const q = db.transaction("voice", "readonly").objectStore("voice").get(KEY);
      q.onsuccess = () => {
        resolve((q.result as SavedVoice | undefined) ?? null);
        db.close();
      };
      q.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function saveVoice(v: SavedVoice): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const t = db.transaction("voice", "readwrite");
      t.objectStore("voice").put(v, KEY);
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => resolve();
    });
  } catch {
    /* 저장이 막혀도 이번 방문에서는 쓸 수 있어요 */
  }
}

export async function clearVoice(): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((resolve) => {
      const t = db.transaction("voice", "readwrite");
      t.objectStore("voice").delete(KEY);
      t.oncomplete = () => {
        db.close();
        resolve();
      };
      t.onerror = () => resolve();
    });
  } catch {
    /* 무시 */
  }
}
