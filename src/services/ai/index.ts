// ============================================================================
// AI のサービスを選ぶ（先生のチャット・歌詞の AI 翻訳から使う入口）
//   検証: scripts/check-ai.ts
// - 使うサービス = 設定の aiProvider（既定 gemini）。ただし選んだ方にキーが無く、もう一方にあればそちらを使う。
//   どちらにもキーが無ければ null（AI の機能はボタンを出さない / 設定へ案内する）。
// - SDK はここでは読み込まない（各サービスが、呼ばれたときに dynamic import する）
// ============================================================================

import type { AiProviderId, AiTranslateModel, GeminiModel } from "../../data/types";
import type { SecretKeys } from "../../store/useSecrets";
import { AI_MODEL_INFO, createClaudeProvider, toAiModel, type MessagesClient } from "./claude";
import { GEMINI_MODEL_INFO, createGeminiProvider, toGeminiModel, type GeminiClient } from "./gemini";
import type { AiProvider } from "./types";

export * from "./types";

export const AI_PROVIDERS: readonly AiProviderId[] = ["gemini", "claude"];
export const DEFAULT_AI_PROVIDER: AiProviderId = "gemini";

export const AI_PROVIDER_INFO: Record<AiProviderId, { name: string; hint: string }> = {
  gemini: { name: "Gemini", hint: "無料枠・おすすめ" },
  claude: { name: "Claude", hint: "任意・有料" },
};

/** 保存値をサービスに丸める（無い・知らない値は既定の Gemini） */
export function toAiProviderId(v: unknown): AiProviderId {
  return AI_PROVIDERS.includes(v as AiProviderId) ? (v as AiProviderId) : DEFAULT_AI_PROVIDER;
}

/** サービスを選ぶのに使う設定 */
export type AiSettings = { aiProvider?: unknown; geminiModel?: unknown; aiTranslateModel?: unknown };

const hasKey = (k: string | null | undefined) => typeof k === "string" && k.trim().length > 0;

/**
 * 今使うサービス。設定で選んだ方にキーがあればそれ、無ければキーがある方、どちらにも無ければ null
 */
export function activeProviderId(settings: AiSettings, secrets: SecretKeys): AiProviderId | null {
  const pref = toAiProviderId(settings.aiProvider);
  const has: Record<AiProviderId, boolean> = { gemini: hasKey(secrets.geminiApiKey), claude: hasKey(secrets.anthropicApiKey) };
  if (has[pref]) return pref;
  const other: AiProviderId = pref === "gemini" ? "claude" : "gemini";
  return has[other] ? other : null;
}

/** 検証用の偽のクライアント（省略時は、呼んだときに SDK を読み込んで作る） */
export interface AiClients {
  gemini?: GeminiClient;
  claude?: MessagesClient;
}

/** そのサービスを作る（キーが無くても作れる。呼ぶと no-key の AiError） */
export function createProvider(id: AiProviderId, settings: AiSettings, secrets: SecretKeys, clients: AiClients = {}): AiProvider {
  return id === "gemini"
    ? createGeminiProvider({ apiKey: secrets.geminiApiKey, model: toGeminiModel(settings.geminiModel), client: clients.gemini })
    : createClaudeProvider({ apiKey: secrets.anthropicApiKey, model: toAiModel(settings.aiTranslateModel), client: clients.claude });
}

/** 今使うサービス（activeProviderId）。どちらにもキーが無ければ null */
export function getProvider(settings: AiSettings, secrets: SecretKeys, clients: AiClients = {}): AiProvider | null {
  const id = activeProviderId(settings, secrets);
  return id ? createProvider(id, settings, secrets, clients) : null;
}

/** モデルの表示名（「Gemini 3.8 Flash」「Claude Haiku 4.5」。知らない ID はそのまま） */
export function aiModelLabel(model: string): string {
  if (model in GEMINI_MODEL_INFO) return GEMINI_MODEL_INFO[model as GeminiModel].label;
  if (model in AI_MODEL_INFO) return `Claude ${AI_MODEL_INFO[model as AiTranslateModel].label}`;
  return model;
}
