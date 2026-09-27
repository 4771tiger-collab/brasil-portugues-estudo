// ============================================================================
// 歌詞の AI 翻訳（Claude）の実行状態（保存しない。永続化なし）
// - 曲の画面（SongView）を離れて戻っても残し、通信中にもう1回始めない（有料のリクエストを重ねない）。
// - ctrl は「中止」用。設定で API キーを削除・差し替えたときも abortAiRun() で止める
//   （削除したキーでの通信を続けない）。
// ============================================================================

import { create } from "zustand";
import type { AiCost } from "../services/aiTranslate";

/** AI 翻訳の実行状態（vid = 訳している・訳した曲。label = モデルの表示名） */
export type AiRun =
  | { vid: string; status: "busy"; label: string; lines: number }
  | { vid: string; status: "done"; label: string; cost: AiCost; lines: number; kept: number; skipped: number }
  | { vid: string; status: "cancelled" }
  | { vid: string; status: "error"; error: string; cost: AiCost | null };

export const useAiRunStore = create<{ run: AiRun | null; ctrl: AbortController | null }>(() => ({ run: null, ctrl: null }));

/** 通信中の AI 翻訳を止める（無ければ何もしない） */
export function abortAiRun(): void {
  useAiRunStore.getState().ctrl?.abort();
}
