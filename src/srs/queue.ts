// ============================================================================
// SRS 学習キューの構築（復習対象・新規語の抽出、習熟度集計）
// ============================================================================

import type { SrsCard, SrsLevel, Word } from "../data/types";
import { todayStr } from "./scheduler";

export type CardMap = Record<string, SrsCard>;

/** 復習期限が来ているカード（id）の単語を返す（due昇順） */
export function dueWords(words: Word[], cards: CardMap, today: string = todayStr()): Word[] {
  return words
    .filter((w) => {
      const c = cards[w.id];
      return c && c.due <= today;
    })
    .sort((a, b) => (cards[a.id].due < cards[b.id].due ? -1 : 1));
}

export function countDue(words: Word[], cards: CardMap, today: string = todayStr()): number {
  let n = 0;
  for (const w of words) {
    const c = cards[w.id];
    if (c && c.due <= today) n++;
  }
  return n;
}

/** 未学習(カード未生成)の語を出題順に返す */
export function newWords(words: Word[], cards: CardMap): Word[] {
  return words.filter((w) => !cards[w.id]);
}

/** 一度でも評価したことがあり、期限が来た語（＝本来の「復習」） */
export function reviewDueWords(words: Word[], cards: CardMap, today: string = todayStr()): Word[] {
  return dueWords(words, cards, today).filter((w) => cards[w.id].last !== null);
}

export function countReview(words: Word[], cards: CardMap, today: string = todayStr()): number {
  let n = 0;
  for (const w of words) {
    const c = cards[w.id];
    if (c && c.last !== null && c.due <= today) n++;
  }
  return n;
}

/** 曲から追加しただけで、まだ一度も評価していない語（addCard で作られたカード） */
export function addedNewWords(words: Word[], cards: CardMap, today: string = todayStr()): Word[] {
  return dueWords(words, cards, today).filter((w) => cards[w.id].last === null);
}

export function countAddedNew(words: Word[], cards: CardMap, today: string = todayStr()): number {
  let n = 0;
  for (const w of words) {
    const c = cards[w.id];
    if (c && c.last === null && c.due <= today) n++;
  }
  return n;
}

/**
 * 本日の学習セッションを構築。
 * 復習(評価済みで期限到来) を全件 + 単語帳の新規を残り枠だけ + 曲から追加した語を残り枠だけ。
 * 曲の語は一般語彙の新規枠を消費しない（musicIntroduced で別管理）。
 */
export function buildSession(
  words: Word[],
  cards: CardMap,
  opts: {
    newLimit: number;
    introducedToday: number;
    addedLimit?: number;
    addedToday?: number;
    today?: string;
  }
): { review: Word[]; fresh: Word[]; added: Word[]; all: Word[] } {
  const today = opts.today ?? todayStr();
  const review = reviewDueWords(words, cards, today);
  const remainingNew = Math.max(0, opts.newLimit - opts.introducedToday);
  const fresh = newWords(words, cards).slice(0, remainingNew);
  const remainingAdded = Math.max(0, (opts.addedLimit ?? 0) - (opts.addedToday ?? 0));
  const added = addedNewWords(words, cards, today).slice(0, remainingAdded);
  return { review, fresh, added, all: [...review, ...fresh, ...added] };
}

export interface Mastery {
  notIntroduced: number;
  new: number;
  learning: number;
  young: number;
  mature: number;
  total: number;
  /** 学習に着手した割合(0-1) */
  startedRatio: number;
  /** 定着(young+mature)割合(0-1) */
  retainedRatio: number;
}

export function masteryBreakdown(words: Word[], cards: CardMap): Mastery {
  const counts: Record<SrsLevel, number> = { new: 0, learning: 0, young: 0, mature: 0 };
  let introduced = 0;
  for (const w of words) {
    const c = cards[w.id];
    if (!c) continue;
    introduced++;
    counts[c.level]++;
  }
  const total = words.length;
  const notIntroduced = total - introduced;
  const retained = counts.young + counts.mature;
  return {
    notIntroduced,
    new: counts.new,
    learning: counts.learning,
    young: counts.young,
    mature: counts.mature,
    total,
    startedRatio: total ? introduced / total : 0,
    retainedRatio: total ? retained / total : 0,
  };
}
