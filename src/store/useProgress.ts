import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Passage, Rating, SrsCard } from "../data/types";
import { addDays, newCard, quizDecision, review, todayStr } from "../srs/scheduler";

interface DailyCounters {
  date: string;
  newIntroduced: number;
  reviewsDone: number;
  studied: number;
  /** 曲から追加した語を今日はじめて評価した数（一般語彙の新規枠とは別管理） */
  musicIntroduced?: number;
}

/** クイズ1問の SRS への反映結果（結果画面の「SRSに反映」表示用） */
export type QuizEffect =
  | "reviewed" // 期限到来の語に good/hard などを反映
  | "lapsed" // again を反映
  | "unchanged" // 今日評価済み・期限前の正解 → 変更なし
  | "untracked"; // 未学習（カード無し・未評価）→ SRS には書かない

/** 永続化される学習データ（アクションを除いた部分） */
export interface ProgressData {
  cards: Record<string, SrsCard>;
  daily: DailyCounters;
  streak: number;
  bestStreak: number;
  lastStudyDate: string | null;
  totalReviews: number;
  customPassages: Passage[];
  /** 「今日の学習に追加」で指定された未学習語。buildSession の新規枠で先に出す。評価したら外す */
  pinnedNew: string[];
}

interface ProgressState extends ProgressData {
  // --- selectors ---
  getCard: (id: string) => SrsCard | undefined;

  // --- actions ---
  ensureToday: () => void;
  /** 単語帳の評価（取り消し用のスナップショットを1段分残す） */
  rate: (id: string, rating: Rating) => void;
  /** クイズの解答を quizDecision の規則で反映する（取り消し対象外） */
  rateQuiz: (id: string, rating: Rating) => QuizEffect;
  /** SRS に書かない練習量を記録（daily.studied とストリーク） */
  logPractice: (n?: number) => void;
  /** 直前の rate を取り消す。取り消した語の id を返す（無ければ null） */
  undo: () => string | null;
  /** 取り消せる評価があるか（id を渡すとその語の評価に限る） */
  canUndo: (id?: string) => boolean;
  /** 未学習語を今日の新規枠の先頭に入れる */
  pinNew: (ids: string[]) => void;
  introduce: (id: string) => void;
  /** カードだけ作る（曲から追加した語用）。既にカードがあれば何もしない。新規枠は消費しない */
  addCard: (id: string) => void;
  removeCard: (id: string) => void;
  addCustomPassage: (p: Passage) => void;
  removeCustomPassage: (id: string) => void;
  resetAll: () => void;
  exportJSON: () => string;
  importJSON: (json: string) => boolean;
}

/** 今日のカウンタ（保存値が前日のものなら 0 扱い。ensureToday 前の描画でも正しく数える） */
export function todayCounters(daily: DailyCounters): DailyCounters {
  return daily.date === todayStr() ? daily : freshDaily();
}

function freshDaily(today: string = todayStr()): DailyCounters {
  return { date: today, newIntroduced: 0, reviewsDone: 0, studied: 0, musicIntroduced: 0 };
}

type StreakFields = Pick<ProgressData, "streak" | "lastStudyDate">;

/** 表示用の連続記録。前回の学習日が今日か昨日なら streak、それ以外（途切れている）は 0 */
export function currentStreak(s: StreakFields, today: string = todayStr()): number {
  return s.lastStudyDate === today || s.lastStudyDate === addDays(today, -1) ? s.streak : 0;
}

/** 今日すでに学習したか（ヘッダーの炎の色などに使う） */
export function studiedToday(s: Pick<ProgressData, "lastStudyDate">, today: string = todayStr()): boolean {
  return s.lastStudyDate === today;
}

function recordStudyDay(
  state: Pick<ProgressData, "streak" | "bestStreak" | "lastStudyDate">,
  today: string = todayStr()
): Partial<ProgressData> {
  if (state.lastStudyDate === today) return {};
  const yesterday = addDays(today, -1);
  let streak = 1;
  if (state.lastStudyDate === yesterday) streak = state.streak + 1;
  const bestStreak = Math.max(state.bestStreak, streak);
  return { streak, bestStreak, lastStudyDate: today };
}

/**
 * 評価1回分の状態変化（純関数）。rate / rateQuiz の本体。
 * 据え置き（scheduler.isHeld）でもカウンタ・ストリークは進める（学習した事実は残す）。
 */
export function applyRating(
  state: Pick<
    ProgressData,
    "cards" | "daily" | "streak" | "bestStreak" | "lastStudyDate" | "totalReviews" | "pinnedNew"
  >,
  id: string,
  rating: Rating,
  today: string = todayStr()
): Partial<ProgressData> {
  const prev = state.cards[id];
  const wasNew = !prev;
  // addCard で作られ、まだ一度も評価していないカード（曲から追加した語）
  const wasAddedNew = !!prev && prev.last === null;
  const updated = review(prev ?? newCard(today), rating, today);

  const baseDaily = state.daily.date === today ? state.daily : freshDaily(today);
  const daily: DailyCounters = {
    ...baseDaily,
    reviewsDone: baseDaily.reviewsDone + 1,
    studied: baseDaily.studied + 1,
    newIntroduced: baseDaily.newIntroduced + (wasNew ? 1 : 0),
    musicIntroduced: (baseDaily.musicIntroduced ?? 0) + (wasAddedNew ? 1 : 0),
  };

  const out: Partial<ProgressData> = {
    // 据え置きなら同じオブジェクトが返る → cards も作り直さない
    cards: updated === prev ? state.cards : { ...state.cards, [id]: updated },
    daily,
    totalReviews: state.totalReviews + 1,
    ...recordStudyDay(state, today),
  };
  if (state.pinnedNew.includes(id)) out.pinnedNew = state.pinnedNew.filter((x) => x !== id);
  return out;
}

// ---------------------------------------------------------------------------
// 取り消し（1段分）。永続化しないモジュール変数に持つ（再読み込みで消えてよい）。
// rate 以外で同じ項目を書き換える操作（クイズ・練習記録・取り込み・リセット等）では破棄する。
// ---------------------------------------------------------------------------
interface UndoSnapshot {
  id: string;
  prevCard: SrsCard | undefined;
  daily: DailyCounters;
  streak: number;
  bestStreak: number;
  lastStudyDate: string | null;
  totalReviews: number;
  pinnedNew: string[];
}
let snap: UndoSnapshot | null = null;

function takeSnapshot(s: ProgressData, id: string): UndoSnapshot {
  return {
    id,
    prevCard: s.cards[id],
    daily: s.daily,
    streak: s.streak,
    bestStreak: s.bestStreak,
    lastStudyDate: s.lastStudyDate,
    totalReviews: s.totalReviews,
    pinnedNew: s.pinnedNew,
  };
}

export const useProgress = create<ProgressState>()(
  persist(
    (set, get) => ({
      cards: {},
      daily: freshDaily(),
      streak: 0,
      bestStreak: 0,
      lastStudyDate: null,
      totalReviews: 0,
      customPassages: [],
      pinnedNew: [],

      getCard: (id) => get().cards[id],

      ensureToday: () => {
        const { daily } = get();
        const today = todayStr();
        if (daily.date !== today) {
          set({ daily: freshDaily() });
        }
      },

      introduce: (id) => {
        const state = get();
        if (state.cards[id]) return; // 既出
        const today = todayStr();
        const daily =
          state.daily.date === today
            ? { ...state.daily, newIntroduced: state.daily.newIntroduced + 1 }
            : { ...freshDaily(), newIntroduced: 1 };
        snap = null;
        set({ cards: { ...state.cards, [id]: newCard() }, daily });
      },

      addCard: (id) => {
        const state = get();
        if (state.cards[id]) return; // 学習履歴を消さない
        set({ cards: { ...state.cards, [id]: newCard() } });
      },

      removeCard: (id) => {
        const state = get();
        if (!state.cards[id]) return;
        const cards = { ...state.cards };
        delete cards[id];
        if (snap?.id === id) snap = null;
        set({ cards });
      },

      rate: (id, rating) => {
        const state = get();
        snap = takeSnapshot(state, id);
        set(applyRating(state, id, rating, todayStr()));
      },

      rateQuiz: (id, rating) => {
        const state = get();
        const today = todayStr();
        const decision = quizDecision(state.cards[id], rating, today);
        if (decision === "rate") {
          snap = null; // クイズの評価は取り消し対象外（直前の単語帳の取り消しも無効）
          set(applyRating(state, id, rating, today));
          return rating === "again" ? "lapsed" : "reviewed";
        }
        // 未学習・今日評価済み・期限前の正解: SRS には書かず練習量だけ記録
        get().logPractice(1);
        return decision === "log" ? "untracked" : "unchanged";
      },

      logPractice: (n = 1) => {
        if (!(n > 0)) return;
        const state = get();
        const today = todayStr();
        const baseDaily = state.daily.date === today ? state.daily : freshDaily(today);
        snap = null;
        set({ daily: { ...baseDaily, studied: baseDaily.studied + n }, ...recordStudyDay(state, today) });
      },

      undo: () => {
        const u = snap;
        if (!u) return null;
        snap = null;
        const cards = { ...get().cards };
        if (u.prevCard) cards[u.id] = u.prevCard;
        else delete cards[u.id]; // 初見で作ったカードは消す
        set({
          cards,
          daily: u.daily,
          streak: u.streak,
          bestStreak: u.bestStreak,
          lastStudyDate: u.lastStudyDate,
          totalReviews: u.totalReviews,
          pinnedNew: u.pinnedNew,
        });
        return u.id;
      },

      canUndo: (id) => !!snap && (id === undefined || snap.id === id),

      pinNew: (ids) => {
        const state = get();
        const next = [...state.pinnedNew];
        for (const id of ids) {
          if (next.includes(id)) continue;
          if (state.cards[id]?.last) continue; // 評価済みの語は新規ではない
          next.push(id);
        }
        if (next.length !== state.pinnedNew.length) set({ pinnedNew: next });
      },

      addCustomPassage: (p) => set({ customPassages: [p, ...get().customPassages] }),
      removeCustomPassage: (id) => set({ customPassages: get().customPassages.filter((x) => x.id !== id) }),

      resetAll: () => {
        snap = null;
        set({
          cards: {},
          daily: freshDaily(),
          streak: 0,
          bestStreak: 0,
          lastStudyDate: null,
          totalReviews: 0,
          customPassages: [],
          pinnedNew: [],
        });
      },

      exportJSON: () => {
        const s = get();
        return JSON.stringify(
          {
            version: 1,
            exportedAt: new Date().toISOString(),
            cards: s.cards,
            streak: s.streak,
            bestStreak: s.bestStreak,
            lastStudyDate: s.lastStudyDate,
            totalReviews: s.totalReviews,
            customPassages: s.customPassages,
            pinnedNew: s.pinnedNew,
          },
          null,
          2
        );
      },

      importJSON: (json) => {
        try {
          const data = JSON.parse(json);
          if (!data || typeof data !== "object" || !data.cards) return false;
          snap = null;
          set({
            cards: data.cards ?? {},
            streak: data.streak ?? 0,
            bestStreak: data.bestStreak ?? 0,
            lastStudyDate: data.lastStudyDate ?? null,
            totalReviews: data.totalReviews ?? 0,
            customPassages: data.customPassages ?? [],
            // 旧バックアップには無い（任意フィールド）
            pinnedNew: Array.isArray(data.pinnedNew)
              ? data.pinnedNew.filter((x: unknown): x is string => typeof x === "string")
              : [],
          });
          return true;
        } catch {
          return false;
        }
      },
    }),
    {
      // キー名は絶対に変えない（既存の進捗が読めなくなる）
      name: "bp-progress-v1",
      // zustand の persist は保存済みの version と違い migrate も無いと、初期状態で起動して
      // 空の進捗を上書き保存してしまう。将来版（v1 以降）のデータを旧版で開いても消えないよう、
      // 何もしない migrate で必ず通す（足りない項目は既定値との浅いマージで補われる）。
      version: 0,
      migrate: (persisted) => persisted as ProgressState,
    }
  )
);
