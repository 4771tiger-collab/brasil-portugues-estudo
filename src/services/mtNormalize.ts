// ============================================================================
// 機械翻訳に送る前の口語形の正規化（純関数）
//   検証: scripts/check-translate.ts（npm run check:translate）
// 歌詞は口語の短縮形（tô, tá, pra, cê, né…）が多く、無料の機械翻訳はこれを誤訳・未訳にしがち。
// 送る前に「意味が1つに決まる」短縮形だけを標準形に直す（訳の質を上げるためだけ。画面の歌詞・保存キーは変えない）。
// - 語の境界で置き換える（前後が文字・数字・ハイフン、または d' のような語の一部なら置き換えない）
// - 大文字小文字を保つ（Tô → Estou、TÔ → ESTOU）
// - 'tá / 'tô のように頭に省略のアポストロフィが付いた形も直す（アポストロフィは外す）
// - 意味が1つに決まらない形は触らない: tão（= estão / とても）、num（= em um / não）、té（= até / 固有名）、
//   to・ta（アクセントなし。別の語・英語の可能性）、vô（= vou / avô）、tiver（ter / estar）など
// data/colloquial.json は辞書引き用の分解表で、do = de+o のような標準の縮約（分解すると訳がかえって崩れる）や
// あいまいな形も含むため使わない。ここでは小さな明示の表を持つ。
// ============================================================================

/**
 * 短縮形 → 標準形（キーは小文字・NFC。' は ' と ’ の両方に一致する）。
 * すべて「意味が1つに決まる」形だけ。
 */
const MT_EXPANSIONS: Readonly<Record<string, string>> = {
  // estar の短縮
  tô: "estou",
  tá: "está",
  tás: "estás",
  tava: "estava",
  tavam: "estavam",
  távamos: "estávamos",
  tamo: "estamos",
  tamos: "estamos",
  // para の短縮
  pra: "para",
  pras: "para as",
  pro: "para o",
  pros: "para os",
  prum: "para um",
  pruma: "para uma",
  procê: "para você",
  // você の短縮
  cê: "você",
  ocê: "você",
  cês: "vocês",
  ocês: "vocês",
  // 決まった言い方
  né: "não é",
  cadê: "onde está",
  vamo: "vamos",
  // bora は「〜しよう / 行こう」（= vamos）。「vamos embora（帰ろう・立ち去ろう）」にすると意味が足されてしまう
  bora: "vamos",
  // d' は母音の前で省略した前置詞 de（copo d'água = 水1杯）。da（de + 冠詞 a）ではない
  "d'água": "de água",
};

/** 頭に省略のアポストロフィが付くことのある形（'tá, 'tô …） */
const APOSTROPHE_FORMS = ["tô", "tá", "tás", "tava", "tavam", "távamos", "tamo", "tamos"];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toPattern = (key: string) => escapeRe(key).replace(/'/g, "['’]");

/** 語の一部とみなす文字（文字・結合文字・数字・_・ハイフン） */
const WORD_CH = "[\\p{L}\\p{M}\\p{N}_-]";
/** 前に語が続いている（文字の直後、または d' のような「文字＋アポストロフィ」の直後） */
const NOT_AFTER_WORD = `(?<!${WORD_CH}|\\p{L}['’])`;
/** 後ろに語が続いている（文字の直前、または 'xxx のような「アポストロフィ＋文字」の直前） */
const NOT_BEFORE_WORD = `(?!${WORD_CH}|['’]\\p{L})`;

const EXPAND_RE = new RegExp(
  `${NOT_AFTER_WORD}(${Object.keys(MT_EXPANSIONS)
    .sort((a, b) => b.length - a.length)
    .map(toPattern)
    .join("|")})${NOT_BEFORE_WORD}`,
  "giu"
);

/** 'tá → tá（アポストロフィだけ外す。続きは EXPAND_RE で直す） */
const APOSTROPHE_RE = new RegExp(
  `(?<!${WORD_CH})['’](?=(?:${APOSTROPHE_FORMS.map(toPattern).join("|")})${NOT_BEFORE_WORD})`,
  "giu"
);

/** 元の語の大文字小文字に合わせる（全部大文字 → 全部大文字 / 先頭が大文字 → 先頭だけ大文字） */
function matchCase(src: string, rep: string): string {
  const letters = src.replace(/[^\p{L}]/gu, "");
  if (letters.length > 1 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return rep.toUpperCase();
  if (/^\p{Lu}/u.test(src)) return rep.charAt(0).toUpperCase() + rep.slice(1);
  return rep;
}

/** 機械翻訳に送る前に、意味の決まる口語の短縮形を標準形に直す（それ以外の文字はそのまま） */
export function normalizeForMT(text: string): string {
  return text
    .normalize("NFC")
    .replace(APOSTROPHE_RE, "")
    .replace(EXPAND_RE, (m: string) => {
      const rep = MT_EXPANSIONS[m.toLowerCase().replace(/’/g, "'")];
      return rep ? matchCase(m, rep) : m;
    });
}
