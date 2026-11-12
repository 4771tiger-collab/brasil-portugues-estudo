import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PartyPopper, X } from "lucide-react";
import { useBack } from "../../hooks/useBack";
import { useCatalog } from "../../hooks/useDailyMenu";
import { useImmersive } from "../../hooks/useImmersive";
import { useActivityTimer } from "../../hooks/useActivityTimer";
import { useWakeLock } from "../../hooks/useWakeLock";
import { useToday } from "../../hooks/useToday";
import { useSettings } from "../../store/useSettings";
import { speakDailyToday, useSpeak } from "../../store/useSpeak";
import { COMEBACK_DAYS, COMEBACK_SESSION, SESSION_MAX, dueCount, dueItems, extraItems, speakStats, type SayItem } from "../../speak/catalog";
import { diffDays } from "../../srs/scheduler";
import { useProgress } from "../../store/useProgress";
import SayRunner, { type SayResult } from "../../components/speak/SayRunner";
import NextMenu from "../../components/speak/NextMenu";
import { speakPt } from "../../components/speak/speakPt";

/** 追加練習（今日の分が終わったあと）の文の数 */
const EXTRA_COUNT = 10;

/**
 * 口慣らし（文の復習）: 期限の来た文を、日本語を見て → ポルトガル語を声に出して言う。
 * 話せるようになるための毎日の中心の練習（単語の復習より先にやる）。
 * /speak/review … 今日の分（1回 SESSION_MAX 文まで）。?extra=1 … 期限前の文の追加練習（SRS は「言えなかった」だけ反映）。
 */
export default function SpeakReview() {
  const [params, setParams] = useSearchParams();
  const extra = params.get("extra") === "1";
  const today = useToday();
  const catalog = useCatalog();
  const limit = useSettings((s) => s.speakDailyLimit);
  const back = useBack("/");
  /** セッションを作り直すための番号（「つづける」で増やす） */
  const [round, setRound] = useState(0);
  // 何日か空いたあとの最初の回は短くする（開いた時点の記録で決める。1文でも評価すると今日が学習日になる）
  const [comeback] = useState(() => {
    const last = useProgress.getState().lastStudyDate;
    return !!last && diffDays(today, last) >= COMEBACK_DAYS;
  });
  const [result, setResult] = useState<SayResult | null>(null);

  // 開いた時点の記録で、今回出す文を決める（評価のたびに並びを変えない）
  const items = useMemo<SayItem[]>(() => {
    const sp = useSpeak.getState();
    if (extra) return extraItems(sp.cards, catalog, today, EXTRA_COUNT);
    const remaining = Math.max(0, limit - speakDailyToday(sp.daily, today).dueReviewed);
    return dueItems(sp.cards, catalog, today, remaining).slice(0, comeback ? COMEBACK_SESSION : SESSION_MAX);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extra, round, today]);

  const running = items.length > 0 && !result;
  useImmersive(running);
  useWakeLock(running);
  useActivityTimer("speak", running);

  const onDone = useCallback((r: SayResult) => setResult(r), []);

  function restart(nextExtra: boolean) {
    setResult(null);
    setRound((n) => n + 1);
    if (nextExtra !== extra) setParams(nextExtra ? { extra: "1" } : {}, { replace: true });
  }

  if (running) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div className="flex items-center justify-between">
          <button type="button" onClick={back} aria-label="口慣らしをやめる" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-slate-500 active:scale-90">
            <X size={22} aria-hidden />
          </button>
          <h1 className="text-sm font-bold text-brand-ink">{extra ? "口慣らし（追加練習）" : "口慣らし"}</h1>
          <span className="w-11" />
        </div>
        {comeback && round === 0 && !extra && (
          <p className="rounded-xl bg-brand-green/5 px-3 py-2 text-center text-xs leading-relaxed text-emerald-800">
            おかえりなさい！ まずは {items.length}文だけ。忘れていても大丈夫、言い直せば戻ってきます。
          </p>
        )}
        <SayRunner key={`${extra}-${round}`} items={items} onDone={onDone} />
      </div>
    );
  }
  return <Finished result={result} extra={extra} onRestart={restart} />;
}

function Finished({ result, extra, onRestart }: { result: SayResult | null; extra: boolean; onRestart: (extra: boolean) => void }) {
  const today = useToday();
  const catalog = useCatalog();
  const cards = useSpeak((s) => s.cards);
  const daily = useSpeak((s) => s.daily);
  const limit = useSettings((s) => s.speakDailyLimit);
  const stats = useMemo(() => speakStats(cards, catalog), [cards, catalog]);
  const dueLeft = useMemo(() => {
    const remaining = Math.max(0, limit - speakDailyToday(daily, today).dueReviewed);
    return dueItems(cards, catalog, today, remaining).length;
  }, [cards, catalog, today, daily, limit]);
  const overLimit = dueLeft === 0 && dueCount(cards, catalog, today) > 0;
  const canExtra = useMemo(() => extraItems(cards, catalog, today, 1).length > 0, [cards, catalog, today]);

  return (
    <div className="mx-auto max-w-xl animate-fade-in space-y-4">
      <div className="card space-y-3 p-6 text-center">
        {result ? (
          <>
            <PartyPopper size={36} className="mx-auto text-brand-yellow" aria-hidden />
            <h1 className="text-xl font-bold text-brand-ink">{result.total}文、声に出しました！</h1>
            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-lg bg-emerald-50 py-2">
                <div className="text-lg font-bold text-emerald-600">{result.good}</div>
                <div className="text-slate-500">言えた</div>
              </div>
              <div className="rounded-lg bg-amber-50 py-2">
                <div className="text-lg font-bold text-amber-600">{result.hard}</div>
                <div className="text-slate-500">惜しい</div>
              </div>
              <div className="rounded-lg bg-rose-50 py-2">
                <div className="text-lg font-bold text-rose-500">{result.again}</div>
                <div className="text-slate-500">言えなかった</div>
              </div>
            </div>
          </>
        ) : stats.started === 0 && Object.keys(cards).length === 0 ? (
          <>
            <h1 className="text-xl font-bold text-brand-ink">口慣らしは、レッスンのあとに始まります</h1>
            <p className="text-sm leading-relaxed text-slate-500">
              レッスンで練習した文が、ここに毎日少しずつ出てきます。日本語を見て、ポルトガル語を声に出して言う練習です。
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold text-brand-ink">{extra ? "追加で練習できる文がありません" : "今日の口慣らしは終わっています"}</h1>
            <p className="text-sm text-slate-500">次の復習は、忘れかけた頃に出てきます。</p>
          </>
        )}
        <p className="rounded-lg bg-brand-green/5 px-3 py-2 text-sm text-slate-600">
          言える文 <span className="text-lg font-bold text-brand-green">{stats.canSay}</span>
          <span className="mx-1.5 text-slate-300">・</span>
          練習中 <span className="font-bold text-brand-ink">{stats.learning}</span>
        </p>
        {overLimit && <p className="text-xs text-slate-400">今日の上限（{limit}文）まで復習しました。残りは明日に回します（上限は設定で変えられます）。</p>}
      </div>

      {result && result.gained.length > 0 && (
        <section className="card space-y-2 p-4">
          <h2 className="text-sm font-bold text-emerald-700">🎉 今日、言えるようになった文（{result.gained.length}）</h2>
          <ul className="divide-y divide-slate-100">
            {result.gained.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => void speakPt(m.pt)} className="w-full py-2 text-left">
                  <span className="block text-xs text-slate-500">{m.ja}</span>
                  <span className="block font-semibold text-brand-ink" lang="pt-BR">
                    {m.pt}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {result && result.missed.length > 0 && (
        <section className="card space-y-2 p-4">
          <h2 className="text-sm font-bold text-slate-500">言えなかった文（タップでお手本）</h2>
          <ul className="divide-y divide-slate-100">
            {result.missed.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => void speakPt(m.pt)} className="w-full py-2 text-left">
                  <span className="block text-xs text-slate-500">{m.ja}</span>
                  <span className="block font-semibold text-brand-ink" lang="pt-BR">
                    {m.pt}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="space-y-2">
        {dueLeft > 0 && (
          <button type="button" onClick={() => onRestart(false)} className="btn-primary min-h-14 w-full text-base">
            つづける（あと {dueLeft}文）
          </button>
        )}
        {stats.started === 0 && Object.keys(cards).length === 0 ? (
          <Link to="/course" replace className="btn-primary min-h-14 w-full text-base">
            レッスンを始める
          </Link>
        ) : (
          <NextMenu skip="speak" />
        )}
        {dueLeft === 0 && canExtra && (
          <button type="button" onClick={() => onRestart(true)} className="btn-ghost min-h-12 w-full text-sm">
            もう少し練習する（あやふやな文を {EXTRA_COUNT}文）
          </button>
        )}
      </div>
    </div>
  );
}
