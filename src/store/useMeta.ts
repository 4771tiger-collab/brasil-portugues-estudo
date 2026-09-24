// ============================================================================
// アプリの付帯情報（端末内に保存・バックアップ対象外）
// - 前回のバックアップの時刻と、その時点の評価回数（ホームのバックアップの催促に使う）
// - インストール案内を閉じた時刻・インストールした時刻
// - storage.persist() の結果
// ============================================================================

import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface MetaData {
  /** 前回バックアップ（共有・ダウンロード）した時刻（ISO）。まだなら null */
  lastBackupAt: string | null;
  /** 前回バックアップした時点の totalReviews */
  reviewsAtLastBackup: number;
  /** インストール案内を閉じた時刻（ISO） */
  installDismissedAt: string | null;
  /** appinstalled を受け取った時刻（ISO）。ブラウザのタブで手順の案内を出し続けないため */
  installedAt: string | null;
  /** navigator.storage.persist() の結果。まだ要求していなければ null */
  persistResult: boolean | null;
}

interface MetaState extends MetaData {
  markBackup: (totalReviews: number, at?: string) => void;
  dismissInstall: (at?: string) => void;
  markInstalled: (at?: string) => void;
  setPersistResult: (r: boolean) => void;
}

/** 前回のバックアップからこの日数たつと催促する */
export const BACKUP_NUDGE_DAYS = 7;
/** 前回のバックアップからこの回数評価すると催促する */
export const BACKUP_NUDGE_REVIEWS = 200;
/** インストール案内を閉じてから、また出すまでの日数 */
export const INSTALL_SNOOZE_DAYS = 30;

const DAY_MS = 86400000;

export type BackupNudgeReason =
  | { kind: "never" } // まだ一度もバックアップしていない
  | { kind: "days"; days: number } // 前回から BACKUP_NUDGE_DAYS 日以上
  | { kind: "reviews"; reviews: number }; // 前回から BACKUP_NUDGE_REVIEWS 回以上

/** バックアップを促すべきか（理由つき）。促さないなら null（純関数） */
export function backupNudgeReason(
  m: Pick<MetaData, "lastBackupAt" | "reviewsAtLastBackup">,
  totalReviews: number,
  now: number = Date.now()
): BackupNudgeReason | null {
  if (!(totalReviews > 0)) return null; // 守るべき学習データがまだ無い
  const at = m.lastBackupAt ? Date.parse(m.lastBackupAt) : NaN;
  if (Number.isNaN(at)) return { kind: "never" };
  const days = Math.floor((now - at) / DAY_MS);
  if (days >= BACKUP_NUDGE_DAYS) return { kind: "days", days };
  const reviews = totalReviews - m.reviewsAtLastBackup;
  if (reviews >= BACKUP_NUDGE_REVIEWS) return { kind: "reviews", reviews };
  return null;
}

/** インストール案内を閉じてから INSTALL_SNOOZE_DAYS 日たっていないか（純関数） */
export function installSnoozed(dismissedAt: string | null, now: number = Date.now()): boolean {
  const at = dismissedAt ? Date.parse(dismissedAt) : NaN;
  return !Number.isNaN(at) && now - at < INSTALL_SNOOZE_DAYS * DAY_MS;
}

export const useMeta = create<MetaState>()(
  persist(
    (set) => ({
      lastBackupAt: null,
      reviewsAtLastBackup: 0,
      installDismissedAt: null,
      installedAt: null,
      persistResult: null,

      markBackup: (totalReviews, at = new Date().toISOString()) =>
        set({ lastBackupAt: at, reviewsAtLastBackup: totalReviews }),
      dismissInstall: (at = new Date().toISOString()) => set({ installDismissedAt: at }),
      markInstalled: (at = new Date().toISOString()) => set({ installedAt: at }),
      setPersistResult: (persistResult) => set({ persistResult }),
    }),
    {
      // キー名は変えない
      name: "bp-meta-v1",
      // 保存済みの version と違い migrate も無いと、zustand は初期状態で起動して上書き保存してしまう。
      // 将来版のデータを旧版で開いても消えないよう、何もしない migrate で必ず通す。
      version: 0,
      migrate: (persisted) => persisted as MetaState,
    }
  )
);
