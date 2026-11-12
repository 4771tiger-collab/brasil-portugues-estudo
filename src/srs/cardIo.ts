// ============================================================================
// 保存データ・バックアップから読んだ SRS のカードの検査（純関数）。
// 単語のカード（backupFormat.ts）と、文のカード（口慣らし。speak/speakData.ts）で共通に使う。
// ============================================================================

import type { SrsCard, SrsLevel } from "../data/types";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v);
const LEVELS: readonly SrsLevel[] = ["new", "learning", "young", "mature"];

/**
 * 1枚分のカード。スケジュールに使う項目の型を確かめる（壊れていれば null）。
 * 知らない項目（将来版が足したもの）はそのまま残す。level は表示に使わない（displayLevel で導く）ので、
 * 壊れていても "new" で補う。
 */
export function readCard(v: unknown): SrsCard | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (![c.ease, c.intervalDays, c.reps, c.lapses].every(isNum)) return null;
  if (!isDate(c.due)) return null;
  const last = c.last ?? null;
  if (last !== null && !isDate(last)) return null;
  const level = LEVELS.includes(c.level as SrsLevel) ? (c.level as SrsLevel) : "new";
  return { ...c, level, last } as SrsCard;
}
