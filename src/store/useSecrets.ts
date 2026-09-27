// ============================================================================
// 秘密の情報（この端末にだけ置く）: AI（先生・歌詞の AI 翻訳）に使う、利用者自身の API キー
//   - geminiApiKey: Google AI Studio の Gemini API キー（既定のサービス。無料枠）
//   - anthropicApiKey: Anthropic の Claude API キー（任意・有料）
// - 設定（useSettings）とは別のキー "bp-secrets-v1" に保存する。
// - バックアップ（exportAll / composeBackup）・インポート（importAll / 統合 merge）・reconcile は
//   このストアを一切読まない・書かない（書き出しに入らず、別の端末へも持ち込まれない）。
//   検証: scripts/check-backup.ts（書き出しにキーもストアも入らない・取り込みでキーが変わらない）・scripts/check-ai.ts
// - キーはログに出さない・URL に入れない（どちらの SDK もリクエストのヘッダーで送る。Gemini は x-goog-api-key）。
//   画面に出すのは末尾4文字（maskApiKey）だけ。
// - 同じ端末でアプリを2つ開いていても、別の窓がキーを書き換えたら読み直す（syncSecretsFromStorage。
//   削除したキーを、もう一方の窓が書き戻さないように）。
// ============================================================================

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AiProviderId } from "../data/types";
import { abortTeacherRun } from "../services/ai/teacherContext";
import { abortAiRun } from "./aiRun";

interface SecretsState {
  /** 利用者自身の Gemini API キー（Google AI Studio）。無ければ null */
  geminiApiKey: string | null;
  /** 利用者自身の Anthropic API キー。無ければ null */
  anthropicApiKey: string | null;
  /** Gemini のキーを保存（前後の空白を除く。空なら削除と同じ） */
  setGeminiApiKey: (key: string | null) => void;
  /** Gemini のキーを削除 */
  clearGeminiApiKey: () => void;
  /** Anthropic のキーを保存（前後の空白を除く。空なら削除と同じ） */
  setAnthropicApiKey: (key: string | null) => void;
  /** Anthropic のキーを削除 */
  clearAnthropicApiKey: () => void;
}

/** 保存するキーだけ（関数を除いたもの） */
export type SecretKeys = Pick<SecretsState, "geminiApiKey" | "anthropicApiKey">;

/** 貼り付けたキーを整える（前後の空白・改行を除く）。空なら null */
export function normalizeApiKey(key: string | null | undefined): string | null {
  const k = typeof key === "string" ? key.replace(/\s+/g, "") : "";
  return k ? k : null;
}

/** Anthropic の API キーらしい形か（sk-ant- で始まる）。違っても保存はできる（画面で注意を出すだけ） */
export function looksLikeAnthropicKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{8,}$/.test(key);
}

/** Gemini（Google AI Studio）の API キーらしい形か（AIza で始まる）。違っても保存はできる（画面で注意を出すだけ） */
export function looksLikeGeminiKey(key: string): boolean {
  return /^AIza[A-Za-z0-9_-]{30,}$/.test(key);
}

/** 画面に出すための伏せ字（末尾4文字だけ: 「…abcd」）。キーが短すぎれば「…」だけ */
export function maskApiKey(key: string | null | undefined): string {
  if (!key) return "";
  return key.length >= 12 ? `…${key.slice(-4)}` : "…";
}

/** そのサービスのキー（無ければ null） */
export function keyFor(id: AiProviderId, keys: SecretKeys): string | null {
  return id === "gemini" ? keys.geminiApiKey : keys.anthropicApiKey;
}

export const useSecrets = create<SecretsState>()(
  persist(
    (set) => ({
      geminiApiKey: null,
      anthropicApiKey: null,
      setGeminiApiKey: (key) => set({ geminiApiKey: normalizeApiKey(key) }),
      clearGeminiApiKey: () => set({ geminiApiKey: null }),
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
      partialize: (s): SecretKeys => ({ geminiApiKey: s.geminiApiKey, anthropicApiKey: s.anthropicApiKey }),
      // 壊れた値（文字列でない）は読まない。geminiApiKey が無い古い保存データは null のまま
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SecretKeys>;
        const str = (v: unknown) => normalizeApiKey(typeof v === "string" ? v : null);
        return { ...current, geminiApiKey: str(p.geminiApiKey), anthropicApiKey: str(p.anthropicApiKey) };
      },
    }
  )
);

/**
 * 別の窓（インストールしたアプリとブラウザのタブなど）がキーを書き換えたら、保存データを読み直す
 * （key null = localStorage をまるごと消した）。読み直さないと、別の窓で削除したキーを、この窓で
 * もう一方のキーを保存したときに書き戻してしまい、削除したキーで通信も続けてしまう。
 * キーが変わったら、通信中の AI 翻訳・AI 先生の返事も止める（設定でキーを削除・差し替えたときと同じ）。
 * 検証: scripts/check-ai.ts
 */
export async function syncSecretsFromStorage(key: string | null): Promise<void> {
  if (key !== null && key !== "bp-secrets-v1") return;
  const before = useSecrets.getState();
  await useSecrets.persist.rehydrate();
  const after = useSecrets.getState();
  if (after.geminiApiKey !== before.geminiApiKey || after.anthropicApiKey !== before.anthropicApiKey) {
    abortAiRun();
    abortTeacherRun();
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => void syncSecretsFromStorage(e.key));
}
