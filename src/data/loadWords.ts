// ============================================================================
// 学習データの読み込み・正規化・ID付与・発音/例文のマージ
// ============================================================================

import wordsRaw from "../../data/words.json";
import capoeiraRaw from "../../data/capoeira-words.json";
import dictRaw from "../../data/dict-words.json";
import examplesRaw from "../../data/examples.json";
import overridesRaw from "../../data/pronunciation-overrides.json";
import coreOrderRaw from "../../data/core-order.json";
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

/**
 * カポエイラ語の訳「カタカナの読み（意味）」。読みは綴りの音写なので、和→葡の問いに出すと答えが見える。
 * 読みの区切りは「・」のほか、データに混ざっている半角の中黒（· U+00B7、･ U+FF65）も読みの一部とみなす。
 */
const KANA_GLOSS_RE = /^[\p{Script=Katakana}・ー·･\s]+（(.+)）$/u;
const KANA_ONLY_RE = /^[\p{Script=Katakana}・ー·･\s]*$/u;

/**
 * カポエイラ語の訳を「意味」と「解説（元の訳）」に分ける（純関数。データは書き換えない）。
 * 形が合わない・括弧の中が空・括弧の中もカタカナだけ、のときは元の訳のまま（note なし）。
 * 例: "ジンガ（カポエイラの基本となる…ステップ動作）" → { ja: "カポエイラの基本となる…ステップ動作", note: 元の訳 }
 */
export function splitKanaGloss(ja: string): { ja: string; note?: string } {
  const m = KANA_GLOSS_RE.exec(ja);
  if (!m) return { ja };
  const inner = m[1].trim();
  if (KANA_ONLY_RE.test(inner)) return { ja };
  return { ja: inner, note: ja };
}

/** 生データ1件を正規化済みの単語にする（id 省略時はソース内インデックス基準） */
export function makeWord(r: RawWord, source: WordSource, index: number, id = `${source}:${pad(index)}`): Word {
  const pt = r.ポルトガル語;
  const { kana, ipa } = transliterate(pt);
  // カポエイラ語だけ、訳の先頭の読みを外して解説に回す（実行時のみ）
  const gloss = source === "capoeira" ? splitKanaGloss(r.日本語) : { ja: r.日本語 };
  return {
    id,
    source,
    index,
    category: r.カテゴリ,
    pt,
    ja: gloss.ja,
    ...(gloss.note !== undefined ? { note: gloss.note } : {}),
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

// ---------------------------------------------------------------------------
// 新規語の導入順（data/core-order.json。scripts/build-core-order.ts で作る）。
// 最初に学ぶ約150語の ID を学ぶ順に並べたもの。ID を参照するだけで、単語データは書き換えない。
// ---------------------------------------------------------------------------
function readCoreOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** コア語の ID（学ぶ順。words / capoeira / dict が混ざる） */
export const CORE_ORDER: readonly string[] = readCoreOrder(coreOrderRaw as unknown);

/**
 * コア語に入っている dict の ID（削除済みを除く）。dict 語は通常「曲から追加した間だけ」復習の対象だが、
 * コア語として導入した dict 語は reviewPool に常に含める（含めないと、そのカードが復習に出ない）。
 */
export const CORE_DICT_IDS: readonly string[] = CORE_ORDER.filter((id) => {
  if (!id.startsWith("dict:")) return false;
  const r = DICT_RAW[Number(id.slice(5))];
  return !!r && r.品詞 !== DELETED_POS;
});

/**
 * 復習対象になりうる語の集合 = 単語帳の全語 + コア語の dict 語（CORE_DICT_IDS。常に含める）
 * + 曲から追加した dict/user 語。
 * 追加語は addedWords にある間だけ含める（削除した語が復習に出続けないように）。
 */
export function reviewPool(addedIds: Iterable<string>, userMap?: Map<string, Word>): Word[] {
  const out = [...ALL_WORDS];
  const seen = new Set<string>();
  for (const id of CORE_DICT_IDS) {
    if (seen.has(id)) continue;
    seen.add(id);
    const w = resolveWord(id);
    if (w) out.push(w);
  }
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

/**
 * 単語帳・クイズの URL の deckId（/flashcards/:deckId・/quiz/:deckId）の中身。
 *   today = 今日の学習、music = 曲から追加した全語、music:<videoId> = その曲の語、数字 = ALL_DECKS の番号
 * 知らない ID（範囲外の番号・数字以外）は null。
 */
export type DeckRef =
  | { kind: "today" }
  | { kind: "music"; videoId: string | null }
  | { kind: "deck"; index: number; deck: Deck };

export function parseDeckId(deckId: string): DeckRef | null {
  if (deckId === "today") return { kind: "today" };
  if (deckId === "music") return { kind: "music", videoId: null };
  if (deckId.startsWith("music:")) return { kind: "music", videoId: deckId.slice(6) || null };
  if (!/^\d+$/.test(deckId)) return null;
  const index = Number(deckId);
  const deck = ALL_DECKS[index];
  return deck ? { kind: "deck", index, deck } : null;
}

/**
 * デッキの語（Flashcards と Quiz で共通）。曲のデッキは addedWords（useMusic）から、同じ語は1回。
 * 今日の学習（today）は日ごとに組み立てる（useTodayPlan）ので対象外で null。知らない ID も null。
 */
export function resolveDeckWords(
  deckId: string,
  addedWords: readonly { id: string; videoId: string }[],
  userMap?: Map<string, Word>
): Word[] | null {
  const ref = parseDeckId(deckId);
  if (!ref || ref.kind === "today") return null;
  if (ref.kind === "deck") return ref.deck.words;
  const ids = [...new Set(addedWords.filter((w) => !ref.videoId || w.videoId === ref.videoId).map((w) => w.id))];
  return ids.map((id) => resolveWord(id, userMap)).filter((w): w is Word => !!w);
}

/**
 * デッキの見出し（「挨拶 (1/3)」「🎵 曲名」「今日の学習」）。知らない ID は null。
 * 曲名は data/music を読むので呼び出し側から渡す（loadWords は music を読み込まない）。
 */
export function deckTitle(deckId: string, songTitle?: (videoId: string) => string | undefined): string | null {
  const ref = parseDeckId(deckId);
  if (!ref) return null;
  switch (ref.kind) {
    case "today":
      return "今日の学習";
    case "music":
      return ref.videoId ? `🎵 ${songTitle?.(ref.videoId) ?? "曲の単語"}` : "🎵 曲の単語";
    case "deck":
      return ref.deck.totalParts > 1 ? `${ref.deck.category} (${ref.deck.part}/${ref.deck.totalParts})` : ref.deck.category;
  }
}

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
