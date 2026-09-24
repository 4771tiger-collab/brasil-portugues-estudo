// ============================================================================
// 活用ドリル（純関数。ストア・DOM に触らない）
//   検証: scripts/check-grade.ts（npm run check:grade）
// - 出題: 動詞 × 時制 × 人称 の組から、成績（useDrill.stats）で重みを付けて n 問を選ぶ
//   （まだ出していない形・正答率の低い形を多めに。1回のドリルで同じ動詞は2問まで、同じ動詞を続けない）
// - 採点: grade.gradeWord。アクセント違い → 惜しい。入力が同じ動詞の別の形なら不正解で、どの形かを示す
//   （fala と falo のように1文字違いでも、別の人称の形なら惜しいにしない）
// - 最初に正解できなかった問題は、最後にもう一度だけ出す
// SRS のカードには書かない（成績は useDrill だけ）。
// ============================================================================

import type { Conjugator } from "./conjugate";
import { accentHint, gradeWord, normalizeAnswer, type Grade, type GradeResult } from "./grade";
import { fold } from "./lemmatize";
import { conjugationForm, formLabel, type TablePerson, type TableTense } from "./verbTable";

/** 1つの形（"inf|tense|person"）の成績 */
export interface DrillStat {
  /** 出した回数（最初の出題だけ数える。もう一度の出題は数えない） */
  seen: number;
  /** 正解（完全一致）の回数 */
  correct: number;
  /** 最後に答えた日（YYYY-MM-DD） */
  last: string;
}
export type DrillStats = Record<string, DrillStat>;

/** 成績のキー（例: "falar|pres|3"） */
export function drillKey(inf: string, tense: TableTense, person: TablePerson): string {
  return `${inf}|${tense}|${person}`;
}

/** 成績のキーの形（不定詞は小文字の1語。時制・人称は将来増えても読めるように緩く） */
export const DRILL_KEY_RE = /^\p{Ll}{1,30}\|[A-Za-z]{2,12}\|[0-5]$/u;

export function parseDrillKey(key: string): { inf: string; tense: string; person: number } | null {
  if (!DRILL_KEY_RE.test(key)) return null;
  const [inf, tense, p] = key.split("|");
  return { inf, tense, person: Number(p) };
}

/** 出題の候補（答えはまだ作らない） */
export interface DrillCandidate {
  key: string;
  inf: string;
  tense: TableTense;
  person: TablePerson;
}

/** 1問 */
export interface ConjQuestion extends DrillCandidate {
  /** 正解の活用形 */
  answer: string;
}

/** 動詞 × 時制 × 人称 のすべての組 */
export function drillCandidates(
  verbs: readonly string[],
  tenses: readonly TableTense[],
  persons: readonly TablePerson[]
): DrillCandidate[] {
  const out: DrillCandidate[] = [];
  const seen = new Set<string>();
  for (const inf of verbs) {
    if (seen.has(inf)) continue;
    seen.add(inf);
    for (const tense of tenses) {
      for (const person of persons) out.push({ key: drillKey(inf, tense, person), inf, tense, person });
    }
  }
  return out;
}

/** 0 以上 1 未満の乱数（検証では固定の種を使う） */
export type Rand = () => number;

/** 出題の重み: まだ出していない形は 3、出した形は正答率が低いほど重い（全問正解 1 〜 全問不正解 5） */
export function drillWeight(s: DrillStat | undefined): number {
  if (!s || !(s.seen > 0)) return 3;
  const acc = Math.min(1, Math.max(0, s.correct / s.seen));
  return 1 + 4 * (1 - acc);
}

/**
 * 同じ動詞が続かないように並べる。元の順（重みの大きい順）をできるだけ保ち、各位置では
 * 「前と違う動詞で、残りも続かないように並べられる」最初の1問を選ぶ（末尾に同じ動詞が2問残って続く、を防ぐ）。
 * 続くのは、どう並べても続く（1つの動詞が多すぎる）ときだけ（そのときも続く回数は最少にする）。
 */
export function spreadVerbs<T extends { inf: string }>(xs: readonly T[]): T[] {
  const rest = [...xs];
  const left = new Map<string, number>();
  for (const x of rest) left.set(x.inf, (left.get(x.inf) ?? 0) + 1);
  // 残り m 問を、先頭が prev と違い、同じ動詞が続かないように並べられるか
  // （prev は m 個のうち 2 番目以降の位置にしか置けないので floor(m/2) まで、ほかは ceil(m/2) まで）
  const arrangeable = (prev: string, m: number): boolean => {
    for (const [v, c] of left) if (c > (v === prev ? Math.floor(m / 2) : Math.ceil(m / 2))) return false;
    return true;
  };
  const out: T[] = [];
  while (rest.length) {
    const prev = out.length ? out[out.length - 1].inf : null;
    let pick = -1;
    for (let i = 0; i < rest.length && pick < 0; i++) {
      const v = rest[i].inf;
      if (v === prev) continue;
      left.set(v, left.get(v)! - 1);
      if (arrangeable(v, rest.length - 1)) pick = i;
      left.set(v, left.get(v)! + 1);
    }
    // どう選んでも続く（1つの動詞が多すぎる）: 前と違う動詞のうち残りの最も多いもの（続く回数が最少になる）。
    // 前と同じ動詞しか残っていなければ先頭
    if (pick < 0) {
      for (let i = 0; i < rest.length; i++) {
        const v = rest[i].inf;
        if (v !== prev && (pick < 0 || left.get(v)! > left.get(rest[pick].inf)!)) pick = i;
      }
    }
    if (pick < 0) pick = 0;
    const [x] = rest.splice(pick, 1);
    left.set(x.inf, left.get(x.inf)! - 1);
    out.push(x);
  }
  return out;
}

/**
 * 候補から n 問を選ぶ（重み付きの非復元抽出。rand^(1/重み) の大きい順）。
 * 1回で同じ動詞は maxPerVerb 問まで（動詞が少なくて足りないときは上限を外して埋める）。
 */
export function pickDrill<T extends DrillCandidate>(
  cands: readonly T[],
  stats: DrillStats,
  n: number,
  rand: Rand = Math.random,
  maxPerVerb = 2
): T[] {
  const keyed = cands.map((c) => ({ c, k: Math.pow(Math.max(rand(), 1e-12), 1 / drillWeight(stats[c.key])) }));
  keyed.sort((a, b) => b.k - a.k);
  const picked: T[] = [];
  const skipped: T[] = [];
  const perVerb = new Map<string, number>();
  for (const { c } of keyed) {
    if (picked.length >= n) break;
    const used = perVerb.get(c.inf) ?? 0;
    if (used >= maxPerVerb) {
      skipped.push(c);
      continue;
    }
    perVerb.set(c.inf, used + 1);
    picked.push(c);
  }
  for (const c of skipped) {
    if (picked.length >= n) break;
    picked.push(c);
  }
  return spreadVerbs(picked);
}

/** 候補に正解の活用形を付けて問題にする */
export function toQuestions(conj: Conjugator, cands: readonly DrillCandidate[]): ConjQuestion[] {
  return cands.map((c) => ({ ...c, answer: conjugationForm(conj, c.inf, c.tense, c.person) }));
}

// ---------------------------------------------------------------------------
// 採点
// ---------------------------------------------------------------------------

/** 答えの結果: 正解 / 惜しい（アクセント・つづり）/ 不正解 */
export type DrillVerdict = "correct" | "close" | "wrong";
export const DRILL_VERDICTS: readonly DrillVerdict[] = ["correct", "close", "wrong"];

export function verdictOf(g: Grade): DrillVerdict {
  return g === "exact" ? "correct" : g === "wrong" ? "wrong" : "close";
}

/** 入力の先頭の主語（「nós falamos」と打っても活用形だけで採点する） */
const SUBJECT_RE = /^(?:eu|tu|ele|ela|você|voce|a gente|nós|nos|vós|eles|elas|vocês|voces)\s+(?=\S)/;

/** 入力から先頭の主語を外す（主語だけのときは外さない） */
export function stripSubject(input: string): string {
  const u = normalizeAnswer(input);
  return u.replace(SUBJECT_RE, "");
}

export interface ConjGrade {
  result: GradeResult;
  verdict: DrillVerdict;
  /** 入力が同じ動詞の別の形なら、その形の説明（「現在・eu」など）。そうでなければ null */
  otherForm: string | null;
}

/**
 * 活用形の答え合わせ。
 * - 完全一致 → 正解、アクセント記号だけの違い・小さなつづりの誤り → 惜しい、それ以外 → 不正解
 * - 入力が同じ動詞の別の形（別の人称・時制・不定詞）なら、1文字違いでも不正解にし、どの形かを説明する
 *   （pôde と pode のようにアクセントだけが違う別の形も不正解）
 */
export function gradeConjugation(conj: Conjugator, q: Pick<ConjQuestion, "inf" | "answer">, input: string): ConjGrade {
  const forms = conj.conjugate(q.inf);
  const u = stripSubject(input);
  const result = gradeWord(u, q.answer, { isKnownForm: (s) => forms.has(s) });
  const verdict = verdictOf(result.grade);
  const tags = verdict === "correct" || !u ? undefined : forms.get(u);
  if (!tags) return { result, verdict, otherForm: null };
  const otherForm = formLabel(tags);
  const e = normalizeAnswer(q.answer);
  const accent = fold(u) === fold(e) ? `（${accentHint(u, e)}）` : "";
  return { result: { ...result, note: `${u} は ${otherForm} の形です${accent}` }, verdict, otherForm };
}

// ---------------------------------------------------------------------------
// 1回のドリル（出題の列）
// ---------------------------------------------------------------------------

export interface ConjEntry {
  q: ConjQuestion;
  /** 最初に正解できなかった問題の、もう一度の出題 */
  retry: boolean;
  /** 答えの結果（まだなら null） */
  verdict: DrillVerdict | null;
  /** 入力した答え（「わからない」は ""） */
  input: string;
}

export function newConjQueue(qs: readonly ConjQuestion[]): ConjEntry[] {
  return qs.map((q) => ({ q, retry: false, verdict: null, input: "" }));
}

/**
 * pos 番目の問題に結果を付けた新しい列を返す。
 * 最初の出題で正解でなければ（惜しい・不正解）、列の最後にもう一度だけ足す（もう一度の出題では足さない）
 */
export function answerEntry(queue: readonly ConjEntry[], pos: number, verdict: DrillVerdict, input: string): ConjEntry[] {
  const e = queue[pos];
  if (!e || e.verdict) return [...queue];
  const next = queue.map((x, i) => (i === pos ? { ...x, verdict, input } : x));
  if (verdict !== "correct" && !e.retry) next.push({ q: e.q, retry: true, verdict: null, input: "" });
  return next;
}

export type VerdictCounts = Record<DrillVerdict, number>;

export interface ConjSummary {
  /** 最初の出題の結果の数 */
  first: VerdictCounts;
  /** もう一度の出題の結果の数 */
  retry: VerdictCounts;
  /** 最初の出題の数（途中でやめても出題予定の数） */
  planned: number;
  /** 答えた最初の出題の数 */
  answered: number;
}

export function summarizeConj(queue: readonly ConjEntry[]): ConjSummary {
  const zero = (): VerdictCounts => ({ correct: 0, close: 0, wrong: 0 });
  const s: ConjSummary = { first: zero(), retry: zero(), planned: 0, answered: 0 };
  for (const e of queue) {
    if (!e.retry) s.planned++;
    if (!e.verdict) continue;
    if (e.retry) s.retry[e.verdict]++;
    else {
      s.first[e.verdict]++;
      s.answered++;
    }
  }
  return s;
}

/** 成績に1回分を足した新しい成績（最初の出題だけ記録する。正解は完全一致だけ） */
export function recordStat(prev: DrillStat | undefined, correct: boolean, today: string): DrillStat {
  return { seen: (prev?.seen ?? 0) + 1, correct: (prev?.correct ?? 0) + (correct ? 1 : 0), last: today };
}

/** 苦手な形（2回以上出して正答率の低い順。同じなら出した回数の多い順）。最大 n 件 */
export function weakKeys(stats: DrillStats, n: number): { key: string; stat: DrillStat }[] {
  return Object.entries(stats)
    .filter(([, s]) => s.seen >= 2 && s.correct < s.seen)
    .map(([key, stat]) => ({ key, stat, acc: stat.correct / stat.seen }))
    .sort((a, b) => a.acc - b.acc || b.stat.seen - a.stat.seen || (a.key < b.key ? -1 : 1))
    .slice(0, n)
    .map(({ key, stat }) => ({ key, stat }));
}
