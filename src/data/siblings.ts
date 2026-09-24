// ============================================================================
// 兄弟語（同じ綴りの見出し）と別名（同じ意味の重複見出し）
// - SIBLING_GROUP: words+capoeira の全語を headKey でまとめたグループ（id → グループキー）。
//   例: words の roda（車輪）と capoeira の roda（ホーダ）は同じキー。
//   誤答の選択肢から除く・1日1枚までにする、などの判定に使う。
//   ※ dict/user 語は Map に無いので、比較は siblingKey() / isSibling() を使うこと
//     （Map.get 同士の比較は undefined===undefined で誤って一致する）。
// - ALIAS_IDS: data/word-aliases.json に人が登録した「alias 側」の ID。
//   新規語の導入候補から外す（keep 側だけを学ぶ）。
// - ALIAS_PEERS: 同じ登録の keep/alias どうし。どれかにカードがあればほかは導入しない（同じ語を2枚にしない）。
// 生データ（JSON）から直接作る。loadWords（発音生成）を読み込まないので scripts からも軽く使える。
// ID は loadWords.makeWord と同じ「source:4桁インデックス」。
// ============================================================================

import wordsRaw from "../../data/words.json";
import capoeiraRaw from "../../data/capoeira-words.json";
import aliasesRaw from "../../data/word-aliases.json";
import type { RawWord } from "./types";
import { headKeys } from "./headKey";

const DELETED_POS = "_deleted";

/** 兄弟グループ判定の入力（id と見出し） */
export interface SiblingEntry {
  id: string;
  pt: string;
}

export interface SiblingIndex {
  /** id → グループキー（入力の全 id。兄弟が無い語は1語だけのグループ） */
  groupOf: Map<string, string>;
  /** headKey → グループキー（入力に現れた全 headKey） */
  groupOfKey: Map<string, string>;
  /** グループキー → 所属 id（入力順） */
  members: Map<string, string[]>;
}

/** 見出しの headKey のうち辞書順で最小のもの（グループキーの規則と同じ） */
function minKey(keys: string[]): string {
  return [...keys].sort()[0] ?? "";
}

/**
 * headKey（"meu/minha" は meu と minha の両方）を1つでも共有する語を同じグループにまとめる（純関数）。
 * グループキーは、グループ内の headKey のうち辞書順で最小のもの。
 */
export function buildSiblingGroups(entries: readonly SiblingEntry[]): SiblingIndex {
  // union-find（添字ベース）
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const keysOf = entries.map((e) => headKeys(e.pt).filter(Boolean));
  const firstByKey = new Map<string, number>();
  keysOf.forEach((keys, i) => {
    for (const k of keys) {
      const j = firstByKey.get(k);
      if (j === undefined) firstByKey.set(k, i);
      else {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
      }
    }
  });

  const byRoot = new Map<number, number[]>();
  entries.forEach((_, i) => {
    const r = find(i);
    const list = byRoot.get(r);
    if (list) list.push(i);
    else byRoot.set(r, [i]);
  });

  const groupOf = new Map<string, string>();
  const groupOfKey = new Map<string, string>();
  const members = new Map<string, string[]>();
  for (const idxs of byRoot.values()) {
    const keys = [...new Set(idxs.flatMap((i) => keysOf[i]))];
    // 見出しが空の語は、ほかと合流させずに id をキーにする
    const gk = keys.length ? minKey(keys) : entries[idxs[0]].id;
    const ids = idxs.map((i) => entries[i].id);
    members.set(gk, [...(members.get(gk) ?? []), ...ids]);
    for (const id of ids) groupOf.set(id, gk);
    for (const k of keys) groupOfKey.set(k, gk);
  }
  return { groupOf, groupOfKey, members };
}

/** word-aliases.json の1件: keep を学び、alias は導入候補から外す */
export interface AliasEntry {
  keep: string;
  alias: string[];
}

/** word-aliases.json を検証しながら読む（不正な要素は捨てる。純関数） */
export function parseAliases(raw: unknown): AliasEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: AliasEntry[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const { keep, alias } = e as { keep?: unknown; alias?: unknown };
    if (typeof keep !== "string" || !Array.isArray(alias)) continue;
    const list = alias.filter((a): a is string => typeof a === "string" && a !== keep);
    if (list.length) out.push({ keep, alias: list });
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(4, "0");
}

function entriesOf(raw: RawWord[], source: "words" | "capoeira"): SiblingEntry[] {
  const out: SiblingEntry[] = [];
  raw.forEach((r, i) => {
    if (r.品詞 === DELETED_POS) return;
    out.push({ id: `${source}:${pad(i)}`, pt: r.ポルトガル語 });
  });
  return out;
}

const INDEX = buildSiblingGroups([
  ...entriesOf(wordsRaw as RawWord[], "words"),
  ...entriesOf(capoeiraRaw as RawWord[], "capoeira"),
]);

/** id → 兄弟グループのキー（words+capoeira の全語） */
export const SIBLING_GROUP: Map<string, string> = INDEX.groupOf;

/** 兄弟グループのキー → 所属 id（words+capoeira） */
export const SIBLING_MEMBERS: Map<string, string[]> = INDEX.members;

/** words+capoeira に同じ綴りの別見出しがあるか */
export function hasSiblings(id: string): boolean {
  const g = SIBLING_GROUP.get(id);
  return g !== undefined && (SIBLING_MEMBERS.get(g)?.length ?? 0) > 1;
}

/**
 * 語の兄弟キー。同じ値なら「同じ綴り」とみなす。
 * words/capoeira は SIBLING_GROUP、dict/user 語は見出しの headKey で words+capoeira のグループに合流させる。
 * どこにも無ければ見出しの headKey（dict 語どうしも綴りが同じなら同じキーになる）。
 */
export function siblingKey(w: SiblingEntry): string {
  const g = SIBLING_GROUP.get(w.id);
  if (g !== undefined) return g;
  const keys = headKeys(w.pt).filter(Boolean);
  for (const k of keys) {
    const gk = INDEX.groupOfKey.get(k);
    if (gk !== undefined) return gk;
  }
  return keys.length ? minKey(keys) : w.id;
}

/**
 * 和訳の「片」: 括弧の注記（入れ子も）を除き、・、／/ で分けた各部分（純関数）。
 * "足（足首から下）" → ["足"]、"ステップ / 歩み" → ["ステップ","歩み"]。
 * 別名候補の検出や、誤答の選択肢の重なり判定に使う。
 */
export function jaPieces(ja: string): string[] {
  let s = ja.normalize("NFC");
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/[（(][^（()）]*[）)]/g, " ");
  }
  const out: string[] = [];
  for (const p of s.split(/[・、／/]/)) {
    const t = p
      .replace(/^[\s〜～~]+|[\s？?！!。．.]+$/g, "")
      .trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 2語が同じ兄弟グループか（同じ id も true） */
export function isSibling(a: SiblingEntry, b: SiblingEntry): boolean {
  return a.id === b.id || siblingKey(a) === siblingKey(b);
}

/** word-aliases.json の登録内容 */
export const WORD_ALIASES: AliasEntry[] = parseAliases(aliasesRaw as unknown);

/** alias 側の ID（新規導入の候補から外す） */
export const ALIAS_IDS: Set<string> = new Set(WORD_ALIASES.flatMap((e) => e.alias));

/** alias 側の ID → keep 側の ID */
export const ALIAS_KEEP: Map<string, string> = new Map(
  WORD_ALIASES.flatMap((e) => e.alias.map((a) => [a, e.keep] as const)),
);

/**
 * 別名の登録でつながるほかの ID（keep と alias の全員。自分は含まない）。
 * どれかにカードがあれば、その語はもう学習中（同じ語を2枚目のカードとして導入しない）。
 */
export const ALIAS_PEERS: Map<string, readonly string[]> = (() => {
  const m = new Map<string, string[]>();
  for (const e of WORD_ALIASES) {
    const ids = [e.keep, ...e.alias];
    for (const id of ids) {
      const list = m.get(id) ?? [];
      for (const x of ids) if (x !== id && !list.includes(x)) list.push(x);
      m.set(id, list);
    }
  }
  return m;
})();

/** 別名の登録でつながるほかの ID のどれかにカードがあるか（has は「カードがあるか」） */
export function aliasPeerCarded(id: string, has: (id: string) => boolean): boolean {
  return ALIAS_PEERS.get(id)?.some(has) ?? false;
}
