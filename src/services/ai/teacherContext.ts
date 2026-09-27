// ============================================================================
// 🧑‍🏫 AI 先生: 「いま見ている内容」（文脈）と、先生のシートの画面の状態（保存しない。永続化なし）
//   検証: scripts/check-ai.ts（npm run check:ai）
// - TeacherContext: 各画面の「🧑‍🏫 先生に聞く」が作る文脈（歌詞の行・歌詞の単語・文型・単語・文・画面）。
//   kind（種類）・label（シートに出す短いチップ。歌詞の本文は入れない）・data（プロンプトに入れる中身）。
//   作るのは下の songLineContext などの純関数。プロンプトへの書き方は teacherPrompt.ts
// - useTeacherUi: シートが開いているか・新しい会話の文脈・開いている会話・入力の下書き・返事の受信の状態。
//   openTeacher(ctx?, question?) で開く（ctx を渡すと新しい会話。質問は下書きに入れるだけで、送らない）。
//   closeTeacher() で閉じる（受信中の返事は止めない。閉じても最後まで受け取って履歴に入る）。
//   abortTeacherRun() で受信を止める（設定で API キーを削除・差し替えたときにも呼ぶ）
// - 会話の履歴（端末だけに保存）は store/useTeacher.ts、送る処理は teacherChat.ts
// ============================================================================

import { create } from "zustand";
import type { AiErrorKind } from "./types";

export type TeacherContextKind = "song-line" | "song-word" | "pattern" | "word" | "sentence" | "general";

/** 先生に渡す「いま見ている内容」 */
export interface TeacherContext {
  kind: TeacherContextKind;
  /** シートに出す短い見出し（例: 「🎵 曲名 — 12行目」）。歌詞の本文は入れない */
  label: string;
  /** プロンプトに入れる中身（項目名 → 文字列か文字列の配列）。書き方は teacherPrompt.ts の contextBlock */
  data: Record<string, string | string[]>;
}

export const TEACHER_CONTEXT_KINDS: readonly TeacherContextKind[] = ["song-line", "song-word", "pattern", "word", "sentence", "general"];

// ---------------------------------------------------------------------------
// 文脈を作る（純関数）
// ---------------------------------------------------------------------------

/** 文字列を n 文字までに縮める（超えたら末尾に …） */
export function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t;
}

/** 空でない値だけを残す（空の文字列・空の配列は項目ごと置かない） */
function compact(data: Record<string, string | string[] | null | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      const list = v.map((x) => x.trim()).filter(Boolean);
      if (list.length) out[k] = list;
    } else if (typeof v === "string" && v.trim()) out[k] = v.trim();
  }
  return out;
}

/** 文型の {X} を「〜」に（チップ用） */
const frameLabel = (frame: string) => frame.replace(/\{[^{}]*\}/g, "〜");

/**
 * 歌詞の1行。前後2行ずつ（空の行・♪ は飛ばす）と、今出している訳を付ける。
 * チップは「🎵 曲名 — N行目」（歌詞の本文は入れない）
 */
export function songLineContext(p: {
  title: string;
  artist: string;
  lines: readonly string[];
  index: number;
  translation?: string | null;
}): TeacherContext {
  const line = p.lines[p.index] ?? "";
  const before: string[] = [];
  for (let i = p.index - 1; i >= 0 && before.length < 2; i--) if (p.lines[i]?.trim()) before.unshift(p.lines[i]);
  const after: string[] = [];
  for (let i = p.index + 1; i < p.lines.length && after.length < 2; i++) if (p.lines[i]?.trim()) after.push(p.lines[i]);
  return {
    kind: "song-line",
    label: `🎵 ${clip(p.title, 18)} — ${p.index + 1}行目`,
    data: compact({ title: p.title, artist: p.artist, line, before, after, translation: p.translation ?? "" }),
  };
}

/** 歌詞の単語（タップした形・原形・意味・品詞・その行） */
export function songWordContext(p: {
  title: string;
  artist: string;
  surface: string;
  lemma?: string;
  meaning?: string;
  pos?: string;
  line?: string;
}): TeacherContext {
  return {
    kind: "song-word",
    label: `🔤 ${clip(p.surface, 16)} — ${clip(p.title, 14)}`,
    data: compact({
      title: p.title,
      artist: p.artist,
      surface: p.surface,
      lemma: p.lemma && p.lemma !== p.surface ? p.lemma : "",
      meaning: p.meaning,
      pos: p.pos,
      line: p.line,
    }),
  };
}

/** パターンプラクティスの文型（型・和文の型・今の文・入れ替え語の例） */
export function patternContext(p: {
  category: string;
  frame: string;
  ja: string;
  sentence?: { pt: string; ja: string } | null;
  options?: readonly string[];
  note?: string;
}): TeacherContext {
  return {
    kind: "pattern",
    label: `🧩 ${clip(frameLabel(p.frame), 24)}`,
    data: compact({
      category: p.category,
      frame: p.frame,
      frameJa: p.ja,
      sentence: p.sentence?.pt,
      sentenceJa: p.sentence?.ja,
      options: (p.options ?? []).slice(0, 8),
      note: p.note,
    }),
  };
}

/** 単語（単語帳・1枚ずつ学習・クイズ）。chosen = クイズで間違えて選んだ語 */
export function wordContext(p: {
  pt: string;
  ja: string;
  pos?: string;
  category?: string;
  example?: { pt: string; ja: string } | null;
  note?: string;
  chosen?: { pt: string; ja: string } | null;
}): TeacherContext {
  return {
    kind: "word",
    label: `📖 ${clip(p.pt, 24)}`,
    data: compact({
      pt: p.pt,
      ja: p.ja,
      pos: p.pos,
      category: p.category,
      example: p.example?.pt,
      exampleJa: p.example?.ja,
      note: p.note,
      chosen: p.chosen ? `${p.chosen.pt}（${p.chosen.ja}）` : "",
    }),
  };
}

/** 文（シャドーイング・書き取り・チャンクリーディング）。source = 教材の名前、label を省くと文の頭 */
export function sentenceContext(p: { pt: string; ja?: string; source?: string; label?: string }): TeacherContext {
  return {
    kind: "sentence",
    label: p.label ?? `💬 ${clip(p.pt, 24)}`,
    data: compact({ pt: p.pt, ja: p.ja, source: p.source }),
  };
}

/** 画面（浮かぶボタンから開いたとき）。screen = 画面の名前 */
export function generalContext(screen: string): TeacherContext {
  return { kind: "general", label: `📍 ${clip(screen, 24)}`, data: compact({ screen }) };
}

/** 画面の名前（パスから。曲の画面は曲名があれば「音楽「曲名」」） */
export function screenNameFor(pathname: string, songTitle?: string | null): string {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return "ホーム";
  if (p.startsWith("/flashcards")) return "単語帳";
  if (p.startsWith("/quiz")) return "クイズ";
  if (p.startsWith("/practice/pattern")) return "パターンプラクティス";
  if (p.startsWith("/practice/conjugation")) return "活用ドリル";
  if (p.startsWith("/practice/chunk")) return "チャンクリーディング";
  if (p.startsWith("/practice/shadowing")) return "シャドーイング";
  if (p.startsWith("/practice/dictation")) return "ディクテーション";
  if (p.startsWith("/practice/add")) return "教材を追加";
  if (p.startsWith("/practice")) return "練習";
  if (p.startsWith("/music/")) return songTitle ? `音楽「${songTitle}」` : "音楽（曲の画面）";
  if (p.startsWith("/music")) return "音楽";
  if (p.startsWith("/settings")) return "設定";
  return "ホーム";
}

/** 保存データの文脈を読む（形の崩れたものは null。長すぎる値は縮める） */
export function readTeacherContext(v: unknown): TeacherContext | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!TEACHER_CONTEXT_KINDS.includes(o.kind as TeacherContextKind) || typeof o.label !== "string") return null;
  const data: Record<string, string | string[]> = {};
  if (typeof o.data === "object" && o.data !== null && !Array.isArray(o.data)) {
    for (const [k, x] of Object.entries(o.data as Record<string, unknown>)) {
      if (typeof x === "string") data[k] = x.slice(0, 600);
      else if (Array.isArray(x)) {
        const list = x.filter((s): s is string => typeof s === "string").slice(0, 10).map((s) => s.slice(0, 600));
        if (list.length) data[k] = list;
      }
    }
  }
  return { kind: o.kind as TeacherContextKind, label: o.label.slice(0, 80), data };
}

// ---------------------------------------------------------------------------
// シートの状態（保存しない）
// ---------------------------------------------------------------------------

/** 返事の受信の状態（streaming = 受信中。error = 失敗。partial は途中まで届いた返事で、保存していない） */
export type TeacherRun =
  | { convId: string; status: "streaming"; text: string; model: string }
  | { convId: string; status: "error"; kind: AiErrorKind; message: string; partial: string };

export interface TeacherUiState {
  open: boolean;
  /** chat = 会話 / history = 履歴の一覧 */
  view: "chat" | "history";
  /** 新しい会話（activeId が null）に付ける文脈。会話を開いているときは、その会話の文脈を使う */
  context: TeacherContext | null;
  /** 開いている会話の ID（null = まだ送っていない新しい会話） */
  activeId: string | null;
  /** 入力欄の下書き */
  draft: string;
  run: TeacherRun | null;
  /** 受信を止める（停止ボタン・API キーの削除） */
  ctrl: AbortController | null;
}

export const useTeacherUi = create<TeacherUiState>(() => ({
  open: false,
  view: "chat",
  context: null,
  activeId: null,
  draft: "",
  run: null,
  ctrl: null,
}));

/**
 * 先生のシートを開く。ctx を渡すと、その文脈で新しい会話を始める（まだ送らない）。
 * ctx が無ければ、開いていた会話（無ければ新しい会話）をそのまま出す。question は入力欄に入れるだけ（送らない）
 */
export function openTeacher(ctx?: TeacherContext, question?: string): void {
  if (ctx) {
    useTeacherUi.setState({ open: true, view: "chat", context: ctx, activeId: null, draft: question ?? "" });
  } else {
    useTeacherUi.setState({ open: true, view: "chat", ...(question !== undefined ? { draft: question } : {}) });
  }
}

/** 先生のシートを閉じる（受信中の返事は止めない） */
export function closeTeacher(): void {
  useTeacherUi.setState({ open: false, view: "chat" });
}

/** 受信中の返事を止める（無ければ何もしない） */
export function abortTeacherRun(): void {
  useTeacherUi.getState().ctrl?.abort();
}
