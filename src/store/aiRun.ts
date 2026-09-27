// ============================================================================
// 歌詞の AI 翻訳（Gemini / Claude）の実行状態（保存しない。永続化なし）
// - 曲の画面（SongView）を離れて戻っても残し、通信中にもう1回始めない（リクエストを重ねない）。
// - ctrl は「中止」用。設定で API キーを削除・差し替えたときも abortAiRun() で止める
//   （削除したキーでの通信を続けない）。
// ============================================================================

import { create } from "zustand";
import type { AiProviderId } from "../data/types";
import type { AiCost } from "../services/aiTranslate";

/**
 * AI 翻訳の実行状態（vid = 訳している・訳した曲。label = 答えたモデルの表示名。
 * cost = Claude の今回の料金（Gemini の無料枠は null）。fallbackFrom = 上限のため別のモデルが訳したときの元のモデルの表示名）
 */
export type AiRun =
  | { vid: string; status: "busy"; provider: AiProviderId; label: string; lines: number }
  | {
      vid: string;
      status: "done";
      provider: AiProviderId;
      label: string;
      cost: AiCost | null;
      lines: number;
      kept: number;
      skipped: number;
      fallbackFrom: string | null;
    }
  | { vid: string; status: "cancelled"; provider: AiProviderId }
  | { vid: string; status: "error"; provider: AiProviderId; error: string; cost: AiCost | null };

export const useAiRunStore = create<{ run: AiRun | null; ctrl: AbortController | null }>(() => ({ run: null, ctrl: null }));

/** 通信中の AI 翻訳を止める（無ければ何もしない） */
export function abortAiRun(): void {
  useAiRunStore.getState().ctrl?.abort();
}
