// ============================================================================
// 秘密の情報（この端末にだけ置く）: 歌詞の AI 翻訳（Claude）に使う、利用者自身の Anthropic API キー
// - 設定（useSettings）とは別のキー "bp-secrets-v1" に保存する。
// - バックアップ（exportAll / composeBackup）・インポート（importAll / 統合 merge）・reconcile は
//   このストアを一切読まない・書かない（書き出しに入らず、別の端末へも持ち込まれない）。
//   検証: scripts/check-backup.ts（書き出しにキーもストアも入らない・取り込みでキーが変わらない）
// - キーはログに出さない・URL に入れない（Anthropic の SDK がリクエストのヘッダーで送る）。
//   画面に出すのは末尾4文字（maskApiKey）だけ。
// ============================================================================

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SecretsState {
  /** 利用者自身の Anthropic API キー。無ければ null（AI 翻訳は出さない） */
  anthropicApiKey: string | null;
  /** キーを保存（前後の空白を除く。空なら削除と同じ） */
  setAnthropicApiKey: (key: string | null) => void;
  /** キーを削除 */
  clearAnthropicApiKey: () => void;
}

/** 貼り付けたキーを整える（前後の空白・改行を除く）。空なら null */
export function normalizeApiKey(key: string | null | undefined): string | null {
  const k = typeof key === "string" ? key.replace(/\s+/g, "") : "";
  return k ? k : null;
}

/** Anthropic の API キーらしい形か（sk-ant- で始まる）。違っても保存はできる（画面で注意を出すだけ） */
export function looksLikeAnthropicKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{8,}$/.test(key);
}

/** 画面に出すための伏せ字（末尾4文字だけ: 「…abcd」）。キーが短すぎれば「…」だけ */
export function maskApiKey(key: string | null | undefined): string {
  if (!key) return "";
  return key.length >= 12 ? `…${key.slice(-4)}` : "…";
}

export const useSecrets = create<SecretsState>()(
  persist(
    (set) => ({
      anthropicApiKey: null,
      setAnthropicApiKey: (key) => set({ anthropicApiKey: normalizeApiKey(key) }),
      clearAnthropicApiKey: () => set({ anthropicApiKey: null }),
    }),
    {
      // キー名は変えない（変えると保存したキーが読めなくなる）。設定・進捗とは別のキー
      name: "bp-secrets-v1",
      // 将来版のデータを旧版で開いても消えないよう、何もしない migrate で必ず通す（useSettings と同じ）
      version: 0,
      migrate: (persisted) => persisted as SecretsState,
      // 保存するのはキーだけ（関数は保存しない）
      partialize: (s) => ({ anthropicApiKey: s.anthropicApiKey }),
      // 壊れた値（文字列でない）は読まない
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SecretsState>;
        return { ...current, anthropicApiKey: normalizeApiKey(typeof p.anthropicApiKey === "string" ? p.anthropicApiKey : null) };
      },
    }
  )
);
