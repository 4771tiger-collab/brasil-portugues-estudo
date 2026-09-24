import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ALL_WORDS, STATS } from "../data/loadWords";
import { currentStreak, studiedToday, todayCounters, useProgress } from "../store/useProgress";
import { activitySeconds } from "../store/history";
import { useSettings } from "../store/useSettings";
import { useAddedIds } from "../store/useMusic";
import { masteryBreakdown, prodMastery } from "../srs/queue";
import { useToday } from "../hooks/useToday";
import { useTodayPlan } from "../hooks/useTodayPlan";
import UpdateBanner from "../components/UpdateBanner";
import InstallCard from "../components/InstallCard";
import BackupNudge from "../components/BackupNudge";

function Bar({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

export default function Home() {
  // 日付の読み直しと daily の切替（ensureToday）は useToday が行う。翌日に戻っても数字が更新される
  const today = useToday();
  const cards = useProgress((s) => s.cards);
  const daily = todayCounters(useProgress((s) => s.daily));
  const bestStreak = useProgress((s) => s.bestStreak);
  const streak = useProgress((s) => currentStreak(s, today));
  const doneToday = useProgress((s) => studiedToday(s, today));
  // 今日の練習（音楽以外）と音楽の時間（学習ログ history。単語の目標とは別に数える）
  const dayLog = useProgress((s) => s.history?.[today]);
  const { practice: practiceSec, music: musicSec } = activitySeconds(dayLog);
  const dailyGoal = useSettings((s) => s.dailyGoal);
  const dailyReviewLimit = useSettings((s) => s.dailyReviewLimit);
  const productionEnabled = useSettings((s) => s.productionEnabled);
  const addedIds = useAddedIds();

  // 今日の学習の中身（実際に始めるセッションと同じ計算。復習は曲から追加した語も含め、1日の上限まで）。
  // 習熟度は単語帳のカリキュラム進捗なので ALL_WORDS のまま
  const plan = useTodayPlan();
  const due = plan.review.length;
  const newCount = plan.fresh.length;
  const musicNew = plan.added.length;
  // 和→葡の産出カード（T2-1。期限の来たもの＋新しく始めるもの）
  const prodCount = plan.prodReview.length + plan.prodFresh.length;
  const backlog = plan.reason === "backlog";
  const mastery = useMemo(() => masteryBreakdown(ALL_WORDS, cards), [cards]);
  // ポルトガル語で言える語（産出カードの間隔7日以上）
  const prod = useMemo(() => prodMastery(cards), [cards]);
  const musicLearned = addedIds.filter((id) => cards[id]?.last).length;
  const goalRatio = dailyGoal ? Math.min(1, daily.studied / dailyGoal) : 0;
  // 今日の分があれば単語帳の一覧を経ずに「今日の学習」へ直行する（産出カードだけの日も）
  const hasToday = plan.items.length > 0;

  return (
    <div className="animate-fade-in space-y-5">
      {/* 新しい版が待機中なら「更新」（学習の画面では出さない） */}
      <UpdateBanner />

      {/* アプリとしてのインストール案内（ホーム画面のアプリで開いているときは出ない） */}
      <InstallCard />

      {/* 今日の学習 */}
      <section className="card overflow-hidden">
        <div className="bg-gradient-to-br from-brand-green to-emerald-600 p-5 text-white">
          <div className="text-sm/relaxed opacity-90">今日の学習</div>
          <div className="mt-1 flex flex-wrap items-end gap-x-3 gap-y-2">
            <div>
              <div className="text-4xl font-extrabold leading-none">{due}</div>
              <div className="mt-1 text-xs opacity-90">復習する語</div>
            </div>
            <div className="mb-0.5 text-white/70">＋</div>
            <div>
              <div className="text-4xl font-extrabold leading-none">{newCount}</div>
              <div className="mt-1 text-xs opacity-90">新しい語</div>
            </div>
            {musicNew > 0 && (
              <>
                <div className="mb-0.5 text-white/70">＋</div>
                <div>
                  <div className="text-4xl font-extrabold leading-none">{musicNew}</div>
                  <div className="mt-1 text-xs opacity-90">🎵 曲の単語</div>
                </div>
              </>
            )}
            {prodCount > 0 && (
              <>
                <div className="mb-0.5 text-white/70">＋</div>
                <div>
                  <div className="text-4xl font-extrabold leading-none">{prodCount}</div>
                  <div className="mt-1 text-xs opacity-90">✍ 産出</div>
                </div>
              </>
            )}
          </div>
          {prodCount > 0 && (
            <p className="mt-2 text-xs opacity-90">✍ 産出 = 日本語を見てポルトガル語を言うカード（覚えた語から）</p>
          )}
          {/* 期限の来た復習が1日の上限を超えている日は、延滞の大きい順に上限まで出し、新しい語は止める */}
          {backlog && (
            <p className="mt-3 rounded-lg bg-white/15 px-3 py-2 text-xs/relaxed">
              復習が溜まっています（期限の来た語 {plan.dueTotal}語）。今日は延滞の大きい語から1日の上限（{dailyReviewLimit}枚）まで復習し、新しい語はお休みします。
            </p>
          )}
          <Link
            to={hasToday ? "/flashcards/today" : "/flashcards"}
            className="mt-4 inline-flex w-full items-center justify-center rounded-xl bg-white py-3 font-bold text-brand-green shadow-sm transition active:scale-95"
          >
            {hasToday ? "学習をはじめる" : "追加で学習する"}
          </Link>
        </div>
        <div className="grid grid-cols-2 gap-3 p-4">
          {/* 今日の目標: 単語（評価の回数 / 目標）と、練習・音楽の時間 */}
          <div>
            <div className="mb-1 flex justify-between text-xs text-slate-500">
              <span>単語</span>
              <span>
                {daily.studied}/{dailyGoal}
              </span>
            </div>
            <Bar value={goalRatio} className="bg-brand-yellow" />
            <div className="mt-2 text-xs text-slate-500">
              練習 <span className="font-bold text-brand-ink">{Math.floor(practiceSec / 60)}分</span>
              <span className="mx-1 text-slate-300">・</span>
              <span aria-hidden="true">🎵</span>
              <span className="sr-only">音楽</span> <span className="font-bold text-brand-ink">{Math.floor(musicSec / 60)}分</span>
            </div>
          </div>
          <div>
            <div className="mb-1 flex justify-between text-xs text-slate-500">
              <span>連続記録</span>
              <span>最高 {bestStreak}日</span>
            </div>
            {/* 途切れていれば 0。今日まだなら炎をグレーにして一言添える */}
            <div
              className={`flex flex-wrap items-baseline gap-x-1.5 text-sm font-bold ${
                doneToday ? "text-orange-600" : "text-slate-500"
              }`}
            >
              <span className={doneToday ? "" : "opacity-60 grayscale"} aria-hidden="true">
                🔥
              </span>
              <span>{streak}日</span>
              <span className="text-xs font-medium text-slate-400">
                {doneToday ? "今日は達成" : streak > 0 ? "今日学習して継続" : "今日から始めよう"}
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* バックアップの催促（前回から7日以上、または200回以上評価したとき） */}
      <BackupNudge />

      {/* 習熟度 */}
      <section className="card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-bold text-brand-ink">習熟度</h2>
          <span className="text-xs text-slate-400">全 {STATS.total} 語</span>
        </div>
        <div className="mb-1 flex justify-between text-xs text-slate-500">
          <span>学習に着手</span>
          <span>{Math.round(mastery.startedRatio * 100)}%</span>
        </div>
        <Bar value={mastery.startedRatio} className="bg-brand-blue" />
        <div className="mb-1 mt-3 flex justify-between text-xs text-slate-500">
          <span>定着（復習間隔7日以上）</span>
          <span>{Math.round(mastery.retainedRatio * 100)}%</span>
        </div>
        <Bar value={mastery.retainedRatio} className="bg-brand-green" />
        {/* 4マスの合計は全語数。レベルは保存値ではなく現在の間隔から導く（displayLevel） */}
        <div className="mt-3 grid grid-cols-4 gap-2 text-center text-xs">
          {[
            { label: "未学習", n: mastery.unstudied, c: "text-slate-500" },
            { label: "学習中", n: mastery.learning, c: "text-amber-600" },
            { label: "定着中", n: mastery.young, c: "text-blue-600" },
            { label: "習得", n: mastery.mature, c: "text-emerald-600" },
          ].map((x) => (
            <div key={x.label} className="rounded-lg bg-slate-50 py-2">
              <div className={`text-base font-bold ${x.c}`}>{x.n}</div>
              <div className="text-slate-400">{x.label}</div>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-center text-[11px] text-slate-400">学習中＝間隔7日未満 ／ 定着中＝7〜20日 ／ 習得＝21日以上</p>
        {/* 和→葡の産出カード（T2-1）: 日本語から言えるようになった語 */}
        {(prod.started > 0 || productionEnabled) && (
          <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-brand-blue/5 px-3 py-2 text-xs text-slate-600">
            <span>
              ✍ ポルトガル語で言える語 <span className="text-base font-bold text-brand-blue">{prod.canSay}</span>語
            </span>
            <span className="text-slate-400">
              {prod.started > 0 ? `練習中 ${prod.learning}語` : "定着中の語から始まります"}
            </span>
          </div>
        )}
        {addedIds.length > 0 && (
          <Link to="/flashcards/music" className="mt-3 flex items-center justify-between rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
            <span>🎵 曲の単語 {addedIds.length}語（うち学習済み {musicLearned}）</span>
            <span>›</span>
          </Link>
        )}
      </section>

      {/* モード */}
      <section className="grid grid-cols-2 gap-3">
        <Link to="/flashcards" className="card flex flex-col gap-1 p-4 transition hover:ring-brand-green/40">
          <span className="text-2xl">📇</span>
          <span className="font-semibold text-brand-ink">単語帳</span>
          <span className="text-xs text-slate-500">目隠し・音声・連続再生</span>
        </Link>
        <Link to="/quiz" className="card flex flex-col gap-1 p-4 transition hover:ring-brand-green/40">
          <span className="text-2xl">🎯</span>
          <span className="font-semibold text-brand-ink">クイズ</span>
          <span className="text-xs text-slate-500">10問・3モード</span>
        </Link>
        <Link to="/practice" className="card flex flex-col gap-1 p-4 transition hover:ring-brand-green/40">
          <span className="text-2xl">🎧</span>
          <span className="font-semibold text-brand-ink">練習</span>
          <span className="text-xs text-slate-500">読解・発話・書取</span>
        </Link>
        <Link to="/music" className="card col-span-2 flex items-center gap-3 p-4 transition hover:ring-brand-green/40">
          <span className="text-2xl">🎵</span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-brand-ink">音楽</div>
            <div className="text-xs text-slate-500">YouTube・同期歌詞・和訳・歌詞の単語をSRSへ</div>
          </div>
          <span className="text-slate-300">›</span>
        </Link>
        <Link to="/settings" className="card col-span-2 flex flex-col gap-1 p-4 transition hover:ring-brand-green/40">
          <span className="text-2xl">⚙️</span>
          <span className="font-semibold text-brand-ink">設定</span>
          <span className="text-xs text-slate-500">速度・音声・バックアップ</span>
        </Link>
      </section>

      <p className="px-1 text-center text-xs text-slate-400">
        一般語彙 {STATS.general} 語 ／ カポエイラ {STATS.capoeira} 語
      </p>
    </div>
  );
}
