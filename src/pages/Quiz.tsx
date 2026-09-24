import { useEffect, useMemo, useState } from "react";
import { WORDS_CAPOEIRA, WORDS_GENERAL, ALL_WORDS, resolveWord, reviewPool } from "../data/loadWords";
import type { Word } from "../data/types";
import { useProgress } from "../store/useProgress";
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

export default function Quiz() {
  const cards = useProgress((s) => s.cards);
  const rate = useProgress((s) => s.rate);
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
    setIdx(0);
    setPhase("playing");
  }

  // リスニング問題は表示時に自動再生
  useEffect(() => {
    if (phase === "playing" && mode === "listen" && questions[idx]) {
      audio.speak(questions[idx].word.ptForSpeech, { rate: settingsRate, voiceURI });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, idx, mode]);

  function choose(choiceIdx: number) {
    if (selected[idx] != null) return;
    const next = [...selected];
    next[idx] = choiceIdx;
    setSelected(next);
  }

  function nextQuestion() {
    if (idx < questions.length - 1) setIdx(idx + 1);
    else {
      // SRSへ反映
      questions.forEach((q, i) => {
        const ok = selected[i] === q.answer;
        rate(q.word.id, ok ? "good" : "again");
      });
      setPhase("result");
    }
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
    const correct = questions.filter((q, i) => selected[i] === q.answer).length;
    return (
      <div className="animate-fade-in space-y-4">
        <div className="card bg-gradient-to-br from-brand-blue to-indigo-600 p-6 text-center text-white">
          <div className="text-sm opacity-90">結果</div>
          <div className="my-1 text-5xl font-extrabold">
            {correct}/{questions.length}
          </div>
          <div className="text-sm opacity-90">正答率 {Math.round((correct / questions.length) * 100)}%</div>
        </div>

        <h2 className="px-1 text-sm font-bold text-slate-500">復習</h2>
        <div className="space-y-2">
          {questions.map((q, i) => {
            const ok = selected[i] === q.answer;
            return (
              <div key={i} className={`card flex items-center gap-3 p-3 ${ok ? "" : "ring-1 ring-rose-200"}`}>
                <span className={`text-lg ${ok ? "text-emerald-500" : "text-rose-500"}`}>{ok ? "○" : "×"}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-brand-ink">{q.word.pt}</div>
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
        <button onClick={() => setPhase("setup")} className="text-sm text-brand-green">‹ 中断</button>
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
