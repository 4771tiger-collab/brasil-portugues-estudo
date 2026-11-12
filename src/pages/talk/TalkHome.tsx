import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BookMarked, ChevronRight, Drama, MessagesSquare, PencilLine, Sparkles } from "lucide-react";
import { LESSONS, type Lesson } from "../../data/course";
import { useAiProvider } from "../../hooks/useAiProvider";
import { CUSTOM_SCENE_MAX, FREE_TOPICS, TALK_LEVELS, TALK_LEVEL_LABEL, defaultTalkLevel } from "../../speak/talk";
import { useSettings } from "../../store/useSettings";
import { useSpeak } from "../../store/useSpeak";
import AiSetupCard from "../../components/speak/AiSetupCard";

function Row({ to, state, title, sub, tag }: { to: string; state?: unknown; title: string; sub: string; tag?: string }) {
  return (
    <Link to={to} state={state} className="flex min-h-14 items-center gap-3 px-3 py-2.5 transition active:bg-slate-50">
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-brand-ink">
          {title}
          {tag && <span className="chip ml-2 bg-violet-100 text-violet-700">{tag}</span>}
        </span>
        <span className="block truncate text-xs text-slate-500">{sub}</span>
      </span>
      <ChevronRight size={18} className="shrink-0 text-slate-300" aria-hidden />
    </Link>
  );
}

/**
 * 会話（台本なしで話す練習）の入口。AI を相手に、習った場面・フリートーク・自分で決めた場面で話す。
 * AI のキーが無いときは、キーの作り方と、AI なしでできるロールプレイ（レッスンの「演じる」）を出す。
 */
export default function TalkHome() {
  const { provider } = useAiProvider();
  const navigate = useNavigate();
  const progress = useSpeak((s) => s.lessons);
  const talks = useSpeak((s) => s.talks);
  const levelSetting = useSettings((s) => s.talkLevel);
  const set = useSettings((s) => s.set);
  const [scene, setScene] = useState("");
  const [showAll, setShowAll] = useState(false);

  const done = useMemo(() => LESSONS.filter((l) => progress[l.id]?.doneAt), [progress]);
  // 終えたレッスンを、終えた日の新しい順に（同じ日は後のレッスンが先）
  const learned = useMemo(
    () => [...done].sort((a, b) => ((progress[a.id]?.doneAt ?? "") < (progress[b.id]?.doneAt ?? "") ? 1 : (progress[a.id]?.doneAt ?? "") > (progress[b.id]?.doneAt ?? "") ? -1 : b.no - a.no)),
    [done, progress]
  );
  const rest = useMemo(() => LESSONS.filter((l) => !progress[l.id]?.doneAt), [progress]);
  const auto = defaultTalkLevel(done.length);
  const totalTurns = talks.reduce((n, t) => n + t.turns, 0);
  const lessonRow = (l: Lesson, tag?: string) => <Row key={l.id} to={`/talk/${l.id}`} title={l.title} sub={`${l.talk.role}・${l.talk.setting}`} tag={tag} />;

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <h1 className="text-xl font-bold text-brand-ink">会話</h1>
        <p className="mt-1 text-sm leading-relaxed text-slate-500">
          台本なしで話す練習です。AI が相手役になって自然に返し、あなたの言い方をその場で直します。直された文は「口慣らし」に足して、次は言えるようにします。
        </p>
        {totalTurns > 0 && (
          <p className="mt-2 text-xs text-slate-500">
            これまでに <span className="font-bold text-brand-ink">{talks.length}回</span>の会話で、
            <span className="font-bold text-brand-ink">{totalTurns}回</span> 話しました。
          </p>
        )}
      </div>

      {!provider && <AiSetupCard />}

      {!provider && done.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 px-1 text-sm font-bold text-slate-500">
            <Drama size={16} className="text-orange-500" aria-hidden />
            AI なしで: ロールプレイ（台本あり）
          </h2>
          <ul className="card divide-y divide-slate-100 overflow-hidden">
            {learned.slice(0, 5).map((l) => (
              <li key={l.id}>
                <Row to={`/course/${l.id}?step=3`} title={l.title} sub="相手のセリフを聞いて、自分の役を言う" />
              </li>
            ))}
          </ul>
        </section>
      )}

      {provider && (
        <section className="card space-y-2 p-3">
          <h2 className="px-1 text-sm font-bold text-slate-500">相手の話し方（むずかしさ）</h2>
          <div className="grid grid-cols-5 gap-1.5">
            <button
              type="button"
              onClick={() => set({ talkLevel: -1 })}
              aria-pressed={levelSetting === -1}
              className={`min-h-11 rounded-xl text-xs font-bold ${levelSetting === -1 ? "bg-brand-green text-white" : "bg-slate-100 text-slate-600"}`}
            >
              自動
            </button>
            {TALK_LEVELS.map((lv) => (
              <button
                key={lv}
                type="button"
                onClick={() => set({ talkLevel: lv })}
                aria-pressed={levelSetting === lv}
                className={`min-h-11 rounded-xl text-xs font-bold ${levelSetting === lv ? "bg-brand-green text-white" : "bg-slate-100 text-slate-600"}`}
              >
                {TALK_LEVEL_LABEL[lv]}
              </button>
            ))}
          </div>
          <p className="px-1 text-xs text-slate-400">
            自動: 終えたレッスンの数に合わせます（今は「{TALK_LEVEL_LABEL[auto]}」）。
          </p>
        </section>
      )}

      <section className="space-y-2">
        <h2 className="flex items-center gap-1.5 px-1 text-sm font-bold text-slate-500">
          <MessagesSquare size={16} className="text-violet-600" aria-hidden />
          習った場面で話す
        </h2>
        {learned.length ? (
          <ul className="card divide-y divide-slate-100 overflow-hidden">
            {learned.map((l, i) => (
              <li key={l.id}>{lessonRow(l, i === 0 ? "おすすめ" : undefined)}</li>
            ))}
          </ul>
        ) : (
          <p className="card p-4 text-sm leading-relaxed text-slate-500">
            レッスンを終えると、その場面がここに並びます。
            <Link to="/course" className="ml-1 font-semibold text-brand-green">
              レッスンへ ›
            </Link>
          </p>
        )}
        {rest.length > 0 && (
          <>
            <button type="button" onClick={() => setShowAll((v) => !v)} className="flex min-h-11 items-center px-1 text-xs font-semibold text-brand-blue">
              {showAll ? "まだ習っていない場面を隠す" : `まだ習っていない場面も見る（${rest.length}）`}
            </button>
            {showAll && (
              <ul className="card divide-y divide-slate-100 overflow-hidden">
                {rest.map((l) => (
                  <li key={l.id}>{lessonRow(l)}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="flex items-center gap-1.5 px-1 text-sm font-bold text-slate-500">
          <Sparkles size={16} className="text-amber-500" aria-hidden />
          フリートーク（自分のことを話す）
        </h2>
        <ul className="card divide-y divide-slate-100 overflow-hidden">
          {FREE_TOPICS.map((t) => (
            <li key={t.id}>
              <Row to={`/talk/${t.id}`} title={t.title} sub={`${t.role}・${t.setting}`} />
            </li>
          ))}
        </ul>
      </section>

      <section className="card space-y-2 p-4">
        <h2 className="flex items-center gap-1.5 text-sm font-bold text-slate-500">
          <PencilLine size={16} className="text-brand-blue" aria-hidden />
          自分で場面を決める
        </h2>
        <p className="text-xs leading-relaxed text-slate-500">近いうちに実際にありそうな場面を書くと、その練習ができます（例: 美容院で髪を切ってもらう／大家さんに水漏れを伝える）。</p>
        <textarea
          value={scene}
          onChange={(e) => setScene(e.target.value.slice(0, CUSTOM_SCENE_MAX))}
          rows={2}
          placeholder="どんな場面で、誰と話しますか？"
          aria-label="会話の場面"
          className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-base text-brand-ink focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green/25"
        />
        <button type="button" disabled={!scene.trim()} onClick={() => navigate("/talk/custom", { state: { scene: scene.trim() } })} className="btn-primary min-h-12 w-full">
          この場面で話す
        </button>
      </section>

      <Link to="/phrases" className="card flex items-center gap-3 p-4 transition active:scale-[0.99]">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-700 ring-1 ring-inset ring-emerald-200/70">
          <BookMarked size={22} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-brand-ink">フレーズ帳・言いたいことメモ</span>
          <span className="block text-xs text-slate-500">「これ、何て言うんだろう」を足して、毎日の口慣らしに</span>
        </span>
        <ChevronRight size={18} className="shrink-0 text-slate-300" aria-hidden />
      </Link>
    </div>
  );
}
