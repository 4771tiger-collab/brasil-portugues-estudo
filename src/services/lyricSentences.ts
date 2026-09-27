// ============================================================================
// 歌詞の行を「文（ひと続きのフレーズ）」にまとめる・和訳の表示の優先順位（純関数。ブラウザ・Node の両方から使う）
//   検証: scripts/check-translate.ts（npm run check:translate）
// 歌詞は1つの文が2〜3行に分かれていることが多く、行ごとに機械翻訳すると文の途中で切れた意味の通らない訳になる。
// 文ごとにまとめて1回で訳すと、前後のつながりを踏まえた訳になる（和訳は文の最後の行の下に出す）。
//
// まとめ方（ヒューリスティック）: 空でない行が続くとき、行 i を次の行 i+1 につなげるのは
//   1. 行 i が文末の記号（. ! ? …。後ろの閉じ引用符・括弧は可）で終わっていない、かつ
//   2. 次のどれか:
//      a. 行 i が , ; : で終わる
//      b. 行 i の最後の語が「つなぎの語」（CONNECTOR_WORDS: 冠詞・前置詞・接続詞・所有詞）… 後ろに続きがないと
//         文にならない語。é / vai / vou / quero / sei のような動詞は入れない（「Você sabe como é」「Eu sei」
//         「Agora eu vou」のように文の終わりにもよく来るため。つなげると次の文を補語として読んだ誤訳になる）
//      c. 次の行が小文字で始まる（行頭の引用符・括弧・ダッシュは飛ばす）
// ただし次のときはつなげない:
//   - 空行（前奏・間奏）をまたぐ
//   - 時刻が分かっていて、次の行まで GROUP_MAX_GAP_SEC（7秒）を超える（間奏をはさむ）
//   - まとめると GROUP_MAX_LINES（3行）を超える、または語数が GROUP_MAX_WORDS（24語）を超える
//     （長すぎる訳は、どの行の訳か分かりにくい）
//   - 行全体が括弧で囲まれた行（コーラスの合いの手）は前後とつなげない
// どの空でない行も、ちょうど1つの文に入る（1行だけの文もある）。空行はどの文にも入らない。
// 歌詞の本文は扱うだけで保存しない（文のキーは lineHash のハッシュ）。
// ============================================================================

import { lineHash, lineKey } from "./lyrics";
import { isSentenceEnd } from "./sentenceGroups";

export interface LyricGroupInput {
  text: string;
  /** 行の時刻（秒）。同期のない歌詞は undefined / null */
  time?: number | null;
}

/** 1文分の行のまとまり */
export interface LyricGroup {
  /** 最初の行の番号 */
  start: number;
  /** 最後の行の次の番号（lines.slice(start, end) がこの文） */
  end: number;
  /** 行を正規化（lineKey）して空白1つでつないだもの */
  text: string;
}

export const GROUP_MAX_LINES = 3;
export const GROUP_MAX_WORDS = 24;
export const GROUP_MAX_GAP_SEC = 7;

/**
 * 行末に来たら「文がまだ続く」とみなす語（小文字・NFC）。
 * 冠詞・前置詞（縮約を含む）・接続詞・所有詞だけ。動詞（é, vai, vou, quero, sei など）は文の終わりにも
 * よく来るので入れない（入れると「Você sabe como é」＋次の文、のような別々の文をつないでしまう）。
 */
export const CONNECTOR_WORDS: ReadonlySet<string> = new Set(
  [
    "que", "de", "do", "da", "dos", "das", "e", "o", "a", "os", "as", "um", "uma",
    "pra", "pro", "pras", "pros", "para", "com", "em", "no", "na", "nos", "nas",
    "se", "quando", "porque", "mas", "sem", "por", "pelo", "pela",
    "meu", "minha", "teu", "tua", "seu", "sua", "nosso", "nossa",
  ].map((w) => w.normalize("NFC"))
);

const wordsOf = (s: string): string[] => s.split(/\s+/).filter(Boolean);

/** 行末の語（小文字・前後の記号を除く） */
function lastWord(text: string): string {
  const ws = wordsOf(text);
  return (ws[ws.length - 1] ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/** 行頭の記号（引用符・括弧・ダッシュなど）を飛ばして、最初の文字が小文字か */
function startsLower(text: string): boolean {
  return /^\p{Ll}/u.test(text.trim().replace(/^[^\p{L}\p{N}]+/u, ""));
}

/** 行全体が括弧で囲まれている（コーラスの合いの手） */
function isParenthetical(text: string): boolean {
  return /^[(（[].*[)）\]]$/u.test(text.trim());
}

/** 行 cur が次の行 next に文としてつながるか（空行・時刻・長さの制限は groupLyricLines で見る） */
export function continuesInto(cur: string, next: string): boolean {
  const c = cur.trim();
  const n = next.trim();
  if (!c || !n) return false;
  if (isParenthetical(c) || isParenthetical(n)) return false;
  if (isSentenceEnd(c)) return false;
  if (/[,;:]["'”’»)）\]]*$/u.test(c)) return true;
  if (CONNECTOR_WORDS.has(lastWord(c))) return true;
  return startsLower(n);
}

/** 次の行までの時間（秒）。どちらかの時刻が分からなければ 0（時間では切らない） */
function gapSec(a: LyricGroupInput, b: LyricGroupInput): number {
  const ta = a.time;
  const tb = b.time;
  if (typeof ta !== "number" || typeof tb !== "number" || !Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return tb - ta;
}

/** 歌詞の行を文ごとにまとめる。行の順番は変えず、空でない行をすき間なく覆う */
export function groupLyricLines(lines: readonly LyricGroupInput[]): LyricGroup[] {
  const out: LyricGroup[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = lines[i].text.trim();
    if (!first) {
      i++;
      continue;
    }
    let end = i + 1;
    let words = wordsOf(first).length;
    while (end < lines.length && end - i < GROUP_MAX_LINES) {
      const prev = lines[end - 1];
      const next = lines[end];
      const nt = next.text.trim();
      if (!nt) break;
      if (gapSec(prev, next) > GROUP_MAX_GAP_SEC) break;
      const nw = wordsOf(nt).length;
      if (words + nw > GROUP_MAX_WORDS) break;
      if (!continuesInto(prev.text, nt)) break;
      words += nw;
      end++;
    }
    out.push({
      start: i,
      end,
      text: lines
        .slice(i, end)
        .map((l) => lineKey(l.text))
        .join(" "),
    });
    i = end;
  }
  return out;
}

/** 文の和訳の保存キー = つないだ本文のハッシュ（1行だけの文はその行の lineHash と同じ） */
export function lineGroupKey(group: Pick<LyricGroup, "text">): string {
  return lineHash(group.text);
}

/** 行番号 → その行の文の番号（空行は -1） */
export function groupIndexByLine(groups: readonly LyricGroup[], lineCount: number): number[] {
  const out = new Array<number>(lineCount).fill(-1);
  groups.forEach((g, gi) => {
    for (let i = g.start; i < g.end && i < lineCount; i++) out[i] = gi;
  });
  return out;
}

// ---------------------------------------------------------------------------
// 和訳の単位と表示の優先順位
// ---------------------------------------------------------------------------

/** 和訳の出どころ: mt = 無料の機械翻訳 / ai = AI 翻訳 / user = 自分で書いた・直した訳（無い古い記録もある） */
export type TranslationSource = "mt" | "ai" | "user";
export const TRANSLATION_SOURCES: readonly TranslationSource[] = ["mt", "ai", "user"];

/** 保存している和訳1件（useMusic の LineTranslation と同じ形） */
export interface StoredTranslation {
  text: string;
  edited: boolean;
  source?: TranslationSource;
  note?: string;
}

/** 和訳の単位: sentence = 文ごと（既定） / line = 行ごと */
export type JaMode = "sentence" | "line";
export const JA_MODES: readonly JaMode[] = ["sentence", "line"];
export const JA_MODE_LABEL: Record<JaMode, string> = { sentence: "文ごと", line: "行ごと" };

/** 保存値を選択肢に丸める（無い・知らない値は sentence） */
export function toJaMode(v: unknown): JaMode {
  return v === "line" ? "line" : "sentence";
}

/** 1回の翻訳で送る単位（行、または文） */
export interface TranslationUnit {
  /** 保存キー（行は lineHash、文は lineGroupKey） */
  key: string;
  /** 送る本文（正規化済み） */
  text: string;
  /** この単位が覆う行のキー（同じ行は1回だけ） */
  lineKeys: string[];
}

/**
 * 翻訳の単位の一覧（同じ本文は1つにまとめる・出てくる順）。
 * line: 空でない行ごと / sentence: 文ごと（1行だけの文は行と同じキー）
 */
export function translationUnits(
  lines: readonly { text: string }[],
  groups: readonly LyricGroup[],
  mode: JaMode
): TranslationUnit[] {
  const out = new Map<string, TranslationUnit>();
  if (mode === "line") {
    for (const l of lines) {
      if (!l.text.trim()) continue;
      const key = lineHash(l.text);
      if (!out.has(key)) out.set(key, { key, text: lineKey(l.text), lineKeys: [key] });
    }
  } else {
    for (const g of groups) {
      const key = lineGroupKey(g);
      if (out.has(key)) continue;
      const lineKeys = [...new Set(lines.slice(g.start, g.end).map((l) => lineHash(l.text)))];
      out.set(key, { key, text: g.text, lineKeys });
    }
  }
  return [...out.values()];
}

const hasText = (t: StoredTranslation | undefined): t is StoredTranslation => !!t && typeof t.text === "string" && !!t.text.trim();
/** 行自身の訳が、文ごとの訳より優先される訳（自分で直した訳・AI の訳）か */
const ownWins = (t: StoredTranslation | undefined): boolean => hasText(t) && (t.edited || t.source === "ai");

/**
 * 機械翻訳で作る単位。
 * - redo = false: まだ訳の無い単位（複数行の文で、どの行にも自分の訳・AI の訳があるものは作らない）
 * - redo = true（作り直す）: 自分で直した訳・AI の訳を除くすべて（同じく、全行に自分の訳・AI の訳がある文は除く）
 */
export function pendingUnits(
  units: readonly TranslationUnit[],
  translations: Readonly<Record<string, StoredTranslation | undefined>>,
  redo: boolean
): TranslationUnit[] {
  return units.filter((u) => {
    const multi = u.lineKeys.length > 1 || u.lineKeys[0] !== u.key;
    if (multi && u.lineKeys.every((k) => ownWins(translations[k]))) return false;
    const cur = translations[u.key];
    if (redo) return !cur?.edited && cur?.source !== "ai";
    return !hasText(cur);
  });
}

/** 1行分の和訳の表示 */
export interface LineTranslationView {
  /** この行の下に出す訳（無ければ undefined） */
  text?: string;
  /**
   * text の出どころ: user = 自分で直した訳 / ai = AI の訳 / group = 文ごとの訳（文の最後の行）/
   * mt = 行ごとの機械翻訳 / covered = 文の途中の行（訳は文の最後の行に出る）/ none = 訳なし
   */
  kind: "user" | "ai" | "group" | "mt" | "covered" | "none";
  /** 文ごとの訳を出している複数行の文での、この行の位置（左の線の表示用）。それ以外は null */
  bracket: "first" | "middle" | "last" | null;
  /** 文の最後の行で、行自身の訳（自分の訳・AI の訳）を優先したときに、あわせて出す文全体の訳 */
  groupText?: string;
}

/**
 * 行に出す和訳を決める（行ごとの優先順位）:
 *   自分で直した行の訳（edited）> AI の行の訳（source "ai"）> 文ごと表示なら文の訳（文の最後の行に出す）> 行の機械翻訳
 * 文ごと表示で文の訳があるとき、文の途中の行は covered（訳は最後の行に出る）。
 * 文の訳がまだ無ければ、行の機械翻訳（行ごとに作った古い訳）をそのまま出す。
 * groupLineKeys（文の各行のキー）を渡したときは、文のどの行にも行自身の訳（自分の訳・AI の訳）があれば
 * 文の訳を使わない（線も「文の訳:」も出さない。AI で曲全体を訳した後に、粗い機械翻訳が重ならないように。
 * pendingUnits がそういう文の訳を作らないのと同じ規則）。
 */
export function resolveLineTranslation(p: {
  translations: Readonly<Record<string, StoredTranslation | undefined>>;
  /** この行の和訳キー（lineHash。空行は ""） */
  lineKey: string;
  mode: JaMode;
  /** この行の文（空行は null）。key は lineGroupKey */
  group: { key: string; start: number; end: number } | null;
  /** この行の番号 */
  index: number;
  /** この行の文の各行のキー（lineHash。任意。上の説明） */
  groupLineKeys?: readonly string[];
}): LineTranslationView {
  if (!p.lineKey) return { kind: "none", bracket: null };
  const own = p.translations[p.lineKey];
  const g = p.group;
  const multi = p.mode === "sentence" && !!g && g.end - g.start > 1;
  const superseded = !!p.groupLineKeys?.length && p.groupLineKeys.every((k) => ownWins(p.translations[k]));
  const gt = multi && g && !superseded ? p.translations[g.key] : undefined;
  const groupText = hasText(gt) ? gt.text : undefined;
  const isLast = multi && !!g && p.index === g.end - 1;
  const bracket: LineTranslationView["bracket"] =
    groupText && g ? (p.index === g.start ? "first" : isLast ? "last" : "middle") : null;
  const extra = isLast && groupText ? { groupText } : {};

  if (hasText(own) && own.edited) return { text: own.text, kind: "user", bracket, ...extra };
  if (hasText(own) && own.source === "ai") return { text: own.text, kind: "ai", bracket, ...extra };
  if (groupText) return isLast ? { text: groupText, kind: "group", bracket } : { kind: "covered", bracket };
  if (hasText(own)) return { text: own.text, kind: "mt", bracket: null };
  return { kind: "none", bracket: null };
}
