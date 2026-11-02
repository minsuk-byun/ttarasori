"use client";

/**
 * 이 브라우저(IndexedDB)에 음원 보관함.
 * - practice: 연습곡 (mix = 반주+가이드, vocals = 가이드 보컬)
 * - cover:    AI 커버 결과 (mix = 완성곡, vocals = AI 보컬)
 * - mine:     내가 부른 녹음 (mix = 녹음 그대로)
 * 서버 파일은 2시간 뒤 지워지지만 여기 저장해 두면 다시 고를 수 있어요.
 */

import type { NoteInfo } from "@/lib/audio/notes.ts";

export type LibraryKind = "practice" | "cover" | "mine";

export interface LibraryItem {
  id: string;
  kind: LibraryKind;
  title: string;
  createdAt: number;
  mix: Blob;
  vocals: Blob | null;
  /** 연습곡의 글자별 음표 (글자별 피드백용, 예전 항목에는 없음) */
  notes?: NoteInfo[] | null;
}

/** 예전 이름 호환 */
export type PracticeSong = LibraryItem;

const DB = "ttarasori";
const STORE = "library";
const MAX_PER_KIND = 20;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      // v1 의 연습곡 보관함을 새 보관함으로 옮기기
      if (e.oldVersion === 1 && db.objectStoreNames.contains("practice")) {
        const t = req.transaction!;
        const old = t.objectStore("practice");
        const lib = t.objectStore(STORE);
        old.openCursor().onsuccess = (ev) => {
          const cur = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cur) {
            db.deleteObjectStore("practice");
            return;
          }
          lib.put({ ...cur.value, kind: "practice" });
          cur.continue();
        };
      }
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

export async function listLibrary(kinds?: LibraryKind[]): Promise<LibraryItem[]> {
  try {
    const all = await tx<LibraryItem[]>("readonly", (s) => s.getAll() as IDBRequest<LibraryItem[]>);
    return all.filter((x) => !kinds || kinds.includes(x.kind)).sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function saveToLibrary(item: Omit<LibraryItem, "id" | "createdAt">): Promise<LibraryItem | null> {
  const full: LibraryItem = { ...item, id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, createdAt: Date.now() };
  try {
    await tx("readwrite", (s) => s.put(full));
    const same = await listLibrary([item.kind]);
    for (const old of same.slice(MAX_PER_KIND)) await tx("readwrite", (s) => s.delete(old.id));
    return full;
  } catch {
    return null; // 사생활 보호 모드 등에서 저장이 막혀도 앱은 계속 동작
  }
}

export async function deleteFromLibrary(id: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* 무시 */
  }
}

// 연습곡 전용 (기존 호출부 호환)
export const listPracticeSongs = () => listLibrary(["practice"]);
export const savePracticeSong = (s: { title: string; mix: Blob; vocals: Blob | null; notes?: NoteInfo[] | null }) => saveToLibrary({ ...s, kind: "practice" });
export const deletePracticeSong = deleteFromLibrary;

export const KIND_LABEL: Record<LibraryKind, string> = { practice: "연습곡", cover: "AI 커버", mine: "내 녹음" };
