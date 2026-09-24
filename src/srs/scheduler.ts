// ============================================================================
// SRS（間隔反復）スケジューラ — SM-2 簡易版
// 4段階評価(again/hard/good/easy)で次回復習日を算出。
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

export function newCard(): SrsCard {
  return {
    ease: EASE_DEFAULT,
    intervalDays: 0,
    due: todayStr(),
    reps: 0,
    lapses: 0,
    level: "new",
    last: null,
  };
}

function clampEase(e: number): number {
  return Math.max(EASE_MIN, Math.min(EASE_MAX, e));
}

function levelFor(intervalDays: number, reps: number): SrsLevel {
  if (reps === 0) return "learning";
  if (intervalDays < 1) return "learning";
  if (intervalDays < 21) return "young";
  return "mature";
}

/** 評価を適用して新しいカード状態を返す */
export function review(card: SrsCard, rating: Rating, today: string = todayStr()): SrsCard {
  let { ease, intervalDays, reps, lapses } = card;

  switch (rating) {
    case "again":
      lapses += 1;
      reps = 0;
      ease = clampEase(ease - 0.2);
      intervalDays = 0; // 当日中に再学習
      break;
    case "hard":
      ease = clampEase(ease - 0.15);
      intervalDays = reps === 0 ? 1 : Math.max(1, Math.round(intervalDays * 1.2));
      reps += 1;
      break;
    case "good":
      if (reps === 0) intervalDays = 1;
      else if (reps === 1) intervalDays = 3;
      else intervalDays = Math.max(1, Math.round(intervalDays * ease));
      reps += 1;
      break;
    case "easy":
      ease = clampEase(ease + 0.15);
      if (reps === 0) intervalDays = 2;
      else intervalDays = Math.max(1, Math.round(intervalDays * ease * 1.3));
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

/** 評価ボタンに表示する「次回まで」の目安ラベル */
export function previewInterval(card: SrsCard, rating: Rating): string {
  const next = review(card, rating);
  if (next.intervalDays <= 0) return "今日";
  if (next.intervalDays === 1) return "1日";
  if (next.intervalDays < 30) return `${next.intervalDays}日`;
  const months = Math.round(next.intervalDays / 30);
  return `${months}ヶ月`;
}
