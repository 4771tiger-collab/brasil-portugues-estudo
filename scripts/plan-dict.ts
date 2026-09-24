// ============================================================================
// 辞書の見出し語計画を機械的に整理し、作成用のスライスに分割する（開発用）
//   npx tsx scripts/plan-dict.ts <見出し計画.json...> --out <出力ディレクトリ> [--slice 400]
// 入力: [{ pt, pos, group }] の配列（一般的な頻度知識から作った原形のリスト）
// - 品詞が許可リスト外 / 大文字・数字を含む / 動詞が不定詞でない → 除外
// - words.json と（キー, 品詞）が重複 → 除外（カポエイラ単語帳とは重複除去しない）
// - 計画内の重複 → 除外
// - 複数形・女性形の見出し（単数・男性形が計画内/単語帳にある）→ 除外
// ============================================================================

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { RawWord } from "../src/data/types";
import { DICT_POS, existingKeySet, headKey, posGroup } from "./dict-common";

interface PlanItem {
  pt: string;
  pos: string;
  group?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const load = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8"));

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outDir = outIdx >= 0 ? args[outIdx + 1] : resolve(here, "../data/_dict-plan");
const sliceIdx = args.indexOf("--slice");
const sliceSize = sliceIdx >= 0 ? Number(args[sliceIdx + 1]) : 400;
const inputs = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--out" && args[i - 1] !== "--slice");

const words = load<RawWord[]>(resolve(here, "../data/words.json"));
const dict = load<RawWord[]>(resolve(here, "../data/dict-words.json"));
const existing = existingKeySet([words, dict]);

const reasons: Record<string, number> = {};
const reject = (r: string) => (reasons[r] = (reasons[r] ?? 0) + 1);

const seen = new Set<string>();
const kept: (PlanItem & { key: string })[] = [];
for (const file of inputs) {
  for (const it of load<PlanItem[]>(file)) {
    const pos = (it.pos ?? "").trim();
    const key = headKey(it.pt ?? "");
    if (!key || !(DICT_POS as readonly string[]).includes(pos)) {
      reject("品詞/空");
      continue;
    }
    if (/\d/.test(key) || /[A-Z]/.test(it.pt.normalize("NFC").replace(/^./, ""))) {
      reject("数字/大文字");
      continue;
    }
    if (pos === "動詞" && !/(ar|er|ir|pôr|por)$/.test(key)) {
      reject("動詞が不定詞でない");
      continue;
    }
    const k = `${key}|${posGroup(pos)}`;
    if (existing.has(k)) {
      reject("単語帳と重複");
      continue;
    }
    if (seen.has(k)) {
      reject("計画内で重複");
      continue;
    }
    seen.add(k);
    kept.push({ ...it, pt: key, pos, key });
  }
}

// 複数形・女性形の見出しを除外（単数・男性形がある場合のみ）
const has = (key: string, pos?: string) =>
  [...seen].some((k) => k.startsWith(key + "|") && (!pos || k.endsWith("|" + pos))) ||
  [...existing].some((k) => k.startsWith(key + "|") && (!pos || k.endsWith("|" + pos)));
const final = kept.filter((it) => {
  if (it.pos === "名詞" || it.pos === "形容詞") {
    const k = it.key;
    const sing = [k.replace(/ões$/, "ão"), k.replace(/es$/, ""), k.replace(/s$/, "")].filter((x) => x !== k);
    if (/s$/.test(k) && sing.some((s) => has(s))) {
      reject("複数形の見出し");
      return false;
    }
    if (it.pos === "形容詞" && /a$/.test(k) && has(k.replace(/a$/, "o"), "形容詞")) {
      reject("女性形の見出し");
      return false;
    }
  }
  return true;
});

mkdirSync(outDir, { recursive: true });
const slices: PlanItem[][] = [];
for (let i = 0; i < final.length; i += sliceSize) {
  slices.push(final.slice(i, i + sliceSize).map(({ pt, pos, group }) => ({ pt, pos, group })));
}
slices.forEach((s, i) => writeFileSync(resolve(outDir, `slice-${String(i + 1).padStart(2, "0")}.json`), JSON.stringify(s, null, 1), "utf8"));

console.log(`入力 ${kept.length + Object.values(reasons).reduce((a, b) => a + b, 0)} 件 → 採用 ${final.length} 件 → ${slices.length} スライス（${outDir}）`);
console.log("除外理由:", reasons);
const byPos: Record<string, number> = {};
final.forEach((f) => (byPos[f.pos] = (byPos[f.pos] ?? 0) + 1));
console.log("品詞別:", byPos);
