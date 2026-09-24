// ============================================================================
// ディクテーションの表示用の計算（純関数。ブラウザ・Node の両方から使う）
// - splitSentences: 本文を文に分ける（文ごとの再生ボタン・順次再生）
// - learnerView: STEP1 の結果。入力した語だけを色分けし、抜けた語は maskWord で伏せる（正解の全文は出さない）
// - stepHint: STEP3 のヒント。STEP1 で正しく書けなかった語だけを頭文字マスクにする
// - answerView: STEP4 の答え合わせ。正解の語を、直前の採点の結果で色分けする
// 採点そのものは grade.alignTokens（語単位の DP）。検証: scripts/check-grade.ts
// ============================================================================

import { maskWord, wordSpans, type Alignment, type Grade } from "./grade";

/** 文の区切り（. ! ? の後ろの空白） */
export const SENTENCE_SPLIT_RE = /(?<=[.!?])\s+/;

/** 本文を文に分ける（空の文は除く）。"— Oi, tudo bem? — Tudo ótimo!" → ["— Oi, tudo bem?", "— Tudo ótimo!"] */
export function splitSentences(text: string): string[] {
  return text
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type TokenKind = Grade | "missing" | "extra";

/** 結果の表示の1語 */
export interface ViewToken {
  /** 表示する文字（入力した語、または抜けた語の頭文字マスク） */
  text: string;
  kind: TokenKind;
}

/**
 * STEP1（と STEP3）の結果の表示。入力側の語をそのまま色分けし、抜けた語は maskWord（頭文字＋下線）にする。
 * 間違えた語の正しい綴りは出さない（答えは STEP4 で見せる）。
 */
export function learnerView(al: Alignment): ViewToken[] {
  return al.tokens.map((t) =>
    t.got === null ? { text: maskWord(t.exp ?? ""), kind: t.grade } : { text: t.got, kind: t.grade }
  );
}

/** 採点の件数（total は本文の語数。wrong は入力したが違った語、extra は本文に無い語） */
export interface AlignCounts {
  correct: number;
  partial: number;
  wrong: number;
  missing: number;
  extra: number;
  total: number;
}

export function alignCounts(al: Alignment): AlignCounts {
  const n = (k: TokenKind) => al.tokens.filter((t) => t.grade === k).length;
  return { correct: al.correct, partial: al.partial, wrong: n("wrong"), missing: n("missing"), extra: n("extra"), total: al.total };
}

/** 本文の語ごとの採点（本文の語の順。wordSpans(本文) と同じ並び） */
export function expGrades(al: Alignment): (Grade | "missing")[] {
  const out: (Grade | "missing")[] = [];
  for (const t of al.tokens) if (t.exp !== null && t.grade !== "extra") out.push(t.grade); // exp があれば extra ではない（型を絞るため）
  return out;
}

/**
 * ヒント: 本文の語を頭文字マスクにする（句読点・空白・ダッシュはそのまま）。keep[i] が true の語はそのまま見せる。
 * i は wordSpans(本文) の順。
 */
export function maskedText(text: string, keep: readonly boolean[] = []): string {
  const s = text.normalize("NFC");
  let out = "";
  let at = 0;
  wordSpans(s).forEach((w, i) => {
    out += s.slice(at, w.start) + (keep[i] ? w.text : maskWord(w.text));
    at = w.end;
  });
  return out + s.slice(at);
}

/**
 * STEP3 のヒント。STEP1 で正しく書けた語（exact）はそのまま見せ、それ以外（違った・惜しい・抜けた語）は
 * 頭文字マスクにする。STEP1 を採点していなければ、全部の語をマスクにする。
 */
export function stepHint(text: string, step1: Alignment | null): string {
  if (!step1) return maskedText(text);
  return maskedText(text, expGrades(step1).map((g) => g === "exact"));
}

/** STEP4 の答え合わせの1語（本文の語、または入力にだけあった余分な語） */
export interface AnswerToken {
  /** 本文の語（余分な語は入力の語） */
  text: string;
  kind: TokenKind;
  /** 入力した語（exact 以外で入力があったとき） */
  got?: string;
}

/** STEP4: 本文の語を直前の採点で色分けする（違った語には入力した形を添える） */
export function answerView(al: Alignment): AnswerToken[] {
  return al.tokens.map((t) => {
    if (t.exp === null) return { text: t.got ?? "", kind: "extra" };
    if (t.got !== null && t.grade !== "exact") return { text: t.exp, kind: t.grade, got: t.got };
    return { text: t.exp, kind: t.grade };
  });
}
