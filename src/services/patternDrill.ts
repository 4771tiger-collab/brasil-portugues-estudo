// ============================================================================
// パターンプラクティスの文と発話ドリル（純関数。ブラウザ・Node の両方から使う）
// - 文型（Pattern）の先頭のスロットに選択肢を入れて、ポルトガル語と和文の1文を作る。
//   和文は選択肢の jaFull（自然な全文）があればそれ、無ければ型（pattern.ja）に差し込む
// - interleave: 同じ文型が続かないように混ぜて n 文を選ぶ（発話ドリル・オート）
// - rateEntry: 自己評価を付ける。「言えなかった」文は最後にもう一度（1回だけ）出す
// 検証: scripts/check-content.ts
// ============================================================================

import type { Pattern, PatternSlotOption } from "../data/types";

/** スロット "{X}"・"{V:inf}" */
const SLOT_RE = /\{[^}]+\}/g;
const SLOT_PART_RE = /(\{[^}]+\})/;
const IS_SLOT_RE = /^\{[^}]+\}$/;

/** 型の {…} をすべて value で埋める（スロットは1つだけの前提。check:content で検査） */
export function fillSlot(template: string, value: string): string {
  return template.replace(SLOT_RE, value);
}

/** 文型の先頭のスロットの選択肢（PatternPractice はスロット1つだけに対応） */
export function slotOptions(p: Pattern): PatternSlotOption[] {
  const key = Object.keys(p.slots)[0];
  return key === undefined ? [] : p.slots[key] ?? [];
}

/** 選択肢を入れた文の和文（jaFull があればそれ、無ければ型に差し込む） */
export function optionJa(p: Pattern, o: PatternSlotOption): string {
  return o.jaFull ?? fillSlot(p.ja, o.ja);
}

/** 文の一部（slot = 入れ替え部分。強調表示に使う） */
export interface FramePart {
  text: string;
  slot: boolean;
}

/** frame に value を入れた文を、固定部分と入れ替え部分に分ける */
export function frameParts(frame: string, value: string): FramePart[] {
  return frame
    .split(SLOT_PART_RE)
    .filter((s) => s !== "")
    .map((s) => (IS_SLOT_RE.test(s) ? { text: value, slot: true } : { text: s, slot: false }));
}

/** 練習する1文 */
export interface PatternItem {
  /** "pat:<文型の id>:<選択肢の番号>"（patterns.json は並びを変えない運用なので安定） */
  id: string;
  pattern: Pattern;
  /** 選択肢の番号 */
  optIdx: number;
  option: PatternSlotOption;
  /** ポルトガル語の文 */
  pt: string;
  /** 和文（問題） */
  ja: string;
}

/** すべての文型・選択肢の文（データの順） */
export function patternItems(patterns: readonly Pattern[]): PatternItem[] {
  return patterns.flatMap((p) =>
    slotOptions(p).map((o, i) => ({
      id: `pat:${p.id}:${i}`,
      pattern: p,
      optIdx: i,
      option: o,
      pt: fillSlot(p.frame, o.pt),
      ja: optionJa(p, o),
    }))
  );
}

/** 0 以上 1 未満の乱数（検証では固定の種を使う） */
export type Rand = () => number;

/** シャッフルした新しい配列（Fisher–Yates） */
export function shuffle<T>(xs: readonly T[], rand: Rand = Math.random): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 文型を混ぜて n 文を選ぶ（インターリーブ）。文型をランダムな順に1文ずつ回し、1周したら順番を変えて次の周へ。
 * 同じ文型が続くのは、残りが1つの文型だけになったときだけ。同じ文は2回選ばない（n は文の数まで）。
 * avoidFirst: 最初の文にしない文型の id（前の周の最後の文型。オートで周をつなぐとき）
 */
export function interleave(items: readonly PatternItem[], n: number, rand: Rand = Math.random, avoidFirst?: string): PatternItem[] {
  const groups = new Map<string, PatternItem[]>();
  for (const it of shuffle(items, rand)) {
    const g = groups.get(it.pattern.id);
    if (g) g.push(it);
    else groups.set(it.pattern.id, [it]);
  }
  const limit = Math.max(0, Math.min(Math.floor(n), items.length));
  const out: PatternItem[] = [];
  let prev = avoidFirst ?? null;
  while (out.length < limit) {
    const round = shuffle(
      [...groups.keys()].filter((k) => (groups.get(k)?.length ?? 0) > 0),
      rand
    );
    if (round.length === 0) break;
    // 前の周の最後と同じ文型から始めない
    if (round.length > 1 && round[0] === prev) [round[0], round[1]] = [round[1], round[0]];
    for (const k of round) {
      if (out.length >= limit) break;
      const it = groups.get(k)?.shift();
      if (!it) continue;
      out.push(it);
      prev = k;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 発話ドリル（和文を見て言う → 答え → 自己評価）
// ---------------------------------------------------------------------------

/** 自己評価: 言えた / 惜しい / 言えなかった */
export type SelfRating = "said" | "close" | "missed";
export const SELF_RATINGS: readonly SelfRating[] = ["said", "close", "missed"];

/** ドリルの1問 */
export interface DrillEntry {
  item: PatternItem;
  /** 「言えなかった」文の再出題 */
  retry: boolean;
  /** 自己評価（まだなら null） */
  rating: SelfRating | null;
}

/** 文型を混ぜた n 問のドリル */
export function newDrill(items: readonly PatternItem[], n: number, rand: Rand = Math.random): DrillEntry[] {
  return interleave(items, n, rand).map((item) => ({ item, retry: false, rating: null }));
}

/**
 * pos 番目の問題に自己評価を付けた新しい列を返す。
 * 最初に出た問題で「言えなかった」なら、列の最後にもう一度だけ足す（再出題でまた言えなくても足さない）
 */
export function rateEntry(queue: readonly DrillEntry[], pos: number, rating: SelfRating): DrillEntry[] {
  const e = queue[pos];
  if (!e) return [...queue];
  const next = queue.map((x, i) => (i === pos ? { ...x, rating } : x));
  if (rating === "missed" && !e.retry) next.push({ item: e.item, retry: true, rating: null });
  return next;
}

export type RatingCounts = Record<SelfRating, number>;

export interface DrillSummary {
  /** 最初に出た問題の自己評価の数 */
  first: RatingCounts;
  /** 再出題の自己評価の数 */
  retry: RatingCounts;
  /** 最初に出た問題の数（途中でやめても出題予定の数） */
  planned: number;
  /** 自己評価した最初の問題の数 */
  answered: number;
}

export function summarizeDrill(queue: readonly DrillEntry[]): DrillSummary {
  const zero = (): RatingCounts => ({ said: 0, close: 0, missed: 0 });
  const s: DrillSummary = { first: zero(), retry: zero(), planned: 0, answered: 0 };
  for (const e of queue) {
    if (!e.retry) s.planned++;
    if (!e.rating) continue;
    if (e.retry) s.retry[e.rating]++;
    else {
      s.first[e.rating]++;
      s.answered++;
    }
  }
  return s;
}
