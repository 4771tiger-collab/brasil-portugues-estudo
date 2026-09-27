// ============================================================================
// AI（Gemini / Claude）のサービスの回帰テスト
//   npm run check:ai
// - services/ai/index.ts: 使うサービスの選び方（設定・キー。選んだ方にキーが無ければキーがある方）
// - services/ai/gemini.ts: 会話（ストリーミング）・JSON・接続テスト・3.8 Flash → 3.5 Flash-Lite の1回だけの頼み直し・
//   エラーの対応（キー・回数の上限・1日の上限・通信・中止）・止まった理由（安全・引用・長すぎ）。
//   偽のクライアントに加えて、実物の SDK（@google/genai）を偽の fetch（httpOptions.fetch）で動かし、
//   SDK が自動で送り直さないこと・キーを URL に入れずヘッダーで送ることも確かめる
// - services/ai/claude.ts: 以前の歌詞の AI 翻訳と同じ送り方（maxRetries 0・構造化出力と頼み直し・effort・stop_reason）を
//   共通の呼び出し口で。会話は messages.stream ＋ finalMessage（偽のストリーム）
// - aiTranslate.ts の translateSongWithAi: どちらのサービスでも同じ検査で訳を返す（Gemini は料金 null）
// - useSecrets: Gemini のキーも bp-secrets-v1 にだけ保存し、バックアップの書き出しに入らない
// - 🧑‍🏫 AI 先生: 文脈（teacherContext）・プロンプト（役割の決まり・学習者のようす・文脈・送る会話は 20 発言まで）・
//   返事の書式（🇧🇷/🇯🇵 の例文・箇条書き・太字・HTML は文字のまま）・会話の履歴（30件 × 100発言・並び・保存データの読み直し）・
//   送受信（偽のサービスで: 少しずつ届く返事・停止・失敗・再試行・消した会話）・会話はバックアップに入らない
// - アプリを2つ開いているとき: 別の窓が書き換えた会話の履歴・キーを読み直し、消したものを書き戻さない
// - ソースの見張り: SDK を静的に import しない（最初の画面のバンドルに入れない）・HTML として差し込まない
// ここでは globalThis.fetch を「呼ばれたら失敗」に差し替え、実際には一度も通信しないことを確かめる。
// 例はすべてこの検証のために作った短いポルトガル語の文（歌詞は使わない）。1件でも失敗したら終了コード1。
// ============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ApiError, GoogleGenAI, type GenerateContentParameters } from "@google/genai";
import {
  AI_PROVIDERS,
  AiError,
  activeProviderId,
  aiModelLabel,
  createProvider,
  getProvider,
  normalizeTurns,
  parseJsonText,
  scrubSecret,
  toAiProviderId,
  type AiProvider,
  type ChatTurn,
} from "../src/services/ai";
import {
  DEFAULT_GEMINI_MODEL,
  GEMINI_FALLBACK_MODEL,
  GEMINI_MODELS,
  classifyGeminiError,
  createGeminiProvider,
  geminiSdkOptions,
  geminiText,
  readGeminiErrorBody,
  toGeminiModel,
  type GeminiClient,
  type GeminiResponseLike,
} from "../src/services/ai/gemini";
import { createClaudeProvider, type ClaudeStreamLike, type MessagesClient } from "../src/services/ai/claude";
import { AI_TRANSLATION_SCHEMA, aiCostOf, costFromUsage, translateSongWithAi } from "../src/services/aiTranslate";
import {
  abortTeacherRun,
  clip,
  closeTeacher,
  generalContext,
  openTeacher,
  patternContext,
  readTeacherContext,
  screenNameFor,
  sentenceContext,
  songLineContext,
  songWordContext,
  useTeacherUi,
  wordContext,
} from "../src/services/ai/teacherContext";
import { MAX_TURNS, QUICK_QUESTIONS, TEACHER_RULES, buildTeacherSystem, buildTurns, contextBlock, learnerProfile, type TeacherProfile } from "../src/services/ai/teacherPrompt";
import { parseInline, parseTeacherText, plainText } from "../src/services/ai/format";
import type { StreamChatOptions, StreamChatResult } from "../src/services/ai/types";
import type { SrsCard } from "../src/data/types";

let fail = 0;
let pass = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.error(`  ✗ ${label}\n      期待: ${e}\n      実際: ${a}`);
  }
}
function ok(cond: boolean, label: string) {
  eq(cond, true, label);
}
async function aiError(fn: () => Promise<unknown>): Promise<AiError | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof AiError ? e : null;
  }
}

// ここから先は fetch を「呼ばれたら失敗」に差し替える（実物の SDK の検証も、偽の fetch を SDK に直接渡す）
const savedFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("検証中は通信しない");
}) as typeof fetch;

const GKEY = "AIzaTEST-FAKE-GEMINI-KEY-for-checks-000000";
const CKEY = "sk-ant-test-FAKE-KEY-for-checks-0000";

// ストア（useSecrets）はメモリ上の localStorage で動かす。作られる前に置く（下で dynamic import する）。
// 以前の版の保存データ（Anthropic のキーだけ）を入れておき、そのまま読めることを後で確かめる
const mem = new Map<string, string>();
const memStorage = {
  get length() {
    return mem.size;
  },
  key: (i: number) => [...mem.keys()][i] ?? null,
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: memStorage, configurable: true, writable: true });
mem.set("bp-secrets-v1", JSON.stringify({ state: { anthropicApiKey: CKEY }, version: 0 }));
const { keyFor, looksLikeGeminiKey, maskApiKey, normalizeApiKey, useSecrets } = await import("../src/store/useSecrets");
const SYSTEM = "Você é um professor paciente de português brasileiro.";

// ---------------------------------------------------------------------------
console.log("=== 使うサービスの選び方（activeProviderId / getProvider） ===");
{
  const both = { geminiApiKey: GKEY, anthropicApiKey: CKEY };
  const onlyG = { geminiApiKey: GKEY, anthropicApiKey: null };
  const onlyC = { geminiApiKey: null, anthropicApiKey: CKEY };
  const none = { geminiApiKey: null, anthropicApiKey: null };
  eq(activeProviderId({}, both), "gemini", "設定が無い → 既定の Gemini");
  eq(activeProviderId({ aiProvider: "gemini" }, both), "gemini", "Gemini を選び、両方のキーあり → Gemini");
  eq(activeProviderId({ aiProvider: "claude" }, both), "claude", "Claude を選び、両方のキーあり → Claude");
  eq(activeProviderId({ aiProvider: "gemini" }, onlyC), "claude", "Gemini を選んだがキーは Claude だけ → Claude");
  eq(activeProviderId({ aiProvider: "claude" }, onlyG), "gemini", "Claude を選んだがキーは Gemini だけ → Gemini");
  eq(activeProviderId({ aiProvider: "claude" }, none), null, "どちらのキーも無い → null");
  eq(activeProviderId({ aiProvider: "gemini" }, { geminiApiKey: "   ", anthropicApiKey: null }), null, "空白だけのキーは無いのと同じ");
  eq(activeProviderId({ aiProvider: "openai" }, both), "gemini", "知らないサービス → 既定の Gemini");
  eq([toAiProviderId("claude"), toAiProviderId(undefined), toAiProviderId(3)], ["claude", "gemini", "gemini"], "toAiProviderId");
  eq(AI_PROVIDERS, ["gemini", "claude"], "サービスの一覧（Gemini が先）");

  const g = getProvider({ aiProvider: "gemini", geminiModel: "gemini-3.5-flash-lite" }, both);
  eq([g?.id, g?.name, g?.model, g?.free], ["gemini", "Gemini", "gemini-3.5-flash-lite", true], "getProvider: Gemini（設定のモデル・無料）");
  const c = getProvider({ aiProvider: "claude", aiTranslateModel: "claude-sonnet-5" }, both);
  eq([c?.id, c?.name, c?.model, c?.free], ["claude", "Claude", "claude-sonnet-5", false], "getProvider: Claude（aiTranslateModel・有料）");
  eq(getProvider({}, none), null, "getProvider: キーが無い → null");
  eq(getProvider({ geminiModel: "gemini-9" }, onlyG)?.model, "gemini-3.8-flash", "知らない Gemini のモデル → 既定の 3.8 Flash");
  eq(createProvider("claude", {}, onlyG).model, "claude-haiku-4-5", "createProvider: Claude のモデルの既定は Haiku 4.5");
  eq([DEFAULT_GEMINI_MODEL, GEMINI_FALLBACK_MODEL, GEMINI_MODELS], ["gemini-3.8-flash", "gemini-3.5-flash-lite", ["gemini-3.8-flash", "gemini-3.5-flash-lite"]], "Gemini のモデル ID");
  eq([toGeminiModel("gemini-3.5-flash-lite"), toGeminiModel("gemini-3.1-flash-lite"), toGeminiModel(null)], ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.8-flash"], "toGeminiModel");
  eq(
    [aiModelLabel("gemini-3.8-flash"), aiModelLabel("gemini-3.5-flash-lite"), aiModelLabel("claude-haiku-4-5"), aiModelLabel("x-model")],
    ["Gemini 3.8 Flash", "Gemini 3.5 Flash-Lite", "Claude Haiku 4.5", "x-model"],
    "aiModelLabel"
  );
  eq([keyFor("gemini", both), keyFor("claude", both)], [GKEY, CKEY], "keyFor: サービスごとのキー");
}

console.log("=== normalizeTurns / parseJsonText / scrubSecret ===");
{
  const turns: ChatTurn[] = [
    { role: "assistant", text: "Olá! Pode perguntar." },
    { role: "user", text: " O que quer dizer  'saudade'? " },
    { role: "user", text: "E como uso numa frase?" },
    { role: "assistant", text: "" },
    { role: "assistant", text: "Saudade é sentir falta." },
    { role: "user", text: "Obrigado!" },
  ];
  eq(
    normalizeTurns(turns),
    [
      { role: "user", text: "O que quer dizer  'saudade'?\n\nE como uso numa frase?" },
      { role: "assistant", text: "Saudade é sentir falta." },
      { role: "user", text: "Obrigado!" },
    ],
    "先頭の assistant を除き、空の発言を除き、同じ役割が続けばまとめる"
  );
  eq(normalizeTurns([{ role: "user", text: "Oi" }, { role: "assistant", text: "Oi!" }]), [], "最後が user でなければ空（送れない）");
  eq(normalizeTurns([]), [], "空 → 空");
  eq(parseJsonText('```json\n{"a":1}\n```'), { a: 1 }, "parseJsonText: ```json の囲み");
  eq(scrubSecret(`erro com a chave ${GKEY} aqui`, GKEY), "erro com a chave （キー） aqui", "scrubSecret: キーを伏せる");
  eq(scrubSecret("sem chave", GKEY), "sem chave", "scrubSecret: キーが無ければそのまま");
}

// ---------------------------------------------------------------------------
// Gemini（偽のクライアント）
// ---------------------------------------------------------------------------

type GStep = GeminiResponseLike | GeminiResponseLike[] | Error | { chunks: GeminiResponseLike[]; thenThrow: Error };
type GCall = { kind: "json" | "stream"; model: string; params: GenerateContentParameters; signal: AbortSignal | undefined };

/** 偽の Gemini クライアント。steps を順に返す（Error なら投げる。配列はストリームの chunk） */
function fakeGemini(steps: GStep[]): { client: GeminiClient; calls: GCall[] } {
  const calls: GCall[] = [];
  const record = (kind: GCall["kind"], params: GenerateContentParameters) => {
    const signal = params.config?.abortSignal;
    const { abortSignal: _drop, ...config } = params.config ?? {};
    calls.push({ kind, model: params.model, params: JSON.parse(JSON.stringify({ ...params, config })), signal });
  };
  const client: GeminiClient = {
    models: {
      generateContent: async (params) => {
        record("json", params);
        const s = steps.shift();
        if (!s) throw new Error("偽のクライアント: 応答がもうありません");
        if (s instanceof Error) throw s;
        if (Array.isArray(s) || "chunks" in s) throw new Error("偽のクライアント: ストリームの応答を generateContent に渡した");
        return s;
      },
      generateContentStream: async (params) => {
        record("stream", params);
        const s = steps.shift();
        if (!s) throw new Error("偽のクライアント: 応答がもうありません");
        if (s instanceof Error) throw s;
        const chunks = Array.isArray(s) ? s : "chunks" in s ? s.chunks : [s];
        const thenThrow = !Array.isArray(s) && "thenThrow" in s ? s.thenThrow : null;
        return (async function* () {
          for (const c of chunks) yield c;
          if (thenThrow) throw thenThrow;
        })();
      },
    },
  };
  return { client, calls };
}

const gText = (text: string, finishReason = "STOP", extra: Partial<GeminiResponseLike> = {}): GeminiResponseLike => ({
  candidates: [{ content: { parts: [{ text }] }, finishReason }],
  ...extra,
});
const gErr = (status: number, body: unknown) => new ApiError({ message: JSON.stringify(body), status });
const quota429 = (quotaId: string | null, extra: Record<string, unknown>[] = []) =>
  gErr(429, {
    error: {
      code: 429,
      message: "You exceeded your current quota. Quota exceeded for metric: generate_content_free_tier_requests, limit: 10",
      status: "RESOURCE_EXHAUSTED",
      details: [...(quotaId ? [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId }] }] : []), ...extra],
    },
  });
const perMinute429 = () => quota429("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "37s" }]);
const perDay429 = () => quota429("GenerateRequestsPerDayPerProjectPerModel-FreeTier");
const badKey = () =>
  gErr(400, {
    error: {
      code: 400,
      message: "API key not valid. Please pass a valid API key.",
      status: "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
    },
  });

const SCHEMA = {
  type: "object",
  properties: { frases: { type: "array", items: { type: "string" } } },
  required: ["frases"],
  additionalProperties: false,
};

console.log("=== Gemini: streamChat（会話・偽のクライアント） ===");
{
  const ctrl = new AbortController();
  const { client, calls } = fakeGemini([
    [
      { candidates: [{ content: { parts: [{ text: "pensando…", thought: true }, { text: "Saudade é " }] } }] },
      { candidates: [{ content: { parts: [{ text: "sentir falta." }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8, thoughtsTokenCount: 5 } },
    ],
  ]);
  const p = createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client });
  const deltas: string[] = [];
  const r = await p.streamChat({
    system: SYSTEM,
    turns: [
      { role: "user", text: "O que é saudade?" },
      { role: "assistant", text: "É um sentimento." },
      { role: "user", text: "Explique mais." },
    ],
    signal: ctrl.signal,
    onText: (d) => deltas.push(d),
  });
  eq(deltas, ["Saudade é ", "sentir falta."], "返事を少しずつ渡す（考えた過程 thought は渡さない）");
  eq([r.text, r.model, r.fallbackFrom], ["Saudade é sentir falta.", "gemini-3.8-flash", undefined], "全文・答えたモデル");
  eq(r.usage, { input: 40, output: 13 }, "usage（出力は考えた分も含む）");
  eq(calls.length, 1, "1回だけ呼ぶ");
  const params = calls[0].params;
  eq(params.model, "gemini-3.8-flash", "送る: モデル ID");
  eq(
    params.contents,
    [
      { role: "user", parts: [{ text: "O que é saudade?" }] },
      { role: "model", parts: [{ text: "É um sentimento." }] },
      { role: "user", parts: [{ text: "Explique mais." }] },
    ],
    "送る: 会話（assistant は role model）"
  );
  eq(params.config?.systemInstruction, SYSTEM, "送る: システムプロンプトは config.systemInstruction");
  ok(calls[0].signal === ctrl.signal, "中止の signal を config.abortSignal で渡す");
  ok(!JSON.stringify(params).includes(GKEY), "リクエストにキーは入らない（SDK がヘッダーで送る）");

  const e = await aiError(() => p.streamChat({ system: SYSTEM, turns: [{ role: "assistant", text: "Oi" }], onText: () => {} }));
  eq([e?.kind, e?.code], ["unknown", "empty"], "送る質問が無い → 呼ばない");
}

console.log("=== Gemini: 3.8 Flash が上限（429）→ 1回だけ 3.5 Flash-Lite で頼み直す ===");
{
  // JSON
  {
    const { client, calls } = fakeGemini([perMinute429(), gText('{"frases":["Eu tô com fome."]}')]);
    const p = createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client });
    const r = await p.generateJson({ system: SYSTEM, user: "Dê um exemplo.", schema: SCHEMA });
    eq(calls.map((c) => c.model), ["gemini-3.8-flash", "gemini-3.5-flash-lite"], "429 → 3.5 Flash-Lite で1回だけ頼み直す");
    eq([r.model, r.fallbackFrom, r.json], ["gemini-3.5-flash-lite", "gemini-3.8-flash", { frases: ["Eu tô com fome."] }], "答えたモデルと元のモデルが分かる");
    eq(calls[1].params.config, calls[0].params.config, "頼み直しも同じ中身（モデルだけ替える）");
  }
  // 1日の上限（PerDay）でも、モデルごとに上限は別なので頼み直す
  {
    const { client, calls } = fakeGemini([perDay429(), gText('{"frases":[]}')]);
    const r = await createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA });
    eq([calls.length, r.model], [2, "gemini-3.5-flash-lite"], "1日の上限（429）でも頼み直す");
  }
  // 会話（返事が届く前の 429）
  {
    const { client, calls } = fakeGemini([perMinute429(), [gText("Claro! ")]]);
    const deltas: string[] = [];
    const r = await createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).streamChat({
      system: SYSTEM,
      turns: [{ role: "user", text: "Pode me ajudar?" }],
      onText: (d) => deltas.push(d),
    });
    eq([calls.map((c) => c.model), r.model, r.fallbackFrom, deltas], [["gemini-3.8-flash", "gemini-3.5-flash-lite"], "gemini-3.5-flash-lite", "gemini-3.8-flash", ["Claro! "]], "会話: 返事の前の 429 → 3.5 Flash-Lite");
  }
  // 返事が届き始めた後の 429 は頼み直さない（同じ返事が2回出ないように）
  {
    const { client, calls } = fakeGemini([{ chunks: [gText("Vamos ", "")], thenThrow: perMinute429() }]);
    const e = await aiError(() =>
      createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).streamChat({ system: SYSTEM, turns: [{ role: "user", text: "Oi" }], onText: () => {} })
    );
    eq([calls.length, e?.kind, e?.partialText], [1, "rate-limit", "Vamos "], "返事の途中の 429 → 頼み直さず、途中までの返事を持つ");
  }
  // 頼み直しも上限 → 選んだモデル（3.8 Flash）のエラー（3回目はない。3.5 Flash-Lite の案内で上書きしない）
  {
    const { client, calls } = fakeGemini([perMinute429(), perDay429()]);
    const e = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
    eq([calls.length, e?.kind, e?.model], [2, "rate-limit", "gemini-3.8-flash"], "1分あたり → 頼み直しは1日の上限: 選んだモデルの「1分あたり」（2回で終わり）");
    ok(!!e?.message.includes("1分あたり") && !e?.message.includes("明日"), "選んだモデルは約1分で戻る → 「明日また」と言わない");
  }
  {
    const limit0 = gErr(429, { error: { code: 429, message: "Quota exceeded for metric: x, limit: 0", status: "RESOURCE_EXHAUSTED" } });
    const { client, calls } = fakeGemini([perMinute429(), limit0]);
    const e = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
    eq([calls.length, e?.kind, e?.model], [2, "rate-limit", "gemini-3.8-flash"], "1分あたり → 頼み直しは上限 0: 選んだモデルの「1分あたり」");
    ok(!!e && !e.message.includes("上限が 0") && !e.message.includes("別のモデル"), "3.5 Flash-Lite の「上限が 0・別のモデルを」を出さない（それを選ぶと毎回失敗する）");
  }
  {
    const { client } = fakeGemini([perDay429(), perDay429()]);
    const e = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
    eq([e?.kind, e?.model], ["quota", "gemini-3.8-flash"], "どちらも1日の上限 → 選んだモデルの「今日の上限」");
    ok(!!e?.message.includes("今日の上限") && !!e?.message.includes("明日"), "1日の上限: 「今日の上限・明日また」");
  }
  {
    const { client } = fakeGemini([perDay429(), perMinute429()]);
    const e = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
    eq([e?.kind, e?.model], ["rate-limit", "gemini-3.5-flash-lite"], "1日の上限 → 頼み直しは1分あたり: すぐ戻る 3.5 Flash-Lite の「1分あたり」");
  }
  {
    const { client } = fakeGemini([perMinute429(), badKey()]);
    const e = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
    eq([e?.kind, e?.model], ["auth", "gemini-3.5-flash-lite"], "頼み直しが上限以外で失敗 → そのエラー（失敗したモデル付き）");
  }
  // 3.5 Flash-Lite を選んでいれば頼み直さない
  {
    const { client, calls } = fakeGemini([perMinute429()]);
    const e = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.5-flash-lite", client }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
    eq([calls.length, e?.kind, e?.model], [1, "rate-limit", "gemini-3.5-flash-lite"], "3.5 Flash-Lite で 429 → 頼み直さない（失敗したモデル付き）");
  }
  // 頼み直した 3.5 Flash-Lite の返事の途中で停止 → 途中までの返事は 3.5 Flash-Lite のもの
  {
    const ctrl = new AbortController();
    const { client } = fakeGemini([perMinute429(), [gText("Parte ", ""), gText("resto", "STOP")]]);
    const e = await aiError(() =>
      createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).streamChat({
        system: SYSTEM,
        turns: [{ role: "user", text: "Oi" }],
        signal: ctrl.signal,
        onText: () => ctrl.abort(),
      })
    );
    eq([e?.kind, e?.partialText, e?.model], ["aborted", "Parte ", "gemini-3.5-flash-lite"], "頼み直しの途中で停止 → 答えていたモデル（3.5 Flash-Lite）と途中までの返事");
  }
  // 上限以外のエラーは頼み直さない
  for (const [name, err] of [["キーの誤り", badKey()], ["503", gErr(503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } })]] as const) {
    const { client, calls } = fakeGemini([err, gText("{}")]);
    await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
    eq(calls.length, 1, `${name} → 頼み直さない`);
  }
}

console.log("=== Gemini: generateJson（JSON・スキーマ） ===");
{
  const ctrl = new AbortController();
  const { client, calls } = fakeGemini([gText('```json\n{"frases":["A gente vai pra roda."]}\n```', "STOP", { usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12 } })]);
  const r = await createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).generateJson({ system: SYSTEM, user: "Exemplos, por favor.", schema: SCHEMA, signal: ctrl.signal });
  eq([r.json, r.model, r.usage], [{ frases: ["A gente vai pra roda."] }, "gemini-3.8-flash", { input: 30, output: 12 }], "応答の JSON を読む（```json の囲みも）");
  const cfg = calls[0].params.config;
  eq([cfg?.responseMimeType, cfg?.responseJsonSchema, cfg?.systemInstruction], ["application/json", SCHEMA, SYSTEM], "送る: responseMimeType application/json・responseJsonSchema・systemInstruction");
  eq(calls[0].params.contents, [{ role: "user", parts: [{ text: "Exemplos, por favor." }] }], "送る: user のメッセージ1つ");
  ok(calls[0].signal === ctrl.signal, "中止の signal を渡す");
  const { client: c2 } = fakeGemini([gText("não é json")]);
  const e2 = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client: c2 }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
  eq([e2?.kind, e2?.code], ["bad-response", "parse"], "JSON でない本文 → bad-response");
}

console.log("=== Gemini: 止まった理由（finishReason / blockReason） ===");
{
  const cases: [string, GeminiResponseLike, string, string][] = [
    ["SAFETY", gText("", "SAFETY"), "refusal", "SAFETY"],
    ["RECITATION", gText("Parte", "RECITATION"), "refusal", "RECITATION"],
    ["PROHIBITED_CONTENT", gText("", "PROHIBITED_CONTENT"), "refusal", "PROHIBITED_CONTENT"],
    ["blockReason", { promptFeedback: { blockReason: "SAFETY" } }, "refusal", "SAFETY"],
    ["MAX_TOKENS", gText('{"frases":["a', "MAX_TOKENS"), "truncated", "MAX_TOKENS"],
    ["空の応答", gText("", "STOP"), "bad-response", "STOP"],
    ["候補なし", {}, "bad-response", "EMPTY"],
  ];
  for (const [name, res, kind, code] of cases) {
    const { client } = fakeGemini([res]);
    const e = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
    eq([e?.kind, e?.code], [kind, code], `JSON: ${name} → ${kind}`);
    ok(e?.partialText === undefined, `JSON: ${name} → 途中の本文を持たない`);
  }
  const { client } = fakeGemini([[gText("Uma parte ", ""), gText("e outra", "RECITATION")]]);
  const e = await aiError(() =>
    createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).streamChat({ system: SYSTEM, turns: [{ role: "user", text: "x" }], onText: () => {} })
  );
  eq([e?.kind, e?.code, e?.partialText], ["refusal", "RECITATION", "Uma parte e outra"], "会話: RECITATION → refusal（途中までの返事を持つ）");
  ok(!!e?.message.includes("歌詞"), "RECITATION: 歌詞などの文章をそのまま書くのを避けた、と伝える");
  const { client: c3 } = fakeGemini([[gText("Tudo certo.", "OTHER")]]);
  const r3 = await createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client: c3 }).streamChat({ system: SYSTEM, turns: [{ role: "user", text: "x" }], onText: () => {} });
  eq(r3.text, "Tudo certo.", "会話: finishReason OTHER でも本文があれば使う");
  eq(geminiText({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b", thought: true }, { text: "c" }] } }] }), "ac", "geminiText: thought を除いてつなぐ");
}

console.log("=== Gemini: エラーの対応（classifyGeminiError） ===");
{
  const abortErr = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  const timeoutErr = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
  const cases: [string, unknown, string][] = [
    ["400 API_KEY_INVALID", badKey(), "auth"],
    ["401", gErr(401, { error: { code: 401, message: "unauthenticated", status: "UNAUTHENTICATED" } }), "auth"],
    ["403", gErr(403, { error: { code: 403, message: "Requests from this referer are blocked.", status: "PERMISSION_DENIED" } }), "auth"],
    ["429 1分あたり", perMinute429(), "rate-limit"],
    ["429 1日あたり", perDay429(), "quota"],
    ["429 上限0（無料枠の対象外）", gErr(429, { error: { code: 429, message: "Quota exceeded for metric: x, limit: 0", status: "RESOURCE_EXHAUSTED" } }), "quota"],
    ["429 説明なし", gErr(429, { error: { code: 429, message: "Resource has been exhausted", status: "RESOURCE_EXHAUSTED" } }), "rate-limit"],
    ["404", gErr(404, { error: { code: 404, message: "models/x is not found", status: "NOT_FOUND" } }), "unknown"],
    ["500", gErr(500, { error: { code: 500, message: "internal", status: "INTERNAL" } }), "server"],
    ["503", gErr(503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }), "server"],
    ["TypeError(Failed to fetch)", new TypeError("Failed to fetch"), "network"],
    ["TimeoutError", timeoutErr, "network"],
    ["AbortError", abortErr, "aborted"],
    ["TypeError(プログラムの誤り)", new TypeError("x is not a function"), "unknown"],
    ["Error", new Error("boom"), "unknown"],
  ];
  for (const [name, err, kind] of cases) eq(classifyGeminiError(err).kind, kind, `${name} → ${kind}`);
  const done = new AbortController();
  done.abort();
  eq(classifyGeminiError(perMinute429(), done.signal).kind, "aborted", "中止済みの signal → aborted（ほかのエラーより先）");
  eq(classifyGeminiError(perMinute429()).message, "無料枠の1分あたりの上限に達しました。約37秒待ってから試してください", "1分あたりの上限: 待つ秒数（retryDelay）");
  eq(
    classifyGeminiError(gErr(429, { error: { code: 429, message: "exhausted", status: "RESOURCE_EXHAUSTED" } })).message,
    "無料枠の上限に達しました。しばらく待つか、明日また試してください",
    "説明の無い上限: 「無料枠の上限に達しました。しばらく待つか、明日また試してください」"
  );
  ok(classifyGeminiError(badKey()).message.includes("キーが正しくありません"), "キーの誤り: 「キーが正しくありません」");
  eq(readGeminiErrorBody("not json").message, "not json", "readGeminiErrorBody: JSON でなければ文字列のまま");
  eq(readGeminiErrorBody(JSON.stringify({ error: { status: "X", details: [{ retryDelay: "2.5s" }] } })).retrySec, 3, "readGeminiErrorBody: retryDelay を秒に（切り上げ）");

  // キーが説明に入っていても画面に出さない
  const leaky = gErr(400, { error: { code: 400, message: `bad request for key ${GKEY}`, status: "INVALID_ARGUMENT" } });
  const { client } = fakeGemini([leaky]);
  const e = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
  ok(!!e && !e.message.includes(GKEY) && e.message.includes("（キー）"), "エラーの文にキーを出さない（伏せる）");

  // 呼ぶ前に止まるもの（クライアントを呼ばない）
  const { client: c2, calls } = fakeGemini([]);
  eq((await aiError(() => createGeminiProvider({ apiKey: "  ", model: "gemini-3.8-flash", client: c2 }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA })))?.kind, "no-key", "キーが空 → no-key");
  eq((await aiError(() => createGeminiProvider({ apiKey: null, model: "gemini-3.8-flash", client: c2 }).testConnection()))?.kind, "no-key", "接続テスト: キーが無い → no-key");
  eq(
    (await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client: c2 }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA, signal: done.signal })))?.kind,
    "aborted",
    "中止済みの signal → aborted"
  );
  eq(calls.length, 0, "どれもクライアントを呼ばない");
}

console.log("=== Gemini: 接続テスト ===");
{
  const { client, calls } = fakeGemini([gText("OK", "STOP", { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } })]);
  const r = await createGeminiProvider({ apiKey: GKEY, model: "gemini-3.5-flash-lite", client }).testConnection();
  eq([r.model, calls[0].model, calls[0].params.config?.httpOptions?.timeout], ["gemini-3.5-flash-lite", "gemini-3.5-flash-lite", 30_000], "選んだモデルに短いメッセージ（30 秒で打ち切る）");
  const { client: c2, calls: k2 } = fakeGemini([perMinute429()]);
  const e = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client: c2 }).testConnection());
  eq([k2.length, e?.kind], [1, "rate-limit"], "接続テストは上限でも頼み直さない（選んだモデルそのものを確かめる）");
}

console.log("=== Gemini: 実物の SDK を偽の fetch で（自動の再試行なし・キーはヘッダー） ===");
{
  eq(geminiSdkOptions(GKEY), { apiKey: GKEY, httpOptions: { retryOptions: { attempts: 1 } } }, "SDK の設定: 自動の再試行なし（attempts 1）");
  type Fetched = { url: string; key: string | null; body: Record<string, unknown> | null };
  const fetched: Fetched[] = [];
  const queue: Response[] = [];
  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetched.push({
      url: String(input instanceof Request ? input.url : input),
      key: new Headers(init?.headers).get("x-goog-api-key"),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    });
    const r = queue.shift();
    if (!r) throw new TypeError("fetch failed");
    return r;
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const opts = geminiSdkOptions(GKEY);
  const real = new GoogleGenAI({ ...opts, httpOptions: { ...opts.httpOptions, fetch: fakeFetch } });
  const p = createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client: real });

  // 429 → SDK は送り直さず（fetch 1回）、こちらが 3.5 Flash-Lite で1回だけ頼み直す
  queue.push(
    json(429, {
      error: {
        code: 429,
        message: "Quota exceeded",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] }],
      },
    }),
    json(200, {
      candidates: [{ content: { role: "model", parts: [{ text: '{"frases":["Bora treinar."]}' }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 6 },
    })
  );
  const r = await p.generateJson({ system: SYSTEM, user: "Um exemplo.", schema: SCHEMA });
  eq([r.json, r.model, r.fallbackFrom], [{ frases: ["Bora treinar."] }, "gemini-3.5-flash-lite", "gemini-3.8-flash"], "実物の SDK: 429 → 3.5 Flash-Lite の答え");
  eq(fetched.length, 2, "実物の SDK: fetch は2回だけ（SDK の自動の再試行なし）");
  ok(fetched[0].url.includes("models/gemini-3.8-flash:generateContent") && fetched[1].url.includes("models/gemini-3.5-flash-lite:generateContent"), "実物の SDK: モデルごとの URL");
  ok(fetched.every((f) => f.key === GKEY), "実物の SDK: キーは x-goog-api-key ヘッダーで送る");
  ok(fetched.every((f) => !f.url.includes(GKEY) && !/[?&]key=/.test(f.url)), "実物の SDK: キーを URL に入れない");
  const body = fetched[1].body ?? {};
  const gen = (body.generationConfig ?? {}) as Record<string, unknown>;
  eq([gen.responseMimeType, gen.responseJsonSchema], ["application/json", SCHEMA], "実物の SDK: generationConfig に JSON の指定とスキーマ");
  ok(JSON.stringify(body.systemInstruction ?? null).includes(SYSTEM), "実物の SDK: systemInstruction にシステムプロンプト");
  ok(!JSON.stringify(body).includes(GKEY), "実物の SDK: 本文にキーは入らない");

  // ストリーミング（SSE）
  fetched.length = 0;
  const sse = [
    { candidates: [{ content: { role: "model", parts: [{ text: "Axé, " }] } }] },
    { candidates: [{ content: { role: "model", parts: [{ text: "camarada!" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3 } },
  ]
    .map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`)
    .join("");
  queue.push(new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }));
  const deltas: string[] = [];
  const s = await p.streamChat({
    system: SYSTEM,
    turns: [
      { role: "user", text: "Como cumprimento na roda?" },
      { role: "assistant", text: "Depende." },
      { role: "user", text: "Um exemplo curto." },
    ],
    onText: (d) => deltas.push(d),
  });
  eq([deltas, s.text, s.model, s.usage], [["Axé, ", "camarada!"], "Axé, camarada!", "gemini-3.8-flash", { input: 9, output: 3 }], "実物の SDK: ストリーミングの返事を少しずつ渡す");
  ok(fetched.length === 1 && fetched[0].url.includes(":streamGenerateContent") && fetched[0].url.includes("alt=sse"), "実物の SDK: streamGenerateContent（SSE）");
  const roles = ((fetched[0].body?.contents ?? []) as { role?: string }[]).map((c) => c.role);
  eq(roles, ["user", "model", "user"], "実物の SDK: 会話の役割（user / model）");

  // 503 → SDK は送り直さない
  fetched.length = 0;
  queue.push(json(503, { error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }));
  const e = await aiError(() => p.generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
  eq([e?.kind, fetched.length], ["server", 1], "実物の SDK: 503 → server（fetch 1回。自動の再試行なし）");

  // 通信の失敗
  fetched.length = 0;
  const e2 = await aiError(() => p.generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
  eq([e2?.kind, fetched.length], ["network", 1], "実物の SDK: fetch の失敗 → network");
  eq(queue.length, 0, "用意した応答をすべて使った");

  // 接続テストの打ち切り（config.httpOptions.timeout）: 実物の SDK は理由なしの中止（AbortError）にする
  // （TimeoutError ではない）→「中止しました」ではなく「時間内に応答がありませんでした」。
  // 30 秒は待てないので、SDK に渡す直前に打ち切りの時間だけ短くする（ほかはそのまま実物の SDK）
  {
    const hanging = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise<Response>((_, reject) => {
        const s = init?.signal;
        s?.addEventListener("abort", () => reject(s.reason));
      });
    const sdk = new GoogleGenAI({ ...opts, httpOptions: { ...opts.httpOptions, fetch: hanging } });
    let sentTimeout: number | undefined;
    const shortTimeout: GeminiClient = {
      models: {
        generateContent: (params) => {
          sentTimeout = params.config?.httpOptions?.timeout;
          return sdk.models.generateContent({ ...params, config: { ...params.config, httpOptions: { ...params.config?.httpOptions, timeout: 30 } } });
        },
        generateContentStream: (params) => sdk.models.generateContentStream(params),
      },
    };
    // SDK は打ち切りのタイマーを unref する（それだけだと Node が待たずに終わる）ので、終わるまでタイマーを1つ持っておく
    const keepAlive = setTimeout(() => {}, 10_000);
    const t = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client: shortTimeout }).testConnection());
    eq([t?.kind, t?.code, sentTimeout], ["network", "timeout", 30_000], "実物の SDK: 接続テストの打ち切り（30 秒）→ network・timeout（「中止しました」にしない）");
    ok(!!t?.message.includes("時間内に応答がありませんでした"), "打ち切り: 「時間内に応答がありませんでした」");
    // こちらが中止したときは「中止しました」のまま
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 10);
    const a = await aiError(() => createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client: sdk }).testConnection({ signal: ctrl.signal }));
    eq(a?.kind, "aborted", "実物の SDK: 接続テストをこちらで中止 → aborted");
    clearTimeout(keepAlive);
  }
}

// ---------------------------------------------------------------------------
// Claude（偽のクライアント）: 以前の歌詞の AI 翻訳と同じ送り方を共通の呼び出し口で
// ---------------------------------------------------------------------------

function fakeMessage(text: string | null, stop: string = "end_turn", usage: Partial<Anthropic.Usage> = {}): Anthropic.Message {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: text === null ? [] : [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: null, cache_read_input_tokens: null, ...usage },
  } as unknown as Anthropic.Message;
}
const textDelta = (text: string) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) as unknown as Anthropic.MessageStreamEvent;

type CCall = { kind: "create" | "stream"; body: Record<string, unknown>; signal: AbortSignal | null | undefined; timeout?: number; maxRetries?: number };
type CStream = { events: Anthropic.MessageStreamEvent[]; final: Anthropic.Message | Error; error?: Error };
function fakeClaude(responses: (Anthropic.Message | Error)[], streams: CStream[] = []): { client: MessagesClient; calls: CCall[] } {
  const calls: CCall[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (body, opts) => {
        calls.push({ kind: "create", body: JSON.parse(JSON.stringify(body)), signal: opts?.signal, timeout: opts?.timeout, maxRetries: opts?.maxRetries });
        const r = responses.shift();
        if (!r) throw new Error("偽のクライアント: 応答がもうありません");
        if (r instanceof Error) throw r;
        return r;
      },
      stream: (body, opts): ClaudeStreamLike => {
        calls.push({ kind: "stream", body: JSON.parse(JSON.stringify(body)), signal: opts?.signal, timeout: opts?.timeout, maxRetries: opts?.maxRetries });
        const s = streams.shift();
        if (!s) throw new Error("偽のクライアント: ストリームがもうありません");
        return {
          async *[Symbol.asyncIterator]() {
            for (const ev of s.events) yield ev;
            if (s.error) throw s.error;
          },
          finalMessage: async () => {
            if (s.final instanceof Error) throw s.final;
            return s.final;
          },
        };
      },
    },
  };
  return { client, calls };
}
const H = () => new Headers();
const apiBody = (type: string, message: string) => ({ type: "error", error: { type, message } });

console.log("=== Claude: generateJson（以前の AI 翻訳と同じ送り方） ===");
{
  const ctrl = new AbortController();
  const { client, calls } = fakeClaude([fakeMessage('{"frases":["Tô chegando."]}', "end_turn", { input_tokens: 500, output_tokens: 80 })]);
  const p = createClaudeProvider({ apiKey: CKEY, model: "claude-haiku-4-5", client });
  const r = await p.generateJson({ system: SYSTEM, user: "Um exemplo.", schema: SCHEMA, signal: ctrl.signal });
  eq([r.json, r.model, r.usage, r.formatFallback], [{ frases: ["Tô chegando."] }, "claude-haiku-4-5", { input: 500, output: 80, cacheWrite: 0, cacheRead: 0 }, undefined], "成功: JSON・モデル・usage");
  const b = calls[0].body;
  eq([b.model, b.max_tokens, b.system], ["claude-haiku-4-5", 16000, SYSTEM], "送る: モデル・max_tokens 16000・システムプロンプト");
  eq(b.output_config, { format: { type: "json_schema", schema: SCHEMA } }, "送る: output_config.format に JSON スキーマ（Haiku 4.5 には effort を送らない）");
  eq([calls[0].maxRetries, calls[0].signal === ctrl.signal], [0, true], "SDK の自動の再試行をしない（maxRetries 0）・中止の signal を渡す");
  ok(!("thinking" in b) && !("temperature" in b), "thinking・temperature を送らない");

  const { client: c2, calls: k2 } = fakeClaude([
    new Anthropic.BadRequestError(400, apiBody("invalid_request_error", "output_config.format: not supported"), "400 output_config", H()),
    fakeMessage('```json\n{"frases":[]}\n```'),
  ]);
  const r2 = await createClaudeProvider({ apiKey: CKEY, model: "claude-sonnet-5", client: c2 }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA });
  eq(
    [k2[0].body.output_config, k2[1].body.output_config, r2.formatFallback],
    [{ effort: "medium", format: { type: "json_schema", schema: SCHEMA } }, { effort: "medium" }, true],
    "Sonnet 5: effort medium。構造化出力を断られたら format だけ外して1回だけ頼み直す"
  );

  const cases: [string, Anthropic.Message | Error, string, string][] = [
    ["refusal", fakeMessage(null, "refusal", { input_tokens: 800, output_tokens: 0 }), "refusal", "refusal"],
    ["max_tokens", fakeMessage('{"frases":["a', "max_tokens"), "truncated", "max_tokens"],
    ["text なし", fakeMessage(null), "bad-response", "parse"],
    ["JSON でない", fakeMessage("não é json"), "bad-response", "parse"],
    ["AuthenticationError", new Anthropic.AuthenticationError(401, apiBody("authentication_error", "invalid x-api-key"), "401", H()), "auth", "auth"],
    ["PermissionDeniedError", new Anthropic.PermissionDeniedError(403, apiBody("permission_error", "no"), "403", H()), "auth", "permission"],
    ["NotFoundError", new Anthropic.NotFoundError(404, apiBody("not_found_error", "model"), "404", H()), "unknown", "not_found"],
    ["RateLimitError", new Anthropic.RateLimitError(429, apiBody("rate_limit_error", "slow"), "429", H()), "rate-limit", "rate_limit"],
    ["InternalServerError", new Anthropic.InternalServerError(529, apiBody("overloaded_error", "busy"), "529", H()), "server", "server"],
    ["APIConnectionError", new Anthropic.APIConnectionError({ message: "Connection error." }), "network", "connection"],
    ["APIUserAbortError", new Anthropic.APIUserAbortError(), "aborted", "aborted"],
    ["APIError(402)", new Anthropic.APIError(402, apiBody("billing_error", "pay"), "402", H()), "quota", "billing"],
    ["TypeError", new TypeError("boom"), "unknown", "unknown"],
  ];
  for (const [name, res, kind, code] of cases) {
    const { client: c, calls: k } = fakeClaude([res]);
    const e = await aiError(() => createClaudeProvider({ apiKey: CKEY, model: "claude-haiku-4-5", client: c }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
    eq([e?.kind, e?.code, k.length], [kind, code, 1], `${name} → ${kind}（code ${code}・頼み直さない）`);
  }
  const { client: c3 } = fakeClaude([fakeMessage(null, "refusal", { input_tokens: 800, output_tokens: 0 })]);
  const e3 = await aiError(() => createClaudeProvider({ apiKey: CKEY, model: "claude-haiku-4-5", client: c3 }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA }));
  eq(e3?.usage?.input, 800, "refusal: その回の usage を持つ（料金の計算に使う）");
  eq((await aiError(() => createClaudeProvider({ apiKey: "", model: "claude-haiku-4-5", client: c3 }).generateJson({ system: SYSTEM, user: "x", schema: SCHEMA })))?.kind, "no-key", "キーが空 → no-key");
}

console.log("=== Claude: streamChat（messages.stream ＋ finalMessage） ===");
{
  const ctrl = new AbortController();
  const { client, calls } = fakeClaude([], [{ events: [textDelta("Oi, "), textDelta("tudo bem?")], final: fakeMessage("Oi, tudo bem?", "end_turn", { input_tokens: 50, output_tokens: 6 }) }]);
  const deltas: string[] = [];
  const r = await createClaudeProvider({ apiKey: CKEY, model: "claude-sonnet-5", client }).streamChat({
    system: SYSTEM,
    turns: [
      { role: "assistant", text: "Bem-vindo!" },
      { role: "user", text: "Oi" },
    ],
    signal: ctrl.signal,
    onText: (d) => deltas.push(d),
  });
  eq([deltas, r.text, r.model, r.usage?.input], [["Oi, ", "tudo bem?"], "Oi, tudo bem?", "claude-sonnet-5", 50], "返事を少しずつ渡し、最後に usage を読む");
  const b = calls[0].body;
  eq([calls[0].kind, b.model, b.max_tokens, b.system, b.messages, b.output_config], ["stream", "claude-sonnet-5", 16000, SYSTEM, [{ role: "user", content: "Oi" }], { effort: "medium" }], "送る: stream（max_tokens 16000・会話は user から・Sonnet 5 は effort medium）");
  eq([calls[0].maxRetries, calls[0].signal === ctrl.signal], [0, true], "stream も maxRetries 0・中止の signal");

  const { client: c2, calls: k2 } = fakeClaude([], [{ events: [textDelta("Olá")], final: fakeMessage("Olá") }]);
  await createClaudeProvider({ apiKey: CKEY, model: "claude-haiku-4-5", client: c2 }).streamChat({ system: SYSTEM, turns: [{ role: "user", text: "Oi" }], onText: () => {} });
  ok(!("output_config" in k2[0].body), "Haiku 4.5 の会話には effort を送らない");

  const { client: c3 } = fakeClaude([], [{ events: [textDelta("Não posso ")], final: fakeMessage("Não posso ", "refusal") }]);
  const e3 = await aiError(() => createClaudeProvider({ apiKey: CKEY, model: "claude-haiku-4-5", client: c3 }).streamChat({ system: SYSTEM, turns: [{ role: "user", text: "x" }], onText: () => {} }));
  eq([e3?.kind, e3?.partialText], ["refusal", "Não posso "], "refusal → refusal（途中までの返事を持つ）");
  const { client: c4 } = fakeClaude([], [{ events: [textDelta("Longo")], final: fakeMessage("Longo", "max_tokens") }]);
  eq((await aiError(() => createClaudeProvider({ apiKey: CKEY, model: "claude-haiku-4-5", client: c4 }).streamChat({ system: SYSTEM, turns: [{ role: "user", text: "x" }], onText: () => {} })))?.kind, "truncated", "max_tokens → truncated");
  const { client: c5 } = fakeClaude([], [{ events: [textDelta("Parte")], final: fakeMessage("x"), error: new Anthropic.RateLimitError(429, apiBody("rate_limit_error", "slow"), "429", H()) }]);
  const e5 = await aiError(() => createClaudeProvider({ apiKey: CKEY, model: "claude-haiku-4-5", client: c5 }).streamChat({ system: SYSTEM, turns: [{ role: "user", text: "x" }], onText: () => {} }));
  eq([e5?.kind, e5?.partialText], ["rate-limit", "Parte"], "ストリームの途中のエラー → 種類に合わせ、途中までの返事を持つ");
  // HTTP 200 の後に SSE の event: error で届くエラー（SDK は status なし・type 付きの APIError にする）
  const sseErr = (type: "overloaded_error" | "rate_limit_error" | "api_error") =>
    new Anthropic.APIError(undefined, { type: "error", error: { type, message: "x" } }, undefined, undefined, type);
  for (const [type, kind, code] of [
    ["overloaded_error", "server", "server"],
    ["api_error", "server", "server"],
    ["rate_limit_error", "rate-limit", "rate_limit"],
  ] as const) {
    const { client: c } = fakeClaude([], [{ events: [textDelta("Meio ")], final: fakeMessage("x"), error: sseErr(type) }]);
    const e = await aiError(() => createClaudeProvider({ apiKey: CKEY, model: "claude-haiku-4-5", client: c }).streamChat({ system: SYSTEM, turns: [{ role: "user", text: "x" }], onText: () => {} }));
    eq([e?.kind, e?.code, e?.partialText], [kind, code, "Meio "], `ストリームの途中の ${type}（status なし）→ ${kind}（途中までの返事を持つ）`);
  }
  const { client: c6 } = fakeClaude([], [{ events: [], final: fakeMessage("Resposta inteira") }]);
  const deltas6: string[] = [];
  const r6 = await createClaudeProvider({ apiKey: CKEY, model: "claude-haiku-4-5", client: c6 }).streamChat({ system: SYSTEM, turns: [{ role: "user", text: "x" }], onText: (d) => deltas6.push(d) });
  eq([r6.text, deltas6], ["Resposta inteira", ["Resposta inteira"]], "差分が来なくても最後のメッセージの本文を使う");
}

console.log("=== Claude: 接続テスト ===");
{
  const { client, calls } = fakeClaude([fakeMessage("OK", "end_turn", { input_tokens: 12, output_tokens: 3 })]);
  const r = await createClaudeProvider({ apiKey: CKEY, model: "claude-sonnet-5", client }).testConnection();
  eq([calls[0].body.max_tokens, calls[0].timeout, r.model, r.usage?.input], [16, 30_000, "claude-sonnet-5", 12], "max_tokens 16・30 秒で打ち切る（以前と同じ）");
}

// ---------------------------------------------------------------------------
// 歌詞の AI 翻訳（translateSongWithAi）: どちらのサービスでも同じ検査
// ---------------------------------------------------------------------------

console.log("=== translateSongWithAi（Gemini / Claude・偽のクライアント） ===");
{
  const lines = ["O barco azul chegou cedo", "", "A roda da escola começou"];
  const okJson = JSON.stringify({ lines: [{ i: 0, ja: "青い船が朝早く着いた" }, { i: 2, ja: "学校のホーダが始まった", note: "roda はカポエイラの輪" }] });
  {
    const { client, calls } = fakeGemini([perMinute429(), gText(okJson)]);
    const r = await translateSongWithAi({ provider: createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }), title: "Canção Inventada", artist: "Grupo de Teste", lines });
    eq(r.results, [{ ja: "青い船が朝早く着いた" }, null, { ja: "学校のホーダが始まった", note: "roda はカポエイラの輪" }], "Gemini: 入力の行と同じ順");
    eq([r.provider, r.model, r.fallbackFrom, r.cost, r.skipped, r.usedFallback], ["gemini", "gemini-3.5-flash-lite", "gemini-3.8-flash", null, 0, false], "Gemini: 無料枠（料金 null）・上限なら 3.5 Flash-Lite");
    eq(calls[1].params.config?.responseJsonSchema, JSON.parse(JSON.stringify(AI_TRANSLATION_SCHEMA)), "Gemini: 歌詞の翻訳と同じ JSON スキーマ");
    ok(String(calls[1].params.contents && JSON.stringify(calls[1].params.contents)).includes("2: A roda da escola começou"), "Gemini: 番号付きの行を送る");
  }
  {
    const { client } = fakeClaude([fakeMessage(okJson, "end_turn", { input_tokens: 900, output_tokens: 300 })]);
    const r = await translateSongWithAi({ provider: createClaudeProvider({ apiKey: CKEY, model: "claude-haiku-4-5", client }), title: "T", artist: "A", lines });
    eq([r.provider, r.model, r.fallbackFrom], ["claude", "claude-haiku-4-5", null], "Claude: モデル");
    ok(r.cost !== null && Math.abs(r.cost.usd - (900 * 1 + 300 * 5) / 1e6) < 1e-12, "Claude: 料金は usage から");
  }
  {
    const { client } = fakeGemini([gText("Uma", "RECITATION")]);
    const e = await aiError(() => translateSongWithAi({ provider: createGeminiProvider({ apiKey: GKEY, model: "gemini-3.5-flash-lite", client }), title: "T", artist: "A", lines }));
    eq(e?.kind, "refusal", "Gemini の RECITATION → refusal");
    ok(!!e?.message.includes("機械翻訳") && !!e?.message.includes("別のモデル"), "refusal: 別のモデルか機械翻訳をすすめる");
  }
  {
    const { client } = fakeGemini([gText(JSON.stringify({ lines: [{ i: 1, ja: "ずれた行" }] }))]);
    const e = await aiError(() => translateSongWithAi({ provider: createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }), title: "T", artist: "A", lines }));
    ok(e?.kind === "bad-response" && e.message.includes("送っていない行番号 1") && e.message.includes("保存していません"), "行番号がずれた応答 → 何も保存しない");
  }
  {
    const { client } = fakeGemini([gText("{", "MAX_TOKENS")]);
    const e = await aiError(() => translateSongWithAi({ provider: createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client }), title: "T", artist: "A", lines }));
    ok(e?.kind === "truncated" && e.message.includes("途中で切れ") && e.message.includes("保存していません"), "途中で切れた → 保存しない");
  }
  eq((await aiError(() => translateSongWithAi({ provider: null, title: "T", artist: "A", lines })))?.kind, "no-key", "キーが無い（provider null）→ no-key");
  const { client: none, calls } = fakeGemini([]);
  eq((await aiError(() => translateSongWithAi({ provider: createGeminiProvider({ apiKey: GKEY, model: "gemini-3.8-flash", client: none }), title: "T", artist: "A", lines: ["", " "] })))?.code, "empty", "送る行が無い → 呼ばない");
  eq(calls.length, 0, "送る行が無ければクライアントを呼ばない");

  eq(aiCostOf("gemini", "gemini-3.8-flash", { input: 1000, output: 1000 }), null, "aiCostOf: Gemini は null（無料枠）");
  eq(
    aiCostOf("claude", "claude-haiku-4-5", { input: 2000, output: 3000, cacheWrite: 0, cacheRead: 0 }),
    costFromUsage({ input_tokens: 2000, output_tokens: 3000 }, "claude-haiku-4-5"),
    "aiCostOf: Claude は costFromUsage と同じ"
  );
}

// ---------------------------------------------------------------------------
// キー（useSecrets）: 端末にだけ保存・バックアップに入らない
// ---------------------------------------------------------------------------

console.log("=== useSecrets: Gemini のキー（bp-secrets-v1 だけ・書き出さない） ===");
{
  eq([normalizeApiKey(`  ${GKEY}\n`), normalizeApiKey(" "), normalizeApiKey(undefined)], [GKEY, null, null], "normalizeApiKey");
  // 本物のキーの形（AIza ＋ 35文字）ちょうどの文字列はソースに書かない（秘密のスキャンに引っかからないよう、実行時に作る）
  const LOOKS_REAL_GEMINI = "AIza" + "A1b2C3d4".repeat(5);
  eq([looksLikeGeminiKey(LOOKS_REAL_GEMINI), looksLikeGeminiKey("sk-ant-abc"), looksLikeGeminiKey("AIza")], [true, false, false], "looksLikeGeminiKey（AIza で始まる）");
  eq(maskApiKey(GKEY), `…${GKEY.slice(-4)}`, "maskApiKey: 末尾4文字だけ");

  // 以前の版の保存データ（Anthropic のキーだけ。上で入れた）→ そのまま読め、Gemini のキーは null
  eq([useSecrets.getState().anthropicApiKey, useSecrets.getState().geminiApiKey], [CKEY, null], "以前の保存データ: Anthropic のキーはそのまま・Gemini は null");
  useSecrets.getState().setGeminiApiKey(`  ${GKEY} `);
  eq(useSecrets.getState().geminiApiKey, GKEY, "保存: 前後の空白を除く");
  const saved = JSON.parse(mem.get("bp-secrets-v1") ?? "{}") as { state: Record<string, unknown> };
  eq(Object.keys(saved.state).sort(), ["anthropicApiKey", "geminiApiKey"], "保存するのはキーだけ（関数は保存しない）");
  eq(saved.state.geminiApiKey, GKEY, "Gemini のキーは bp-secrets-v1 に保存");

  const { exportAll } = await import("../src/store/backup");
  const json = exportAll();
  ok(!json.includes(GKEY) && !json.includes(CKEY), "バックアップの書き出しにキーが入らない");
  ok(!json.includes("geminiApiKey") && !json.includes("anthropicApiKey") && !json.includes("bp-secrets"), "書き出しにキーの項目名・秘密のストアが入らない");
  ok(![...mem.entries()].some(([k, v]) => k !== "bp-secrets-v1" && (v.includes(GKEY) || v.includes(CKEY))), "キーは bp-secrets-v1 のほかのどこにも保存されない");

  mem.set("bp-secrets-v1", JSON.stringify({ state: { geminiApiKey: 12345, anthropicApiKey: ["x"] }, version: 0 }));
  await useSecrets.persist.rehydrate();
  eq([useSecrets.getState().geminiApiKey, useSecrets.getState().anthropicApiKey], [null, null], "壊れた値（文字列でない）は読まない");
  useSecrets.getState().clearGeminiApiKey();
  useSecrets.getState().clearAnthropicApiKey();
}

// ---------------------------------------------------------------------------
// 🧑‍🏫 AI 先生（文脈・プロンプト・返事の書式・会話の履歴・送受信）。例はすべてこの検証のために作った文
// ---------------------------------------------------------------------------

const SONG_LINES = [
  "Primeira linha inventada",
  "",
  "Segunda linha do teste",
  "Terceira linha aqui",
  "Quarta linha final",
  "Quinta linha extra",
  "Sexta linha sobrando",
];

console.log("=== AI 先生: 文脈（teacherContext） ===");
{
  const c = songLineContext({ title: "Canção Inventada", artist: "Grupo de Teste", lines: SONG_LINES, index: 3, translation: "三行目の訳" });
  eq([c.kind, c.label], ["song-line", "🎵 Canção Inventada — 4行目"], "歌詞の行: 種類とチップ（N行目）");
  eq(
    c.data,
    {
      title: "Canção Inventada",
      artist: "Grupo de Teste",
      line: "Terceira linha aqui",
      before: ["Primeira linha inventada", "Segunda linha do teste"],
      after: ["Quarta linha final", "Quinta linha extra"],
      translation: "三行目の訳",
    },
    "歌詞の行: 前後2行ずつ（空の行は飛ばす）・今の訳"
  );
  ok(!c.label.includes("Terceira"), "チップに歌詞の本文を入れない");
  const first = songLineContext({ title: "T", artist: "A", lines: SONG_LINES, index: 0, translation: "" });
  ok(!("before" in first.data) && !("translation" in first.data), "最初の行: 前の行・空の訳の項目を置かない");
  eq(songLineContext({ title: "T", artist: "A", lines: SONG_LINES, index: 6 }).data.after, undefined, "最後の行: 次の行の項目を置かない");

  const w = songWordContext({ title: "Canção Inventada", artist: "Grupo", surface: "tava", lemma: "estar", meaning: "いる・ある", pos: "動詞", line: "Eu tava na roda" });
  eq([w.kind, w.data.surface, w.data.lemma, w.data.line], ["song-word", "tava", "estar", "Eu tava na roda"], "歌詞の単語: 形・原形・その行");
  eq(songWordContext({ title: "T", artist: "A", surface: "roda", lemma: "roda" }).data.lemma, undefined, "原形が形と同じなら原形の項目を置かない");

  const p = patternContext({
    category: "日常",
    frame: "Eu quero {X}.",
    ja: "私は{X}が欲しい。",
    sentence: { pt: "Eu quero água.", ja: "私は水が欲しい。" },
    options: ["água", "café", "pão", "um livro", "ajuda", "dormir", "sair", "jogar", "treinar", "cantar"],
  });
  eq([p.kind, p.label, p.data.frame, p.data.sentence], ["pattern", "🧩 Eu quero 〜.", "Eu quero {X}.", "Eu quero água."], "文型: チップは {X} を 〜 に");
  eq((p.data.options as string[]).length, 8, "文型: 入れ替え語の例は8つまで");

  const wc = wordContext({ pt: "saudade", ja: "懐かしさ", pos: "名詞", example: { pt: "Tenho saudade.", ja: "恋しい。" }, chosen: { pt: "sorte", ja: "運" } });
  eq([wc.kind, wc.label, wc.data.example, wc.data.chosen], ["word", "📖 saudade", "Tenho saudade.", "sorte（運）"], "単語: 例文・間違えて選んだ語");
  ok(!("note" in wc.data) && !("category" in wc.data), "単語: 無い項目は置かない");
  const sc = sentenceContext({ pt: "A gente se vê amanhã, beleza?", ja: "また明日ね、いい？", source: "会話の練習" });
  eq([sc.kind, sc.label, sc.data.source], ["sentence", "💬 A gente se vê amanhã, b…", "会話の練習"], "文: チップは文の頭（24文字まで）");
  eq(generalContext("単語帳"), { kind: "general", label: "📍 単語帳", data: { screen: "単語帳" } }, "画面の文脈");
  eq(
    ["/", "/flashcards/today", "/quiz", "/practice/pattern", "/practice/chunk/psg_1", "/music", "/music/abc", "/settings", "/nao-existe"].map((x) => screenNameFor(x, x === "/music/abc" ? "Música Inventada" : null)),
    ["ホーム", "単語帳", "クイズ", "パターンプラクティス", "チャンクリーディング", "音楽", "音楽「Música Inventada」", "設定", "ホーム"],
    "screenNameFor: パスから画面の名前（曲の画面は曲名つき）"
  );
  eq([clip("abcdef", 4), clip("  a  b ", 10)], ["abc…", "a b"], "clip: 縮める・空白をまとめる");
  eq(readTeacherContext({ kind: "song-line", label: "🎵 X", data: { line: "L", before: ["a", 3, "b"], n: 5 } }), { kind: "song-line", label: "🎵 X", data: { line: "L", before: ["a", "b"] } }, "readTeacherContext: 文字列・文字列の配列だけ");
  eq([readTeacherContext({ kind: "x", label: "L", data: {} }), readTeacherContext(null), readTeacherContext({ kind: "word" })], [null, null, null], "readTeacherContext: 知らない種類・形の崩れたもの → null");
}

/** 検証用のカード */
const card = (p: Partial<SrsCard>): SrsCard => ({ ease: 2.5, intervalDays: 3, due: "2026-09-30", reps: 1, lapses: 0, level: "learning", last: "2026-09-20", ...p });
const WORDS: Record<string, { pt: string; ja: string }> = {
  "words:0001": { pt: "casa", ja: "家" },
  "words:0002": { pt: "roda", ja: "輪・ホーダ" },
  "words:0003": { pt: "ginga", ja: "ジンガ（基本の動き）" },
  "words:0005": { pt: "saudade", ja: "懐かしさ・恋しさ" },
};
const TODAY = "2026-09-27";
const PROFILE: TeacherProfile = learnerProfile(
  {
    "words:0001": card({ intervalDays: 30, reps: 6, last: "2026-09-20" }),
    "words:0002": card({ lapses: 2, last: "2026-09-26" }),
    "words:0003": card({ lapses: 1, last: TODAY }),
    "words:0003@p": card({ last: TODAY }),
    "words:0004": card({ last: null, reps: 0 }),
    "words:0005": card({ lapses: 3, last: "2026-09-26" }),
    "words:9999": card({ lapses: 5, last: "2026-09-25" }),
  },
  (id) => WORDS[id],
  TODAY
);

console.log("=== AI 先生: 学習者のようす・プロンプト（teacherPrompt） ===");
{
  eq([PROFILE.learned, PROFILE.mature], [5, 1], "学習した語（評価した理解カード。産出カード・未評価は数えない）・習得");
  eq(PROFILE.weak, ["ginga（ジンガ（基本の動き））", "saudade（懐かしさ・恋しさ）", "roda（輪・ホーダ）"], "最近つまずいた語: 新しい順・同じ日は失敗の多い順（引けない語は出さない）");
  eq(PROFILE.today, ["ginga（ジンガ（基本の動き））"], "今日復習した語（産出カードは元の語として1回）");

  const ctx = songLineContext({ title: "Canção Inventada", artist: "Grupo de Teste", lines: SONG_LINES, index: 3, translation: "三行目の訳" });
  const sys = buildTeacherSystem(PROFILE, ctx);
  for (const rule of ["日本語で", "簡潔", "você", "a gente", "【口語】", "【丁寧】", "【スラング】", "地域", "文法はやさしく", "「🇧🇷 」", "「🇯🇵 」", "HTML", "**太字**", "比喩", "カポエイラ", "歌詞をまるごと", "自信がない"]) {
    ok(sys.includes(rule), `システムプロンプト: 決まり「${rule}」`);
  }
  ok(sys.startsWith(TEACHER_RULES), "システムプロンプトは役割と答え方の決まりから始まる");
  for (const s of ["学習した語: 5語（うち習得 1語）", "最近つまずいた語: ginga", "今日復習した語: ginga", "興味: カポエイラ"]) ok(sys.includes(s), `学習者のようす: 「${s}」`);
  for (const s of [
    "種類: 歌の歌詞の1行",
    "曲: Canção Inventada",
    "アーティスト: Grupo de Teste",
    "前の行: Primeira linha inventada / Segunda linha do teste",
    "この行: Terceira linha aqui",
    "次の行: Quarta linha final / Quinta linha extra",
    "アプリで出している和訳: 三行目の訳",
  ]) {
    ok(sys.includes(s), `文脈: 「${s}」`);
  }
  ok(!sys.includes("Sexta linha sobrando"), "文脈: 前後2行より外の行は送らない");
  ok(sys.length < 2500, `システムプロンプトは短い（${sys.length}文字）`);
  const none = buildTeacherSystem(PROFILE, null);
  ok(!none.includes("# いま見ている内容") && !none.includes("# いま開いている画面"), "文脈なし: 文脈の見出しを出さない");
  const gen = buildTeacherSystem(PROFILE, generalContext("クイズ"));
  ok(gen.includes("# いま開いている画面") && gen.includes("いま開いている画面: クイズ"), "画面の文脈: 画面の名前");
  const long = buildTeacherSystem(PROFILE, sentenceContext({ pt: "a".repeat(5000), ja: "い".repeat(5000) }));
  ok(long.length < 3000 && long.includes("…"), `長すぎる文脈は縮める（${long.length}文字）`);
  eq(contextBlock(wordContext({ pt: "casa", ja: "家", chosen: { pt: "caça", ja: "狩り" } })), "- 種類: 単語帳の単語\n- ポルトガル語: casa\n- 意味: 家\n- クイズで間違えて選んだ語: caça（狩り）", "contextBlock: 知っている項目を決まった順で");
  const empty = learnerProfile({}, () => undefined, TODAY);
  const sys0 = buildTeacherSystem(empty, null);
  ok(sys0.includes("学習した語: 0語（うち習得 0語）") && !sys0.includes("最近つまずいた語") && !sys0.includes("今日復習した語"), "学習前: 語の一覧の行を出さない");

  const hist = Array.from({ length: 31 }, (_, i) => ({ role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant", text: `発言${i}` }));
  const turns = buildTurns(hist);
  eq([MAX_TURNS, turns.length, turns[0].text, turns[turns.length - 1].text], [20, 20, "発言11", "発言30"], "buildTurns: 最後の 20 発言だけ送る");
  eq(buildTurns(hist.slice(0, 3)), hist.slice(0, 3), "buildTurns: 20 以下はそのまま");
  eq(
    (Object.keys(QUICK_QUESTIONS) as (keyof typeof QUICK_QUESTIONS)[]).map((k) => QUICK_QUESTIONS[k].map((q) => q.label)),
    [
      ["この行の意味と文脈", "比喩・言葉遊びは？", "文法を分解して", "日常会話でも使う？"],
      ["使い方と例文", "似た語との違い", "覚え方のコツ"],
      ["使い方と例文", "似た語との違い", "覚え方のコツ"],
      ["例文をもっと5つ", "こんな場面ではどう言う？", "丁寧・くだけた言い方"],
      ["この表現の使いどころ", "言い換えは？", "文法を説明して"],
      ["〜って何て言う？", "発音のコツ", "今日の復習語で例文を"],
    ],
    "すぐ聞ける質問（文脈の種類ごと）"
  );
  ok(
    Object.values(QUICK_QUESTIONS).every((qs) => qs.every((q) => !q.fill || q.text.includes("〜"))),
    "入力欄に入れる質問（fill）には、書き足す所「〜」がある"
  );
}

console.log("=== AI 先生: 返事の書式（format.ts） ===");
{
  const text = [
    "**ポイント**: saudade は名詞です。",
    "",
    "- 1つ目の *使い方*",
    "- 2つ目は `a gente`",
    "",
    "🇧🇷 Eu sinto saudade da roda.",
    "🇯🇵 ホーダが恋しい。",
    "- 🇧🇷 **A gente** vai treinar amanhã.",
    "- 🇯🇵 私たちは明日トレーニングする。",
    "🇧🇷 Só a frase, sem tradução.",
    "",
    "### まとめ",
    "1. 覚える",
    "2. 使う",
    "<b>タグ</b> と <script>alert(1)</script> はそのまま",
    "閉じていない **太字",
  ].join("\n");
  const blocks = parseTeacherText(text);
  eq(blocks.map((b) => b.kind), ["p", "ul", "example", "example", "example", "h", "ol", "p"], "段落・箇条書き・例文・見出し・番号付きに分ける");
  eq(blocks[0], { kind: "p", lines: [[{ text: "ポイント", b: true }, { text: ": saudade は名詞です。" }]] }, "**太字**");
  eq(
    blocks[1],
    { kind: "ul", items: [[{ text: "1つ目の " }, { text: "使い方", i: true }], [{ text: "2つ目は " }, { text: "a gente", code: true }]] },
    "箇条書き（*斜体*・`コード`）"
  );
  eq(blocks[2], { kind: "example", pt: "Eu sinto saudade da roda.", ja: "ホーダが恋しい。" }, "例文: 🇧🇷 の行と次の 🇯🇵 の行の組");
  eq(blocks[3], { kind: "example", pt: "A gente vai treinar amanhã.", ja: "私たちは明日トレーニングする。" }, "例文: 箇条書きの印・太字の印は外す");
  eq(blocks[4], { kind: "example", pt: "Só a frase, sem tradução.", ja: null }, "例文: 🇯🇵 の無い 🇧🇷 → 意味なし");
  eq(blocks[5], { kind: "h", spans: [{ text: "まとめ" }] }, "見出し（### ）");
  eq(blocks[6], { kind: "ol", start: 1, items: [[{ text: "覚える" }], [{ text: "使う" }]] }, "番号付き");
  eq(
    blocks[7],
    { kind: "p", lines: [[{ text: "<b>タグ</b> と <script>alert(1)</script> はそのまま" }], [{ text: "閉じていない **太字" }]] },
    "HTML のタグは解釈せず文字のまま・閉じていない ** も文字のまま"
  );
  eq(parseTeacherText("🇧🇷 Oi, tudo bem? 🇯🇵 やあ、元気？"), [{ kind: "example", pt: "Oi, tudo bem?", ja: "やあ、元気？" }], "同じ行の 🇧🇷 / 🇯🇵");
  eq(parseTeacherText("🇧🇷 Bora!\n\n🇯🇵 行こう！"), [{ kind: "example", pt: "Bora!", ja: "行こう！" }], "🇧🇷 と 🇯🇵 の間の空行1つは許す");
  eq(parseTeacherText("🇯🇵 意味だけの行"), [{ kind: "p", lines: [[{ text: "🇯🇵 意味だけの行" }]] }], "前に 🇧🇷 の無い 🇯🇵 は普通の文");
  eq(parseTeacherText("説明です。\n🇧🇷 Eu vo"), [{ kind: "p", lines: [[{ text: "説明です。" }]] }, { kind: "example", pt: "Eu vo", ja: null }], "受信中の途中の文でも分けられる");
  eq(parseTeacherText("1行目\r\n2行目"), [{ kind: "p", lines: [[{ text: "1行目" }], [{ text: "2行目" }]] }], "CRLF の改行・続く行は同じ段落");
  eq(parseTeacherText("・中黒の箇条書き\n* 星の箇条書き"), [{ kind: "ul", items: [[{ text: "中黒の箇条書き" }], [{ text: "星の箇条書き" }]] }], "・ と * の箇条書き");
  eq([parseTeacherText(""), parseTeacherText("\n\n")], [[], []], "空 → 部品なし");
  eq(parseInline("a **b** c * d * e"), [{ text: "a " }, { text: "b", b: true }, { text: " c * d * e" }], "parseInline: 空白で囲んだ * は印にしない");
  eq(parseInline("&lt;b&gt;x&lt;/b&gt;"), [{ text: "&lt;b&gt;x&lt;/b&gt;" }], "parseInline: 実体参照も文字のまま");
  eq(plainText("**Eu** *vou* `já`"), "Eu vou já", "plainText: 印を外す（読み上げ・カナ用）");
}

console.log("=== AI 先生: 会話の履歴（useTeacher。上限・並び・保存データ） ===");
// 以前の保存データ（形の崩れた会話・発言が混ざる）を入れてから、ストアを読み込む
mem.set(
  "bp-teacher-v1",
  JSON.stringify({
    state: {
      conversations: [
        {
          id: "old-1",
          title: "",
          createdAt: "2026-09-20T10:00:00.000Z",
          updatedAt: "2026-09-20T10:05:00.000Z",
          contextLabel: "🎵 Canção Inventada — 4行目",
          context: { kind: "song-line", label: "🎵 Canção Inventada — 4行目", data: { line: "Terceira linha aqui", extra: 5 } },
          future: "項目",
          messages: [
            { role: "user", text: "Primeira pergunta inventada", at: "2026-09-20T10:00:00.000Z" },
            { role: "system", text: "x", at: "2026-09-20T10:00:01.000Z" },
            { role: "assistant", text: 5, at: "2026-09-20T10:00:02.000Z" },
            { role: "assistant", text: "Resposta.", at: "2026-09-20T10:05:00.000Z", model: "gemini-3.8-flash", stopped: true },
          ],
        },
        { id: 3, createdAt: "x", updatedAt: "x", messages: [] },
        { id: "empty", createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z", messages: [] },
        { id: "old-1", createdAt: "2026-09-20T10:00:00.000Z", updatedAt: "2026-09-20T10:00:00.000Z", messages: [{ role: "user", text: "重複", at: "x" }] },
      ],
    },
    version: 0,
  })
);
const { useTeacher, capConversations, conversationTitle, readConversations, MAX_CONVERSATIONS, MAX_MESSAGES, TEXT_BUDGET } = await import("../src/store/useTeacher");
const { sendTeacherMessage, retryTeacher, deleteTeacherConversation, clearTeacherHistory, MAX_QUESTION_CHARS } = await import("../src/services/ai/teacherChat");
{
  const T = () => useTeacher.getState();
  eq(T().conversations.map((c) => c.id), ["old-1"], "保存データ: 形の崩れた会話・発言の無い会話・重複した ID を読まない");
  const old = T().conversations[0];
  eq(
    old.messages.map((m) => [m.role, m.text, m.model ?? null, m.stopped ?? false]),
    [
      ["user", "Primeira pergunta inventada", null, false],
      ["assistant", "Resposta.", "gemini-3.8-flash", true],
    ],
    "保存データ: 形の崩れた発言を落とす（モデル・停止の印は読む）"
  );
  eq([old.title, old.context?.data, (old as unknown as { future?: string }).future], ["Primeira pergunta inventada", { line: "Terceira linha aqui" }, "項目"], "保存データ: 題が無ければ最初の質問から・文脈を読む・知らない項目は残す");

  T().clearAll();
  eq(T().conversations, [], "clearAll: すべて消す");
  const at = (m: number) => `2026-09-27T10:${String(m).padStart(2, "0")}:00.000Z`;
  const a = T().newConversation({ context: generalContext("クイズ"), at: at(0) });
  T().append(a, { role: "user", text: "Como se diz 'obrigado' de um jeito informal?\n2行目", at: at(1) });
  T().append(a, { role: "assistant", text: "Valeu!", at: at(2), model: "gemini-3.8-flash" });
  const b = T().newConversation({ at: at(3) });
  T().append(b, { role: "user", text: "Outra pergunta", at: at(4) });
  eq(T().conversations.map((c) => c.id), [b, a], "並び: 更新の新しい順");
  eq([T().conversations[1].title, T().conversations[1].contextLabel], ["Como se diz 'obrigado' de um…", "📍 クイズ"], "題は最初の質問の1行目（30文字まで）・文脈のチップ");
  T().append(a, { role: "user", text: "Mais uma", at: at(5) });
  eq(T().conversations.map((c) => c.id), [a, b], "発言を足した会話が先頭へ");
  T().updateLast(a, { text: "Mais uma, por favor", stopped: true });
  eq(T().conversations[0].messages[2], { role: "user", text: "Mais uma, por favor", at: at(5), stopped: true }, "updateLast: 最後の発言を直す");
  T().setContext(a, null);
  ok(!("context" in T().conversations[0]) && !("contextLabel" in T().conversations[0]), "setContext(null): 文脈を外す");
  T().setContext(a, wordContext({ pt: "valeu", ja: "ありがとう" }));
  eq(T().conversations[0].contextLabel, "📖 valeu", "setContext: 文脈を替える");
  T().remove(b);
  eq(T().conversations.map((c) => c.id), [a], "remove: 会話を1つ消す");

  // 発言の上限（古い発言から消す）
  for (let i = 0; i < MAX_MESSAGES + 5; i++) T().append(a, { role: i % 2 ? "assistant" : "user", text: `m${i}`, at: `2026-09-27T11:${String(i % 60).padStart(2, "0")}:00.000Z` });
  const msgs = T().conversations[0].messages;
  eq([MAX_MESSAGES, msgs.length, msgs[msgs.length - 1].text, msgs[0].text], [100, 100, `m${MAX_MESSAGES + 4}`, "m5"], "1つの会話は 100 発言まで（古い発言から消す）");
  // 会話の上限（更新の古い会話から消す）
  T().clearAll();
  const ids: string[] = [];
  for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
    const id = T().newConversation({ at: `2026-09-${String(10 + (i % 18)).padStart(2, "0")}T00:00:${String(i).padStart(2, "0")}.000Z` });
    T().append(id, { role: "user", text: `Pergunta ${i}`, at: `2026-09-27T12:00:${String(i).padStart(2, "0")}.000Z` });
    ids.push(id);
  }
  eq([MAX_CONVERSATIONS, T().conversations.length], [30, 30], "会話は 30件まで");
  eq(T().conversations[0].id, ids[ids.length - 1], "一番新しい会話が先頭");
  ok(!T().conversations.some((c) => ids.slice(0, 5).includes(c.id)), "更新の古い5件を消す");
  const saved = JSON.parse(mem.get("bp-teacher-v1") ?? "{}") as { state: Record<string, unknown>; version: number };
  eq([Object.keys(saved.state), saved.version, (saved.state.conversations as unknown[]).length], [["conversations"], 0, 30], "保存: bp-teacher-v1 に会話だけ（version 0）");

  // 文字数の合計の上限（最新の会話は必ず残す）
  const big = (id: string, updatedAt: string, n: number) => ({ id, title: "t", createdAt: updatedAt, updatedAt, messages: [{ role: "user" as const, text: "x".repeat(n), at: updatedAt }] });
  const capped = capConversations([big("c1", "2026-09-01", TEXT_BUDGET - 100), big("c2", "2026-09-03", 200), big("c3", "2026-09-02", 50)]);
  eq(capped.map((c) => c.id), ["c2", "c3"], "文字数の合計が上限を超えたら古い会話から消す");
  eq(capConversations([big("only", "2026-09-01", TEXT_BUDGET * 2)]).map((c) => c.id), ["only"], "最新の会話は大きくても残す");
  eq([conversationTitle("\n\n  Oi  gente \n2"), conversationTitle("")], ["Oi gente", "（無題）"], "conversationTitle");
  eq(readConversations("x"), [], "readConversations: 配列でない → []");
  T().clearAll();
}

/** 偽のサービス（streamChat の中身を渡す。呼ばれた内容を記録する） */
function fakeTeacher(run: (o: StreamChatOptions) => Promise<StreamChatResult>, id: "gemini" | "claude" = "gemini"): AiProvider & { calls: StreamChatOptions[] } {
  const calls: StreamChatOptions[] = [];
  return {
    id,
    name: id === "gemini" ? "Gemini" : "Claude",
    model: id === "gemini" ? "gemini-3.8-flash" : "claude-haiku-4-5",
    free: id === "gemini",
    calls,
    streamChat: (o) => {
      calls.push(o);
      return run(o);
    },
    generateJson: () => Promise.reject(new Error("使わない")),
    testConnection: () => Promise.reject(new Error("使わない")),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
/** 検証用の時計（1回ごとに1秒進む） */
const clock = (() => {
  let n = 0;
  return () => new Date(Date.UTC(2026, 8, 27, 13, 0, 0) + 1000 * n++).toISOString();
})();

console.log("=== AI 先生: 送受信（teacherChat・偽のサービス） ===");
{
  const T = () => useTeacher.getState();
  const U = () => useTeacherUi.getState();
  /** 受信中の返事（受信中でなければ null） */
  const runText = () => {
    const r = U().run;
    return r?.status === "streaming" ? r.text : null;
  };
  /** 失敗の run（失敗でなければ null） */
  const runErr = () => {
    const r = U().run;
    return r?.status === "error" ? r : null;
  };
  openTeacher(songLineContext({ title: "Canção Inventada", artist: "Grupo de Teste", lines: SONG_LINES, index: 3 }), "下書き");
  eq([U().open, U().activeId, U().draft, U().context?.kind], [true, null, "下書き", "song-line"], "openTeacher(ctx, question): 新しい会話・質問は下書きに入れるだけ（送らない）");
  eq(T().conversations.length, 0, "openTeacher だけでは会話を作らない（送らない）");

  // 成功: 少しずつ届く返事が run に積み上がり、届き終わったら履歴に入る
  const seen: string[] = [];
  const ok1 = fakeTeacher(async (o) => {
    for (const d of ["Olá, ", "tudo ", "bem?"]) {
      o.onText(d);
      seen.push(runText() ?? "");
      await tick();
    }
    return { text: "Olá, tudo bem?", model: "gemini-3.8-flash" };
  });
  const id = await sendTeacherMessage({ provider: ok1, text: "  この行の意味と文脈を教えて  ", convId: null, context: U().context, profile: PROFILE, now: clock });
  eq(seen, ["Olá, ", "Olá, tudo ", "Olá, tudo bem?"], "受信中: 届いた分が run.text に積み上がる");
  const conv = T().conversations.find((c) => c.id === id);
  eq(
    conv?.messages.map((m) => [m.role, m.text, m.model ?? null]),
    [
      ["user", "この行の意味と文脈を教えて", null],
      ["assistant", "Olá, tudo bem?", "gemini-3.8-flash"],
    ],
    "届き終わったら、質問と返事が履歴に入る（前後の空白は除く）"
  );
  eq([U().run, U().ctrl, U().activeId], [null, null, id], "終わったら run・ctrl を消し、開いている会話はこの会話");
  eq(conv?.contextLabel, "🎵 Canção Inventada — 4行目", "新しい会話に文脈を保存");
  const call = ok1.calls[0];
  ok(call.system.includes("この行: Terceira linha aqui") && call.system.includes("学習した語: 5語"), "送る: システムプロンプトに文脈と学習者のようす");
  eq(call.turns, [{ role: "user", text: "この行の意味と文脈を教えて" }], "送る: 会話（最後は質問）");
  ok(call.signal instanceof AbortSignal, "送る: 中止の signal");

  // 続きの質問: 保存した文脈を使う（options.context は使わない）・文脈を外したら送らない
  const ok2 = fakeTeacher(async () => ({ text: "Sim.", model: "gemini-3.5-flash-lite" }));
  await sendTeacherMessage({ provider: ok2, text: "Mais?", convId: id, context: generalContext("無視される"), profile: PROFILE, now: clock });
  ok(ok2.calls[0].system.includes("この行: Terceira linha aqui") && !ok2.calls[0].system.includes("無視される"), "続きの質問: 会話に保存した文脈を使う");
  eq(ok2.calls[0].turns.map((t) => t.role), ["user", "assistant", "user"], "続きの質問: これまでの会話も送る");
  eq(T().conversations[0].messages[3].model, "gemini-3.5-flash-lite", "答えたモデルを記録（上限で別のモデルが答えたときも分かる）");
  T().setContext(id!, null);
  await sendTeacherMessage({ provider: ok2, text: "E agora?", convId: id, context: null, profile: PROFILE, now: clock });
  ok(!ok2.calls[1].system.includes("# いま見ている内容"), "文脈を外した会話: 文脈を送らない");

  // 停止: 途中まで届いた返事を「停止しました」の印付きで残す
  const slow = fakeTeacher(
    (o) =>
      new Promise((_, reject) => {
        o.onText("Parte ");
        o.signal?.addEventListener("abort", () => reject(new AiError("aborted", "中止しました", { code: "aborted", partialText: "Parte " })));
      })
  );
  const p = sendTeacherMessage({ provider: slow, text: "Explique devagar", convId: id, context: null, profile: PROFILE, now: clock });
  await tick();
  eq([U().run?.status, runText()], ["streaming", "Parte "], "停止の前: 受信中");
  abortTeacherRun();
  await p;
  const last = T().conversations[0].messages.at(-1);
  eq([last?.role, last?.text, last?.stopped], ["assistant", "Parte ", true], "停止: 途中までの返事を印付きで残す");
  eq([U().run, U().ctrl], [null, null], "停止: run を消す");

  // 停止（上限で 3.5 Flash-Lite が答えていた）: 途中までの返事は、答えていたモデルの名前で残す
  const fellBack = fakeTeacher(
    (o) =>
      new Promise((_, reject) => {
        o.onText("Metade ");
        o.signal?.addEventListener("abort", () =>
          reject(new AiError("aborted", "中止しました", { code: "aborted", partialText: "Metade ", model: "gemini-3.5-flash-lite" }))
        );
      })
  );
  const pF = sendTeacherMessage({ provider: fellBack, text: "Fale mais", convId: id, context: null, profile: PROFILE, now: clock });
  await tick();
  abortTeacherRun();
  await pF;
  const lastF = T().conversations[0].messages.at(-1);
  eq([lastF?.text, lastF?.model, lastF?.stopped], ["Metade ", "gemini-3.5-flash-lite", true], "停止: 答えていたモデル（3.5 Flash-Lite）で残す（設定のモデルではなく）");

  // 停止（まだ1文字も届いていない）: 返事は足さず、「返事が届く前に停止しました」を出す（画面で再試行できる）
  const silent = fakeTeacher((o) => new Promise((_, reject) => o.signal?.addEventListener("abort", () => reject(new AiError("aborted", "中止しました")))));
  const n0 = T().conversations[0].messages.length;
  const p2 = sendTeacherMessage({ provider: silent, text: "Nada", convId: id, context: null, profile: PROFILE, now: clock });
  await tick();
  abortTeacherRun();
  await p2;
  eq(T().conversations[0].messages.length, n0 + 1, "停止（返事なし）: 質問だけ残し、返事は足さない");
  const stopped0 = runErr();
  eq(stopped0 ? [stopped0.kind, stopped0.message, stopped0.convId, U().ctrl] : null, ["aborted", "返事が届く前に停止しました", id, null], "停止（返事なし）: 停止したことを出す（再試行できる）");
  const again0 = fakeTeacher(async () => ({ text: "Agora vai.", model: "gemini-3.8-flash" }));
  await retryTeacher(id!, again0, PROFILE, clock);
  eq([again0.calls[0]?.turns.at(-1)?.text, T().conversations[0].messages.at(-1)?.text, U().run], ["Nada", "Agora vai.", null], "停止（返事なし）→ 再試行: 同じ質問でもう一度頼む");

  // 失敗: 履歴には足さず、run に種類・説明・途中までの返事。再試行で同じ会話にもう一度頼む
  const bad = fakeTeacher(async (o) => {
    o.onText("Meia ");
    throw new AiError("rate-limit", "無料枠の1分あたりの上限に達しました。約37秒待ってから試してください", { code: "429", partialText: "Meia " });
  });
  await sendTeacherMessage({ provider: bad, text: "Pergunta com erro", convId: id, context: null, profile: PROFILE, now: clock });
  const r = runErr();
  eq(r ? [r.kind, r.partial, r.convId] : null, ["rate-limit", "Meia ", id], "失敗: run に種類・途中までの返事");
  ok(!!r && r.message.includes("1分あたりの上限"), "失敗: 日本語の説明");
  eq(T().conversations[0].messages.at(-1)?.text, "Pergunta com erro", "失敗: 返事は履歴に足さない（最後は質問のまま）");
  const again = fakeTeacher(async (o) => {
    o.onText("Agora sim.");
    return { text: "Agora sim.", model: "gemini-3.8-flash" };
  });
  await retryTeacher(id!, again, PROFILE, clock);
  eq([again.calls[0].turns.at(-1)?.text, T().conversations[0].messages.at(-1)?.text, U().run], ["Pergunta com erro", "Agora sim.", null], "再試行: 同じ質問でもう一度頼み、返事を履歴に足す");
  const never = fakeTeacher(async () => ({ text: "x", model: "m" }));
  await retryTeacher(id!, never, PROFILE, clock);
  eq(never.calls.length, 0, "再試行: 最後が返事なら頼まない");

  // 予期しない例外も日本語の失敗にする
  await sendTeacherMessage({ provider: fakeTeacher(() => Promise.reject(new TypeError("x is not a function"))), text: "Oi", convId: id, context: null, profile: PROFILE, now: clock });
  eq([runErr()?.kind, runErr()?.message], ["unknown", "AIの呼び出しに失敗しました"], "予期しない例外 → unknown");

  // キーが無い（provider null）→ no-key
  await sendTeacherMessage({ provider: null, text: "Sem chave", convId: id, context: null, profile: PROFILE, now: clock });
  eq(runErr()?.kind, "no-key", "キーが無い → no-key の失敗（設定へ案内）");

  // 空の質問は何もしない・長すぎる質問は切る
  const before = JSON.stringify(T().conversations);
  eq(await sendTeacherMessage({ provider: ok2, text: "   ", convId: id, context: null, profile: PROFILE, now: clock }), null, "空の質問 → 送らない");
  eq(JSON.stringify(T().conversations), before, "空の質問 → 履歴も変えない");
  // 長い会話にしてから送る（送る会話は最後の 20 発言まで）
  for (let i = 0; i < 12; i++) {
    T().append(id!, { role: "user", text: `Pergunta extra ${i}`, at: clock() });
    T().append(id!, { role: "assistant", text: `Resposta extra ${i}`, at: clock() });
  }
  await sendTeacherMessage({ provider: ok2, text: "あ".repeat(MAX_QUESTION_CHARS + 50), convId: id, context: null, profile: PROFILE, now: clock });
  eq(ok2.calls.at(-1)?.turns.at(-1)?.text.length, MAX_QUESTION_CHARS, `質問は ${MAX_QUESTION_CHARS} 文字まで`);
  eq([ok2.calls.at(-1)?.turns.length, ok2.calls.at(-1)?.turns[0].text], [MAX_TURNS, "Resposta extra 2"], "長い会話でも送るのは最後の 20 発言");

  // 受信中に会話を消す → 止めて、何も足さない
  const hang = fakeTeacher((o) => new Promise((_, reject) => o.signal?.addEventListener("abort", () => reject(new AiError("aborted", "中止しました", { partialText: "Algo" })))));
  const other = T().newConversation({ at: clock() });
  T().append(other, { role: "user", text: "Primeira", at: clock() });
  const p3 = retryTeacher(other, hang, PROFILE, clock);
  await tick();
  deleteTeacherConversation(other);
  await p3;
  ok(!T().conversations.some((c) => c.id === other) && U().run === null, "受信中に会話を消す → 止めて、何も残さない");

  // 存在しない会話に送ると、新しい会話を作る
  const fresh = await sendTeacherMessage({ provider: ok2, text: "Novo", convId: "nao-existe", context: generalContext("ホーム"), profile: PROFILE, now: clock });
  ok(!!fresh && fresh !== "nao-existe" && T().conversations[0].contextLabel === "📍 ホーム", "消えた会話に送る → 新しい会話を作る");

  closeTeacher();
  eq(U().open, false, "closeTeacher");
  openTeacher();
  eq([U().open, U().activeId], [true, fresh], "openTeacher()（文脈なし）: 開いていた会話をそのまま出す");
  closeTeacher();
  clearTeacherHistory();
  eq([T().conversations, U().activeId, U().run], [[], null, null], "clearTeacherHistory: 履歴・開いている会話・受信を消す");
}

console.log("=== AI 先生: 会話の履歴はバックアップに入らない ===");
{
  const MARK = "PERGUNTA_INVENTADA_PARA_TESTE";
  const T = () => useTeacher.getState();
  const c = T().newConversation({ context: songLineContext({ title: "Canção Inventada", artist: "Grupo", lines: [`Linha ${MARK}`], index: 0 }), at: clock() });
  T().append(c, { role: "user", text: MARK, at: clock() });
  T().append(c, { role: "assistant", text: `Resposta ${MARK}`, at: clock() });
  ok((mem.get("bp-teacher-v1") ?? "").includes(MARK), "前提: 会話は bp-teacher-v1 に保存されている");
  const { exportAll, importAll, resetAllProgress } = await import("../src/store/backup");
  const json = exportAll();
  ok(!json.includes(MARK) && !json.includes("bp-teacher") && !json.includes("conversations"), "書き出しに会話・歌詞の行・ストアの名前が入らない");
  const forged = JSON.parse(json) as Record<string, unknown>;
  forged.conversations = [{ id: "x", messages: [{ role: "user", text: "de fora", at: "t" }] }];
  forged["bp-teacher-v1"] = { state: { conversations: [] } };
  ok(importAll(JSON.stringify(forged), "replace").ok && importAll(JSON.stringify(forged), "merge").ok, "会話を紛れ込ませたファイルも取り込める");
  eq(T().conversations.map((x) => x.id), [c], "置き換え・統合の取り込みで会話は変わらない");
  resetAllProgress();
  eq(T().conversations.map((x) => x.id), [c], "進捗のリセットでは会話を消さない");
  ok(![...mem.entries()].some(([k, v]) => k !== "bp-teacher-v1" && v.includes(MARK)), "会話は bp-teacher-v1 のほかのどこにも保存されない");
  clearTeacherHistory();
}

console.log("=== アプリを2つ開いている（別の窓が書き換えた）: 保存データを読み直す ===");
{
  const { syncTeacherFromStorage } = await import("../src/store/useTeacher");
  const { syncSecretsFromStorage } = await import("../src/store/useSecrets");
  const { useAiRunStore } = await import("../src/store/aiRun");
  const T = () => useTeacher.getState();
  const U = () => useTeacherUi.getState();
  const GONE = "PERGUNTA_APAGADA_NO_OUTRO";
  const emptyTeacher = JSON.stringify({ state: { conversations: [] }, version: 0 });

  // この窓（B）には古い会話が残っている。別の窓（A）が会話の履歴をすべて消した
  const oldId = T().newConversation({ at: clock() });
  T().append(oldId, { role: "user", text: GONE, at: clock() });
  mem.set("bp-teacher-v1", emptyTeacher);
  await syncTeacherFromStorage("bp-settings-v1");
  eq(T().conversations.map((c) => c.id), [oldId], "関係ないキーの変更では読み直さない");
  await syncTeacherFromStorage("bp-teacher-v1");
  eq(T().conversations, [], "別の窓で消した会話は、この窓からも消える");
  const nid = T().newConversation({ at: clock() });
  T().append(nid, { role: "user", text: "Nova pergunta", at: clock() });
  const savedT = mem.get("bp-teacher-v1") ?? "";
  ok(savedT.includes("Nova pergunta") && !savedT.includes(GONE), "この窓で次に保存しても、消した会話を書き戻さない");
  mem.delete("bp-teacher-v1");
  await syncTeacherFromStorage(null);
  eq(T().conversations, [], "localStorage をまるごと消した（key null）→ 読み直して空");

  // 受信中の会話を別の窓が消した → この窓の返事も止める（消した会話に書き戻さない）
  const hang2 = fakeTeacher((o) => new Promise((_, reject) => o.signal?.addEventListener("abort", () => reject(new AiError("aborted", "中止しました", { partialText: "Algo" })))));
  const cid = T().newConversation({ at: clock() });
  T().append(cid, { role: "user", text: "Pergunta em andamento", at: clock() });
  const pr = retryTeacher(cid, hang2, PROFILE, clock);
  await tick();
  eq(U().run?.status, "streaming", "前提: 受信中");
  mem.set("bp-teacher-v1", emptyTeacher);
  await syncTeacherFromStorage("bp-teacher-v1");
  await pr;
  ok(hang2.calls[0]?.signal?.aborted === true && U().run === null && U().ctrl === null, "受信中の会話が別の窓で消された → 返事を止める");
  ok(!T().conversations.some((c) => c.id === cid) && !(mem.get("bp-teacher-v1") ?? "").includes("Algo"), "止めた返事も書き戻さない");

  // キー: 別の窓（A）が Claude のキーを削除した。この窓（B）で Gemini のキーを替えても、削除したキーを書き戻さない
  useSecrets.getState().setGeminiApiKey(GKEY);
  useSecrets.getState().setAnthropicApiKey(CKEY);
  const aiCtrl = new AbortController();
  const tCtrl = new AbortController();
  useAiRunStore.setState({ ctrl: aiCtrl });
  useTeacherUi.setState({ ctrl: tCtrl });
  mem.set("bp-secrets-v1", JSON.stringify({ state: { geminiApiKey: GKEY, anthropicApiKey: null }, version: 0 }));
  await syncSecretsFromStorage("bp-teacher-v1");
  eq(useSecrets.getState().anthropicApiKey, CKEY, "関係ないキーの変更では読み直さない");
  await syncSecretsFromStorage("bp-secrets-v1");
  eq([useSecrets.getState().geminiApiKey, useSecrets.getState().anthropicApiKey], [GKEY, null], "別の窓で削除したキーは、この窓でも消える");
  ok(aiCtrl.signal.aborted && tCtrl.signal.aborted, "キーが変わった → 通信中の AI 翻訳・先生の返事を止める（削除したキーで通信を続けない）");
  const GKEY2 = `${GKEY}-novo`;
  useSecrets.getState().setGeminiApiKey(GKEY2);
  const savedS = mem.get("bp-secrets-v1") ?? "";
  ok(savedS.includes(GKEY2) && !savedS.includes(CKEY), "この窓でもう一方のキーを保存しても、削除したキーを書き戻さない");
  const tCtrl2 = new AbortController();
  useTeacherUi.setState({ ctrl: tCtrl2 });
  await syncSecretsFromStorage("bp-secrets-v1");
  ok(!tCtrl2.signal.aborted, "キーが変わらなければ止めない");
  mem.delete("bp-secrets-v1");
  await syncSecretsFromStorage(null);
  eq([useSecrets.getState().geminiApiKey, useSecrets.getState().anthropicApiKey, tCtrl2.signal.aborted], [null, null, true], "localStorage をまるごと消した（key null）→ キーも消え、通信を止める");
  useAiRunStore.setState({ ctrl: null, run: null });
  useTeacherUi.setState({ ctrl: null, run: null });
}

// ---------------------------------------------------------------------------
// ソースの見張り
// ---------------------------------------------------------------------------

console.log("=== ソースの見張り（SDK を静的に読み込まない・HTML として差し込まない） ===");
{
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name)) files.push(p);
    }
  };
  walk("src");
  ok(files.length > 20, "src のファイルを読めた");
  const staticSdk = /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["'](?:@google\/genai|@anthropic-ai\/sdk)(?:\/[^"']*)?["']|^\s*import\s+["'](?:@google\/genai|@anthropic-ai\/sdk)/m;
  const offenders = files.filter((f) => staticSdk.test(readFileSync(f, "utf8")));
  eq(offenders, [], "SDK（@google/genai・@anthropic-ai/sdk）を静的に import しない（型だけ。本体は dynamic import）");
  const dynamicUsers = files.filter((f) => /import\(\s*["'](?:@google\/genai|@anthropic-ai\/sdk)["']\s*\)/.test(readFileSync(f, "utf8").replace(/typeof import\(/g, ""))).map((f) => f.replace(/\\/g, "/"));
  eq(dynamicUsers.sort(), ["src/services/ai/claude.ts", "src/services/ai/gemini.ts"], "SDK を読み込むのは services/ai の2つだけ");
  const html = files.filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML/.test(readFileSync(f, "utf8")));
  eq(html, [], "HTML として差し込まない（AI の返事は React の文字として出す）");
  const aiFiles = files.filter((f) => /services[\\/]ai[\\/]|useSecrets|useTeacher|aiTranslate|components[\\/]teacher[\\/]/.test(f));
  const logs = aiFiles.filter((f) => /console\.(log|info|debug|warn|error)\(/.test(readFileSync(f, "utf8")));
  eq(logs, [], "AI・キー・AI 先生のコードはログに出さない");
  const norm = (f: string) => f.replace(/\\/g, "/");
  const teacherKeyUsers = files.filter((f) => readFileSync(f, "utf8").includes("bp-teacher-v1")).map(norm);
  eq(teacherKeyUsers, ["src/store/useTeacher.ts"], "会話の履歴のストア（bp-teacher-v1）を使うのは useTeacher.ts だけ");
  const backupCode = files.filter((f) => /store[\\/](backup|backupFormat|merge)\.ts$/.test(f));
  ok(
    backupCode.length === 3 && backupCode.every((f) => !/useTeacher|bp-teacher|teacherChat/.test(readFileSync(f, "utf8"))),
    "バックアップ・統合のコードは会話の履歴を読まない・書かない"
  );
  const teacherUi = files.filter((f) => /components[\\/]teacher[\\/]/.test(f));
  ok(teacherUi.length >= 4 && teacherUi.every((f) => !/innerHTML|dangerouslySetInnerHTML|outerHTML/.test(readFileSync(f, "utf8"))), "AI 先生の画面は返事を HTML として差し込まない");
}

eq(fetchCalls, 0, "この検証の間、globalThis.fetch は一度も呼ばれない（実際に通信しない）");
globalThis.fetch = savedFetch;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
