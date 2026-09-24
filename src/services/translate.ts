// ============================================================================
// 翻訳サービス（抽象化）— audio.ts の AudioProvider と同じく差し替え前提。
// 既定: Google 翻訳の無料エンドポイント(gtx, APIキー不要) → 失敗時 MyMemory。
// 端末からユーザー操作で呼び出し、結果は端末内にだけ保存する。
// 検証に通らなかった応答は例外にして、呼び出し側が保存しないようにする。
// ============================================================================

export interface TranslateProvider {
  readonly name: string;
  /** lines と同じ長さ・同じ順序の訳を返す。失敗時は例外 */
  translate(lines: string[], signal?: AbortSignal): Promise<string[]>;
}

export class TranslateQuotaError extends Error {}

const SRC = "pt";
const DST = "ja";

/** 1リクエストあたりの文字数でバッチに分ける */
function batches(lines: string[], maxChars: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const l of lines) {
    if (cur.length && len + l.length + 1 > maxChars) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(l);
    len += l.length + 1;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

class GoogleGtxProvider implements TranslateProvider {
  readonly name = "Google翻訳";

  private async request(text: string, signal?: AbortSignal): Promise<string> {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&dt=t" +
      `&sl=${SRC}&tl=${DST}&q=${encodeURIComponent(text)}`;
    const r = await fetch(url, { signal });
    if (r.status === 429) throw new TranslateQuotaError("翻訳サービスが混み合っています");
    if (!r.ok) throw new Error(`翻訳エラー (${r.status})`);
    const j: unknown = await r.json();
    if (!Array.isArray(j) || !Array.isArray(j[0])) throw new Error("翻訳の応答形式が不正です");
    return (j[0] as unknown[])
      .map((seg) => (Array.isArray(seg) && typeof seg[0] === "string" ? seg[0] : ""))
      .join("");
  }

  async translate(lines: string[], signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    for (const batch of batches(lines, 1500)) {
      const joined = await this.request(batch.join("\n"), signal);
      const parts = joined.split("\n").map((s) => s.trim());
      if (parts.length === batch.length) out.push(...parts);
      else out.push(...(await mapLimit(batch, 3, (l) => this.request(l, signal).then((s) => s.trim()))));
    }
    return out;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

class MyMemoryProvider implements TranslateProvider {
  readonly name = "MyMemory";

  private async request(text: string, signal?: AbortSignal): Promise<string> {
    const url = `https://api.mymemory.translated.net/get?langpair=${SRC}-BR|${DST}&q=${encodeURIComponent(text)}`;
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`翻訳エラー (${r.status})`);
    const j = (await r.json()) as {
      responseStatus?: number | string;
      quotaFinished?: boolean;
      responseData?: { translatedText?: string };
    };
    // エラーも HTTP 200 で返るため、本文のステータスで判定する
    if (j.quotaFinished) throw new TranslateQuotaError("本日の無料翻訳の上限に達しました");
    if (Number(j.responseStatus) !== 200 || typeof j.responseData?.translatedText !== "string") {
      throw new Error("翻訳に失敗しました");
    }
    return decodeEntities(j.responseData.translatedText);
  }

  async translate(lines: string[], signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    for (const batch of batches(lines, 450)) {
      const joined = await this.request(batch.join("\n"), signal);
      const parts = joined.split("\n").map((s) => s.trim());
      if (parts.length === batch.length) out.push(...parts);
      else out.push(...(await mapLimit(batch, 2, (l) => this.request(l.slice(0, 450), signal).then((s) => s.trim()))));
    }
    return out;
  }
}

const PROVIDERS: TranslateProvider[] = [new GoogleGtxProvider(), new MyMemoryProvider()];

/** 行を翻訳（プロバイダを順に試す）。全プロバイダ失敗時は最後のエラーを投げる */
export async function translateLines(lines: string[], signal?: AbortSignal): Promise<string[]> {
  if (lines.length === 0) return [];
  let lastErr: unknown;
  for (const p of PROVIDERS) {
    try {
      const out = await p.translate(lines, signal);
      if (out.length !== lines.length) throw new Error("翻訳の行数が一致しません");
      return out;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("翻訳に失敗しました");
}

export async function translateText(text: string, signal?: AbortSignal): Promise<string> {
  const [out] = await translateLines([text], signal);
  return out;
}
