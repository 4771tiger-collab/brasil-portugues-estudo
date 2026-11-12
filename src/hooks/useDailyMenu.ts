// ============================================================================
// 今日のメニュー（ホームの「今日のトレーニング」と、各練習の完了画面の「次へ」で同じ計算を使う）
// 話せるようになるための順番: ①口慣らし（覚えた文を声に出して思い出す）→ ②場面の復習（終えた場面を、
// 相手のセリフを聞いてヒントなしで演じる。間隔が来た日だけ）→ ③レッスン（新しい場面）→ ④会話（AI と自由に話す）→
// ⑤単語（語彙の復習）。
// 復習が溜まっている日（期限の来た文が REVIEW_DAY_BACKLOG を超える）は「復習の日」にして、新しいレッスンを勧めない。
// 全部のレッスンを終えたあとは、レッスンの代わりに「言いたいことを1文足す」を勧める。
// ============================================================================

import { useMemo } from "react";
import { LESSONS, type Lesson } from "../data/course";
import { REVIEW_DAY_BACKLOG, buildCatalog, dueCount, dueItems, isReviewDay, speakStats, type Catalog, type SpeakStats } from "../speak/catalog";
import { LESSON_STEPS, replayDue } from "../speak/speakData";
import { todayCounters, useProgress } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { speakDailyToday, useSpeak } from "../store/useSpeak";
import { useAiProvider } from "./useAiProvider";
import { useToday } from "./useToday";
import { useTodayPlan } from "./useTodayPlan";

export type MenuKey = "speak" | "scene" | "lesson" | "talk" | "words";

export interface MenuItem {
  key: MenuKey;
  title: string;
  detail: string;
  to: string;
  /** todo = 今日やる / done = 今日は済み / none = まだ無い（準備中・対象なし） */
  state: "todo" | "done" | "none";
  /** 目安の時間（分） */
  minutes: number;
}

export interface DailyMenu {
  items: MenuItem[];
  /** 次にやるもの（全部済んでいれば null） */
  next: MenuItem | null;
  /** 済んだ数 / 今日やる数 */
  done: number;
  total: number;
  /** 今日の口慣らしの文の数（1日の上限まで） */
  speakDue: number;
  stats: SpeakStats;
  /** 次のレッスン（全部終えていれば null） */
  nextLesson: Lesson | null;
  lessonsDone: number;
  catalog: Catalog;
}

/** 自分で足した文を含む、口慣らしの文の一覧 */
export function useCatalog(): Catalog {
  const phrases = useSpeak((s) => s.phrases);
  return useMemo(() => buildCatalog(phrases), [phrases]);
}

export function useDailyMenu(): DailyMenu {
  const today = useToday();
  const cards = useSpeak((s) => s.cards);
  const lessons = useSpeak((s) => s.lessons);
  const talks = useSpeak((s) => s.talks);
  const phrases = useSpeak((s) => s.phrases);
  const speakDaily = useSpeak((s) => s.daily);
  const limit = useSettings((s) => s.speakDailyLimit);
  const dayLog = useProgress((s) => s.history?.[today]);
  const studied = todayCounters(useProgress((s) => s.daily)).studied;
  const plan = useTodayPlan();
  const { provider } = useAiProvider();
  const catalog = useCatalog();
  const hasAi = !!provider;

  return useMemo(() => {
    const stats = speakStats(cards, catalog);
    const remaining = Math.max(0, limit - speakDailyToday(speakDaily, today).dueReviewed);
    const speakDue = dueItems(cards, catalog, today, remaining).length;
    const spoken = dayLog?.act.speak?.n ?? 0;

    const next = LESSONS.find((l) => !lessons[l.id]?.doneAt) ?? null;
    const lessonsDone = LESSONS.filter((l) => lessons[l.id]?.doneAt).length;
    const doneToday = LESSONS.filter((l) => lessons[l.id]?.doneAt === today);
    const step = next ? lessons[next.id]?.step ?? 0 : 0;

    const talkedToday = talks.some((t) => t.at === today);
    const wordsLeft = plan.items.length;

    // 復習の日: 期限の来た文が多い日は、新しいレッスンを勧めない（進むことはできる）
    const backlog = dueCount(cards, catalog, today);
    const reviewDay = !!next && isReviewDay(backlog, doneToday.length > 0);
    // 場面の復習: 終えたレッスンのロールプレイを、間隔が来たらヒントなしで通す
    const sceneId = replayDue(lessons, today, LESSONS.map((l) => l.id));
    const scene = sceneId ? LESSONS.find((l) => l.id === sceneId) ?? null : null;
    const replayedToday = LESSONS.find((l) => lessons[l.id]?.replays?.includes(today)) ?? null;
    // 全部のレッスンを終えたあと: 今日言いたかった文を1つ足す
    const addedToday = phrases.some((p) => p.createdAt === today);

    const items: MenuItem[] = [
      {
        key: "speak",
        title: "口慣らし",
        detail:
          speakDue > 0
            ? `覚えた文を声に出して思い出す（${speakDue}文）`
            : stats.started > 0
              ? spoken > 0
                ? "今日の分は言えました"
                : "今日復習する文はありません"
              : "レッスンを終えると、ここで毎日復習します",
        to: "/speak/review",
        state: speakDue > 0 ? "todo" : stats.started > 0 ? "done" : "none",
        minutes: Math.max(1, Math.round(speakDue * 0.3)),
      },
      ...(scene || replayedToday
        ? [
            {
              key: "scene" as const,
              title: "場面の復習",
              detail: replayedToday
                ? `今日は L${replayedToday.no} ${replayedToday.title} を演じました`
                : `L${scene!.no} ${scene!.title} を、相手のセリフを聞いてヒントなしで演じる`,
              to: `/course/${(scene ?? replayedToday)!.id}?step=3&replay=1`,
              state: replayedToday ? ("done" as const) : ("todo" as const),
              minutes: 3,
            },
          ]
        : []),
      next
        ? {
            key: "lesson",
            title: "レッスン",
            detail: doneToday.length
              ? `今日は L${doneToday[doneToday.length - 1].no} を終えました（次は L${next.no} ${next.title}）`
              : reviewDay
                ? `今日は復習の日（復習が ${REVIEW_DAY_BACKLOG}文以下になったら次の課。先へ進むなら L${next.no} ${next.title}）`
                : step > 0 && step < LESSON_STEPS
                  ? `L${next.no} ${next.title}（つづきから）`
                  : `L${next.no} ${next.title}`,
            to: `/course/${next.id}`,
            // 復習の日は「今日やること」に数えない（押せば進める）
            state: doneToday.length ? "done" : reviewDay ? "none" : "todo",
            minutes: 10,
          }
        : {
            key: "lesson",
            title: "言いたいこと",
            detail: addedToday ? "今日の1文を足しました" : "全部のレッスンを終えました。今日言いたかった文を1つ足そう",
            to: "/phrases",
            state: addedToday ? "done" : "todo",
            minutes: 3,
          },
      {
        key: "talk",
        title: "会話",
        detail: talkedToday
          ? "今日は AI と話しました"
          : hasAi
            ? "AI を相手に、習った場面で自由に話す"
            : "AI と話す準備をする（無料の設定・数分）",
        to: "/talk",
        state: talkedToday ? "done" : hasAi ? "todo" : "none",
        minutes: 5,
      },
      {
        key: "words",
        title: "単語",
        detail:
          wordsLeft > 0
            ? `復習 ${plan.review.length + plan.prodReview.length}・新しい語 ${plan.fresh.length + plan.added.length + plan.prodFresh.length}`
            : studied > 0
              ? "今日の単語は終わりました"
              : "今日の単語はありません",
        to: wordsLeft > 0 ? "/flashcards/today" : "/flashcards",
        state: wordsLeft > 0 ? "todo" : "done",
        minutes: Math.max(1, Math.round(wordsLeft * 0.15)),
      },
    ];
    const active = items.filter((i) => i.state !== "none");
    return {
      items,
      next: items.find((i) => i.state === "todo") ?? null,
      done: active.filter((i) => i.state === "done").length,
      total: active.length,
      speakDue,
      stats,
      nextLesson: next,
      lessonsDone,
      catalog,
    };
  }, [cards, catalog, limit, speakDaily, today, dayLog, lessons, talks, phrases, plan, studied, hasAi]);
}
