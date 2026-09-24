// ============================================================================
// データ検証 & 発音プレビュー生成スクリプト
//   npm run enrich
// - words.json / capoeira-words.json を読み込み、スキーマを検証
// - 全語のカタカナ/IPAを生成し data/_pronunciation-preview.json に出力
//   （発音の自動生成結果を目視確認し、必要なら pronunciation-overrides.json で補正）
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { registerOverrides, transliterate } from "../src/services/pronunciation";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(here, "../data");

function load<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(dataDir, name), "utf8"));
}

interface RawWord {
  カテゴリ: string;
  ポルトガル語: string;
  日本語: string;
  品詞: string;
}

// 発音例外辞書を登録
const overridesRaw = load<Record<string, unknown>>("pronunciation-overrides.json");
const overrideMap: Record<string, { kana: string; ipa: string }> = {};
for (const [k, v] of Object.entries(overridesRaw)) {
  if (k.startsWith("_")) continue;
  if (v && typeof v === "object" && "kana" in v) overrideMap[k] = v as { kana: string; ipa: string };
}
registerOverrides(overrideMap);

const REQUIRED = ["カテゴリ", "ポルトガル語", "日本語", "品詞"] as const;

function validate(name: string, list: RawWord[]): number {
  let errors = 0;
  list.forEach((w, i) => {
    for (const key of REQUIRED) {
      if (!w[key] || typeof w[key] !== "string") {
        console.warn(`  [${name}#${i}] 欠落/不正フィールド: ${key}`);
        errors++;
      }
    }
  });
  return errors;
}

const general = load<RawWord[]>("words.json");
const capoeira = load<RawWord[]>("capoeira-words.json");

console.log("=== データ検証 ===");
console.log(`words.json         : ${general.length} 語`);
console.log(`capoeira-words.json: ${capoeira.length} 語`);
const errs = validate("words", general) + validate("capoeira", capoeira);
console.log(errs === 0 ? "✓ スキーマOK" : `⚠ ${errs} 件の問題`);

// 付属コンテンツの存在チェック
for (const f of ["examples.json", "patterns.json", "passages.json", "scripts.json", "dictation.json"]) {
  try {
    load(f);
    console.log(`✓ ${f}`);
  } catch {
    console.warn(`⚠ ${f} が読み込めません`);
  }
}

console.log("\n=== 発音プレビュー生成 ===");
const preview = [...general, ...capoeira].map((w, i) => {
  const r = transliterate(w.ポルトガル語);
  return { i, pt: w.ポルトガル語, kana: r.kana, ipa: `/${r.ipa}/`, ja: w.日本語 };
});
writeFileSync(resolve(dataDir, "_pronunciation-preview.json"), JSON.stringify(preview, null, 2), "utf8");
console.log(`✓ data/_pronunciation-preview.json (${preview.length} 語) を出力しました`);
console.log("  自動生成が不自然な語は pronunciation-overrides.json で上書きできます。");
