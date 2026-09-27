// ============================================================================
// 歌詞の AI 翻訳（Claude。利用者自身の Anthropic API キーで、任意・オプトイン）
//   検証: scripts/check-translate.ts（npm run check:translate。偽のクライアントで動かし、実際には通信しない）
// - 無料の機械翻訳（translate.ts）とは別の経路。キーが無ければ何も起きない（画面にボタンも出さない）。
// - 送るもの: 曲名・アーティスト名・歌詞の行（空でない行。同じ行は1回だけ）。ユーザーが「AIで訳す」を
//   押して確認したときだけ送る。結果は行のハッシュをキーに端末へ保存する（歌詞の本文は保存しない。useMusic）。
// - 公式の TypeScript SDK（@anthropic-ai/sdk）を、翻訳するときにだけ読み込む（dynamic import。
//   最初の画面の読み込みを重くしない）。ブラウザから直接呼ぶので dangerouslyAllowBrowser を付ける
//   （キーは利用者自身のもので、この端末にだけ保存している。useSecrets.ts）。
// - 応答は JSON（構造化出力 output_config.format）で受け取り、行番号などを確かめてから使う（行番号がずれていれば
//   何も保存しない。訳が返らなかった行だけは飛ばして、ほかの行の訳は使う）。補足に元の行がまるごと入っていたら
//   「この行」に置き換える（歌詞の本文を保存しない）。
//   モデルが構造化出力を受け付けなければ、1回だけ format なしで頼み、本文の JSON を読む。
// - Sonnet 5 / Opus 5 は effort medium（考える量を抑えて、料金を見積もりに近づける）。Haiku 4.5 には effort を送らない。
// - SDK の自動の再試行はしない（有料のリクエストを黙って送り直さない）。
// - 料金は応答の usage（トークン数）から計算して見せる（1ドル = 150円の目安）。
// ============================================================================

import type Anthropic from "@anthropic-ai/sdk";
import type { AiTranslateModel } from "../data/types";
import { lineHash } from "./lyrics";

// ---------------------------------------------------------------------------
// モデルと料金
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

/** 円の目安に使うレート（1ドル = 150円。実際の請求はドル建て） */
export const YEN_PER_USD = 150;

export interface AiCost {
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** usd × YEN_PER_USD（目安） */
  yen: number;
}

function costOf(inputUsd: number, outputUsd: number, inputTokens: number, outputTokens: number): AiCost {
  const usd = inputUsd + outputUsd;
  return { inputTokens, outputTokens, usd, yen: usd * YEN_PER_USD };
}

/**
 * 送る前の料金の見積もり（おおまか）。
 * 入力 ≈ 700 + 文字数 / 2.5 トークン、出力 ≈ 45 × 行数 + 600 トークン（Sonnet 5 / Opus 5 は出力 × 2.5。思考の分）。
 * lines は送る行（空の行は数えない）
 */
export function estimateAiCost(lines: readonly string[], model: AiTranslateModel): AiCost {
  const info = AI_MODEL_INFO[model];
  const sent = lines.map((l) => l.trim()).filter(Boolean);
  const chars = sent.reduce((n, l) => n + [...l].length, 0);
  const inputTokens = Math.ceil(700 + chars / 2.5);
  const outputTokens = Math.ceil((45 * sent.length + 600) * info.outputFactor);
  return costOf((inputTokens * info.usdPerMTokIn) / 1e6, (outputTokens * info.usdPerMTokOut) / 1e6, inputTokens, outputTokens);
}

/** 1曲あたりの目安（40行・1行30文字の曲として見積もる。設定画面の説明用） */
export function typicalSongCost(model: AiTranslateModel): AiCost {
  return estimateAiCost(Array.from({ length: 40 }, () => "x".repeat(30)), model);
}

/** 応答の usage から実際の料金を計算する（キャッシュの書き込みは入力の 1.25 倍、読み込みは 0.1 倍） */
export function costFromUsage(
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  },
  model: AiTranslateModel
): AiCost {
  const info = AI_MODEL_INFO[model];
  const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const input = n(usage.input_tokens);
  const write = n(usage.cache_creation_input_tokens);
  const read = n(usage.cache_read_input_tokens);
  const output = n(usage.output_tokens);
  const inputUsd = ((input + write * 1.25 + read * 0.1) * info.usdPerMTokIn) / 1e6;
  return costOf(inputUsd, (output * info.usdPerMTokOut) / 1e6, input + write + read, output);
}

/** 円の目安の表示（「約2.3円」「約15円」「0.1円未満」） */
export function formatYen(yen: number): string {
  if (!(yen >= 0.05)) return "0.1円未満";
  if (yen < 10) {
    const r = Math.round(yen * 10) / 10;
    return `約${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)}円`;
  }
  return `約${Math.round(yen)}円`;
}

/** ドルの表示（「$0.0132」「$0.090」） */
export function formatUsd(usd: number): string {
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// 送る行（曲の行 → 同じ行は1回・連の区切りは空文字）
// ---------------------------------------------------------------------------

export interface AiSongInput {
  /** 送る行。空文字は連（スタンザ）の区切り（続けて2つ以上は入れない・先頭と末尾には置かない） */
  lines: string[];
  /** lines と同じ長さ。各行の和訳キー（lineHash）。区切りは null */
  keys: (string | null)[];
}

/** 繰り返しの印だけの行（「(2x)」「x2」「[3x]」「(bis)」など） */
const REPEAT_MARK_RE = /^[([]?\s*(?:\d+\s*[x×]|[x×]\s*\d+)\s*[)\]]?$|^[([]\s*bis\s*[)\]]$/iu;

/** 訳すものが無い行（文字が無い「---」「...」「♪」、繰り返しの印だけの「(2x)」など） */
export function isUntranslatableLine(text: string): boolean {
  const t = text.trim();
  return !/\p{L}/u.test(t) || REPEAT_MARK_RE.test(t);
}

/**
 * 曲の行から AI に送る行を作る。同じ行（lineHash が同じ）は最初の1回だけ送り（繰り返すサビは1回分の料金で
 * 全部の箇所に出る）、空行は連の区切りとして残す（曲の構成が分かるように）。
 * 訳すものが無い行（isUntranslatableLine: 「(2x)」「---」「...」など）は送らない（繰り返しの行と同じく飛ばす。
 * 連の区切りにもしない）。送ると空の訳が返りやすく、その行だけ訳が返らなくなる。
 */
export function songLinesForAi(lines: readonly { text: string }[]): AiSongInput {
  const out: AiSongInput = { lines: [], keys: [] };
  const seen = new Set<string>();
  for (const l of lines) {
    const text = l.text.replace(/\s+/g, " ").trim();
    if (!text) {
      if (out.lines.length && out.lines[out.lines.length - 1] !== "") {
        out.lines.push("");
        out.keys.push(null);
      }
      continue;
    }
    if (isUntranslatableLine(text)) continue;
    const key = lineHash(text);
    if (seen.has(key)) continue;
    seen.add(key);
    out.lines.push(text);
    out.keys.push(key);
  }
  while (out.lines.length && out.lines[out.lines.length - 1] === "") {
    out.lines.pop();
    out.keys.pop();
  }
  return out;
}

// ---------------------------------------------------------------------------
// プロンプトと応答の形
// ---------------------------------------------------------------------------

/** 訳の補足（note）の最大の長さ（文字） */
export const AI_NOTE_MAX = 80;

const SYSTEM_PROMPT = `You are a professional literary translator of Brazilian Portuguese song lyrics into Japanese. Your reader is a Japanese learner of Brazilian Portuguese who reads your translation line by line next to the original lyrics while listening to the song.

How to translate:
- Read the whole song first. Translate every line in the context of the WHOLE song: its story, who is speaking to whom, the mood, and recurring images.
- Convey the meaning, imagery and emotion in natural Japanese, as a good published lyric translation would. Avoid word-for-word renderings that sound unnatural or unclear in Japanese, but stay faithful: never add ideas that are not in the original.
- Understand colloquial Brazilian Portuguese (tô, tá, pra, pro, cê, né, cadê, a gente, gírias), regional expressions, Afro-Brazilian and Candomblé terms, and capoeira vocabulary (roda, berimbau, camará, iê, axé, mandinga, etc.). Keep proper nouns and culture-specific terms in katakana when there is no good Japanese equivalent.
- Recognize metaphors, double meanings and wordplay, and render the intended sense.
- Keep one consistent voice (usually plain form 常体) unless the original clearly changes tone. Vocables without lexical meaning (such as "lá lá lá", "ê", "oi") may be written in katakana.

Output rules:
- Give exactly one Japanese rendering per input line, with the same index "i" as the input. Never skip, merge, split or add lines.
- When one sentence spans several lines, split the Japanese naturally across those lines so that each rendering matches its own part of the sentence (a line may read as a fragment).
- Add "note" ONLY for lines with an idiom, slang, wordplay, a cultural or capoeira reference, or a meaning different from the literal words. Write the note in Japanese, at most ${AI_NOTE_MAX} characters, explaining the meaning or background (not your translation choices). Leave "note" out for all other lines.
- In "note", never copy the whole original line; refer to it as この行 or quote only the specific word or short expression being explained (at most 3 words). "ja" must be Japanese, not the original Portuguese.
- The title and artist are context only; do not translate them.
- Never invent content that is not in the lines. If a line is unclear, give the most plausible reading.
- Respond with JSON only, no other text: {"lines":[{"i":0,"ja":"...","note":"..."}]}`;

/** 応答の JSON の形（構造化出力 output_config.format に渡す） */
export const AI_TRANSLATION_SCHEMA = {
  type: "object",
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          i: { type: "integer" },
          ja: { type: "string" },
          note: { type: "string" },
        },
        required: ["i", "ja"],
        additionalProperties: false,
      },
    },
  },
  required: ["lines"],
  additionalProperties: false,
} as const;

export interface AiPrompt {
  system: string;
  /** user のメッセージ（曲名・アーティスト名と、番号付きの行） */
  content: string;
  /** 送った行の番号（入力の lines の添字。空の行は入らない） */
  indices: number[];
}

/**
 * プロンプトを組み立てる（純関数）。行は「番号: 本文」で1行ずつ並べ、番号は入力の lines の添字のまま使う。
 * 空の行は送らず、連の区切りとして空行を1つ入れる。
 */
export function buildAiTranslatePrompt(p: { title: string; artist: string; lines: readonly string[] }): AiPrompt {
  const indices: number[] = [];
  const body: string[] = [];
  p.lines.forEach((raw, i) => {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) {
      if (body.length && body[body.length - 1] !== "") body.push("");
      return;
    }
    indices.push(i);
    body.push(`${i}: ${text}`);
  });
  while (body.length && body[body.length - 1] === "") body.pop();
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const content = [
    `Title: ${oneLine(p.title) || "(unknown)"}`,
    `Artist: ${oneLine(p.artist) || "(unknown)"}`,
    "",
    "Lyrics (index: line). Repeated lines appear only once; a blank line separates stanzas.",
    "",
    ...body,
  ].join("\n");
  return { system: SYSTEM_PROMPT, content, indices };
}

export interface AiLineResult {
  ja: string;
  note?: string;
}

/**
 * ok のとき: results = 使える訳（行番号 → 訳）、skipped = 訳が返らなかった・空だった行番号（保存せず、その行は
 * 今の訳のまま）。行番号のずれを示すもの（送っていない番号・重複・形の崩れ）は ok: false（何も保存しない）
 */
export type AiParseResult = { ok: true; results: Map<number, AiLineResult>; skipped: number[] } | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 訳の補足を AI_NOTE_MAX 文字までに切る（超えたら最後を「…」に） */
export function clampNote(note: string): string {
  const chars = [...note.replace(/\s+/g, " ").trim()];
  return chars.length > AI_NOTE_MAX ? chars.slice(0, AI_NOTE_MAX - 1).join("") + "…" : chars.join("");
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 補足（note）に元の行がまるごと入っていたら「この行」に置き換える（歌詞の本文を端末・バックアップに残さないため。
 * プロンプトでも禁じているが、念のため）。補足そのものは残す。
 * 比べるときは NFC・大文字小文字・空白の違いを無視し、行の前後の記号（. , ! ? など）は無くても一致とみなす。
 * 語の途中には一致させない。行を囲む括弧・引用符（「」『』“” ""）ごと「この行」にする。
 */
export function scrubLineFromNote(note: string, line: string): string {
  const core = line
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!core) return note;
  const body = core
    .split(" ")
    .map((w) => escapeRe(w).replace(/['’]/g, "['’]"))
    .join("\\s+");
  const re = new RegExp(
    `(?:[「『“"]\\s*)?(?<![\\p{L}\\p{M}\\p{N}])${body}(?![\\p{L}\\p{M}\\p{N}])[.,;:!?…]*(?:\\s*[」』”"])?`,
    "giu"
  );
  return note.normalize("NFC").replace(re, "「この行」");
}

/**
 * 応答の JSON（JSON.parse 済み）を確かめて、行番号 → 訳 にする。補足は空なら無し、長ければ切る。
 * sentLines（送った行。添字 = 行番号）を渡すと、補足に入った元の行を「この行」に置き換える（scrubLineFromNote）。
 * - 送っていない行番号・同じ行番号が2回・形の崩れた項目 → エラー（行がずれている恐れがあるので何も保存しない）
 * - 訳が返らなかった行・訳が空の行 → skipped（その行だけ保存しない。ほかの行の訳は使う。有料の結果を捨てない）
 * - 使える訳が1行も無い → エラー
 */
export function parseAiTranslation(json: unknown, expectedIndices: readonly number[], sentLines?: readonly string[]): AiParseResult {
  const fail = (error: string): AiParseResult => ({ ok: false, error });
  if (!isObj(json) || !Array.isArray(json.lines)) return fail("AIの応答の形が正しくありません（lines がありません）");
  const expected = new Set(expectedIndices);
  const results = new Map<number, AiLineResult>();
  const seen = new Set<number>();
  for (let n = 0; n < json.lines.length; n++) {
    const item: unknown = json.lines[n];
    if (!isObj(item) || typeof item.i !== "number" || !Number.isInteger(item.i) || typeof item.ja !== "string") {
      return fail(`AIの応答の形が正しくありません（${n + 1}番目の項目）`);
    }
    const i = item.i;
    if (!expected.has(i)) return fail(`AIの応答に、送っていない行番号 ${i} があります`);
    if (seen.has(i)) return fail(`AIの応答で、行 ${i} の訳が重複しています`);
    seen.add(i);
    const ja = item.ja.replace(/\s*\n+\s*/g, " ").trim();
    if (!ja) continue;
    const rawNote = typeof item.note === "string" ? item.note : "";
    const line = sentLines?.[i];
    const note = clampNote(line ? scrubLineFromNote(rawNote, line) : rawNote);
    results.set(i, note ? { ja, note } : { ja });
  }
  const skipped = expectedIndices.filter((i) => !results.has(i));
  if (!results.size && skipped.length) {
    const shown = skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? " ほか" : "");
    return fail(`AIの応答に、${skipped.length}行分の訳がありません（行 ${shown}）`);
  }
  return { ok: true, results, skipped };
}

/** 本文から JSON を取り出して読む（構造化出力なしで頼んだとき用。```json の囲みや前後の文を除く）。読めなければ例外 */
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

// ---------------------------------------------------------------------------
// 呼び出し（SDK）とエラー
// ---------------------------------------------------------------------------

/** messages.create だけを使う（検証では偽物を渡す。実物は @anthropic-ai/sdk の Anthropic） */
export interface MessagesClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal | null; timeout?: number; maxRetries?: number }
    ): PromiseLike<Anthropic.Message>;
  };
}

type Sdk = typeof import("@anthropic-ai/sdk").default;

/** SDK を読み込む（翻訳・接続テストのときだけ。最初の画面のバンドルに入れない）。読み込めなければ AiTranslateError */
async function loadSdk(): Promise<Sdk> {
  try {
    const mod = await import("@anthropic-ai/sdk");
    return mod.default;
  } catch {
    throw new AiTranslateError("connection", "AI翻訳の準備（読み込み）に失敗しました。通信環境を確かめて、もう一度試してください");
  }
}

export type AiErrorKind =
  | "no_key"
  | "empty"
  | "aborted"
  | "auth"
  | "permission"
  | "not_found"
  | "billing"
  | "rate_limit"
  | "bad_request"
  | "connection"
  | "server"
  | "api"
  | "refusal"
  | "max_tokens"
  | "parse"
  | "unknown";

/** AI 翻訳の失敗（message は画面に出す日本語。cost は課金されたと分かっている場合の料金） */
export class AiTranslateError extends Error {
  readonly kind: AiErrorKind;
  readonly cost: AiCost | null;
  constructor(kind: AiErrorKind, message: string, cost: AiCost | null = null) {
    super(message);
    this.name = "AiTranslateError";
    this.kind = kind;
    this.cost = cost;
  }
}

/** API のエラー本文の message（例: クレジット残高が足りない）。無ければ null */
function apiErrorDetail(e: { error?: unknown }): string | null {
  const body = e.error;
  const inner = isObj(body) && isObj(body.error) ? body.error.message : undefined;
  return typeof inner === "string" && inner.trim() ? inner.trim().slice(0, 200) : null;
}

/** SDK の型付きエラーを、画面に出す日本語のエラーにする（具体的なクラスから順に見る） */
export function classifyAiError(A: Sdk, e: unknown, signal?: AbortSignal | null): AiTranslateError {
  if (e instanceof AiTranslateError) return e;
  if (e instanceof A.APIUserAbortError || signal?.aborted) return new AiTranslateError("aborted", "中止しました");
  if (e instanceof A.AuthenticationError) {
    return new AiTranslateError("auth", "APIキーが正しくありません（無効・削除済みの可能性）。設定の「AI翻訳」でキーを確かめてください");
  }
  if (e instanceof A.PermissionDeniedError) {
    return new AiTranslateError("permission", "このAPIキーでは使えません（権限や利用地域の制限）。Anthropic Console で確かめてください");
  }
  if (e instanceof A.NotFoundError) {
    return new AiTranslateError("not_found", "このモデルはこのAPIキーでは使えません。設定の「AI翻訳」で別のモデルを選んでください");
  }
  if (e instanceof A.RateLimitError) {
    return new AiTranslateError(
      "rate_limit",
      "混み合っているか、利用の上限に達しました。少し待ってから試してください（月の上限は Anthropic Console で確かめられます）"
    );
  }
  if (e instanceof A.BadRequestError) {
    const detail = apiErrorDetail(e);
    return new AiTranslateError(
      "bad_request",
      `リクエストが受け付けられませんでした${detail ? `（${detail}）` : ""}。クレジット残高・支払い設定も Anthropic Console で確かめてください`
    );
  }
  if (e instanceof A.APIConnectionTimeoutError) {
    return new AiTranslateError("connection", "時間内に応答がありませんでした。通信環境を確かめて、もう一度試してください");
  }
  if (e instanceof A.APIConnectionError) {
    return new AiTranslateError("connection", "通信エラーです。オフラインか、接続が不安定です");
  }
  if (e instanceof A.InternalServerError) {
    return new AiTranslateError("server", "Anthropic 側で一時的なエラーが起きました（混雑など）。少し待ってから試してください");
  }
  if (e instanceof A.APIError) {
    if (e.status === 402) {
      return new AiTranslateError("billing", "支払いの問題で使えません。Anthropic Console でクレジット残高・支払い設定を確かめてください");
    }
    return new AiTranslateError("api", `AIの呼び出しに失敗しました${e.status ? `（${e.status}）` : ""}`);
  }
  return new AiTranslateError("unknown", "AI翻訳に失敗しました");
}

/** 構造化出力（output_config）をこのモデルが受け付けなかったか（そのときだけ1回、output_config なしで頼み直す） */
function isOutputConfigRejected(A: Sdk, e: unknown): boolean {
  if (!(e instanceof A.BadRequestError)) return false;
  return /output_config|output_format|format|schema/i.test(`${apiErrorDetail(e) ?? ""} ${e.message}`);
}

function firstText(res: Anthropic.Message): string | null {
  const block = res.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return block ? block.text : null;
}

export interface AiTranslateResult {
  /** 入力の lines と同じ長さ・同じ順序。空の行・訳が返らなかった行は null */
  results: (AiLineResult | null)[];
  /** 送ったのに訳が返らなかった（空だった）行の数（その行は保存しない） */
  skipped: number;
  /** 今回の料金（応答の usage から） */
  cost: AiCost;
  model: AiTranslateModel;
  /** 構造化出力を使わずに訳した（モデルが output_config を受け付けなかった） */
  usedFallback: boolean;
}

/**
 * 曲の歌詞を Claude で和訳する（ユーザーの操作からだけ呼ぶ）。
 * lines は送る行（songLinesForAi の lines。空文字は連の区切り）。失敗は AiTranslateError。
 * client は検証用（省略時は SDK を読み込んで、この apiKey でクライアントを作る）。
 */
export async function translateSongWithClaude(p: {
  apiKey: string;
  model: AiTranslateModel;
  title: string;
  artist: string;
  lines: readonly string[];
  signal?: AbortSignal;
  client?: MessagesClient;
}): Promise<AiTranslateResult> {
  const apiKey = (p.apiKey ?? "").trim();
  if (!apiKey) throw new AiTranslateError("no_key", "APIキーが設定されていません（設定の「AI翻訳」で入れてください）");
  const model = toAiModel(p.model);
  const prompt = buildAiTranslatePrompt(p);
  if (!prompt.indices.length) throw new AiTranslateError("empty", "訳す行がありません");
  const A = await loadSdk();
  if (p.signal?.aborted) throw new AiTranslateError("aborted", "中止しました");
  const client: MessagesClient = p.client ?? new A({ apiKey, dangerouslyAllowBrowser: true });
  // thinking は送らない（Haiku 4.5 は考えずに訳す。Sonnet 5 / Opus 5 は省略すると考えながら訳す）。
  // Sonnet 5 / Opus 5 の考える量は effort で抑える（既定の high だと上限がなく、料金が見積もりを大きく超えたり、
  // 長い曲で max_tokens に届いて何も保存できなかったりする）。訳の質は medium で十分。
  // Haiku 4.5 は effort を受け付けない（400）ので送らない
  const effort: Anthropic.OutputConfig | null = model === "claude-haiku-4-5" ? null : { effort: "medium" };
  const base: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: 16000,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.content }],
    ...(effort ? { output_config: effort } : {}),
  };
  // SDK の自動の再試行はしない（曲全体の有料のリクエストを黙って送り直さない。表示する料金も1回分だけ）。
  // 失敗したら画面の「再試行」で送り直す
  const opts = { signal: p.signal, maxRetries: 0 };

  let res: Anthropic.Message;
  let usedFallback = false;
  try {
    res = await client.messages.create(
      { ...base, output_config: { ...effort, format: { type: "json_schema", schema: AI_TRANSLATION_SCHEMA } } },
      opts
    );
  } catch (e) {
    if (!isOutputConfigRejected(A, e) || p.signal?.aborted) throw classifyAiError(A, e, p.signal);
    // 構造化出力を受け付けないモデル → 1回だけ、本文の JSON で頼み直す（プロンプトでも JSON だけを求めている。
    // base のまま = format だけを外し、effort は残す）
    usedFallback = true;
    try {
      res = await client.messages.create(base, opts);
    } catch (e2) {
      throw classifyAiError(A, e2, p.signal);
    }
  }

  const cost = costFromUsage(res.usage, model);
  if (res.stop_reason === "refusal") {
    throw new AiTranslateError(
      "refusal",
      "AIがこの歌詞の翻訳を断りました。設定の「AI翻訳」で別のモデルを選ぶか、無料の機械翻訳を使ってください",
      cost
    );
  }
  if (res.stop_reason === "max_tokens") {
    throw new AiTranslateError("max_tokens", "訳が長くなりすぎて途中で切れました（保存していません）。別のモデルで試してください", cost);
  }
  const text = firstText(res);
  if (text == null) throw new AiTranslateError("parse", "AIの応答に訳がありませんでした（保存していません）", cost);
  let json: unknown;
  try {
    json = parseJsonText(text);
  } catch {
    throw new AiTranslateError("parse", "AIの応答を JSON として読めませんでした（保存していません）", cost);
  }
  const parsed = parseAiTranslation(json, prompt.indices, p.lines);
  if (!parsed.ok) throw new AiTranslateError("parse", `${parsed.error}（保存していません）`, cost);
  return {
    results: p.lines.map((_, i) => parsed.results.get(i) ?? null),
    skipped: parsed.skipped.length,
    cost,
    model,
    usedFallback,
  };
}

/**
 * 接続テスト: 小さなリクエスト（max_tokens 16）でキーとモデルが使えるか確かめる。
 * 成功すれば今回の料金（ごくわずか）を返す。失敗は AiTranslateError（キーが正しくない、など）。
 */
export async function testClaudeConnection(p: {
  apiKey: string;
  model: AiTranslateModel;
  signal?: AbortSignal;
  client?: MessagesClient;
}): Promise<{ cost: AiCost; model: AiTranslateModel }> {
  const apiKey = (p.apiKey ?? "").trim();
  if (!apiKey) throw new AiTranslateError("no_key", "APIキーが設定されていません");
  const model = toAiModel(p.model);
  const A = await loadSdk();
  const client: MessagesClient = p.client ?? new A({ apiKey, dangerouslyAllowBrowser: true });
  try {
    const res = await client.messages.create(
      { model, max_tokens: 16, messages: [{ role: "user", content: "Reply with OK." }] },
      { signal: p.signal, timeout: 30_000 }
    );
    return { cost: costFromUsage(res.usage, model), model };
  } catch (e) {
    throw classifyAiError(A, e, p.signal);
  }
}
