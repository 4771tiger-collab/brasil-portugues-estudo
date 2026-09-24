// ============================================================================
// 活用表（純関数。ストア・DOM に触らない）
//   検証: scripts/check-lemmatize.ts（npm run check:lemma）
// - verbHead: 単語が活用表を出せる動詞か（品詞が「動詞」で始まり、見出しが1語の不定詞 -ar/-er/-ir/-or/-ôr）
// - buildConjugationTable: 主な4時制 × 4人称と、現在分詞・過去分詞
// 人称はブラジルの話し言葉に合わせ、tu・vós を省いた4つ（você・a gente は3単、vocês は3複の形）。
// 活用は規則からの自動生成（不規則動詞は data/verb-irregular.json の上書き）。画面では「自動生成」と明記する。
// ============================================================================

import { alternatives } from "./lemmatize";
import { TENSE_JA, type Conjugator, type FormKind, type IrregularTable, type VerbTag } from "./conjugate";

/** 活用表・活用ドリルで扱う時制 */
export type TableTense = "pres" | "pret" | "impf" | "fut";
export const TABLE_TENSES: readonly TableTense[] = ["pres", "pret", "impf", "fut"];

/** 活用表・活用ドリルで扱う人称（0 = 1単、2 = 3単、3 = 1複、5 = 3複） */
export type TablePerson = 0 | 2 | 3 | 5;
export const TABLE_PERSONS: readonly TablePerson[] = [0, 2, 3, 5];

/** 活用表の人称の見出し */
export const PERSON_LABEL: Record<TablePerson, string> = {
  0: "eu",
  2: "você・ele・a gente",
  3: "nós",
  5: "vocês・eles",
};
/** 出題に出す主語（短い形） */
export const PERSON_PROMPT: Record<TablePerson, string> = { 0: "eu", 2: "ele・você", 3: "nós", 5: "eles・vocês" };
/** 読み上げで活用形の前に置く主語（「nós falamos」のように読む） */
export const PERSON_PRONOUN: Record<TablePerson, string> = { 0: "eu", 2: "ele", 3: "nós", 5: "eles" };
/** 再帰動詞の代名詞（eu me lembro / ele se lembra / nós nos lembramos / eles se lembram） */
export const REFLEXIVE_PRONOUN: Record<TablePerson, string> = { 0: "me", 2: "se", 3: "nos", 5: "se" };

/** 時制の短い名前（出題・表の見出し） */
export const TENSE_SHORT: Record<TableTense, string> = {
  pres: "現在",
  pret: "完了過去",
  impf: "不完了過去",
  fut: "未来",
};
/** 時制のポルトガル語名 */
export const TENSE_PT: Record<TableTense, string> = {
  pres: "presente",
  pret: "pretérito perfeito",
  impf: "pretérito imperfeito",
  fut: "futuro do presente",
};
/** 時制の使いどころ（ひとこと） */
export const TENSE_HINT: Record<TableTense, string> = {
  pres: "今のこと・習慣",
  pret: "終わったこと（〜した）",
  impf: "過去の習慣・状態（〜していた）",
  fut: "これからのこと（話し言葉では ir＋不定詞 が普通）",
};

export const isTableTense = (t: string): t is TableTense => (TABLE_TENSES as readonly string[]).includes(t);
export const isTablePerson = (p: number): p is TablePerson => (TABLE_PERSONS as readonly number[]).includes(p);

// ---------------------------------------------------------------------------
// 活用表を出せる動詞か
// ---------------------------------------------------------------------------

export interface VerbHead {
  /** 不定詞（再帰の -se を外したもの） */
  inf: string;
  /** 再帰動詞（見出しに -se が付いていた） */
  reflexive: boolean;
}

/** 1語の不定詞（ir・ser も含む。-or/-ôr は pôr とその派生） */
const INF_RE = /^\p{Ll}*(?:ar|er|ir|or|ôr)$/u;

/**
 * 単語が活用表を出せる動詞なら、その不定詞を返す（出せなければ null）。
 * - 品詞が「動詞」で始まる（「動詞（現在分詞）」の pulando などは不定詞でないので外れる）
 * - 見出しの表記ゆれ（"a/b"）を展開して1つだけになり、1語で -ar/-er/-ir/-or/-ôr で終わる
 * - 再帰の -se（chamar-se、lembrar(-se)）は外し、reflexive で知らせる
 * - -or/-ôr は不規則動詞の表にある語だけ（compor など pôr の派生。表に無いと正しく作れない）
 */
export function verbHead(pt: string, pos: string, table: IrregularTable): VerbHead | null {
  if (!pos.startsWith("動詞")) return null;
  const alts = alternatives(pt);
  if (alts.length !== 1) return null;
  const reflexive = /-se(?!\p{L})/u.test(pt);
  const inf = alts[0].toLowerCase().replace(/-se$/, "");
  if (!INF_RE.test(inf)) return null;
  if (/[oô]r$/.test(inf) && !table[inf]) return null;
  return { inf, reflexive };
}

// ---------------------------------------------------------------------------
// 表のデータ
// ---------------------------------------------------------------------------

export interface ConjugationRow {
  tense: TableTense;
  /** TABLE_PERSONS の順（eu / você・ele / nós / vocês・eles） */
  forms: string[];
}

export interface ConjugationTableData {
  inf: string;
  rows: ConjugationRow[];
  /** 現在分詞（gerúndio） */
  ger: string;
  /** 過去分詞（particípio。規則形と不規則形が併存する動詞は2つ: pagado / pago） */
  pp: string[];
  /** 不規則動詞の表にある */
  irregular: boolean;
  /** 派生元の動詞（manter → ter）。無ければ null */
  like: string | null;
}

export function buildConjugationTable(conj: Conjugator, table: IrregularTable, inf: string): ConjugationTableData {
  const p = conj.paradigm(inf);
  return {
    inf,
    rows: TABLE_TENSES.map((tense) => ({ tense, forms: TABLE_PERSONS.map((i) => p[tense][i]) })),
    ger: p.ger,
    pp: [...p.pp],
    irregular: !!table[inf],
    like: table[inf]?.like ?? null,
  };
}

/** 1つの活用形（inf の tense・person） */
export function conjugationForm(conj: Conjugator, inf: string, tense: TableTense, person: TablePerson): string {
  return conj.paradigm(inf)[tense][person];
}

/** 読み上げ・表示用の「主語＋活用形」（再帰動詞は代名詞も入れる: eu me lembro） */
export function withSubject(form: string, person: TablePerson, reflexive = false): string {
  return reflexive
    ? `${PERSON_PRONOUN[person]} ${REFLEXIVE_PRONOUN[person]} ${form}`
    : `${PERSON_PRONOUN[person]} ${form}`;
}

// ---------------------------------------------------------------------------
// 活用形の説明（活用ドリルで「入力したのはどの形か」を示す）
// ---------------------------------------------------------------------------

function personNo(p: number): string {
  return p < 3 ? `${p + 1}人称単数` : `${p - 2}人称複数`;
}

/** 1つのタグの名前（表の時制・人称なら「完了過去・nós」、それ以外は「接続法現在・1人称単数」など） */
function tagLabel(tag: VerbTag): { label: string; main: boolean } {
  if (isTableTense(tag.t) && tag.p != null && isTablePerson(tag.p)) {
    return { label: `${TENSE_SHORT[tag.t]}・${PERSON_PROMPT[tag.p]}`, main: true };
  }
  const t: FormKind = tag.t;
  if (t === "pp" || t === "ger" || t === "inf" || tag.p == null) return { label: TENSE_JA[t], main: false };
  return { label: `${TENSE_JA[t]}・${personNo(tag.p)}`, main: false };
}

/**
 * 活用形のタグ → 短い説明（最大2つ）。表の時制・人称の形なら、それだけを示す（ほかの時制は出さない）。
 * 例: falamos → 「現在・nós ／ 完了過去・nós」、fala → 「現在・ele・você」、falar → 「不定詞 ／ 接続法未来・1人称単数」
 */
export function formLabel(tags: readonly VerbTag[]): string {
  const main: string[] = [];
  const other: string[] = [];
  for (const tag of tags) {
    const { label, main: isMain } = tagLabel(tag);
    const list = isMain ? main : other;
    if (!list.includes(label)) list.push(label);
  }
  return (main.length ? main : other).slice(0, 2).join(" ／ ");
}
