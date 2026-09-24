// ============================================================================
// SRS（間隔反復）スケジューラ — SM-2 簡易版
// 4段階評価(again/hard/good/easy)で次回復習日を算出。
// 期限前・同じ日の再評価は「据え置き」（間隔を伸ばさない）。実際に空いた間隔だけを強化とみなす。
// 真理値表は scripts/check-srs.ts（npm run check:srs）。
// ============================================================================

import type { Rating, SrsCard, SrsLevel } from "../data/types";

const EASE_MIN = 1.3;
const EASE_MAX = 3.0;
const EASE_DEFAULT = 2.5;

/** ローカル日付を YYYY-MM-DD で返す */
export function todayStr(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

/** 2つの日付文字列の差（a - b 日数） */
export function diffDays(a: string, b: string): number {
  const da = new Date(a + "T00:00:00").getTime();
  const db = new Date(b + "T00:00:00").getTime();
  return Math.round((da - db) / 86400000);
}

export function newCard(today: string = todayStr()): SrsCard {
  return {
    ease: EASE_DEFAULT,
    intervalDays: 0,
    due: today,
    reps: 0,
    lapses: 0,
    level: "new",
    last: null,
  };
}

function clampEase(e: number): number {
  return Math.max(EASE_MIN, Math.min(EASE_MAX, e));
}

/**
 * 間隔と連続正解数から習熟度レベルを決める。
 *  - reps=0 または間隔7日未満 → learning（学習中）
 *  - 間隔7〜20日 → young（定着中）
 *  - 間隔21日以上 → mature（習得）
 * 1日後・3日後に出るだけの語は、まだ「定着」とは呼ばない。
 */
export function levelFor(intervalDays: number, reps: number): SrsLevel {
  if (reps === 0 || intervalDays < 7) return "learning";
  if (intervalDays < 21) return "young";
  return "mature";
}

/**
 * 表示用のレベル。保存済みの card.level は旧しきい値で書かれた値が残るため、表示には使わず毎回導く。
 * 一度も評価していないカード（曲から追加しただけ）は new（未学習）。
 */
export function displayLevel(card: SrsCard): SrsLevel {
  if (card.last === null) return "new";
  return levelFor(card.intervalDays, card.reps);
}

/** 習熟度の表示名。引くときは LEVEL_JA[displayLevel(card)]（保存済みの card.level は使わない） */
export const LEVEL_JA: Readonly<Record<SrsLevel, string>> = { new: "未学習", learning: "学習中", young: "定着中", mature: "習得" };

/**
 * 歌詞の色分けで「覚えた語」（緑）とみなすか。評価済みで、間隔3日以上。
 * 習熟度の「定着」（7日以上）とは別基準で、歌詞では手応えを早めに見せる。
 */
export function isKnownForLyrics(card: SrsCard | undefined): boolean {
  return !!card?.last && card.intervalDays >= 3;
}

/**
 * 据え置き判定（again 以外で、次のどちらかなら間隔・due・reps を変えない）。
 *  (a) 期限前（一度でも評価済みで due が未来）
 *  (b) 同じ日にすでに合格済み（intervalDays>0）。間隔0の再学習中は先へ進めるため除外する
 * 曲から追加しただけのカード（last=null）は据え置かない。
 */
export function isHeld(card: SrsCard, rating: Rating, today: string = todayStr()): boolean {
  if (rating === "again" || card.last === null) return false;
  return card.due > today || (card.last === today && card.intervalDays > 0);
}

/**
 * 2回目以降（reps≥1）の good の間隔。reps===1 は最低3日、それ以降は間隔×ease（最低1日）。
 * 新規で easy（4日）にした語の次の good が3日に縮まないよう、前回の間隔×ease も下回らない。
 */
function goodInterval(intervalDays: number, reps: number, ease: number): number {
  return Math.max(reps === 1 ? 3 : 1, Math.round(intervalDays * ease));
}

/**
 * 評価を適用して新しいカード状態を返す（入力は変更しない）。
 * - 据え置きのときは入力と同じオブジェクトを返す
 * - 初見・再学習中・今日評価済み（reps===0 || last===today）の again では lapses と ease を変えない
 *   → lapses と ease を下げるのは、合格済みのカードを前日以前の状態から落としたときだけ
 * - 新規カード（reps===0）の hard/easy では ease を変えない。easy は4日後
 * - reps≥1 では hard ≤ good < easy（easy は good より最低1日長い）で、good は今の間隔を下回らない
 */
export function review(card: SrsCard, rating: Rating, today: string = todayStr()): SrsCard {
  if (isHeld(card, rating, today)) return card; // 据え置き
  const learning = card.reps === 0 || card.last === today;
  let { ease, intervalDays, reps, lapses } = card;

  switch (rating) {
    case "again":
      if (!learning) {
        lapses += 1;
        ease = clampEase(ease - 0.2);
      }
      reps = 0;
      intervalDays = 0; // 当日中に再学習
      break;
    case "hard":
      if (reps === 0) intervalDays = 1;
      else {
        ease = clampEase(ease - 0.15);
        intervalDays = Math.max(1, Math.round(intervalDays * 1.2));
      }
      reps += 1;
      break;
    case "good":
      if (reps === 0) intervalDays = 1;
      else intervalDays = goodInterval(intervalDays, reps, ease);
      reps += 1;
      break;
    case "easy":
      if (reps === 0) intervalDays = 4;
      else {
        // good より必ず長く（丸めで good と同じ日数にならないよう +1 を下限にする）
        const goodDays = goodInterval(intervalDays, reps, ease);
        ease = clampEase(ease + 0.15);
        intervalDays = Math.max(goodDays + 1, Math.round(intervalDays * ease * 1.3));
      }
      reps += 1;
      break;
  }

  return {
    ease,
    intervalDays,
    reps,
    lapses,
    level: levelFor(intervalDays, reps),
    due: addDays(today, intervalDays),
    last: today,
  };
}

export function isDue(card: SrsCard | undefined, today: string = todayStr()): boolean {
  if (!card) return false;
  return card.due <= today;
}

/** 復習日までの日数（期限到来なら 0、延滞ならマイナス） */
export function daysUntilDue(card: SrsCard, today: string = todayStr()): number {
  return diffDays(card.due, today);
}

/** 評価ボタンに表示する「次回まで」の目安ラベル（据え置き / このあと / n日 / nヶ月） */
export function previewInterval(card: SrsCard, rating: Rating, today: string = todayStr()): string {
  if (isHeld(card, rating, today)) return "据え置き";
  const next = review(card, rating, today);
  if (next.intervalDays <= 0) return "このあと";
  if (next.intervalDays < 30) return `${next.intervalDays}日`;
  const months = Math.round(next.intervalDays / 30);
  return `${months}ヶ月`;
}

/**
 * クイズの解答を SRS にどう反映するか（4択のまぐれ当たりで定着扱いにしない）。
 *  - "log"  : カード無し・未評価（last=null）→ SRS には書かず、練習量だけ記録
 *  - "none" : 今日すでに評価済み → 変更なし
 *  - "rate" : 期限到来なら評価を反映。期限前は again のときだけ反映
 */
export type QuizDecision = "rate" | "log" | "none";

export function quizDecision(card: SrsCard | undefined, rating: Rating, today: string = todayStr()): QuizDecision {
  if (!card || card.last === null) return "log";
  if (card.last === today) return "none";
  if (card.due <= today) return "rate";
  return rating === "again" ? "rate" : "none";
}
