// ============================================================================
// 🧑‍🏫 AI 先生のプロンプト（純関数。ストア・DOM・localStorage に触らない）
//   検証: scripts/check-ai.ts（npm run check:ai。例はこの検証のために作った短い文だけ）
// - buildTeacherSystem(profile, ctx): 先生の役割と答え方の決まり・学習者のようす・いま見ている内容。
//   短く保つ（各項目は数百文字まで・配列は数件まで）。
//   例文の書き方の決まり: ポルトガル語の例文は1文ずつ「🇧🇷 」で始まる1行、次の行に「🇯🇵 」で始まる意味
//   （画面で例文カード＝読み上げ・カナ付きにする。format.ts の parseTeacherText）
// - buildTurns(history): 送る会話（最後の 20 発言まで）
// - learnerProfile(cards, resolve, today): 学習した語の数・習得の数・最近つまずいた語・今日復習した語
// - QUICK_QUESTIONS: 文脈の種類ごとの「すぐ聞ける質問」
// ============================================================================

import type { SrsCard } from "../../data/types";
import { displayLevel } from "../../srs/scheduler";
import { baseOfKey, isProdKey } from "../../srs/cardKey";
import type { TeacherContext, TeacherContextKind } from "./teacherContext";
import type { ChatTurn } from "./types";

/** 送る会話の発言の上限（古い発言は送らない。画面と履歴には残る） */
export const MAX_TURNS = 20;

/** プロンプトに入れる1項目の長さの上限 */
const FIELD_CHARS = 300;

// ---------------------------------------------------------------------------
// 学習者のようす
// ---------------------------------------------------------------------------

export interface TeacherProfile {
  /** 学習した語（一度でも評価した理解カード）の数 */
  learned: number;
  /** 習得（間隔 21 日以上）の語の数 */
  mature: number;
  /** 最近つまずいた語（「pt（ja）」。最大5語） */
  weak: string[];
  /** 今日復習した語（「pt（ja）」。最大8語。例文づくりに使う） */
  today: string[];
  /** 興味 */
  interest: string;
}

export const TEACHER_INTEREST = "カポエイラ（ブラジル音楽・アフロ・ブラジル文化）";

/** 語の見出し（「pt（ja）」。訳は短く） */
function wordLabel(w: { pt: string; ja: string }): string {
  const ja = w.ja.replace(/\s+/g, " ").trim();
  return `${w.pt}（${ja.length > 16 ? `${ja.slice(0, 15)}…` : ja}）`;
}

/**
 * SRS のカードから学習者のようすを作る。resolve = 語の ID → 見出し（引けない語は数だけに入れる）。
 * 産出カード（"…@p"）は語の数に入れない（今日復習した語には元の語として入れる）
 */
export function learnerProfile(
  cards: Readonly<Record<string, SrsCard>>,
  resolve: (id: string) => { pt: string; ja: string } | undefined,
  today: string
): TeacherProfile {
  let learned = 0;
  let mature = 0;
  const weak: { id: string; last: string; lapses: number }[] = [];
  const todayIds: string[] = [];
  for (const [key, c] of Object.entries(cards)) {
    if (!c || c.last === null) continue;
    const prod = isProdKey(key);
    const id = baseOfKey(key);
    if (c.last === today && !todayIds.includes(id)) todayIds.push(id);
    if (prod) continue;
    learned++;
    if (displayLevel(c) === "mature") mature++;
    if (c.lapses > 0) weak.push({ id, last: c.last, lapses: c.lapses });
  }
  // 最近つまずいた語: 最後に学習した日の新しい順、同じ日なら失敗の多い順
  weak.sort((a, b) => (a.last === b.last ? b.lapses - a.lapses : a.last < b.last ? 1 : -1));
  const pick = (ids: readonly string[], n: number) => {
    const out: string[] = [];
    for (const id of ids) {
      const w = resolve(id);
      if (w) out.push(wordLabel(w));
      if (out.length >= n) break;
    }
    return out;
  };
  return {
    learned,
    mature,
    weak: pick(
      weak.map((w) => w.id),
      5
    ),
    today: pick(todayIds, 8),
    interest: TEACHER_INTEREST,
  };
}

// ---------------------------------------------------------------------------
// システムプロンプト
// ---------------------------------------------------------------------------

/** 先生の役割と答え方の決まり（どの質問でも同じ） */
export const TEACHER_RULES = [
  "あなたは、日本語を母語とする学習者にブラジル・ポルトガル語を教える、親しみやすく経験豊富な先生です。",
  "",
  "# 答え方",
  "- 日本語で、簡潔に答える（短い段落と箇条書き。前置き・同じことの繰り返しは省く）。",
  "- ブラジルで実際に使われる言い方を教える（você・a gente など）。必要に応じて【口語】【丁寧】【スラング】の印を付け、地域による違いがあれば触れる。",
  "- 文法はやさしく説明し、ポルトガル語の例を添える。",
  "- 例文の書き方（必ず守る）: ポルトガル語の例文は1文ずつ、行頭を「🇧🇷 」にした1行に書き、そのすぐ次の行に、行頭を「🇯🇵 」にして日本語の意味を書く。例文の行には他のことを書かない。",
  "- HTML・表・コードブロックは使わない。強調は **太字** だけ、箇条書きは「- 」で始める。",
  "- 歌詞について聞かれたら、意味・ニュアンス・文脈・比喩や言葉遊び・文化的な背景（アフロ・ブラジル文化、カポエイラ、地方の言葉など）を説明する。歌詞をまるごと・長く書き写さない（引用は説明に必要な短い部分だけ）。",
  "- 自信がないこと・分からないことは、正直にそう伝える（推測なら推測と書く）。",
].join("\n");

const KIND_JA: Record<TeacherContextKind, string> = {
  "song-line": "歌の歌詞の1行",
  "song-word": "歌詞に出てきた単語",
  pattern: "パターンプラクティスの文型",
  word: "単語帳の単語",
  sentence: "教材の文",
  general: "アプリの画面",
};

/** 文脈の項目名 → 見出し（プロンプトに書く順もこの順） */
const FIELD_JA: [string, string][] = [
  ["title", "曲"],
  ["artist", "アーティスト"],
  ["screen", "いま開いている画面"],
  ["source", "教材"],
  ["category", "カテゴリ"],
  ["before", "前の行"],
  ["line", "この行"],
  ["after", "次の行"],
  ["translation", "アプリで出している和訳"],
  ["surface", "単語（歌詞の形）"],
  ["lemma", "原形"],
  ["pt", "ポルトガル語"],
  ["ja", "意味"],
  ["meaning", "意味（辞書）"],
  ["pos", "品詞"],
  ["frame", "文型"],
  ["frameJa", "文型の和訳"],
  ["sentence", "今の文"],
  ["sentenceJa", "今の文の和訳"],
  ["options", "入れ替え語の例"],
  ["example", "例文"],
  ["exampleJa", "例文の和訳"],
  ["note", "メモ"],
  ["chosen", "クイズで間違えて選んだ語"],
];

const cut = (s: string, n = FIELD_CHARS) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** 文脈を「- 見出し: 値」の行にする（知っている項目だけ。配列は「 / 」でつなぐ） */
export function contextBlock(ctx: TeacherContext): string {
  const lines = [`- 種類: ${KIND_JA[ctx.kind]}`];
  for (const [key, label] of FIELD_JA) {
    const v = ctx.data[key];
    if (v === undefined) continue;
    const text = Array.isArray(v) ? v.slice(0, 8).map((x) => cut(x, 160)).join(" / ") : cut(v);
    if (text) lines.push(`- ${label}: ${text}`);
  }
  return lines.join("\n");
}

/** 先生のシステムプロンプト（役割・答え方・学習者のようす・いま見ている内容） */
export function buildTeacherSystem(profile: TeacherProfile, ctx: TeacherContext | null): string {
  const me = [
    "# 学習者",
    `- 学習した語: ${profile.learned}語（うち習得 ${profile.mature}語）`,
    ...(profile.weak.length ? [`- 最近つまずいた語: ${profile.weak.join("、")}`] : []),
    ...(profile.today.length ? [`- 今日復習した語: ${profile.today.join("、")}`] : []),
    `- 興味: ${profile.interest}`,
    "- 語彙のレベルに合わせ、知らなそうな語には意味を添える。",
  ];
  const parts = [TEACHER_RULES, me.join("\n")];
  if (ctx) {
    const head = ctx.kind === "general" ? "# いま開いている画面" : "# いま見ている内容（質問はこれについてのことが多い）";
    parts.push(`${head}\n${contextBlock(ctx)}`);
  }
  return parts.join("\n\n");
}

/** 送る会話（履歴の最後の MAX_TURNS 発言。空の発言の除去・同じ役割のまとめは normalizeTurns が行う） */
export function buildTurns(history: readonly { role: "user" | "assistant"; text: string }[]): ChatTurn[] {
  return history.slice(-MAX_TURNS).map((m) => ({ role: m.role, text: m.text }));
}

// ---------------------------------------------------------------------------
// すぐ聞ける質問
// ---------------------------------------------------------------------------

export interface QuickQuestion {
  /** チップの文字 */
  label: string;
  /** 送る文（fill なら入力欄に入れるだけ） */
  text: string;
  /** 入力欄に入れて、「〜」を選んだ状態にする（学習者が書き足してから送る） */
  fill?: boolean;
}

const WORD_QUESTIONS: QuickQuestion[] = [
  { label: "使い方と例文", text: "この語の使い方を、例文を3つ付けて教えて" },
  { label: "似た語との違い", text: "この語と似た語・まぎらわしい語との違いを教えて" },
  { label: "覚え方のコツ", text: "この語の覚え方のコツを教えて" },
];

export const QUICK_QUESTIONS: Record<TeacherContextKind, QuickQuestion[]> = {
  "song-line": [
    { label: "この行の意味と文脈", text: "この行の意味と、曲の中での文脈を教えて" },
    { label: "比喩・言葉遊びは？", text: "この行に比喩・言葉遊び・文化的な背景はある？" },
    { label: "文法を分解して", text: "この行の文法を、語ごとに分解して説明して" },
    { label: "日常会話でも使う？", text: "この行の言い回しは、日常会話でも使う？使うなら例文も" },
  ],
  "song-word": WORD_QUESTIONS,
  word: WORD_QUESTIONS,
  pattern: [
    { label: "例文をもっと5つ", text: "この文型で、例文をもっと5つ作って" },
    { label: "こんな場面ではどう言う？", text: "この文型を使って、〜の場面ではどう言う？", fill: true },
    { label: "丁寧・くだけた言い方", text: "この文の、丁寧な言い方とくだけた言い方を教えて" },
  ],
  sentence: [
    { label: "この表現の使いどころ", text: "この表現はどんな場面で使う？" },
    { label: "言い換えは？", text: "この文の言い換えを、ニュアンスの違いと一緒に教えて" },
    { label: "文法を説明して", text: "この文の文法を説明して" },
  ],
  general: [
    { label: "〜って何て言う？", text: "「〜」ってポルトガル語で何て言う？", fill: true },
    { label: "発音のコツ", text: "ブラジル・ポルトガル語の発音で、日本人がつまずきやすい点とコツを教えて" },
    { label: "今日の復習語で例文を", text: "今日復習した語を使って、短い例文を5つ作って（今日の語が無ければ、最近つまずいた語で）" },
  ],
};
