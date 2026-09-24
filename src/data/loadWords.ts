// ============================================================================
// 学習データの読み込み・正規化・ID付与・発音/例文のマージ
// ============================================================================

import wordsRaw from "../../data/words.json";
import capoeiraRaw from "../../data/capoeira-words.json";
import dictRaw from "../../data/dict-words.json";
import examplesRaw from "../../data/examples.json";
import overridesRaw from "../../data/pronunciation-overrides.json";
import type { RawWord, Word, WordExtra, WordSource } from "./types";
import { cleanForSpeech } from "../services/audio";
import { registerOverrides, toKana, transliterate } from "../services/pronunciation";

// 例外辞書を登録（"_" で始まるメタキーは除外）
const overrideMap: Record<string, { kana: string; ipa: string }> = {};
for (const [k, v] of Object.entries(overridesRaw as Record<string, unknown>)) {
  if (k.startsWith("_")) continue;
  if (v && typeof v === "object" && "kana" in v && "ipa" in v) {
    overrideMap[k] = v as { kana: string; ipa: string };
  }
}
registerOverrides(overrideMap);

const examples = examplesRaw as Record<string, WordExtra>;

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

/** 生データ1件を正規化済みの単語にする（id 省略時はソース内インデックス基準） */
export function makeWord(r: RawWord, source: WordSource, index: number, id = `${source}:${pad(index)}`): Word {
  const pt = r.ポルトガル語;
  const { kana, ipa } = transliterate(pt);
  return {
    id,
    source,
    index,
    category: r.カテゴリ,
    pt,
    ja: r.日本語,
    pos: r.品詞,
    ptForSpeech: cleanForSpeech(pt),
    kana,
    ipa,
  };
}

function normalize(raw: RawWord[], source: WordSource): Word[] {
  return raw.map((r, index) => makeWord(r, source, index));
}

export const WORDS_GENERAL: Word[] = normalize(wordsRaw as RawWord[], "words");
export const WORDS_CAPOEIRA: Word[] = normalize(capoeiraRaw as RawWord[], "capoeira");
export const ALL_WORDS: Word[] = [...WORDS_GENERAL, ...WORDS_CAPOEIRA];

export const WORD_BY_ID: Map<string, Word> = new Map(ALL_WORDS.map((w) => [w.id, w]));

// ---------------------------------------------------------------------------
// 歌詞引き用の一般辞書（dict-words.json）。語数が多いので起動時には変換せず、
// 必要になった語だけ makeWord する（カナ/IPA生成のコストを抑える）。
// dict-words.json は追記専用: ID "dict:NNNN" がインデックス基準のため並べ替え・削除禁止。
// ---------------------------------------------------------------------------
export const DICT_RAW: RawWord[] = dictRaw as RawWord[];
const DELETED_POS = "_deleted";
const dictCache = new Map<number, Word>();

export function getDictWord(index: number): Word | undefined {
  const cached = dictCache.get(index);
  if (cached) return cached;
  const r = DICT_RAW[index];
  if (!r || r.品詞 === DELETED_POS) return undefined;
  const w = makeWord(r, "dict", index);
  dictCache.set(index, w);
  return w;
}

/** ユーザーが意味を入力して追加した語（useMusic.userWords）の生データ */
export interface UserWordRaw {
  id: string; // "user:<正規化したポルトガル語>"
  pt: string;
  ja: string;
  pos: string;
}

const userCache = new Map<string, { raw: UserWordRaw; word: Word }>();

export function makeUserWord(u: UserWordRaw): Word {
  const hit = userCache.get(u.id);
  if (hit && hit.raw.pt === u.pt && hit.raw.ja === u.ja && hit.raw.pos === u.pos) return hit.word;
  const word = makeWord({ カテゴリ: "曲の単語", ポルトガル語: u.pt, 日本語: u.ja, 品詞: u.pos }, "user", -1, u.id);
  userCache.set(u.id, { raw: u, word });
  return word;
}

export function userWordMap(list: UserWordRaw[]): Map<string, Word> {
  return new Map(list.map((u) => [u.id, makeUserWord(u)]));
}

/** 単語IDから単語を引く唯一の窓口（words/capoeira/dict/user）。解決できないIDは undefined */
export function resolveWord(id: string, userMap?: Map<string, Word>): Word | undefined {
  const w = WORD_BY_ID.get(id);
  if (w) return w;
  if (id.startsWith("dict:")) return getDictWord(Number(id.slice(5)));
  if (id.startsWith("user:")) return userMap?.get(id);
  return undefined;
}

/**
 * 復習対象になりうる語の集合 = 単語帳の全語 + 曲から追加した dict/user 語。
 * 追加語は addedWords にある間だけ含める（削除した語が復習に出続けないように）。
 */
export function reviewPool(addedIds: Iterable<string>, userMap?: Map<string, Word>): Word[] {
  const out = [...ALL_WORDS];
  const seen = new Set<string>();
  for (const id of addedIds) {
    if (seen.has(id) || WORD_BY_ID.has(id)) continue;
    seen.add(id);
    const w = resolveWord(id, userMap);
    if (w) out.push(w);
  }
  return out;
}

const extraCache = new Map<string, WordExtra | undefined>();

/** 単語に紐づく例文・コロケーション（ポルトガル語キーで検索。例文のカナは自動生成） */
export function getExtra(word: Word): WordExtra | undefined {
  // 辞書語・ユーザー語は同綴りの別語(例: roda=車輪 と カポエイラのホーダ)に例文が付かないよう除外
  if (word.source === "dict" || word.source === "user") return undefined;
  const key = word.pt.toLowerCase();
  if (extraCache.has(key)) return extraCache.get(key);
  const raw = examples[key] ?? examples[word.pt];
  const enriched: WordExtra | undefined = raw
    ? {
        ...raw,
        examples: raw.examples?.map((ex) => ({ ...ex, kana: ex.kana ?? toKana(ex.pt) })),
      }
    : undefined;
  extraCache.set(key, enriched);
  return enriched;
}

export interface Deck {
  id: string;
  source: WordSource;
  category: string;
  part: number; // 1始まり
  totalParts: number;
  words: Word[];
}

const DECK_SIZE = 50;

function buildDecks(words: Word[], source: WordSource): Deck[] {
  const byCat = new Map<string, Word[]>();
  for (const w of words) {
    if (!byCat.has(w.category)) byCat.set(w.category, []);
    byCat.get(w.category)!.push(w);
  }
  const decks: Deck[] = [];
  for (const [category, list] of byCat) {
    const totalParts = Math.ceil(list.length / DECK_SIZE);
    for (let p = 0; p < totalParts; p++) {
      const slice = list.slice(p * DECK_SIZE, (p + 1) * DECK_SIZE);
      decks.push({
        id: `${source}:${category}:${p + 1}`,
        source,
        category,
        part: p + 1,
        totalParts,
        words: slice,
      });
    }
  }
  return decks;
}

export const DECKS_GENERAL = buildDecks(WORDS_GENERAL, "words");
export const DECKS_CAPOEIRA = buildDecks(WORDS_CAPOEIRA, "capoeira");
export const ALL_DECKS = [...DECKS_GENERAL, ...DECKS_CAPOEIRA];
export const DECK_BY_ID = new Map(ALL_DECKS.map((d) => [d.id, d]));

/** ソースごとのカテゴリ一覧（出現順を保持） */
export function categoriesOf(source: "words" | "capoeira"): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  let list: Word[];
  switch (source) {
    case "words":
      list = WORDS_GENERAL;
      break;
    case "capoeira":
      list = WORDS_CAPOEIRA;
      break;
    default: {
      const never: never = source;
      throw new Error(`unknown source: ${never}`);
    }
  }
  for (const w of list) {
    if (!set.has(w.category)) {
      set.add(w.category);
      seen.push(w.category);
    }
  }
  return seen;
}

export const STATS = {
  total: ALL_WORDS.length,
  general: WORDS_GENERAL.length,
  capoeira: WORDS_CAPOEIRA.length,
  dict: DICT_RAW.length,
};
