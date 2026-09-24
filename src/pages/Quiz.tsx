import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import {
  ALL_WORDS,
  WORDS_CAPOEIRA,
  WORDS_GENERAL,
  deckTitle,
  getExtra,
  resolveDeckWords,
  resolveWord,
  reviewPool,
} from "../data/loadWords";
import { SONG_BY_ID } from "../data/music";
import { ALIAS_KEEP, aliasPeerCarded } from "../data/siblings";
import type { Rating, Word } from "../data/types";
import { todayCounters, useProgress } from "../store/useProgress";
import type { QuizEffect } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { useAddedIds, useMusic, useUserWordMap } from "../store/useMusic";
import { pickForQuiz, reviewDueWords, weakWords } from "../srs/queue";
import { audio } from "../services/audio";
import { askableByJa, pickDistractors, type ChoiceSide } from "../services/quizChoices";
import {
  HINT_MAX,
  gradeWord,
  hintText,
  ratingForGrade,
  ratingForOverride,
  type DiffSeg,
  type GradeResult,
} from "../services/grade";
import { isKnownForm, isOwnAnswer, quizAnswers } from "../services/gradeLexicon";
import { useToday } from "../hooks/useToday";
import { useTodayPlan } from "../hooks/useTodayPlan";
import SpeakerButton from "../components/SpeakerButton";
import PtInput from "../components/PtInput";

/**
 * 出題モード。
 * 4択: pt2ja（葡→和）、ja2pt（和→葡）、listen（音声→和）
 * 入力式: ja2pt_type（和訳を見てつづりを打つ）、listen_type（音声を聴いてつづりを打つ）
 */
type Mode = "pt2ja" | "ja2pt" | "listen" | "ja2pt_type" | "listen_type";
/**
 * 出題範囲。weak = 苦手（何度か間違えた・覚えにくい語）、deck = /quiz/:deckId のデッキ
 */
type Scope = "deck" | "studied" | "due" | "weak" | "general" | "capoeira" | "music";

/** 問題数の選択肢 */
const COUNTS = [5, 10, 20] as const;
const DEFAULT_COUNT = 10;

/**
 * pickForQuiz（期限到来 → 延滞比 → ease の低い順 → 最近 again）で選ぶ範囲。
 * 一般語彙・カポエイラは未学習の語が大半の「力試し」の範囲なので、これまでどおり無作為に選ぶ
 * （未学習で間違えた語を「今日の学習に追加」できる）。
 */
const RANKED_SCOPES: readonly Scope[] = ["deck", "studied", "due", "weak", "music"];

interface Question {
  word: Word;
  /** 4択の選択肢（入力式では空） */
  choices: Word[];
  answer: number; // choices内の正解index（入力式では -1）
}

/** 入力式の1問の解答 */
interface TypedAnswer {
  /** 入力した答え（「わからない」のときは途中まで打っていた文字） */
  input: string;
  /** 採点結果（「わからない」は null） */
  result: GradeResult | null;
  /** 使ったヒントの段階（0〜HINT_MAX） */
  hints: number;
  /** SRS に渡す評価（「正解にする」で上書きした後の値。もう一度のラウンドでは記録しない） */
  rating: Rating;
  /** 「正解にする」で上書きしたか */
  overridden: boolean;
}

/** 1ラウンド分の出題と解答（最初のラウンドは「もう一度」の間も結果を残す） */
interface Round {
  questions: Question[];
  selected: (number | null)[];
  typed: (TypedAnswer | null)[];
  effects: (QuizEffect | null)[];
}

/** リスニングの「ゆっくり」の速さ */
const SLOW_RATE = 0.6;

function shuffle<T>(arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 入力式（つづりを打つ）モードか */
function isTyped(mode: Mode): boolean {
  return mode === "ja2pt_type" || mode === "listen_type";
}

/** 音声で出題するモードか */
function isListen(mode: Mode): boolean {
  return mode === "listen" || mode === "listen_type";
}

/** 選択肢に出す面（和→葡は葡語、それ以外は訳） */
function choiceSide(mode: Mode): ChoiceSide {
  return mode === "ja2pt" ? "pt" : "ja";
}

/** そのモードで出題できる語（和→葡では固有名詞を出さない: 訳が読みだけで答えが見えるため） */
function askable(mode: Mode, words: Word[]): Word[] {
  return mode === "ja2pt" || mode === "ja2pt_type" ? words.filter(askableByJa) : words;
}

/**
 * 問題を作る（words の順に出題する）。誤答は services/quizChoices.pickDistractors（同品詞×同カテゴリから優先し、
 * 和訳の片が重なる語・同じ綴りの語・別名を除く。足りなければ条件を緩める）。入力式は選択肢を作らない。
 */
function buildQuestions(words: readonly Word[], distractorPool: Word[], mode: Mode): Question[] {
  if (isTyped(mode)) return words.map((word) => ({ word, choices: [], answer: -1 }));
  const side = choiceSide(mode);
  return words.map((word) => {
    const distractors = pickDistractors(word, distractorPool, side);
    const choices = shuffle([word, ...distractors]);
    return { word, choices, answer: choices.findIndex((c) => c.id === word.id) };
  });
}

/** 解答したか */
function isAnswered(r: Pick<Round, "selected" | "typed">, i: number): boolean {
  return r.selected[i] != null || r.typed[i] != null;
}

/** 正解として数えるか（入力式は again 以外 = 惜しい・ヒントあり・正解にした を含む） */
function isCorrect(r: Pick<Round, "questions" | "selected" | "typed">, i: number): boolean {
  const t = r.typed[i];
  return t ? t.rating !== "again" : r.selected[i] === r.questions[i]?.answer;
}

/** 入力式の判定の見出し */
function typedVerdict(t: TypedAnswer): { label: string; cls: string } {
  if (t.overridden) return { label: "正解にしました", cls: "text-emerald-600" };
  if (!t.result) return { label: "わからない", cls: "text-slate-500" };
  switch (t.result.grade) {
    case "exact":
      return { label: t.hints ? "正解（ヒントあり）" : "正解！", cls: "text-emerald-600" };
    case "accent":
      return { label: "惜しい！アクセント記号", cls: "text-amber-600" };
    case "typo":
      return { label: "惜しい！つづり", cls: "text-amber-600" };
    case "wrong":
      return { label: "不正解", cls: "text-rose-600" };
  }
}

/** 結果画面の ○△× （入力式の △ は「難しい」で記録した問題: 惜しい・ヒントあり） */
function markOf(ok: boolean, t: TypedAnswer | null): { mark: string; cls: string } {
  if (t?.rating === "hard") return { mark: "△", cls: "text-amber-500" };
  return ok ? { mark: "○", cls: "text-emerald-500" } : { mark: "×", cls: "text-rose-500" };
}

/** ボタンを押してもフォーカス（スマホのキーボード）を入力欄に残す（pointerdown/mousedown の既定動作を止める） */
const keepFocus = (e: React.SyntheticEvent) => e.preventDefault();

/** 空白の差分は見えないので記号にする */
const showSpaces = (s: string) => s.replace(/ /g, "␣");

/** 入力と正解の文字差分（赤の取り消し線 = 余分な文字、緑 = 足りない文字） */
function DiffView({ diff }: { diff: DiffSeg[] }) {
  return (
    <div className="break-all font-mono text-lg tracking-wide text-brand-ink">
      {diff.map((d, i) =>
        d.kind === "same" ? (
          <span key={i}>{d.text}</span>
        ) : d.kind === "del" ? (
          <del key={i} className="rounded bg-rose-100 text-rose-600">
            {showSpaces(d.text)}
          </del>
        ) : (
          <ins key={i} className="rounded bg-emerald-100 font-bold text-emerald-700 no-underline">
            {showSpaces(d.text)}
          </ins>
        )
      )}
    </div>
  );
}

/**
 * 解答カード: 正解の綴り・カナ・音声・意味・例文1件・解説（カポエイラ語）。
 * 4択で誤答を選んだときは、選んだ語の綴りと意味も並べる。リスニングでは、ここで初めて綴りを見せる。
 */
function AnswerCard({ word, chosen }: { word: Word; chosen?: Word | null }) {
  const ex = useMemo(() => getExtra(word)?.examples?.[0], [word]);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-slate-400">正解</div>
          <div className="break-words text-xl font-extrabold text-brand-ink">{word.pt}</div>
          <div className="text-xs text-slate-500">{word.kana}</div>
          <div className="mt-1 text-sm text-slate-600">{word.ja}</div>
        </div>
        <SpeakerButton text={word.ptForSpeech} />
      </div>
      {chosen && (
        <div className="flex items-center gap-2 rounded-lg bg-rose-50 p-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-slate-400">選んだ答え</div>
            <div className="break-words font-bold text-brand-ink">{chosen.pt}</div>
            <div className="text-sm text-slate-600">＝ {chosen.ja}</div>
          </div>
          <SpeakerButton text={chosen.ptForSpeech} size={18} />
        </div>
      )}
      {ex && (
        <div className="flex items-start gap-2 rounded-lg bg-slate-50 p-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-slate-400">例文</div>
            <div className="font-medium text-brand-ink">{ex.pt}</div>
            {ex.kana && <div className="text-[11px] text-slate-400">{ex.kana}</div>}
            <div className="text-sm text-slate-500">{ex.ja}</div>
          </div>
          <SpeakerButton text={ex.pt} size={18} />
        </div>
      )}
      {word.note && (
        <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
          <span className="font-bold text-slate-400">解説 </span>
          {word.note}
        </div>
      )}
    </div>
  );
}

/** 結果画面の各行に出す「SRS への反映」ラベル */
const EFFECT_LABEL: Record<QuizEffect, { label: string; cls: string }> = {
  reviewed: { label: "反映", cls: "bg-emerald-50 text-emerald-700" },
  lapsed: { label: "反映・再学習", cls: "bg-rose-50 text-rose-600" },
  unchanged: { label: "変更なし", cls: "bg-slate-100 text-slate-500" },
  untracked: { label: "未学習", cls: "bg-amber-50 text-amber-700" },
};

/** 「今日の学習に追加」の説明（復習が溜まっている日は、新しい語そのものを休んでいる） */
function PinNotice({ newRemaining, pinned }: { newRemaining: number; pinned: boolean }) {
  const plan = useTodayPlan();
  const backlog = plan.reason === "backlog";
  return (
    <>
      <p className="text-xs text-slate-500">
        「今日の学習」の新しい語の枠で優先して出題します。
        {backlog
          ? "ただし今は復習が溜まっていて新しい語をお休みしているため、復習が1日の上限に収まった日から先に出ます。"
          : newRemaining <= 0 && "今日の新しい語の枠は使い切っているため、次の枠（明日）で先に出ます。"}
      </p>
      {pinned && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-bold text-brand-green">✓ 今日の学習に追加しました</span>
          {newRemaining > 0 && !backlog && (
            <Link to="/flashcards/today" className="text-sm font-bold text-brand-green">
              今日の学習へ ›
            </Link>
          )}
        </div>
      )}
    </>
  );
}

/** /quiz と /quiz/:deckId。デッキが見つからなければ /quiz へ */
export default function Quiz() {
  const { deckId } = useParams();
  const addedWords = useMusic((s) => s.addedWords);
  const userMap = useUserWordMap();
  const deckWords = useMemo(
    () => (deckId === undefined ? null : resolveDeckWords(deckId, addedWords, userMap)),
    [deckId, addedWords, userMap]
  );
  if (deckId !== undefined && !deckWords) return <Navigate to="/quiz" replace />;
  // デッキが変わったら出題設定から作り直す
  return <QuizRunner key={deckId ?? ""} deckId={deckId ?? null} deckWords={deckWords} />;
}

function QuizRunner({ deckId, deckWords }: { deckId: string | null; deckWords: Word[] | null }) {
  const today = useToday();
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
  const dueWordsNow = useMemo(() => reviewDueWords(pool, cards, today), [pool, cards, today]);
  const weakNow = useMemo(() => weakWords(pool, cards), [pool, cards]);
  const title = deckId !== null ? deckTitle(deckId, (id) => SONG_BY_ID.get(id)?.title) : null;

  const [phase, setPhase] = useState<"setup" | "playing" | "result">("setup");
  const [mode, setMode] = useState<Mode>("pt2ja");
  // 既定: デッキから来たらそのデッキ。それ以外は「学習済み」。ただし学習語が少ない初回は「一般語彙」
  const [scope, setScope] = useState<Scope>(() =>
    deckWords && deckWords.length > 0 ? "deck" : studiedWords.length >= 4 ? "studied" : "general"
  );
  const [count, setCount] = useState<number>(DEFAULT_COUNT);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState<(number | null)[]>([]);
  // 入力式の解答（未解答は null）
  const [typed, setTyped] = useState<(TypedAnswer | null)[]>([]);
  // 入力式: いま打っている答えと、使ったヒントの段階
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState(0);
  // 1問ごとの SRS への反映結果（未解答・反映待ち・もう一度のラウンドは null）
  const [effects, setEffects] = useState<(QuizEffect | null)[]>([]);
  // 0 = 最初のラウンド（SRS に反映する）、1 以上 = 「間違えた問題をもう一度」（SRS には書かない）
  const [round, setRound] = useState(0);
  // もう一度のラウンドの間、最初のラウンドの結果を残しておく（「最初の結果に戻る」）
  const [main, setMain] = useState<Round | null>(null);
  // rateQuiz は同じ語に2回呼ぶと練習量を二重に数えるので、連打でも1問1回に限る
  const answeredRef = useRef<Set<number>>(new Set());
  // 入力式: 採点したがまだ SRS に書いていない評価。「正解にする」で変えられる間だけ保留し、
  // 次へ進む・中断・画面を離れる・アプリを裏に回す、のどれかで反映する（反映は1問1回。最初のラウンドだけ）
  const pendingRef = useRef<{ i: number; id: string; rating: Rating } | null>(null);

  const isRetry = round > 0;
  const current: Round = { questions, selected, typed, effects };

  const recordEffect = useCallback((i: number, effect: QuizEffect) => {
    setEffects((prev) => {
      const next = [...prev];
      next[i] = effect;
      return next;
    });
  }, []);

  /** 保留中の評価を SRS に反映する（反映したら、その問題の番号と結果を返す） */
  const commitPending = useCallback((): { i: number; effect: QuizEffect } | null => {
    const p = pendingRef.current;
    if (!p) return null;
    pendingRef.current = null;
    const effect = useProgress.getState().rateQuiz(p.id, p.rating);
    recordEffect(p.i, effect);
    return { i: p.i, effect };
  }, [recordEffect]);

  // 反映待ちのまま画面を離れても答えた分は残す（Android はアプリを裏に回したまま終了されることがある）
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") commitPending();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const onPageHide = () => {
      commitPending();
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      commitPending();
    };
  }, [commitPending]);

  /** リスニング問題の読み上げ。自動再生の制限を避けるため、必ずクリック処理の中から呼ぶ */
  function speakQuestion(q: Question | undefined, rate = settingsRate) {
    if (!isListen(mode) || !q) return;
    void audio.speak(q.word.ptForSpeech, { rate, voiceURI });
  }

  /** もう一度のラウンドで解答したとき: SRS には書かず、練習の記録（学習ログ）だけ残す */
  function logRetry() {
    useProgress.getState().logActivity("quiz", 1);
  }

  /** 出題範囲の語（そのモードで出題できる語だけ） */
  function scopeWords(s: Scope): Word[] {
    switch (s) {
      case "deck":
        return deckWords ?? [];
      case "studied":
        return studiedWords;
      case "due":
        return dueWordsNow;
      case "weak":
        return weakNow;
      case "music":
        return musicWords;
      case "capoeira":
        return WORDS_CAPOEIRA;
      case "general":
        return WORDS_GENERAL;
    }
  }

  /** 出題語が0語のとき全語から出すか（まだ学習した語が無い「学習済み」だけ） */
  function fallbackToAll(s: Scope): boolean {
    return s === "studied" && studiedWords.length < 1;
  }

  /** ラウンドを始める（問題と解答の状態を入れ替える） */
  function beginRound(qs: Question[], nextRound: number) {
    setQuestions(qs);
    setSelected(new Array(qs.length).fill(null));
    setTyped(new Array(qs.length).fill(null));
    setEffects(new Array(qs.length).fill(null));
    answeredRef.current = new Set();
    setRound(nextRound);
    setDraft("");
    setHint(0);
    setIdx(0);
    setPhase("playing");
    // リスニングの1問目は、開始のタップの中で読み上げる
    speakQuestion(qs[0]);
  }

  function start() {
    commitPending();
    // 和→葡では固有名詞を出題しない
    let words = askable(mode, scopeWords(scope));
    let picked: Word[];
    if (words.length === 0) {
      // 全語へのフォールバックは、まだ学習した語が無い「学習済み」のときだけ（誤答候補は常に全語から取るため、
      // 学習済みが少数でも「学習した語のみ」を出題できる）。
      // ほかの範囲（固有名詞だけのデッキを和→葡で、復習を終えた「今日の復習」など）は、黙って別の語を出さずに
      // 出題設定へ戻す（そこでは理由を表示し、スタートを無効にしている。結果画面の「新しい問題で」から来たとき用）
      if (!fallbackToAll(scope)) {
        setPhase("setup");
        return;
      }
      words = askable(mode, ALL_WORDS);
      picked = shuffle(words).slice(0, count);
    } else if (RANKED_SCOPES.includes(scope)) {
      picked = pickForQuiz(words, cards, count, today);
    } else {
      picked = shuffle(words).slice(0, count);
    }
    setMain(null);
    beginRound(buildQuestions(picked, ALL_WORDS, mode), 0);
  }

  /** 「間違えた n問をもう一度」: 今のラウンドで間違えた語だけを出し直す（SRS には書かない） */
  function startRetry() {
    // （結果画面では反映待ちは無いはずだが、残っていれば反映してから最初のラウンドの結果に含める）
    const c = commitPending();
    const snap: Round = c ? { ...current, effects: current.effects.map((e, i) => (i === c.i ? c.effect : e)) } : current;
    const wrong = questions.filter((_, i) => isAnswered(snap, i) && !isCorrect(snap, i)).map((q) => q.word);
    if (wrong.length === 0) return;
    if (!isRetry) setMain(snap);
    // 4択は誤答を選び直す（同じ選択肢の消去法で当てないように）
    beginRound(buildQuestions(shuffle(wrong), ALL_WORDS, mode), round + 1);
  }

  /** 最初のラウンドの結果に戻る */
  function backToMain() {
    if (!main) return;
    setQuestions(main.questions);
    setSelected(main.selected);
    setTyped(main.typed);
    setEffects(main.effects);
    answeredRef.current = new Set();
    setRound(0);
    setMain(null);
    setPhase("result");
  }

  /** 解答したその場で SRS に反映する（途中で離れても答えた分は残る）。もう一度のラウンドでは反映しない */
  function choose(choiceIdx: number) {
    const q = questions[idx];
    if (!q || selected[idx] != null || answeredRef.current.has(idx)) return;
    answeredRef.current.add(idx);
    const i = idx;
    setSelected((prev) => {
      const next = [...prev];
      next[i] = choiceIdx;
      return next;
    });
    if (isRetry) {
      logRetry();
      return;
    }
    // 未学習語・今日評価済み・期限前の正解は SRS に書かない（判定は useProgress.rateQuiz / quizDecision）
    recordEffect(i, rateQuiz(q.word.id, choiceIdx === q.answer ? "good" : "again"));
  }

  function setTypedAt(i: number, t: TypedAnswer) {
    setTyped((prev) => {
      const next = [...prev];
      next[i] = t;
      return next;
    });
  }

  /**
   * 入力式の答え合わせ。評価は ratingForGrade（exact→good、ヒントありなら hard、accent/typo→hard、wrong→again）。
   * 「正解にする」で評価が変わりうるとき（不正解・ヒントなしの惜しい）は反映を保留する。それ以外はその場で反映。
   * もう一度のラウンドでは反映も保留もしない。
   */
  function submitTyped() {
    const q = questions[idx];
    const input = draft.trim();
    if (!q || !input || typed[idx] || answeredRef.current.has(idx)) return;
    answeredRef.current.add(idx);
    // 正解の集合: 見出しの表記（と読み上げの形）。和→葡では和訳が同じ別見出しも正解
    const result = gradeWord(input, quizAnswers(q.word, mode === "ja2pt_type"), { isKnownForm });
    const usedHint = hint > 0;
    const rating = ratingForGrade(result.grade, usedHint);
    setTypedAt(idx, { input, result, hints: hint, rating, overridden: false });
    if (isRetry) logRetry();
    else if (ratingForOverride(usedHint) !== rating) pendingRef.current = { i: idx, id: q.word.id, rating };
    else recordEffect(idx, rateQuiz(q.word.id, rating));
  }

  /** 「わからない」: again で反映して正解を見せる（もう一度のラウンドでは反映しない） */
  function giveUp() {
    const q = questions[idx];
    if (!q || typed[idx] || answeredRef.current.has(idx)) return;
    answeredRef.current.add(idx);
    setTypedAt(idx, { input: draft.trim(), result: null, hints: hint, rating: "again", overridden: false });
    if (isRetry) logRetry();
    else recordEffect(idx, rateQuiz(q.word.id, "again"));
  }

  /** 「正解にする」: 評価を good（ヒントを使ったら hard）に変える。最初のラウンドは保留中の評価を反映する */
  function markCorrect() {
    const t = typed[idx];
    if (!t || t.overridden) return;
    const rating = ratingForOverride(t.hints > 0);
    if (isRetry) {
      if (t.result && rating !== t.rating) setTypedAt(idx, { ...t, rating, overridden: true });
      return;
    }
    const p = pendingRef.current;
    if (!p || p.i !== idx) return;
    pendingRef.current = null;
    setTypedAt(idx, { ...t, rating, overridden: true });
    recordEffect(idx, rateQuiz(p.id, rating));
  }

  function showHint() {
    setHint((h) => Math.min(HINT_MAX, h + 1));
  }

  function nextQuestion() {
    commitPending();
    setDraft("");
    setHint(0);
    if (idx < questions.length - 1) {
      setIdx(idx + 1);
      speakQuestion(questions[idx + 1]);
    } else {
      setPhase("result");
    }
  }

  /**
   * 中断: 1問でも答えていれば結果画面へ（反映済みの結果を見せる）、未解答なら出題設定へ。
   * もう一度のラウンドを1問も答えずに中断したら、最初のラウンドの結果に戻る。
   */
  function quit() {
    commitPending();
    audio.cancel();
    const any = selected.some((s) => s != null) || typed.some((t) => t != null);
    if (any) setPhase("result");
    else if (isRetry && main) backToMain();
    else setPhase("setup");
  }

  // ---------- setup ----------
  if (phase === "setup") {
    const modes: { v: Mode; label: string; desc: string }[] = [
      { v: "pt2ja", label: "葡 → 和", desc: "単語を見て意味を選ぶ" },
      { v: "ja2pt", label: "和 → 葡", desc: "意味を見て葡語を選ぶ" },
      { v: "listen", label: "リスニング", desc: "音声を聴いて意味を選ぶ" },
      { v: "ja2pt_type", label: "和 → 葡（入力）", desc: "意味を見てつづりを打つ" },
      { v: "listen_type", label: "書き取り（入力）", desc: "音声を聴いてつづりを打つ" },
    ];
    // 語数はそのモードで出題できる語の数（和→葡は固有名詞を除く）
    const nAsk = (ws: Word[]) => askable(mode, ws).length;
    const scopes: { v: Scope; label: string; n: number }[] = [
      ...(deckWords ? [{ v: "deck" as const, label: "このデッキ", n: nAsk(deckWords) }] : []),
      { v: "studied", label: "学習済み", n: nAsk(studiedWords) },
      { v: "due", label: "今日の復習", n: nAsk(dueWordsNow) },
      { v: "weak", label: "苦手", n: nAsk(weakNow) },
      { v: "general", label: "一般語彙", n: nAsk(WORDS_GENERAL) },
      { v: "capoeira", label: "カポエイラ", n: nAsk(WORDS_CAPOEIRA) },
      { v: "music", label: "🎵 曲の単語", n: nAsk(musicWords) },
    ];
    const needsWords: readonly Scope[] = ["deck", "due", "studied", "weak", "music"];
    // 選んでいる範囲がこのモードでは0語（固有名詞だけのデッキを和→葡で、復習を終えた「今日の復習」など）→ 始められない
    const scopeN = scopes.find((s) => s.v === scope)?.n ?? 0;
    const scopeEmpty = scopeN < 1 && !fallbackToAll(scope);
    return (
      <div className="animate-fade-in space-y-5">
        {deckId !== null && (
          <Link to={`/flashcards/${deckId}`} className="inline-flex min-h-11 items-center pr-2 text-sm text-brand-green">
            ‹ 単語帳に戻る
          </Link>
        )}
        <div>
          <h1 className="text-xl font-bold text-brand-ink">クイズ</h1>
          {title && <p className="text-sm text-slate-500">デッキ: {title}</p>}
        </div>

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
          {isTyped(mode) && (
            <p className="mt-2 px-1 text-xs text-slate-500">
              アクセント記号の違いやつづりの小さな誤りは「惜しい」（評価は「難しい」）。ヒントを使うと、正解でも「難しい」として記録します。
            </p>
          )}
        </section>

        <section>
          <h2 className="mb-2 px-1 text-sm font-bold text-slate-500">出題範囲</h2>
          <div className="grid grid-cols-2 gap-2">
            {scopes.map((s) => (
              <button
                key={s.v}
                onClick={() => setScope(s.v)}
                disabled={needsWords.includes(s.v) && s.n < 1}
                className={`card flex flex-col items-center p-3 transition disabled:opacity-40 ${
                  scope === s.v ? "ring-2 ring-brand-green" : ""
                } ${s.v === "deck" ? "col-span-2" : ""}`}
              >
                <span className="text-sm font-bold text-brand-ink">{s.label}</span>
                <span className="text-xs text-slate-400">{s.n}語</span>
              </button>
            ))}
          </div>
          {scope === "studied" && studiedWords.length < 1 && (
            <p className="mt-2 text-xs text-slate-400">まだ学習した単語がありません。単語帳で学習を始めましょう。</p>
          )}
          {scopeEmpty && (
            <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {scopeWords(scope).length > 0
                ? "この範囲には、このモードで出題できる語がありません（和→葡では固有名詞を出しません）。モードか範囲を選び直してください。"
                : "この範囲には出題できる語がありません。範囲を選び直してください。"}
            </p>
          )}
          {scope === "weak" && (
            <p className="mt-2 px-1 text-xs text-slate-400">
              何度か間違えた語・覚えにくい語です（少ないときは、1回でも間違えた語まで広げます）。
            </p>
          )}
          {RANKED_SCOPES.includes(scope) && (
            <p className="mt-2 px-1 text-xs text-slate-400">
              復習日が来た語 → 忘れかけている語 → 苦手な語 の順に選びます。
            </p>
          )}
        </section>

        <section>
          <h2 className="mb-2 px-1 text-sm font-bold text-slate-500">問題数</h2>
          <div className="flex gap-2" role="group" aria-label="問題数">
            {COUNTS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setCount(n)}
                aria-pressed={count === n}
                className={`card min-h-11 flex-1 py-2 text-sm font-bold transition ${
                  count === n ? "text-brand-ink ring-2 ring-brand-green" : "text-slate-500"
                }`}
              >
                {n}問
              </button>
            ))}
          </div>
        </section>

        <button onClick={start} disabled={scopeEmpty} className="btn-primary w-full py-3 text-base">
          {count}問スタート
        </button>
      </div>
    );
  }

  // ---------- result ----------
  if (phase === "result") {
    // 解答済みの問題だけを集計する（「中断」したときは途中まで）
    const answered = questions.map((q, i) => ({ q, i })).filter(({ i }) => isAnswered(current, i));
    const isOk = (i: number) => isCorrect(current, i);
    const total = answered.length;
    const correct = answered.filter(({ i }) => isOk(i)).length;
    const wrongCount = total - correct;
    const nPartial = answered.filter(({ i }) => typed[i]?.rating === "hard").length;
    const countEff = (...kinds: QuizEffect[]) => answered.filter(({ i }) => kinds.includes(effects[i]!)).length;
    const nReviewed = countEff("reviewed", "lapsed");
    const nUnchanged = countEff("unchanged");
    const nUntracked = countEff("untracked");
    // 未学習（カード無し）で間違えた語 → 「今日の学習」の新規枠へ優先して入れられる（最初のラウンドだけ）。
    // 別名（word-aliases.json の alias 側）は keep 側を入れる。keep/alias のどれかにカードがあれば学習中なので入れない
    const hasCard = (id: string) => !!cards[id];
    const wrongNew = isRetry
      ? []
      : [
          ...new Set(
            answered
              .filter(({ q, i }) => effects[i] === "untracked" && !isOk(i) && !cards[q.word.id])
              .map(({ q }) => ALIAS_KEEP.get(q.word.id) ?? q.word.id)
              .filter((id) => !hasCard(id) && !aliasPeerCarded(id, hasCard))
          ),
        ];
    const toPin = wrongNew.filter((id) => !pinnedNew.includes(id));
    const newRemaining = Math.max(0, dailyNewLimit - daily.newIntroduced);
    // もう一度のラウンドのときに出す、最初のラウンドの成績
    const mainScore = main
      ? (() => {
          const idxs = main.questions.map((_, i) => i).filter((i) => isAnswered(main, i));
          return { correct: idxs.filter((i) => isCorrect(main, i)).length, total: idxs.length };
        })()
      : null;
    return (
      <div className="animate-fade-in space-y-4">
        <div
          className={`card bg-gradient-to-br p-6 text-center text-white ${
            isRetry ? "from-amber-500 to-orange-600" : "from-brand-blue to-indigo-600"
          }`}
        >
          <div className="text-sm opacity-90">{isRetry ? `もう一度（${round}回目）の結果` : "結果"}</div>
          <div className="my-1 text-5xl font-extrabold">
            {correct}/{total}
          </div>
          <div className="text-sm opacity-90">正答率 {total ? Math.round((correct / total) * 100) : 0}%</div>
          {nPartial > 0 && <div className="mt-1 text-xs opacity-80">うち △（惜しい・ヒントあり） {nPartial}問</div>}
          {total < questions.length && (
            <div className="mt-1 text-xs opacity-80">
              {questions.length}問中 {total}問で中断
            </div>
          )}
          {mainScore && (
            <div className="mt-1 text-xs opacity-80">
              最初のラウンド: {mainScore.correct}/{mainScore.total}
            </div>
          )}
        </div>

        {isRetry ? (
          <div className="card p-4 text-xs text-slate-500">
            もう一度のラウンドは練習です。SRS（復習の予定）には記録しません（反映したのは最初のラウンドだけ）。
          </div>
        ) : (
          /* SRS への反映の内訳 */
          <div className="card space-y-1 p-4">
            <div className="text-sm font-bold text-brand-ink">
              SRSに反映: 復習 {nReviewed} ／ 変更なし {nUnchanged} ／ 未学習 {nUntracked}
            </div>
            <p className="text-xs text-slate-500">
              復習日が来た語だけを予定に反映します。今日すでに評価した語と復習日前の正解は予定を変えず、未学習の語はクイズの正解だけでは記録しません。
            </p>
          </div>
        )}

        {wrongCount > 0 && (
          <button onClick={startRetry} className="btn-primary min-h-11 w-full flex-col gap-0 py-3">
            <span>間違えた {wrongCount}問をもう一度</span>
            <span className="text-[11px] font-normal opacity-90">SRS には記録しません</span>
          </button>
        )}

        {wrongNew.length > 0 && (
          <div className="card space-y-2 p-4">
            <div className="text-sm text-brand-ink">
              未学習で間違えた語が <span className="font-bold">{wrongNew.length}語</span> あります。
            </div>
            {toPin.length > 0 ? (
              <>
                <PinNotice newRemaining={newRemaining} pinned={false} />
                <button onClick={() => pinNew(toPin)} className="btn-primary w-full py-3">
                  今日の学習に追加（{toPin.length}語）
                </button>
              </>
            ) : (
              <PinNotice newRemaining={newRemaining} pinned />
            )}
          </div>
        )}

        <h2 className="px-1 text-sm font-bold text-slate-500">復習</h2>
        <div className="space-y-2">
          {answered.map(({ q, i }) => {
            const ok = isOk(i);
            const t = typed[i];
            const m = markOf(ok, t);
            const eff = effects[i] ? EFFECT_LABEL[effects[i]!] : null;
            let detail: string | null = null;
            if (t) {
              if (!t.result) detail = "わからない";
              else if (t.result.grade !== "exact") detail = `入力: ${t.input}${t.overridden ? "（正解にした）" : ""}`;
              else if (t.hints) detail = "ヒントあり";
            } else if (!ok && selected[i] != null) {
              const c = q.choices[selected[i]!];
              detail = `誤答: ${mode === "ja2pt" ? `${c.pt}（${c.ja}）` : `${c.ja}（${c.pt}）`}`;
            }
            return (
              <div key={i} className={`card flex items-center gap-3 p-3 ${ok ? "" : "ring-1 ring-rose-200"}`}>
                <span className={`text-lg ${m.cls}`}>{m.mark}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="font-bold text-brand-ink">{q.word.pt}</span>
                    {eff && <span className={`chip ${eff.cls}`}>{eff.label}</span>}
                  </div>
                  <div className="text-xs text-slate-500">
                    {q.word.ja}
                    {detail && <span className={ok ? "text-amber-600" : "text-rose-500"}> ／ {detail}</span>}
                  </div>
                </div>
                <SpeakerButton text={q.word.ptForSpeech} />
              </div>
            );
          })}
        </div>

        {isRetry && main && (
          <button onClick={backToMain} className="btn-ghost min-h-11 w-full py-3">
            最初の結果に戻る
          </button>
        )}
        <div className="flex gap-2">
          <button onClick={() => setPhase("setup")} className="btn-ghost flex-1 py-3">
            モード選択へ
          </button>
          <button onClick={start} className="btn-primary flex-1 py-3">
            新しい問題で
          </button>
        </div>
      </div>
    );
  }

  // ---------- playing ----------
  const q = questions[idx];
  const sel = selected[idx];
  const typedMode = isTyped(mode);
  const t = typed[idx];
  const answered = typedMode ? t != null : sel != null;
  // 「正解にする」を出せるのは、評価が変わるときだけ（最初のラウンドは SRS への反映待ちの間だけ）
  const canOverride =
    !!t &&
    (isRetry
      ? !!t.result && !t.overridden && ratingForOverride(t.hints > 0) !== t.rating
      : effects[idx] == null && pendingRef.current?.i === idx);
  const synonym = !!t?.result && t.result.grade !== "wrong" && !isOwnAnswer(q.word, t.result.expected);
  const nextLabel = idx < questions.length - 1 ? "次へ" : "結果を見る";
  const chosenWrong = !typedMode && sel != null && sel !== q.answer ? q.choices[sel] : null;

  return (
    <div className="animate-fade-in space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={quit} className="min-h-11 pr-2 text-sm text-brand-green">‹ 中断</button>
        <div className="flex items-center gap-2 text-sm font-bold text-slate-500">
          {isRetry && <span className="chip bg-amber-100 text-amber-700">もう一度・記録しません</span>}
          {idx + 1} / {questions.length}
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full transition-all ${isRetry ? "bg-amber-500" : "bg-brand-green"}`}
          style={{ width: `${((idx + 1) / questions.length) * 100}%` }}
        />
      </div>

      {/* 問題 */}
      <div
        className={`card flex flex-col items-center justify-center gap-2 p-6 text-center ${
          typedMode || answered ? "min-h-[96px]" : "min-h-[140px]"
        }`}
      >
        {isListen(mode) ? (
          <>
            {/* 入力式では、再生のタップで入力欄のフォーカス（キーボード）を外さない */}
            <span onPointerDown={keepFocus} onMouseDown={keepFocus}>
              <SpeakerButton text={q.word.ptForSpeech} size={40} />
            </span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">音声をタップして再生</span>
              <button
                type="button"
                onPointerDown={keepFocus}
                onMouseDown={keepFocus}
                onClick={() => speakQuestion(q, SLOW_RATE)}
                className="btn-ghost min-h-11 px-3 text-xs"
              >
                ゆっくり
              </button>
            </div>
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

      {!typedMode && (
        <>
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

          {/* 解答カード */}
          {answered && (
            <div className="card space-y-3 p-4">
              <div className={`text-lg font-bold ${sel === q.answer ? "text-emerald-600" : "text-rose-600"}`}>
                {sel === q.answer ? "正解！" : "不正解"}
              </div>
              <AnswerCard word={q.word} chosen={chosenWrong} />
            </div>
          )}

          {answered && (
            <button onClick={nextQuestion} className="btn-primary min-h-11 w-full py-3">
              {nextLabel}
            </button>
          )}
        </>
      )}

      {/* 入力式: 答える前 */}
      {typedMode && !t && (
        <div className="space-y-2">
          {hint > 0 && (
            <div className="rounded-lg bg-amber-50 p-3 text-amber-800">
              <span className="text-xs font-bold">ヒント </span>
              <span className="font-mono text-lg tracking-wide">{hintText(q.word.pt, hint)}</span>
            </div>
          )}
          <PtInput
            key={`${round}:${idx}`}
            value={draft}
            onChange={setDraft}
            onSubmit={submitTyped}
            autoFocus
            placeholder="ポルトガル語で入力…"
            aria-label="答え（ポルトガル語）"
          />
          <button onClick={submitTyped} disabled={!draft.trim()} className="btn-primary min-h-11 w-full py-3">
            答え合わせ
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              // 入力欄のフォーカス（キーボード）を保ったままヒントを出す
              onPointerDown={keepFocus}
              onMouseDown={keepFocus}
              onClick={showHint}
              disabled={hint >= HINT_MAX}
              className="btn-ghost min-h-11 flex-1 text-sm"
            >
              ヒント{hint > 0 ? `（${hint}/${HINT_MAX}）` : ""}
            </button>
            <button type="button" onClick={giveUp} className="btn-ghost min-h-11 flex-1 text-sm">
              わからない
            </button>
          </div>
        </div>
      )}

      {/* 入力式: 答え合わせの後（解答カード） */}
      {typedMode && t && (
        <div className="space-y-3">
          <div className="card space-y-3 p-4">
            <div className={`text-lg font-bold ${typedVerdict(t).cls}`}>{typedVerdict(t).label}</div>
            {t.result && t.result.grade !== "exact" && (
              <div className="space-y-1">
                <div className="text-xs text-slate-400">あなたの答え</div>
                {t.result.grade === "wrong" && !t.result.note ? (
                  <div className="break-all text-lg text-rose-600 line-through">{t.input}</div>
                ) : (
                  <>
                    <DiffView diff={t.result.diff} />
                    <div className="text-[11px] text-slate-400">赤の取り消し線＝余分な文字、緑＝足りない文字</div>
                  </>
                )}
                {t.result.note && <div className="text-sm text-slate-600">{t.result.note}</div>}
              </div>
            )}
            <AnswerCard word={q.word} />
            {synonym && t.result && (
              <p className="text-xs text-slate-500">
                「{t.result.expected}」（同じ意味の別の見出し）として採点しました。
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {canOverride && (
              <button type="button" onClick={markCorrect} className="btn-ghost min-h-11 flex-1 py-3">
                正解にする
              </button>
            )}
            <button type="button" onClick={nextQuestion} autoFocus className="btn-primary min-h-11 flex-1 py-3">
              {nextLabel}
            </button>
          </div>
          {canOverride && (
            <p className="text-xs text-slate-400">
              表記ゆれなどで正しいと思うときは「正解にする」（ヒントを使ったときは「難しい」として記録）。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
