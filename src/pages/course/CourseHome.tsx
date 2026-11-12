import { Link } from "react-router-dom";
import { Check, ChevronRight, MessagesSquare, Play } from "lucide-react";
import { UNITS, LESSONS } from "../../data/course";
import { LESSON_STEPS } from "../../speak/speakData";
import { useSpeak } from "../../store/useSpeak";

/**
 * コース（場面別レッスン）の一覧。上から順に進めるのがおすすめだが、どのレッスンも自由に開ける
 * （必要な場面から先にやってよい）。終えたレッスンは ✓、次にやるレッスンを強調する。
 */
export default function CourseHome() {
  const progress = useSpeak((s) => s.lessons);
  const next = LESSONS.find((l) => !progress[l.id]?.doneAt) ?? null;
  const done = LESSONS.filter((l) => progress[l.id]?.doneAt).length;

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <h1 className="text-xl font-bold text-brand-ink">レッスン</h1>
        <p className="mt-1 text-sm leading-relaxed text-slate-500">
          場面ごとの会話を「聞く → まねる → 言う → 演じる」で身につけます。1レッスン約10分。練習した文は、毎日の口慣らしに出てきます。
        </p>
        <div className="mt-3 flex items-center gap-3">
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-200">
            <div className="h-full rounded-full bg-brand-green" style={{ width: `${Math.round((done / LESSONS.length) * 100)}%` }} />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-slate-500">
            {done} / {LESSONS.length}
          </span>
        </div>
      </div>

      {UNITS.map((u) => {
        const unitDone = u.lessons.filter((l) => progress[l.id]?.doneAt).length;
        return (
          <section key={u.id} className="space-y-2">
            <div className="px-1">
              <h2 className="flex items-baseline gap-2 font-bold text-brand-ink">
                <span className="text-xs font-bold text-brand-green">UNIT {u.no}</span>
                {u.title}
                <span className="ml-auto text-xs font-normal tabular-nums text-slate-400">
                  {unitDone}/{u.lessons.length}
                </span>
              </h2>
              <p className="text-xs leading-relaxed text-slate-500">{u.goal}</p>
            </div>
            <ul className="card divide-y divide-slate-100 overflow-hidden">
              {u.lessons.map((l) => {
                const p = progress[l.id];
                const isDone = !!p?.doneAt;
                const isNext = next?.id === l.id;
                const started = !isDone && (p?.step ?? 0) > 0;
                return (
                  <li key={l.id} className={isNext ? "bg-brand-green/5" : ""}>
                    <div className="flex items-center gap-1 pr-2">
                      <Link to={`/course/${l.id}`} className="flex min-h-16 min-w-0 flex-1 items-center gap-3 px-3 py-2.5 transition active:bg-slate-50">
                        <span
                          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                            isDone ? "bg-brand-green text-white" : isNext ? "bg-white text-brand-green ring-2 ring-brand-green" : "bg-slate-100 text-slate-500"
                          }`}
                          aria-hidden
                        >
                          {isDone ? <Check size={18} strokeWidth={3} /> : l.no}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block font-semibold text-brand-ink">
                            {l.title}
                            {isDone && <span className="sr-only">（終了）</span>}
                          </span>
                          <span className="block truncate text-xs text-slate-500">{l.goal}</span>
                          {started && (
                            <span className="mt-0.5 block text-[11px] font-bold text-amber-600">
                              途中（{p?.step}/{LESSON_STEPS}）
                            </span>
                          )}
                        </span>
                        {isNext ? (
                          <span className="chip shrink-0 gap-1 bg-brand-green px-2.5 py-1 text-white">
                            <Play size={12} className="fill-current" aria-hidden />
                            {started ? "つづき" : "次はここ"}
                          </span>
                        ) : (
                          <ChevronRight size={18} className="shrink-0 text-slate-300" aria-hidden />
                        )}
                      </Link>
                      {isDone && (
                        <Link
                          to={`/talk/${l.id}`}
                          aria-label={`${l.title} の場面で AI と話す`}
                          title="この場面で AI と話す"
                          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-violet-600 transition active:scale-90"
                        >
                          <MessagesSquare size={20} aria-hidden />
                        </Link>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
