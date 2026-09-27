// ============================================================================
// AI のサービス: Gemini（Google AI Studio の API キー。無料枠で使う。既定のサービス）
//   検証: scripts/check-ai.ts（偽のクライアント・偽の fetch で動かし、実際には通信しない）
// - 公式の SDK（@google/genai）を、呼ぶときにだけ読み込む（dynamic import。最初の画面のバンドルに入れない）。
//   使うのは ai.models.generateContentStream（会話）と ai.models.generateContent（JSON・接続テスト）。
//   システムプロンプトは config.systemInstruction、会話は contents（role "user" / "model"）、
//   JSON は config.responseMimeType "application/json" ＋ config.responseJsonSchema、中止は config.abortSignal。
//   キーは SDK がヘッダー（x-goog-api-key）で送る（URL に入れない）。
// - SDK の自動の再試行はしない（httpOptions.retryOptions.attempts = 1。回数の上限のある無料枠を黙って使わない）。
// - 3.8 Flash が回数の上限（429 / RESOURCE_EXHAUSTED）のときだけ、その回を1回だけ 3.5 Flash-Lite で頼み直す
//   （モデルごとに上限が別）。答えたモデルは結果の model・fallbackFrom で分かる。返事が届き始めた後は頼み直さない。
// - 無料枠（Unpaid Services）では、送った内容と返事が Google の製品改善に使われ、人が読むこともある
//   （設定画面で説明する）。請求先アカウント（課金）を有効にしなければ料金は発生しない（上限で止まるだけ）。
// ============================================================================

import type { GenerateContentParameters, GoogleGenAIOptions } from "@google/genai";
import type { GeminiModel } from "../../data/types";
import {
  AiError,
  isAbortLike,
  knownOffline,
  normalizeTurns,
  parseJsonText,
  scrubSecret,
  withErrorExtra,
  type AiProvider,
  type AiUsage,
  type GenerateJsonOptions,
  type GenerateJsonResult,
  type StreamChatOptions,
  type StreamChatResult,
} from "./types";

// ---------------------------------------------------------------------------
// モデル
// ---------------------------------------------------------------------------

export const GEMINI_MODELS: readonly GeminiModel[] = ["gemini-3.8-flash", "gemini-3.5-flash-lite"];
export const DEFAULT_GEMINI_MODEL: GeminiModel = "gemini-3.8-flash";
/** 3.8 Flash が上限のとき、その回だけ頼み直すモデル */
export const GEMINI_FALLBACK_MODEL: GeminiModel = "gemini-3.5-flash-lite";

export const GEMINI_MODEL_INFO: Record<GeminiModel, { label: string; hint: string }> = {
  "gemini-3.8-flash": { label: "Gemini 3.8 Flash", hint: "賢さ優先" },
  "gemini-3.5-flash-lite": { label: "Gemini 3.5 Flash-Lite", hint: "速さ・回数優先" },
};

/** 保存値をモデルに丸める（無い・知らない値は既定の 3.8 Flash） */
export function toGeminiModel(v: unknown): GeminiModel {
  return GEMINI_MODELS.includes(v as GeminiModel) ? (v as GeminiModel) : DEFAULT_GEMINI_MODEL;
}

// ---------------------------------------------------------------------------
// クライアント（検証では偽物を渡す。実物は @google/genai の GoogleGenAI）
// ---------------------------------------------------------------------------

/** 応答のうち使うところ（SDK の GenerateContentResponse の一部。偽物は普通のオブジェクトで作れる） */
export interface GeminiResponseLike {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** ai.models のうち使うところ */
export interface GeminiClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GeminiResponseLike>;
    generateContentStream(params: GenerateContentParameters): Promise<AsyncIterable<GeminiResponseLike>>;
  };
}

/**
 * SDK のクライアントの設定。キーはヘッダーで送られる。自動の再試行はしない（attempts 1 = 最初の1回だけ）。
 * 検証では、これに偽の fetch（httpOptions.fetch）を足して実物の SDK を通信なしで動かす
 */
export function geminiSdkOptions(apiKey: string): GoogleGenAIOptions {
  return { apiKey, httpOptions: { retryOptions: { attempts: 1 } } };
}

type GenAiModule = typeof import("@google/genai");

/** SDK を読み込む（呼ぶときだけ）。読み込めなければ AiError */
async function loadSdk(): Promise<GenAiModule> {
  try {
    return await import("@google/genai");
  } catch {
    throw new AiError("network", "AIの準備（読み込み）に失敗しました。通信環境を確かめて、もう一度試してください", { code: "load" });
  }
}

// ---------------------------------------------------------------------------
// エラー
// ---------------------------------------------------------------------------

/** SDK の ApiError（HTTP の status と、JSON の本文を文字列にした message を持つ） */
function apiStatusOf(e: unknown): number | null {
  if (!(e instanceof Error)) return null;
  const s = (e as { status?: unknown }).status;
  return typeof s === "number" && Number.isFinite(s) ? s : null;
}

interface GeminiErrorBody {
  /** RESOURCE_EXHAUSTED / INVALID_ARGUMENT / PERMISSION_DENIED など */
  status: string;
  message: string;
  /** details[].reason（API_KEY_INVALID など） */
  reasons: string[];
  /** details[].violations[].quotaId（GenerateRequestsPerDayPerProjectPerModel-FreeTier など） */
  quotaIds: string[];
  /** details[].retryDelay（「37s」→ 37）。無ければ null */
  retrySec: number | null;
}

/** ApiError の message（JSON の本文）を読む。読めなければ文字列のまま message に入れる */
export function readGeminiErrorBody(raw: string): GeminiErrorBody {
  const out: GeminiErrorBody = { status: "", message: "", reasons: [], quotaIds: [], retrySec: null };
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  let body: unknown = null;
  try {
    const a = raw.indexOf("{");
    body = JSON.parse(a >= 0 ? raw.slice(a) : raw);
  } catch {
    out.message = raw;
    return out;
  }
  const err = isObj(body) && isObj(body.error) ? body.error : isObj(body) ? body : {};
  if (typeof err.status === "string") out.status = err.status;
  if (typeof err.message === "string") out.message = err.message;
  const details = Array.isArray(err.details) ? err.details : [];
  for (const d of details) {
    if (!isObj(d)) continue;
    if (typeof d.reason === "string") out.reasons.push(d.reason);
    if (Array.isArray(d.violations)) {
      for (const v of d.violations) if (isObj(v) && typeof v.quotaId === "string") out.quotaIds.push(v.quotaId);
    }
    if (typeof d.retryDelay === "string") {
      const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay.trim());
      if (m) out.retrySec = Math.ceil(Number(m[1]));
    }
  }
  return out;
}

/** 回数の上限（429 / RESOURCE_EXHAUSTED）だったか（classifyGeminiError の結果で見る）。3.8 Flash のときだけ頼み直すのに使う */
export function isGeminiRateLimited(e: AiError): boolean {
  return (e.kind === "rate-limit" || e.kind === "quota") && e.code === "429";
}

/** SDK の例外を、画面に出す日本語の AiError にする。code は HTTP の status か、finishReason など */
export function classifyGeminiError(e: unknown, signal?: AbortSignal | null): AiError {
  if (e instanceof AiError) return e;
  if (isAbortLike(e, signal)) return new AiError("aborted", "中止しました", { code: "aborted" });
  const status = apiStatusOf(e);
  if (status !== null || (e instanceof Error && /RESOURCE_EXHAUSTED/.test(e.message))) {
    const body = readGeminiErrorBody(e instanceof Error ? e.message : "");
    const code = String(status ?? 429);
    const text = `${body.status} ${body.message} ${body.reasons.join(" ")} ${body.quotaIds.join(" ")}`;
    const detail = body.message.trim().replace(/\s+/g, " ").slice(0, 160);
    if (status === 429 || /RESOURCE_EXHAUSTED/.test(text)) {
      if (/limit:\s*0\b/i.test(text)) {
        return new AiError("quota", "このモデルは無料枠では使えないようです（上限が 0）。設定の「🤖 AI」で別のモデルを選んでください", {
          code: "429",
        });
      }
      if (/PerDay|per day|daily/i.test(text)) {
        return new AiError("quota", "無料枠の今日の上限に達しました。明日また試してください（上限は AI Studio で確かめられます）", {
          code: "429",
        });
      }
      if (/PerMinute|per minute/i.test(text)) {
        const wait = body.retrySec ? `約${body.retrySec}秒` : "1分ほど";
        return new AiError("rate-limit", `無料枠の1分あたりの上限に達しました。${wait}待ってから試してください`, { code: "429" });
      }
      return new AiError("rate-limit", "無料枠の上限に達しました。しばらく待つか、明日また試してください", { code: "429" });
    }
    if (status === 401 || body.reasons.includes("API_KEY_INVALID") || /API key (not valid|expired|invalid)/i.test(body.message)) {
      return new AiError("auth", "Gemini の APIキーが正しくありません（無効・削除済みの可能性）。設定の「🤖 AI」でキーを確かめてください", {
        code: String(status ?? 400),
      });
    }
    if (status === 403 || body.status === "PERMISSION_DENIED") {
      return new AiError("auth", "このAPIキーでは Gemini を使えません（キーの制限・権限）。AI Studio でキーを確かめてください", {
        code: "403",
      });
    }
    if (status === 404) {
      return new AiError("unknown", "このモデルは今は使えません。設定の「🤖 AI」で Gemini の別のモデルを選んでください", { code: "404" });
    }
    if (/location|country|region/i.test(body.message) && (status === 400 || body.status === "FAILED_PRECONDITION")) {
      return new AiError("unknown", "この地域・この設定では Gemini の無料枠が使えないようです。AI Studio で確かめてください", { code });
    }
    if (status !== null && status >= 500) {
      return new AiError("server", "Google 側で一時的なエラーが起きました（混雑など）。少し待ってから試してください", { code });
    }
    return new AiError("unknown", `AIの呼び出しに失敗しました（${code}${detail ? `・${detail}` : ""}）`, { code });
  }
  if (e instanceof Error && e.name === "TimeoutError") {
    return new AiError("network", "時間内に応答がありませんでした。通信環境を確かめて、もう一度試してください", { code: "timeout" });
  }
  if (knownOffline()) return new AiError("offline", "オフラインです。ネットにつながってから試してください", { code: "offline" });
  // fetch の失敗（Chrome「Failed to fetch」・Safari「Load failed」・Firefox「NetworkError…」・Node「fetch failed」）
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) {
    return new AiError("network", "通信エラーです。接続が不安定です", { code: "network" });
  }
  return new AiError("unknown", "AIの呼び出しに失敗しました", { code: "unknown" });
}

// ---------------------------------------------------------------------------
// 応答の読み取り
// ---------------------------------------------------------------------------

/** 応答の本文（考えた過程 thought を除いた text をつなげる） */
export function geminiText(r: GeminiResponseLike | null | undefined): string {
  const parts = r?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => (p && !p.thought && typeof p.text === "string" ? p.text : "")).join("");
}

export function geminiUsage(r: GeminiResponseLike | null | undefined): AiUsage | undefined {
  const u = r?.usageMetadata;
  if (!u) return undefined;
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return { input: n(u.promptTokenCount), output: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount) };
}

/** 安全のための制限で止まった理由（finishReason）。LANGUAGE・OTHER は本文があればそのまま使う */
const REFUSAL_FINISH = new Set(["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

/**
 * 最後の状態を確かめる（止まった理由 → AiError。問題なければ null）。
 * RECITATION = 歌詞など、よそにある文章をそのまま書こうとして止まった。
 * 会話（chat）では途中まで届いた返事を partialText に入れる（JSON では入れない）
 */
export function geminiStopError(p: {
  finish: string;
  block: string;
  text: string;
  model: string;
  usage?: AiUsage;
  chat: boolean;
}): AiError | null {
  const extra = { usage: p.usage, model: p.model, partialText: p.chat && p.text ? p.text : undefined };
  if (p.block) {
    return new AiError("refusal", "AIがこの内容には答えられないと判断しました（安全のための制限）。聞き方を変えてみてください", {
      code: p.block,
      ...extra,
    });
  }
  if (p.finish === "MAX_TOKENS") {
    return new AiError("truncated", p.chat ? "返事が長くなりすぎて途中で切れました" : "AIの応答が長くなりすぎて途中で切れました", {
      code: "MAX_TOKENS",
      ...extra,
    });
  }
  if (p.finish === "RECITATION") {
    return new AiError("refusal", "AIが途中で答えを止めました（歌詞などの文章をそのまま書くのを避けるため）。聞き方を変えてみてください", {
      code: "RECITATION",
      ...extra,
    });
  }
  if (REFUSAL_FINISH.has(p.finish)) {
    return new AiError("refusal", "AIが途中で答えを止めました（安全のための制限）。聞き方を変えてみてください", { code: p.finish, ...extra });
  }
  if (!p.text.trim()) {
    return new AiError("bad-response", p.chat ? "AIの返事が空でした。もう一度試してください" : "AIの応答に中身がありませんでした", {
      code: p.finish || "EMPTY",
      ...extra,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// サービス
// ---------------------------------------------------------------------------

/**
 * Gemini のサービスを作る（SDK はまだ読み込まない。呼んだときに読み込む）。
 * client は検証用（省略時は SDK を読み込んで、この apiKey でクライアントを作る）
 */
export function createGeminiProvider(p: { apiKey: string | null; model: GeminiModel; client?: GeminiClient }): AiProvider {
  const apiKey = (p.apiKey ?? "").trim();
  const model = toGeminiModel(p.model);
  let client: GeminiClient | null = p.client ?? null;

  /** 失敗を画面に出す形にする（万一キーが説明に入っていても伏せる） */
  const fail = (e: unknown, signal?: AbortSignal | null): AiError => {
    const err = classifyGeminiError(e, signal);
    const msg = scrubSecret(err.message, apiKey);
    return msg === err.message ? err : new AiError(err.kind, msg, { code: err.code, usage: err.usage, model: err.model, partialText: err.partialText });
  };

  async function prepare(signal?: AbortSignal): Promise<GeminiClient> {
    if (!apiKey) throw new AiError("no-key", "Gemini の APIキーが設定されていません（設定の「🤖 AI」で入れてください）", { code: "no_key" });
    if (!client) {
      const mod = await loadSdk();
      client = new mod.GoogleGenAI(geminiSdkOptions(apiKey));
    }
    if (signal?.aborted) throw new AiError("aborted", "中止しました", { code: "aborted" });
    return client;
  }

  /**
   * 3.8 Flash が回数の上限のときだけ、1回だけ 3.5 Flash-Lite で頼み直す（canRetry が false なら頼み直さない。
   * 会話で返事が届き始めた後など）。エラーには失敗したモデル（model）を付ける。
   * 頼み直しも上限なら、選んだモデルのエラーを出す（3.5 Flash-Lite の「上限が 0」「今日の上限」で、
   * 選んだモデルの案内を上書きしない）。ただし 3.5 Flash-Lite の方が1分あたりの上限（すぐ戻る）なら、そちら。
   * 頼み直しがそのほかの理由で失敗したら（中止・キーなど）、そのエラー
   */
  async function withFallback<T>(run: (m: GeminiModel) => Promise<T>, signal: AbortSignal | undefined, canRetry: () => boolean): Promise<{ value: T; used: GeminiModel }> {
    try {
      return { value: await run(model), used: model };
    } catch (e) {
      const err = fail(e, signal);
      if (model === GEMINI_FALLBACK_MODEL || err.kind === "aborted" || !canRetry() || !isGeminiRateLimited(err)) throw withErrorExtra(err, { model });
      try {
        return { value: await run(GEMINI_FALLBACK_MODEL), used: GEMINI_FALLBACK_MODEL };
      } catch (e2) {
        const err2 = fail(e2, signal);
        // canRetry() が false = 3.5 Flash-Lite の返事が届き始めていた（途中までの返事はそのモデルのもの）
        const bothLimited = err2.kind !== "aborted" && isGeminiRateLimited(err2) && canRetry();
        if (bothLimited && !(err.kind === "quota" && err2.kind === "rate-limit")) throw withErrorExtra(err, { model });
        throw withErrorExtra(err2, { model: GEMINI_FALLBACK_MODEL });
      }
    }
  }

  async function generateJson(opts: GenerateJsonOptions): Promise<GenerateJsonResult> {
    const c = await prepare(opts.signal);
    const { value: res, used } = await withFallback(
      (m) =>
        c.models.generateContent({
          model: m,
          contents: [{ role: "user", parts: [{ text: opts.user }] }],
          config: {
            systemInstruction: opts.system,
            responseMimeType: "application/json",
            responseJsonSchema: opts.schema,
            abortSignal: opts.signal,
          },
        }),
      opts.signal,
      () => true
    );
    const text = geminiText(res);
    const usage = geminiUsage(res);
    const stop = geminiStopError({
      finish: res.candidates?.[0]?.finishReason ?? "",
      block: res.promptFeedback?.blockReason ?? "",
      text,
      model: used,
      usage,
      chat: false,
    });
    if (stop) throw stop;
    let json: unknown;
    try {
      json = parseJsonText(text);
    } catch {
      throw new AiError("bad-response", "AIの応答を JSON として読めませんでした", { code: "parse", usage, model: used });
    }
    return { json, model: used, ...(usage ? { usage } : {}), ...(used !== model ? { fallbackFrom: model } : {}) };
  }

  async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
    const turns = normalizeTurns(opts.turns);
    if (!turns.length) throw new AiError("unknown", "送る質問がありません", { code: "empty" });
    const c = await prepare(opts.signal);
    const contents = turns.map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: [{ text: t.text }] }));
    let text = "";
    /** 今答えているモデル（上限で 3.5 Flash-Lite に替えたら、途中で止めた返事もそのモデルのもの） */
    let current: GeminiModel = model;
    const run = async (m: GeminiModel) => {
      current = m;
      const stream = await c.models.generateContentStream({
        model: m,
        contents,
        config: { systemInstruction: opts.system, abortSignal: opts.signal },
      });
      let finish = "";
      let block = "";
      let usage: AiUsage | undefined;
      for await (const chunk of stream) {
        if (opts.signal?.aborted) throw new AiError("aborted", "中止しました", { code: "aborted" });
        const delta = geminiText(chunk);
        if (delta) {
          text += delta;
          opts.onText(delta);
        }
        finish = chunk.candidates?.[0]?.finishReason ?? finish;
        block = chunk.promptFeedback?.blockReason ?? block;
        usage = geminiUsage(chunk) ?? usage;
      }
      return { finish, block, usage };
    };
    try {
      // 返事が届き始めた後は頼み直さない（同じ返事が2回出るのを防ぐ）
      const { value, used } = await withFallback(run, opts.signal, () => !text);
      const stop = geminiStopError({ ...value, text, model: used, chat: true });
      if (stop) throw stop;
      return { text, model: used, ...(value.usage ? { usage: value.usage } : {}), ...(used !== model ? { fallbackFrom: model } : {}) };
    } catch (e) {
      const err = fail(e, opts.signal);
      throw withErrorExtra(err, { model: err.model ?? current, ...(text && !err.partialText ? { partialText: text } : {}) });
    }
  }

  async function testConnection(opts: { signal?: AbortSignal } = {}): Promise<{ model: string; usage?: AiUsage }> {
    const c = await prepare(opts.signal);
    try {
      // 選んだモデルそのものを確かめる（上限でも頼み直さない。429 ならキーは正しい）
      const res = await c.models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }],
        config: { abortSignal: opts.signal, httpOptions: { timeout: 30_000 } },
      });
      return { model, ...(geminiUsage(res) ? { usage: geminiUsage(res) } : {}) };
    } catch (e) {
      // SDK の打ち切り（httpOptions.timeout）は理由なしの中止（AbortError）として届く（TimeoutError ではない）。
      // こちらが中止していなければ「時間内に応答がなかった」にする（「中止しました」と出さない）
      if (!opts.signal?.aborted && (e as { name?: unknown } | null)?.name === "AbortError") {
        throw new AiError("network", "時間内に応答がありませんでした。通信環境を確かめて、もう一度試してください", { code: "timeout", model });
      }
      throw fail(e, opts.signal);
    }
  }

  return { id: "gemini", name: "Gemini", model, free: true, streamChat, generateJson, testConnection };
}
