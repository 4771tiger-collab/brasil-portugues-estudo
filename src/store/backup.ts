// ============================================================================
// バックアップ（エクスポート/インポート/リセット）
// v2 = v1 と同じ最上位フィールド（旧バージョンのアプリでも読める）＋ music。
// 歌詞キャッシュ(lyricsCache)は含めない（再取得できるため・著作物のため）。
// ============================================================================

import { useMusic, type MusicExport } from "./useMusic";
import { useProgress } from "./useProgress";

export function exportAll(): string {
  const progress = JSON.parse(useProgress.getState().exportJSON()) as Record<string, unknown>;
  const music: MusicExport = useMusic.getState().exportData();
  return JSON.stringify({ ...progress, version: 2, music }, null, 2);
}

/** 追加済みなのにカードが無い語（v1 ファイルの取り込み等）にカードを作り直す */
export function reconcile(): void {
  const { addedWords, markCreated } = useMusic.getState();
  const { cards, addCard } = useProgress.getState();
  for (const id of new Set(addedWords.map((w) => w.id))) {
    if (cards[id]) continue;
    addCard(id);
    markCreated(id); // 外す時にこの未評価カードも消せるように
  }
}

export function importAll(json: string): boolean {
  if (!useProgress.getState().importJSON(json)) return false;
  try {
    const data = JSON.parse(json) as { music?: Partial<MusicExport> };
    if (data.music && typeof data.music === "object") useMusic.getState().importData(data.music);
  } catch {
    return false;
  }
  reconcile();
  return true;
}

/** 学習進捗のリセット。曲から追加した語の一覧も消す（和訳・同期設定は教材なので残す） */
export function resetAllProgress(): void {
  useProgress.getState().resetAll();
  useMusic.getState().clearAddedWords();
}
