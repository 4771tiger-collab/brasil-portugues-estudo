// ============================================================================
// 入力式の答えの採点（純関数。ブラウザ・Node の両方から使う）
// - gradeWord: 1語（または1フレーズ）を exact / accent / typo / wrong の4段階で採点する
//     accent = アクセント記号（とセディーユ）だけが違う、typo = つづりの小さな誤り
//     ただし入力が「別の実在語」（avó/avô、esta/está、e/é …）なら wrong（isKnownForm で判定）
// - alignTokens: 文を語単位の DP で対応付けて採点する（ディクテーション用。1語抜けても後ろがずれない）
// - charDiff: 文字単位の差分（LCS）。答え合わせで「どこが違ったか」を見せる
// 辞書（isKnownForm・和訳が同じ別見出し）は gradeLexicon.ts が遅延構築して注入する。
// このファイル自体はデータを読み込まない（scripts/check-grade から固定データで検証する）。
// ============================================================================

import type { Rating } from "../data/types";
import { alternatives, fold, tokenize } from "./lemmatize";

export type Grade = "exact" | "accent" | "typo" | "wrong";

/**
 * 文字単位の差分の1区間。
 *   same = 入力と正解で同じ、del = 入力にだけある（消すべき文字）、ins = 正解にだけある（足りない文字）
 */
export interface DiffSeg {
  kind: "same" | "ins" | "del";
  text: string;
}

export interface GradeResult {
  grade: Grade;
  /** いちばん近かった正解（表示用の元の表記。例: "Obrigado"）。正解が無ければ "" */
  expected: string;
  /** 正規化した入力と正解の編集距離（アクセントの違いも1と数える） */
  distance: number;
  /** 正規化した入力 → 正規化した正解 の文字差分 */
  diff: DiffSeg[];
  /** 利用者向けの一言（「ê が必要」「esta は別の語（á が必要）」など） */
  note?: string;
}

export interface GradeOptions {
  /** 実在する語形か（true なら、アクセント違い・つづり違いでも別の語として wrong にする） */
  isKnownForm?: (s: string) => boolean;
  /** 正解の長さ（アクセントを除いた文字数）ごとの、typo とみなす編集距離の上限 */
  typoBudget?: (len: number) => number;
}

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

/** 句読点・括弧・引用符（全角も含む）。空白に置き換える */
const PUNCT_RE = /[.,!?¿¡;:"“”„«»()[\]{}…。、，．！？：；（）「」『』]/g;
/** ハイフン・ダッシュ・スラッシュ。語の区切りとして空白に置き換える（guarda-chuva = guarda chuva） */
const DASH_RE = /[-‐‑‒–—―/]/g;

/**
 * 答えの比較用の正規化。
 * NFKC（全角英字を半角に）・小文字・’‘ʼ→'・句読点と括弧と引用符の除去・"-" "/" を空白に・
 * 語頭/語末のアポストロフィ除去（'tá → tá）・空白の連続を1つに。
 * "Socorro!" → "socorro"、"Bem-vindo" → "bem vindo"、"ｏｂｒｉｇａｄｏ" → "obrigado"
 */
export function normalizeAnswer(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘ʼ]/g, "'")
    .replace(PUNCT_RE, " ")
    .replace(DASH_RE, " ")
    .replace(/(^|\s)'+/g, "$1")
    .replace(/'+(?=\s|$)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 見出し語の表記ゆれを展開する（"Obrigado/Obrigada" → 2つ、括弧の注記は除く）。lemmatize.alternatives と同じ */
export function expandAlternatives(pt: string): string[] {
  return alternatives(pt);
}

// ---------------------------------------------------------------------------
// 編集距離と差分
// ---------------------------------------------------------------------------

/** 編集距離（OSA: 挿入・削除・置換・隣り合う2文字の入れ替えを各1とする）。コードポイント単位 */
export function levenshtein(a: string, b: string): number {
  const s = Array.from(a);
  const t = Array.from(b);
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;
  // d[i][j] = s[0..i) と t[0..j) の距離
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array<number>(m + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
    }
  }
  return d[n][m];
}

/**
 * 文字単位の差分（最長共通部分列）。input → expected に直すには del を消して ins を足す。
 * 同じ位置で両方あるときは del を先に出す（"avó"→"avô" は same "av"・del "ó"・ins "ô"）。
 */
export function charDiff(input: string, expected: string): DiffSeg[] {
  const a = Array.from(input);
  const b = Array.from(expected);
  const n = a.length;
  const m = b.length;
  // L[i][j] = a[i..] と b[j..] の最長共通部分列の長さ
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const out: DiffSeg[] = [];
  const push = (kind: DiffSeg["kind"], ch: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += ch;
    else out.push({ kind, text: ch });
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) {
      push("del", a[i]);
      i++;
    } else {
      push("ins", b[j]);
      j++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1語の採点
// ---------------------------------------------------------------------------

/** typo とみなす編集距離の上限（正解の長さ別）: 3文字以下 0、6文字以下 1、12文字以下 2、それより長い 3 */
export function defaultTypoBudget(len: number): number {
  if (len <= 3) return 0;
  if (len <= 6) return 1;
  if (len <= 12) return 2;
  return 3;
}

const GRADE_RANK: Record<Grade, number> = { exact: 0, accent: 1, typo: 2, wrong: 3 };

const hasMark = (ch: string) => fold(ch) !== ch;

/**
 * アクセント記号だけが違う2語（fold が同じ）の違いを一言で（「ê が必要」「á ではなく â」「é は不要」）。
 * 文字数が合わない（合成済みの文字が無い）ときは一般的な言い方にする。
 */
export function accentHint(input: string, expected: string): string {
  const a = Array.from(input);
  const b = Array.from(expected);
  if (a.length !== b.length) return "アクセント記号が違います";
  const notes: string[] = [];
  for (let k = 0; k < a.length; k++) {
    if (a[k] === b[k]) continue;
    let n: string;
    if (hasMark(b[k]) && !hasMark(a[k])) n = `${b[k]} が必要`;
    else if (hasMark(a[k]) && !hasMark(b[k])) n = `${a[k]} は不要（${b[k]}）`;
    else n = `${a[k]} ではなく ${b[k]}`;
    if (!notes.includes(n)) notes.push(n);
  }
  return notes.length ? notes.join("、") : "アクセント記号が違います";
}

interface Judged {
  grade: Grade;
  distance: number;
  note?: string;
}

/** 正規化済みの入力 u と正解 e を比べる（diff は作らない。alignTokens の DP でも使う） */
function judge(u: string, e: string, known: boolean, budget: (len: number) => number): Judged {
  const distance = levenshtein(u, e);
  if (u === e) return { grade: "exact", distance };
  const fu = fold(u);
  const fe = fold(e);
  if (fu === fe) {
    // アクセントだけが違う。ただし入力が別の実在語（最小対）なら不正解
    if (known) return { grade: "wrong", distance, note: `${u} は別の語（${accentHint(u, e)}）` };
    return { grade: "accent", distance, note: accentHint(u, e) };
  }
  const d = levenshtein(fu, fe);
  if (d > 0 && d <= budget(Array.from(fe).length)) {
    if (known) return { grade: "wrong", distance, note: `${u} は別の語` };
    return { grade: "typo", distance, note: `つづりが${d}文字違います` };
  }
  return { grade: "wrong", distance };
}

/**
 * 入力 input を正解 expected（複数可。"a/b" の表記ゆれも展開する）と比べ、いちばん良い結果を返す。
 * 順に: 完全一致 → exact、アクセントだけ違う → accent（入力が実在の別語なら wrong）、
 * アクセントを除いて編集距離が typoBudget 以内 → typo（入力が実在の別語なら wrong）、それ以外 → wrong。
 * 比較は normalizeAnswer 後（大文字・句読点・ハイフンは区別しない）。
 */
export function gradeWord(input: string, expected: string | readonly string[], o: GradeOptions = {}): GradeResult {
  const budget = o.typoBudget ?? defaultTypoBudget;
  const u = normalizeAnswer(input);
  const known = !!u && !!o.isKnownForm?.(u);
  const list = (typeof expected === "string" ? [expected] : expected).flatMap(expandAlternatives);
  let best: { j: Judged; e: string; raw: string } | null = null;
  const seen = new Set<string>();
  for (const raw of list) {
    const e = normalizeAnswer(raw);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    const j = judge(u, e, known, budget);
    if (
      !best ||
      GRADE_RANK[j.grade] < GRADE_RANK[best.j.grade] ||
      (GRADE_RANK[j.grade] === GRADE_RANK[best.j.grade] && j.distance < best.j.distance)
    ) {
      best = { j, e, raw: raw.trim() };
    }
  }
  if (!best) return { grade: "wrong", expected: "", distance: Array.from(u).length, diff: charDiff(u, "") };
  return {
    grade: best.j.grade,
    expected: best.raw,
    distance: best.j.distance,
    diff: charDiff(u, best.e),
    ...(best.j.note !== undefined ? { note: best.j.note } : {}),
  };
}

/** 「正解にする」（利用者の判断で正解扱い）で記録する評価: ヒントなしは good、ありは hard */
export function ratingForOverride(usedHint: boolean): Rating {
  return usedHint ? "hard" : "good";
}

/**
 * 採点結果 → SRS の評価。exact は good（ヒントを使ったら hard）、accent/typo は hard、wrong は again。
 */
export function ratingForGrade(g: Grade, usedHint: boolean): Rating {
  switch (g) {
    case "exact":
      return usedHint ? "hard" : "good";
    case "accent":
    case "typo":
      return "hard";
    case "wrong":
      return "again";
  }
}

// ---------------------------------------------------------------------------
// 文の採点（語単位の対応付け）
// ---------------------------------------------------------------------------

export interface AlignedToken {
  /** 正解側の語（元の表記）。入力にだけある語は null */
  exp: string | null;
  /** 入力側の語（元の表記）。抜けた語は null */
  got: string | null;
  grade: Grade | "missing" | "extra";
}

export interface Alignment {
  tokens: AlignedToken[];
  /** exact の語数 */
  correct: number;
  /** accent + typo の語数 */
  partial: number;
  /** 正解の語数 */
  total: number;
}

/** 置換のコスト（整数で持って小数の誤差を避ける。exact 0 / accent 0.25 / typo 0.5 / wrong 1.2、挿入・削除 1） */
const SUB_COST: Record<Grade, number> = { exact: 0, accent: 25, typo: 50, wrong: 120 };
const INDEL_COST = 100;

/** 文の中の1語と、その位置（s.normalize("NFC") の中の [start, end)） */
export interface WordSpan {
  text: string;
  start: number;
  end: number;
}

/**
 * 文を語に分け、位置も返す（lemmatize.tokenize。ハイフンでつながった語は normalizeAnswer に合わせて分ける）。
 * alignTokens が対応付ける語と同じ並び（ディクテーションのヒントで、語ごとに伏せるかを決めるのに使う）。
 * 位置は NFC にした文字列の中の位置。
 */
export function wordSpans(s: string): WordSpan[] {
  const out: WordSpan[] = [];
  for (const t of tokenize(s)) {
    let at = t.start;
    for (const part of t.text.split("-")) {
      if (part) out.push({ text: part, start: at, end: at + part.length });
      at += part.length + 1;
    }
  }
  return out;
}

/** 文を語に分ける（wordSpans の語だけ） */
function words(s: string): string[] {
  return wordSpans(s).map((w) => w.text);
}

/**
 * 入力文 input と正解文 answer を語単位の DP で対応付ける。
 * 置換のコストは gradeWord の段階ごと（exact 0、accent 0.25、typo 0.5、wrong 1.2）、挿入・削除は 1。
 * 同じコストなら置換を優先してたどる。tokens は文の順（抜けた語は missing、余分な語は extra）。
 */
export function alignTokens(input: string, answer: string, o: GradeOptions = {}): Alignment {
  const exp = words(answer);
  const got = words(input);
  const n = exp.length;
  const m = got.length;
  const g: Grade[][] = exp.map((e) => got.map((x) => gradeWord(x, e, o).grade));
  // D[i][j] = exp[0..i) と got[0..j) の最小コスト
  const D: number[][] = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Array<number>(m + 1).fill(0);
    row[0] = i * INDEL_COST;
    return row;
  });
  for (let j = 0; j <= m; j++) D[0][j] = j * INDEL_COST;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      D[i][j] = Math.min(
        D[i - 1][j - 1] + SUB_COST[g[i - 1][j - 1]],
        D[i - 1][j] + INDEL_COST,
        D[i][j - 1] + INDEL_COST
      );
    }
  }
  const rev: AlignedToken[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + SUB_COST[g[i - 1][j - 1]]) {
      rev.push({ exp: exp[i - 1], got: got[j - 1], grade: g[i - 1][j - 1] });
      i--;
      j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + INDEL_COST) {
      rev.push({ exp: exp[i - 1], got: null, grade: "missing" });
      i--;
    } else {
      rev.push({ exp: null, got: got[j - 1], grade: "extra" });
      j--;
    }
  }
  const tokens = rev.reverse();
  return {
    tokens,
    correct: tokens.filter((t) => t.grade === "exact").length,
    partial: tokens.filter((t) => t.grade === "accent" || t.grade === "typo").length,
    total: n,
  };
}

// ---------------------------------------------------------------------------
// ヒント
// ---------------------------------------------------------------------------

/** 入力式クイズのヒントの段階の上限（1: 頭文字、2: 語ごとの頭文字＋文字数） */
export const HINT_MAX = 2;

/**
 * 入力式クイズのヒント（表記ゆれは「／」で並べる）。
 * 1段目は頭文字（"Obrigado/Obrigada" → "O… ／ O…"）、2段目は語ごとに maskWord（"Tudo bem?" → "T___ b__?"）。
 */
export function hintText(pt: string, level: number): string {
  const alts = expandAlternatives(pt);
  if (level <= 0) return "";
  if (level === 1) return alts.map((a) => `${a.match(/\p{L}/u)?.[0] ?? ""}…`).join(" ／ ");
  return alts.map((a) => a.split(/\s+/).map(maskWord).join(" ")).join(" ／ ");
}

/** 頭文字だけ残して残りの文字を "_" にする（記号・空白はそのまま）。"você" → "v___"、"d'água" → "d'____" */
export function maskWord(w: string): string {
  let seen = false;
  let out = "";
  for (const ch of w) {
    if (/\p{L}/u.test(ch)) {
      if (!seen) {
        out += ch;
        seen = true;
      } else out += "_";
    } else out += ch;
  }
  return out;
}
