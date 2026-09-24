// ============================================================================
// 教材（読み物・スクリプト・ディクテーション・文型）の一覧と内容チェックの純関数（ブラウザ・Node の両方から使う）
// - 難易度の表示名と絞り込み（URL の ?level=）
// - 読み物の話題（topic）・文の数・内容チェックの設問（questions）の取り出しと、答えの記録
//   自作教材はバックアップから形の崩れた値が入りうるので、画面ではここを通して読む（崩れた設問は落とす）
// - スクリプトの会話（kind: "dialogue"）の話者（ちょうど2人のときだけ会話として扱う）
// - 難易度ごとのまとまり（ディクテーションの一覧）と、文型の一覧のまとまり（パターンプラクティス）
// 検証: scripts/check-content.ts
// ============================================================================

import type { Chunk, ContentLevel, Passage, PassageQuestion, Pattern, Script } from "../data/types";
import { groupChunks } from "./sentenceGroups";
import { seededShuffle } from "../srs/queue";

// ---------------------------------------------------------------------------
// 難易度
// ---------------------------------------------------------------------------
export const CONTENT_LEVELS: readonly ContentLevel[] = ["short", "medium", "long"];

export const LEVEL_LABEL: Record<ContentLevel, string> = { short: "短文", medium: "中文", long: "長文" };

export const isContentLevel = (v: unknown): v is ContentLevel =>
  typeof v === "string" && (CONTENT_LEVELS as readonly string[]).includes(v);

/** 一覧の難易度の絞り込み（all = すべて） */
export type LevelFilter = "all" | ContentLevel;

export const LEVEL_FILTERS: readonly { v: LevelFilter; label: string }[] = [
  { v: "all", label: "すべて" },
  ...CONTENT_LEVELS.map((v) => ({ v, label: LEVEL_LABEL[v] })),
];

/** URL の ?level= を読む（知らない値は all） */
export function parseLevelFilter(v: string | null | undefined): LevelFilter {
  return isContentLevel(v) ? v : "all";
}

/** 難易度の絞り込みに合うか（all は難易度の無い教材も含めてすべて） */
export function matchesLevel(level: unknown, f: LevelFilter): boolean {
  return f === "all" || level === f;
}

/**
 * 難易度ごとのまとまり（短文 → 中文 → 長文の順。空のまとまりは出さない。まとまりの中は元の順）。
 * 難易度の無い・知らない項目は入れない
 */
export function groupByLevel<T extends { level?: unknown }>(items: readonly T[]): { level: ContentLevel; items: T[] }[] {
  return CONTENT_LEVELS.map((level) => ({ level, items: items.filter((x) => x.level === level) })).filter(
    (g) => g.items.length > 0
  );
}

// ---------------------------------------------------------------------------
// 読み物: 話題・文の数・内容チェック
// ---------------------------------------------------------------------------

/** 話題のチップの並び（ここにある話題を先に、残りは教材の出現順） */
export const TOPIC_ORDER: readonly string[] = ["日常", "食事", "買い物", "家族", "天気", "旅行", "文化", "カポエイラ", "仕事", "健康"];

/** 読み物の話題（無い・文字列でない・空なら null） */
export function passageTopic(p: Passage): string | null {
  const t = (p as { topic?: unknown }).topic;
  return typeof t === "string" && t.trim() !== "" ? t.trim() : null;
}

/** 一覧に出す話題（TOPIC_ORDER の順 → 残りは出現順。重複なし） */
export function topicsOf(ps: readonly Passage[]): string[] {
  const seen = new Set<string>();
  const rest: string[] = [];
  for (const p of ps) {
    const t = passageTopic(p);
    if (t === null || seen.has(t)) continue;
    seen.add(t);
    rest.push(t);
  }
  const known = TOPIC_ORDER.filter((t) => seen.has(t));
  return [...known, ...rest.filter((t) => !TOPIC_ORDER.includes(t))];
}

/** 読み物の一覧の絞り込み（topic が null ならすべての話題） */
export function filterPassages(ps: readonly Passage[], level: LevelFilter, topic: string | null): Passage[] {
  return ps.filter((p) => matchesLevel(p.level, level) && (topic === null || passageTopic(p) === topic));
}

/**
 * 読み物の文の数（文末でまとめた文のうち、本文のあるもの。シャドーイングの行数と同じ）。
 * 一覧で全件に使うので、形の崩れたチャンク（バックアップから来た自作教材など）は飛ばして数える
 */
export function sentenceCount(p: Passage): number {
  const raw: unknown = (p as { chunks?: unknown }).chunks;
  if (!Array.isArray(raw)) return 0;
  const chunks = raw.flatMap((c): Chunk[] =>
    c && typeof c === "object" && typeof (c as Chunk).pt === "string" ? [{ pt: (c as Chunk).pt, ja: "" }] : []
  );
  return groupChunks(chunks).filter((g) => g.pt !== "").length;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/**
 * 画面に出せる設問だけを取り出す（問い・選択肢2つ以上・範囲内の答えの番号がそろったもの。解説は文字列のときだけ）。
 * 同梱の教材は check:content で 3〜4 択・重複なしを確かめている。ここは自作教材や壊れたデータで画面を落とさないため
 */
export function passageQuestions(p: Passage): PassageQuestion[] {
  const raw = (p as { questions?: unknown }).questions;
  if (!Array.isArray(raw)) return [];
  const out: PassageQuestion[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const { q, choices, answer, explain } = x as Record<string, unknown>;
    if (!isText(q) || !Array.isArray(choices) || choices.length < 2 || !choices.every(isText)) continue;
    if (typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer >= choices.length) continue;
    out.push({ q, choices: [...choices], answer, ...(isText(explain) ? { explain } : {}) });
  }
  return out;
}

/** 内容チェックの答え（設問ごとに選んだ番号。まだなら null） */
export type QuizAnswers = readonly (number | null)[];

export const emptyAnswers = (n: number): (number | null)[] => Array.from({ length: n }, () => null);

/**
 * 内容チェックの選択肢を出す順（設問ごとに、元の選択肢の番号の並び）。種（読み物の id と「もう一度」の回数など）と
 * 設問の番号でシャッフルする（同じ種なら同じ並び）。同梱の教材は正解の位置が読み物をまたいで似た並びになりがちなので、
 * 画面ではこの順で A・B・C… を振る。答え（answerQuestion）と正誤は元の番号のまま
 */
export function choiceOrders(qs: readonly PassageQuestion[], seed: string): number[][] {
  return qs.map((q, qi) => seededShuffle(q.choices.map((_, i) => i), `${seed}:${qi}`));
}

/**
 * qi 番目の設問に choice を答えた新しい答え（入力は変えない）。
 * 答えた設問は変えない（1回目の答えで正誤を決める）。範囲外の設問・選択肢は無視して同じ配列を返す
 */
export function answerQuestion(qs: readonly PassageQuestion[], answers: QuizAnswers, qi: number, choice: number): QuizAnswers {
  const q = qs[qi];
  if (!q || answers[qi] != null || !Number.isInteger(choice) || choice < 0 || choice >= q.choices.length) return answers;
  const next = qs.map((_, i) => answers[i] ?? null);
  next[qi] = choice;
  return next;
}

export interface QuizSummary {
  total: number;
  answered: number;
  correct: number;
  /** 全問に答えた（設問が0なら false） */
  done: boolean;
}

export function quizSummary(qs: readonly PassageQuestion[], answers: QuizAnswers): QuizSummary {
  let answered = 0;
  let correct = 0;
  qs.forEach((q, i) => {
    const a = answers[i];
    if (a == null) return;
    answered++;
    if (a === q.answer) correct++;
  });
  return { total: qs.length, answered, correct, done: qs.length > 0 && answered === qs.length };
}

/**
 * 同梱の読み物を読み込むときの整え（content.ts）。話題は前後の空白を除き、設問は画面に出せるものだけにする。
 * 空になった項目は置かない。ほかの項目はそのまま
 */
export function normalizePassage(p: Passage): Passage {
  const { topic: _t, questions: _q, ...rest } = p;
  const topic = passageTopic(p);
  const questions = passageQuestions(p);
  return { ...rest, ...(topic !== null ? { topic } : {}), ...(questions.length ? { questions } : {}) };
}

// ---------------------------------------------------------------------------
// スクリプト: 会話の話者
// ---------------------------------------------------------------------------

/** 行の話者（無い・空なら null。前後の空白は除く） */
export function lineSpeaker(line: { speaker?: unknown }): string | null {
  return isText(line.speaker) ? line.speaker.trim() : null;
}

/**
 * 同梱のスクリプトを読み込むときの整え（content.ts）。難易度・種類は知らない値なら置かない。
 * 話者は前後の空白を除く（空なら置かない）。ほかの項目はそのまま
 */
export function normalizeScript(s: Script): Script {
  const { level: _l, kind: _k, lines, ...rest } = s;
  const kind = s.kind === "dialogue" || s.kind === "monologue" ? s.kind : null;
  return {
    ...rest,
    ...(isContentLevel(s.level) ? { level: s.level } : {}),
    ...(kind ? { kind } : {}),
    lines: (Array.isArray(lines) ? lines : []).map((l) => {
      const { speaker: _s, ...line } = l;
      const sp = lineSpeaker(l);
      return sp !== null ? { ...line, speaker: sp } : line;
    }),
  };
}

/** スクリプトに出てくる話者（出てくる順・重複なし） */
export function scriptSpeakers(s: Script): string[] {
  const out: string[] = [];
  for (const l of s.lines) {
    const sp = lineSpeaker(l);
    if (sp !== null && !out.includes(sp)) out.push(sp);
  }
  return out;
}

/**
 * 会話の2人の話者（出てくる順）。kind が "dialogue" で、全行に話者があり、話者がちょうど2人のときだけ。
 * それ以外は null（行ごとの話者やロールプレイを出さず、ふつうのスクリプトとして扱う）
 */
export function dialogueSpeakers(s: Script): [string, string] | null {
  if (s.kind !== "dialogue" || s.lines.length === 0) return null;
  if (s.lines.some((l) => lineSpeaker(l) === null)) return null;
  const sp = scriptSpeakers(s);
  return sp.length === 2 ? [sp[0], sp[1]] : null;
}

// ---------------------------------------------------------------------------
// 文型の一覧（パターンプラクティスの「見て覚える」）
// ---------------------------------------------------------------------------

/** カテゴリの「分類：名前」の区切り（全角・半角のコロン） */
const GROUP_SEP_RE = /^(.+?)\s*[：:]\s*(.+)$/u;

export interface PatternGroup {
  /** まとまりの名前（カテゴリの「：」より前。「：」の無いカテゴリは null = 基本の文型） */
  name: string | null;
  /** 文型と一覧に出す名前（「：」より後。無ければカテゴリそのもの） */
  entries: { pattern: Pattern; label: string }[];
}

/**
 * 文型の一覧のまとまり。「カポエイラ：誘う」のように「：」のあるカテゴリはその前の名前でまとめ、
 * 「：」の無いカテゴリは基本の文型（name = null）にまとめる。まとまりは出現順（基本の文型が先頭）、
 * まとまりの中は同じカテゴリを隣り合わせにしたうえで出現順
 */
export function patternGroups(ps: readonly Pattern[]): PatternGroup[] {
  const groups = new Map<string | null, { pattern: Pattern; label: string; cat: string }[]>();
  groups.set(null, []);
  for (const p of ps) {
    const m = GROUP_SEP_RE.exec(p.category.trim());
    const name = m ? m[1] : null;
    const label = m ? m[2] : p.category.trim();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push({ pattern: p, label, cat: p.category.trim() });
  }
  const out: PatternGroup[] = [];
  for (const [name, list] of groups) {
    if (list.length === 0) continue;
    // 同じカテゴリを最初に出てきた位置にまとめる（安定）
    const firstAt = new Map<string, number>();
    list.forEach((e, i) => {
      if (!firstAt.has(e.cat)) firstAt.set(e.cat, i);
    });
    const sorted = list
      .map((e, i) => ({ e, i }))
      .sort((a, b) => firstAt.get(a.e.cat)! - firstAt.get(b.e.cat)! || a.i - b.i)
      .map(({ e }) => ({ pattern: e.pattern, label: e.label }));
    out.push({ name, entries: sorted });
  }
  return out;
}

/** 文型の型の見出し（{X}・{V:inf} を「＿＿」にした文） */
export function frameBlank(frame: string): string {
  return frame.replace(/\{[^{}]*\}/g, "＿＿");
}
