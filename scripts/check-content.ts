// ============================================================================
// 同梱データ（data/*.json）の整合性チェック
//   npm run check:content
// - 教材（patterns / passages / scripts / dictation）: ID の重複・形式、必須項目、難易度、パターンの {slot} の整合
// - 読み物の話題（topic）と内容チェックの設問（questions）: 3〜4個の重複の無い選択肢・範囲内の答えの番号
// - スクリプトの会話（kind: dialogue）: 全行に話者（speaker）があり、話者がちょうど2人
// - カポエイラ語のカテゴリの付け替え（capoeira-category-map.json）: キーが実在するカテゴリか・連鎖が無いか
// - 教材の画面の純関数（services/materials・services/rolePlay）: 一覧の絞り込み・設問の答え・会話の話者・
//   ロールプレイの進行（偽の読み上げと待ちで、順番・止めた位置・最初の読み上げが同期か）
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
import type { Chunk, Passage, Pattern, PatternSlotOption, RawWord, Script } from "../src/data/types";
import { groupChunks, isSentenceEnd, passageToScript } from "../src/services/sentenceGroups";
import {
  answerQuestion,
  choiceOrders,
  dialogueSpeakers,
  emptyAnswers,
  filterPassages,
  frameBlank,
  groupByLevel,
  lineSpeaker,
  matchesLevel,
  normalizePassage,
  normalizeScript,
  parseLevelFilter,
  passageQuestions,
  passageTopic,
  patternGroups,
  quizSummary,
  scriptSpeakers,
  sentenceCount,
  topicsOf,
} from "../src/services/materials";
import { myTurns, runRolePlay, turnGapMs, waitTurn, type RolePlayDeps } from "../src/services/rolePlay";
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
/** 画面にそのまま出す名前（話題・話者）: 空でなく、前後に空白が無い（表記ゆれで別の話題・話者にならないように） */
const label = (v: unknown) => (!nonEmpty(v) ? "空でない文字列が必要" : v !== v.trim() ? "前後に空白がある" : null);
const LEVELS = ["short", "medium", "long"] as const;
/** スクリプトの種類（dialogue = 2人の会話。行ごとに speaker が要る） */
const SCRIPT_KINDS = ["monologue", "dialogue"] as const;
/** 内容チェックの設問の選択肢の数 */
const QUESTION_CHOICES_MIN = 3;
const QUESTION_CHOICES_MAX = 4;

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
    // questions の中身は checkQuestions で1問ずつ検査する
    optional: { origin: optStr, topic: label, questions: (v) => (Array.isArray(v) ? null : "配列が必要") },
  },
  scripts: {
    // 会話（kind: dialogue）の話者の決まりは checkDialogue で検査する
    required: { id: reqStr, title: reqStr, lines: pairList(1, { kana: optStr, speaker: label }) },
    optional: { description: optStr, level: oneOf(LEVELS), kind: oneOf(SCRIPT_KINDS) },
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

/**
 * 読み物の内容チェックの設問（questions）: 1問ずつ、問い・3〜4個の重複の無い選択肢・範囲内の答えの番号・解説（任意）。
 * どの設問も答えが同じ位置（3問以上）なら警告（位置で当てられる）
 */
export function checkQuestions(p: Obj, where: string, r: Report) {
  const qs = p.questions;
  if (qs === undefined || !Array.isArray(qs)) return;
  if (qs.length === 0) {
    r.error(`${where}.questions: 空の配列（設問が無いなら項目ごと書かない）`);
    return;
  }
  const answers: number[] = [];
  qs.forEach((x, i) => {
    const w = `${where}.questions[${i}]`;
    if (!isObj(x)) {
      r.error(`${w}: オブジェクトでない`);
      return;
    }
    for (const k of Object.keys(x)) {
      if (!["q", "choices", "answer", "explain"].includes(k)) r.error(`${w}: 未知の項目 "${k}"（q / choices / answer / explain）`);
    }
    if (!nonEmpty(x.q)) r.error(`${w}.q: 空でない文字列が必要`);
    if (x.explain !== undefined && !nonEmpty(x.explain)) r.error(`${w}.explain: 空でない文字列にする（無いなら書かない）`);
    const ch = x.choices;
    if (!Array.isArray(ch)) {
      r.error(`${w}.choices: 配列が必要`);
      return;
    }
    if (ch.length < QUESTION_CHOICES_MIN || ch.length > QUESTION_CHOICES_MAX) {
      r.error(`${w}.choices: 選択肢は ${QUESTION_CHOICES_MIN}〜${QUESTION_CHOICES_MAX} 個（${ch.length} 個）`);
    }
    if (!ch.every(nonEmpty)) r.error(`${w}.choices: どの選択肢も空でない文字列にする`);
    else {
      const norm = ch.map((c) => c.trim().toLowerCase());
      const dup = norm.find((c, j) => norm.indexOf(c) !== j);
      if (dup !== undefined) r.error(`${w}.choices: 同じ選択肢「${dup}」が2回`);
    }
    const a = x.answer;
    if (typeof a !== "number" || !Number.isInteger(a)) r.error(`${w}.answer: 整数（正解の番号。0 始まり）が必要`);
    else if (a < 0 || a >= ch.length) r.error(`${w}.answer: ${a} は選択肢の範囲外（0〜${ch.length - 1}）`);
    else answers.push(a);
  });
  if (answers.length >= 3 && answers.length === qs.length && answers.every((a) => a === answers[0])) {
    r.warn(`${where}.questions: どの設問も正解が ${answers[0] + 1} 番目（位置で当てられる。並びを散らす）`);
  }
}

/**
 * スクリプトの話者: 会話（kind: "dialogue"）は全行に speaker があり、話者がちょうど2人。
 * 会話でないのに speaker がある行は警告（画面では会話のときだけ話者を出す）
 */
export function checkDialogue(s: Obj, where: string, r: Report) {
  if (!Array.isArray(s.lines)) return;
  const lines = s.lines.filter(isObj);
  const withSpeaker = lines.filter((l) => l.speaker !== undefined);
  if (s.kind !== "dialogue") {
    if (withSpeaker.length > 0) r.warn(`${where}: kind が "dialogue" でないのに speaker のある行が ${withSpeaker.length} 行（話者は会話でだけ出す）`);
    return;
  }
  const missing = s.lines.flatMap((l, i) => (isObj(l) && nonEmpty(l.speaker) ? [] : [i]));
  if (missing.length) r.error(`${where}: 会話（kind: dialogue）なのに speaker の無い行がある（lines[${missing.slice(0, 5).join("], [")}]）`);
  const speakers = [...new Set(lines.flatMap((l) => (nonEmpty(l.speaker) ? [l.speaker.trim()] : [])))];
  if (speakers.length !== 2) r.error(`${where}: 会話の話者はちょうど2人にする（${speakers.length} 人: ${speakers.join(" / ") || "なし"}）`);
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
    if (kind === "passages") checkQuestions(item, where, r);
    if (kind === "scripts") checkDialogue(item, where, r);
  });
  // 一部の項目にだけ話題・難易度があると、その話題・難易度で絞り込んだときに無い項目が一覧から消える
  if (kind === "passages") checkPartialKey(raw, "topic", kind, r);
  if (kind === "scripts") checkPartialKey(raw, "level", kind, r);
  return ids;
}

/** 一部の項目にだけ key がある（ほかの項目に無い）なら警告（絞り込むと key の無い項目が一覧に出ない） */
function checkPartialKey(raw: readonly unknown[], key: string, kind: ContentKind, r: Report) {
  const items = raw.filter(isObj);
  const missing = items.filter((x) => !(key in x)).map((x) => (isStr(x.id) ? x.id : "?"));
  if (missing.length > 0 && missing.length < items.length) {
    r.warn(`${kind}: ${key} の無い項目 ${missing.join(", ")}（ほかの項目にはあるので、絞り込むと一覧から消える）`);
  }
}

/**
 * data/capoeira-category-map.json: { 元のカテゴリ: 表示するカテゴリ }（"_" で始まるキーはメモ）。
 * キーは capoeira-words.json に実在するカテゴリ、値は空でない文字列でキーと違うもの。
 * 付け替え先がまた付け替えられる（連鎖）と、読み込み（1回だけ引く）と食い違うのでエラー。
 * 付け替えた後のカテゴリの一覧（出現順）を返す
 */
export function checkCategoryMap(raw: unknown, capoeira: readonly RawWord[], r: Report): string[] {
  const cats: string[] = [];
  for (const w of capoeira) if (w && isStr(w.カテゴリ) && !cats.includes(w.カテゴリ)) cats.push(w.カテゴリ);
  if (!isObj(raw)) {
    r.error("capoeira-category-map: オブジェクトでない");
    return cats;
  }
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_")) continue;
    const where = `capoeira-category-map["${k}"]`;
    if (!cats.includes(k)) r.error(`${where}: capoeira-words.json にこのカテゴリが無い`);
    if (!nonEmpty(v)) {
      r.error(`${where}: 付け替え先は空でない文字列にする`);
      continue;
    }
    if (v !== v.trim()) r.error(`${where}: 付け替え先の前後に空白がある`);
    if (v.trim() === k) r.error(`${where}: 付け替え先が元のカテゴリと同じ`);
    map.set(k, v.trim());
  }
  for (const [k, v] of map) {
    if (map.has(v) && v !== k) r.error(`capoeira-category-map["${k}"]: 付け替え先「${v}」がまた付け替えられている（連鎖。最後の名前を直接書く）`);
  }
  const after: string[] = [];
  for (const c of cats) {
    const d = map.get(c) ?? c;
    if (!after.includes(d)) after.push(d);
  }
  return after;
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

// ---------------------------------------------------------------------------
// 拡充した教材の形（T2-3）: 読み物の話題・設問、スクリプトの会話、カポエイラのカテゴリの付け替え
{
  const Q = (o: Obj = {}) => ({ q: "どこ？", choices: ["A", "B", "C"], answer: 1, explain: "B とある", ...o });
  const psg = (o: Obj = {}) => ({
    id: "psg_q",
    title: "t",
    level: "short",
    source: "original",
    topic: "食事",
    chunks: [{ pt: "Oi.", ja: "やあ。" }],
    questions: [Q(), Q({ answer: 0 }), Q({ choices: ["A", "B", "C", "D"], answer: 3 })],
    ...o,
  });
  const P1 = (o: Obj) => (r: Report) => checkContentFile("passages", [psg(o)], r);
  flags(P1({}), null, "設問つきの読み物（話題・3〜4択・解説）");
  flags(P1({ questions: [Q({ answer: 3 })] }), /範囲外/, "設問: 答えの番号が選択肢の範囲外");
  flags(P1({ questions: [Q({ answer: -1 })] }), /範囲外/, "設問: 答えの番号が負");
  flags(P1({ questions: [Q({ answer: 1.5 })] }), /整数/, "設問: 答えの番号が整数でない");
  flags(P1({ questions: [Q({ answer: "1" })] }), /整数/, "設問: 答えの番号が文字列");
  flags(P1({ questions: [Q({ choices: ["A", "B"], answer: 0 })] }), /3〜4 個/, "設問: 選択肢が2個");
  flags(P1({ questions: [Q({ choices: ["A", "B", "C", "D", "E"] })] }), /3〜4 個/, "設問: 選択肢が5個");
  flags(P1({ questions: [Q({ choices: ["A", "b ", "B"] })] }), /同じ選択肢/, "設問: 同じ選択肢（大文字小文字・空白の違いだけ）");
  flags(P1({ questions: [Q({ choices: ["A", "", "C"] })] }), /空でない文字列/, "設問: 空の選択肢");
  flags(P1({ questions: [Q({ choices: "A,B,C" })] }), /choices: 配列/, "設問: 選択肢が配列でない");
  flags(P1({ questions: [Q({ q: "" })] }), /\.q: 空でない/, "設問: 問いが空");
  flags(P1({ questions: [Q({ explain: "" })] }), /explain/, "設問: 解説が空");
  flags(P1({ questions: [Q({ hint: "x" })] }), /未知の項目 "hint"/, "設問: 未知の項目");
  flags(P1({ questions: [] }), /空の配列/, "設問: 空の配列");
  flags(P1({ questions: { q: "x" } }), /questions: 配列が必要/, "設問: 配列でない");
  flags(P1({ questions: ["x"] }), /オブジェクトでない/, "設問: 要素がオブジェクトでない");
  flags(P1({ topic: " 食事" }), /topic: 前後に空白/, "話題の前後に空白");
  flags(P1({ topic: "" }), /topic/, "話題が空");
  flags(P1({ level: "easy" }), /level/, "読み物の難易度が範囲外");
  {
    const r = new Report();
    checkContentFile("passages", [psg({ questions: [Q({ answer: 2 }), Q({ answer: 2 }), Q({ answer: 2 })] })], r);
    expect(r.errors.length === 0 && r.warns.some((w) => /正解が 3 番目/.test(w)), "設問: どれも正解が同じ位置 → 警告だけ");
  }

  const L = (speaker: unknown, pt = "Oi.") => (speaker === undefined ? { pt, ja: "やあ" } : { pt, ja: "やあ", speaker });
  const scr = (o: Obj = {}) => ({ id: "scr_d", title: "t", level: "short", kind: "dialogue", lines: [L("Ana"), L("Yuki"), L("Ana")], ...o });
  const S1 = (o: Obj) => (r: Report) => checkContentFile("scripts", [scr(o)], r);
  flags(S1({}), null, "会話（2人・全行に話者・難易度つき）");
  flags(S1({ kind: "monologue", lines: [L(undefined)] }), null, "1人の語り（話者なし）");
  flags((r) => checkContentFile("scripts", [{ id: "scr_o", title: "t", lines: [L(undefined)] }], r), null, "難易度・種類の無い旧形式のスクリプト");
  flags(S1({ lines: [L("Ana"), L(undefined), L("Yuki")] }), /speaker の無い行/, "会話: 話者の無い行");
  flags(S1({ lines: [L("Ana"), L("Yuki"), L("Rui")] }), /ちょうど2人.*3 人/, "会話: 話者が3人");
  flags(S1({ lines: [L("Ana"), L("Ana")] }), /ちょうど2人.*1 人/, "会話: 話者が1人");
  flags(S1({ lines: [L("Ana"), L("Yuki "), L("Ana")] }), /前後に空白/, "会話: 話者の前後に空白（表記ゆれ）");
  flags(S1({ lines: [L("Ana"), L(""), L("Yuki")] }), /speaker/, "会話: 話者が空");
  flags(S1({ level: "easy" }), /level/, "スクリプトの難易度が範囲外");
  flags(S1({ kind: "chat" }), /kind/, "スクリプトの種類が範囲外");
  {
    const r = new Report();
    checkContentFile("scripts", [scr({ kind: "monologue" })], r);
    expect(r.errors.length === 0 && r.warns.some((w) => /speaker のある行が 3 行/.test(w)), "会話でないのに話者 → 警告だけ");
  }
  flags((r) => checkContentFile("scripts", [scr(), scr()], r), /重複/, "スクリプトの id 重複");
  {
    const r = new Report();
    checkContentFile("scripts", [scr(), { id: "scr_o", title: "t", lines: [L(undefined)] }], r);
    expect(r.errors.length === 0 && r.warns.some((w) => /level の無い項目 scr_o/.test(w)), "一部のスクリプトにだけ難易度 → 警告だけ");
    const r2 = new Report();
    checkContentFile("passages", [psg(), { ...psg({ id: "psg_n" }), topic: undefined }].map((x) => JSON.parse(JSON.stringify(x))), r2);
    expect(r2.errors.length === 0 && r2.warns.some((w) => /topic の無い項目 psg_n/.test(w)), "一部の読み物にだけ話題 → 警告だけ");
  }

  // カポエイラのカテゴリの付け替え
  const cw = (cat: string): RawWord => ({ カテゴリ: cat, ポルトガル語: "x", 日本語: "j", 品詞: "名詞" });
  const CAP = [cw("基本動作・技術"), cw("状態・方向"), cw("状態・評価"), cw("基本動作"), cw("音楽")];
  {
    const r = new Report();
    const after = checkCategoryMap(
      { _comment: "メモ", 基本動作: "基本動作・技術", "状態・方向": "状態・方向・評価", "状態・評価": "状態・方向・評価" },
      CAP,
      r
    );
    expect(
      r.errors.length === 0 && after.join("|") === "基本動作・技術|状態・方向・評価|音楽",
      `カテゴリの付け替え: 正しい表（付け替え後 ${after.join("|")}）`
    );
  }
  flags((r) => checkCategoryMap({ 存在しない: "x" }, CAP, r), /このカテゴリが無い/, "カテゴリの付け替え: 実在しないキー");
  flags((r) => checkCategoryMap({ 音楽: "音楽" }, CAP, r), /元のカテゴリと同じ/, "カテゴリの付け替え: 同じ名前へ");
  flags((r) => checkCategoryMap({ 音楽: "" }, CAP, r), /空でない/, "カテゴリの付け替え: 付け替え先が空");
  flags((r) => checkCategoryMap({ 音楽: 3 }, CAP, r), /空でない/, "カテゴリの付け替え: 付け替え先が文字列でない");
  flags((r) => checkCategoryMap({ 基本動作: "状態・方向", "状態・方向": "状態" }, CAP, r), /連鎖/, "カテゴリの付け替え: 連鎖");
  flags((r) => checkCategoryMap([], CAP, r), /オブジェクトでない/, "カテゴリの付け替え: 配列");
  flags((r) => checkCategoryMap({ _x: "何でも" }, CAP, r), null, "カテゴリの付け替え: _ で始まるキーはメモ");

  // 発話ドリル: 文型が多い（30文型）ときも、10問は重複なし・同じ文型が続かず10文型から出る
  {
    const many: Pattern[] = Array.from({ length: 30 }, (_, k) => ({
      id: `p${k}`,
      category: `c${k}`,
      frame: `F {X} ${k}.`,
      ja: `{X}の${k}`,
      slots: { X: Array.from({ length: 6 }, (_, i) => ({ pt: `w${k}_${i}`, ja: `j${i}` })) },
    }));
    flags((r) => checkPatternDrill(many, r, 10, 30), null, "発話ドリル: 30文型×6語から10問");
  }
}

// ---------------------------------------------------------------------------
// 教材の画面の純関数（services/materials）
{
  const ch = (pt: string, ja = "") => ({ pt, ja });
  const P = (id: string, level: string, topic?: unknown, o: Obj = {}): Passage =>
    ({ id, title: id, level, source: "original", chunks: [ch("Oi, tudo bem?"), ch("Sim."), ch("E você")], ...(topic !== undefined ? { topic } : {}), ...o }) as Passage;
  const ps = [P("a", "short", "旅行"), P("b", "medium", "食事"), P("c", "long"), P("d", "short", " 家族 "), P("e", "short", "趣味"), P("f", "medium", 3), P("g", "long", "旅行")];

  expect(parseLevelFilter("short") === "short" && parseLevelFilter("x") === "all" && parseLevelFilter(null) === "all", "parseLevelFilter: 知らない値は all");
  expect(matchesLevel(undefined, "all") && !matchesLevel(undefined, "short") && matchesLevel("long", "long"), "matchesLevel: 難易度の無い教材は「すべて」だけ");
  const gl = groupByLevel([{ id: 1, level: "long" }, { id: 2, level: "short" }, { id: 3 }, { id: 4, level: "short" }, { id: 5, level: "x" }]);
  expect(
    gl.map((g) => `${g.level}:${g.items.map((x) => x.id).join(",")}`).join(" ") === "short:2,4 long:1",
    "groupByLevel: 短文→中文→長文、空は出さない、難易度の無い項目は入れない"
  );
  expect(passageTopic(ps[3]) === "家族" && passageTopic(ps[2]) === null && passageTopic(ps[5]) === null, "passageTopic: 前後の空白を除く・無い・文字列でない");
  expect(topicsOf(ps).join("|") === "食事|家族|旅行|趣味", `topicsOf: よく使う話題の順 → 残りは出現順（${topicsOf(ps).join("|")}）`);
  expect(
    filterPassages(ps, "short", null).map((p) => p.id).join() === "a,d,e" &&
      filterPassages(ps, "all", "旅行").map((p) => p.id).join() === "a,g" &&
      filterPassages(ps, "long", "旅行").map((p) => p.id).join() === "g" &&
      filterPassages(ps, "all", null).length === ps.length,
    "filterPassages: 難易度と話題の両方で絞る"
  );
  expect(sentenceCount(ps[0]) === 3 && sentenceCount(P("z", "short", undefined, { chunks: [ch("A,"), ch("b."), ch(" ")] })) === 1, "sentenceCount: 文の数（本文の無い文は数えない）");
  expect(
    sentenceCount(P("y", "short", undefined, { chunks: [ch("A."), { ja: "x" }, null, ch("B.")] })) === 2 && sentenceCount(P("x", "short", undefined, { chunks: "A." })) === 0,
    "sentenceCount: 形の崩れたチャンク・配列でない chunks でも落ちない"
  );

  const good = { q: "問", choices: ["A", "B", "C"], answer: 2, explain: "説明" };
  const pq = P("q", "short", undefined, {
    questions: [good, { q: "", choices: ["A", "B"], answer: 0 }, { q: "問2", choices: ["A", "B"], answer: 2 }, { q: "問3", choices: ["A", 1], answer: 0 }, { q: "問4", choices: ["A", "B"], answer: 1, explain: 5 }, null, "x"],
  });
  const vq = passageQuestions(pq);
  expect(vq.length === 2 && vq[0].explain === "説明" && vq[1].q === "問4" && !("explain" in vq[1]), "passageQuestions: 崩れた設問を落とす（解説は文字列のときだけ）");
  expect(passageQuestions(P("n", "short", undefined, { questions: "x" })).length === 0 && passageQuestions(ps[0]).length === 0, "passageQuestions: 配列でない・無い → []");

  const qs = [good, { q: "b", choices: ["x", "y", "z"], answer: 0 }];
  const a0 = emptyAnswers(2);
  const a1 = answerQuestion(qs, a0, 0, 1);
  const a2 = answerQuestion(qs, a1, 0, 2);
  const a3 = answerQuestion(qs, a1, 1, 0);
  expect(a0[0] === null && a1[0] === 1 && a2 === a1 && a3[1] === 0 && a3[0] === 1, "answerQuestion: 1回目の答えで決まる（答え直せない）・元の配列は変えない");
  expect(answerQuestion(qs, a0, 5, 0) === a0 && answerQuestion(qs, a0, 0, 3) === a0 && answerQuestion(qs, a0, 0, -1) === a0, "answerQuestion: 範囲外の設問・選択肢は無視");
  const s1 = quizSummary(qs, a1);
  const s3 = quizSummary(qs, a3);
  expect(s1.answered === 1 && !s1.done && s3.done && s3.correct === 1 && s3.total === 2, "quizSummary: 回答数・正解数・全問回答");
  expect(!quizSummary([], []).done, "quizSummary: 設問0は done にしない");

  // 選択肢の出す順（画面でシャッフル。答えは元の番号のまま）
  const q4 = [good, { q: "b", choices: ["w", "x", "y", "z"], answer: 3 }];
  const o1 = choiceOrders(q4, "psg_x:0");
  expect(
    o1.length === 2 && o1.every((o, i) => o.length === q4[i].choices.length && [...o].sort().join() === q4[i].choices.map((_, k) => k).join()),
    "choiceOrders: 設問ごとに元の番号の並べ替え（抜け・重複なし）"
  );
  expect(JSON.stringify(choiceOrders(q4, "psg_x:0")) === JSON.stringify(o1), "choiceOrders: 同じ種なら同じ並び");
  expect(choiceOrders([], "x").length === 0, "choiceOrders: 設問0 → []");

  const np = normalizePassage(P("np", "short", " 旅行 ", { questions: [good, { q: "x" }] }));
  const np0 = normalizePassage(P("np0", "short", "", { questions: [{ q: "x" }] }));
  expect(np.topic === "旅行" && np.questions?.length === 1 && !("topic" in np0) && !("questions" in np0) && np0.chunks.length === 3, "normalizePassage: 話題を整え、崩れた設問を落とし、空の項目は置かない");

  const sc = (o: Obj): Script => ({ id: "s", title: "t", lines: [{ pt: "a", ja: "", speaker: " Ana " }, { pt: "b", ja: "", speaker: "Yuki" }, { pt: "c", ja: "", speaker: "Ana" }], ...o }) as Script;
  const dia = normalizeScript(sc({ kind: "dialogue", level: "medium" }));
  expect(lineSpeaker({ speaker: " Ana " }) === "Ana" && lineSpeaker({ speaker: "" }) === null && lineSpeaker({}) === null, "lineSpeaker: 前後の空白を除く・空は null");
  expect(scriptSpeakers(sc({})).join() === "Ana,Yuki", "scriptSpeakers: 出てくる順・重複なし");
  expect(dialogueSpeakers(dia)?.join() === "Ana,Yuki" && dia.level === "medium" && dia.lines[0].speaker === "Ana", "dialogueSpeakers: 会話の2人（normalizeScript で話者を整える）");
  expect(dialogueSpeakers(sc({})) === null && dialogueSpeakers(sc({ kind: "monologue" })) === null, "dialogueSpeakers: kind が dialogue でなければ null");
  expect(
    dialogueSpeakers(sc({ kind: "dialogue", lines: [{ pt: "a", ja: "", speaker: "A" }, { pt: "b", ja: "", speaker: "B" }, { pt: "c", ja: "" }] })) === null &&
      dialogueSpeakers(sc({ kind: "dialogue", lines: [{ pt: "a", ja: "", speaker: "A" }, { pt: "b", ja: "", speaker: "B" }, { pt: "c", ja: "", speaker: "C" }] })) === null &&
      dialogueSpeakers(sc({ kind: "dialogue", lines: [] })) === null,
    "dialogueSpeakers: 話者の無い行・3人・行なし → null（ふつうのスクリプトとして出す）"
  );
  const bad = normalizeScript(sc({ kind: "chat", level: "easy", lines: [{ pt: "a", ja: "", speaker: "  " }] }));
  expect(!("kind" in bad) && !("level" in bad) && !("speaker" in bad.lines[0]), "normalizeScript: 知らない種類・難易度・空の話者は置かない");

  const pat = (id: string, category: string): Pattern => ({ id, category, frame: `Eu {X} ${id}.`, ja: "{X}", slots: { X: [{ pt: "a", ja: "a" }] } });
  const groups = patternGroups([pat("1", "欲求"), pat("2", "カポエイラ：誘う"), pat("3", "場所"), pat("4", "欲求"), pat("5", "カポエイラ: 指示"), pat("6", "カポエイラ：誘う")]);
  expect(
    groups.map((g) => `${g.name ?? "基本"}=${g.entries.map((e) => `${e.pattern.id}:${e.label}`).join(",")}`).join(" ") ===
      "基本=1:欲求,4:欲求,3:場所 カポエイラ=2:誘う,6:誘う,5:指示",
    `patternGroups: 「：」の前でまとめ、同じカテゴリを隣に（${groups.map((g) => `${g.name}=${g.entries.map((e) => e.pattern.id).join(",")}`).join(" ")}）`
  );
  expect(patternGroups([pat("1", "カポエイラ：誘う")]).length === 1 && patternGroups([pat("1", "カポエイラ：誘う")])[0].name === "カポエイラ", "patternGroups: 基本の文型が無ければそのまとまりは出さない");
  expect(frameBlank("Eu quero {X}.") === "Eu quero ＿＿." && frameBlank("{S} {V:inf}") === "＿＿ ＿＿", "frameBlank: {…} を ＿＿ に");
}

// ---------------------------------------------------------------------------
// 会話のロールプレイ（services/rolePlay）: 偽の読み上げ・待ちで進行を確かめる
{
  expect(turnGapMs("Oi.", 1) === 1500 && turnGapMs("x".repeat(30), 1) === 2700 && turnGapMs("x".repeat(30), 1.5) === 1800, "turnGapMs: max(1.5秒, 文字数×90ms÷速さ)");
  expect(turnGapMs("x".repeat(30), 0) === 2700 && turnGapMs("  Oi  ", NaN) === 1500, "turnGapMs: 速さが 0・NaN なら 1.0");
  const lines = [
    { pt: "A1", speaker: "Ana" },
    { pt: "Y1", speaker: "Yuki" },
    { pt: "A2", speaker: "Ana" },
    { pt: "A3", speaker: "Ana" },
    { pt: "Y2", speaker: "Yuki" },
  ];
  const mine = myTurns(lines, "Yuki");
  expect(mine.join() === "false,true,false,false,true", "myTurns: 自分の役の行");

  /** 偽の依存。onTurn / onSpeak で途中に止める */
  const fake = (hooks: { onSpeak?: (i: number) => void; onTurn?: (i: number) => void; onPause?: () => void } = {}) => {
    const log: string[] = [];
    const deps: RolePlayDeps = {
      speak: async (t, i) => {
        log.push(`speak:${t}`);
        hooks.onSpeak?.(i);
      },
      turn: async (i, signal) => {
        log.push(`turn:${i}`);
        hooks.onTurn?.(i);
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
      },
      pause: async (ms, signal) => {
        log.push(`pause:${ms}`);
        hooks.onPause?.();
        if (signal.aborted) throw new DOMException("aborted", "AbortError");
      },
      onLine: (i, m) => log.push(`line:${i}${m ? "*" : ""}`),
    };
    return { log, deps };
  };

  {
    const f = fake();
    const ctrl = new AbortController();
    const p = runRolePlay(lines, mine, 0, f.deps, ctrl.signal, 500);
    // 最初の読み上げは呼び出しの中で同期に始まる（クリック処理の中で speak する）
    expect(f.log.join() === "line:0,speak:A1", `runRolePlay: 最初の読み上げは同期（${f.log.join()}）`);
    const res = await p;
    expect(
      f.log.join(" ") === "line:0 speak:A1 line:1* turn:1 line:2 speak:A2 pause:500 line:3 speak:A3 line:4* turn:4",
      `runRolePlay: 相手の行は読み、自分の行は待つ。間は相手の行が続くときだけ（${f.log.join(" ")}）`
    );
    expect(res.completed && res.next === 5, "runRolePlay: 最後まで → completed");
  }
  {
    const ctrl = new AbortController();
    const f = fake({ onTurn: (i) => i === 1 && ctrl.abort() });
    const res = await runRolePlay(lines, mine, 0, f.deps, ctrl.signal);
    expect(!res.completed && res.next === 1 && !f.log.includes("line:2"), "runRolePlay: 自分の番で止めた → その行から再開");
    const f2 = fake();
    const res2 = await runRolePlay(lines, mine, res.next, f2.deps, new AbortController().signal);
    expect(res2.completed && f2.log[0] === "line:1*", "runRolePlay: 止めた行から再開して最後まで");
  }
  {
    const ctrl = new AbortController();
    const f = fake({ onSpeak: (i) => i === 2 && ctrl.abort() });
    const res = await runRolePlay(lines, mine, 0, f.deps, ctrl.signal);
    expect(!res.completed && res.next === 2 && !f.log.some((x) => x.startsWith("pause")), "runRolePlay: 読み上げの途中で止めた → その行から");
  }
  {
    const ctrl = new AbortController();
    const f = fake({ onPause: () => ctrl.abort() });
    const res = await runRolePlay(lines, mine, 0, f.deps, ctrl.signal);
    expect(!res.completed && res.next === 3, "runRolePlay: 行の後の間で止めた → 次の行から");
  }
  {
    const f = fake();
    const ctrl = new AbortController();
    ctrl.abort();
    const r1 = await runRolePlay(lines, mine, 0, f.deps, ctrl.signal);
    const r2 = await runRolePlay(lines, mine, 9, f.deps, new AbortController().signal);
    expect(!r1.completed && r1.next === 0 && !r2.completed && r2.next === 5 && f.log.length === 0, "runRolePlay: 止めてから・範囲外からは何もしない");
  }
  {
    const f = fake();
    const res = await runRolePlay(lines, myTurns(lines, "Ana"), 0, f.deps, new AbortController().signal, 0);
    expect(res.completed && f.log[1] === "turn:0" && !f.log.some((x) => x.startsWith("pause")), "runRolePlay: 自分が先に話す役・間 0");
  }

  // waitTurn: 「次へ」・考える間・止める
  {
    let adv: (() => void) | null = null;
    const set = (fn: (() => void) | null) => {
      adv = fn;
    };
    const t0 = Date.now();
    const pNext = waitTurn(null, new AbortController().signal, set);
    const gotAdv = typeof adv === "function";
    (adv as unknown as () => void)();
    await pNext;
    expect(gotAdv && adv === null && Date.now() - t0 < 1000, "waitTurn: 「次へ」で進み、終わったら setAdvance(null)");

    await waitTurn(20, new AbortController().signal, set);
    expect(adv === null && Date.now() - t0 >= 20, "waitTurn: 考える間が過ぎたら進む");

    const ctrl = new AbortController();
    const pAbort = waitTurn(10_000, ctrl.signal, set);
    ctrl.abort();
    let rejected = false;
    try {
      await pAbort;
    } catch (e) {
      rejected = e instanceof DOMException && e.name === "AbortError";
    }
    expect(rejected && adv === null, "waitTurn: 止めたら AbortError（考える間のタイマーも止まる）");

    const done = new AbortController();
    done.abort();
    let rejected2 = false;
    await waitTurn(null, done.signal, set).catch(() => (rejected2 = true));
    expect(rejected2, "waitTurn: 止めた後に呼んだら、すぐ AbortError");

    // 「次へ」を2回押しても1回だけ（2回目は何もしない。次の番の「次へ」を消さない）
    let n = 0;
    const p2 = waitTurn(null, new AbortController().signal, set).then(() => n++);
    const a = adv as unknown as () => void;
    a();
    await p2;
    const p3 = waitTurn(null, new AbortController().signal, set);
    const b = adv as unknown as () => void;
    a();
    const keptNext = adv === b;
    b();
    await p3;
    expect(n === 1 && keptNext, "waitTurn: 前の番の「次へ」をもう一度押しても、次の番の「次へ」は消えない");
  }
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
  // 内容チェックの正解の位置: 画面の並び（choiceOrders）では、同じ並びの読み物が偏らない
  const withQ = (loadJson("data/passages.json") as Passage[]).filter((p) => passageQuestions(p).length > 0);
  const seqs = new Map<string, number>();
  for (const p of withQ) {
    const qs = passageQuestions(p);
    const shown = choiceOrders(qs, `${p.id}:0`).map((o, qi) => String.fromCharCode(65 + o.indexOf(qs[qi].answer))).join("");
    seqs.set(shown, (seqs.get(shown) ?? 0) + 1);
  }
  const top = Math.max(0, ...seqs.values());
  console.log(`  内容チェック: 画面での正解の位置の並び ${seqs.size} 通り（最多 ${top} / ${withQ.length} 件）`);
  if (withQ.length >= 6 && top > withQ.length / 3) report.warn(`内容チェック: 画面での正解の位置の並びが ${top} / ${withQ.length} 件で同じ（位置で当てられる）`);
}
{
  const d = checkPatternDrill(loadJson("data/patterns.json"), report);
  console.log(`  patterns → 発話ドリル: ${d.items} 文（うち jaFull ${d.jaFull}）`);
}
{
  // 画面で読む形（content.ts と同じ整え）でも、検査を通った設問・会話がそのまま残るか
  const rawP = loadJson("data/passages.json");
  const rawS = loadJson("data/scripts.json");
  const rawPat = loadJson("data/patterns.json");
  if (Array.isArray(rawP)) {
    const ps = (rawP.filter(isObj) as unknown as Passage[]).map(normalizePassage);
    const nq = ps.reduce((n, p) => n + (p.questions?.length ?? 0), 0);
    const rawQ = rawP.filter(isObj).reduce((n, p) => n + (Array.isArray(p.questions) ? p.questions.length : 0), 0);
    if (nq !== rawQ) report.error(`passages: 画面に出せない設問がある（${rawQ} 問中 ${nq} 問）`);
    const levels = groupByLevel(ps).map((g) => `${g.level} ${g.items.length}`).join("・");
    console.log(`  passages: ${levels} / 話題 ${topicsOf(ps).join("・") || "なし"} / 内容チェック ${nq} 問（${ps.filter((p) => p.questions).length} 編）`);
  }
  if (Array.isArray(rawS)) {
    const ss = (rawS.filter((s) => isObj(s) && Array.isArray(s.lines)) as unknown as Script[]).map(normalizeScript);
    const dialogues = ss.filter((s) => dialogueSpeakers(s) !== null);
    const declared = ss.filter((s) => s.kind === "dialogue").length;
    if (dialogues.length !== declared) report.error(`scripts: 会話（kind: dialogue）${declared} 本のうち、ロールプレイにできるのは ${dialogues.length} 本`);
    console.log(`  scripts: 会話 ${dialogues.length} 本・そのほか ${ss.length - dialogues.length} 本（難易度つき ${ss.filter((s) => s.level).length} 本）`);
  }
  if (Array.isArray(rawPat) && rawPat.every((p) => isObj(p) && isStr(p.category))) {
    const pats = rawPat as unknown as Pattern[];
    const groups = patternGroups(pats);
    const listed = groups.flatMap((g) => g.entries.map((e) => e.pattern.id));
    if (listed.length !== pats.length || new Set(listed).size !== pats.length) report.error("patterns → 一覧: まとめると漏れる・重なる文型がある");
    console.log(`  patterns → 一覧: ${groups.map((g) => `${g.name ?? "基本"} ${g.entries.length}`).join("・")}`);
  }
}

console.log("=== カテゴリの付け替え・導入順（core-order）・別名（word-aliases） ===");
const tables: WordTables = {
  words: asTable(loadJson("data/words.json"), "words"),
  capoeira: asTable(loadJson("data/capoeira-words.json"), "capoeira-words"),
  dict: asTable(loadJson("data/dict-words.json"), "dict-words"),
};
{
  const before = new Set(tables.capoeira.map((w) => w?.カテゴリ)).size;
  const after = checkCategoryMap(loadJson("data/capoeira-category-map.json"), tables.capoeira, report);
  console.log(`  capoeira-category-map: カポエイラのカテゴリ ${before} → ${after.length}（${after.join(" ／ ")}）`);
}
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
