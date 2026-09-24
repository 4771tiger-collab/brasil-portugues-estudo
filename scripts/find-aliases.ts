// ============================================================================
// 別名（同じ意味の重複見出し）の候補を一覧にする（開発用・読み取り専用）
//   npx tsx scripts/find-aliases.ts [--all] [--json]
// 対象: words.json + capoeira-words.json
// 候補 = headKey が同じ（"meu/minha" は各部分）で、和訳の片（括弧を除き・、／/ で分割）が1つでも重なる組。
//   カポエイラ語の「カタカナ（意味）」形の訳は、括弧の中身の片も比べる（外側はカタカナ読みだけのため）。
// 参考として、片が一致はしないが一方がもう一方を含む組（2文字以上。例: 払う ⊂ 支払う）も別枠で出す。
//   部分一致は「オレンジ ⊂ オレンジ色」のような別語も拾うので、特に慎重に確認すること。
// 出力を人が確認し、本当に同じ語だけを data/word-aliases.json に手で登録する:
//   [{ "keep": "words:0294", "alias": ["capoeira:0049"] }]   ← keep は一般語彙側を優先
// --all : 和訳が重ならない同綴りの組（兄弟語）も表示する
// --json: 候補（完全一致の片）から作った登録案（未登録のもの）を JSON で表示する（ファイルには書かない）
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { RawWord } from "../src/data/types";
import { headKeys } from "../src/data/headKey";
import { ALIAS_IDS, ALIAS_KEEP, WORD_ALIASES, jaPieces } from "../src/data/siblings";

const here = dirname(fileURLToPath(import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(resolve(here, "../data", name), "utf8"));

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const showJson = args.includes("--json");

interface Entry {
  id: string;
  source: "words" | "capoeira";
  pt: string;
  ja: string;
  pos: string;
  cat: string;
  pieces: string[];
}

const KATAKANA_GLOSS = /^[\p{Script=Katakana}・ー\s]+[（(](.+)[）)]$/u;

function piecesOf(ja: string): string[] {
  const out = jaPieces(ja);
  const m = ja.normalize("NFC").match(KATAKANA_GLOSS);
  if (m) for (const p of jaPieces(m[1])) if (!out.includes(p)) out.push(p);
  return out;
}

function entries(file: string, source: Entry["source"]): Entry[] {
  const out: Entry[] = [];
  load<RawWord[]>(file).forEach((r, i) => {
    if (r.品詞 === "_deleted") return;
    out.push({
      id: `${source}:${String(i).padStart(4, "0")}`,
      source,
      pt: r.ポルトガル語,
      ja: r.日本語,
      pos: r.品詞,
      cat: r.カテゴリ,
      pieces: piecesOf(r.日本語),
    });
  });
  return out;
}

const all = [...entries("words.json", "words"), ...entries("capoeira-words.json", "capoeira")];

// headKey → 語
const byKey = new Map<string, Entry[]>();
for (const e of all) {
  for (const k of headKeys(e.pt)) {
    if (!k) continue;
    const list = byKey.get(k) ?? [];
    if (!list.includes(e)) list.push(e);
    byKey.set(k, list);
  }
}

interface Pair {
  a: Entry;
  b: Entry;
  keys: string[];
  /** 完全に一致した片 */
  overlap: string[];
  /** 一方がもう一方を含む片（2文字以上。完全一致が無いときだけ） */
  partial: string[];
}

/** 片どうしの部分一致（短い方が2文字以上で、長い方に含まれる） */
function partialOverlap(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const x of a) {
    for (const y of b) {
      if (x === y) continue;
      const [s, l] = x.length <= y.length ? [x, y] : [y, x];
      if (s.length >= 2 && l.includes(s)) out.push(`${s}⊂${l}`);
    }
  }
  return out;
}

const pairMap = new Map<string, Pair>();
for (const [k, list] of byKey) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [a, b] = [list[i], list[j]];
      const id = `${a.id}|${b.id}`;
      const hit = pairMap.get(id);
      if (hit) {
        hit.keys.push(k);
        continue;
      }
      const overlap = a.pieces.filter((p) => b.pieces.includes(p));
      const partial = overlap.length ? [] : partialOverlap(a.pieces, b.pieces);
      pairMap.set(id, { a, b, keys: [k], overlap, partial });
    }
  }
}
const pairs = [...pairMap.values()];
const candidates = pairs.filter((p) => p.overlap.length > 0);
const partials = pairs.filter((p) => p.partial.length > 0);
const siblingsOnly = pairs.filter((p) => p.overlap.length === 0 && p.partial.length === 0);

const fmt = (e: Entry) => `${e.id}  ${e.pt} | ${e.ja} | ${e.pos} | ${e.cat}`;
/** keep 側の優先度: 一般語彙（words）を優先、同じソースなら ID の小さい方 */
const better = (x: Entry, y: Entry): boolean =>
  x.source !== y.source ? x.source === "words" : all.indexOf(x) < all.indexOf(y);
const keepOf = (p: Pair): [Entry, Entry] => (better(p.a, p.b) ? [p.a, p.b] : [p.b, p.a]);
const status = (keep: Entry, alias: Entry): string =>
  ALIAS_KEEP.get(alias.id) === keep.id ? "登録済み" : ALIAS_IDS.has(alias.id) ? "別の keep で登録済み" : "未登録";

function printPairs(list: Pair[], note: (p: Pair) => string) {
  list.forEach((p, n) => {
    const [keep, alias] = keepOf(p);
    const samePos = p.a.pos === p.b.pos ? "同品詞" : "品詞違い";
    console.log("");
    console.log(`#${n + 1} [${p.keys.join(",")}] ${note(p)}（${samePos}・${status(keep, alias)}）`);
    console.log(`  keep  ${fmt(keep)}`);
    console.log(`  alias ${fmt(alias)}`);
  });
}

console.log(`対象: words+capoeira ${all.length} 語 / 同綴りの組 ${pairs.length} 件 / 登録済みの alias ${ALIAS_IDS.size} 件`);
console.log("");
console.log(`■ 別名候補（headKey が同じ・和訳の片が重なる）: ${candidates.length} 件`);
printPairs(candidates, (p) => `重なり: ${p.overlap.join("・")}`);

console.log("");
console.log(`■ 参考: 和訳の片が部分一致する同綴りの組（別語も混じる。要確認）: ${partials.length} 件`);
printPairs(partials, (p) => `部分一致: ${p.partial.join("・")}`);

if (showAll) {
  console.log("");
  console.log(`■ 兄弟語（同綴り・和訳が重ならない）: ${siblingsOnly.length} 件`);
  for (const p of siblingsOnly) {
    console.log("");
    console.log(`  [${p.keys.join(",")}]（${ALIAS_IDS.has(p.a.id) || ALIAS_IDS.has(p.b.id) ? "一方は登録済み" : "未登録"}）`);
    console.log(`    ${fmt(p.a)}`);
    console.log(`    ${fmt(p.b)}`);
  }
}

// 登録内容の整合: 解決できない ID、keep が別の組の alias になっている（連鎖）、同じ alias の二重登録
const known = new Set(all.map((e) => e.id));
for (const [alias, keep] of ALIAS_KEEP) {
  if (!known.has(alias) || !known.has(keep)) console.log(`⚠ word-aliases.json: 解決できない ID（keep ${keep} / alias ${alias}）`);
  if (ALIAS_IDS.has(keep)) console.log(`⚠ word-aliases.json: keep ${keep} が別の組で alias になっている`);
}
const aliasCount = new Map<string, number>();
for (const e of WORD_ALIASES) for (const a of e.alias) aliasCount.set(a, (aliasCount.get(a) ?? 0) + 1);
for (const [a, n] of aliasCount) if (n > 1) console.log(`⚠ word-aliases.json: alias ${a} が ${n} 回登録されている`);

if (showJson) {
  // 候補の組をつないだグループごとに、keep を1つ選ぶ（natureza のような3語以上の重複もまとめる）
  const groups: Entry[][] = [];
  for (const p of candidates) {
    const ga = groups.find((g) => g.includes(p.a));
    const gb = groups.find((g) => g.includes(p.b));
    if (ga && gb && ga !== gb) {
      ga.push(...gb);
      groups.splice(groups.indexOf(gb), 1);
    } else if (ga) {
      if (!ga.includes(p.b)) ga.push(p.b);
    } else if (gb) gb.push(p.a);
    else groups.push([p.a, p.b]);
  }
  const suggestion = groups
    .map((g) => {
      const keep = g.reduce((x, y) => (better(x, y) ? x : y));
      return { keep: keep.id, alias: g.filter((e) => e !== keep && !ALIAS_IDS.has(e.id)).map((e) => e.id) };
    })
    .filter((e) => e.alias.length > 0);
  console.log("");
  console.log("■ 登録案（完全一致の候補のうち未登録分。確認してから data/word-aliases.json に手で写す）");
  console.log(JSON.stringify(suggestion, null, 2));
}
