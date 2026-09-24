// ============================================================================
// 作成・検証済みの辞書スライスを dict-words.json に追記する（開発用・追記専用）
//   npx tsx scripts/merge-dict.ts <slice.json...>
// ID が "dict:インデックス" のため、既存項目の並べ替え・削除は行わない。
// 追記後に dict-words.lock.json（各インデックスの見出し）を更新する。
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { RawWord } from "../src/data/types";
import { DICT_POS, existingKeySet, headKey, headKeys, posGroup } from "./dict-common";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "../data");
const load = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8"));

const words = load<RawWord[]>(resolve(dataDir, "words.json"));
const dict = load<RawWord[]>(resolve(dataDir, "dict-words.json"));
const lock = load<string[]>(resolve(dataDir, "dict-words.lock.json"));

for (let i = 0; i < lock.length; i++) {
  if (dict[i]?.ポルトガル語 !== lock[i]) {
    console.error(`✗ dict-words.json が lock と一致しません（#${i}）。追記専用のため中止します。`);
    process.exit(1);
  }
}

const existing = existingKeySet([words, dict]);
let added = 0;
const skipped: Record<string, number> = {};
const skip = (r: string) => (skipped[r] = (skipped[r] ?? 0) + 1);

for (const file of process.argv.slice(2)) {
  for (const w of load<RawWord[]>(file)) {
    const ok =
      w &&
      typeof w.カテゴリ === "string" &&
      typeof w.ポルトガル語 === "string" &&
      typeof w.日本語 === "string" &&
      typeof w.品詞 === "string" &&
      w.カテゴリ.trim() &&
      w.ポルトガル語.trim() &&
      w.日本語.trim() &&
      (DICT_POS as readonly string[]).includes(w.品詞.trim());
    if (!ok) {
      skip("形式不正");
      continue;
    }
    const entry: RawWord = {
      カテゴリ: w.カテゴリ.trim(),
      ポルトガル語: w.ポルトガル語.normalize("NFC").trim(),
      日本語: w.日本語.normalize("NFC").trim(),
      品詞: w.品詞.trim(),
    };
    if (!/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(entry.日本語)) {
      skip("日本語が無い");
      continue;
    }
    const keys = headKeys(entry.ポルトガル語).map((k) => `${k}|${posGroup(entry.品詞)}`);
    if (keys.some((k) => existing.has(k))) {
      skip("重複");
      continue;
    }
    if (headKey(entry.ポルトガル語) !== entry.ポルトガル語.toLowerCase()) entry.ポルトガル語 = headKey(entry.ポルトガル語);
    keys.forEach((k) => existing.add(k));
    dict.push(entry);
    added++;
  }
}

writeFileSync(resolve(dataDir, "dict-words.json"), JSON.stringify(dict, null, 1) + "\n", "utf8");
writeFileSync(resolve(dataDir, "dict-words.lock.json"), JSON.stringify(dict.map((d) => d.ポルトガル語)) + "\n", "utf8");
console.log(`追記 ${added} 語（合計 ${dict.length} 語）`, skipped);
