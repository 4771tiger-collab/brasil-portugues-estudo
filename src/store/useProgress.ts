import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Passage, Rating, SrsCard } from "../data/types";
import { addDays, newCard, quizDecision, review, todayStr } from "../srs/scheduler";
import {
  MUSIC_STUDY_SEC,
  addActivity,
  pruneHistory,
  readHistory,
  updateDay,
  type ActivityKind,
  type DayLog,
  type History,
} from "./history";

export type { ActivityKind, ActivityLog, DayLog, History } from "./history";

export interface DailyCounters {
  date: string;
  newIntroduced: number;
  reviewsDone: number;
  studied: number;
  /** 曲から追加した語を今日はじめて評価した数（一般語彙の新規枠とは別管理） */
  musicIntroduced?: number;
  /**
   * 期限の来た復習を今日はじめて評価した数（1日の復習の上限 dailyReviewLimit の残りを数える）。
   * B2-04 で追加。保存済みの古い daily には無いので、読むときは `?? 0`。
   */
  dueReviewed?: number;
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
  /**
   * 日ごとの学習ログ（キーは YYYY-MM-DD、最大 400 日）。B2-06（persist の version 1）で追加。
   * 評価（reviews/newWords/again）と、練習・音楽の回数と秒数（act）を持つ。
   */
  history: History;
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
  /**
   * 練習・音楽の記録を今日の history に足す（n = 回数、sec = 秒数）。daily.studied は変えない。
   * 学習日（ストリーク）にも数える。ただし音楽はその日の合計が 3 分以上になったときだけ。
   */
  logActivity: (kind: ActivityKind, n?: number, sec?: number) => void;
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
  return { date: today, newIntroduced: 0, reviewsDone: 0, studied: 0, musicIntroduced: 0, dueReviewed: 0 };
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
  > & { history?: History },
  id: string,
  rating: Rating,
  today: string = todayStr()
): Partial<ProgressData> {
  const prev = state.cards[id];
  const wasNew = !prev;
  // addCard で作られ、まだ一度も評価していないカード（曲から追加した語）
  const wasAddedNew = !!prev && prev.last === null;
  // 期限の来た復習を今日はじめて評価した（同じ日の再評価・期限前の評価は復習の上限に数えない）
  const wasDueReview = !!prev && prev.last !== null && prev.last !== today && prev.due <= today;
  const updated = review(prev ?? newCard(today), rating, today);

  const baseDaily = state.daily.date === today ? state.daily : freshDaily(today);
  const daily: DailyCounters = {
    ...baseDaily,
    reviewsDone: baseDaily.reviewsDone + 1,
    studied: baseDaily.studied + 1,
    newIntroduced: baseDaily.newIntroduced + (wasNew ? 1 : 0),
    musicIntroduced: (baseDaily.musicIntroduced ?? 0) + (wasAddedNew ? 1 : 0),
    dueReviewed: (baseDaily.dueReviewed ?? 0) + (wasDueReview ? 1 : 0),
  };

  // 日ごとの学習ログ（その日のキーを新しく作るときに 400 日より古い日を消す）
  const history = updateDay(state.history, today, (d) => ({
    ...d,
    reviews: d.reviews + 1,
    newWords: d.newWords + (wasNew || wasAddedNew ? 1 : 0),
    again: d.again + (rating === "again" ? 1 : 0),
  }));

  const out: Partial<ProgressData> = {
    // 据え置きなら同じオブジェクトが返る → cards も作り直さない
    cards: updated === prev ? state.cards : { ...state.cards, [id]: updated },
    daily,
    totalReviews: state.totalReviews + 1,
    history,
    ...recordStudyDay(state, today),
  };
  if (state.pinnedNew.includes(id)) out.pinnedNew = state.pinnedNew.filter((x) => x !== id);
  return out;
}

/** SRS に書かない練習量（daily.studied と学習日）。logPractice / rateQuiz の本体（純関数） */
function practicePatch(
  state: Pick<ProgressData, "daily" | "streak" | "bestStreak" | "lastStudyDate">,
  n: number,
  today: string
): Partial<ProgressData> {
  const baseDaily = state.daily.date === today ? state.daily : freshDaily(today);
  return { daily: { ...baseDaily, studied: baseDaily.studied + n }, ...recordStudyDay(state, today) };
}

/** 0 以上の有限の数（それ以外は 0） */
const nonNeg = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);

/**
 * 練習・音楽の記録1回分の状態変化（純関数）。logActivity の本体。
 * history[today].act[kind] に n と sec を足し、学習日を記録する（音楽はその日の合計が
 * MUSIC_STUDY_SEC 秒以上になったときだけ）。daily.studied は変えない。
 * n も sec も 0 なら何もしない（null）。
 */
export function applyActivity(
  state: Pick<ProgressData, "streak" | "bestStreak" | "lastStudyDate"> & { history?: History },
  kind: ActivityKind,
  n: number,
  sec: number,
  today: string = todayStr()
): Partial<ProgressData> | null {
  const dn = nonNeg(n);
  const ds = nonNeg(sec);
  if (!dn && !ds) return null;
  const history = updateDay(state.history, today, (d) => addActivity(d, kind, dn, ds));
  const studied = kind !== "music" || (history[today].act.music?.sec ?? 0) >= MUSIC_STUDY_SEC;
  return { history, ...(studied ? recordStudyDay(state, today) : {}) };
}

/**
 * persist の移行（純関数）。
 * - v0（B1 まで。version を指定していなかった頃の保存データも zustand が version:0 で書いている）
 *   → v1: history と pinnedNew が無ければ空で補う
 * - v1 より新しい版（将来のアプリで保存したデータ）は捨てずにそのまま通す
 */
export function migrateProgress(persisted: unknown, version: number): Partial<ProgressData> {
  const s = { ...((persisted ?? {}) as Partial<ProgressData>) };
  if (version < 1) {
    s.history ??= {};
    s.pinnedNew ??= [];
  }
  return s;
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
  /** 評価した日の history の記録（評価前のもの。undefined ならその日のキーは無かった） */
  historyDay: [string, DayLog | undefined];
}
let snap: UndoSnapshot | null = null;

function takeSnapshot(s: ProgressData, id: string, today: string): UndoSnapshot {
  return {
    id,
    prevCard: s.cards[id],
    daily: s.daily,
    streak: s.streak,
    bestStreak: s.bestStreak,
    lastStudyDate: s.lastStudyDate,
    totalReviews: s.totalReviews,
    pinnedNew: s.pinnedNew,
    historyDay: [today, s.history?.[today]],
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
      history: {},

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
        const today = todayStr();
        snap = takeSnapshot(state, id, today);
        set(applyRating(state, id, rating, today));
      },

      rateQuiz: (id, rating) => {
        const state = get();
        const today = todayStr();
        const decision = quizDecision(state.cards[id], rating, today);
        // クイズの評価は取り消し対象外（直前の単語帳の取り消しも無効）
        snap = null;
        // "rate": SRS に反映。それ以外（未学習・今日評価済み・期限前の正解）: SRS には書かず練習量だけ記録
        const patch = decision === "rate" ? applyRating(state, id, rating, today) : practicePatch(state, 1, today);
        // どちらでも今日の history にクイズ1問を記録する（B2-06）
        const act = applyActivity({ ...state, ...patch }, "quiz", 1, 0, today);
        set({ ...patch, ...act });
        if (decision === "rate") return rating === "again" ? "lapsed" : "reviewed";
        return decision === "log" ? "untracked" : "unchanged";
      },

      logPractice: (n = 1) => {
        if (!(n > 0)) return;
        snap = null;
        set(practicePatch(get(), n, todayStr()));
      },

      logActivity: (kind, n = 1, sec = 0) => {
        const patch = applyActivity(get(), kind, n, sec, todayStr());
        if (!patch) return;
        // 取り消しは今日の history の記録ごと戻すので、間に入った練習の記録を消さないよう破棄する
        snap = null;
        set(patch);
      },

      undo: () => {
        const u = snap;
        if (!u) return null;
        snap = null;
        const cards = { ...get().cards };
        if (u.prevCard) cards[u.id] = u.prevCard;
        else delete cards[u.id]; // 初見で作ったカードは消す
        const history = { ...get().history };
        const [day, dayLog] = u.historyDay;
        if (dayLog) history[day] = dayLog;
        else delete history[day]; // その日の最初の記録だった
        set({
          cards,
          daily: u.daily,
          streak: u.streak,
          bestStreak: u.bestStreak,
          lastStudyDate: u.lastStudyDate,
          totalReviews: u.totalReviews,
          pinnedNew: u.pinnedNew,
          history,
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
          history: {},
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
            history: s.history,
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
            // B2-06 で追加（旧バックアップには無い → {}）。形を確かめ、400 日より古い日は落とす
            history: pruneHistory(readHistory(data.history), todayStr()),
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
      // 空の進捗を上書き保存してしまう。必ず migrate を通す（足りない項目は既定値との浅いマージでも補われる）。
      // v1（B2-06）: history を追加。v0 のデータには空の history を補う。将来版（v2 以降）のデータは
      // 捨てずにそのまま通す（旧版のアプリで開いても進捗が消えない）。
      version: 1,
      migrate: (persisted, version) => migrateProgress(persisted, version) as ProgressState,
    }
  )
);
