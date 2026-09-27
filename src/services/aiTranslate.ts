// ============================================================================
// 歌詞の AI 翻訳（利用者自身の API キーで、任意・オプトイン）。既定は Gemini（無料枠）、Claude（有料）も選べる
//   検証: scripts/check-translate.ts（npm run check:translate）・scripts/check-ai.ts（npm run check:ai）。
//   どちらも偽のクライアントで動かし、実際には通信しない
// - 無料の機械翻訳（translate.ts）とは別の経路。キーが無ければ何も起きない（画面にボタンも出さない）。
// - 送るもの: 曲名・アーティスト名・歌詞の行（空でない行。同じ行は1回だけ）。ユーザーが「AIで訳す」を
//   押して確認したときだけ送る。結果は行のハッシュをキーに端末へ保存する（歌詞の本文は保存しない。useMusic）。
// - 呼び出しはサービス（services/ai。Gemini / Claude）の generateJson に任せる（SDK はそちらが呼ぶときだけ読み込む）。
//   ここはプロンプト・応答の検査・料金（Claude）だけを受け持つ。
// - 応答は JSON（スキーマ付き）で受け取り、行番号などを確かめてから使う（行番号がずれていれば
//   何も保存しない。訳が返らなかった行だけは飛ばして、ほかの行の訳は使う）。補足に元の行がまるごと入っていたら
//   「この行」に置き換える（歌詞の本文を保存しない）。
// - Claude の料金は応答の usage（トークン数）から計算して見せる（1ドル = 150円の目安）。Gemini は無料枠なので出さない。
// ============================================================================

import type { AiTranslateModel } from "../data/types";
import { lineHash } from "./lyrics";
import { AI_MODEL_INFO, createClaudeProvider, toAiModel, type MessagesClient } from "./ai/claude";
import { AiError, type AiProvider, type AiProviderId, type AiUsage, type GenerateJsonResult } from "./ai/types";

// ---------------------------------------------------------------------------
// モデルと料金（Claude のモデルの一覧は services/ai/claude.ts。以前の名前のまま使えるようにここからも出す）
// ---------------------------------------------------------------------------

export { AI_MODELS, AI_MODEL_INFO, DEFAULT_AI_MODEL, toAiModel, type AiModelInfo, type MessagesClient } from "./ai/claude";
export { parseJsonText } from "./ai/types";

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

/** 応答の JSON の形（Claude は構造化出力 output_config.format、Gemini は responseJsonSchema に渡す） */
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

// ---------------------------------------------------------------------------
// 料金（Claude）。Gemini は無料枠なので null
// ---------------------------------------------------------------------------

/** 共通の usage から今回の料金を出す（Claude だけ。Gemini の無料枠は null = 料金を出さない） */
export function aiCostOf(provider: AiProviderId, model: string, usage: AiUsage | null | undefined): AiCost | null {
  if (provider !== "claude") return null;
  return costFromUsage(
    {
      input_tokens: usage?.input ?? 0,
      output_tokens: usage?.output ?? 0,
      cache_creation_input_tokens: usage?.cacheWrite ?? 0,
      cache_read_input_tokens: usage?.cacheRead ?? 0,
    },
    toAiModel(model)
  );
}

// ---------------------------------------------------------------------------
// 呼び出し（今使うサービスの generateJson）
// ---------------------------------------------------------------------------

export interface AiSongTranslation {
  /** 入力の lines と同じ長さ・同じ順序。空の行・訳が返らなかった行は null */
  results: (AiLineResult | null)[];
  /** 送ったのに訳が返らなかった（空だった）行の数（その行は保存しない） */
  skipped: number;
  /** 今回の料金（Claude。応答の usage から）。Gemini の無料枠は null */
  cost: AiCost | null;
  provider: AiProviderId;
  /** 答えたモデル */
  model: string;
  /** 設定のモデルが上限だったので別のモデルで訳したとき、元のモデル（Gemini の 3.8 Flash → 3.5 Flash-Lite） */
  fallbackFrom: string | null;
  /** 構造化出力を使わずに訳した（Claude。モデルが output_config を受け付けなかった） */
  usedFallback: boolean;
}

/** 翻訳の失敗の文（断られた・切れた・形が崩れた応答は、翻訳の言葉で言い直す。種類・usage はそのまま） */
function translationError(e: AiError): AiError {
  const extra = { code: e.code, usage: e.usage, model: e.model };
  if (e.kind === "refusal") {
    const why =
      e.code === "RECITATION" ? "AIが歌詞の翻訳を途中で止めました（歌詞の文章をそのまま書くのを避けるため）" : "AIがこの歌詞の翻訳を断りました";
    return new AiError("refusal", `${why}。設定の「🤖 AI」で別のモデルを選ぶか、無料の機械翻訳を使ってください`, extra);
  }
  if (e.kind === "truncated") {
    return new AiError("truncated", "訳が長くなりすぎて途中で切れました（保存していません）。別のモデルで試してください", extra);
  }
  if (e.kind === "bad-response") return new AiError("bad-response", `${e.message}（保存していません）`, extra);
  return e;
}

/**
 * 曲の歌詞を今使うサービス（Gemini / Claude）で和訳する（ユーザーの操作からだけ呼ぶ）。
 * lines は送る行（songLinesForAi の lines。空文字は連の区切り）。provider が null（キーが無い）なら no-key。
 * 失敗は AiError（kind で種類。料金が分かるときは usage・model を持つ → aiCostOf）
 */
export async function translateSongWithAi(p: {
  provider: AiProvider | null;
  title: string;
  artist: string;
  lines: readonly string[];
  signal?: AbortSignal;
}): Promise<AiSongTranslation> {
  if (!p.provider) {
    throw new AiError("no-key", "APIキーが設定されていません（設定の「🤖 AI」で Gemini か Claude のキーを入れてください）", {
      code: "no_key",
    });
  }
  const provider = p.provider;
  const prompt = buildAiTranslatePrompt(p);
  if (!prompt.indices.length) throw new AiError("unknown", "訳す行がありません", { code: "empty" });
  let r: GenerateJsonResult;
  try {
    r = await provider.generateJson({ system: prompt.system, user: prompt.content, schema: AI_TRANSLATION_SCHEMA, signal: p.signal });
  } catch (e) {
    throw translationError(e instanceof AiError ? e : new AiError("unknown", "AI翻訳に失敗しました", { code: "unknown" }));
  }
  const parsed = parseAiTranslation(r.json, prompt.indices, p.lines);
  if (!parsed.ok) throw new AiError("bad-response", `${parsed.error}（保存していません）`, { code: "parse", usage: r.usage, model: r.model });
  return {
    results: p.lines.map((_, i) => parsed.results.get(i) ?? null),
    skipped: parsed.skipped.length,
    cost: aiCostOf(provider.id, r.model, r.usage),
    provider: provider.id,
    model: r.model,
    fallbackFrom: r.fallbackFrom ?? null,
    usedFallback: r.formatFallback === true,
  };
}

// ---------------------------------------------------------------------------
// 以前の呼び出し口（Claude だけ。検証 check-translate.ts が使う。中身は上の translateSongWithAi と同じ経路）
// ---------------------------------------------------------------------------

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

const LEGACY_KINDS: readonly AiErrorKind[] = [
  "no_key",
  "empty",
  "aborted",
  "auth",
  "permission",
  "not_found",
  "billing",
  "rate_limit",
  "bad_request",
  "connection",
  "server",
  "api",
  "refusal",
  "max_tokens",
  "parse",
  "unknown",
];

/** AI 翻訳（Claude）の失敗（message は画面に出す日本語。cost は課金されたと分かっている場合の料金） */
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

const LEGACY_KIND_OF: Record<AiError["kind"], AiErrorKind> = {
  "no-key": "no_key",
  auth: "auth",
  "rate-limit": "rate_limit",
  quota: "billing",
  network: "connection",
  offline: "connection",
  refusal: "refusal",
  truncated: "max_tokens",
  "bad-response": "parse",
  aborted: "aborted",
  server: "server",
  unknown: "unknown",
};

/** 共通の AiError を以前の AiTranslateError にする（Claude のサービスは code に以前の kind を入れている） */
function toLegacyError(e: unknown, model: AiTranslateModel): AiTranslateError {
  if (e instanceof AiTranslateError) return e;
  if (!(e instanceof AiError)) return new AiTranslateError("unknown", "AI翻訳に失敗しました");
  const kind = LEGACY_KINDS.includes(e.code as AiErrorKind) ? (e.code as AiErrorKind) : LEGACY_KIND_OF[e.kind];
  return new AiTranslateError(kind, e.message, e.usage ? aiCostOf("claude", model, e.usage) : null);
}

const ZERO_USAGE = { input_tokens: 0, output_tokens: 0 };

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
 * 曲の歌詞を Claude で和訳する（以前の呼び出し口。画面は translateSongWithAi を使う）。
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
  if (!apiKey) throw new AiTranslateError("no_key", "APIキーが設定されていません（設定の「🤖 AI」で入れてください）");
  const model = toAiModel(p.model);
  try {
    const r = await translateSongWithAi({
      provider: createClaudeProvider({ apiKey, model, client: p.client }),
      title: p.title,
      artist: p.artist,
      lines: p.lines,
      signal: p.signal,
    });
    return { results: r.results, skipped: r.skipped, cost: r.cost ?? costFromUsage(ZERO_USAGE, model), model, usedFallback: r.usedFallback };
  } catch (e) {
    throw toLegacyError(e, model);
  }
}

/**
 * 接続テスト（以前の呼び出し口。Claude だけ）: 小さなリクエスト（max_tokens 16）でキーとモデルが使えるか確かめる。
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
  try {
    const r = await createClaudeProvider({ apiKey, model, client: p.client }).testConnection({ signal: p.signal });
    return { cost: aiCostOf("claude", model, r.usage) ?? costFromUsage(ZERO_USAGE, model), model };
  } catch (e) {
    throw toLegacyError(e, model);
  }
}
