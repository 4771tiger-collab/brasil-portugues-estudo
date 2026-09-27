import { useMemo } from "react";
import { useSettings } from "../store/useSettings";
import { useSecrets } from "../store/useSecrets";
import { activeProviderId, createProvider, type AiProvider } from "../services/ai";
import type { AiProviderId } from "../data/types";

/**
 * 今使う AI のサービス（設定の aiProvider。選んだ方にキーが無ければ、キーがある方）。
 * どちらにもキーが無ければ id・provider とも null。キー・モデル・選択が変わったら作り直す
 * （SDK は呼んだときに読み込むので、作るだけなら軽い）。key は結果を保存する前の「キーが替わっていないか」の確認に使う
 */
export function useAiProvider(): { id: AiProviderId | null; provider: AiProvider | null; key: string | null } {
  const aiProvider = useSettings((s) => s.aiProvider);
  const geminiModel = useSettings((s) => s.geminiModel);
  const aiTranslateModel = useSettings((s) => s.aiTranslateModel);
  const geminiApiKey = useSecrets((s) => s.geminiApiKey);
  const anthropicApiKey = useSecrets((s) => s.anthropicApiKey);
  return useMemo(() => {
    const settings = { aiProvider, geminiModel, aiTranslateModel };
    const secrets = { geminiApiKey, anthropicApiKey };
    const id = activeProviderId(settings, secrets);
    if (!id) return { id: null, provider: null, key: null };
    return { id, provider: createProvider(id, settings, secrets), key: id === "gemini" ? geminiApiKey : anthropicApiKey };
  }, [aiProvider, geminiModel, aiTranslateModel, geminiApiKey, anthropicApiKey]);
}
