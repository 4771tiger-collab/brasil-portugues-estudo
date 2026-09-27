// ============================================================================
// 🧑‍🏫 AI 先生の会話の履歴（この端末にだけ保存する）
//   検証: scripts/check-ai.ts（上限・並び・保存データの読み直し）・scripts/check-backup.ts（書き出しに入らない）
// - 別のキー "bp-teacher-v1" に保存する（version 0・何もしない migrate。キー名は変えない）。
// - バックアップ（exportAll / composeBackup）・インポート（置き換え・統合）・reconcile・進捗のリセット
//   （resetAllProgress）は、このストアを一切読まない・書かない・消さない。会話には歌詞の行や質問が入りうるため、
//   端末の外に出さない（歌詞キャッシュ bp-lyrics-cache-v1 と同じ扱い）。消すのは設定・先生のシートの
//   「会話の履歴をすべて消す」と、会話ごとの削除だけ。
// - 上限: 会話 30件（更新の古いものから消す）× 1つの会話に 100件（古い発言から消す）。
//   さらに文字数の合計が TEXT_BUDGET を超えたら古い会話から消す（localStorage の容量を使い切らないように）。
// - 並びは更新の新しい順（conversations[0] が最新）。
// - 同じ端末でアプリを2つ開いていても（インストールしたアプリとブラウザのタブなど）、別の窓が書き換えたら
//   読み直す（syncTeacherFromStorage。消した会話を、もう一方の窓が書き戻さないように）。
// ============================================================================

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { readTeacherContext, useTeacherUi, type TeacherContext } from "../services/ai/teacherContext";

export interface TeacherMessage {
  role: "user" | "assistant";
  text: string;
  /** 発言の時刻（ISO） */
  at: string;
  /** 答えたモデル（assistant だけ） */
  model?: string;
  /** 停止ボタンで途中で止めた返事 */
  stopped?: boolean;
}

export interface TeacherConversation {
  id: string;
  /** 最初の質問の頭（履歴の一覧に出す） */
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 文脈のチップ（履歴の一覧に出す） */
  contextLabel?: string;
  /** 文脈の中身（続きを質問するときもプロンプトに入れる）。チップの × で外せる */
  context?: TeacherContext;
  messages: TeacherMessage[];
}

/** 会話の上限（超えたら更新の古い会話から消す） */
export const MAX_CONVERSATIONS = 30;
/** 1つの会話の発言の上限（超えたら古い発言から消す） */
export const MAX_MESSAGES = 100;
/** 1つの発言の文字数の上限（超えた分は保存しない） */
export const MAX_MESSAGE_CHARS = 8000;
/** 保存する文字数の合計の上限（超えたら古い会話から消す。最新の会話は必ず残す） */
export const TEXT_BUDGET = 600_000;
/** 会話の題の長さ */
const TITLE_CHARS = 30;

// ---------------------------------------------------------------------------
// 純関数（検証から直接呼ぶ）
// ---------------------------------------------------------------------------

/** 会話の題（最初の質問の1行目を 30 文字まで） */
export function conversationTitle(text: string): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const t = first.replace(/\s+/g, " ").trim();
  return t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS - 1).trimEnd()}…` : t || "（無題）";
}

/** 発言の上限（新しい方から MAX_MESSAGES 件） */
export function capMessages(messages: readonly TeacherMessage[]): TeacherMessage[] {
  return messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : [...messages];
}

const textSize = (c: TeacherConversation) => c.messages.reduce((n, m) => n + m.text.length, 0) + c.title.length;

/**
 * 会話の上限: 更新の新しい順に並べ（同じ時刻なら元の順）、MAX_CONVERSATIONS 件まで。
 * 文字数の合計が TEXT_BUDGET を超えたら、そこから先（古い会話）を消す（最新の1件は必ず残す）
 */
export function capConversations(list: readonly TeacherConversation[]): TeacherConversation[] {
  const sorted = list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.updatedAt === b.c.updatedAt ? a.i - b.i : a.c.updatedAt < b.c.updatedAt ? 1 : -1))
    .map((x) => x.c)
    .slice(0, MAX_CONVERSATIONS);
  const out: TeacherConversation[] = [];
  let total = 0;
  for (const c of sorted) {
    total += textSize(c);
    if (out.length > 0 && total > TEXT_BUDGET) break;
    out.push(c);
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 保存データの発言（形の崩れたものは null。知らない項目はそのまま残す） */
function readMessage(v: unknown): TeacherMessage | null {
  if (!isObj(v)) return null;
  if ((v.role !== "user" && v.role !== "assistant") || typeof v.text !== "string" || typeof v.at !== "string") return null;
  const { model: _m, stopped: _s, ...rest } = v;
  return {
    ...(rest as object),
    role: v.role,
    text: v.text.slice(0, MAX_MESSAGE_CHARS),
    at: v.at,
    ...(typeof v.model === "string" ? { model: v.model } : {}),
    ...(v.stopped === true ? { stopped: true } : {}),
  } as TeacherMessage;
}

/**
 * 保存データの会話の一覧を読む（形の崩れた会話・発言は落とし、発言の無い会話は消す。上限もかける）。
 * 将来版が足した知らない項目はそのまま残す
 */
export function readConversations(v: unknown): TeacherConversation[] {
  if (!Array.isArray(v)) return [];
  const out: TeacherConversation[] = [];
  const seen = new Set<string>();
  for (const c of v) {
    if (!isObj(c) || typeof c.id !== "string" || !c.id || seen.has(c.id)) continue;
    if (typeof c.createdAt !== "string" || typeof c.updatedAt !== "string" || !Array.isArray(c.messages)) continue;
    const messages = capMessages(c.messages.map(readMessage).filter((m): m is TeacherMessage => m !== null));
    if (!messages.length) continue;
    seen.add(c.id);
    const context = readTeacherContext(c.context);
    const { context: _c, contextLabel: _l, ...rest } = c;
    out.push({
      ...(rest as object),
      id: c.id,
      title: typeof c.title === "string" && c.title.trim() ? c.title.slice(0, 80) : conversationTitle(messages.find((m) => m.role === "user")?.text ?? ""),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      ...(typeof c.contextLabel === "string" && c.contextLabel ? { contextLabel: c.contextLabel.slice(0, 80) } : {}),
      ...(context ? { context } : {}),
      messages,
    } as TeacherConversation);
  }
  return capConversations(out);
}

/** 会話の ID（crypto.randomUUID が無い環境では時刻と乱数） */
export function newConversationId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 発言を1つ足した一覧（その会話を先頭へ。題が無ければ最初の質問から付ける）。会話が無ければそのまま */
export function appendMessage(list: readonly TeacherConversation[], id: string, msg: TeacherMessage): TeacherConversation[] {
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) return [...list];
  const c = list[i];
  const m: TeacherMessage = { ...msg, text: msg.text.slice(0, MAX_MESSAGE_CHARS) };
  const next: TeacherConversation = {
    ...c,
    title: c.title || (m.role === "user" ? conversationTitle(m.text) : c.title),
    updatedAt: m.at > c.updatedAt ? m.at : c.updatedAt,
    messages: capMessages([...c.messages, m]),
  };
  return capConversations([next, ...list.slice(0, i), ...list.slice(i + 1)]);
}

// ---------------------------------------------------------------------------
// ストア
// ---------------------------------------------------------------------------

interface TeacherState {
  conversations: TeacherConversation[];
  /** 新しい会話を作って ID を返す（発言は append で足す） */
  newConversation: (p?: { context?: TeacherContext | null; at?: string }) => string;
  /** 発言を足す（その会話を一覧の先頭へ） */
  append: (id: string, msg: TeacherMessage) => void;
  /** 最後の発言を直す */
  updateLast: (id: string, patch: Partial<Pick<TeacherMessage, "text" | "model" | "stopped">>) => void;
  /** 会話の文脈を替える・外す（null） */
  setContext: (id: string, ctx: TeacherContext | null) => void;
  /** 会話を1つ消す */
  remove: (id: string) => void;
  /** 会話の履歴をすべて消す */
  clearAll: () => void;
}

type Persisted = Pick<TeacherState, "conversations">;

/** localStorage（容量超過・使えない環境では保存を諦める。例外で画面を止めない） */
const safeStorage = createJSONStorage<Persisted>(() => ({
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // 容量超過・プライベートモードなど: この回の保存を諦める（次の保存でまた試す）
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* noop */
    }
  },
}));

export const useTeacher = create<TeacherState>()(
  persist(
    (set, get) => ({
      conversations: [],
      newConversation: (p = {}) => {
        const id = newConversationId();
        const at = p.at ?? new Date().toISOString();
        const ctx = p.context ?? null;
        const conv: TeacherConversation = {
          id,
          title: "",
          createdAt: at,
          updatedAt: at,
          ...(ctx ? { contextLabel: ctx.label, context: ctx } : {}),
          messages: [],
        };
        // 発言の無い会話は保存データの読み直しで消える（append で発言が入る前提）。上限はここではかけない
        set({ conversations: [conv, ...get().conversations] });
        return id;
      },
      append: (id, msg) => set({ conversations: appendMessage(get().conversations, id, msg) }),
      updateLast: (id, patch) =>
        set({
          conversations: get().conversations.map((c) => {
            if (c.id !== id || !c.messages.length) return c;
            const last = c.messages[c.messages.length - 1];
            const next = { ...last, ...patch, ...(patch.text !== undefined ? { text: patch.text.slice(0, MAX_MESSAGE_CHARS) } : {}) };
            return { ...c, messages: [...c.messages.slice(0, -1), next] };
          }),
        }),
      setContext: (id, ctx) =>
        set({
          conversations: get().conversations.map((c) => {
            if (c.id !== id) return c;
            const { context: _c, contextLabel: _l, ...rest } = c;
            return ctx ? { ...rest, context: ctx, contextLabel: ctx.label } : rest;
          }),
        }),
      remove: (id) => set({ conversations: get().conversations.filter((c) => c.id !== id) }),
      clearAll: () => set({ conversations: [] }),
    }),
    {
      // キー名は変えない（変えると保存した会話が読めなくなる）。バックアップの対象外
      name: "bp-teacher-v1",
      storage: safeStorage,
      // 将来版のデータを旧版で開いても消えないよう、何もしない migrate で必ず通す（useSettings と同じ）
      version: 0,
      migrate: (persisted) => persisted as Persisted,
      // 保存するのは会話だけ（関数は保存しない）
      partialize: (s): Persisted => ({ conversations: s.conversations }),
      // 形の崩れた会話・発言は読まない（上限もかける）
      merge: (persisted, current) => ({
        ...current,
        conversations: readConversations(isObj(persisted) ? persisted.conversations : undefined),
      }),
    }
  )
);

/**
 * 別の窓（インストールしたアプリとブラウザのタブなど）が会話の履歴を書き換えたら、保存データを読み直す
 * （key null = localStorage をまるごと消した）。persist は起動時に1回しか読まず、保存のたびに一覧をまるごと書くので、
 * 読み直さないと、別の窓で消した会話をこの窓の次の保存で書き戻してしまう。
 * 読み直した結果、受信中の返事の会話が消えていたら、その返事も止める。検証: scripts/check-ai.ts
 */
export async function syncTeacherFromStorage(key: string | null): Promise<void> {
  if (key !== null && key !== "bp-teacher-v1") return;
  await useTeacher.persist.rehydrate();
  const ui = useTeacherUi.getState();
  if (ui.run && !useTeacher.getState().conversations.some((c) => c.id === ui.run?.convId)) {
    ui.ctrl?.abort();
    useTeacherUi.setState({ run: null, ctrl: null });
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => void syncTeacherFromStorage(e.key));
}
