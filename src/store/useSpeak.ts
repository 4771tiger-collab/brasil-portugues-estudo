// ============================================================================
// 「話す」練習の記録（文のカード・自分で足した文・レッスンの進み具合・会話の記録）
// 形と純関数は src/speak/speakData.ts。単語の進捗（useProgress）とは別のキーに保存する。
// 学習日（連続記録）と練習時間は useProgress.logActivity（speak / lesson / talk）に記録する（画面側で呼ぶ）。
//   検証: scripts/check-speak.ts（npm run check:speak）
// ============================================================================

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Rating, SrsCard } from "../data/types";
import { newCard, review, todayStr } from "../srs/scheduler";
import {
  LESSON_STEPS,
  TALK_LOG_MAX,
  USER_PHRASE_MAX,
  emptySpeak,
  mergeSpeak,
  newPhraseId,
  readSpeak,
  samePhraseText,
  readUserPhrase,
  type LessonProgress,
  type PhraseSource,
  type SpeakExport,
  type TalkLog,
  type UserPhrase,
} from "../speak/speakData";

export interface SpeakDaily {
  date: string;
  /** 期限の来た文を今日はじめて評価した数（1日の上限の残りを数える） */
  dueReviewed: number;
}

export interface SpeakData extends SpeakExport {
  daily: SpeakDaily;
}

interface SpeakState extends SpeakData {
  /** 文を評価する（id はフレーズの ID）。カードが無ければ作る */
  rate: (id: string, rating: Rating) => void;
  /** カードを元に戻す（取り消し用。undefined なら消す） */
  restoreCard: (id: string, prev: SrsCard | undefined, daily: SpeakDaily) => void;
  /** まだカードの無い文に、今日が期限のカードを作る（レッスンを終えたとき） */
  ensureCards: (ids: readonly string[]) => void;
  /** 自分の文を足す。足した文の ID を返す（上限・空のときは null。同じポルトガル語の文があれば、その文の ID） */
  addPhrase: (p: { ja: string; pt: string; note?: string; alt?: string[]; from: PhraseSource }) => string | null;
  updatePhrase: (id: string, patch: { ja?: string; pt?: string; note?: string }) => void;
  removePhrase: (id: string) => void;
  /** レッスンのステップを進める（戻さない） */
  setLessonStep: (id: string, step: number) => void;
  completeLesson: (id: string) => void;
  logTalk: (t: Omit<TalkLog, "at">) => void;
  exportData: () => SpeakExport;
  /** バックアップの置き換え */
  importData: (d: SpeakExport) => void;
  /** バックアップの統合（speakData.mergeSpeak） */
  mergeData: (d: SpeakExport) => void;
  /** 進捗のリセット（文のカード・レッスンの進み具合・会話の記録を消す。自分で足した文は教材なので残す） */
  reset: () => void;
}

const freshDaily = (today: string = todayStr()): SpeakDaily => ({ date: today, dueReviewed: 0 });

/** 今日のカウンタ（保存値が前日のものなら 0 扱い） */
export function speakDailyToday(daily: SpeakDaily, today: string = todayStr()): SpeakDaily {
  return daily.date === today ? daily : freshDaily(today);
}

/** 評価1回分の状態変化（純関数）。期限の来た文を今日はじめて評価したときだけ dueReviewed を数える */
export function applySpeakRating(
  state: Pick<SpeakData, "cards" | "daily">,
  id: string,
  rating: Rating,
  today: string = todayStr()
): Pick<SpeakData, "cards" | "daily"> {
  const prev = state.cards[id];
  const wasDue = !!prev && prev.last !== null && prev.last !== today && prev.due <= today;
  const updated = review(prev ?? newCard(today), rating, today);
  const base = speakDailyToday(state.daily, today);
  return {
    cards: updated === prev ? state.cards : { ...state.cards, [id]: updated },
    daily: wasDue ? { ...base, dueReviewed: base.dueReviewed + 1 } : base,
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const useSpeak = create<SpeakState>()(
  persist(
    (set, get) => ({
      ...emptySpeak(),
      daily: freshDaily(),

      rate: (id, rating) => set((s) => applySpeakRating(s, id, rating)),

      restoreCard: (id, prev, daily) =>
        set((s) => {
          const cards = { ...s.cards };
          if (prev) cards[id] = prev;
          else delete cards[id];
          return { cards, daily };
        }),

      ensureCards: (ids) =>
        set((s) => {
          const missing = ids.filter((id) => id && !s.cards[id]);
          if (!missing.length) return s;
          const cards = { ...s.cards };
          for (const id of missing) cards[id] = newCard();
          return { cards };
        }),

      addPhrase: (p) => {
        const s = get();
        const phrase = readUserPhrase({ ...p, id: newPhraseId(), createdAt: todayStr() });
        if (!phrase) return null;
        // 同じポルトガル語の文がもうあれば、足さずにその文の ID を返す（会話の途中とふりかえりで2回足さない）
        const same = s.phrases.find((x) => samePhraseText(x.pt, phrase.pt));
        if (same) return same.id;
        if (s.phrases.length >= USER_PHRASE_MAX) return null;
        // 足した文は今日から口慣らしに出す
        set({ phrases: [phrase, ...s.phrases], cards: { ...s.cards, [phrase.id]: newCard() } });
        return phrase.id;
      },

      updatePhrase: (id, patch) =>
        set((s) => ({
          phrases: s.phrases.map((p) => (p.id === id ? readUserPhrase({ ...p, ...patch }) ?? p : p)),
        })),

      removePhrase: (id) =>
        set((s) => {
          const cards = { ...s.cards };
          delete cards[id];
          return { phrases: s.phrases.filter((p) => p.id !== id), cards };
        }),

      setLessonStep: (id, step) =>
        set((s) => {
          const cur = s.lessons[id];
          const next = Math.max(0, Math.min(LESSON_STEPS, Math.floor(step)));
          if (cur && (cur.doneAt || cur.step >= next)) return s;
          return { lessons: { ...s.lessons, [id]: { step: next, doneAt: cur?.doneAt ?? null } } };
        }),

      completeLesson: (id) =>
        set((s) => {
          const cur = s.lessons[id];
          if (cur?.doneAt) return s;
          return { lessons: { ...s.lessons, [id]: { step: LESSON_STEPS, doneAt: todayStr() } } };
        }),

      logTalk: (t) => set((s) => ({ talks: [{ ...t, at: todayStr() }, ...s.talks].slice(0, TALK_LOG_MAX) })),

      exportData: () => {
        const s = get();
        return { cards: s.cards, phrases: s.phrases, lessons: s.lessons, talks: s.talks };
      },
      importData: (d) => set({ cards: { ...d.cards }, phrases: [...d.phrases], lessons: { ...d.lessons }, talks: [...d.talks] }),
      mergeData: (d) => set((s) => mergeSpeak({ cards: s.cards, phrases: s.phrases, lessons: s.lessons, talks: s.talks }, d)),
      reset: () =>
        set((s) => {
          // 自分で足した文は残し、そのカードは今日が期限の新しいカードに戻す
          const cards: Record<string, SrsCard> = {};
          for (const p of s.phrases) cards[p.id] = newCard();
          return { cards, lessons: {}, talks: [], daily: freshDaily() };
        }),
    }),
    {
      // キー名は変えない（既存の記録が読めなくなる）
      name: "bp-speak-v1",
      // 保存済みの version と違い migrate も無いと、zustand は初期状態で起動して上書き保存してしまう。
      // 将来版のデータを旧版で開いても消えないよう、何もしない migrate で必ず通す。
      version: 0,
      migrate: (persisted) => persisted as SpeakState,
      // 壊れた項目は落として組み直す（知らない項目はそのまま残す）
      merge: (persisted, current) => {
        const p = isObj(persisted) ? persisted : {};
        const data = readSpeak(p) ?? emptySpeak();
        const d = isObj(p.daily) && typeof p.daily.date === "string" ? (p.daily as unknown as SpeakDaily) : freshDaily();
        return {
          ...current,
          ...p,
          ...data,
          daily: { date: d.date, dueReviewed: Number.isFinite(d.dueReviewed) && d.dueReviewed > 0 ? d.dueReviewed : 0 },
        };
      },
    }
  )
);

export type { LessonProgress, TalkLog, UserPhrase };
