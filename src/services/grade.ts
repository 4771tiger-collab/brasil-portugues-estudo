// ============================================================================
// 入力式の答えの採点（純関数。ブラウザ・Node の両方から使う）
// - gradeWord: 1語（または1フレーズ）を exact / accent / typo / wrong の4段階で採点する
//     accent = アクセント記号（とセディーユ）だけが違う、typo = つづりの小さな誤り
//     ただし入力が「別の実在語」（avó/avô、esta/está、e/é …）なら wrong（isKnownForm で判定）
// - alignTokens: 文を語単位の DP で対応付けて採点する（ディクテーション用。1語抜けても後ろがずれない）
// - charDiff: 文字単位の差分（LCS）。答え合わせで「どこが違ったか」を見せる
// - scoreSpeechWord / scoreSpeechSentence: 音声認識（🎤 言ってみる）の結果の採点
//     アクセント記号だけの違いは正解、数字は読み方に展開（"2" → dois/duas）、認識の候補のうち最も合うもの
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
  /**
   * アクセント記号（とセディーユ）だけの違いを exact にする（最小対の判定もしない）。
   * 音声認識の採点用: 認識結果の綴りは認識エンジンが決めたもので、学習者が書いたものではないため
   */
  accentInsensitive?: boolean;
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

/**
 * 正規化済みの入力 u と正解 e を比べる（diff は作らない。alignTokens の DP でも使う）。
 * accentFree なら、アクセント記号だけの違いは exact（音声認識の採点）
 */
function judge(u: string, e: string, known: boolean, budget: (len: number) => number, accentFree = false): Judged {
  const distance = levenshtein(u, e);
  if (u === e) return { grade: "exact", distance };
  const fu = fold(u);
  const fe = fold(e);
  if (fu === fe) {
    if (accentFree) return { grade: "exact", distance };
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
    const j = judge(u, e, known, budget, !!o.accentInsensitive);
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
// 音声認識（🎤 言ってみる）の採点
// 認識結果の綴りは認識エンジンが決めたもので、学習者が書いたものではない。そのため
// - アクセント記号だけの違いは正解にする（accentInsensitive）
// - 数字は読み方に展開して比べる（認識エンジンは "dois" を "2" と書くことが多い。2 は dois/duas のどちらでも可）
// - 認識エンジンが記号で書く読み方も語にする（"10%" → dez por cento、"R$ 60" → sessenta reais、"5º" → quinto、"38°" → graus）
// - 大文字・句読点は normalizeAnswer で無視する
// 認識の候補（maxAlternatives）が複数あれば、いちばん良く合う候補で採点する。
// ---------------------------------------------------------------------------

/** 0〜20 の読み方（読み方が複数ある数は男性形・よく使う綴りを先に） */
const NUM_0_20: readonly (readonly string[])[] = [
  ["zero"], ["um", "uma"], ["dois", "duas"], ["três"], ["quatro"], ["cinco"], ["seis"], ["sete"], ["oito"], ["nove"],
  ["dez"], ["onze"], ["doze"], ["treze"], ["catorze", "quatorze"], ["quinze"], ["dezesseis"], ["dezessete"], ["dezoito"],
  ["dezenove"], ["vinte"],
];
/** 20〜90 の十の位 */
const TENS: Readonly<Record<number, string>> = {
  2: "vinte", 3: "trinta", 4: "quarenta", 5: "cinquenta", 6: "sessenta", 7: "setenta", 8: "oitenta", 9: "noventa",
};

/** 100〜900 の百の位（男性形・女性形。100 ちょうどは cem） */
const HUNDREDS: Readonly<Record<number, readonly string[]>> = {
  1: ["cento"], 2: ["duzentos", "duzentas"], 3: ["trezentos", "trezentas"], 4: ["quatrocentos", "quatrocentas"],
  5: ["quinhentos", "quinhentas"], 6: ["seiscentos", "seiscentas"], 7: ["setecentos", "setecentas"],
  8: ["oitocentos", "oitocentas"], 9: ["novecentos", "novecentas"],
};
/** 1つの数の読み方の上限（男性形・女性形の組み合わせが増えすぎないように） */
const NUMBER_FORMS_MAX = 8;

/**
 * 数の読み方（0〜999 999）。読み方が複数あれば全部（1 → um/uma、2 → dois/duas、14 → catorze/quatorze、
 * 21 → vinte e um/vinte e uma、504 → quinhentos e quatro/quinhentas e quatro）。先頭ほど男性形・重複なし・
 * NUMBER_FORMS_MAX 通りまで。対応しない数（100万以上・負・小数）は []（数字のまま比べる）
 */
export function numberWords(n: number): string[] {
  if (!Number.isInteger(n) || n < 0) return [];
  if (n <= 20) return [...NUM_0_20[n]];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const u = n % 10;
    return u === 0 ? [t] : NUM_0_20[u].map((w) => `${t} e ${w}`);
  }
  if (n === 100) return ["cem"];
  if (n < 1000) {
    const h = HUNDREDS[Math.floor(n / 100)];
    const r = n % 100;
    return r ? uniq(h.flatMap((a) => numberWords(r).map((b) => `${a} e ${b}`))).slice(0, NUMBER_FORMS_MAX) : [...h];
  }
  if (n < 1_000_000) {
    const k = Math.floor(n / 1000);
    const r = n % 1000;
    const ks = k === 1 ? ["mil"] : numberWords(k).map((w) => `${w} mil`);
    if (!r) return ks.slice(0, NUMBER_FORMS_MAX);
    // 1100 → mil e cem、1250 → mil duzentos e cinquenta（下3桁が100未満か百の倍数なら e でつなぐ）
    const j = r < 100 || r % 100 === 0 ? " e " : " ";
    return uniq(ks.flatMap((a) => numberWords(r).map((b) => a + j + b))).slice(0, NUMBER_FORMS_MAX);
  }
  return [];
}

/** 序数 1〜10（男性形。女性形は語末の o を a に） */
const ORDINALS = ["primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "oitavo", "nono", "décimo"];
/** 数（3桁区切りの点も可）を1つ取り出すパターン */
const NUM_SRC = String.raw`\d{1,3}(?:\.\d{3})+(?!\d)|\d+`;
const MONEY_RE = new RegExp(String.raw`R\$\s?(${NUM_SRC})(?:,(\d{2}))?(?!\d)`, "g");
const PERCENT_RE = new RegExp(String.raw`(${NUM_SRC})\s?%`, "g");
const ORD_M_RE = /(\d+)\s?º/g;
const ORD_F_RE = /(\d+)\s?ª/g;
const DEGREE_RE = /(\d+)\s?°(?:\s?C(?![\p{L}\p{M}]))?/gu;

const numOf = (d: string) => Number(d.replace(/\./g, ""));
const ordinalOf = (d: string, fem: boolean): string | null => {
  const w = ORDINALS[numOf(d) - 1];
  return w ? (fem ? `${w.slice(0, -1)}a` : w) : null;
};

/**
 * 認識エンジンが記号で書く読み方を語に置き換えた形（数字は残す。numberWords で読む）。
 * "R$ 60" → "60 reais"（1 は um real、センタボは "e 50 centavos"）、"10%" → "10 por cento"、
 * "5º" → "quinto"、"1ª" → "primeira"（1〜10 以外は記号だけ外す）、"38°" → "38 graus"（1〜10 なら序数の形も）。
 * NFKC は º を o、ª を a にしてしまうので、その前に置き換える（全角の数字と ％ は先に半角にする）。
 * 置き換える記号が無ければ [s]
 */
function rewriteSymbols(s: string): string[] {
  const t = s
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/％/g, "%")
    .replace(MONEY_RE, (_m, n: string, c?: string) => {
      const v = numOf(n);
      const cents = c ? Number(c) : 0;
      const centPart = cents ? `${c} centavo${cents === 1 ? "" : "s"}` : "";
      if (v === 0 && cents) return centPart;
      return (v === 1 ? "um real" : `${n} reais`) + (centPart ? ` e ${centPart}` : "");
    })
    .replace(PERCENT_RE, "$1 por cento")
    .replace(ORD_M_RE, (_m, d: string) => ordinalOf(d, false) ?? d)
    .replace(ORD_F_RE, (_m, d: string) => ordinalOf(d, true) ?? d);
  if (!t.includes("°")) return t === s ? [s] : [t];
  const graus = t.replace(DEGREE_RE, "$1 graus");
  const ordinal = t.replace(DEGREE_RE, (_m, d: string) => ordinalOf(d, false) ?? `${d} graus`);
  return ordinal === graus ? [graus] : [graus, ordinal];
}

/** 数字の並び（"1.000" のような3桁区切りも1つの数） */
const DIGITS_RE = /\d{1,3}(?:\.\d{3})+(?!\d)|\d+/g;

/** speechVariants が返す形の上限（読み方が複数ある数がいくつもある文で増えすぎないように） */
export const SPEECH_VARIANTS_MAX = 8;

/**
 * 数字を読み方に置き換えた形の一覧（"2 cafés" → ["dois cafés", "duas cafés"]）。
 * 読み方が複数ある数が並ぶときは組み合わせ（先頭ほど男性形。max 通りまで）。
 * 記号で書いた読み方（R$・%・º/ª・°）も語にする（rewriteSymbols）。
 * 数字も記号も無ければ [s]（全角数字は半角にしてから読む）
 */
export function speechVariants(s: string, max = SPEECH_VARIANTS_MAX): string[] {
  const cap = Math.max(1, max);
  const pres = rewriteSymbols(s);
  const out: string[] = [];
  for (const pre of pres) {
    for (const v of numberVariants(pre, cap)) if (!out.includes(v)) out.push(v);
  }
  return out.slice(0, cap);
}

/** speechVariants の数字の部分（数字が無ければ [s]） */
function numberVariants(s: string, max: number): string[] {
  const text = s.normalize("NFKC");
  let out = [""];
  let at = 0;
  const add = (forms: readonly string[]) => {
    out = out.flatMap((p) => forms.map((f) => p + f)).slice(0, max);
  };
  for (const m of text.matchAll(DIGITS_RE)) {
    const words = numberWords(numOf(m[0]));
    add([text.slice(at, m.index)]);
    add(words.length ? words.map((w) => ` ${w} `) : [m[0]]);
    at = m.index! + m[0].length;
  }
  if (at === 0) return [s];
  add([text.slice(at)]);
  return out.map((v) => v.replace(/\s+/g, " ").trim());
}

/** 名詞の前に付けて言いがちな冠詞（「casa」を「a casa」と言っても正解にする） */
const LEADING_ARTICLES = new Set(["o", "a", "os", "as", "um", "uma", "uns", "umas"]);

/** 先頭の冠詞を外した形（冠詞で始まらない・冠詞だけなら null） */
function withoutArticle(s: string): string | null {
  const m = normalizeAnswer(s).match(/^(\S+) (.+)$/);
  return m && LEADING_ARTICLES.has(m[1]) ? m[2] : null;
}

/** 重複と空を除く（順は保つ） */
function uniq(list: readonly string[]): string[] {
  return [...new Set(list.map((x) => x.trim()).filter(Boolean))];
}

/** 1語（1フレーズ）を言ってみた結果 */
export interface SpeechWordScore {
  kind: "word";
  /** 採点（accent は出ない: アクセントだけの違いは exact） */
  grade: Grade;
  /** 採点に使った聞き取り（認識の候補の元の表記）。聞き取れていなければ "" */
  heard: string;
  /** 採点の詳細（差分・注記。expected は正解の元の表記） */
  result: GradeResult;
  /** 採点から勧める SRS の評価（exact → good、typo → hard、wrong → again） */
  suggestedRating: Rating;
}

/** 1文を言ってみた結果 */
export interface SpeechSentenceScore {
  kind: "sentence";
  /** 採点に使った聞き取り（認識の候補の元の表記） */
  heard: string;
  /** 正解の語と聞き取った語の対応（exp は正解の表記。数字は読み方に置き換えた形） */
  alignment: Alignment;
  /** 0〜100（下の speechPercent） */
  percent: number;
}

export type SpeechScore = SpeechWordScore | SpeechSentenceScore;

const betterGrade = (a: GradeResult, b: GradeResult) =>
  GRADE_RANK[a.grade] < GRADE_RANK[b.grade] || (GRADE_RANK[a.grade] === GRADE_RANK[b.grade] && a.distance < b.distance);

/**
 * 1語（1フレーズ）の採点。認識の候補 × 正解の表記（"a/b" も展開）の組のうち、いちばん良い gradeWord。
 * アクセント記号だけの違いは正解。数字は読み方に展開し、先頭の冠詞（o/a/um/uma…）は外した形でも比べる。
 * 正解に届かない（wrong）ときは、いちばん確からしい候補（先頭）で採点を見せる。
 * isKnownForm を渡すと、別の実在語に聞こえたとき（typo の範囲でも）wrong にする（入力式と同じ）。
 */
export function scoreSpeechWord(
  transcripts: readonly string[],
  expected: string | readonly string[],
  o: GradeOptions = {}
): SpeechWordScore {
  const opts: GradeOptions = { ...o, accentInsensitive: true };
  // 数字を読み方にした正解 → 元の表記（採点の expected を元の表記に戻すため）
  const rawOf = new Map<string, string>();
  for (const raw of (typeof expected === "string" ? [expected] : expected).flatMap(expandAlternatives)) {
    for (const v of uniq(speechVariants(raw))) if (!rawOf.has(v)) rawOf.set(v, raw.trim());
  }
  const exps = [...rawOf.keys()];
  const heardList = uniq(transcripts);
  let best: { r: GradeResult; heard: string } | null = null;
  for (const t of heardList) {
    for (const v of speechVariants(t)) {
      for (const cand of [v, withoutArticle(v)]) {
        if (cand === null) continue;
        const r = gradeWord(cand, exps, opts);
        if (!best || betterGrade(r, best.r)) best = { r, heard: t };
      }
    }
  }
  if (!best || best.r.grade === "wrong") {
    const top = heardList[0] ?? "";
    best = { r: gradeWord(speechVariants(top)[0], exps, opts), heard: top };
  }
  const result: GradeResult = { ...best.r, expected: rawOf.get(best.r.expected) ?? best.r.expected };
  return { kind: "word", grade: result.grade, heard: best.heard, result, suggestedRating: ratingForGrade(result.grade, false) };
}

/**
 * 文の点数（0〜100）。正しい語は1、惜しい語（つづりが近い）は0.5。分母は正解の語数＋余分な語の数
 * （聞き取れた語が多すぎても満点にならない）
 */
export function speechPercent(al: Alignment): number {
  const extra = al.tokens.filter((t) => t.grade === "extra").length;
  const denom = al.total + extra;
  return denom ? Math.round((100 * (al.correct + 0.5 * al.partial)) / denom) : 0;
}

/**
 * 1文の採点。認識の候補 × 正解の文（複数可）を alignTokens（アクセントの違いは正解）で対応付け、
 * 点数のいちばん高い組を返す（同点なら余分な語の少ない組、それも同じなら先の候補）。
 * 数字は両方とも読み方に展開して比べる。
 */
export function scoreSpeechSentence(
  transcripts: readonly string[],
  expected: string | readonly string[],
  o: GradeOptions = {}
): SpeechSentenceScore {
  const opts: GradeOptions = { ...o, accentInsensitive: true };
  const exps = uniq((typeof expected === "string" ? [expected] : expected).flatMap((e) => speechVariants(e)));
  if (!exps.length) exps.push("");
  let best: { al: Alignment; percent: number; extra: number; heard: string } | null = null;
  for (const t of uniq(transcripts)) {
    for (const v of speechVariants(t)) {
      for (const e of exps) {
        const al = alignTokens(v, e, opts);
        const percent = speechPercent(al);
        const extra = al.tokens.filter((x) => x.grade === "extra").length;
        if (!best || percent > best.percent || (percent === best.percent && extra < best.extra)) {
          best = { al, percent, extra, heard: t };
        }
      }
    }
  }
  if (!best) return { kind: "sentence", heard: "", alignment: alignTokens("", exps[0], opts), percent: 0 };
  return { kind: "sentence", heard: best.heard, alignment: best.al, percent: best.percent };
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
