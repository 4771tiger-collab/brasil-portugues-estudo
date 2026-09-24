// ============================================================================
// 1枚ずつ学習（ReviewSession）の状態機械 — 純粋な reducer
// 副作用（useProgress.rate・音声）は持たない。コンポーネントの click/keydown handler の中で
// step() の前後に行う（StrictMode の二重実行と自動再生の制限を避けるため）。
//
//  - 新規語（カード無し / 曲から追加しただけ = last===null）は intro（両面・音声・例文）で紹介し、
//    INTRO_GAP 枚後に test として出す。intro は SRS に書かない
//  - test は front（表）→ reveal → back（裏）→ rate で次へ
//  - again のカードは AGAIN_GAP 枚後に再挿入する（1枚 MAX_REQUEUE 回まで）
//  - 産出カード（dir="prod"。和→葡。T2-1）は紹介せず、カードが無くても test で出す
//  - 再挿入の回数・最初の評価・again の記録は「カードキー」（cardKey.ts。理解は語の ID、産出は ID+"@p"）で数える。
//    同じ語の理解カードと産出カードは別のカードとして数え、混ざらない
//    （今日の学習 buildSession は同じ語・同じ綴りの理解カードと産出カードを同じ日に入れないので、
//    again の再挿入や「もう1周」で2枚が近づき、答えを見た直後に言わせることはない）
//    （QItem.key はキューの中の一意な key "カードキー#連番" で、カードキーとは別物）
// 検証は scripts/check-srs.ts（npm run check:srs）。
// ============================================================================

import type { Rating, StudyDirection, Word } from "../data/types";
import type { CardMap } from "./queue";
import { toStudyItem, type Dir, type StudyItem } from "./cardKey";

export interface QItem {
  /** React の key（`${cardKey}#${seq}`。同じカードの再出題でも一意） */
  key: string;
  word: Word;
  kind: "intro" | "test";
  /** 出題方向（recog = 理解、prod = 産出） */
  dir: Dir;
  /** SRS のカードキー（rate・取り消しに渡す） */
  cardKey: string;
  /** 産出カードで、セッションを始めた時点でカードが無かった（完了画面の「新しく始めた産出カード」） */
  newCard?: boolean;
}

export interface SessionState {
  queue: QItem[];
  /** 今のカードの位置（queue.length 以上なら完了） */
  pos: number;
  /** test の表 / 裏（intro では常に front） */
  phase: "front" | "back";
  /** カードキーごとの再挿入回数（again の再出題。1周ごとに数え直す） */
  requeued: Record<string, number>;
  /** カードキーごとのセッション内で最初の評価（1回目の正答率に使う） */
  first: Record<string, Rating>;
  /** key の採番 */
  seq: number;
  /** 今の周で again を付けたカードキー（重複なし・評価順）。完了画面の「もう1周」に使う */
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
  | { t: "append"; items: readonly (Word | StudyItem)[] };

/** 1枚分の QItem（test） */
function testItem(it: StudyItem, seq: number): QItem {
  return { key: `${it.key}#${seq}`, word: it.word, kind: "test", dir: it.dir, cardKey: it.key };
}

/**
 * 新規語（カード無し・未評価）の理解カードは intro、それ以外は test で並べる。並びは入力のまま。
 * 入力は Word（理解カード）でも StudyItem（産出カードを含む）でもよい。産出カードは常に test。
 */
export function initSession(items: readonly (Word | StudyItem)[], cards: CardMap): SessionState {
  const queue: QItem[] = items.map((x, i) => {
    const it = toStudyItem(x);
    const c = cards[it.key];
    if (it.dir === "prod") return { ...testItem(it, i), ...(c ? {} : { newCard: true }) };
    return { ...testItem(it, i), kind: !c || c.last === null ? "intro" : "test" };
  });
  return { queue, pos: 0, phase: "front", requeued: {}, first: {}, seq: items.length, again: [], round: 1 };
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

/** QItem → StudyItem（「もう1周」などで同じカードをもう一度出す） */
export function studyItemOf(q: Pick<QItem, "word" | "dir" | "cardKey">): StudyItem {
  return { word: q.word, dir: q.dir, key: q.cardKey };
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
      const test = testItem(studyItemOf(cur), s.seq);
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
      const k = cur.cardKey;
      const first = k in s.first ? s.first : { ...s.first, [k]: a.r };
      let { queue, seq, requeued, again } = s;
      if (a.r === "again") {
        if (!again.includes(k)) again = [...again, k];
        const n = requeued[k] ?? 0;
        if (n < MAX_REQUEUE) {
          queue = insertAt(queue, s.pos + 1 + AGAIN_GAP, testItem(studyItemOf(cur), seq));
          seq += 1;
          requeued = { ...requeued, [k]: n + 1 };
        }
      }
      return { ...s, queue, pos: s.pos + 1, phase: "front", first, seq, requeued, again };
    }

    case "append": {
      // 完了後の「again の語をもう1周」: 末尾に test で足す。再挿入の回数と again の記録は数え直す
      if (!a.items.length) return s;
      const requeued = { ...s.requeued };
      const items = a.items.map((x, i) => {
        const it = toStudyItem(x);
        delete requeued[it.key];
        return testItem(it, s.seq + i);
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

/** 今の周で again だったカード（評価順。完了画面の一覧と「もう1周」） */
export function againItems(s: SessionState): StudyItem[] {
  const byKey = new Map(s.queue.map((q) => [q.cardKey, q]));
  return s.again.map((k) => byKey.get(k)).filter((q): q is QItem => !!q).map(studyItemOf);
}

/** 出題方向ごとの集計 */
export interface DirStats {
  /** 評価した回数（再出題を含む） */
  reviews: number;
  /** 評価したカードの数 */
  words: number;
  /** 1回目で again 以外だったカードの数 */
  firstCorrect: number;
}

/** 完了画面の集計。最上位は理解カード（これまでと同じ意味）、産出カードは prod に分ける */
export interface SessionStats extends DirStats {
  /** 紹介した新しい語の数 */
  newWords: number;
  /** 産出カード（評価した産出カードがあるときだけ）。newCards = 新しく始めた産出カードの数 */
  prod?: DirStats & { newCards: number };
}

export function sessionStats(s: SessionState): SessionStats {
  const done = s.queue.slice(0, s.pos);
  const prodKeys = new Set(s.queue.filter((q) => q.dir === "prod").map((q) => q.cardKey));
  const firsts = Object.entries(s.first);
  const recogFirst = firsts.filter(([k]) => !prodKeys.has(k)).map(([, r]) => r);
  const prodFirst = firsts.filter(([k]) => prodKeys.has(k)).map(([, r]) => r);
  const out: SessionStats = {
    reviews: done.filter((q) => q.kind === "test" && q.dir === "recog").length,
    words: recogFirst.length,
    newWords: done.filter((q) => q.kind === "intro").length,
    firstCorrect: recogFirst.filter((r) => r !== "again").length,
  };
  const prodReviews = done.filter((q) => q.kind === "test" && q.dir === "prod").length;
  if (prodReviews > 0) {
    const newKeys = new Set(s.queue.filter((q) => q.dir === "prod" && q.newCard).map((q) => q.cardKey));
    out.prod = {
      reviews: prodReviews,
      words: prodFirst.length,
      firstCorrect: prodFirst.filter((r) => r !== "again").length,
      newCards: Object.keys(s.first).filter((k) => newKeys.has(k)).length,
    };
  }
  return out;
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

/** 理解カードの test の出題方向。mixed は語と日付で決める（同じ日の再出題では向きが変わらない） */
export function testDirection(id: string, today: string, setting: StudyDirection): "pt2ja" | "ja2pt" {
  if (setting !== "mixed") return setting;
  return hash32(id + today) % 2 === 0 ? "pt2ja" : "ja2pt";
}
