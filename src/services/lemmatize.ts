// ============================================================================
// 歌詞の単語 → 辞書の原形（オフライン・純関数）
// 探索順:
//   段階1〜4（常に全部集める）: 完全一致 / 縮約・口語 / 不規則・クラス動詞の活用索引 / 名詞形容詞の複数・性
//                               / 規則動詞の逆接尾辞解析（候補の不定詞を活用させて検証）
//   段階5〜（何も無い時だけ）  : 指小辞・-mente・-íssimo / ハイフン(接語・複合語) / r落ち / アクセント揺れ / 固有名詞
// 同綴りで複数の読み（foi = ser/ir、como = como/comer 等）は候補として全部返す。
// ============================================================================

import type { WordSource } from "../data/types";
import {
  Conjugator,
  describeVerbTags,
  irregularParticipleVerbs,
  isSpecialVerb,
  regularSuffixes,
  type IrregularTable,
  type VerbTag,
} from "./conjugate";

/** 辞書の見出し1件（Word を作らずに引ける軽量参照） */
export interface LexRef {
  id: string;
  pt: string;
  ja: string;
  pos: string;
  source: WordSource;
}

export interface ColloquialEntry {
  parts: string[];
  note: string;
  ambiguous?: boolean;
  interjection?: boolean;
}
export type ColloquialTable = Record<string, ColloquialEntry>;

export type CandidateKind =
  | "proper"
  | "exact"
  | "contraction"
  | "colloquial"
  | "irregular"
  | "nominal"
  | "regular"
  | "clitic"
  | "compound"
  | "derived"
  | "rdrop"
  | "fold"
  | "interjection";

export interface Candidate {
  lemma: string;
  refs: LexRef[];
  note: string;
  kind: CandidateKind;
  /** 縮約・複合語の構成要素（各要素の第1候補） */
  parts?: { surface: string; top?: Candidate }[];
}

export interface LookupResult {
  surface: string;
  candidates: Candidate[];
}

export interface Token {
  text: string;
  start: number;
  end: number;
  /** 正規化キー（小文字・NFC・先頭アポストロフィ除去） */
  key: string;
  /** 成句（de repente 等）に含まれる場合 */
  phrase?: { key: string; refs: LexRef[] };
}

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------
const TOKEN_RE = /['’]?[\p{L}\p{M}]+(?:[-'’][\p{L}\p{M}]+)*/gu;

export function normToken(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/[’ʼ‘]/g, "'").replace(/^'+/, "");
}

export function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

export function tokenize(line: string): Token[] {
  const text = line.normalize("NFC");
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    out.push({ text: m[0], start: m.index!, end: m.index! + m[0].length, key: normToken(m[0]) });
  }
  return out;
}

/** 見出し語の表記ゆれ（"meu/minha"・括弧注記）を展開 */
function alternatives(pt: string): string[] {
  const s = pt.normalize("NFC").replace(/\s*[（(][^）)]*[）)]\s*/g, " ").trim();
  const parts = s.split("/").map((x) => x.trim());
  return parts.length > 1 && parts.every(Boolean) ? parts : [s];
}

/** 見出し語のうち key（アクセント無視）に対応する表記を返す（"amigo/amiga" + amiga → amiga、rápido + rapido → rápido） */
function headwordFor(ref: LexRef, key: string): string {
  const alts = alternatives(ref.pt);
  const f = fold(key.toLowerCase());
  return alts.find((a) => fold(a.toLowerCase()) === f) ?? alts[0];
}

const SOURCE_RANK: Record<WordSource, number> = { words: 0, dict: 1, user: 2, capoeira: 3 };

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const l = m.get(k);
  if (l) {
    if (!l.includes(v)) l.push(v);
  } else m.set(k, [v]);
}

const CLITICS = new Set([
  "me", "te", "se", "nos", "vos", "lhe", "lhes", "o", "a", "os", "as", "lo", "la", "los", "las",
  "no", "na", "nas", "mo", "ma", "to", "ta", "lho", "lha",
]);
const MESO_ENDINGS = new Set(["ei", "ás", "á", "emos", "eis", "ão", "ia", "ias", "íamos", "íeis", "iam"]);
const NOMINAL_POS = (pos: string) => /^(名詞|形容詞|代名詞|数詞|冠詞)/.test(pos);
const GENDER_POS = (pos: string) => pos.startsWith("形容詞") || pos.startsWith("代名詞") || pos.startsWith("数詞") || pos === "冠詞";

const KIND_RANK: Record<CandidateKind, number> = {
  proper: 0,
  exact: 1,
  interjection: 2,
  contraction: 3,
  colloquial: 3,
  nominal: 4,
  irregular: 5,
  regular: 6,
  clitic: 7,
  compound: 8,
  derived: 9,
  rdrop: 10,
  fold: 11,
};

class CandList {
  private list: Candidate[] = [];
  private keys = new Set<string>();
  add(c: Candidate) {
    const k = `${c.kind === "contraction" || c.kind === "compound" ? c.kind : ""}|${c.lemma}|${c.refs[0]?.id ?? ""}`;
    if (this.keys.has(k)) return;
    // 同じ原形・同じ参照が既にあれば追加しない（例: 不定詞の完全一致と活用解析の重複）
    if (c.refs.length && this.list.some((x) => x.lemma === c.lemma && x.refs[0]?.id === c.refs[0]?.id)) return;
    this.keys.add(k);
    this.list.push(c);
  }
  get size() {
    return this.list.length;
  }
  sorted(): Candidate[] {
    return this.list
      .map((c, i) => ({ c, i }))
      .sort((a, b) => KIND_RANK[a.c.kind] - KIND_RANK[b.c.kind] || a.i - b.i)
      .map((x) => x.c);
  }
}

/** 候補が辞書の意味を持つ（＝カバーできている）か */
export function isCovered(c: Candidate): boolean {
  if (c.kind === "interjection") return true;
  if (c.refs.length) return true;
  return !!c.parts?.length && c.parts.every((p) => p.top && isCovered(p.top));
}

/**
 * 文法の機能語か（曲の単語の一括追加から外す）。
 * 冠詞・前置詞・接続詞と、目的格・再帰の代名詞（me/te/se/lhe/o/a…）。
 * 縮約（do = de + o、pra = para + a）は構成要素ごとに判定される。個別の「＋追加」は制限しない。
 */
export function isGrammarWord(pos: string, ja: string): boolean {
  if (/^(冠詞|前置詞|接続詞)/.test(pos)) return true;
  return pos.startsWith("代名詞") && /目的格|再帰/.test(ja);
}

export interface LemmatizerInput {
  entries: LexRef[];
  irregular: IrregularTable;
  colloquial: ColloquialTable;
}

export type Lemmatizer = ReturnType<typeof createLemmatizer>;

export function createLemmatizer(input: LemmatizerInput) {
  const irregular: IrregularTable = Object.fromEntries(Object.entries(input.irregular).filter(([k]) => !k.startsWith("_")));
  const colloquial: ColloquialTable = Object.fromEntries(Object.entries(input.colloquial).filter(([k]) => !k.startsWith("_")));

  // ---------------- 索引 ----------------
  const WORD_MAP = new Map<string, LexRef[]>();
  const PHRASE_MAP = new Map<string, LexRef[]>();
  const PROPER_MAP = new Map<string, LexRef[]>();
  const FOLD_MAP = new Map<string, LexRef[]>();
  let maxPhrase = 1;

  const sortedEntries = [...input.entries].sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
  for (const e of sortedEntries) {
    if (e.pos === "_deleted") continue;
    const proper = e.pos.startsWith("固有名詞");
    for (const alt of alternatives(e.pt)) {
      if (/\d/.test(alt)) continue;
      const keys = tokenize(alt).map((t) => t.key);
      if (keys.length === 0) continue;
      if (keys.length > 1) {
        if (proper) continue;
        push(PHRASE_MAP, keys.join(" "), e);
        maxPhrase = Math.max(maxPhrase, Math.min(keys.length, 5));
        continue;
      }
      const k = keys[0];
      if (proper) push(PROPER_MAP, k, e);
      else {
        push(WORD_MAP, k, e);
        push(FOLD_MAP, fold(k), e);
      }
    }
  }

  const VERB_RE = /^[\p{Ll}\p{M}]+(ar|er|ir)$/u;
  const VERB_SET = new Set<string>();
  for (const [k, refs] of WORD_MAP) {
    if (refs.some((r) => r.pos === "動詞") && (VERB_RE.test(k) || irregular[k])) VERB_SET.add(k);
  }
  const conj = new Conjugator(irregular);

  // 不規則動詞・クラス動詞は前方生成して 活用形→(原形,タグ) の索引に（初回利用時に構築）
  let FORM_INDEX: Map<string, { lemma: string; tags: VerbTag[] }[]> | null = null;
  function formIndex() {
    if (FORM_INDEX) return FORM_INDEX;
    FORM_INDEX = new Map();
    const special = new Set<string>(Object.keys(irregular));
    for (const v of VERB_SET) if (isSpecialVerb(v, irregular)) special.add(v);
    for (const inf of special) {
      for (const [form, tags] of conj.conjugate(inf)) push(FORM_INDEX, form, { lemma: inf, tags });
    }
    // 不規則過去分詞（aberto, escrito, pago…）だけは規則動詞でも索引に入れる
    for (const inf of irregularParticipleVerbs()) {
      if (!VERB_SET.has(inf) || special.has(inf)) continue;
      for (const [form, tags] of conj.conjugate(inf)) {
        const ppTags = tags.filter((t) => t.t === "pp");
        if (ppTags.length && !form.endsWith("ado") && !form.endsWith("ido") && !form.endsWith("ada") && !form.endsWith("ida")
          && !form.endsWith("ados") && !form.endsWith("idos") && !form.endsWith("adas") && !form.endsWith("idas")) {
          push(FORM_INDEX, form, { lemma: inf, tags });
        }
      }
    }
    return FORM_INDEX;
  }

  function verbRefs(inf: string): LexRef[] {
    const refs = WORD_MAP.get(inf) ?? [];
    const verbs = refs.filter((r) => r.pos.startsWith("動詞"));
    return verbs.length ? verbs : refs;
  }

  // ---------------- 規則動詞の逆解析 ----------------
  function stemVariants(stem: string): string[] {
    const v = new Set([stem]);
    if (stem.endsWith("qu")) v.add(stem.slice(0, -2) + "c");
    if (stem.endsWith("gu")) v.add(stem.slice(0, -1));
    if (stem.endsWith("c")) v.add(stem.slice(0, -1) + "ç");
    if (stem.endsWith("ç")) v.add(stem.slice(0, -1) + "c");
    if (stem.endsWith("j")) v.add(stem.slice(0, -1) + "g");
    if (stem.endsWith("g")) v.add(stem + "u");
    return [...v];
  }

  function analyzeRegular(tok: string): Candidate[] {
    const out: Candidate[] = [];
    const seen = new Set<string>();
    for (const { cls, suffix } of regularSuffixes()) {
      if (!tok.endsWith(suffix)) continue;
      const stem = tok.slice(0, tok.length - suffix.length);
      if (stem.length < 2) continue;
      for (const s of stemVariants(stem)) {
        const inf = s + cls;
        if (seen.has(inf) || !VERB_SET.has(inf) || isSpecialVerb(inf, irregular)) continue;
        seen.add(inf);
        const tags = conj.conjugate(inf).get(tok);
        if (tags) out.push({ lemma: inf, refs: verbRefs(inf), note: describeVerbTags(inf, tags), kind: "regular" });
      }
    }
    return out;
  }

  // ---------------- 名詞・形容詞 ----------------
  function pluralBases(tok: string): string[] {
    const out: string[] = [];
    const rules: [RegExp, string[]][] = [
      [/s$/, [""]],
      [/ões$/, ["ão"]],
      [/ães$/, ["ão", "ã"]],
      [/ãos$/, ["ão"]],
      [/ais$/, ["al"]],
      [/éis$/, ["el"]],
      [/eis$/, ["il", "el"]],
      [/óis$/, ["ol"]],
      [/uis$/, ["ul"]],
      [/is$/, ["il"]],
      [/ns$/, ["m"]],
      [/eses$/, ["ês", "ese"]],
      [/zes$/, ["z"]],
      [/res$/, ["r"]],
      [/ses$/, ["s"]],
      [/es$/, ["", "e"]],
    ];
    for (const [re, reps] of rules) {
      if (!re.test(tok)) continue;
      for (const r of reps) {
        const base = tok.replace(re, r);
        if (base.length >= 1 && base !== tok) out.push(base);
      }
    }
    return [...new Set(out)];
  }

  function genderBases(tok: string): string[] {
    const rules: [RegExp, string][] = [
      [/^má$/, "mau"],
      [/^boa$/, "bom"],
      [/ora$/, "or"],
      [/esa$/, "ês"],
      [/eia$/, "eu"],
      [/ã$/, "ão"],
      [/oa$/, "ão"],
      [/ua$/, "u"],
      [/a$/, "o"],
    ];
    const out: string[] = [];
    for (const [re, r] of rules) if (re.test(tok)) out.push(tok.replace(re, r));
    return out;
  }

  function nominal(tok: string, add: (c: Candidate) => void) {
    // 複数形 → 完全一致
    let found = false;
    const plurals = pluralBases(tok);
    for (const base of plurals) {
      const refs = (WORD_MAP.get(base) ?? []).filter((r) => NOMINAL_POS(r.pos));
      if (refs.length) {
        add({ lemma: base, refs, note: `${base} の複数形`, kind: "nominal" });
        found = true;
      }
    }
    if (found) return;
    // 性（形容詞・代名詞・数詞・冠詞のみ）: bonita → bonito, bonitas → bonita → bonito
    for (const [form, isPl] of [[tok, false] as const, ...plurals.map((p) => [p, true] as const)]) {
      for (const base of genderBases(form)) {
        const refs = (WORD_MAP.get(base) ?? []).filter((r) => GENDER_POS(r.pos));
        if (refs.length) add({ lemma: base, refs, note: `${base} の女性${isPl ? "複数" : ""}形`, kind: "nominal" });
      }
    }
  }

  /** 指小辞・-mente・-íssimo（何も見つからない時だけ） */
  function derived(tok: string, add: (c: Candidate) => void) {
    const tryBase = (base: string, note: (lemma: string) => string) => {
      const direct = WORD_MAP.get(base) ?? FOLD_MAP.get(fold(base));
      if (direct?.length) {
        const lemma = headwordFor(direct[0], base);
        add({ lemma, refs: direct, note: note(lemma), kind: "derived" });
        return true;
      }
      for (const g of genderBases(base)) {
        const refs = (WORD_MAP.get(g) ?? FOLD_MAP.get(fold(g)) ?? []).filter((r) => GENDER_POS(r.pos));
        if (refs.length) {
          const lemma = headwordFor(refs[0], g);
          add({ lemma, refs, note: note(lemma), kind: "derived" });
          return true;
        }
      }
      return false;
    };
    const sing = [tok, ...pluralBases(tok)];
    for (const w of sing) {
      let m = w.match(/^(.+?)zinh([oa])$/);
      if (m && tryBase(m[1], (l) => `${l} の指小形（小さい・かわいい等のニュアンス）`)) return;
      m = w.match(/^(.+?)inh([oa])$/);
      if (m) {
        let st = m[1];
        if (st.endsWith("qu")) st = st.slice(0, -2) + "c";
        else if (st.endsWith("gu")) st = st.slice(0, -1);
        for (const end of [m[2], "o", "a", "e", ""]) {
          for (const s of new Set([st, st.endsWith("c") ? st.slice(0, -1) + "ç" : st])) {
            if (tryBase(s + end, (l) => `${l} の指小形（小さい・かわいい等のニュアンス）`)) return;
          }
        }
      }
    }
    let m = tok.match(/^(.+)mente$/);
    if (m && tryBase(m[1], (l) => `${l} の副詞形（〜に・〜く）`)) return;
    m = tok.match(/^(.+)íssim([oa])s?$/);
    if (m) {
      let st = m[1];
      if (st.endsWith("qu")) st = st.slice(0, -2) + "c"; // pouquíssimo → pouco
      else if (st.endsWith("gu")) st = st.slice(0, -1); // larguíssimo → largo
      for (const end of ["o", "e", ""]) if (tryBase(st + end, (l) => `${l} の最上級（とても〜）`)) return;
      if (st.endsWith("c") && tryBase(st.slice(0, -1) + "z", (l) => `${l} の最上級（とても〜）`)) return;
    }
  }

  // ---------------- 本体 ----------------
  const memo = new Map<string, LookupResult>();

  function core(key: string, out: CandList) {
    const add = (c: Candidate) => out.add(c);
    const ex = WORD_MAP.get(key);
    if (ex) add({ lemma: key, refs: ex, note: "", kind: "exact" });

    const col = colloquial[key];
    if (col) {
      if (col.interjection) add({ lemma: key, refs: [], note: col.note, kind: "interjection" });
      else if (col.parts.length === 1) {
        // 口語の短縮（tô → estou → estar）は元の語の候補に説明を付けて返す
        const inner = new CandList();
        core(col.parts[0], inner);
        const top = inner.sorted();
        if (top.length) {
          for (const c of top.slice(0, 1)) {
            add({ ...c, kind: "colloquial", note: c.note ? `${col.note}・${c.note}` : col.note });
          }
        } else add({ lemma: col.parts[0], refs: [], note: col.note, kind: "colloquial" });
      } else {
        add({
          lemma: col.parts.join(" + "),
          refs: [],
          note: col.note,
          kind: "contraction",
          parts: col.parts.map((p) => ({ surface: p, top: lookupKey(p).candidates[0] })),
        });
      }
    }

    for (const { lemma, tags } of formIndex().get(key) ?? []) {
      add({ lemma, refs: verbRefs(lemma), note: describeVerbTags(lemma, tags), kind: "irregular" });
    }
    nominal(key, add);
    for (const c of analyzeRegular(key)) add(c);
  }

  function hyphen(key: string, out: CandList) {
    const parts = key.split("-");
    const head = parts[0];
    const rest = parts.slice(1);
    // 未来形の中間接語: amar-te-ei → amarei / fá-lo-ei → farei
    const last = rest[rest.length - 1];
    if (rest.length >= 2 && MESO_ENDINGS.has(last) && rest.slice(0, -1).every((p) => CLITICS.has(p))) {
      for (const h of restoreHead(head, true)) {
        const inner = new CandList();
        core(h + last, inner);
        const verbs = inner.sorted().filter((c) => c.kind === "irregular" || c.kind === "regular");
        if (verbs.length) {
          for (const c of verbs) out.add({ ...c, kind: "clitic", note: `${c.note} ＋ 接語 ${rest.slice(0, -1).join("・")}` });
          return;
        }
      }
    }
    // 接語: amá-la / fazê-lo / dá-me / encontramo-nos / fá-lo
    if (rest.length && rest.every((p) => CLITICS.has(p))) {
      const heads = restoreHead(head, false);
      const lForm = /^l[oa]s?$/.test(rest[0]);
      for (const h of lForm && heads.length > 1 ? heads.slice(1) : heads) {
        const inner = new CandList();
        core(h, inner);
        const verbs = inner.sorted().filter((c) => c.kind === "irregular" || c.kind === "regular" || (c.kind === "exact" && VERB_SET.has(c.lemma)));
        if (verbs.length) {
          for (const c of verbs) {
            const note = c.note || `${c.lemma} の不定詞`;
            out.add({ ...c, kind: "clitic", note: `${note} ＋ 接語 ${rest.join("・")}` });
          }
          return;
        }
      }
    }
    // 複合語: 各要素を別々に
    out.add({
      lemma: parts.join(" + "),
      refs: [],
      note: "複合語",
      kind: "compound",
      parts: parts.map((p) => ({ surface: p, top: lookupKey(p).candidates[0] })),
    });
  }

  /** 接語の前で落ちた/変わった語末を戻す候補 */
  function restoreHead(head: string, forFuture: boolean): string[] {
    const out: string[] = [head];
    const deacc = head.replace(/á$/, "a").replace(/ê$/, "e").replace(/ô$/, "o");
    if (forFuture) {
      out.push(deacc + "r");
      if (head.endsWith("i")) out.push(head + "r");
      return out;
    }
    if (/[áêô]$/.test(head)) {
      out.push(head === "pô" ? "pôr" : deacc + "r"); // amá → amar, fazê → fazer
      out.push(deacc + "z", deacc + "s"); // fá → faz, fê → fez
    }
    if (head.endsWith("i")) out.push(head + "r", head + "z", head + "s"); // parti → partir, fi → fiz, di → diz
    if (head.endsWith("mo")) out.push(head + "s"); // encontramo-nos
    return out;
  }

  function lookupKey(key: string, opts: { capitalized?: boolean; lineStart?: boolean } = {}): LookupResult {
    const mk = `${key}|${opts.capitalized ? 1 : 0}${opts.lineStart ? 1 : 0}`;
    const hit = memo.get(mk);
    if (hit) return hit;

    const out = new CandList();
    const proper = PROPER_MAP.get(key);
    if (proper && opts.capitalized && !opts.lineStart) out.add({ lemma: proper[0].pt, refs: proper, note: "固有名詞", kind: "proper" });

    if (key.includes("'")) {
      // d'água → de + água / pro'cê → pro + cê
      const parts = key.split("'").filter(Boolean).map((p) => (p === "d" ? "de" : p === "n" ? "em" : p));
      out.add({
        lemma: parts.join(" + "),
        refs: [],
        note: "縮約（アポストロフィ）",
        kind: "contraction",
        parts: parts.map((p) => ({ surface: p, top: lookupKey(p).candidates[0] })),
      });
    } else if (key.includes("-")) {
      const whole = WORD_MAP.get(key);
      if (whole) out.add({ lemma: key, refs: whole, note: "", kind: "exact" });
      else if (colloquial[key]) core(key, out);
      else hyphen(key, out);
    } else {
      core(key, out);
      if (out.size === 0) {
        derived(key, (c) => out.add(c));
      }
      if (out.size === 0 && /[áêô]$/.test(key)) {
        // 口語の r 落ち不定詞: amá → amar, fazê → fazer
        const inf = key.replace(/á$/, "ar").replace(/ê$/, "er").replace(/ô$/, "or");
        if (VERB_SET.has(inf)) out.add({ lemma: inf, refs: verbRefs(inf), note: `口語: ${inf} の語末 r が落ちた形`, kind: "rdrop" });
      }
      if (out.size === 0) {
        const f = FOLD_MAP.get(fold(key));
        if (f) {
          const lemma = headwordFor(f[0], key);
          out.add({ lemma, refs: f, note: `アクセント表記の揺れ（${lemma}）`, kind: "fold" });
        }
      }
      if (out.size === 0) {
        // 複数形+アクセント揺れ
        for (const b of pluralBases(key)) {
          const f = FOLD_MAP.get(fold(b));
          if (f) {
            const lemma = headwordFor(f[0], b);
            out.add({ lemma, refs: f, note: `${lemma} の複数形（表記揺れ）`, kind: "fold" });
            break;
          }
        }
      }
    }
    // 行頭の大文字語だけは、他に何も無ければ固有名詞として返す（小文字の besouro を人名にしない）
    if (out.size === 0 && proper && opts.capitalized) out.add({ lemma: proper[0].pt, refs: proper, note: "固有名詞", kind: "proper" });

    const res: LookupResult = { surface: key, candidates: out.sorted() };
    memo.set(mk, res);
    return res;
  }

  /** 画面のトークン（大文字・行頭情報つき）で引く */
  function lookup(surface: string, opts: { lineStart?: boolean } = {}): LookupResult {
    const key = normToken(surface);
    const raw = surface.replace(/^['’]+/, "");
    const capitalized = /^\p{Lu}/u.test(raw);
    return { ...lookupKey(key, { capitalized, lineStart: opts.lineStart }), surface };
  }

  /** 行をトークン化し、成句（最長一致・最大5語）を付与 */
  function analyzeLine(line: string): Token[] {
    const toks = tokenize(line);
    for (let i = 0; i < toks.length; i++) {
      for (let len = Math.min(maxPhrase, toks.length - i); len >= 2; len--) {
        const k = toks
          .slice(i, i + len)
          .map((t) => t.key)
          .join(" ");
        const refs = PHRASE_MAP.get(k);
        if (refs) {
          for (let j = i; j < i + len; j++) toks[j].phrase = { key: k, refs };
          i += len - 1;
          break;
        }
      }
    }
    return toks;
  }

  return {
    lookup,
    lookupKey,
    analyzeLine,
    tokenize,
    /** 動詞の不定詞として辞書にあるか */
    isVerb: (inf: string) => VERB_SET.has(inf),
    stats: () => ({ words: WORD_MAP.size, phrases: PHRASE_MAP.size, proper: PROPER_MAP.size, verbs: VERB_SET.size }),
  };
}
