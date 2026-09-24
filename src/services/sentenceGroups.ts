// ============================================================================
// 読み物（Passage）のチャンクを文にまとめる（純関数。ブラウザ・Node の両方から使う）
// - groupChunks: 文末（. ! ? …。後ろの閉じ引用符・括弧は許す）で終わるチャンクまでを1文にまとめる。
//   最後のチャンクが文末で終わらなくても、残りを1文にする（どのチャンクも必ずどれかの文に入る）
// - passageToScript: シャドーイング用のスクリプトに変換する（ID は "p:<passageId>"）
// チャンクリーディングの1文読み（B3-03）でも使える。検証: scripts/check-content.ts
// ============================================================================

import type { Chunk, Passage, Script } from "../data/types";

/** 読み物から作ったシャドーイング教材の ID の頭（同梱の教材の ID は英数字・_・- だけなので衝突しない） */
export const PASSAGE_SCRIPT_PREFIX = "p:";

/** 文末: . ! ? …（後ろに閉じ引用符・閉じ括弧が続いてもよい） */
const SENTENCE_END_RE = /[.!?…]["'”’»)）\]]*$/u;

/** チャンク（またはテキスト）が文末で終わっているか */
export function isSentenceEnd(pt: string): boolean {
  return SENTENCE_END_RE.test(pt.trim());
}

/** 1文分のチャンクのまとまり */
export interface SentenceGroup {
  /** 最初のチャンクの番号 */
  start: number;
  /** 最後のチャンクの次の番号（chunks.slice(start, end) がこの文） */
  end: number;
  /** ポルトガル語（チャンクを空白1つでつないだもの。空のチャンクは飛ばす） */
  pt: string;
  /** 和訳（チャンクの訳を区切らずにつないだもの。訳の無いチャンクは飛ばす） */
  ja: string;
}

/** チャンクを文末ごとにまとめる。チャンクの順番は変えず、すき間なく覆う */
export function groupChunks(chunks: readonly Chunk[]): SentenceGroup[] {
  const out: SentenceGroup[] = [];
  let start = 0;
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    if (!last && !isSentenceEnd(chunks[i].pt)) continue;
    const part = chunks.slice(start, i + 1);
    out.push({
      start,
      end: i + 1,
      pt: part
        .map((c) => c.pt.trim())
        .filter(Boolean)
        .join(" "),
      ja: part
        .map((c) => (c.ja ?? "").trim())
        .filter(Boolean)
        .join(""),
    });
    start = i + 1;
  }
  return out;
}

/** シャドーイング教材の ID（読み物の ID から） */
export const passageScriptId = (passageId: string): string => PASSAGE_SCRIPT_PREFIX + passageId;

/**
 * 読み物をシャドーイング用のスクリプトにする（1文 = 1行）。
 * 本文の無い文（空のチャンクだけ）は行にしない。カナは画面側で自動生成する。
 */
export function passageToScript(p: Passage): Script {
  return {
    id: passageScriptId(p.id),
    title: p.title,
    lines: groupChunks(p.chunks)
      .filter((g) => g.pt !== "")
      .map((g) => ({ pt: g.pt, ja: g.ja })),
  };
}
