// ============================================================================
// 「話す」練習の保存データの形と純関数（ストア・DOM・localStorage に触らない）
//   検証: scripts/check-speak.ts（npm run check:speak）
// - cards: 文のカード（口慣らし＝日本語を見てポルトガル語を言う）。キーはフレーズの ID
//   （レッスンの文は "u1l1p1"、自分で足した文は "my:…"）。形は単語と同じ SrsCard（srs/scheduler.ts）
// - phrases: 自分で足した文（言いたいこと・会話で直された文）
// - lessons: レッスンの進み具合（どのステップまで進んだか・終えた日）
// - talks: AI との会話の記録（日付・場面・往復の数・秒数だけ。会話の中身は保存しない）
// useSpeak（保存）・backupFormat（読み込みの検査）・backup（統合インポート）で共通に使う。
// ============================================================================

import type { SrsCard } from "../data/types";
import { readCard } from "../srs/cardIo";
import { mergeCards } from "../store/merge";

/** 自分で足した文の ID の頭 */
export const MY_PREFIX = "my:";

/** 自分で足した文の出どころ（manual = 手で入力 / ai = AI に訳してもらった / mt = 機械翻訳 / talk = 会話で直された文） */
export const PHRASE_SOURCES = ["manual", "ai", "mt", "talk"] as const;
export type PhraseSource = (typeof PHRASE_SOURCES)[number];

export interface UserPhrase {
  /** "my:" で始まる ID（作ったときに決めて、変えない） */
  id: string;
  ja: string;
  pt: string;
  /** 同じ意味で言ってよい別の言い方 */
  alt?: string[];
  note?: string;
  /** 作った日（YYYY-MM-DD） */
  createdAt: string;
  from: PhraseSource;
}

/** レッスンのステップ数（0 聞く / 1 まねる / 2 言う / 3 演じる）。step がこの数なら全部済み */
export const LESSON_STEPS = 4;

export interface LessonProgress {
  /** 次にやるステップ（0〜LESSON_STEPS） */
  step: number;
  /** はじめて最後まで終えた日（YYYY-MM-DD）。まだなら null */
  doneAt: string | null;
}

export interface TalkLog {
  /** 会話した日（YYYY-MM-DD） */
  at: string;
  /** 場面の ID（レッスンの ID、"free:…"、"custom"） */
  id: string;
  /** 学習者が話した回数 */
  turns: number;
  sec: number;
}

/** 残す会話の記録の数 */
export const TALK_LOG_MAX = 60;
/** 自分で足す文の上限（保存データを大きくしすぎない） */
export const USER_PHRASE_MAX = 500;
/** 文の長さの上限（文字） */
export const PHRASE_TEXT_MAX = 200;

/** バックアップに入れる部分 */
export interface SpeakExport {
  cards: Record<string, SrsCard>;
  phrases: UserPhrase[];
  lessons: Record<string, LessonProgress>;
  talks: TalkLog[];
}

export const emptySpeak = (): SpeakExport => ({ cards: {}, phrases: [], lessons: {}, talks: [] });

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, PHRASE_TEXT_MAX) : "");

/** 自分で足した文の ID を作る（時刻＋乱数。重複しなければよい） */
export function newPhraseId(now: number = Date.now(), rand: number = Math.random()): string {
  return `${MY_PREFIX}${now.toString(36)}${Math.floor(rand * 46656).toString(36).padStart(3, "0")}`;
}

export const isMyPhraseId = (id: string): boolean => id.startsWith(MY_PREFIX) && id.length > MY_PREFIX.length;

/** 自分で足した文1つ。ID・和文・ポルトガル語がそろっていなければ null */
export function readUserPhrase(v: unknown): UserPhrase | null {
  if (!isObj(v) || typeof v.id !== "string" || !isMyPhraseId(v.id)) return null;
  const ja = text(v.ja);
  const pt = text(v.pt);
  if (!ja || !pt) return null;
  const alt = Array.isArray(v.alt) ? v.alt.map(text).filter(Boolean).slice(0, 5) : [];
  const note = text(v.note);
  const from = (PHRASE_SOURCES as readonly string[]).includes(v.from as string) ? (v.from as PhraseSource) : "manual";
  return {
    id: v.id,
    ja,
    pt,
    ...(alt.length ? { alt } : {}),
    ...(note ? { note } : {}),
    createdAt: isDate(v.createdAt) ? v.createdAt : "1970-01-01",
    from,
  };
}

export function readLessonProgress(v: unknown): LessonProgress | null {
  if (!isObj(v)) return null;
  const step = Math.min(LESSON_STEPS, count(v.step));
  const doneAt = isDate(v.doneAt) ? v.doneAt : null;
  return { step: doneAt ? LESSON_STEPS : step, doneAt };
}

export function readTalkLog(v: unknown): TalkLog | null {
  if (!isObj(v) || !isDate(v.at) || typeof v.id !== "string" || !v.id) return null;
  return { at: v.at, id: v.id.slice(0, 60), turns: count(v.turns), sec: count(v.sec) };
}

const talkKey = (t: TalkLog) => `${t.at}|${t.id}|${t.turns}|${t.sec}`;

/** 会話の記録を新しい順に並べ、上限で切る */
function tidyTalks(list: readonly TalkLog[]): TalkLog[] {
  const seen = new Set<string>();
  const out: TalkLog[] = [];
  for (const t of list) {
    const k = talkKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  // 同じ日の中の順は保つ（安定ソート）
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, TALK_LOG_MAX);
}

/**
 * 保存データ・バックアップの speak を読む。知っている項目だけで組み直す（壊れた項目は落とす）。
 * object でなければ null（ファイルに無い扱い。置き換えの取り込みでも端末の記録を消さない）。
 */
export function readSpeak(v: unknown): SpeakExport | null {
  if (!isObj(v)) return null;
  const cards: Record<string, SrsCard> = {};
  if (isObj(v.cards)) {
    for (const [id, c] of Object.entries(v.cards)) {
      const card = readCard(c);
      if (card && id) cards[id] = card;
    }
  }
  const phrases: UserPhrase[] = [];
  const seen = new Set<string>();
  if (Array.isArray(v.phrases)) {
    for (const p of v.phrases) {
      const up = readUserPhrase(p);
      if (!up || seen.has(up.id)) continue;
      seen.add(up.id);
      phrases.push(up);
      if (phrases.length >= USER_PHRASE_MAX) break;
    }
  }
  const lessons: Record<string, LessonProgress> = {};
  if (isObj(v.lessons)) {
    for (const [id, l] of Object.entries(v.lessons)) {
      const lp = readLessonProgress(l);
      if (lp && id) lessons[id] = lp;
    }
  }
  const talks = Array.isArray(v.talks) ? tidyTalks(v.talks.map(readTalkLog).filter((t): t is TalkLog => t !== null)) : [];
  return { cards, phrases, lessons, talks };
}

/**
 * 統合インポート: この端末（local）とバックアップ（remote）の記録を合わせる。
 * - cards: 文ごとに、新しく学習した方（単語と同じ規則。merge.mergeCards）
 * - phrases: 両方の文を残す（同じ ID はこの端末の方）
 * - lessons: 終えた日は早い方、ステップは進んでいる方
 * - talks: 両方の記録（重複は1つに）
 */
export function mergeSpeak(local: SpeakExport, remote: SpeakExport | null): SpeakExport {
  if (!remote) return local;
  const cards = mergeCards(local.cards, remote.cards);

  const ids = new Set(local.phrases.map((p) => p.id));
  const phrases = [...local.phrases, ...remote.phrases.filter((p) => !ids.has(p.id))].slice(0, USER_PHRASE_MAX);

  const lessons: Record<string, LessonProgress> = { ...local.lessons };
  for (const [id, r] of Object.entries(remote.lessons)) {
    const l = lessons[id];
    if (!l) {
      lessons[id] = r;
      continue;
    }
    const doneAt = l.doneAt && r.doneAt ? (l.doneAt < r.doneAt ? l.doneAt : r.doneAt) : l.doneAt ?? r.doneAt;
    lessons[id] = { step: doneAt ? LESSON_STEPS : Math.max(l.step, r.step), doneAt };
  }
  return { cards, phrases, lessons, talks: tidyTalks([...local.talks, ...remote.talks]) };
}
