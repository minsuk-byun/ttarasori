"use client";

import { useEffect, useMemo, useState } from "react";
import LibraryPicker from "@/components/LibraryPicker";
import PitchGame from "@/components/PitchGame";
import type { GameNote, GameResult } from "@/lib/audio/game.ts";
import { autoNotes } from "@/lib/audio/notes.ts";
import { decodeToMono } from "@/lib/audio/decode.ts";
import { extractFeatures, hzToMidi } from "@/lib/audio/features.ts";
import { deviceId, getNickname, makeChallenge, renderChallenge, setNickname, weekKey } from "@/lib/challenge";
import { addSession } from "@/lib/progress";
import type { LibraryItem } from "@/lib/practiceLibrary";

interface Board {
  players: number;
  top: { rank: number; name: string; best: number; gain: number; plays: number; me: boolean }[];
  improved: { rank: number; name: string; best: number; gain: number; plays: number; me: boolean }[];
  me: { rank: number; name: string; best: number; gain: number; plays: number; me: boolean } | null;
}

type Game = { title: string; notes: GameNote[]; backing: Blob | null; guideTones: boolean; label: string; challenge?: boolean };

/** 저장된 연습곡·가이드에서 게임용 음표 만들기 */
async function gameFromItem(it: LibraryItem): Promise<Game> {
  let notes: GameNote[];
  if (it.notes?.length) notes = it.notes.map((n) => ({ midi: n.midi, start: n.start, dur: n.dur, syllable: n.syllable }));
  else {
    // 가사 정보가 없는 가이드: 보컬 음정을 음 단위로 나눠요
    const x = await decodeToMono(it.vocals ?? it.mix);
    const f = await extractFeatures(x, 16000);
    const midi = Array.from(f.f0, (v) => (v > 0 ? hzToMidi(v) : null));
    notes = autoNotes(midi, f.hopSec, { thresh: 0.85, hold: 5 })
      .filter((n) => n.dur >= 0.18)
      .map((n) => ({ midi: Math.round(n.midi), start: n.start, dur: n.dur }));
  }
  if (notes.length < 4) throw new Error("이 음원에서는 게임으로 만들 음을 충분히 찾지 못했어요.");
  return { title: it.title, notes, backing: it.mix, guideTones: false, label: `game:${it.id}` };
}

export default function GameTab({ onSaved }: { onSaved: () => void }) {
  const song = useMemo(() => makeChallenge(), []);
  const week = useMemo(() => weekKey(), []);
  const [game, setGame] = useState<Game | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const [board, setBoard] = useState<Board | null>(null);
  const [boardMsg, setBoardMsg] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    setName(getNickname());
    fetch(`/api/challenge?week=${week}&me=${deviceId()}`)
      .then(async (r) => (r.ok ? setBoard(await r.json()) : setBoardMsg(r.status === 503 ? "랭킹 저장소가 아직 준비되지 않았어요." : "랭킹을 불러오지 못했어요.")))
      .catch(() => setBoardMsg("랭킹을 불러오지 못했어요."));
  }, [week]);

  async function playChallenge() {
    setError(null);
    setLoading("챌린지 곡 만드는 중");
    try {
      const backing = await renderChallenge(song);
      setGame({ title: `이번 주 챌린지 「${song.title}」`, notes: song.notes, backing, guideTones: true, label: `game:challenge:${week}`, challenge: true });
    } catch {
      setError("챌린지 곡을 만들지 못했어요.");
    } finally {
      setLoading(null);
    }
  }

  async function finish(g: Game, r: GameResult, seconds: number) {
    await addSession({
      kind: "game",
      label: g.label,
      songTitle: g.title,
      score: r.score,
      pitchAcc: r.hitRatio,
      offsetCents: r.offsetCents,
      seconds,
      weak: r.weak,
      stars: r.stars,
      maxCombo: r.maxCombo,
      perfects: r.counts.PERFECT,
    });
    onSaved();
    if (g.challenge && name.trim()) {
      const res = await fetch("/api/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week, id: deviceId(), name: name.trim(), score: r.score }),
      }).catch(() => null);
      if (res?.ok) setBoard(await res.json());
      else if (res?.status === 429) setBoardMsg("너무 빨리 다시 올렸어요. 잠시 뒤 다시 도전하면 반영돼요.");
    }
  }

  return (
    <div className="space-y-6">
      {game ? (
        <section className="rounded-2xl bg-surface p-4 sm:p-6">
          <button onClick={() => setGame(null)} className="mb-3 text-sm font-semibold text-muted hover:text-ink">
            ← 곡 고르기
          </button>
          <PitchGame key={game.label} title={game.title} notes={game.notes} backing={game.backing} guideTones={game.guideTones} onFinish={(r, s) => finish(game, r, s)} />
          {game.challenge && !name.trim() && <p className="mt-2 text-sm text-muted">닉네임을 정하면 점수가 이번 주 랭킹에 올라가요.</p>}
        </section>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-2xl bg-ink p-5 text-white sm:p-6">
            <div className="text-sm font-semibold text-white/60">이번 주 챌린지 · {week.replace("-W", "년 ")}주차</div>
            <h2 className="mt-1 text-2xl font-bold">「{song.title}」</h2>
            <p className="mt-1 text-sm text-white/70">
              모두가 같은 곡으로 도전해요. 따라소리가 새로 만든 곡이라 저작권 걱정이 없어요. {song.bpm} BPM · {song.minor ? "단조" : "장조"} · 8마디
            </p>
            <label className="mt-4 block text-sm">
              <span className="text-white/70">닉네임 (랭킹에 보여요, 12자까지)</span>
              <input
                value={name}
                maxLength={12}
                onChange={(e) => {
                  setName(e.target.value);
                  setNickname(e.target.value);
                }}
                placeholder="예: 노래하는 고양이"
                className="mt-1 w-full rounded-lg bg-white/10 px-3 py-2 text-white outline-none placeholder:text-white/40 focus:bg-white/15"
              />
            </label>
            <button onClick={playChallenge} disabled={!!loading} className="mt-4 rounded-xl bg-white px-5 py-3 font-semibold text-ink hover:bg-white/90 disabled:opacity-50">
              {loading ?? "챌린지 도전"}
            </button>
            <p className="mt-2 text-xs text-white/50">이 기기에서 만든 임의 번호와 닉네임만 저장돼요. 매주 월요일에 새 곡으로 바뀌어요.</p>
          </section>

          <section className="rounded-2xl bg-surface p-5 sm:p-6">
            <h2 className="text-xl font-semibold">이번 주 랭킹</h2>
            {board ? (
              <>
                <p className="text-sm text-muted">{board.players}명 도전 중{board.me ? ` · 내 순위 ${board.me.rank}위 (${board.me.best}점)` : ""}</p>
                {board.top.length ? (
                  <ol className="mt-3 divide-y divide-line">
                    {board.top.map((r) => (
                      <li key={r.rank} className={`flex items-center gap-3 py-2 ${r.me ? "font-semibold text-mine" : ""}`}>
                        <span className="w-6 text-right tabular-nums text-muted">{r.rank}</span>
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        <span className="tabular-nums">{r.best}점</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="mt-3 rounded-xl bg-paper p-4 text-sm text-muted">아직 도전한 사람이 없어요. 첫 번째로 이름을 올려 보세요!</p>
                )}
                {board.improved.length > 0 && (
                  <>
                    <h3 className="mt-5 text-sm font-semibold">가장 많이 늘었어요</h3>
                    <ol className="mt-1 text-sm">
                      {board.improved.map((r) => (
                        <li key={r.rank} className={`flex gap-3 py-1 ${r.me ? "font-semibold text-mine" : ""}`}>
                          <span className="min-w-0 flex-1 truncate">{r.name}</span>
                          <span className="font-semibold text-good">+{r.gain}점</span>
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </>
            ) : (
              <p className="mt-3 text-sm text-muted">{boardMsg ?? "불러오는 중"}</p>
            )}
            {boardMsg && board && <p className="mt-2 text-xs text-bad">{boardMsg}</p>}
          </section>

          <section className="rounded-2xl bg-surface p-5 sm:p-6 lg:col-span-2">
            <h2 className="text-xl font-semibold">내 곡으로 게임</h2>
            <p className="text-sm text-muted">만든 연습곡이나 AI 커버·내 목소리 가이드로도 할 수 있어요. 가사가 있는 연습곡은 막대에 글자가 나와요.</p>
            {pick ? (
              <div className="mt-3">
                <LibraryPicker
                  kinds={["practice", "cover"]}
                  pickLabel="게임하기"
                  onClose={() => setPick(false)}
                  empty="아직 저장된 연습곡이나 AI 커버가 없어요. 연습곡을 만들면 여기서 고를 수 있어요."
                  onPick={async (it) => {
                    setError(null);
                    setLoading("음표 준비 중");
                    try {
                      setGame(await gameFromItem(it));
                      setPick(false);
                    } catch (e) {
                      setError(e instanceof Error ? e.message : "게임을 준비하지 못했어요.");
                    } finally {
                      setLoading(null);
                    }
                  }}
                />
              </div>
            ) : (
              <button onClick={() => setPick(true)} disabled={!!loading} className="mt-3 rounded-xl bg-ink px-5 py-2.5 font-semibold text-white disabled:opacity-40">
                {loading === "음표 준비 중" ? loading : "저장된 곡 고르기"}
              </button>
            )}
          </section>
        </div>
      )}
      {error && <p className="rounded-lg bg-mine-soft px-3 py-2 text-sm text-bad">{error}</p>}
    </div>
  );
}
