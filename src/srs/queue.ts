// ============================================================================
// SRS 学習キューの構築（復習対象・新規語の抽出、習熟度集計）
// ============================================================================

import type { SrsCard, SrsLevel, Word } from "../data/types";
import { addDays, displayLevel, todayStr } from "./scheduler";

export type CardMap = Record<string, SrsCard>;

/** 復習期限が来ているカード（id）の単語を返す（due昇順） */
export function dueWords(words: Word[], cards: CardMap, today: string = todayStr()): Word[] {
  return words
    .filter((w) => {
      const c = cards[w.id];
      return c && c.due <= today;
    })
    .sort((a, b) => cards[a.id].due.localeCompare(cards[b.id].due)); // 同じ日は元の順（安定ソート）
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

/**
 * 新規語の出題順。「今日の学習に追加」で指定された語(pinned・カード未生成のもの)を先頭に、
 * 残りは newWords の順（ファイル順）。
 */
function freshOrder(words: Word[], cards: CardMap, pinned: readonly string[]): Word[] {
  const unseen = newWords(words, cards);
  if (!pinned.length) return unseen;
  const byId = new Map(unseen.map((w) => [w.id, w]));
  const head: Word[] = [];
  for (const id of pinned) {
    const w = byId.get(id);
    if (!w) continue; // カード作成済み・対象外の語は無視
    head.push(w);
    byId.delete(id); // 重複指定も1回だけ
  }
  if (!head.length) return unseen;
  const headIds = new Set(head.map((w) => w.id));
  return [...head, ...unseen.filter((w) => !headIds.has(w.id))];
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
 * 新規枠は pinned（useProgress.pinnedNew）の語から先に使う。
 */
export function buildSession(
  words: Word[],
  cards: CardMap,
  opts: {
    newLimit: number;
    introducedToday: number;
    addedLimit?: number;
    addedToday?: number;
    /** 「今日の学習に追加」で指定された未学習語の id（先頭から新規枠に入る） */
    pinned?: readonly string[];
    today?: string;
  }
): { review: Word[]; fresh: Word[]; added: Word[]; all: Word[] } {
  const today = opts.today ?? todayStr();
  const review = reviewDueWords(words, cards, today);
  const remainingNew = Math.max(0, opts.newLimit - opts.introducedToday);
  const fresh = freshOrder(words, cards, opts.pinned ?? []).slice(0, remainingNew);
  const remainingAdded = Math.max(0, (opts.addedLimit ?? 0) - (opts.addedToday ?? 0));
  const added = addedNewWords(words, cards, today).slice(0, remainingAdded);
  return { review, fresh, added, all: [...review, ...fresh, ...added] };
}

/**
 * 復習の予報（完了画面の「明日の復習」と7日分の棒）。
 * 1日目（明日）は、評価済みで due が明日以前のカード（今日やり残した分も明日に回る）。
 * 2日目以降は due がその日ちょうどのカード。未評価（曲から追加しただけ）のカードは数えない。
 */
export function forecast(words: Word[], cards: CardMap, today: string = todayStr(), days = 7): number[] {
  const out = new Array<number>(Math.max(0, days)).fill(0);
  if (!out.length) return out;
  const dates = out.map((_, i) => addDays(today, i + 1));
  const index = new Map(dates.map((d, i) => [d, i]));
  const tomorrow = dates[0];
  const seen = new Set<string>();
  for (const w of words) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const c = cards[w.id];
    if (!c || !c.last) continue;
    if (c.due <= tomorrow) out[0]++;
    else {
      const i = index.get(c.due);
      if (i !== undefined) out[i]++;
    }
  }
  return out;
}

export interface Mastery {
  /** カード無し */
  notIntroduced: number;
  /** カードはあるが一度も評価していない（曲から追加しただけ） */
  new: number;
  /** 未学習の合計（notIntroduced + new）。ホームの「未学習」マス */
  unstudied: number;
  learning: number;
  young: number;
  mature: number;
  total: number;
  /** 学習に着手した（一度でも評価した）割合(0-1) */
  startedRatio: number;
  /** 定着(young+mature ＝ 間隔7日以上)割合(0-1) */
  retainedRatio: number;
}

/** 習熟度の集計。保存済みの level ではなく displayLevel（現行しきい値）で数える */
export function masteryBreakdown(words: Word[], cards: CardMap): Mastery {
  const counts: Record<SrsLevel, number> = { new: 0, learning: 0, young: 0, mature: 0 };
  let introduced = 0;
  for (const w of words) {
    const c = cards[w.id];
    if (!c) continue;
    introduced++;
    counts[displayLevel(c)]++;
  }
  const total = words.length;
  const notIntroduced = total - introduced;
  const unstudied = notIntroduced + counts.new;
  const retained = counts.young + counts.mature;
  return {
    notIntroduced,
    new: counts.new,
    unstudied,
    learning: counts.learning,
    young: counts.young,
    mature: counts.mature,
    total,
    startedRatio: total ? (total - unstudied) / total : 0,
    retainedRatio: total ? retained / total : 0,
  };
}
