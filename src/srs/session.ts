// ============================================================================
// 1枚ずつ学習（ReviewSession）の状態機械 — 純粋な reducer
// 副作用（useProgress.rate・音声）は持たない。コンポーネントの click/keydown handler の中で
// step() の前後に行う（StrictMode の二重実行と自動再生の制限を避けるため）。
//
//  - 新規語（カード無し / 曲から追加しただけ = last===null）は intro（両面・音声・例文）で紹介し、
//    INTRO_GAP 枚後に test として出す。intro は SRS に書かない
//  - test は front（表）→ reveal → back（裏）→ rate で次へ
//  - again の語は AGAIN_GAP 枚後に再挿入する（1語 MAX_REQUEUE 回まで）
// 検証は scripts/check-srs.ts（npm run check:srs）。
// ============================================================================

import type { Rating, StudyDirection, Word } from "../data/types";
import type { CardMap } from "./queue";

export interface QItem {
  /** React の key（`${id}#${seq}`。同じ語の再出題でも一意） */
  key: string;
  word: Word;
  kind: "intro" | "test";
}

export interface SessionState {
  queue: QItem[];
  /** 今のカードの位置（queue.length 以上なら完了） */
  pos: number;
  /** test の表 / 裏（intro では常に front） */
  phase: "front" | "back";
  /** 語ごとの再挿入回数（again の再出題。1周ごとに数え直す） */
  requeued: Record<string, number>;
  /** 語ごとのセッション内で最初の評価（1回目の正答率に使う） */
  first: Record<string, Rating>;
  /** key の採番 */
  seq: number;
  /** 今の周で again を付けた語（重複なし・評価順）。完了画面の「もう1周」に使う */
  again: string[];
  /** 周回数（1始まり。「again 語をもう1周」で +1） */
  round: number;
}

export const AGAIN_GAP = 3;
export const INTRO_GAP = 3;
export const MAX_REQUEUE = 3;

export type SessionAction =
  | { t: "reveal" }
  | { t: "introNext" }
  | { t: "rate"; r: Rating }
  | { t: "append"; words: Word[] };

/** 新規語（カード無し・未評価）は intro、それ以外は test で並べる。並びは words のまま */
export function initSession(words: Word[], cards: CardMap): SessionState {
  const queue: QItem[] = words.map((word, i) => {
    const c = cards[word.id];
    return { key: `${word.id}#${i}`, word, kind: !c || c.last === null ? "intro" : "test" };
  });
  return { queue, pos: 0, phase: "front", requeued: {}, first: {}, seq: words.length, again: [], round: 1 };
}

export const isDone = (s: SessionState): boolean => s.pos >= s.queue.length;

/** 今のカード（完了なら undefined） */
export const currentItem = (s: SessionState): QItem | undefined => s.queue[s.pos];

/** queue の at の位置に item を差し込んだ新しい配列 */
function insertAt(queue: QItem[], at: number, item: QItem): QItem[] {
  const q = queue.slice();
  q.splice(Math.min(at, q.length), 0, item);
  return q;
}

export function step(s: SessionState, a: SessionAction): SessionState {
  const cur = s.queue[s.pos];
  switch (a.t) {
    case "reveal":
      if (!cur || cur.kind !== "test" || s.phase !== "front") return s;
      return { ...s, phase: "back" };

    case "introNext": {
      if (!cur || cur.kind !== "intro") return s;
      // 紹介した語を INTRO_GAP 枚後に表だけでテストする
      const test: QItem = { key: `${cur.word.id}#${s.seq}`, word: cur.word, kind: "test" };
      return {
        ...s,
        queue: insertAt(s.queue, s.pos + 1 + INTRO_GAP, test),
        pos: s.pos + 1,
        phase: "front",
        seq: s.seq + 1,
      };
    }

    case "rate": {
      // 答えを見る前には評価できない
      if (!cur || cur.kind !== "test" || s.phase !== "back") return s;
      const id = cur.word.id;
      const first = id in s.first ? s.first : { ...s.first, [id]: a.r };
      let { queue, seq, requeued, again } = s;
      if (a.r === "again") {
        if (!again.includes(id)) again = [...again, id];
        const n = requeued[id] ?? 0;
        if (n < MAX_REQUEUE) {
          queue = insertAt(queue, s.pos + 1 + AGAIN_GAP, { key: `${id}#${seq}`, word: cur.word, kind: "test" });
          seq += 1;
          requeued = { ...requeued, [id]: n + 1 };
        }
      }
      return { ...s, queue, pos: s.pos + 1, phase: "front", first, seq, requeued, again };
    }

    case "append": {
      // 完了後の「again の語をもう1周」: 末尾に test で足す。再挿入の回数と again の記録は数え直す
      if (!a.words.length) return s;
      const requeued = { ...s.requeued };
      const items = a.words.map((word, i) => {
        delete requeued[word.id];
        return { key: `${word.id}#${s.seq + i}`, word, kind: "test" as const };
      });
      return {
        ...s,
        queue: [...s.queue, ...items],
        phase: "front",
        seq: s.seq + items.length,
        requeued,
        again: [],
        round: s.round + 1,
      };
    }
  }
}

/** 完了画面の集計 */
export interface SessionStats {
  /** 評価した回数（再出題を含む） */
  reviews: number;
  /** 評価した語の数 */
  words: number;
  /** 紹介した新しい語の数 */
  newWords: number;
  /** 1回目で again 以外だった語の数 */
  firstCorrect: number;
}

export function sessionStats(s: SessionState): SessionStats {
  const done = s.queue.slice(0, s.pos);
  const firsts = Object.values(s.first);
  return {
    reviews: done.filter((q) => q.kind === "test").length,
    words: firsts.length,
    newWords: done.filter((q) => q.kind === "intro").length,
    firstCorrect: firsts.filter((r) => r !== "again").length,
  };
}

/** 文字列の簡易ハッシュ（FNV-1a 32bit） */
function hash32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** test の出題方向。mixed は語と日付で決める（同じ日の再出題では向きが変わらない） */
export function testDirection(id: string, today: string, setting: StudyDirection): "pt2ja" | "ja2pt" {
  if (setting !== "mixed") return setting;
  return hash32(id + today) % 2 === 0 ? "pt2ja" : "ja2pt";
}
