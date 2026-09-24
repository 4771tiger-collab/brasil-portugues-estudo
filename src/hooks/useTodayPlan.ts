// ============================================================================
// 「今日の学習」の中身（復習・新しい語・曲の語・和→葡の産出カードと、新しい語を止めた理由）
// ホーム・単語帳の一覧の数字と、実際に始めるセッション（Flashcards の StudyView）で同じ計算を使う。
// 本体は純関数 buildSession（src/srs/queue.ts）。ここではストアと設定から引数をそろえるだけ。
// ============================================================================

import { useMemo } from "react";
import type { Settings, Word } from "../data/types";
import { CORE_ORDER, reviewPool } from "../data/loadWords";
import { buildSession, type CardMap, type SessionPlan } from "../srs/queue";
import { todayCounters, useProgress, type DailyCounters } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { useAddedIds, useUserWordMap } from "../store/useMusic";
import { useToday } from "./useToday";

type PlanSettings = Pick<
  Settings,
  "dailyNewLimit" | "musicNewLimit" | "dailyReviewLimit" | "capoeiraShare" | "productionEnabled" | "dailyProductionNewLimit"
>;

export interface TodayInputs {
  /** reviewPool(addedIds, userMap) */
  pool: Word[];
  cards: CardMap;
  /** 今日の daily（todayCounters を通したもの） */
  daily: Pick<DailyCounters, "newIntroduced" | "musicIntroduced" | "dueReviewed" | "prodIntroduced">;
  settings: PlanSettings;
  /** useProgress.pinnedNew */
  pinned: readonly string[];
  today: string;
  /** 新規語の上限を広げるとき（「あと5語」）。省略時は settings.dailyNewLimit */
  newLimit?: number;
}

/** 今日の学習を組み立てる（純関数。StudyView は開いた時点の値で1回だけ呼ぶ） */
export function planToday(i: TodayInputs): SessionPlan {
  return buildSession(i.pool, i.cards, {
    newLimit: i.newLimit ?? i.settings.dailyNewLimit,
    introducedToday: i.daily.newIntroduced,
    addedLimit: i.settings.musicNewLimit,
    addedToday: i.daily.musicIntroduced ?? 0,
    reviewLimit: i.settings.dailyReviewLimit,
    reviewedToday: i.daily.dueReviewed ?? 0,
    coreOrder: CORE_ORDER,
    capoeiraShare: i.settings.capoeiraShare,
    // クイズ結果の「今日の学習に追加」で指定した語を新規枠の先頭に
    pinned: i.pinned,
    today: i.today,
    // 和→葡の産出カード（T2-1。止めているときは産出カードを出さない）
    production: i.settings.productionEnabled,
    prodNewLimit: i.settings.dailyProductionNewLimit,
    prodIntroducedToday: i.daily.prodIntroduced ?? 0,
  });
}

/** 今日の学習の中身（ホーム・単語帳の一覧の数字用。ストアが変わると計算し直す） */
export function useTodayPlan(): SessionPlan {
  const today = useToday();
  const cards = useProgress((s) => s.cards);
  const rawDaily = useProgress((s) => s.daily);
  const pinned = useProgress((s) => s.pinnedNew);
  const dailyNewLimit = useSettings((s) => s.dailyNewLimit);
  const musicNewLimit = useSettings((s) => s.musicNewLimit);
  const dailyReviewLimit = useSettings((s) => s.dailyReviewLimit);
  const capoeiraShare = useSettings((s) => s.capoeiraShare);
  const productionEnabled = useSettings((s) => s.productionEnabled);
  const dailyProductionNewLimit = useSettings((s) => s.dailyProductionNewLimit);
  const addedIds = useAddedIds();
  const userMap = useUserWordMap();
  const pool = useMemo(() => reviewPool(addedIds, userMap), [addedIds, userMap]);
  return useMemo(
    () =>
      planToday({
        pool,
        cards,
        daily: todayCounters(rawDaily),
        settings: { dailyNewLimit, musicNewLimit, dailyReviewLimit, capoeiraShare, productionEnabled, dailyProductionNewLimit },
        pinned,
        today,
      }),
    [
      pool,
      cards,
      rawDaily,
      pinned,
      today,
      dailyNewLimit,
      musicNewLimit,
      dailyReviewLimit,
      capoeiraShare,
      productionEnabled,
      dailyProductionNewLimit,
    ]
  );
}
