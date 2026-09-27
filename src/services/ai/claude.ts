// ============================================================================
// AI のサービス: Claude（Anthropic。利用者自身の API キーで、任意・有料）
//   検証: scripts/check-ai.ts・scripts/check-translate.ts（偽のクライアントで動かし、実際には通信しない）
// - 公式の TypeScript SDK（@anthropic-ai/sdk）を、呼ぶときにだけ読み込む（dynamic import。最初の画面の
//   バンドルに入れない）。ブラウザから直接呼ぶので dangerouslyAllowBrowser を付ける（キーは利用者自身のもので、
//   この端末にだけ保存している。useSecrets.ts）。キーは SDK がヘッダーで送る（URL に入れない）。
// - SDK の自動の再試行はしない（maxRetries 0。有料のリクエストを黙って送り直さない）。
// - Sonnet 5 / Opus 5 は effort medium（考える量を抑えて、料金を見積もりに近づける）。Haiku 4.5 には effort を送らない。
// - generateJson: 構造化出力（output_config.format の json_schema）で頼み、モデルが受け付けなければ1回だけ
//   format なしで頼み直して本文の JSON を読む。stop_reason の refusal / max_tokens は AiError にする。
// - streamChat: client.messages.stream で返事を少しずつ渡し、最後に finalMessage() で stop_reason・usage を見る。
// - 以前の歌詞の AI 翻訳（aiTranslate.ts の translateSongWithClaude）と同じ送り方・同じエラーの扱い
//   （AiError.code に以前の AiTranslateError の kind を入れる）。
// ============================================================================

import type Anthropic from "@anthropic-ai/sdk";
import type { AiTranslateModel } from "../../data/types";
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
// モデル（料金は aiTranslate.ts で計算する）
// ---------------------------------------------------------------------------

export const AI_MODELS: readonly AiTranslateModel[] = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"];
export const DEFAULT_AI_MODEL: AiTranslateModel = "claude-haiku-4-5";

export interface AiModelInfo {
  /** 画面の表示名 */
  label: string;
  /** 選ぶときの一言 */
  hint: string;
  /** 100万トークンあたりの料金（USD）: 入力 / 出力 */
  usdPerMTokIn: number;
  usdPerMTokOut: number;
  /**
   * 見積もりで出力に掛ける係数。Sonnet 5 / Opus 5 は、考える過程（思考。effort medium）も出力として課金され、
   * 同じ文でもトークン数が 3 割ほど多く数えられる（トークナイザーが違う）ため、多めに見る（安く見せない）
   */
  outputFactor: number;
}

export const AI_MODEL_INFO: Record<AiTranslateModel, AiModelInfo> = {
  "claude-haiku-4-5": { label: "Haiku 4.5", hint: "おすすめ・安い", usdPerMTokIn: 1, usdPerMTokOut: 5, outputFactor: 1 },
  "claude-sonnet-5": { label: "Sonnet 5", hint: "より丁寧", usdPerMTokIn: 2, usdPerMTokOut: 10, outputFactor: 2.5 },
  "claude-opus-5": { label: "Opus 5", hint: "最高品質", usdPerMTokIn: 5, usdPerMTokOut: 25, outputFactor: 2.5 },
};

/** 保存値をモデルに丸める（無い・知らない値は既定の Haiku 4.5） */
export function toAiModel(v: unknown): AiTranslateModel {
  return AI_MODELS.includes(v as AiTranslateModel) ? (v as AiTranslateModel) : DEFAULT_AI_MODEL;
}

/** 考える量（Sonnet 5 / Opus 5 は medium。Haiku 4.5 は effort を受け付けない（400）ので null = 送らない） */
export function claudeEffort(model: AiTranslateModel): Anthropic.OutputConfig | null {
  return model === "claude-haiku-4-5" ? null : { effort: "medium" };
}

// ---------------------------------------------------------------------------
// クライアント（検証では偽物を渡す。実物は @anthropic-ai/sdk の Anthropic）
// ---------------------------------------------------------------------------

export type ClaudeRequestOptions = { signal?: AbortSignal | null; timeout?: number; maxRetries?: number };

/** messages.stream の戻り値のうち使うところ（イベントを順に読み、最後に finalMessage） */
export interface ClaudeStreamLike extends AsyncIterable<Anthropic.MessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>;
}

/** messages.create（JSON・接続テスト）と messages.stream（会話）だけを使う */
export interface MessagesClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming, options?: ClaudeRequestOptions): PromiseLike<Anthropic.Message>;
    /** 会話（少しずつ返事を受け取る）。検証の偽物では省略できる */
    stream?(body: Anthropic.MessageStreamParams, options?: ClaudeRequestOptions): ClaudeStreamLike;
  };
}

type Sdk = typeof import("@anthropic-ai/sdk").default;

/** SDK を読み込む（呼ぶときだけ。最初の画面のバンドルに入れない）。読み込めなければ AiError */
async function loadSdk(): Promise<Sdk> {
  try {
    const mod = await import("@anthropic-ai/sdk");
    return mod.default;
  } catch {
    throw new AiError("network", "AIの準備（読み込み）に失敗しました。通信環境を確かめて、もう一度試してください", { code: "connection" });
  }
}

/** API のエラー本文の message（例: クレジット残高が足りない）。無ければ null */
function apiErrorDetail(e: { error?: unknown }): string | null {
  const body = e.error;
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const inner = isObj(body) && isObj(body.error) ? body.error.message : undefined;
  return typeof inner === "string" && inner.trim() ? inner.trim().slice(0, 200) : null;
}

/**
 * SDK の型付きエラーを、画面に出す日本語の AiError にする（具体的なクラスから順に見る）。
 * code には以前の AiTranslateError の kind（auth / permission / not_found / rate_limit / bad_request /
 * connection / server / billing / api / aborted / unknown）を入れる
 */
export function classifyClaudeError(A: Sdk, e: unknown, signal?: AbortSignal | null): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof A.APIUserAbortError || isAbortLike(e, signal)) return new AiError("aborted", "中止しました", { code: "aborted" });
  if (e instanceof A.AuthenticationError) {
    return new AiError("auth", "APIキーが正しくありません（無効・削除済みの可能性）。設定の「🤖 AI」で Claude のキーを確かめてください", {
      code: "auth",
    });
  }
  if (e instanceof A.PermissionDeniedError) {
    return new AiError("auth", "このAPIキーでは使えません（権限や利用地域の制限）。Anthropic Console で確かめてください", {
      code: "permission",
    });
  }
  if (e instanceof A.NotFoundError) {
    return new AiError("unknown", "このモデルはこのAPIキーでは使えません。設定の「🤖 AI」で Claude の別のモデルを選んでください", {
      code: "not_found",
    });
  }
  if (e instanceof A.RateLimitError) {
    return new AiError(
      "rate-limit",
      "混み合っているか、利用の上限に達しました。少し待ってから試してください（月の上限は Anthropic Console で確かめられます）",
      { code: "rate_limit" }
    );
  }
  if (e instanceof A.BadRequestError) {
    const detail = apiErrorDetail(e);
    return new AiError(
      "unknown",
      `リクエストが受け付けられませんでした${detail ? `（${detail}）` : ""}。クレジット残高・支払い設定も Anthropic Console で確かめてください`,
      { code: "bad_request" }
    );
  }
  if (e instanceof A.APIConnectionTimeoutError) {
    return new AiError("network", "時間内に応答がありませんでした。通信環境を確かめて、もう一度試してください", { code: "connection" });
  }
  if (e instanceof A.APIConnectionError) {
    return new AiError(knownOffline() ? "offline" : "network", "通信エラーです。オフラインか、接続が不安定です", { code: "connection" });
  }
  if (e instanceof A.InternalServerError) {
    return new AiError("server", "Anthropic 側で一時的なエラーが起きました（混雑など）。少し待ってから試してください", { code: "server" });
  }
  if (e instanceof A.APIError) {
    // HTTP 200 の後にストリームの途中で届いたエラー（SSE の event: error）は status が無く、type で種類が分かる
    if (e.status === undefined) {
      if (e.type === "overloaded_error" || e.type === "api_error") {
        return new AiError("server", "Anthropic 側で一時的なエラーが起きました（混雑など）。少し待ってから試してください", { code: "server" });
      }
      if (e.type === "rate_limit_error") {
        return new AiError(
          "rate-limit",
          "混み合っているか、利用の上限に達しました。少し待ってから試してください（月の上限は Anthropic Console で確かめられます）",
          { code: "rate_limit" }
        );
      }
      if (e.type === "authentication_error") {
        return new AiError("auth", "APIキーが正しくありません（無効・削除済みの可能性）。設定の「🤖 AI」で Claude のキーを確かめてください", {
          code: "auth",
        });
      }
      if (e.type === "permission_error") {
        return new AiError("auth", "このAPIキーでは使えません（権限や利用地域の制限）。Anthropic Console で確かめてください", {
          code: "permission",
        });
      }
      if (e.type === "billing_error") {
        return new AiError("quota", "支払いの問題で使えません。Anthropic Console でクレジット残高・支払い設定を確かめてください", {
          code: "billing",
        });
      }
      if (e.type === "timeout_error") {
        return new AiError("network", "時間内に応答がありませんでした。通信環境を確かめて、もう一度試してください", { code: "connection" });
      }
    }
    if (e.status === 402) {
      return new AiError("quota", "支払いの問題で使えません。Anthropic Console でクレジット残高・支払い設定を確かめてください", {
        code: "billing",
      });
    }
    return new AiError("unknown", `AIの呼び出しに失敗しました${e.status ? `（${e.status}）` : ""}`, { code: "api" });
  }
  return new AiError("unknown", "AIの呼び出しに失敗しました", { code: "unknown" });
}

/** 構造化出力（output_config）をこのモデルが受け付けなかったか（そのときだけ1回、format なしで頼み直す） */
function isOutputConfigRejected(A: Sdk, e: unknown): boolean {
  if (!(e instanceof A.BadRequestError)) return false;
  return /output_config|output_format|format|schema/i.test(`${apiErrorDetail(e) ?? ""} ${e.message}`);
}

function firstText(res: Anthropic.Message): string | null {
  const block = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return block ? block.text : null;
}

/** 応答の usage を共通の形に（料金は aiTranslate.ts の costFromUsage / aiCostOf で計算する） */
export function claudeUsage(u: Anthropic.Usage | null | undefined): AiUsage {
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    input: n(u?.input_tokens),
    output: n(u?.output_tokens),
    cacheWrite: n(u?.cache_creation_input_tokens),
    cacheRead: n(u?.cache_read_input_tokens),
  };
}

// ---------------------------------------------------------------------------
// サービス
// ---------------------------------------------------------------------------

/**
 * Claude のサービスを作る（SDK はまだ読み込まない。呼んだときに読み込む）。
 * client は検証用（省略時は SDK を読み込んで、この apiKey でクライアントを作る）
 */
export function createClaudeProvider(p: { apiKey: string | null; model: AiTranslateModel; client?: MessagesClient }): AiProvider {
  const apiKey = (p.apiKey ?? "").trim();
  const model = toAiModel(p.model);
  const effort = claudeEffort(model);

  /** 失敗を画面に出す形にする（万一キーが説明に入っていても伏せる） */
  const fail = (A: Sdk, e: unknown, signal?: AbortSignal | null): AiError => {
    const err = classifyClaudeError(A, e, signal);
    const msg = scrubSecret(err.message, apiKey);
    return msg === err.message ? err : new AiError(err.kind, msg, { code: err.code, usage: err.usage, model: err.model, partialText: err.partialText });
  };

  async function prepare(signal?: AbortSignal): Promise<{ A: Sdk; client: MessagesClient }> {
    if (!apiKey) throw new AiError("no-key", "Claude の APIキーが設定されていません（設定の「🤖 AI」で入れてください）", { code: "no_key" });
    const A = await loadSdk();
    if (signal?.aborted) throw new AiError("aborted", "中止しました", { code: "aborted" });
    return { A, client: p.client ?? new A({ apiKey, dangerouslyAllowBrowser: true }) };
  }

  async function generateJson(opts: GenerateJsonOptions): Promise<GenerateJsonResult> {
    const { A, client } = await prepare(opts.signal);
    // thinking は送らない（Haiku 4.5 は考えずに答える。Sonnet 5 / Opus 5 は省略すると考えながら答える）。
    // Sonnet 5 / Opus 5 の考える量は effort で抑える（既定の high だと上限がなく、料金が見積もりを大きく超えたり、
    // 長い入力で max_tokens に届いて何も使えなかったりする）
    const base: Anthropic.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: 16000,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
      ...(effort ? { output_config: effort } : {}),
    };
    // SDK の自動の再試行はしない（有料のリクエストを黙って送り直さない。表示する料金も1回分だけ）
    const reqOpts: ClaudeRequestOptions = { signal: opts.signal, maxRetries: 0 };

    let res: Anthropic.Message;
    let formatFallback = false;
    try {
      res = await client.messages.create(
        { ...base, output_config: { ...effort, format: { type: "json_schema", schema: opts.schema } } },
        reqOpts
      );
    } catch (e) {
      if (!isOutputConfigRejected(A, e) || opts.signal?.aborted) throw fail(A, e, opts.signal);
      // 構造化出力を受け付けないモデル → 1回だけ、本文の JSON で頼み直す（base のまま = format だけを外し、effort は残す）
      formatFallback = true;
      try {
        res = await client.messages.create(base, reqOpts);
      } catch (e2) {
        throw fail(A, e2, opts.signal);
      }
    }

    const usage = claudeUsage(res.usage);
    if (res.stop_reason === "refusal") {
      throw new AiError("refusal", "AIがこの依頼への回答を断りました。設定の「🤖 AI」で別のモデルやサービスを選んでください", {
        code: "refusal",
        usage,
        model,
      });
    }
    if (res.stop_reason === "max_tokens") {
      throw new AiError("truncated", "AIの応答が長くなりすぎて途中で切れました", { code: "max_tokens", usage, model });
    }
    const text = firstText(res);
    if (text == null) throw new AiError("bad-response", "AIの応答に中身がありませんでした", { code: "parse", usage, model });
    let json: unknown;
    try {
      json = parseJsonText(text);
    } catch {
      throw new AiError("bad-response", "AIの応答を JSON として読めませんでした", { code: "parse", usage, model });
    }
    return { json, model, usage, ...(formatFallback ? { formatFallback } : {}) };
  }

  async function streamChat(opts: StreamChatOptions): Promise<StreamChatResult> {
    const messages: Anthropic.MessageParam[] = normalizeTurns(opts.turns).map((t) => ({ role: t.role, content: t.text }));
    if (!messages.length) throw new AiError("unknown", "送る質問がありません", { code: "empty" });
    const { A, client } = await prepare(opts.signal);
    if (!client.messages.stream) throw new AiError("unknown", "このクライアントは会話（ストリーミング）に対応していません", { code: "unknown" });
    let text = "";
    try {
      // 公式 SDK の流れ: stream のイベントから text_delta を渡し、最後に finalMessage() で stop_reason・usage を見る。
      // SDK の自動の再試行はしない（maxRetries 0）
      const stream = client.messages.stream(
        { model, max_tokens: 16000, system: opts.system, messages, ...(effort ? { output_config: effort } : {}) },
        { signal: opts.signal, maxRetries: 0 }
      );
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          text += event.delta.text;
          opts.onText(event.delta.text);
        }
      }
      const final = await stream.finalMessage();
      const usage = claudeUsage(final.usage);
      if (final.stop_reason === "refusal") {
        throw new AiError("refusal", "AIがこの質問への回答を断りました。聞き方を変えてみてください", {
          code: "refusal",
          usage,
          model,
          partialText: text,
        });
      }
      if (final.stop_reason === "max_tokens") {
        throw new AiError("truncated", "返事が長くなりすぎて途中で切れました", { code: "max_tokens", usage, model, partialText: text });
      }
      if (!text.trim()) {
        const whole = firstText(final) ?? "";
        if (!whole.trim()) throw new AiError("bad-response", "AIの返事が空でした。もう一度試してください", { code: "parse", usage, model });
        text = whole;
        opts.onText(whole);
      }
      return { text, model, usage };
    } catch (e) {
      const err = fail(A, e, opts.signal);
      throw text && !err.partialText ? withErrorExtra(err, { partialText: text }) : err;
    }
  }

  async function testConnection(opts: { signal?: AbortSignal } = {}): Promise<{ model: string; usage?: AiUsage }> {
    const { A, client } = await prepare();
    try {
      const res = await client.messages.create(
        { model, max_tokens: 16, messages: [{ role: "user", content: "Reply with OK." }] },
        { signal: opts.signal, timeout: 30_000 }
      );
      return { model, usage: claudeUsage(res.usage) };
    } catch (e) {
      throw fail(A, e, opts.signal);
    }
  }

  return { id: "claude", name: "Claude", model, free: false, streamChat, generateJson, testConnection };
}
