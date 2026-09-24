// ============================================================================
// バックアップファイルの形式（純関数。ストア・DOM・localStorage に触らない）
//   検証: scripts/check-backup.ts（npm run check:backup）
// v1: 進捗だけ（useProgress.exportJSON の形。version が無い古いファイルも v1）
// v2: v1 と同じ最上位フィールド ＋ music
// v3: v2 ＋ app・settings（任意フィールドを足しただけ。旧版のアプリでも最上位の項目で読める）
//     B2-06 で任意フィールド history（日ごとの学習ログ）を足した（version は 3 のまま。無ければ {}）。
// v4 以降（新しいアプリで作ったファイル）: 警告を出し、このアプリが知っている項目だけ読む。
// 歌詞の本文・歌詞キャッシュ（lyricsCache）は書き出さず、読み込みでも拾わない。
// ============================================================================

import type { Passage, Settings, SrsCard, SrsLevel } from "../data/types";
import type { UserWordRaw } from "../data/loadWords";
import type { AddedWord, LineTranslation, MusicExport, SongState } from "./useMusic";
import { readHistory, type History } from "./history";

export const BACKUP_VERSION = 3;

export interface AppInfo {
  version: string;
  build: string;
}

/** 進捗の部分（useProgress.importJSON に渡せる形） */
export interface ProgressPart {
  cards: Record<string, SrsCard>;
  streak: number;
  bestStreak: number;
  lastStudyDate: string | null;
  totalReviews: number;
  customPassages: Passage[];
  pinnedNew: string[];
  /** 日ごとの学習ログ（B2-06 で追加した任意フィールド。無い古いファイルは {}） */
  history: History;
}

/** parseBackup で読み取った中身（知っている項目だけ・型を確かめ済み） */
export interface BackupData {
  /** ファイルの version（無い古いファイルは 1） */
  version: number;
  exportedAt: string | null;
  /** 作ったアプリの版（v3 以降） */
  app: AppInfo | null;
  progress: ProgressPart;
  /** v1 は null（曲のデータを持たない → 端末側をそのまま残す） */
  music: MusicExport | null;
  /** v3 以降。voiceURI（端末ごとの音声）は含めない */
  settings: Partial<Settings> | null;
}

export type ParseResult =
  | { ok: true; data: BackupData; warnings: string[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// 設定の項目表。Settings に項目を足すと、ここに足すまで型エラーになる（書き出し漏れを防ぐ）。
// - "count": 0 以上の有限の数 / "positive": 0 より大きい有限の数 / "ratio": 0 以上 1 以下の数 / "boolean"
// - 文字列の配列: その値のどれか
// - null: バックアップに入れない（voiceURI は端末ごとに違うため）
// ---------------------------------------------------------------------------
type SettingKind = "count" | "positive" | "ratio" | "boolean" | readonly string[] | null;

const SETTINGS_SCHEMA: { [K in keyof Settings]-?: SettingKind } = {
  rate: "positive",
  dailyNewLimit: "count",
  dailyGoal: "count",
  voiceURI: null,
  showKana: "boolean",
  showIpa: "boolean",
  musicNewLimit: "count",
  pauseOnWordTap: "boolean",
  studyView: ["session", "list"],
  studyDirection: ["pt2ja", "ja2pt", "mixed"],
  autoPlayOnReveal: "boolean",
  // B2-03/B2-04 で追加（任意フィールド。無い古いファイルでは端末側の値のまま）
  capoeiraShare: "ratio",
  dailyReviewLimit: "positive",
};

function settingOk(kind: SettingKind, v: unknown): boolean {
  if (kind === null) return false;
  if (kind === "boolean") return typeof v === "boolean";
  if (kind === "count") return typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (kind === "positive") return typeof v === "number" && Number.isFinite(v) && v > 0;
  if (kind === "ratio") return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
  return typeof v === "string" && kind.includes(v);
}

/**
 * 設定のうちバックアップに入れる・取り込むもの。
 * 項目表にある項目で、型と値が正しいものだけを返す（関数・voiceURI・未知の項目は落とす）。
 */
export function pickSettings(raw: unknown): Partial<Settings> {
  const out: Record<string, unknown> = {};
  if (!isObj(raw)) return out;
  for (const [k, kind] of Object.entries(SETTINGS_SCHEMA) as [string, SettingKind][]) {
    if (settingOk(kind, raw[k])) out[k] = raw[k];
  }
  return out as Partial<Settings>;
}

// ---------------------------------------------------------------------------
// 小さな検査関数
// ---------------------------------------------------------------------------
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const num = (v: unknown, d = 0): number => (isNum(v) ? v : d);
const str = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === "string" && DATE_RE.test(v);
const LEVELS: readonly SrsLevel[] = ["new", "learning", "young", "mature"];

/**
 * 1枚分のカード。スケジュールに使う項目の型を確かめる（壊れていれば null）。
 * 知らない項目（将来版が足したもの）はそのまま残す。level は表示に使わない（displayLevel で導く）ので、
 * 壊れていても "new" で補う。
 */
function readCard(v: unknown): SrsCard | null {
  if (!isObj(v)) return null;
  if (![v.ease, v.intervalDays, v.reps, v.lapses].every(isNum)) return null;
  if (!isDate(v.due)) return null;
  const last = v.last ?? null;
  if (last !== null && !isDate(last)) return null;
  const level = LEVELS.includes(v.level as SrsLevel) ? (v.level as SrsLevel) : "new";
  return { ...v, level, last } as SrsCard;
}

function readPassage(v: unknown): v is Passage {
  return isObj(v) && typeof v.id === "string" && typeof v.title === "string" && Array.isArray(v.chunks);
}

/**
 * 曲のデータ。songs は既知の項目（offsetMs・translations）だけで組み直す
 * （歌詞の本文など、知らない項目を端末に持ち込まないため）。
 * addedWords・userWords は必須の項目を確かめ、それ以外はそのまま通す。
 */
export function readMusic(v: unknown): MusicExport | null {
  if (!isObj(v)) return null;
  const songs: Record<string, SongState> = {};
  if (isObj(v.songs)) {
    for (const [vid, s] of Object.entries(v.songs)) {
      if (!isObj(s)) continue;
      const translations: Record<string, LineTranslation> = {};
      if (isObj(s.translations)) {
        for (const [k, t] of Object.entries(s.translations)) {
          if (isObj(t) && typeof t.text === "string") translations[k] = { text: t.text, edited: t.edited === true };
        }
      }
      songs[vid] = { offsetMs: num(s.offsetMs), translations };
    }
  }
  const addedWords: AddedWord[] = Array.isArray(v.addedWords)
    ? v.addedWords
        .filter((w): w is Record<string, unknown> => isObj(w) && typeof w.id === "string" && typeof w.videoId === "string")
        .map((w) => ({ ...w, surface: str(w.surface), createdCard: w.createdCard === true, addedAt: str(w.addedAt) }) as AddedWord)
    : [];
  const userWords: UserWordRaw[] = Array.isArray(v.userWords)
    ? v.userWords
        .filter((u): u is Record<string, unknown> => isObj(u) && typeof u.id === "string" && typeof u.pt === "string")
        .map((u) => ({ ...u, ja: str(u.ja), pos: str(u.pos) }) as UserWordRaw)
    : [];
  return { songs, addedWords, userWords };
}

// ---------------------------------------------------------------------------
// 書き出し
// ---------------------------------------------------------------------------

/**
 * v3 のバックアップを組み立てる。progress は useProgress.exportJSON() を parse したもの。
 * 進捗の項目は最上位に置いたまま（旧版のアプリでも読める）、music・settings・app を足す。
 */
export function composeBackup(p: {
  progress: Record<string, unknown>;
  music: MusicExport;
  settings: unknown;
  app: AppInfo;
}): Record<string, unknown> {
  return {
    ...p.progress,
    // 学習ログも読み込みと同じ規則で組み直す（日付のキーと件数・秒数だけ）
    ...(p.progress.history !== undefined ? { history: readHistory(p.progress.history) } : {}),
    version: BACKUP_VERSION,
    app: p.app,
    // ストアに紛れ込んだ未知の項目も書き出さない（読み込みと同じ規則で組み直す）
    music: readMusic(p.music) ?? { songs: {}, addedWords: [], userWords: [] },
    settings: pickSettings(p.settings),
  };
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

const fail = (error: string): ParseResult => ({ ok: false, error });

/** バックアップのテキスト（.json / 共有した .txt / 貼り付け）を読む。ストアには触らない */
export function parseBackup(json: string): ParseResult {
  let raw: unknown;
  try {
    // 先頭の BOM と前後の空白（貼り付け時の改行など）は無視する
    raw = JSON.parse(json.replace(/^﻿/, "").trim());
  } catch {
    return fail("JSON として読めません。ファイルが壊れているか、バックアップ以外のファイルです");
  }
  if (!isObj(raw)) return fail("バックアップの形式ではありません");

  const version = raw.version === undefined ? 1 : raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return fail("バックアップの形式ではありません（version が不正です）");
  }
  if (!isObj(raw.cards)) return fail("学習データ（cards）が見つかりません");

  const warnings: string[] = [];
  const app: AppInfo | null =
    version >= 3 && isObj(raw.app) ? { version: str(raw.app.version), build: str(raw.app.build) } : null;
  if (version > BACKUP_VERSION) {
    const by = app?.version ? `（v${app.version}）` : "";
    warnings.push(`新しいバージョンのアプリ${by}で作ったファイルです。このアプリが知っている項目だけ読み込みます。`);
  }

  const cards: Record<string, SrsCard> = {};
  const entries = Object.entries(raw.cards);
  let broken = 0;
  for (const [id, c] of entries) {
    const card = readCard(c);
    if (card) cards[id] = card;
    else broken++;
  }
  if (entries.length > 0 && broken === entries.length) return fail("学習データ（cards）が読めません");
  if (broken > 0) warnings.push(`壊れていた単語の記録 ${broken}件を読み飛ばしました。`);

  const progress: ProgressPart = {
    cards,
    streak: Math.max(0, num(raw.streak)),
    bestStreak: Math.max(0, num(raw.bestStreak)),
    lastStudyDate: isDate(raw.lastStudyDate) ? raw.lastStudyDate : null,
    totalReviews: Math.max(0, num(raw.totalReviews)),
    customPassages: Array.isArray(raw.customPassages) ? raw.customPassages.filter(readPassage) : [],
    // v3 で足した任意フィールド（無ければ空）
    pinnedNew: Array.isArray(raw.pinnedNew) ? raw.pinnedNew.filter((x): x is string => typeof x === "string") : [],
    // B2-06 で足した任意フィールド。日付のキー・既知の項目だけで組み直す（無い・不正なら {}）
    history: readHistory(raw.history),
  };

  return {
    ok: true,
    warnings,
    data: {
      version,
      exportedAt: typeof raw.exportedAt === "string" ? raw.exportedAt : null,
      app,
      progress,
      // v1 は music を持たない（あっても読まない）
      music: version >= 2 ? readMusic(raw.music) : null,
      settings: version >= 3 && isObj(raw.settings) ? pickSettings(raw.settings) : null,
    },
  };
}

/** 取り込みの確認に出す要約（例: 「2026-09-20 作成・単語 120語・曲の単語 8語・設定を含む」） */
export function describeBackup(d: BackupData): string {
  const parts: string[] = [];
  const at = d.exportedAt ? new Date(d.exportedAt) : null;
  if (at && !Number.isNaN(at.getTime())) {
    const p = (n: number) => String(n).padStart(2, "0");
    parts.push(`${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} 作成`);
  }
  const studied = Object.values(d.progress.cards).filter((c) => c.last).length;
  parts.push(`学習した単語 ${studied}語`);
  parts.push(`評価 ${d.progress.totalReviews}回`);
  const days = Object.keys(d.progress.history).length;
  if (days) parts.push(`学習ログ ${days}日分`);
  if (d.music) parts.push(`曲の単語 ${new Set(d.music.addedWords.map((w) => w.id)).size}語`);
  if (d.settings && Object.keys(d.settings).length) parts.push("設定を含む");
  return parts.join("・");
}
