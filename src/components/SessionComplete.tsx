import { useMemo } from "react";
import { Link } from "react-router-dom";
import type { Word } from "../data/types";
import { CORE_ORDER, reviewPool } from "../data/loadWords";
import { useProgress } from "../store/useProgress";
import { useAddedIds, useUserWordMap } from "../store/useMusic";
import { forecast as buildForecast, orderNew } from "../srs/queue";
import { addDays } from "../srs/scheduler";
import type { SessionStats } from "../srs/session";
import { useToday } from "../hooks/useToday";

const WEEKDAY = ["日", "月", "火", "水", "木", "金", "土"];

/** 復習の対象になる語（単語帳の全語＋曲から追加した語） */
function usePool(): Word[] {
  const addedIds = useAddedIds();
  const userMap = useUserWordMap();
  return useMemo(() => reviewPool(addedIds, userMap), [addedIds, userMap]);
}

/** 復習の予報（明日から days 日分） */
export function useForecast(days = 7): number[] {
  const today = useToday();
  const cards = useProgress((s) => s.cards);
  const pool = usePool();
  return useMemo(() => buildForecast(pool, cards, today, days), [pool, cards, today, days]);
}

interface Props {
  /** このセッションの集計。null は「始めた時点で今日の分が無かった」 */
  stats: SessionStats | null;
  /** 今の周で again だった語 */
  againWords: Word[];
  /** 明日からの復習数（useForecast） */
  forecast: number[];
  /** 新しい語を止めている理由。backlog = 期限の来た復習が1日の復習の上限を超えている（buildSession） */
  reason?: "backlog";
  /** again だった語をもう1周（無ければボタンを出さない） */
  onAgainRound?: () => void;
  /** 「あと5語」（今日の学習のみ。無ければ出さない） */
  onExtra?: () => void;
  /** 次の一手のクイズを、このデッキのクイズ（/quiz/:deckId）にする。無ければ /quiz */
  quizPath?: string;
}

/** 明日から7日分の予報（単一系列の棒。値は棒の上に直接書く） */
function ForecastBars({ values, today }: { values: number[]; today: string }) {
  const max = Math.max(1, ...values);
  const days = values.map((n, i) => {
    const d = addDays(today, i + 1);
    const label = i === 0 ? "明日" : WEEKDAY[new Date(d + "T00:00:00").getDay()];
    return { d, n, label };
  });
  return (
    <figure>
      <div className="flex h-24 items-end gap-0.5" aria-hidden="true">
        {days.map((x) => (
          <div key={x.d} className="flex h-full flex-1 flex-col items-center justify-end" title={`${x.d}: ${x.n}枚`}>
            <span className="mb-0.5 text-[10px] tabular-nums text-slate-500">{x.n}</span>
            <div
              className={`w-full max-w-[28px] rounded-t ${x.n ? "bg-brand-green" : "bg-slate-200"}`}
              style={{ height: x.n ? `${Math.max(6, (x.n / max) * 100)}%` : "2px" }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-0.5 border-t border-slate-200 pt-1" aria-hidden="true">
        {days.map((x) => (
          <span key={x.d} className="flex-1 text-center text-[10px] text-slate-400">
            {x.label}
          </span>
        ))}
      </div>
      {/* 読み上げ用の表 */}
      <figcaption className="sr-only">
        {days.map((x) => `${x.label} ${x.n}枚`).join("、")}
      </figcaption>
    </figure>
  );
}

export default function SessionComplete({ stats, againWords, forecast, reason, onAgainRound, onExtra, quizPath }: Props) {
  const today = useToday();
  const cards = useProgress((s) => s.cards);
  const pool = usePool();
  // 導入できる語（orderNew の候補。固有名詞・別名などは除く）が残っているときだけ「あと5語」を出す
  const hasUnseen = useMemo(
    () => orderNew(pool, cards, { limit: 1, capoeiraShare: 0, coreOrder: CORE_ORDER, seed: today }).length > 0,
    [pool, cards, today]
  );
  const tomorrow = forecast[0] ?? 0;
  const accuracy = stats && stats.words ? Math.round((stats.firstCorrect / stats.words) * 100) : null;

  return (
    <div className="animate-fade-in space-y-4">
      <section className="card overflow-hidden">
        <div className="bg-gradient-to-br from-brand-green to-emerald-600 p-5 text-white">
          <div className="text-2xl font-extrabold">{stats ? "🎉 おつかれさまでした" : "🎉 今日の分は完了しています"}</div>
          <div className="mt-1 text-sm opacity-90">
            {stats
              ? "ひと通り終わりました"
              : reason === "backlog"
                ? "今日の復習は上限まで終わりました。残りは明日以降に回ります"
                : "復習も新しい語も、今日の予定はありません"}
          </div>
        </div>
        {stats && (
          <div className="grid grid-cols-3 divide-x divide-slate-100 p-3 text-center">
            <div>
              <div className="text-2xl font-bold text-brand-ink">{stats.reviews}</div>
              <div className="text-xs text-slate-400">評価した枚数</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-brand-ink">{accuracy ?? "—"}{accuracy !== null && <span className="text-base">%</span>}</div>
              <div className="text-xs text-slate-400">1回目の正答率</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-brand-ink">{stats.newWords}</div>
              <div className="text-xs text-slate-400">新しい語</div>
            </div>
          </div>
        )}
      </section>

      {againWords.length > 0 && (
        <section className="card space-y-3 p-4">
          <h2 className="text-sm font-bold text-slate-500">「もう一度」だった語（{againWords.length}）</h2>
          <div className="flex flex-wrap gap-1.5">
            {againWords.map((w) => (
              <span key={w.id} className="chip bg-rose-50 text-rose-600">
                {w.pt}
              </span>
            ))}
          </div>
          {onAgainRound && (
            <button type="button" onClick={onAgainRound} className="btn-primary min-h-11 w-full">
              この {againWords.length}語をもう1周
            </button>
          )}
        </section>
      )}

      <section className="card p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-bold text-slate-500">これからの復習</h2>
          <span className="text-sm text-brand-ink">
            明日 <span className="text-lg font-bold">{tomorrow}</span> 枚
          </span>
        </div>
        <ForecastBars values={forecast} today={today} />
      </section>

      {reason === "backlog" && (
        <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          期限の来た復習が1日の上限（設定の「1日の復習の上限」）を超えているため、新しい語はお休みしています。延滞の大きい語から順に出しているので、復習が上限内に収まると新しい語も再開します。
        </div>
      )}

      {onExtra && hasUnseen && reason !== "backlog" && (
        <button type="button" onClick={onExtra} className="btn-ghost min-h-11 w-full flex-col gap-0 py-2">
          <span>＋ あと5語 学ぶ</span>
          <span className="text-[11px] font-normal text-slate-400">明日の復習が約5枚増えます</span>
        </button>
      )}

      <section className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-slate-500">次の一手</h2>
        <div className="grid grid-cols-2 gap-3">
          <Link to={quizPath ?? "/quiz"} className="card flex min-h-11 flex-col gap-1 p-4 transition hover:ring-brand-green/40">
            <span className="text-2xl">🎯</span>
            <span className="font-semibold text-brand-ink">{quizPath ? "このデッキでクイズ" : "クイズ"}</span>
            <span className="text-xs text-slate-500">覚えた語を確かめる</span>
          </Link>
          <Link to="/practice/shadowing" className="card flex min-h-11 flex-col gap-1 p-4 transition hover:ring-brand-green/40">
            <span className="text-2xl">🗣️</span>
            <span className="font-semibold text-brand-ink">シャドーイング</span>
            <span className="text-xs text-slate-500">声に出して慣れる</span>
          </Link>
        </div>
        <Link to="/flashcards" className="btn-ghost min-h-11 w-full">
          単語帳の一覧へ
        </Link>
      </section>
    </div>
  );
}
