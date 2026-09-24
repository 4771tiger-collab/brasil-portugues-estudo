import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { WORDS_CAPOEIRA, WORDS_GENERAL, ALL_WORDS, resolveWord, reviewPool } from "../data/loadWords";
import type { Word } from "../data/types";
import { todayCounters, useProgress } from "../store/useProgress";
import type { QuizEffect } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { useAddedIds, useUserWordMap } from "../store/useMusic";
import { reviewDueWords } from "../srs/queue";
import { audio } from "../services/audio";
import SpeakerButton from "../components/SpeakerButton";

type Mode = "pt2ja" | "ja2pt" | "listen";
type Scope = "studied" | "due" | "general" | "capoeira" | "music";

interface Question {
  word: Word;
  choices: Word[];
  answer: number; // choices内の正解index
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildQuestions(pool: Word[], distractorPool: Word[], mode: Mode, count = 10): Question[] {
  const picked = shuffle(pool).slice(0, Math.min(count, pool.length));
  const key = (w: Word) => (mode === "ja2pt" ? w.pt : w.ja);
  return picked.map((word) => {
    const sameCat = distractorPool.filter((w) => w.id !== word.id && w.category === word.category && key(w) !== key(word));
    const others = distractorPool.filter((w) => w.id !== word.id && key(w) !== key(word));
    const distractors: Word[] = [];
    const used = new Set<string>([key(word)]);
    for (const cand of [...shuffle(sameCat), ...shuffle(others)]) {
      if (distractors.length >= 3) break;
      if (used.has(key(cand))) continue;
      used.add(key(cand));
      distractors.push(cand);
    }
    const choices = shuffle([word, ...distractors]);
    return { word, choices, answer: choices.findIndex((c) => c.id === word.id) };
  });
}

/** 結果画面の各行に出す「SRS への反映」ラベル */
const EFFECT_LABEL: Record<QuizEffect, { label: string; cls: string }> = {
  reviewed: { label: "反映", cls: "bg-emerald-50 text-emerald-700" },
  lapsed: { label: "反映・再学習", cls: "bg-rose-50 text-rose-600" },
  unchanged: { label: "変更なし", cls: "bg-slate-100 text-slate-500" },
  untracked: { label: "未学習", cls: "bg-amber-50 text-amber-700" },
};

export default function Quiz() {
  const cards = useProgress((s) => s.cards);
  const rateQuiz = useProgress((s) => s.rateQuiz);
  const pinNew = useProgress((s) => s.pinNew);
  const pinnedNew = useProgress((s) => s.pinnedNew);
  const daily = todayCounters(useProgress((s) => s.daily));
  const dailyNewLimit = useSettings((s) => s.dailyNewLimit);
  const voiceURI = useSettings((s) => s.voiceURI);
  const settingsRate = useSettings((s) => s.rate);

  const addedIds = useAddedIds();
  const userMap = useUserWordMap();
  // 曲から追加した語も対象に含める（誤答の選択肢は単語帳の語から取る）
  const pool = useMemo(() => reviewPool(addedIds, userMap), [addedIds, userMap]);
  const musicWords = useMemo(
    () => addedIds.map((id) => resolveWord(id, userMap)).filter((w): w is Word => !!w),
    [addedIds, userMap]
  );
  const studiedWords = useMemo(() => pool.filter((w) => cards[w.id]?.last), [pool, cards]);
  const dueCount = useMemo(() => reviewDueWords(pool, cards).length, [pool, cards]);

  const [phase, setPhase] = useState<"setup" | "playing" | "result">("setup");
  const [mode, setMode] = useState<Mode>("pt2ja");
  // 既定は「学習済み」。ただし学習語が少ない初回は「一般語彙」にフォールバック
  const [scope, setScope] = useState<Scope>(() => (studiedWords.length >= 4 ? "studied" : "general"));
  const [questions, setQuestions] = useState<Question[]>([]);
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState<(number | null)[]>([]);
  // 1問ごとの SRS への反映結果（未解答は null）
  const [effects, setEffects] = useState<(QuizEffect | null)[]>([]);
  // rateQuiz は同じ語に2回呼ぶと練習量を二重に数えるので、連打でも1問1回に限る
  const answeredRef = useRef<Set<number>>(new Set());

  /** リスニング問題の読み上げ。自動再生の制限を避けるため、必ずクリック処理の中から呼ぶ */
  function speakQuestion(q: Question | undefined) {
    if (mode !== "listen" || !q) return;
    void audio.speak(q.word.ptForSpeech, { rate: settingsRate, voiceURI });
  }

  function start() {
    let pool: Word[];
    if (scope === "studied") pool = studiedWords;
    else if (scope === "due") pool = reviewDueWords(reviewPool(addedIds, userMap), cards);
    else if (scope === "music") pool = musicWords;
    else if (scope === "capoeira") pool = WORDS_CAPOEIRA;
    else pool = WORDS_GENERAL;
    // 出題語が空の時のみ全語にフォールバック（誤答候補は常に全語から取るため、
    // 学習済みが少数でも「学習した語のみ」を出題できる）
    if (pool.length === 0) pool = ALL_WORDS;
    const qs = buildQuestions(pool, ALL_WORDS, mode);
    setQuestions(qs);
    setSelected(new Array(qs.length).fill(null));
    setEffects(new Array(qs.length).fill(null));
    answeredRef.current = new Set();
    setIdx(0);
    setPhase("playing");
    // リスニングの1問目は「スタート」のタップの中で読み上げる
    speakQuestion(qs[0]);
  }

  /** 解答したその場で SRS に反映する（途中で離れても答えた分は残る） */
  function choose(choiceIdx: number) {
    const q = questions[idx];
    if (!q || selected[idx] != null || answeredRef.current.has(idx)) return;
    answeredRef.current.add(idx);
    const i = idx;
    // 未学習語・今日評価済み・期限前の正解は SRS に書かない（判定は useProgress.rateQuiz / quizDecision）
    const effect = rateQuiz(q.word.id, choiceIdx === q.answer ? "good" : "again");
    setSelected((prev) => {
      const next = [...prev];
      next[i] = choiceIdx;
      return next;
    });
    setEffects((prev) => {
      const next = [...prev];
      next[i] = effect;
      return next;
    });
  }

  function nextQuestion() {
    if (idx < questions.length - 1) {
      setIdx(idx + 1);
      speakQuestion(questions[idx + 1]);
    } else {
      setPhase("result");
    }
  }

  /** 中断: 1問でも答えていれば結果画面へ（反映済みの結果を見せる）、未解答なら出題設定へ */
  function quit() {
    audio.cancel();
    setPhase(selected.some((s) => s != null) ? "result" : "setup");
  }

  // ---------- setup ----------
  if (phase === "setup") {
    const modes: { v: Mode; label: string; desc: string }[] = [
      { v: "pt2ja", label: "葡 → 和", desc: "単語を見て意味を選ぶ" },
      { v: "ja2pt", label: "和 → 葡", desc: "意味を見て葡語を選ぶ" },
      { v: "listen", label: "リスニング", desc: "音声を聴いて意味を選ぶ" },
    ];
    const scopes: { v: Scope; label: string; n: number }[] = [
      { v: "studied", label: "学習済み", n: studiedWords.length },
      { v: "due", label: "今日の復習", n: dueCount },
      { v: "general", label: "一般語彙", n: WORDS_GENERAL.length },
      { v: "capoeira", label: "カポエイラ", n: WORDS_CAPOEIRA.length },
      { v: "music", label: "🎵 曲の単語", n: musicWords.length },
    ];
    return (
      <div className="animate-fade-in space-y-5">
        <h1 className="text-xl font-bold text-brand-ink">クイズ</h1>

        <section>
          <h2 className="mb-2 px-1 text-sm font-bold text-slate-500">出題モード</h2>
          <div className="space-y-2">
            {modes.map((m) => (
              <button
                key={m.v}
                onClick={() => setMode(m.v)}
                className={`card flex w-full items-center gap-3 p-3 text-left transition ${
                  mode === m.v ? "ring-2 ring-brand-green" : ""
                }`}
              >
                <span className="font-bold text-brand-ink">{m.label}</span>
                <span className="text-xs text-slate-500">{m.desc}</span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-2 px-1 text-sm font-bold text-slate-500">出題範囲</h2>
          <div className="grid grid-cols-2 gap-2">
            {scopes.map((s) => (
              <button
                key={s.v}
                onClick={() => setScope(s.v)}
                disabled={(s.v === "due" || s.v === "studied" || s.v === "music") && s.n < 1}
                className={`card flex flex-col items-center p-3 transition disabled:opacity-40 ${
                  scope === s.v ? "ring-2 ring-brand-green" : ""
                }`}
              >
                <span className="text-sm font-bold text-brand-ink">{s.label}</span>
                <span className="text-xs text-slate-400">{s.n}語</span>
              </button>
            ))}
          </div>
          {scope === "studied" && studiedWords.length < 1 && (
            <p className="mt-2 text-xs text-slate-400">まだ学習した単語がありません。単語帳で学習を始めましょう。</p>
          )}
        </section>

        <button onClick={start} className="btn-primary w-full py-3 text-base">
          10問スタート
        </button>
      </div>
    );
  }

  // ---------- result ----------
  if (phase === "result") {
    // 解答済みの問題だけを集計する（「中断」したときは途中まで）
    const answered = questions.map((q, i) => ({ q, i })).filter(({ i }) => selected[i] != null);
    const total = answered.length;
    const correct = answered.filter(({ q, i }) => selected[i] === q.answer).length;
    const count = (...kinds: QuizEffect[]) => answered.filter(({ i }) => kinds.includes(effects[i]!)).length;
    const nReviewed = count("reviewed", "lapsed");
    const nUnchanged = count("unchanged");
    const nUntracked = count("untracked");
    // 未学習（カード無し）で間違えた語 → 「今日の学習」の新規枠へ優先して入れられる
    const wrongNew = [
      ...new Set(
        answered
          .filter(({ q, i }) => effects[i] === "untracked" && selected[i] !== q.answer && !cards[q.word.id])
          .map(({ q }) => q.word.id)
      ),
    ];
    const toPin = wrongNew.filter((id) => !pinnedNew.includes(id));
    const newRemaining = Math.max(0, dailyNewLimit - daily.newIntroduced);
    return (
      <div className="animate-fade-in space-y-4">
        <div className="card bg-gradient-to-br from-brand-blue to-indigo-600 p-6 text-center text-white">
          <div className="text-sm opacity-90">結果</div>
          <div className="my-1 text-5xl font-extrabold">
            {correct}/{total}
          </div>
          <div className="text-sm opacity-90">正答率 {total ? Math.round((correct / total) * 100) : 0}%</div>
          {total < questions.length && (
            <div className="mt-1 text-xs opacity-80">
              {questions.length}問中 {total}問で中断
            </div>
          )}
        </div>

        {/* SRS への反映の内訳 */}
        <div className="card space-y-1 p-4">
          <div className="text-sm font-bold text-brand-ink">
            SRSに反映: 復習 {nReviewed} ／ 変更なし {nUnchanged} ／ 未学習 {nUntracked}
          </div>
          <p className="text-xs text-slate-500">
            復習日が来た語だけを予定に反映します。今日すでに評価した語と復習日前の正解は予定を変えず、未学習の語は4択の正解だけでは記録しません。
          </p>
        </div>

        {wrongNew.length > 0 && (
          <div className="card space-y-2 p-4">
            <div className="text-sm text-brand-ink">
              未学習で間違えた語が <span className="font-bold">{wrongNew.length}語</span> あります。
            </div>
            <p className="text-xs text-slate-500">
              「今日の学習」の新しい語の枠で優先して出題します。
              {newRemaining <= 0 && "今日の新しい語の枠は使い切っているため、次の枠（明日）で先に出ます。"}
            </p>
            {toPin.length > 0 ? (
              <button onClick={() => pinNew(toPin)} className="btn-primary w-full py-3">
                今日の学習に追加（{toPin.length}語）
              </button>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold text-brand-green">✓ 今日の学習に追加しました</span>
                {newRemaining > 0 && (
                  <Link to="/flashcards/today" className="text-sm font-bold text-brand-green">
                    今日の学習へ ›
                  </Link>
                )}
              </div>
            )}
          </div>
        )}

        <h2 className="px-1 text-sm font-bold text-slate-500">復習</h2>
        <div className="space-y-2">
          {answered.map(({ q, i }) => {
            const ok = selected[i] === q.answer;
            const eff = effects[i] ? EFFECT_LABEL[effects[i]!] : null;
            return (
              <div key={i} className={`card flex items-center gap-3 p-3 ${ok ? "" : "ring-1 ring-rose-200"}`}>
                <span className={`text-lg ${ok ? "text-emerald-500" : "text-rose-500"}`}>{ok ? "○" : "×"}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-bold text-brand-ink">{q.word.pt}</span>
                    {eff && <span className={`chip ${eff.cls}`}>{eff.label}</span>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {q.word.ja}
                    {!ok && selected[i] != null && (
                      <span className="text-rose-500"> ／ 誤答: {mode === "ja2pt" ? q.choices[selected[i]!].pt : q.choices[selected[i]!].ja}</span>
                    )}
                  </div>
                </div>
                <SpeakerButton text={q.word.ptForSpeech} />
              </div>
            );
          })}
        </div>

        <div className="flex gap-2">
          <button onClick={() => setPhase("setup")} className="btn-ghost flex-1 py-3">
            モード選択へ
          </button>
          <button onClick={start} className="btn-primary flex-1 py-3">
            もう一度
          </button>
        </div>
      </div>
    );
  }

  // ---------- playing ----------
  const q = questions[idx];
  const sel = selected[idx];
  const answered = sel != null;

  return (
    <div className="animate-fade-in space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={quit} className="text-sm text-brand-green">‹ 中断</button>
        <div className="text-sm font-bold text-slate-500">
          {idx + 1} / {questions.length}
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-brand-green transition-all" style={{ width: `${((idx + 1) / questions.length) * 100}%` }} />
      </div>

      {/* 問題 */}
      <div className="card flex min-h-[140px] flex-col items-center justify-center gap-2 p-6 text-center">
        {mode === "listen" ? (
          <>
            <SpeakerButton text={q.word.ptForSpeech} size={40} />
            <div className="text-xs text-slate-400">音声をタップして再生</div>
          </>
        ) : mode === "pt2ja" ? (
          <>
            <div className="text-2xl font-extrabold text-brand-ink">{q.word.pt}</div>
            <SpeakerButton text={q.word.ptForSpeech} />
          </>
        ) : (
          <div className="text-2xl font-extrabold text-brand-ink">{q.word.ja}</div>
        )}
      </div>

      {/* 選択肢 */}
      <div className="grid grid-cols-1 gap-2">
        {q.choices.map((c, i) => {
          const isAnswer = i === q.answer;
          const isSelected = sel === i;
          let cls = "card p-3 text-left font-medium transition";
          if (answered) {
            if (isAnswer) cls += " ring-2 ring-emerald-400 bg-emerald-50";
            else if (isSelected) cls += " ring-2 ring-rose-400 bg-rose-50";
            else cls += " opacity-60";
          } else {
            cls += " hover:ring-brand-green/40 active:scale-[0.99]";
          }
          return (
            <button key={c.id} onClick={() => choose(i)} disabled={answered} className={cls}>
              {mode === "ja2pt" ? c.pt : c.ja}
            </button>
          );
        })}
      </div>

      {answered && (
        <button onClick={nextQuestion} className="btn-primary w-full py-3">
          {idx < questions.length - 1 ? "次へ" : "結果を見る"}
        </button>
      )}
    </div>
  );
}
