// ============================================================================
// クイズの誤答の選択肢（純関数。ブラウザ・Node の両方から使う）
// - 候補の順: 同じ品詞×同じカテゴリ → 同じ品詞 → 同じカテゴリ → その他（各段の中はランダム）
// - 除外（もう1つの正解に見える語）: 和訳の片が1つでも重なる語、headKey が同じ語、同じ兄弟グループの語、
//   別名（word-aliases.json の alias 側。keep 側と同じ意味なので選択肢には keep 側だけを使う）
// - 候補が足りなければ、除外の条件を段階的に緩める（表示が同じ選択肢だけは最後まで出さない）
// loadWords（発音生成）を読み込まないので、scripts/check-srs からそのまま使える。
// ============================================================================

import type { Word } from "../data/types";
import { headKey, headKeys } from "../data/headKey";
import { ALIAS_IDS, jaPieces, siblingKey } from "../data/siblings";
import { fold } from "./lemmatize";

/** 選択肢に出す面（葡語を選ぶ = "pt"、訳を選ぶ = "ja"） */
export type ChoiceSide = "pt" | "ja";

/**
 * 選択肢の表示の比較キー。同じキーの選択肢は2つ並べない。
 * pt: 小文字化・アクセント除去（fold）・括弧の注記と前後の記号を除く（"Você" と "voce?" は同じ）。
 * ja: NFC と空白の除去だけ（fold は濁点も落とすので和訳には使わない）。
 */
export function choiceKey(w: Pick<Word, "pt" | "ja">, side: ChoiceSide): string {
  return side === "pt" ? fold(headKey(w.pt)) : w.ja.normalize("NFC").replace(/\s+/g, "");
}

/** 固有名詞か（人名・地名・西暦など。品詞に「固有名詞」を含む） */
export function isProperNoun(w: Pick<Word, "pos">): boolean {
  return /固有名詞/.test(w.pos);
}

/**
 * 和→葡（訳を見せて葡語を選ぶ）で出題してよい語か。
 * 固有名詞は訳がカタカナの読み（＝答えの音写）だけのことが多く、答えが見えるので出さない。
 */
export function askableByJa(w: Pick<Word, "pos">): boolean {
  return !isProperNoun(w);
}

/** カタカナどうしをつなぐ「・」（メストリ・ビンバ、カポエイラ・アンゴラ） */
const KANA_JOIN_RE = /(?<=[\p{Script=Katakana}ー])・(?=\p{Script=Katakana})/gu;
const JOIN_MARK = "";

/**
 * 重なり判定に使う和訳の片（siblings.jaPieces）。
 * カポエイラ語の訳ではカタカナ間の「・」は人名・用語の区切りなので分けない
 * （分けると「メストリ」「カポエイラ」だけで別のメストリ同士が重なり、良い誤答が消える）。
 * words.json の「ペースト・フォルダ」のような「・」は同義語の列挙なので、従来どおり分ける。
 */
export function quizPieces(w: Pick<Word, "ja" | "source">): string[] {
  if (w.source !== "capoeira") return jaPieces(w.ja);
  return jaPieces(w.ja.replace(KANA_JOIN_RE, JOIN_MARK)).map((p) => p.split(JOIN_MARK).join("・"));
}

/** 品詞の大分類（"固有名詞（人名）"→"固有名詞"、"名詞・形容詞"→"名詞"、"動詞（現在分詞）"→"動詞"） */
export function posClass(pos: string): string {
  return pos.replace(/[（(].*$/, "").split(/[・/／]/)[0].trim();
}

/** 語ごとの比較用の値（語は不変なので WeakMap で使い回す） */
interface Info {
  pieces: string[];
  heads: string[];
  sib: string;
  pos: string;
}
const infoCache = new WeakMap<Word, Info>();
function infoOf(w: Word): Info {
  let v = infoCache.get(w);
  if (!v) {
    v = {
      pieces: quizPieces(w),
      heads: headKeys(w.pt).filter(Boolean),
      sib: siblingKey(w),
      pos: posClass(w.pos),
    };
    infoCache.set(w, v);
  }
  return v;
}

/**
 * 候補の除外の段階（小さいほど厳しい。この値以上の段階でだけ候補にできる）。
 *   0: 片の重なり・同じ綴り（headKey / 兄弟グループ）・別名のどれにも当たらない
 *   1: 片が重なる、または別名（同じ綴りではない）
 *   2: 同じ綴り（headKey か兄弟グループが同じ）
 */
export function exclusionLevel(answer: Word, cand: Word): 0 | 1 | 2 {
  const a = infoOf(answer);
  const c = infoOf(cand);
  if (c.sib === a.sib || c.heads.some((k) => a.heads.includes(k))) return 2;
  if (ALIAS_IDS.has(cand.id) || c.pieces.some((p) => a.pieces.includes(p))) return 1;
  return 0;
}

/** 候補の優先の段（0: 同品詞×同カテゴリ、1: 同品詞、2: 同カテゴリ、3: その他） */
export function distractorTier(answer: Word, cand: Word): 0 | 1 | 2 | 3 {
  const samePos = infoOf(answer).pos === infoOf(cand).pos;
  const sameCat = answer.category === cand.category;
  if (samePos && sameCat) return 0;
  if (samePos) return 1;
  if (sameCat) return 2;
  return 3;
}

function shuffleWith<T>(arr: readonly T[], random: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface DistractorOptions {
  /** 誤答の数（既定 3） */
  n?: number;
  /** 乱数（テスト用。既定 Math.random） */
  random?: () => number;
}

/**
 * 正解 answer に対する誤答の選択肢を pool から n 個選ぶ。
 * 段（distractorTier）の順に、除外の段階 0 の候補から取り、足りなければ段階 1、2 と緩める。
 * 正解そのもの（同じ id）と、表示（choiceKey）が正解や選んだ誤答と同じ候補は、どの段階でも取らない。
 */
export function pickDistractors(
  answer: Word,
  pool: readonly Word[],
  side: ChoiceSide,
  opts: DistractorOptions = {}
): Word[] {
  const n = opts.n ?? 3;
  const random = opts.random ?? Math.random;
  const used = new Set<string>([choiceKey(answer, side)]);
  // 段ごとにシャッフルしてつなぐ（同じ段の中はランダム）
  const tiers: Word[][] = [[], [], [], []];
  for (const c of pool) {
    if (c.id === answer.id) continue;
    tiers[distractorTier(answer, c)].push(c);
  }
  const ordered = tiers.flatMap((t) => shuffleWith(t, random));
  const level = new Map<Word, number>();
  const out: Word[] = [];
  for (let allow = 0; allow <= 2 && out.length < n; allow++) {
    for (const c of ordered) {
      if (out.length >= n) break;
      let lv = level.get(c);
      if (lv === undefined) {
        lv = exclusionLevel(answer, c);
        level.set(c, lv);
      }
      if (lv !== allow) continue;
      const k = choiceKey(c, side);
      if (!k || used.has(k)) continue;
      used.add(k);
      out.push(c);
    }
  }
  return out;
}
