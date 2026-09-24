// ============================================================================
// 一般辞書(dict-words.json)の検証
//   npm run check:dict
// - 4項目が空でない文字列 / 品詞が許可リスト内（または _deleted）
// - NFC・小文字・前後に記号なし / 動詞は不定詞 / 日本語に仮名か漢字を含む
// - （見出し, 品詞）の重複なし（辞書内・単語帳 words.json と）
// - 追記専用: dict-words.lock.json と先頭から一致
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { RawWord } from "../src/data/types";
import { DELETED, DICT_POS, existingKeySet, headKey, headKeys, posGroup } from "./dict-common";

const here = dirname(fileURLToPath(import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(resolve(here, "../data", name), "utf8"));

const dict = load<RawWord[]>("dict-words.json");
const lock = load<string[]>("dict-words.lock.json");
const wordsKeys = existingKeySet([load<RawWord[]>("words.json")]);

const errors: string[] = [];
const err = (i: number, m: string) => errors.push(`#${i} ${dict[i]?.ポルトガル語 ?? ""}: ${m}`);

if (lock.length > dict.length) errors.push(`lock(${lock.length}) より辞書(${dict.length})が短い（削除は禁止）`);
lock.forEach((pt, i) => {
  if (dict[i] && dict[i].ポルトガル語 !== pt) err(i, `lock と不一致（${pt}）— 並べ替え・書き換え禁止`);
});

const seen = new Set<string>();
dict.forEach((w, i) => {
  for (const f of ["カテゴリ", "ポルトガル語", "日本語", "品詞"] as const) {
    if (typeof w[f] !== "string" || !w[f].trim()) err(i, `${f} が空`);
  }
  if (w.品詞 === DELETED) return;
  if (!(DICT_POS as readonly string[]).includes(w.品詞)) err(i, `品詞「${w.品詞}」は許可リスト外`);
  const pt = w.ポルトガル語;
  if (pt !== pt.normalize("NFC")) err(i, "NFC でない");
  if (pt !== pt.toLowerCase()) err(i, "小文字でない");
  if (headKey(pt) !== pt) err(i, "前後に記号・余分な空白");
  if (w.品詞 === "動詞" && !/(ar|er|ir|pôr|por)$/.test(pt)) err(i, "動詞が不定詞でない");
  if (!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(w.日本語)) err(i, "日本語に仮名・漢字が無い");
  for (const k of headKeys(pt)) {
    const key = `${k}|${posGroup(w.品詞)}`;
    if (wordsKeys.has(key)) err(i, "単語帳 words.json と重複");
    if (seen.has(key)) err(i, "辞書内で重複");
    seen.add(key);
  }
});

console.log(`dict-words.json: ${dict.length} 語（lock ${lock.length}）`);
if (errors.length) {
  console.error(errors.slice(0, 50).join("\n"));
  console.error(`✗ ${errors.length} 件の問題`);
  process.exit(1);
}
console.log("✓ 辞書OK");
