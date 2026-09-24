// ============================================================================
// 同梱データ（data/*.json）の整合性チェック
//   npm run check:content
// - 教材（patterns / passages / scripts / dictation）: ID の重複・形式、必須項目、パターンの {slot} の整合
// - パターンの和文: 型に差し込むと崩れる選択肢（「手伝うしてもらえますか」など）に jaFull があるか
// - パターン → 発話ドリル（patternDrill）: 文に { } が残らないか、10問に同じ文型が続かず全文型が出るか
// - 読み物 → シャドーイングの文（sentenceGroups.groupChunks）: チャンクをすき間なく覆い、本文が変わらないか
// - 導入順（core-order.json）と別名（word-aliases.json）: ID が解決できるか、削除済みでないか、
//   重複・連鎖・コア語との衝突が無いか（単語データは書き換えず、ID を参照するだけのファイル）
// - 再生リスト（music-playlists.json）: videoId の重複と必須項目（メタデータだけで歌詞は持たない）
// - examples.json: 形。どの見出しにも当たらないキーは警告
// - 歌詞の本文が同梱されていないか: data/・src/・public/ の全 JSON を走査し、
//   syncedLyrics / plainLyrics / lyrics など「lyric」を含む項目名と、LRC のタイムスタンプ（[01:23.45]）を探す
// 検査関数は純関数。実データの前に、壊したフィクスチャで「ちゃんと見つけられるか」を自己テストする。
// 生の JSON だけを読み、loadWords（発音生成）は読み込まない。
// エラー（✗）が1件でもあれば終了コード1。警告（⚠）は終了コードに影響しない。
// ============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import type { Chunk, Pattern, PatternSlotOption, RawWord } from "../src/data/types";
import { groupChunks, isSentenceEnd, passageToScript } from "../src/services/sentenceGroups";
import {
  fillSlot,
  frameParts,
  interleave,
  newDrill,
  optionJa,
  patternItems,
  rateEntry,
  summarizeDrill,
  type PatternItem,
  type Rand,
} from "../src/services/patternDrill";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const DELETED_POS = "_deleted";

// ---------------------------------------------------------------------------
// 結果の入れ物
// ---------------------------------------------------------------------------
class Report {
  errors: string[] = [];
  warns: string[] = [];
  error(msg: string) {
    this.errors.push(msg);
  }
  warn(msg: string) {
    this.warns.push(msg);
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const nonEmpty = (v: unknown): v is string => isStr(v) && v.trim() !== "";

/** URL（/practice/chunk/:id など）にそのまま使える ID */
const ID_RE = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// 教材ファイルの形（src/data/types.ts の Pattern / Passage / Script / DictationItem）
// ---------------------------------------------------------------------------
export type ContentKind = "patterns" | "passages" | "scripts" | "dictation";

interface FieldSpec {
  required: Record<string, (v: unknown) => string | null>;
  optional: Record<string, (v: unknown) => string | null>;
}

const reqStr = (v: unknown) => (nonEmpty(v) ? null : "空でない文字列が必要");
const optStr = (v: unknown) => (isStr(v) ? null : "文字列が必要");
const optBool = (v: unknown) => (typeof v === "boolean" ? null : "true/false が必要");
const oneOf = (xs: readonly string[]) => (v: unknown) => (isStr(v) && xs.includes(v) ? null : `${xs.join(" / ")} のどれか`);
const LEVELS = ["short", "medium", "long"] as const;

/** {pt, ja} の配列（min 件以上）。extra は各要素に許す任意項目 */
function pairList(min: number, extra: Record<string, (v: unknown) => string | null> = {}) {
  return (v: unknown): string | null => {
    if (!Array.isArray(v)) return "配列が必要";
    if (v.length < min) return `${min} 件以上必要`;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (!isObj(x)) return `[${i}] がオブジェクトでない`;
      if (!nonEmpty(x.pt) || !nonEmpty(x.ja)) return `[${i}] に pt・ja（空でない文字列）が必要`;
      for (const k of Object.keys(x)) {
        if (k === "pt" || k === "ja") continue;
        const f = extra[k];
        if (!f) return `[${i}] に未知の項目 "${k}"`;
        const e = f(x[k]);
        if (e) return `[${i}].${k}: ${e}`;
      }
    }
    return null;
  };
}

const SPECS: Record<ContentKind, FieldSpec> = {
  patterns: {
    required: {
      id: reqStr,
      category: reqStr,
      frame: reqStr,
      ja: reqStr,
      slots: (v) => (isObj(v) ? null : "オブジェクト（スロット名 → 選択肢）が必要"),
    },
    optional: { note: optStr },
  },
  passages: {
    required: {
      id: reqStr,
      title: reqStr,
      level: oneOf(LEVELS),
      source: oneOf(["original", "news", "custom"]),
      chunks: pairList(1),
    },
    optional: { origin: optStr },
  },
  scripts: {
    required: { id: reqStr, title: reqStr, lines: pairList(1, { kana: optStr }) },
    optional: { description: optStr },
  },
  dictation: {
    required: { id: reqStr, level: oneOf(LEVELS), text: reqStr, ja: reqStr, keyVocab: pairList(0) },
    optional: { isDialogue: optBool },
  },
};

/** "{X}"・"{V:inf}" の中のスロット名（":" より前）。括弧の対応が壊れていれば null */
export function placeholders(s: string): string[] | null {
  const names: string[] = [];
  const rest = s.replace(/\{([^{}]*)\}/g, (_, inner: string) => {
    names.push(inner.split(":")[0].trim());
    return "";
  });
  if (/[{}]/.test(rest)) return null;
  return names;
}

const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** 動詞の辞書形の語尾（う段のひらがな。「手伝う」「働く」「勉強する」） */
const DICT_FORM_END_RE = /[うくぐすつぬぶむる]$/u;

/**
 * 型（pattern.ja）に選択肢の訳を差し込んだ和文が崩れる理由（崩れないなら null）。jaFull の無い選択肢に使う
 * - 型に「／」「〜」がある: 言い方の候補を並べた型で、1つの文にならない（「私は{X}（が）欲しい／〜したいです」）
 * - 型に「（が）」のような省略できる助詞がある
 * - 動詞の辞書形の後に「し…」「です」が続く（「手伝うしてもらえますか」「働くします」「食べるです」）
 */
export function jaFillIssue(templateJa: string, optJa: string): string | null {
  if (/[／〜～]/.test(templateJa)) return "型に「／」「〜」があり、1つの文にならない";
  if (/（[がをはにでとも]）/.test(templateJa)) return "型に「（が）」のような省略できる助詞がある";
  if (DICT_FORM_END_RE.test(optJa.trim())) {
    const after = templateJa.split(/\{[^{}]*\}/).slice(1);
    if (after.some((s) => s.startsWith("し"))) return "動詞の辞書形の後に「し…」が続く";
    if (after.some((s) => s.startsWith("です"))) return "動詞の辞書形の後に「です」が続く";
  }
  return null;
}

/** パターンの frame / ja / slots の整合 */
function checkPatternSlots(p: Obj, where: string, r: Report) {
  if (!isStr(p.frame) || !isStr(p.ja) || !isObj(p.slots)) return;
  const keys = Object.keys(p.slots);
  if (keys.length === 0) {
    r.error(`${where}: slots が空`);
    return;
  }
  // PatternPractice は先頭のスロットだけを使い、frame の {…} をすべてその値で埋める
  if (keys.length > 1) r.error(`${where}: スロットが ${keys.length} 個（PatternPractice はスロット1つだけに対応）`);
  const f = placeholders(p.frame);
  const j = placeholders(p.ja);
  if (!f) r.error(`${where}: frame の { } の対応が壊れている`);
  if (!j) r.error(`${where}: ja の { } の対応が壊れている`);
  if (f && f.length === 0) r.error(`${where}: frame に {スロット} が無い`);
  if (f && f.some((n) => !n)) r.error(`${where}: frame に名前の無い {}`);
  if (j && j.some((n) => !n)) r.error(`${where}: ja に名前の無い {}`);
  const fmt = (ns: string[]) => (ns.length ? [...new Set(ns)].map((n) => `{${n}}`).join("") : "（なし）");
  if (f && !sameSet(f, keys)) r.error(`${where}: frame のスロット ${fmt(f)} が slots（${keys.join(", ")}）と一致しない`);
  if (j && !sameSet(j, keys)) r.error(`${where}: ja のスロット ${fmt(j)} が slots（${keys.join(", ")}）と一致しない`);
  const ja = p.ja;
  for (const k of keys) {
    const opts = p.slots[k];
    // jaFull: その選択肢を入れた文の自然な和訳（任意。表示は jaFull ?? 型への差し込み）
    const e = pairList(1, { jaFull: reqStr })(opts);
    if (e) {
      r.error(`${where}: slots.${k}: ${e}`);
      continue;
    }
    const seen = new Set<string>();
    for (const o of opts as PatternSlotOption[]) {
      if (/[{}]/.test(o.pt) || /[{}]/.test(o.ja)) r.error(`${where}: slots.${k} の選択肢 "${o.pt}" に { } が入っている`);
      const key = o.pt.trim().toLowerCase();
      if (seen.has(key)) r.warn(`${where}: slots.${k} に同じ選択肢 "${o.pt}" が2回`);
      seen.add(key);
      // 画面に出す和文が崩れないか（崩れる選択肢には jaFull が要る）
      const filled = fillSlot(ja, o.ja);
      if (o.jaFull === undefined) {
        const issue = jaFillIssue(ja, o.ja);
        if (issue) r.error(`${where}: slots.${k} の選択肢 "${o.pt}" の和文「${filled}」が崩れる（${issue}）。jaFull に自然な文を書く`);
      } else if (/[{}]/.test(o.jaFull)) {
        r.error(`${where}: slots.${k} の選択肢 "${o.pt}" の jaFull に { } が入っている（jaFull は差し込み済みの全文）`);
      } else if (o.jaFull.trim() === filled.trim()) {
        r.warn(`${where}: slots.${k} の選択肢 "${o.pt}" の jaFull が型への差し込みと同じ（書かなくてよい）`);
      }
    }
  }
}

/** 教材ファイル1つを検査し、ID の一覧を返す（ファイルをまたぐ重複の検査用） */
export function checkContentFile(kind: ContentKind, raw: unknown, r: Report): string[] {
  const ids: string[] = [];
  if (!Array.isArray(raw)) {
    r.error(`${kind}: 配列でない`);
    return ids;
  }
  if (raw.length === 0) r.warn(`${kind}: 項目が0件`);
  const spec = SPECS[kind];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const where = `${kind}[${i}]${isObj(item) && isStr(item.id) ? `(${item.id})` : ""}`;
    if (!isObj(item)) {
      r.error(`${where}: オブジェクトでない`);
      return;
    }
    for (const [k, f] of Object.entries(spec.required)) {
      if (!(k in item)) {
        r.error(`${where}: 必須項目 ${k} が無い`);
        continue;
      }
      const e = f(item[k]);
      if (e) r.error(`${where}.${k}: ${e}`);
    }
    for (const [k, v] of Object.entries(item)) {
      if (k in spec.required) continue;
      const f = spec.optional[k];
      if (!f) {
        r.warn(`${where}: 未知の項目 "${k}"（型に無い。綴りの誤りでないか確認）`);
        continue;
      }
      const e = f(v);
      if (e) r.error(`${where}.${k}: ${e}`);
    }
    if (nonEmpty(item.id)) {
      const id = item.id;
      if (!ID_RE.test(id)) r.error(`${where}: id "${id}" は英数字・_・- だけにする（URL に使う）`);
      if (seen.has(id)) r.error(`${where}: id "${id}" が重複`);
      seen.add(id);
      ids.push(id);
      // 自分で追加した教材は custom_… の ID（AddMaterial）。同梱の教材がこれと衝突しないように
      if (kind === "passages" && id.startsWith("custom_")) r.error(`${where}: id "${id}" は custom_ で始めない（自作教材の ID と衝突する）`);
    }
    if (kind === "patterns") checkPatternSlots(item, where, r);
  });
  return ids;
}

/** 教材ファイルをまたいだ ID の重複 */
export function checkCrossIds(byKind: Partial<Record<ContentKind, string[]>>, r: Report) {
  const owner = new Map<string, ContentKind>();
  for (const [kind, ids] of Object.entries(byKind) as [ContentKind, string[]][]) {
    for (const id of new Set(ids)) {
      const o = owner.get(id);
      if (o && o !== kind) r.error(`id "${id}" が ${o} と ${kind} の両方にある`);
      else owner.set(id, kind);
    }
  }
}

/**
 * 読み物をシャドーイングの文（"p:<id>"）にまとめたとき、チャンクをすき間なく覆い、本文が変わらないか。
 * 最後のチャンクが文末で終わらない読み物は警告（残りをそのまま1文として読む）。文の数の合計を返す。
 */
export function checkPassageSentences(v: unknown, r: Report): number {
  if (!Array.isArray(v)) return 0;
  let total = 0;
  v.forEach((p, i) => {
    if (!isObj(p) || !Array.isArray(p.chunks)) return;
    const where = `passages[${i}]${nonEmpty(p.id) ? ` (${p.id})` : ""}`;
    const chunks: Chunk[] = p.chunks.filter(isObj).map((c) => ({ pt: isStr(c.pt) ? c.pt : "", ja: isStr(c.ja) ? c.ja : "" }));
    const groups = groupChunks(chunks);
    let pos = 0;
    for (const g of groups) {
      if (g.start !== pos || g.end <= g.start) r.error(`${where}: 文のまとまりにすき間・重なりがある（${g.start}〜${g.end}）`);
      pos = g.end;
    }
    if (pos !== chunks.length) r.error(`${where}: 文にまとめると最後のチャンクが漏れる（${pos}/${chunks.length}）`);
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    if (norm(groups.map((g) => g.pt).join(" ")) !== norm(chunks.map((c) => c.pt).join(" "))) r.error(`${where}: 文にまとめると本文が変わる`);
    const last = chunks[chunks.length - 1];
    if (last && !isSentenceEnd(last.pt)) r.warn(`${where}: 最後のチャンクが文末（. ! ? …）で終わっていない（シャドーイングでは残りを1文として読む）`);
    total += groups.filter((g) => g.pt !== "").length;
  });
  return total;
}

/** 種つきの乱数（mulberry32）。ドリルの出題を再現できるように検証で使う */
export function seeded(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 発話ドリル・オートの文（services/patternDrill）を実データで作り、和文・ポルトガル語に { } が残らないか、
 * 文型を混ぜた drillSize 問に同じ文型が続かず、どの文型も出るか（乱数の種を変えて seeds 回）。
 * 文の数と jaFull のある文の数を返す。checkContentFile の後に呼ぶ（形の壊れたデータは例外をエラーにする）
 */
export function checkPatternDrill(raw: unknown, r: Report, drillSize = 10, seeds = 50): { items: number; jaFull: number } {
  if (!Array.isArray(raw)) return { items: 0, jaFull: 0 };
  let items: PatternItem[];
  try {
    items = patternItems(raw as Pattern[]);
  } catch (e) {
    r.error(`patterns → 発話ドリル: 文を作れない（${e instanceof Error ? e.message : e}）`);
    return { items: 0, jaFull: 0 };
  }
  const ids = new Set<string>();
  for (const it of items) {
    if (ids.has(it.id)) r.error(`patterns → 発話ドリル: 文の id "${it.id}" が重複`);
    ids.add(it.id);
    if (/[{}]/.test(it.pt) || /[{}]/.test(it.ja)) r.error(`patterns → 発話ドリル: ${it.id} に { } が残る（${it.pt} ／ ${it.ja}）`);
  }
  const nPat = new Set(items.map((it) => it.pattern.id)).size;
  const want = Math.min(drillSize, items.length);
  for (let s = 1; s <= seeds; s++) {
    const d = interleave(items, drillSize, seeded(s));
    const pats = d.map((it) => it.pattern.id);
    if (d.length !== want || new Set(d.map((it) => it.id)).size !== d.length) {
      r.error(`patterns → 発話ドリル: ${want}問を重複なしで選べない（種 ${s}: ${d.length}問）`);
      break;
    }
    if (nPat > 1 && pats.some((p, i) => i > 0 && p === pats[i - 1])) {
      r.error(`patterns → 発話ドリル: 同じ文型が続く（種 ${s}: ${pats.join(" ")}）`);
      break;
    }
    if (new Set(pats).size !== Math.min(nPat, want)) {
      r.error(`patterns → 発話ドリル: ${want}問に出ない文型がある（種 ${s}: ${[...new Set(pats)].join(" ")}）`);
      break;
    }
  }
  return { items: items.length, jaFull: items.filter((it) => it.option.jaFull !== undefined).length };
}

// ---------------------------------------------------------------------------
// 単語 ID（words:0042 / capoeira:0040 / dict:0290）の解決
// ---------------------------------------------------------------------------
export type WordTables = Record<"words" | "capoeira" | "dict", readonly RawWord[]>;

export type Resolved =
  | { ok: true; entry: RawWord; deleted: boolean }
  | { ok: false; reason: string };

/** loadWords.makeWord と同じ「source:4桁インデックス」を生データで引く（削除済みも返す） */
export function resolveRawId(id: unknown, t: WordTables): Resolved {
  if (!isStr(id)) return { ok: false, reason: "文字列でない" };
  const m = /^(words|capoeira|dict):(\d+)$/.exec(id);
  if (!m) return { ok: false, reason: "形式が source:NNNN でない（words / capoeira / dict）" };
  const n = Number(m[2]);
  if (String(n).padStart(4, "0") !== m[2]) return { ok: false, reason: `番号の桁が正規形でない（${m[1]}:${String(n).padStart(4, "0")}）` };
  const entry = t[m[1] as keyof WordTables][n];
  if (!entry) return { ok: false, reason: `${m[1]} は ${t[m[1] as keyof WordTables].length} 件しか無い` };
  return { ok: true, entry, deleted: entry.品詞 === DELETED_POS };
}

/** 別名ファイルから alias 側の ID を集める（形が壊れた要素は飛ばす。検査は checkAliases） */
export function aliasIdsOf(raw: unknown): Set<string> {
  const out = new Set<string>();
  if (!Array.isArray(raw)) return out;
  for (const e of raw) {
    if (isObj(e) && Array.isArray(e.alias)) for (const a of e.alias) if (isStr(a)) out.add(a);
  }
  return out;
}

/** data/word-aliases.json: [{ keep, alias: [...], pt? }] */
export function checkAliases(raw: unknown, t: WordTables, r: Report) {
  if (!Array.isArray(raw)) {
    r.error("word-aliases: 配列でない");
    return;
  }
  const aliasAt = new Map<string, number>();
  const keepAt = new Map<string, number>();
  raw.forEach((e, i) => {
    const where = `word-aliases[${i}]`;
    if (!isObj(e)) {
      r.error(`${where}: オブジェクトでない`);
      return;
    }
    for (const k of Object.keys(e)) {
      if (k !== "keep" && k !== "alias" && k !== "pt") r.warn(`${where}: 未知の項目 "${k}"（読み込みでは無視される）`);
    }
    if (e.pt !== undefined && !isStr(e.pt)) r.error(`${where}.pt: メモは文字列にする`);
    const keep = e.keep;
    const rk = resolveRawId(keep, t);
    if (!rk.ok) r.error(`${where}: keep ${JSON.stringify(keep)} を解決できない（${rk.reason}）`);
    else if (rk.deleted) r.error(`${where}: keep ${keep} は削除済み`);
    if (isStr(keep)) {
      const k0 = keepAt.get(keep);
      if (k0 !== undefined) r.warn(`${where}: keep ${keep} が word-aliases[${k0}] にもある（1件にまとめる）`);
      else keepAt.set(keep, i);
    }
    if (!Array.isArray(e.alias) || e.alias.length === 0) {
      r.error(`${where}: alias は1件以上の配列にする`);
      return;
    }
    for (const a of e.alias) {
      const ra = resolveRawId(a, t);
      if (!ra.ok) {
        r.error(`${where}: alias ${JSON.stringify(a)} を解決できない（${ra.reason}）`);
        continue;
      }
      if (ra.deleted) r.error(`${where}: alias ${a} は削除済み`);
      if (a === keep) r.error(`${where}: alias ${a} が keep と同じ`);
      const a0 = aliasAt.get(a as string);
      if (a0 !== undefined) r.error(`${where}: alias ${a} が word-aliases[${a0}] にも登録されている`);
      else aliasAt.set(a as string, i);
    }
  });
  // keep が別の登録の alias になっている（連鎖）と、keep 側も新規導入から外れてしまう
  for (const [keep, i] of keepAt) {
    const a = aliasAt.get(keep);
    if (a !== undefined) r.error(`word-aliases[${i}]: keep ${keep} が word-aliases[${a}] の alias にもなっている（連鎖）`);
  }
}

/** data/core-order.json: 学ぶ順に並べた ID の配列 */
export function checkCoreOrder(raw: unknown, t: WordTables, aliasIds: ReadonlySet<string>, r: Report) {
  if (!Array.isArray(raw)) {
    r.error("core-order: 配列でない");
    return;
  }
  if (raw.length === 0) r.error("core-order: 空");
  const seen = new Map<string, number>();
  raw.forEach((id, i) => {
    const where = `core-order[${i}]`;
    const res = resolveRawId(id, t);
    if (!res.ok) {
      r.error(`${where}: ${JSON.stringify(id)} を解決できない（${res.reason}）`);
      return;
    }
    const s = id as string;
    const label = `${s}（${res.entry.ポルトガル語}）`;
    if (res.deleted) r.error(`${where}: ${label} は削除済み${s.startsWith("dict:") ? "（dict のコア語は reviewPool に常に入る）" : ""}`);
    // 別名（alias 側）は新規導入の候補から外れるので、コア語に入れても出てこない。keep 側を使う
    if (aliasIds.has(s)) r.error(`${where}: ${label} は word-aliases の alias 側（keep 側の ID を使う）`);
    // 固有名詞は新規導入の候補から外れる（orderNew）ので、コア語に入れても出てこない
    if (/固有名詞/.test(res.entry.品詞)) r.error(`${where}: ${label} は固有名詞（新規導入されない）`);
    const j = seen.get(s);
    if (j !== undefined) r.error(`${where}: ${label} が core-order[${j}] と重複`);
    else seen.set(s, i);
  });
}

// ---------------------------------------------------------------------------
// 再生リスト・例文
// ---------------------------------------------------------------------------
export function checkPlaylists(raw: unknown, r: Report) {
  if (!Array.isArray(raw)) {
    r.error("music-playlists: 配列でない");
    return;
  }
  const pl = new Set<string>();
  const vids = new Map<string, string>();
  const SONG_KEYS = ["videoId", "title", "artist", "lrcArtist", "lrcTrack", "durationSec", "lrclibId"];
  raw.forEach((p, i) => {
    const where = `music-playlists[${i}]`;
    if (!isObj(p)) {
      r.error(`${where}: オブジェクトでない`);
      return;
    }
    for (const k of ["id", "title", "url"]) if (!nonEmpty(p[k])) r.error(`${where}.${k}: 空でない文字列が必要`);
    if (nonEmpty(p.id)) {
      if (pl.has(p.id)) r.error(`${where}: 再生リストの id "${p.id}" が重複`);
      pl.add(p.id);
    }
    if (!Array.isArray(p.songs)) {
      r.error(`${where}.songs: 配列が必要`);
      return;
    }
    p.songs.forEach((s, j) => {
      const w = `${where}.songs[${j}]`;
      if (!isObj(s)) {
        r.error(`${w}: オブジェクトでない`);
        return;
      }
      for (const k of ["videoId", "title", "artist", "lrcArtist", "lrcTrack"]) if (!nonEmpty(s[k])) r.error(`${w}.${k}: 空でない文字列が必要`);
      if (typeof s.durationSec !== "number" || !(s.durationSec > 0)) r.error(`${w}.durationSec: 正の数が必要`);
      if (s.lrclibId !== null && !(typeof s.lrclibId === "number" && Number.isInteger(s.lrclibId))) r.error(`${w}.lrclibId: 整数か null`);
      for (const k of Object.keys(s)) if (!SONG_KEYS.includes(k)) r.warn(`${w}: 未知の項目 "${k}"`);
      if (nonEmpty(s.videoId)) {
        const prev = vids.get(s.videoId);
        // SONG_BY_ID（videoId → 曲）が後の曲で上書きされる
        if (prev) r.error(`${w}: videoId "${s.videoId}" が ${prev} と重複`);
        else vids.set(s.videoId, w);
      }
    });
  });
}

/** examples.json: { 見出し(小文字): { examples?: [{pt, ja}], collocations?: string[] } } */
export function checkExamples(raw: unknown, headwords: ReadonlySet<string>, r: Report) {
  if (!isObj(raw)) {
    r.error("examples: オブジェクトでない");
    return;
  }
  for (const [key, v] of Object.entries(raw)) {
    const where = `examples["${key}"]`;
    if (!isObj(v)) {
      r.error(`${where}: オブジェクトでない`);
      continue;
    }
    for (const k of Object.keys(v)) {
      if (k === "examples") {
        const e = pairList(1, { kana: optStr })(v.examples);
        if (e) r.error(`${where}.examples: ${e}`);
      } else if (k === "collocations") {
        if (!Array.isArray(v.collocations) || !v.collocations.every(nonEmpty)) r.error(`${where}.collocations: 文字列の配列にする`);
      } else r.warn(`${where}: 未知の項目 "${k}"`);
    }
    // getExtra は word.pt.toLowerCase()（か word.pt）で引く。どの見出しにも当たらないキーは表示されない
    if (!headwords.has(key)) r.warn(`${where}: words / capoeira のどの見出しにも当たらない（表示されない）`);
  }
}

// ---------------------------------------------------------------------------
// 歌詞の本文が同梱されていないか
// ---------------------------------------------------------------------------
/** 歌詞を入れる項目名（syncedLyrics / plainLyrics / lyrics / lyricLines …） */
const LYRIC_KEY_RE = /lyric/i;
/** LRC（同期歌詞）のタイムスタンプ [mm:ss.xx] */
const LRC_TIME_RE = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/;

/** JSON の値をたどり、歌詞らしい項目名と LRC のタイムスタンプを探す */
export function findLyricFields(value: unknown, path = "$"): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (isStr(v)) {
      if (LRC_TIME_RE.test(v)) hits.push(`${p}: LRC のタイムスタンプを含む文字列`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${p}[${i}]`));
      return;
    }
    if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        const q = `${p}.${k}`;
        if (LYRIC_KEY_RE.test(k)) hits.push(`${q}: 歌詞の項目名`);
        if (LRC_TIME_RE.test(k)) hits.push(`${q}: LRC のタイムスタンプを含む項目名`);
        walk(x, q);
      }
    }
  };
  walk(value, path);
  return hits;
}

/** dir 以下の *.json（node_modules・dist・.git は見ない） */
function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...jsonFiles(p));
    else if (name.endsWith(".json")) out.push(p);
  }
  return out.sort();
}

// ===========================================================================
// 実行
// ===========================================================================
let selfFail = 0;
let selfPass = 0;
function expect(cond: boolean, label: string) {
  if (cond) selfPass++;
  else {
    selfFail++;
    console.error(`  ✗ 自己テスト: ${label}`);
  }
}
/** fn が「pattern に当たるエラー」を出すか（pattern が null ならエラー0件か） */
function flags(fn: (r: Report) => void, pattern: RegExp | null, label: string) {
  const r = new Report();
  fn(r);
  if (pattern === null) expect(r.errors.length === 0, `${label}（エラーなし: ${r.errors.join(" / ")}）`);
  else expect(r.errors.some((e) => pattern.test(e)), `${label}（${pattern} が出ない: ${r.errors.join(" / ") || "エラー0件"}）`);
}

console.log("=== 自己テスト（壊したフィクスチャを見つけられるか） ===");
{
  const pat = (o: Obj = {}) => ({
    id: "pat_x",
    category: "c",
    frame: "Eu quero {X}.",
    ja: "{X}が欲しい",
    slots: { X: [{ pt: "água", ja: "水" }] },
    ...o,
  });
  flags((r) => checkContentFile("patterns", [pat()], r), null, "正しいパターン");
  flags((r) => checkContentFile("patterns", [pat(), pat()], r), /重複/, "パターンの id 重複");
  flags((r) => checkContentFile("patterns", [pat({ ja: "欲しい" })], r), /ja のスロット （なし） が slots（X）と一致しない/, "ja に {X} が無い");
  flags((r) => checkContentFile("patterns", [pat({ frame: "Eu quero {Y}." })], r), /frame のスロット \{Y\} が slots（X）と一致しない/, "frame のスロット名が slots と違う");
  flags((r) => checkContentFile("patterns", [pat({ frame: "Eu quero {X." })], r), /対応が壊れている/, "閉じていない {");
  flags((r) => checkContentFile("patterns", [pat({ slots: { X: [] } })], r), /slots\.X/, "選択肢が0件");
  flags((r) => checkContentFile("patterns", [pat({ slots: { X: [{ pt: "água" }] } })], r), /pt・ja/, "選択肢に ja が無い");
  flags(
    (r) => checkContentFile("patterns", [pat({ frame: "{S} {V:inf}", ja: "{S}{V}", slots: { S: [{ pt: "a", ja: "a" }], V: [{ pt: "b", ja: "b" }] } })], r),
    /スロット1つだけ/,
    "スロット2つ（{V:inf} はスロット名 V として読む）"
  );
  flags((r) => checkContentFile("patterns", [pat({ category: "" })], r), /category/, "必須の文字列が空");

  // パターンの和文（型への差し込みが崩れる選択肢には jaFull）
  {
    const pode = (o: Obj) =>
      pat({ frame: "Você pode {X}, por favor?", ja: "{X}してもらえますか？", slots: { X: [{ pt: "me ajudar", ja: "手伝う", ...o }] } });
    flags((r) => checkContentFile("patterns", [pode({})], r), /jaFull に自然な文/, "和文が崩れる（手伝うして…）のに jaFull が無い");
    flags((r) => checkContentFile("patterns", [pode({ jaFull: "手伝ってもらえますか？" })], r), null, "jaFull で直した選択肢");
    flags((r) => checkContentFile("patterns", [pode({ jaFull: "" })], r), /jaFull/, "jaFull が空");
    flags((r) => checkContentFile("patterns", [pode({ jaFull: "{X}してもらえますか？" })], r), /jaFull に \{ \}/, "jaFull に { } が残る");
    flags((r) => checkContentFile("patterns", [pode({ jafull: "手伝ってもらえますか？" })], r), /未知の項目 "jafull"/, "jaFull の綴り違い");
    flags((r) => checkContentFile("patterns", [pat({ ja: "私は{X}（が）欲しい／〜したいです。" })], r), /1つの文にならない/, "候補を並べた型で jaFull が無い");
    const rw = new Report();
    checkContentFile("patterns", [pat({ slots: { X: [{ pt: "água", ja: "水", jaFull: "水が欲しい" }] } })], rw);
    expect(rw.errors.length === 0 && rw.warns.some((w) => /書かなくてよい/.test(w)), "jaFull が型への差し込みと同じ → 警告だけ");
    expect(
      jaFillIssue("私は明日{X}します。", "働く") !== null &&
        jaFillIssue("{X}です。", "食べる") !== null &&
        jaFillIssue("私は明日{X}します。", "勉強") === null &&
        jaFillIssue("私は{X}が好きです。", "旅行すること") === null &&
        jaFillIssue("今日は{X}です。", "暑い") === null,
      "jaFillIssue: 辞書形＋「し…」「です」だけを崩れとみなす"
    );
  }

  // 発話ドリル（services/patternDrill）
  {
    const P = (id: string, n: number): Pattern => ({
      id,
      category: id,
      frame: `F {X} ${id}.`,
      ja: `{X}の${id}`,
      slots: { X: Array.from({ length: n }, (_, i) => ({ pt: `${id}${i}`, ja: `j${i}`, ...(i === 0 ? { jaFull: `全文${id}` } : {}) })) },
    });
    const items = patternItems([P("a", 4), P("b", 2), P("c", 1)]);
    expect(
      items.length === 7 && items[0].id === "pat:a:0" && items[0].pt === "F a0 a." && items[0].ja === "全文a" && items[1].ja === "j1のa",
      "patternItems: id・ポルトガル語・和文（jaFull を優先）"
    );
    expect(fillSlot("Eu quero {X}.", "água") === "Eu quero água." && optionJa(P("a", 1), { pt: "x", ja: "y" }) === "yのa", "fillSlot / optionJa");
    const parts = frameParts("Você pode {X}, por favor?", "me ajudar");
    expect(
      parts.length === 3 && parts[1].slot && parts[1].text === "me ajudar" && !parts[0].slot && parts.map((p) => p.text).join("") === "Você pode me ajudar, por favor?",
      "frameParts: 入れ替え部分だけ slot"
    );
    let adjOk = true;
    let distinctOk = true;
    let avoidOk = true;
    for (let s = 1; s <= 30; s++) {
      // a×4・b×2・c×1 から5問: 3文型 → 2文型の2周。周の境目でも同じ文型は続かない
      const d = interleave(items, 5, seeded(s));
      const pats = d.map((x) => x.pattern.id);
      if (pats.some((p, i) => i > 0 && p === pats[i - 1])) adjOk = false;
      if (d.length !== 5 || new Set(d.map((x) => x.id)).size !== 5) distinctOk = false;
      if (interleave(items, 3, seeded(s), "a")[0]?.pattern.id === "a") avoidOk = false;
    }
    expect(adjOk, "interleave: 同じ文型が続かない");
    expect(distinctOk && interleave(items, 99, seeded(1)).length === 7 && interleave(items, 0).length === 0, "interleave: 重複なし・文の数まで");
    expect(avoidOk, "interleave: avoidFirst の文型から始めない");
    const q0 = newDrill(items, 3, seeded(1));
    const q1 = rateEntry(q0, 0, "missed");
    const q4 = rateEntry(rateEntry(rateEntry(q1, 1, "said"), 2, "close"), 3, "missed");
    expect(
      q0.length === 3 && q1.length === 4 && q1[3].retry && q1[3].item.id === q0[0].item.id && q1[3].rating === null && q4.length === 4,
      "rateEntry: 言えなかった文は最後に1回だけ再出題（再出題でまた言えなくても足さない）"
    );
    expect(q0[0].rating === null && rateEntry(q0, 1, "close").length === 3, "rateEntry: 元の列は変えない・言えた/惜しいは再出題しない");
    const sm = summarizeDrill(q4);
    expect(
      sm.planned === 3 && sm.answered === 3 && sm.first.missed === 1 && sm.first.said === 1 && sm.first.close === 1 && sm.retry.missed === 1,
      "summarizeDrill: 最初の出題と再出題を分けて数える"
    );
    const sm1 = summarizeDrill(q1);
    expect(sm1.answered === 1 && sm1.planned === 3 && sm1.retry.missed === 0, "summarizeDrill: 途中でやめた");
    flags((r) => checkPatternDrill([P("a", 4), P("b", 2), P("c", 1)], r, 5, 10), null, "実データ検査（発話ドリル）: 正しい文型");
    flags(
      (r) => checkPatternDrill([{ ...P("a", 1), frame: "F {X} {Y" }], r, 1, 1),
      /\{ \} が残る/,
      "実データ検査（発話ドリル）: { } が残る"
    );
  }
  flags(
    (r) => {
      const { id: _drop, ...noId } = pat();
      checkContentFile("patterns", [noId], r);
    },
    /必須項目 id/,
    "id が無い"
  );
  flags((r) => checkContentFile("patterns", [pat({ id: "pat x/1" })], r), /英数字/, "URL に使えない id");
  flags((r) => checkContentFile("patterns", {} as unknown, r), /配列でない/, "配列でない");
  flags((r) => checkContentFile("passages", [{ id: "psg_a", title: "t", level: "short", source: "original", chunks: [{ pt: "a", ja: "b" }] }], r), null, "正しい読み物");
  flags((r) => checkContentFile("passages", [{ id: "psg_a", title: "t", level: "easy", source: "original", chunks: [{ pt: "a", ja: "b" }] }], r), /level/, "level が範囲外");
  flags((r) => checkContentFile("passages", [{ id: "psg_a", title: "t", level: "short", source: "original", chunks: [] }], r), /chunks/, "chunks が空");
  flags((r) => checkContentFile("passages", [{ id: "custom_1", title: "t", level: "short", source: "original", chunks: [{ pt: "a", ja: "b" }] }], r), /custom_/, "自作教材の ID と衝突");
  flags((r) => checkContentFile("scripts", [{ id: "scr_a", title: "t", lines: [{ pt: "a", ja: "b", kana: 1 }] }], r), /kana/, "kana が文字列でない");
  flags((r) => checkContentFile("dictation", [{ id: "dct_a", level: "short", text: "", ja: "j", keyVocab: [] }], r), /text/, "本文が空");
  flags((r) => checkContentFile("dictation", [{ id: "dct_a", level: "short", text: "a", ja: "j", keyVocab: [], isDialogue: "yes" }], r), /isDialogue/, "isDialogue が真偽値でない");
  flags((r) => checkCrossIds({ patterns: ["x_1"], dictation: ["x_1"] }, r), /両方/, "ファイルをまたぐ id 重複");
  {
    const r = new Report();
    checkContentFile("scripts", [{ id: "scr_a", title: "t", lines: [{ pt: "a", ja: "b" }], lnes: [] }], r);
    expect(r.errors.length === 0 && r.warns.some((w) => /未知の項目 "lnes"/.test(w)), "未知の項目は警告だけ");
  }
  expect(JSON.stringify(placeholders("{S} {V:inf} {S}")) === '["S","V","S"]', "placeholders: {V:inf} → V");

  // 読み物 → シャドーイングの文
  {
    const ch = (pt: string, ja = ""): Chunk => ({ pt, ja });
    const g = groupChunks([ch("De manhã,", "朝に、"), ch("eu acordo cedo.", "早く起きる。"), ch("Depois,", "その後、"), ch("vou", "行く")]);
    expect(
      g.length === 2 && g[0].start === 0 && g[0].end === 2 && g[0].pt === "De manhã, eu acordo cedo." && g[0].ja === "朝に、早く起きる。",
      "groupChunks: 文末のチャンクまでを1文に（訳は区切らずにつなぐ）"
    );
    expect(g[1]?.start === 2 && g[1]?.end === 4 && g[1]?.pt === "Depois, vou" && g[1]?.ja === "その後、行く", "groupChunks: 文末の無い残りも1文");
    expect(groupChunks([]).length === 0, "groupChunks: チャンク0件");
    expect(
      isSentenceEnd('Ele disse: "Oi!"') && isSentenceEnd("Foi um dia perfeito! ") && isSentenceEnd("(Sério?)") && isSentenceEnd("E então…"),
      "isSentenceEnd: 閉じ引用符・閉じ括弧・…・末尾の空白"
    );
    expect(!isSentenceEnd("De manhã,") && !isSentenceEnd("Nota:") && !isSentenceEnd(""), "isSentenceEnd: 読点・コロン・空は文末でない");
    const sc = passageToScript({ id: "custom_1", title: "t", level: "short", source: "custom", chunks: [ch("  "), ch("Oi."), ch("Tudo bem?", "元気？")] });
    expect(
      sc.id === "p:custom_1" && sc.lines.length === 2 && sc.lines[0].pt === "Oi." && sc.lines[0].ja === "" && sc.lines[1].ja === "元気？",
      "passageToScript: id は p:<id>、空のチャンクは飛ばす"
    );
    expect(passageToScript({ id: "x", title: "t", level: "short", source: "custom", chunks: [ch(" ")] }).lines.length === 0, "passageToScript: 本文の無い文は行にしない");
    flags((r) => checkPassageSentences([{ id: "psg_a", chunks: [ch("Oi,"), ch("tudo bem?")] }], r), null, "読み物の文: 正しい");
    const rw = new Report();
    checkPassageSentences([{ id: "psg_a", chunks: [ch("Oi,"), ch("tudo bem")] }], rw);
    expect(rw.errors.length === 0 && rw.warns.some((w) => /文末/.test(w)), "読み物の文: 最後が文末でない → 警告");
  }
  expect(placeholders("a } b") === null && placeholders("{a{b}}") === null, "placeholders: 壊れた括弧は null");

  const raw = (pt: string, pos = "名詞"): RawWord => ({ カテゴリ: "c", ポルトガル語: pt, 日本語: "j", 品詞: pos });
  const T: WordTables = {
    words: [raw("a"), raw("b"), raw("c", DELETED_POS), raw("Zé", "固有名詞（人名）")],
    capoeira: [raw("ginga")],
    dict: [raw("o", "冠詞"), raw("x", DELETED_POS)],
  };
  const res = resolveRawId("words:0001", T);
  expect(res.ok && res.entry.ポルトガル語 === "b" && !res.deleted, "resolveRawId: words:0001");
  expect(!resolveRawId("words:1", T).ok && !resolveRawId("words:00001", T).ok, "resolveRawId: 桁が正規形でない");
  expect(!resolveRawId("words:0009", T).ok && !resolveRawId("song:0001", T).ok && !resolveRawId(5, T).ok, "resolveRawId: 範囲外・未知の source・文字列でない");
  const del = resolveRawId("dict:0001", T);
  expect(del.ok && del.deleted, "resolveRawId: 削除済みは deleted=true");

  const noAlias = new Set<string>();
  flags((r) => checkCoreOrder(["words:0000", "capoeira:0000", "dict:0000"], T, noAlias, r), null, "正しいコア語");
  flags((r) => checkCoreOrder(["words:0000", "words:0000"], T, noAlias, r), /重複/, "コア語の重複");
  flags((r) => checkCoreOrder(["dict:0001"], T, noAlias, r), /削除済み/, "コア語の dict が削除済み");
  flags((r) => checkCoreOrder(["words:0002"], T, noAlias, r), /削除済み/, "コア語の words が削除済み");
  flags((r) => checkCoreOrder(["dict:0009"], T, noAlias, r), /解決できない/, "コア語が範囲外");
  flags((r) => checkCoreOrder(["words:0001"], T, new Set(["words:0001"]), r), /alias 側/, "コア語に alias 側の ID");
  flags((r) => checkCoreOrder(["words:0003"], T, noAlias, r), /固有名詞/, "コア語に固有名詞");
  flags((r) => checkCoreOrder([], T, noAlias, r), /空/, "コア語が空");

  const al = (keep: unknown, alias: unknown, o: Obj = {}) => ({ keep, alias, ...o });
  flags((r) => checkAliases([al("words:0000", ["words:0001"], { pt: "a" })], T, r), null, "正しい別名（pt メモつき）");
  flags((r) => checkAliases([al("words:0000", ["words:0009"])], T, r), /解決できない/, "alias が範囲外");
  flags((r) => checkAliases([al("words:0009", ["words:0001"])], T, r), /keep .*解決できない/, "keep が範囲外");
  flags((r) => checkAliases([al("words:0000", ["words:0002"])], T, r), /削除済み/, "alias が削除済み");
  flags((r) => checkAliases([al("words:0000", ["words:0000"])], T, r), /keep と同じ/, "alias = keep");
  flags((r) => checkAliases([al("words:0000", ["words:0001"]), al("capoeira:0000", ["words:0001"])], T, r), /にも登録/, "alias の二重登録");
  flags((r) => checkAliases([al("words:0000", ["words:0001"]), al("words:0001", ["capoeira:0000"])], T, r), /連鎖/, "keep が別の登録の alias");
  flags((r) => checkAliases([al("words:0000", [])], T, r), /1件以上/, "alias が空");
  flags((r) => checkAliases([al("words:0000", ["words:0001"], { pt: 3 })], T, r), /メモ/, "pt メモが文字列でない");
  expect([...aliasIdsOf([al("a", ["b", "c"]), { x: 1 }, al("d", "e")])].join() === "b,c", "aliasIdsOf: 形の壊れた要素は飛ばす");

  const song = (o: Obj = {}) => ({ videoId: "v1", title: "t", artist: "a", lrcArtist: "a", lrcTrack: "t", durationSec: 100, lrclibId: null, ...o });
  flags((r) => checkPlaylists([{ id: "p", title: "t", url: "u", songs: [song(), song({ videoId: "v2", lrclibId: 3 })] }], r), null, "正しい再生リスト");
  flags((r) => checkPlaylists([{ id: "p", title: "t", url: "u", songs: [song(), song()] }], r), /videoId .*重複/, "videoId の重複");
  flags((r) => checkPlaylists([{ id: "p", title: "t", url: "u", songs: [song({ lrclibId: "1" })] }], r), /lrclibId/, "lrclibId が数でない");
  flags((r) => checkExamples({ a: { examples: [{ pt: "x" }] } }, new Set(["a"]), r), /examples/, "例文に ja が無い");
  {
    const r = new Report();
    checkExamples({ zzz: { examples: [{ pt: "x", ja: "y" }] } }, new Set(["a"]), r);
    expect(r.errors.length === 0 && r.warns.some((w) => /見出しにも当たらない/.test(w)), "例文のキーが見出しに無い → 警告");
  }

  expect(findLyricFields({ songs: [{ videoId: "v", title: "t" }] }).length === 0, "歌詞: メタデータだけなら0件");
  expect(findLyricFields({ a: [{ syncedLyrics: "x" }] }).some((h) => h.includes("$.a[0].syncedLyrics")), "歌詞: syncedLyrics（パスつき）");
  expect(findLyricFields({ plainLyrics: "x" }).length === 1 && findLyricFields({ Lyrics: "x" }).length === 1, "歌詞: plainLyrics・Lyrics");
  expect(findLyricFields({ note: "[00:12.34] Eu sei" }).length === 1, "歌詞: LRC のタイムスタンプ");
  expect(findLyricFields({ t: "12:30 に集合 [注]" }).length === 0, "歌詞: 普通の時刻・角括弧は当たらない");
}
console.log(`  ${selfPass} passed, ${selfFail} failed`);

// ---------------------------------------------------------------------------
const report = new Report();
const loadJson = (rel: string): unknown => {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, rel), "utf8"));
  } catch (e) {
    report.error(`${rel}: 読み込めない（${e instanceof Error ? e.message : e}）`);
    return undefined;
  }
};
const asTable = (v: unknown, name: string): RawWord[] => {
  if (Array.isArray(v)) return v as RawWord[];
  report.error(`${name}: 配列でない`);
  return [];
};

console.log("=== 教材（patterns / passages / scripts / dictation） ===");
const idsByKind: Partial<Record<ContentKind, string[]>> = {};
for (const kind of ["patterns", "passages", "scripts", "dictation"] as const) {
  idsByKind[kind] = checkContentFile(kind, loadJson(`data/${kind}.json`), report);
  console.log(`  ${kind}: ${idsByKind[kind]!.length} 件`);
}
checkCrossIds(idsByKind, report);
console.log(`  passages → シャドーイング: ${checkPassageSentences(loadJson("data/passages.json"), report)} 文`);
{
  const d = checkPatternDrill(loadJson("data/patterns.json"), report);
  console.log(`  patterns → 発話ドリル: ${d.items} 文（うち jaFull ${d.jaFull}）`);
}

console.log("=== 導入順（core-order）・別名（word-aliases） ===");
const tables: WordTables = {
  words: asTable(loadJson("data/words.json"), "words"),
  capoeira: asTable(loadJson("data/capoeira-words.json"), "capoeira-words"),
  dict: asTable(loadJson("data/dict-words.json"), "dict-words"),
};
const aliasesRaw = loadJson("data/word-aliases.json");
checkAliases(aliasesRaw, tables, report);
const aliasIds = aliasIdsOf(aliasesRaw);
const coreRaw = loadJson("data/core-order.json");
checkCoreOrder(coreRaw, tables, aliasIds, report);
{
  const core = Array.isArray(coreRaw) ? coreRaw.filter(isStr) : [];
  const bySource = (p: string) => core.filter((id) => id.startsWith(p)).length;
  console.log(
    `  word-aliases: ${Array.isArray(aliasesRaw) ? aliasesRaw.length : 0} 件（alias ${aliasIds.size} 語）` +
      ` / core-order: ${core.length} 語（words ${bySource("words:")}・capoeira ${bySource("capoeira:")}・dict ${bySource("dict:")}）`
  );
}

console.log("=== 再生リスト・例文 ===");
checkPlaylists(loadJson("data/music-playlists.json"), report);
{
  const heads = new Set<string>();
  for (const w of [...tables.words, ...tables.capoeira]) {
    if (!w || w.品詞 === DELETED_POS || !isStr(w.ポルトガル語)) continue;
    heads.add(w.ポルトガル語);
    heads.add(w.ポルトガル語.toLowerCase());
  }
  checkExamples(loadJson("data/examples.json"), heads, report);
}

console.log("=== 歌詞の本文が同梱されていないか（data/・src/・public/ の JSON） ===");
{
  const files = ["data", "src", "public"].flatMap((d) => jsonFiles(resolve(ROOT, d)));
  for (const f of files) {
    const rel = relative(ROOT, f).replace(/\\/g, "/");
    const v = loadJson(rel);
    if (v === undefined) continue;
    for (const h of findLyricFields(v)) report.error(`${rel} ${h}`);
  }
  console.log(`  ${files.length} ファイルを走査`);
}

// ---------------------------------------------------------------------------
for (const w of report.warns) console.warn(`  ⚠ ${w}`);
for (const e of report.errors) console.error(`  ✗ ${e}`);
const total = report.errors.length + selfFail;
console.log(
  total
    ? `\nNG: エラー ${report.errors.length} 件・自己テストの失敗 ${selfFail} 件（警告 ${report.warns.length} 件）`
    : `\nOK: エラー 0 件（警告 ${report.warns.length} 件）・自己テスト ${selfPass} 件`
);
if (total) process.exit(1);
