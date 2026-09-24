// ============================================================================
// 新規語の導入順の核（data/core-order.json）を作る
//   npm run core-order            … 解決結果を表示して data/core-order.json を書く
//   npm run core-order -- --dry   … 表示だけ（書かない）
// SEED（区分つき）の各項目は次のどれか:
//   "não entendo"               … 見出し（headKeys が一致する語を words → capoeira → dict の順で探す。
//                                  word-aliases.json の alias 側は候補から除く）
//   "words:0979=não entendo"    … ID を直接指定し、見出しが一致することも確かめる（曖昧な語・dict・capoeira 用）
// 出力の並び: 区分ごとに per 語ずつ取るラウンドロビン（初日から挨拶・代名詞・動詞・機能語が混ざるように）。
//   アプリ側（queue.orderNew）は words/dict を genQ、capoeira を capQ に分けてこの順で取り出すので、
//   カポエイラ中核語の順番はカポエイラ語どうしの中でだけ意味を持つ。
// 未解決・曖昧・重複・削除済み・alias の ID が1つでもあれば、書かずに終了コード1。
// 表（# | id | pt | ja | pos | 区分）を見て、オーナーが目で確認する。
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { RawWord } from "../src/data/types";
import { headKey, headKeys } from "../src/data/headKey";
import { ALIAS_IDS, ALIAS_KEEP, siblingKey } from "../src/data/siblings";

const here = dirname(fileURLToPath(import.meta.url));
const dataPath = (name: string) => resolve(here, "../data", name);
const load = <T>(name: string): T => JSON.parse(readFileSync(dataPath(name), "utf8"));

const DRY = process.argv.includes("--dry");
const OUT = "core-order.json";
const DELETED = "_deleted";

interface SeedGroup {
  /** 区分名（表示用） */
  name: string;
  /** 1ラウンドでこの区分から取る語数 */
  per: number;
  items: string[];
}

// ---------------------------------------------------------------------------
// SEED（区分内は優先順）。ID を書くときは "id=見出し" の形にして取り違えを防ぐ。
// ---------------------------------------------------------------------------
const SEED: SeedGroup[] = [
  {
    name: "挨拶・礼儀",
    per: 2,
    items: [
      "olá",
      "dict:0270=oi",
      "obrigado",
      "tchau",
      "sim",
      "não",
      "bom dia",
      "por favor",
      "words:0015=tudo bem?", // 元気ですか？（words:0016 と同綴り）
      "desculpe",
      "de nada",
      "boa tarde",
      "words:0016=tudo bem", // 元気です・大丈夫です
      "com licença",
      "boa noite",
      "até logo",
      "prazer em conhecê-lo",
      "até amanhã",
    ],
  },
  {
    name: "代名詞",
    per: 1,
    items: ["eu", "você", "ele", "ela", "nós", "meu", "seu", "isso", "vocês", "eles", "elas", "tudo"],
  },
  {
    name: "基本動詞",
    per: 2,
    items: [
      "words:0080=ser",
      "words:0081=estar",
      "words:0082=ter",
      "words:0084=ir",
      "querer",
      "poder",
      "gostar",
      "falar",
      "fazer",
      "saber",
      "entender",
      "precisar",
      "ver",
      "dizer",
      "vir",
      "dar",
      "achar",
      "ficar",
      "pensar",
      "comer",
      "beber",
      "morar",
      "trabalhar",
      "estudar",
      "aprender",
      "conhecer",
      "jogar",
      "cantar",
      "chegar",
      "voltar",
    ],
  },
  {
    name: "サバイバル表現",
    per: 1,
    items: [
      "words:0979=não entendo",
      "words:0982=pode repetir?",
      "words:0981=fale mais devagar",
      "words:0971=como assim?",
      "words:0980=eu não sei",
      "words:0984=quanto custa?",
      "words:0983=onde fica o banheiro?",
      "words:0972=é mesmo?",
    ],
  },
  {
    name: "疑問詞",
    per: 1,
    items: [
      "o que",
      "words:0038=como", // どのように（words:0518 の「〜のように」とは別）
      "onde",
      "quem",
      "quando",
      "por que",
      "qual",
      "quanto",
    ],
  },
  {
    name: "機能語",
    per: 2,
    items: [
      "words:0512=e",
      "words:0517=que",
      "words:0519=de",
      "words:0520=em",
      "words:0524=com",
      "words:0522=para",
      "mas",
      "muito",
      "também",
      "aqui",
      "lá",
      "agora",
      "bem",
      "mais",
      "só",
      "porque",
      "se",
      "ou",
      "já",
      "ainda",
      "dict:0176=aí",
      "então",
      "por",
      "sem",
      "words:0518=como", // 〜のように・〜として
    ],
  },
  {
    name: "冠詞・口語",
    per: 1,
    items: [
      "dict:0000=o",
      "dict:0001=a",
      "dict:0290=né",
      "dict:0004=um",
      "dict:0005=uma",
      "dict:0308=tá",
      "dict:0311=a gente",
      "dict:0132=pra",
      "dict:0002=os",
      "dict:0003=as",
    ],
  },
  {
    name: "数",
    per: 1,
    items: [
      "words:0484=um", // 1（dict:0004 の不定冠詞 um とは別）
      "dois",
      "três",
      "quatro",
      "cinco",
      "seis",
      "sete",
      "oito",
      "nove",
      "dez",
    ],
  },
  {
    name: "時間",
    per: 1,
    items: ["hoje", "amanhã", "ontem", "dia", "noite", "hora"],
  },
  {
    // カポエイラ語は同綴りの一般語（jogo・roda など）があるので、すべて ID で指定する。
    // meia-lua・cocorinha・ladainha・camará・axé は capoeira-words.json に単独の見出しが無い（2026-09 時点）。
    name: "カポエイラ中核",
    per: 1,
    items: [
      "capoeira:0040=ginga",
      "capoeira:0063=roda",
      "capoeira:0062=jogo",
      "capoeira:0112=berimbau",
      "capoeira:0052=aú",
      "capoeira:0113=pandeiro",
      "capoeira:0114=atabaque",
      "capoeira:0144=esquiva de recua",
      "capoeira:0145=negativa de frente",
      "capoeira:0118=palmas",
      "capoeira:0120=corrido",
      "capoeira:0119=coro",
      "capoeira:0272=chamada",
      "capoeira:0273=volta do mundo",
      "capoeira:0223=queixada",
      "capoeira:0160=cabeçada",
      "capoeira:0053=rolê",
      "capoeira:0126=corda",
      "capoeira:0290=batizado",
      "capoeira:0162=angola",
      "capoeira:0163=regional",
    ],
  },
];

// ---------------------------------------------------------------------------
// データの索引
// ---------------------------------------------------------------------------
type Source = "words" | "capoeira" | "dict";
const SOURCES: Source[] = ["words", "capoeira", "dict"];
const FILES: Record<Source, string> = {
  words: "words.json",
  capoeira: "capoeira-words.json",
  dict: "dict-words.json",
};

interface Entry {
  id: string;
  source: Source;
  raw: RawWord;
}

const RAW: Record<Source, RawWord[]> = {
  words: load<RawWord[]>(FILES.words),
  capoeira: load<RawWord[]>(FILES.capoeira),
  dict: load<RawWord[]>(FILES.dict),
};

const idOf = (source: Source, i: number) => `${source}:${String(i).padStart(4, "0")}`;

/** source → headKey → 語（削除済みを除く） */
const INDEX = new Map<Source, Map<string, Entry[]>>();
for (const source of SOURCES) {
  const m = new Map<string, Entry[]>();
  RAW[source].forEach((raw, i) => {
    if (raw.品詞 === DELETED) return;
    const e: Entry = { id: idOf(source, i), source, raw };
    for (const k of headKeys(raw.ポルトガル語)) {
      const list = m.get(k) ?? [];
      list.push(e);
      m.set(k, list);
    }
  });
  INDEX.set(source, m);
}

function entryById(id: string): Entry | undefined {
  const m = /^(words|capoeira|dict):(\d{4})$/.exec(id);
  if (!m) return undefined;
  const source = m[1] as Source;
  const raw = RAW[source][Number(m[2])];
  return raw ? { id, source, raw } : undefined;
}

// ---------------------------------------------------------------------------
// 解決
// ---------------------------------------------------------------------------
interface Resolved {
  entry: Entry;
  group: string;
  seed: string;
  note?: string;
}
const errors: string[] = [];
const notes: string[] = [];

function resolveSeed(seed: string, group: string): Resolved | undefined {
  const explicit = /^((?:words|capoeira|dict):\d{4})(?:=(.+))?$/.exec(seed);
  if (explicit) {
    const [, id, check] = explicit;
    const entry = entryById(id);
    if (!entry) {
      errors.push(`[${group}] ${seed}: ID が存在しない`);
      return undefined;
    }
    if (entry.raw.品詞 === DELETED) {
      errors.push(`[${group}] ${seed}: 削除済み（_deleted）の ID`);
      return undefined;
    }
    if (ALIAS_IDS.has(id)) {
      errors.push(`[${group}] ${seed}: word-aliases.json の alias 側。keep の ${ALIAS_KEEP.get(id)} を使う`);
      return undefined;
    }
    if (check !== undefined) {
      const want = headKeys(check);
      const have = headKeys(entry.raw.ポルトガル語);
      if (!want.some((k) => have.includes(k))) {
        errors.push(`[${group}] ${seed}: 見出しが一致しない（実際は「${entry.raw.ポルトガル語}」）`);
        return undefined;
      }
    }
    return { entry, group, seed };
  }

  const keys = headKeys(seed);
  for (const source of SOURCES) {
    const idx = INDEX.get(source)!;
    const hits = [...new Set(keys.flatMap((k) => idx.get(k) ?? []))];
    if (hits.length === 0) continue;
    const usable = hits.filter((e) => !ALIAS_IDS.has(e.id));
    if (usable.length === 1) {
      const skipped = hits.length - usable.length;
      return { entry: usable[0], group, seed, note: skipped ? `alias ${skipped}件を除外` : undefined };
    }
    if (usable.length > 1) {
      errors.push(
        `[${group}] "${seed}": 複数ヒット（${source}）→ "id=見出し" で指定する\n` +
          usable.map((e) => `      ${e.id}  ${e.raw.ポルトガル語} | ${e.raw.日本語} | ${e.raw.品詞}`).join("\n"),
      );
      return undefined;
    }
    // すべて alias 側 → keep を使う
    const keep = entryById(ALIAS_KEEP.get(hits[0].id) ?? "");
    if (keep) return { entry: keep, group, seed, note: `alias → keep ${keep.id}` };
  }
  errors.push(`[${group}] "${seed}": 見つからない（headKey「${headKey(seed)}」）`);
  return undefined;
}

const byGroup = SEED.map((g) => ({
  group: g,
  list: g.items.map((s) => resolveSeed(s, g.name)).filter((r): r is Resolved => r !== undefined),
}));

// 区分ごとに per 語ずつ取るラウンドロビン
const ordered: Resolved[] = [];
const cursor = byGroup.map(() => 0);
for (let progressed = true; progressed; ) {
  progressed = false;
  byGroup.forEach(({ group, list }, gi) => {
    for (let n = 0; n < group.per && cursor[gi] < list.length; n++) {
      ordered.push(list[cursor[gi]++]);
      progressed = true;
    }
  });
}

// 重複
const seen = new Map<string, Resolved>();
const out: Resolved[] = [];
for (const r of ordered) {
  const prev = seen.get(r.entry.id);
  if (prev) {
    errors.push(`${r.entry.id}（${r.entry.raw.ポルトガル語}）が重複: [${prev.group}] "${prev.seed}" と [${r.group}] "${r.seed}"`);
    continue;
  }
  seen.set(r.entry.id, r);
  out.push(r);
  if (r.note) notes.push(`${r.entry.id} "${r.seed}": ${r.note}`);
}

// ---------------------------------------------------------------------------
// 表示
// ---------------------------------------------------------------------------
const cell = (s: string, n: number) => {
  const t = s.length > n ? `${s.slice(0, n - 1)}…` : s;
  return t;
};
console.log("#   | id            | pt | ja | pos | 区分");
out.forEach((r, i) => {
  const w = r.entry.raw;
  console.log(
    `${String(i + 1).padStart(3)} | ${r.entry.id.padEnd(13)} | ${w.ポルトガル語} | ${cell(w.日本語, 28)} | ${w.品詞} | ${r.group}`,
  );
});

console.log("\n■ 区分ごとの件数");
for (const { group, list } of byGroup) console.log(`  ${group.name}: ${list.length}/${group.items.length}（1ラウンド ${group.per}）`);

const count = (s: Source) => out.filter((r) => r.entry.source === s).length;
console.log(`\n■ 合計 ${out.length} 件（words ${count("words")} / capoeira ${count("capoeira")} / dict ${count("dict")}）`);

const dictIds = out.filter((r) => r.entry.source === "dict").map((r) => r.entry.id);
console.log(`\n■ dict の ID（reviewPool に常に含める必要あり）: ${dictIds.join(", ") || "なし"}`);

// 同じ綴りの組（アプリ側で同じ日に1枚までになる）
const bySib = new Map<string, Resolved[]>();
for (const r of out) {
  const k = siblingKey({ id: r.entry.id, pt: r.entry.raw.ポルトガル語 });
  bySib.set(k, [...(bySib.get(k) ?? []), r]);
}
const sibs = [...bySib.values()].filter((l) => l.length > 1);
if (sibs.length) {
  console.log("\n■ 参考: core 内の同綴りの組（同じ日には1枚まで）");
  for (const l of sibs) console.log(`  ${l.map((r) => `${r.entry.id} ${r.entry.raw.ポルトガル語}（${r.entry.raw.日本語}）`).join(" / ")}`);
}

if (notes.length) {
  console.log("\n■ メモ");
  for (const n of notes) console.log(`  ${n}`);
}

if (errors.length) {
  console.log(`\n✗ 未解決・曖昧・重複など ${errors.length} 件（data/${OUT} は書きません）`);
  for (const e of errors) console.log(`  ${e}`);
  process.exit(1);
}

if (DRY) {
  console.log(`\n--dry: data/${OUT} は書きません`);
} else {
  writeFileSync(dataPath(OUT), JSON.stringify(out.map((r) => r.entry.id), null, 2) + "\n", "utf8");
  console.log(`\n✓ data/${OUT} に ${out.length} 件を書きました`);
}
