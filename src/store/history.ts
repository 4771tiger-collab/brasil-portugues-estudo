// ============================================================================
// 学習ログ（日ごとの記録）の型と純関数。ストア・DOM・localStorage に触らない。
// useProgress（保存）・backupFormat（読み込みの検査）・merge（統合インポート）で共通に使う。
//   検証: scripts/check-srs.ts（ストア）/ scripts/check-backup.ts（読み込み・統合）
// - history のキーは YYYY-MM-DD（端末のローカル日付）。最大 HISTORY_DAYS 日分だけ残す。
// - 歌詞に関する情報は持たない（件数と秒数だけ）。
// ============================================================================

import { addDays } from "../srs/scheduler";

/** 記録する活動の種類（単語帳の評価は DayLog の reviews/newWords/again で数える） */
export const ACTIVITY_KINDS = ["quiz", "dictation", "shadowing", "pattern", "chunk", "drill", "listen", "music"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** 活動1種類の1日分: n = 回数（採点・録音・通し再生・文など）、sec = 秒数 */
export interface ActivityLog {
  n: number;
  sec: number;
}

/** 1日分の記録 */
export interface DayLog {
  /** 単語帳・クイズで SRS に反映した評価の回数（据え置きも含む。totalReviews と同じ数え方） */
  reviews: number;
  /** はじめて評価した語の数（新規語・曲から追加した語） */
  newWords: number;
  /** again の回数 */
  again: number;
  act: Partial<Record<ActivityKind, ActivityLog>>;
}

export type History = Record<string, DayLog>;

/** 残す日数（今日を含めて 400 日） */
export const HISTORY_DAYS = 400;
/** 音楽はこの秒数（3分）以上聴いた日だけ学習日に数える */
export const MUSIC_STUDY_SEC = 180;

export const emptyDay = (): DayLog => ({ reviews: 0, newWords: 0, again: 0, act: {} });

const isKind = (k: string): k is ActivityKind => (ACTIVITY_KINDS as readonly string[]).includes(k);

/** 残す範囲の最初の日（これより古いキーは消す） */
export function historyCutoff(today: string): string {
  return addDays(today, -(HISTORY_DAYS - 1));
}

/** 古い日（今日を含めて HISTORY_DAYS 日より前）を除いた history。消すものが無ければ同じオブジェクト */
export function pruneHistory(h: History, today: string): History {
  const cutoff = historyCutoff(today);
  const keys = Object.keys(h);
  if (!keys.some((k) => k < cutoff)) return h;
  const out: History = {};
  for (const k of keys) if (k >= cutoff) out[k] = h[k];
  return out;
}

/**
 * その日の記録を fn で書き換えた新しい history（入力は変えない）。
 * その日のキーを新しく作るときだけ、古い日を削除する（最大 HISTORY_DAYS 日）。
 */
export function updateDay(h: History | undefined, day: string, fn: (d: DayLog) => DayLog): History {
  const base = h ?? {};
  const cur = base[day];
  if (cur) return { ...base, [day]: fn(cur) };
  return { ...pruneHistory(base, day), [day]: fn(emptyDay()) };
}

/** 活動を1日分の記録に足す（入力は変えない） */
export function addActivity(d: DayLog, kind: ActivityKind, n: number, sec: number): DayLog {
  const prev = d.act[kind];
  return { ...d, act: { ...d.act, [kind]: { n: (prev?.n ?? 0) + n, sec: (prev?.sec ?? 0) + sec } } };
}

/**
 * 学習日に数える日か（統合インポートで連続記録を数え直すときに使う）。
 * 評価した日、音楽以外の練習をした日、音楽を MUSIC_STUDY_SEC 秒以上聴いた日。
 */
export function isStudyDay(d: DayLog | undefined): boolean {
  if (!d) return false;
  if (d.reviews > 0) return true;
  return Object.entries(d.act).some(([k, a]) =>
    !a ? false : k === "music" ? a.sec >= MUSIC_STUDY_SEC : a.n > 0 || a.sec > 0
  );
}

/** その日の練習（音楽以外）と音楽の秒数（ホームの「練習 m分 ・ 🎵 k分」） */
export function activitySeconds(d: DayLog | undefined): { practice: number; music: number } {
  let practice = 0;
  let music = 0;
  for (const [k, a] of Object.entries(d?.act ?? {})) {
    if (!a) continue;
    if (k === "music") music += a.sec;
    else practice += a.sec;
  }
  return { practice, music };
}

// ---------------------------------------------------------------------------
// 読み込みの検査（バックアップ・importJSON）。知っている項目だけで組み直す
// ---------------------------------------------------------------------------
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
/** 0 以上の有限の数（それ以外は 0） */
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 1日分。object でなければ null。数が不正なら 0、知らない活動の種類は落とす */
export function readDayLog(v: unknown): DayLog | null {
  if (!isObj(v)) return null;
  const act: DayLog["act"] = {};
  if (isObj(v.act)) {
    for (const [k, a] of Object.entries(v.act)) {
      if (!isKind(k) || !isObj(a)) continue;
      act[k] = { n: count(a.n), sec: count(a.sec) };
    }
  }
  return { reviews: count(v.reviews), newWords: count(v.newWords), again: count(v.again), act };
}

/** history 全体。キーが日付でないもの・object でない日は落とす。無い・不正なら {} */
export function readHistory(v: unknown): History {
  const out: History = {};
  if (!isObj(v)) return out;
  for (const [day, d] of Object.entries(v)) {
    if (!DATE_RE.test(day)) continue;
    const log = readDayLog(d);
    if (log) out[day] = log;
  }
  return out;
}
