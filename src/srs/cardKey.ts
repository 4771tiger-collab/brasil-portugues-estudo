// ============================================================================
// SRS のカードキー（出題方向ごとに別のカード）
// - 理解カード（recog: 葡を見て意味を思い出す）: キーは語の ID そのまま（"words:0042"。これまでと同じ）
// - 産出カード（prod: 日本語を見てポルトガル語を言う）: キーは語の ID ＋ "@p"（"words:0042@p"）
// 語の ID は "source:4桁" / "dict:N" / "user:<歌詞の語>" で、"@" を含まない
// （user: の語は歌詞のトークン＝文字・ハイフン・アポストロフィだけから作る。lemmatize.TOKEN_RE）。
// 念のため "@" を含む ID は産出カードの対象にしない（canHaveProd）。
// ※ 1枚ずつ学習のキュー（session.ts）の React の key "…#n" とは別物。カードキーは SRS の保存に使う。
// 検証: scripts/check-srs.ts（npm run check:srs）
// ============================================================================

import type { Word } from "../data/types";

/** 産出カードのキーの末尾 */
export const PROD_SUFFIX = "@p";

/** 出題方向: recog = 理解（葡 → 意味）、prod = 産出（和 → 葡） */
export type Dir = "recog" | "prod";

/** 語の ID に "@" が無い（産出カードを作れる ID） */
export function canHaveProd(id: string): boolean {
  return !!id && !id.includes("@");
}

/** 語の ID → 産出カードのキー */
export function prodKey(id: string): string {
  return id + PROD_SUFFIX;
}

/** 産出カードのキーか（"@p" で終わり、その前に "@" が無い） */
export function isProdKey(key: string): boolean {
  return key.endsWith(PROD_SUFFIX) && canHaveProd(key.slice(0, -PROD_SUFFIX.length));
}

/** カードキー → 語の ID（理解カードのキーはそのまま） */
export function baseOfKey(key: string): string {
  return isProdKey(key) ? key.slice(0, -PROD_SUFFIX.length) : key;
}

/** 語の ID と出題方向 → カードキー */
export function cardKey(id: string, dir: Dir): string {
  return dir === "prod" ? prodKey(id) : id;
}

/** 今日の学習の1枚（語・出題方向・カードキー） */
export interface StudyItem {
  word: Word;
  dir: Dir;
  /** SRS のカードキー（cardKey(word.id, dir)） */
  key: string;
}

export function recogItem(word: Word): StudyItem {
  return { word, dir: "recog", key: word.id };
}

export function prodItem(word: Word): StudyItem {
  return { word, dir: "prod", key: prodKey(word.id) };
}

/** Word（理解カード）と StudyItem のどちらでも受け取る（1枚ずつ学習の入力など） */
export function toStudyItem(x: Word | StudyItem): StudyItem {
  return "word" in x ? x : recogItem(x);
}
