// ============================================================================
// AI（先生のチャット・歌詞の AI 翻訳）の共通の形: サービス（Gemini / Claude）に依らない呼び出し口とエラー
//   検証: scripts/check-ai.ts（npm run check:ai。偽のクライアントで動かし、実際には通信しない）
// - AiProvider: streamChat（会話。少しずつ届く返事を onText で渡す）・generateJson（JSON で答えさせる）・
//   testConnection（接続テスト）。実装は gemini.ts（既定・無料枠）と claude.ts（任意・有料）。選ぶのは index.ts
// - 失敗はすべて AiError（kind = 種類・message = 画面に出す日本語）。SDK の例外は各実装で AiError に直す
// - SDK はここでは読み込まない（型も持ち込まない。最初の画面の読み込みを重くしない）
// ============================================================================

import type { AiProviderId } from "../../data/types";

export type { AiProviderId };

/** 会話の1回分（user = 学習者 / assistant = AI） */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** トークン数（分かるものだけ）。input = 入力、output = 出力（Gemini は考えた分も含む）、cache* = Claude のキャッシュ */
export interface AiUsage {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
}

export interface StreamChatOptions {
  /** 先生の役割・話し方（システムプロンプト） */
  system: string;
  /** これまでの会話（最後は user。normalizeTurns で整えてから送る） */
  turns: readonly ChatTurn[];
  signal?: AbortSignal;
  /** 返事が少し届くたびに、その差分を渡す（画面に足していく） */
  onText: (delta: string) => void;
}

export interface StreamChatResult {
  /** 返事の全文 */
  text: string;
  /** 答えたモデル（Gemini は上限のとき別のモデルが答えることがある → fallbackFrom） */
  model: string;
  usage?: AiUsage;
  /** 設定のモデルが上限だったので別のモデルが答えたとき、元のモデル */
  fallbackFrom?: string;
}

export interface GenerateJsonOptions {
  system: string;
  /** user のメッセージ（1つ） */
  user: string;
  /** 応答の JSON スキーマ（type / properties / required / additionalProperties / items の範囲で書く） */
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface GenerateJsonResult {
  /** JSON.parse 済みの応答（中身の形は呼び出し側で確かめる） */
  json: unknown;
  model: string;
  usage?: AiUsage;
  /** 設定のモデルが上限だったので別のモデルが答えたとき、元のモデル（Gemini） */
  fallbackFrom?: string;
  /** 構造化出力（スキーマ）を受け付けないモデルだったので、スキーマなしで頼み直した（Claude） */
  formatFallback?: boolean;
}

export interface AiProvider {
  readonly id: AiProviderId;
  /** サービスの表示名（Gemini / Claude） */
  readonly name: string;
  /** 設定で選んだモデル */
  readonly model: string;
  /** 無料枠で使う（料金を出さない）。Gemini は true */
  readonly free: boolean;
  streamChat(opts: StreamChatOptions): Promise<StreamChatResult>;
  generateJson(opts: GenerateJsonOptions): Promise<GenerateJsonResult>;
  /** 接続テスト: 小さなリクエストを1回送り、キーとモデルが使えるか確かめる */
  testConnection(opts?: { signal?: AbortSignal }): Promise<{ model: string; usage?: AiUsage }>;
}

// ---------------------------------------------------------------------------
// エラー
// ---------------------------------------------------------------------------

/**
 * 失敗の種類。
 * no-key: キーが無い / auth: キーが正しくない・使えない / rate-limit: 回数の上限（少し待てば使える）/
 * quota: 1日の上限・支払いの問題（今日は使えない）/ network: 通信の失敗 / offline: オフライン /
 * refusal: AI が答えを断った・止めた / truncated: 返事が途中で切れた / bad-response: 応答の形が崩れている /
 * aborted: 中止した / server: サービス側の一時的なエラー / unknown: そのほか
 */
export type AiErrorKind =
  | "no-key"
  | "auth"
  | "rate-limit"
  | "quota"
  | "network"
  | "offline"
  | "refusal"
  | "truncated"
  | "bad-response"
  | "aborted"
  | "server"
  | "unknown";

/** AI の呼び出しの失敗（message は画面に出す日本語。API キーは入れない） */
export class AiError extends Error {
  readonly kind: AiErrorKind;
  /** サービスごとの細かい種類（Claude は以前の AiTranslateError の kind、Gemini は finishReason など）。表示には使わない */
  readonly code?: string;
  /** その回に使ったトークン数（分かるとき。Claude の料金の計算に使う） */
  readonly usage?: AiUsage;
  /** 失敗したモデル */
  readonly model?: string;
  /** 途中まで届いていた返事（streamChat で、返事の途中で止まったとき） */
  readonly partialText?: string;
  constructor(
    kind: AiErrorKind,
    message: string,
    extra: { code?: string; usage?: AiUsage; model?: string; partialText?: string } = {}
  ) {
    super(message);
    this.name = "AiError";
    this.kind = kind;
    if (extra.code !== undefined) this.code = extra.code;
    if (extra.usage !== undefined) this.usage = extra.usage;
    if (extra.model !== undefined) this.model = extra.model;
    if (extra.partialText !== undefined) this.partialText = extra.partialText;
  }
}

/** 同じエラーに、途中まで届いた返事などを足した写し（kind・message・code・usage はそのまま） */
export function withErrorExtra(e: AiError, extra: { usage?: AiUsage; model?: string; partialText?: string }): AiError {
  return new AiError(e.kind, e.message, {
    code: e.code,
    usage: extra.usage ?? e.usage,
    model: extra.model ?? e.model,
    partialText: extra.partialText ?? e.partialText,
  });
}

/** 中止したか（signal が中止済み・AbortError / TimeoutError でない中止の例外） */
export function isAbortLike(e: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/** ブラウザがオフラインと分かっているか（Node の検証では常に false） */
export function knownOffline(): boolean {
  return typeof navigator !== "undefined" && (navigator as { onLine?: unknown }).onLine === false;
}

/** 文からキーを伏せる（万一、エラーの説明にキーが入っていても画面に出さない） */
export function scrubSecret(text: string, secret: string | null | undefined): string {
  const s = (secret ?? "").trim();
  return s.length >= 6 ? text.split(s).join("（キー）") : text;
}

// ---------------------------------------------------------------------------
// 共通の小さな関数
// ---------------------------------------------------------------------------

/**
 * 送る会話を整える: 空の発言を除き、同じ役割が続けば1つにまとめ（空行で区切る）、先頭の assistant は除く
 * （会話は user から始める。画面だけのあいさつなど）。最後が user でなければ空（送れない）
 */
export function normalizeTurns(turns: readonly ChatTurn[]): ChatTurn[] {
  const out: ChatTurn[] = [];
  for (const t of turns) {
    const text = (t.text ?? "").trim();
    if (!text) continue;
    if (t.role !== "user" && t.role !== "assistant") continue;
    if (!out.length && t.role === "assistant") continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.text = `${last.text}\n\n${text}`;
    else out.push({ role: t.role, text });
  }
  return out.length && out[out.length - 1].role === "user" ? out : [];
}

/** 本文から JSON を取り出して読む（```json の囲みや前後の文を除く）。読めなければ例外 */
export function parseJsonText(text: string): unknown {
  let t = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t);
  if (fence) t = fence[1].trim();
  if (!t.startsWith("{")) {
    const a = t.indexOf("{");
    const b = t.lastIndexOf("}");
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
  }
  return JSON.parse(t);
}
