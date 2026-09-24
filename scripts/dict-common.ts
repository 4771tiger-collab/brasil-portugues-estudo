// 辞書スクリプト共通: 見出しキーの正規化・許可する品詞
import type { RawWord } from "../src/data/types";

export const DICT_POS = [
  "名詞",
  "動詞",
  "形容詞",
  "副詞",
  "代名詞",
  "前置詞",
  "接続詞",
  "間投詞",
  "数詞",
  "疑問詞",
  "フレーズ",
  "冠詞",
] as const;

export const DELETED = "_deleted";

/** 見出しの比較用キー（NFC・小文字・括弧注記除去・前後の記号除去） */
export function headKey(pt: string): string {
  return pt
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’ʼ‘]/g, "'")
    .replace(/\s*[（(][^）)]*[）)]\s*/g, " ")
    .replace(/^[¿¡?!.,;:…\s]+|[¿¡?!.,;:…\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "meu/minha" → ["meu","minha"] */
export function headKeys(pt: string): string[] {
  const k = headKey(pt);
  const parts = k.split("/").map((x) => x.trim());
  return parts.length > 1 && parts.every(Boolean) ? parts : [k];
}

/** 品詞の大分類（重複判定用: 名詞・形容詞 などの複合ラベルを先頭で代表） */
export function posGroup(pos: string): string {
  return pos.split(/[・（(]/)[0];
}

export function existingKeySet(lists: RawWord[][]): Set<string> {
  const set = new Set<string>();
  for (const list of lists) {
    for (const w of list) {
      if (w.品詞 === DELETED) continue;
      for (const k of headKeys(w.ポルトガル語)) set.add(`${k}|${posGroup(w.品詞)}`);
    }
  }
  return set;
}
