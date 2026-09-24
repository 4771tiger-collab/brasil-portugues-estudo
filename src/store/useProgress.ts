import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Passage, Rating, SrsCard } from "../data/types";
import { addDays, newCard, review, todayStr } from "../srs/scheduler";

interface DailyCounters {
  date: string;
  newIntroduced: number;
  reviewsDone: number;
  studied: number;
  /** 曲から追加した語を今日はじめて評価した数（一般語彙の新規枠とは別管理） */
  musicIntroduced?: number;
}

interface ProgressState {
  cards: Record<string, SrsCard>;
  daily: DailyCounters;
  streak: number;
  bestStreak: number;
  lastStudyDate: string | null;
  totalReviews: number;
  customPassages: Passage[];

  // --- selectors ---
  getCard: (id: string) => SrsCard | undefined;

  // --- actions ---
  ensureToday: () => void;
  rate: (id: string, rating: Rating) => void;
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

function freshDaily(): DailyCounters {
  return { date: todayStr(), newIntroduced: 0, reviewsDone: 0, studied: 0, musicIntroduced: 0 };
}

function recordStudyDay(state: ProgressState): Partial<ProgressState> {
  const today = todayStr();
  if (state.lastStudyDate === today) return {};
  const yesterday = addDays(today, -1);
  let streak = 1;
  if (state.lastStudyDate === yesterday) streak = state.streak + 1;
  const bestStreak = Math.max(state.bestStreak, streak);
  return { streak, bestStreak, lastStudyDate: today };
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
        set({ cards });
      },

      rate: (id, rating) => {
        const state = get();
        const today = todayStr();
        const existing = state.cards[id] ?? newCard();
        const wasNew = !state.cards[id];
        // addCard で作られ、まだ一度も評価していないカード（曲から追加した語）
        const wasAddedNew = !!state.cards[id] && state.cards[id].last === null;
        const updated = review(existing, rating, today);

        const baseDaily = state.daily.date === today ? state.daily : freshDaily();
        const daily: DailyCounters = {
          ...baseDaily,
          reviewsDone: baseDaily.reviewsDone + 1,
          studied: baseDaily.studied + 1,
          newIntroduced: baseDaily.newIntroduced + (wasNew ? 1 : 0),
          musicIntroduced: (baseDaily.musicIntroduced ?? 0) + (wasAddedNew ? 1 : 0),
        };

        set({
          cards: { ...state.cards, [id]: updated },
          daily,
          totalReviews: state.totalReviews + 1,
          ...recordStudyDay(state),
        });
      },

      addCustomPassage: (p) => set({ customPassages: [p, ...get().customPassages] }),
      removeCustomPassage: (id) => set({ customPassages: get().customPassages.filter((x) => x.id !== id) }),

      resetAll: () =>
        set({
          cards: {},
          daily: freshDaily(),
          streak: 0,
          bestStreak: 0,
          lastStudyDate: null,
          totalReviews: 0,
          customPassages: [],
        }),

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
          },
          null,
          2
        );
      },

      importJSON: (json) => {
        try {
          const data = JSON.parse(json);
          if (!data || typeof data !== "object" || !data.cards) return false;
          set({
            cards: data.cards ?? {},
            streak: data.streak ?? 0,
            bestStreak: data.bestStreak ?? 0,
            lastStudyDate: data.lastStudyDate ?? null,
            totalReviews: data.totalReviews ?? 0,
            customPassages: data.customPassages ?? [],
          });
          return true;
        } catch {
          return false;
        }
      },
    }),
    { name: "bp-progress-v1" }
  )
);
