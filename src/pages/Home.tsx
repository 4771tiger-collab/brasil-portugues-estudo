import { useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check, ChevronRight, Flame, Headphones, ListMusic, Music, Play } from "lucide-react";
import { LESSONS } from "../data/course";
import { ALL_WORDS, STATS } from "../data/loadWords";
import { currentStreak, studiedToday, useProgress } from "../store/useProgress";
import { activitySeconds } from "../store/history";
import { useAddedIds } from "../store/useMusic";
import { masteryBreakdown, prodMastery } from "../srs/queue";
import { useToday } from "../hooks/useToday";
import { useDailyMenu, type MenuKey } from "../hooks/useDailyMenu";
import UpdateBanner from "../components/UpdateBanner";
import InstallCard from "../components/InstallCard";
import BackupNudge from "../components/BackupNudge";
import { IconBadge, type FeatureKey } from "../components/icons";

/** メニューの種類 → アイコン（色は icons/features.ts） */
const MENU_FEATURE: Record<MenuKey, FeatureKey> = { speak: "speak", lesson: "course", talk: "talk", words: "flashcards" };

function Bar({ value, className = "" }: { value: number; className?: string }) {
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
      <div className={`h-full rounded-full ${className}`} style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
    </div>
  );
}

/**
 * 今日（ホーム）: 「話せるようになる」ための毎日のメニューを、上から順にやるだけにする。
 * ① 口慣らし（覚えた文を声に出して思い出す）→ ② レッスン（新しい場面）→ ③ 会話（AI と自由に話す）→ ④ 単語。
 * 指標も「言える文の数・声に出した回数・会話の回数」を先に出す（単語の数は下に）。
 */
export default function Home() {
  // 日付の読み直しと daily の切替（ensureToday）は useToday が行う。翌日に戻っても数字が更新される
  const today = useToday();
  const menu = useDailyMenu();
  const cards = useProgress((s) => s.cards);
  const bestStreak = useProgress((s) => s.bestStreak);
  const streak = useProgress((s) => currentStreak(s, today));
  const doneToday = useProgress((s) => studiedToday(s, today));
  const dayLog = useProgress((s) => s.history?.[today]);
  const { practice: practiceSec, music: musicSec } = activitySeconds(dayLog);
  const spoken = dayLog?.act.speak?.n ?? 0;
  const talked = dayLog?.act.talk?.n ?? 0;
  const addedIds = useAddedIds();
  const mastery = useMemo(() => masteryBreakdown(ALL_WORDS, cards), [cards]);
  const prod = useMemo(() => prodMastery(cards), [cards]);
  const musicLearned = addedIds.filter((id) => cards[id]?.last).length;
  const isNew = menu.lessonsDone === 0 && menu.stats.started === 0;
  const allDone = !menu.next;

  return (
    <div className="animate-fade-in space-y-5">
      {/* 新しい版が待機中なら「更新」（学習の画面では出さない） */}
      <UpdateBanner />

      {/* アプリとしてのインストール案内（ホーム画面のアプリで開いているときは出ない） */}
      <InstallCard />

      {/* 今日のトレーニング */}
      <section className="card overflow-hidden">
        <div className="bg-gradient-to-br from-brand-green to-emerald-600 p-5 text-white">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-sm/relaxed font-bold opacity-95">今日のトレーニング</h1>
            <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-bold tabular-nums">
              {menu.done} / {menu.total} 完了
            </span>
          </div>
          <p className="mt-2 text-xl font-extrabold leading-snug">
            {allDone ? "今日のメニューは完了！ おつかれさま" : isNew ? "まずは最初のレッスンから。声に出して始めよう" : "上から順に、声に出していこう"}
          </p>
          {menu.next ? (
            <Link
              to={menu.next.to}
              className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-white px-4 font-bold text-brand-green shadow-sm transition active:scale-95"
            >
              <Play size={18} className="shrink-0 fill-current" aria-hidden />
              <span className="min-w-0 truncate">
                {menu.next.title}をはじめる
                <span className="ml-1 text-xs font-normal">（約{menu.next.minutes}分）</span>
              </span>
            </Link>
          ) : (
            <Link to="/speak/review?extra=1" className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-white/15 px-4 text-sm font-bold text-white transition active:scale-95">
              もう少し口慣らしをする
              <ArrowRight size={16} aria-hidden />
            </Link>
          )}
        </div>
        <ol className="divide-y divide-slate-100">
          {menu.items.map((it, i) => {
            const isNext = menu.next?.key === it.key;
            return (
              <li key={it.key}>
                <Link to={it.to} className={`flex min-h-16 items-center gap-3 px-4 py-3 transition active:bg-slate-50 ${isNext ? "bg-brand-green/5" : ""}`}>
                  <span className="w-4 shrink-0 text-center text-xs font-bold tabular-nums text-slate-400">{i + 1}</span>
                  <IconBadge feature={MENU_FEATURE[it.key]} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className={`block font-semibold ${it.state === "done" ? "text-slate-400" : "text-brand-ink"}`}>{it.title}</span>
                    <span className="block text-xs leading-relaxed text-slate-500">{it.detail}</span>
                  </span>
                  {it.state === "done" ? (
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-green text-white" aria-label="済み">
                      <Check size={16} strokeWidth={3} aria-hidden />
                    </span>
                  ) : (
                    <ChevronRight size={20} className={`shrink-0 ${isNext ? "text-brand-green" : "text-slate-300"}`} aria-hidden />
                  )}
                </Link>
              </li>
            );
          })}
        </ol>
      </section>

      {/* はじめての人へ: この順番の理由 */}
      {isNew && (
        <section className="card space-y-2 p-4 text-sm leading-relaxed text-slate-600">
          <h2 className="font-bold text-brand-ink">話せるようになる進め方</h2>
          <ol className="list-decimal space-y-1.5 pl-5">
            <li>
              <span className="font-semibold text-brand-ink">レッスン</span>で場面の会話を聞いて、まねて、日本語を見て言えるようにする（1日1課・約10分）
            </li>
            <li>
              練習した文は<span className="font-semibold text-brand-ink">口慣らし</span>に入り、忘れかけた頃に「日本語 → 声に出して言う」で毎日出てくる
            </li>
            <li>
              <span className="font-semibold text-brand-ink">会話</span>で、同じ場面を台本なしで AI と話す（任意・無料の設定で使える）
            </li>
            <li>
              <span className="font-semibold text-brand-ink">単語</span>は、話す材料を増やすために続ける
            </li>
          </ol>
          <p className="text-xs text-slate-500">声に出すほど話せるようになります。マイクを使うと、言えたかどうかを自動で確かめられます。</p>
        </section>
      )}

      {/* 話す力 */}
      <section className="card space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h2 className="font-bold text-brand-ink">話す力</h2>
          <Link to="/phrases" className="flex min-h-11 items-center text-xs font-semibold text-brand-green">
            フレーズ帳 ›
          </Link>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-xl bg-brand-green/5 py-2.5">
            <div className="text-2xl font-extrabold leading-none text-brand-green">{menu.stats.canSay}</div>
            <div className="mt-1 text-slate-500">言える文</div>
          </div>
          <div className="rounded-xl bg-amber-50 py-2.5">
            <div className="text-2xl font-extrabold leading-none text-amber-600">{menu.stats.learning}</div>
            <div className="mt-1 text-slate-500">練習中の文</div>
          </div>
          <div className="rounded-xl bg-slate-50 py-2.5">
            <div className="text-2xl font-extrabold leading-none text-brand-ink">
              {menu.lessonsDone}
              <span className="text-sm font-bold text-slate-400">/{LESSONS.length}</span>
            </div>
            <div className="mt-1 text-slate-500">レッスン</div>
          </div>
        </div>
        <p className="text-center text-[11px] text-slate-400">言える文＝日本語を見てすぐ言えて、復習の間隔が7日以上になった文</p>
        {menu.stats.started > 0 && (
          <Link to="/speak/handsfree" className="flex min-h-11 items-center gap-2 rounded-lg bg-teal-50 px-3 py-2 text-xs text-teal-800">
            <Headphones size={16} className="shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">耳だけ口慣らし（画面を見ずに、歩きながら声に出す）</span>
            <ChevronRight size={16} className="shrink-0 text-teal-600" aria-hidden />
          </Link>
        )}
        <div className="grid grid-cols-2 gap-3 border-t border-slate-100 pt-3">
          <div className="text-xs leading-relaxed text-slate-500">
            <div className="mb-0.5 font-bold text-slate-600">今日</div>
            声に出した <span className="font-bold text-brand-ink">{spoken}回</span>
            <span className="mx-1 text-slate-300">・</span>
            会話 <span className="font-bold text-brand-ink">{talked}回</span>
            <br />
            練習 <span className="font-bold text-brand-ink">{Math.floor(practiceSec / 60)}分</span>
            <span className="mx-1 text-slate-300">・</span>
            <Music size={12} strokeWidth={2.25} className="inline-block align-[-1px] text-rose-500" aria-hidden />
            <span className="sr-only">音楽</span> <span className="font-bold text-brand-ink">{Math.floor(musicSec / 60)}分</span>
          </div>
          <div>
            <div className="mb-0.5 flex justify-between text-xs text-slate-500">
              <span className="font-bold text-slate-600">連続記録</span>
              <span>最高 {bestStreak}日</span>
            </div>
            {/* 途切れていれば 0。今日まだなら炎をグレーにして一言添える */}
            <div className={`flex flex-wrap items-baseline gap-x-1.5 text-sm font-bold ${doneToday ? "text-orange-600" : "text-slate-500"}`}>
              <Flame size={16} className={`self-center ${doneToday ? "fill-orange-400 text-orange-600" : "text-slate-400"}`} aria-hidden />
              <span>{streak}日</span>
              <span className="text-xs font-medium text-slate-400">{doneToday ? "今日は達成" : streak > 0 ? "今日やって継続" : "今日から始めよう"}</span>
            </div>
          </div>
        </div>
      </section>

      {/* バックアップの催促（前回から7日以上、または200回以上評価したとき） */}
      <BackupNudge />

      {/* 単語（話す材料） */}
      <section className="card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-bold text-brand-ink">単語</h2>
          <Link to="/flashcards" className="flex min-h-11 items-center text-xs font-semibold text-brand-green">
            単語帳 ›
          </Link>
        </div>
        <div className="mb-1 flex justify-between text-xs text-slate-500">
          <span>定着（復習間隔7日以上）</span>
          <span>
            {mastery.young + mastery.mature} / {STATS.total}語
          </span>
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
        {prod.started > 0 && (
          <p className="mt-3 rounded-lg bg-brand-blue/5 px-3 py-2 text-xs text-slate-600">
            ✍ 日本語から言える語 <span className="text-base font-bold text-brand-blue">{prod.canSay}</span>語
            <span className="ml-2 text-slate-400">練習中 {prod.learning}語</span>
          </p>
        )}
        {addedIds.length > 0 && (
          <Link to="/flashcards/music" className="mt-3 flex min-h-11 items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <ListMusic size={16} className="shrink-0" aria-hidden />
            <span className="min-w-0 flex-1">
              曲の単語 {addedIds.length}語（うち学習済み {musicLearned}）
            </span>
            <ChevronRight size={16} className="shrink-0 text-amber-600" aria-hidden />
          </Link>
        )}
      </section>

      <p className="px-1 text-center text-xs text-slate-400">
        レッスン {LESSONS.length}課 ／ 一般語彙 {STATS.general} 語 ／ カポエイラ {STATS.capoeira} 語
      </p>
    </div>
  );
}
