// ============================================================================
// 歌詞の端末内キャッシュ（localStorage 別キー）。
// LRCLIB から取得した生の文字列だけを保存する。バックアップ(エクスポート)の対象外。
// ============================================================================

import type { LrclibRecord } from "../services/lyrics";

const KEY = "bp-lyrics-cache-v1";

export type CachedLyrics = Pick<LrclibRecord, "id" | "syncedLyrics" | "plainLyrics" | "instrumental"> & {
  fetchedAt: string;
};

function readAll(): Record<string, CachedLyrics> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, CachedLyrics>) : {};
  } catch {
    return {};
  }
}

export function getCachedLyrics(videoId: string): CachedLyrics | undefined {
  return readAll()[videoId];
}

export function setCachedLyrics(videoId: string, rec: LrclibRecord): void {
  try {
    const all = readAll();
    all[videoId] = {
      id: rec.id,
      syncedLyrics: rec.syncedLyrics,
      plainLyrics: rec.plainLyrics,
      instrumental: rec.instrumental,
      fetchedAt: new Date().toISOString(),
    };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 容量超過・プライベートモード等は黙って諦める（次回また取得する）
  }
}

export function clearLyricsCache(videoId?: string): void {
  try {
    if (!videoId) localStorage.removeItem(KEY);
    else {
      const all = readAll();
      delete all[videoId];
      localStorage.setItem(KEY, JSON.stringify(all));
    }
  } catch {
    /* noop */
  }
}
