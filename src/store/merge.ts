// ============================================================================
// 統合インポート（純関数。ストア・DOM・localStorage に触らない）
//   検証: scripts/check-backup.ts（npm run check:backup）
// スマホと PC など、別の端末で学習した記録を1つに合わせる。どちらの端末の記録も消さない。
// - cards: 語ごとに last が新しい方（null は最も古い）。同じなら reps、intervalDays が大きい方、それも同じなら端末側
// - 連続記録: lastStudyDate は新しい方、bestStreak・totalReviews は大きい方。
//   streak は「両方の連続区間」と「学習ログで学習日だった日」をつないで数え直す（mergeStreak）
// - customPassages・pinnedNew・userWords: 和集合（同じ ID は端末側）。pinnedNew は評価済みになった語を外す
// - history: 日ごと・項目ごとに大きい方
// - 曲: offsetMs は端末側、和訳は edited の方（どちらも同じなら端末側）。
//   addedWords は (id, videoId) の和集合で、addedAt は古い方、createdCard は OR
// - daily（今日のカウンタ）と設定は端末側のまま（呼び出し側で扱う）
// 歌詞の本文は扱わない（和訳は行のハッシュをキーにした訳文だけ）。
// ============================================================================

import type { SrsCard } from "../data/types";
import type { ProgressPart } from "./backupFormat";
import type { AddedWord, LineTranslation, MusicExport, SongState } from "./useMusic";
import { addDays, todayStr } from "../srs/scheduler";
import { ACTIVITY_KINDS, isStudyDay, pruneHistory, type DayLog, type History } from "./history";

/** インポートの方法: merge = 統合（推奨）、replace = 置き換え */
export type ImportMode = "merge" | "replace";

// ---------------------------------------------------------------------------
// カード
// ---------------------------------------------------------------------------

/** a の方が新しければ正、b の方が新しければ負、同じなら 0（last → reps → intervalDays の順に比べる） */
export function compareCards(a: SrsCard, b: SrsCard): number {
  const la = a.last ?? "";
  const lb = b.last ?? ""; // null（曲から追加しただけで未評価）は最も古い
  if (la !== lb) return la > lb ? 1 : -1;
  if (a.reps !== b.reps) return a.reps - b.reps;
  if (a.intervalDays !== b.intervalDays) return a.intervalDays - b.intervalDays;
  return 0;
}

/** 語ごとに新しい方のカード（同じなら端末側）。端末側の順に並べ、ファイルにだけある語を後ろに足す */
export function mergeCards(local: Record<string, SrsCard>, remote: Record<string, SrsCard>): Record<string, SrsCard> {
  const out: Record<string, SrsCard> = { ...local };
  for (const [id, r] of Object.entries(remote)) {
    const l = out[id];
    out[id] = l && compareCards(l, r) >= 0 ? l : r;
  }
  return out;
}

const sameSchedule = (a: SrsCard, b: SrsCard) =>
  a.ease === b.ease &&
  a.intervalDays === b.intervalDays &&
  a.due === b.due &&
  a.reps === b.reps &&
  a.lapses === b.lapses &&
  a.last === b.last;

export interface CardDiff {
  /** 取り込みで新しく入った語 */
  added: number;
  /** 取り込みで学習状況が変わった語 */
  updated: number;
  /** 取り込みで無くなった語（置き換えのとき） */
  removed: number;
}

/** 取り込みの前後でカードがどう変わったか（確認の表示用） */
export function cardDiff(before: Record<string, SrsCard>, after: Record<string, SrsCard>): CardDiff {
  let added = 0;
  let updated = 0;
  let removed = 0;
  for (const [id, c] of Object.entries(after)) {
    const b = before[id];
    if (!b) added++;
    else if (!sameSchedule(b, c)) updated++;
  }
  for (const id of Object.keys(before)) if (!after[id]) removed++;
  return { added, updated, removed };
}

// ---------------------------------------------------------------------------
// 学習ログと連続記録
// ---------------------------------------------------------------------------

/** 1日分: 項目ごとに大きい方 */
export function mergeDayLog(a: DayLog, b: DayLog): DayLog {
  const act: DayLog["act"] = {};
  for (const k of ACTIVITY_KINDS) {
    const x = a.act[k];
    const y = b.act[k];
    if (!x && !y) continue;
    act[k] = { n: Math.max(x?.n ?? 0, y?.n ?? 0), sec: Math.max(x?.sec ?? 0, y?.sec ?? 0) };
  }
  return {
    reviews: Math.max(a.reviews, b.reviews),
    newWords: Math.max(a.newWords, b.newWords),
    again: Math.max(a.again, b.again),
    act,
  };
}

/** 日ごと・項目ごとに大きい方（片方にしか無い日はそのまま） */
export function mergeHistory(local: History, remote: History): History {
  const out: History = { ...local };
  for (const [day, r] of Object.entries(remote)) {
    const l = out[day];
    out[day] = l ? mergeDayLog(l, r) : r;
  }
  return out;
}

type StreakPart = Pick<ProgressPart, "streak" | "bestStreak" | "lastStudyDate">;

const laterDate = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a >= b ? a : b);

/** s の連続区間（lastStudyDate までの streak 日）に day が入るか */
function inRun(s: StreakPart, day: string): boolean {
  if (s.lastStudyDate === null || !(s.streak > 0)) return false;
  return day <= s.lastStudyDate && day >= addDays(s.lastStudyDate, -(s.streak - 1));
}

/**
 * 連続記録の統合。lastStudyDate は新しい方、bestStreak は大きい方。
 * streak は、新しい方の lastStudyDate から1日ずつさかのぼり、どちらかの連続区間に入る日か、
 * 統合した学習ログで学習日の日が続くかぎり数える。
 * （片方の古い大きな streak をそのまま使うと、途切れた記録が続いているように見えるため。
 *   例: 端末 A が 9/23 まで 5日、端末 B が 9/24 に 1日 → 6日。A が 9/20 まで 10日、B が 9/24 に 1日 → 1日）
 */
export function mergeStreak(local: StreakPart, remote: StreakPart, history: History): StreakPart {
  const last = laterDate(local.lastStudyDate, remote.lastStudyDate);
  const best = Math.max(local.bestStreak, remote.bestStreak);
  if (last === null) {
    const streak = Math.max(local.streak, remote.streak);
    return { streak, bestStreak: Math.max(best, streak), lastStudyDate: null };
  }
  // 数えられる日は「両方の streak の合計＋学習ログの日数」を超えない（無限ループの防止を兼ねる）
  const limit = Math.max(0, local.streak) + Math.max(0, remote.streak) + Object.keys(history).length + 1;
  let streak = 0;
  let day = last;
  while (streak < limit && (inRun(local, day) || inRun(remote, day) || isStudyDay(history[day]))) {
    streak++;
    day = addDays(day, -1);
  }
  return { streak, bestStreak: Math.max(best, streak), lastStudyDate: last };
}

// ---------------------------------------------------------------------------
// 進捗全体
// ---------------------------------------------------------------------------

/** 和集合（端末側の順・端末側の値を優先し、ファイルにだけあるものを後ろに足す） */
export function unionBy<T>(local: readonly T[], remote: readonly T[], key: (x: T) => string): T[] {
  const seen = new Set(local.map(key));
  const out = [...local];
  for (const r of remote) {
    const k = key(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/** 端末の進捗（local）とファイルの進捗（remote）を統合する */
export function mergeProgress(local: ProgressPart, remote: ProgressPart, today: string = todayStr()): ProgressPart {
  const cards = mergeCards(local.cards, remote.cards);
  const history = pruneHistory(mergeHistory(local.history, remote.history), today);
  return {
    cards,
    ...mergeStreak(local, remote, history),
    totalReviews: Math.max(local.totalReviews, remote.totalReviews),
    customPassages: unionBy(local.customPassages, remote.customPassages, (p) => p.id),
    // 「今日の学習に追加」は未学習の語だけ（もう一方の端末で評価済みになった語は外す）
    pinnedNew: unionBy(local.pinnedNew, remote.pinnedNew, (x) => x).filter((id) => !cards[id]?.last),
    history,
  };
}

// ---------------------------------------------------------------------------
// 曲のデータ
// ---------------------------------------------------------------------------

/** 行ごとの和訳: 端末側が手で直したものはそのまま。そうでなく、ファイル側が手で直したものならファイル側 */
export function mergeTranslations(
  local: Record<string, LineTranslation>,
  remote: Record<string, LineTranslation>
): Record<string, LineTranslation> {
  const out = { ...local };
  for (const [k, r] of Object.entries(remote)) {
    const l = out[k];
    if (!l || (!l.edited && r.edited)) out[k] = r;
  }
  return out;
}

/** 古い方の時刻（ISO）。読めない・空の値は無視し、どちらも読めなければ端末側 */
function olderTime(a: string, b: string): string {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta)) return Number.isNaN(tb) ? a : b;
  if (Number.isNaN(tb)) return a;
  return tb < ta ? b : a;
}

const addedKey = (w: AddedWord) => `${w.id}\u0000${w.videoId}`;

/** 曲から追加した語: (id, videoId) の和集合。同じ記録は addedAt を古い方、createdCard を OR にする */
export function mergeAddedWords(local: readonly AddedWord[], remote: readonly AddedWord[]): AddedWord[] {
  const out = [...local];
  const index = new Map<string, number>();
  out.forEach((w, i) => {
    if (!index.has(addedKey(w))) index.set(addedKey(w), i);
  });
  for (const r of remote) {
    const i = index.get(addedKey(r));
    if (i === undefined) {
      index.set(addedKey(r), out.length);
      out.push(r);
      continue;
    }
    const l = out[i];
    out[i] = { ...l, addedAt: olderTime(l.addedAt, r.addedAt), createdCard: l.createdCard || r.createdCard };
  }
  return out;
}

/** 曲のデータの統合。ファイルに曲のデータが無ければ（v1）端末側のまま */
export function mergeMusic(local: MusicExport, remote: MusicExport | null): MusicExport {
  if (!remote) return local;
  const songs: Record<string, SongState> = { ...local.songs };
  for (const [vid, r] of Object.entries(remote.songs)) {
    const l = songs[vid];
    songs[vid] = l ? { ...l, offsetMs: l.offsetMs, translations: mergeTranslations(l.translations, r.translations) } : r;
  }
  return {
    songs,
    addedWords: mergeAddedWords(local.addedWords, remote.addedWords),
    userWords: unionBy(local.userWords, remote.userWords, (u) => u.id),
  };
}
