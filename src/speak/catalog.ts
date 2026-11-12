// ============================================================================
// 口慣らし（日本語を見て → ポルトガル語を言う）の文の一覧と、今日やる文の選び方（純関数）
//   検証: scripts/check-speak.ts（npm run check:speak）
// 文は2種類: レッスンのフレーズ（data/course）と、自分で足した文（useSpeak.phrases）。
// どちらも同じ SRS（srs/scheduler.ts の review）で、単語とは別のカード（useSpeak.cards）に記録する。
// ============================================================================

import type { Rating, SrsCard } from "../data/types";
import { LESSONS, type Lesson } from "../data/course";
import type { UserPhrase } from "./speakData";

/** 口慣らしの1文 */
export interface SayItem {
  id: string;
  ja: string;
  pt: string;
  alt?: string[];
  note?: string;
  /** レッスンの文なら、そのレッスンの ID */
  lessonId?: string;
  /** 出どころの表示（「L3 聞き返す」「自分のフレーズ」） */
  label: string;
}

export type Catalog = ReadonlyMap<string, SayItem>;
export type SpeakCards = Readonly<Record<string, SrsCard>>;

export const lessonLabel = (l: Pick<Lesson, "no" | "title">): string => `L${l.no} ${l.title}`;

/** レッスン1つ分の文 */
export function lessonItems(l: Lesson): SayItem[] {
  return l.phrases.map((p) => ({
    id: p.id,
    ja: p.ja,
    pt: p.pt,
    ...(p.alt?.length ? { alt: p.alt } : {}),
    ...(p.note ? { note: p.note } : {}),
    lessonId: l.id,
    label: lessonLabel(l),
  }));
}

export function userItem(p: UserPhrase): SayItem {
  return {
    id: p.id,
    ja: p.ja,
    pt: p.pt,
    ...(p.alt?.length ? { alt: p.alt } : {}),
    ...(p.note ? { note: p.note } : {}),
    label: "自分のフレーズ",
  };
}

const COURSE_ITEMS: SayItem[] = LESSONS.flatMap(lessonItems);

/** 全部の文（レッスンの文 ＋ 自分で足した文） */
export function buildCatalog(userPhrases: readonly UserPhrase[], course: readonly SayItem[] = COURSE_ITEMS): Catalog {
  const m = new Map<string, SayItem>();
  for (const it of course) m.set(it.id, it);
  for (const p of userPhrases) m.set(p.id, userItem(p));
  return m;
}

/** 採点で正解とみなす言い方（pt と alt） */
export const answersOf = (it: Pick<SayItem, "pt" | "alt">): string[] => [it.pt, ...(it.alt ?? [])];

// ---------------------------------------------------------------------------
// 今日の口慣らし
// ---------------------------------------------------------------------------

/** 1回のセッションで出す文の数の上限（多すぎると最後まで続かない） */
export const SESSION_MAX = 20;

/**
 * 今日やる文（期限の来たカード）。延滞の大きい順 → 間隔の短い順（あやふやな文を先に）→ ID 順。
 * remaining は今日の残りの枠（1日の上限 − 今日すでに復習した数）。教材から消えた文のカードは出さない。
 */
export function dueItems(cards: SpeakCards, catalog: Catalog, today: string, remaining: number = Infinity): SayItem[] {
  const due: { it: SayItem; c: SrsCard }[] = [];
  for (const [id, c] of Object.entries(cards)) {
    if (c.due > today) continue;
    const it = catalog.get(id);
    if (it) due.push({ it, c });
  }
  due.sort((a, b) => (a.c.due < b.c.due ? -1 : a.c.due > b.c.due ? 1 : a.c.intervalDays - b.c.intervalDays || (a.it.id < b.it.id ? -1 : a.it.id > b.it.id ? 1 : 0)));
  return due.slice(0, Math.max(0, Math.floor(remaining))).map((x) => x.it);
}

/** 期限の来ている文の数（1日の上限は見ない） */
export function dueCount(cards: SpeakCards, catalog: Catalog, today: string): number {
  let n = 0;
  for (const [id, c] of Object.entries(cards)) if (c.due <= today && catalog.has(id)) n++;
  return n;
}

/**
 * 期限の来ていない文からの追加練習（今日の分が終わったあと）。あやふやな文（間隔の短い文）→ 久しぶりの文の順に n 個。
 * 期限前の評価は SRS を変えない（scheduler.isHeld。「言えなかった」だけは反映される）。
 */
export function extraItems(cards: SpeakCards, catalog: Catalog, today: string, n: number): SayItem[] {
  const pool: { it: SayItem; c: SrsCard }[] = [];
  for (const [id, c] of Object.entries(cards)) {
    if (c.due <= today || !c.last) continue;
    const it = catalog.get(id);
    if (it) pool.push({ it, c });
  }
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  pool.sort((a, b) => a.c.intervalDays - b.c.intervalDays || cmp(a.c.last ?? "", b.c.last ?? "") || cmp(a.it.id, b.it.id));
  return pool.slice(0, Math.max(0, n)).map((x) => x.it);
}

export interface SpeakStats {
  /** 一度でも言う練習をした文 */
  started: number;
  /** 言える文（復習の間隔が7日以上） */
  canSay: number;
  /** 練習中（間隔7日未満） */
  learning: number;
}

/** 「言える文」の間隔のしきい値（日）。単語の「定着」と同じ7日 */
export const CAN_SAY_DAYS = 7;

export function speakStats(cards: SpeakCards, catalog: Catalog): SpeakStats {
  let started = 0;
  let canSay = 0;
  for (const [id, c] of Object.entries(cards)) {
    if (!c.last || !catalog.has(id)) continue;
    started++;
    if (c.intervalDays >= CAN_SAY_DAYS) canSay++;
  }
  return { started, canSay, learning: started - canSay };
}

// ---------------------------------------------------------------------------
// 音声認識の点数 → おすすめの評価
// ---------------------------------------------------------------------------

/** この点数以上なら「言えた」 */
export const SAY_GOOD_PERCENT = 85;
/** この点数以上なら「惜しい」 */
export const SAY_HARD_PERCENT = 55;

/** 言ってみた点数（0〜100）からのおすすめ。ヒントを見たときは「言えた」にしない */
export function ratingFromPercent(percent: number, usedHint = false): Rating {
  if (percent >= SAY_GOOD_PERCENT) return usedHint ? "hard" : "good";
  if (percent >= SAY_HARD_PERCENT) return "hard";
  return "again";
}
