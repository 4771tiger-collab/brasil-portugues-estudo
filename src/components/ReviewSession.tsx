// ============================================================================
// 1枚ずつ学習（思い出す → 答えを見る → 評価）
// 状態遷移は純粋な reducer（src/srs/session.ts）。SRS への書き込み（rate/undo）と音声は
// click/keydown の handler の中だけで行う（StrictMode の effect 二重実行と自動再生の制限を避ける）。
// 学習中は useUi.immersive で下部ナビを隠し、操作バーを親指の届く画面下部に置く。
// 和→葡の産出カード（T2-1。StudyItem.dir="prod"）も同じ流れで出す。評価・取り消しはカードキー
// （cardKey.ts。産出カードは "id@p"）で行い、入力で答えたときは採点して「おすすめ」の評価を強調する。
// ============================================================================

import { useEffect, useMemo, useRef, useState } from "react";
import type { Rating, Word } from "../data/types";
import { useProgress } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { useUi } from "../store/useUi";
import { useToday } from "../hooks/useToday";
import { audio } from "../services/audio";
import { gradeWord, ratingForGrade, type SpeechScore } from "../services/grade";
import { isKnownForm, quizAnswers } from "../services/gradeLexicon";
import { speechInput } from "../services/speechInput";
import type { StudyItem } from "../srs/cardKey";
import {
  againItems,
  currentItem,
  initSession,
  isDone,
  sessionStats,
  step,
  testDirection,
  type SessionAction,
  type SessionState,
} from "../srs/session";
import ReviewCard, { type ProdAnswer } from "./ReviewCard";
import RatingButtons, { RATING_KEYS, RATING_LABEL } from "./RatingButtons";
import SayItButton from "./SayItButton";
import SessionComplete, { useForecast } from "./SessionComplete";
import UndoToast from "./UndoToast";

interface Props {
  /**
   * 出題するカード（親で確定して固定する。並びもこのまま）。
   * Word は理解カード、StudyItem は dir で理解・産出を指定する（今日の学習の plan.items）
   */
  items: readonly (Word | StudyItem)[];
  title: string;
  /** ✕（一覧へ戻る） */
  onExit: () => void;
  /** 一覧表示に切り替える */
  onSwitchView?: () => void;
  /** 耳だけ復習（🎧）を開く */
  onHandsfree?: () => void;
  /** 完了画面の「あと5語」（今日の学習のみ） */
  onExtra?: () => void;
  /** 今日の学習で新しい語を止めた理由（完了画面に出す） */
  reason?: "backlog";
  /**
   * 評価・取り消しを親へ知らせる（表示を切り替えたときに合格済みのカードを出し直さないため）。
   * key はカードキー（理解カードは語の ID、産出カードは ID+"@p"）
   */
  onRated?: (key: string, r: Rating) => void;
  onUnrated?: (key: string) => void;
  /** 完了画面の「このデッキでクイズ」のリンク先（今日の学習では無し） */
  quizPath?: string;
}

/** 状態が変わった直後、この時間だけ画面上のボタンの押下を無視する（ダブルタップが次のボタンに当たらないように） */
const INPUT_LOCK_MS = 350;

/** 取り消し用: 評価する直前のセッション状態（直前カードの裏面）と、そのカードキー */
interface UndoRef {
  snap: SessionState;
  key: string;
}

/** 入力欄・IME 変換中・キーリピートでは反応しない */
function ignoreKey(e: KeyboardEvent): boolean {
  if (e.isComposing || e.repeat) return true;
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

/** 操作バー（画面下部・safe-area の上）。下部ナビの代わりに親指ゾーンを使う */
function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-2xl border-t border-slate-200 bg-white/95 px-4 pb-[calc(.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur">
      {children}
    </div>
  );
}

/** 完了画面（予報はここでだけ計算する） */
function Done({
  s,
  onAgainRound,
  onExtra,
  reason,
  quizPath,
}: {
  s: SessionState;
  onAgainRound: (items: StudyItem[]) => void;
  onExtra?: () => void;
  reason?: "backlog";
  quizPath?: string;
}) {
  const fc = useForecast();
  // again だったカード（同じ語の理解カードと産出カードは別の1枚）
  const again = useMemo(() => againItems(s), [s]);
  return (
    <SessionComplete
      stats={sessionStats(s)}
      againItems={again}
      forecast={fc}
      onAgainRound={again.length ? () => onAgainRound(again) : undefined}
      onExtra={onExtra}
      reason={reason}
      quizPath={quizPath}
    />
  );
}

export default function ReviewSession({
  items,
  title,
  onExit,
  onSwitchView,
  onHandsfree,
  onExtra,
  reason,
  onRated,
  onUnrated,
  quizPath,
}: Props) {
  const today = useToday();
  const cards = useProgress((st) => st.cards);
  const showKana = useSettings((st) => st.showKana);
  const showIpa = useSettings((st) => st.showIpa);
  const direction = useSettings((st) => st.studyDirection);
  const autoPlay = useSettings((st) => st.autoPlayOnReveal);
  const voiceURI = useSettings((st) => st.voiceURI);
  const speechRate = useSettings((st) => st.rate);
  const answerMode = useSettings((st) => st.productionAnswerMode);
  // 音声認識の「🎤 言ってみる」（T2-8。オプトイン。オフなら何も描かず、何も動かさない）
  const speechOn = useSettings((st) => st.speechInputEnabled);
  const setImmersive = useUi((st) => st.setImmersive);

  // mount 時の cards で intro/test を決める（以後の評価で並びは変えない）
  const [s, setS] = useState<SessionState>(() => initSession(items, useProgress.getState().cards));
  // 産出カードを入力で答えた結果（キューの key ごと。取り消しで裏面に戻ったときもそのまま出す）
  const [answers, setAnswers] = useState<Record<string, ProdAnswer>>({});
  // handler は連打でも最新の状態を読む（再描画を待たずに二重評価しないため）
  const sRef = useRef(s);
  const undoRef = useRef<UndoRef | null>(null);
  const [toast, setToast] = useState<{ token: number; message: string } | null>(null);
  // 画面下の操作バーは「答えを見る」「覚えた → 次へ」「評価4つ」が同じ位置に入れ替わるため、
  // ダブルタップの2回目が次のボタン（評価など）に当たらないよう、切り替え直後の押下を少しの間無視する
  const inputLockRef = useRef(0);
  function guard<A extends unknown[]>(fn: (...a: A) => void) {
    return (...a: A) => {
      if (performance.now() >= inputLockRef.current) fn(...a);
    };
  }
  // 最後にフォーカスを動かしたのがキーボード（Tab）か。タップ・クリックで押したボタンに残ったフォーカスと区別する
  const kbdFocusRef = useRef(false);

  const done = isDone(s);
  const cur = currentItem(s);

  // 学習中は下部ナビを隠す。完了画面では戻す。アンマウントで必ず戻す
  useEffect(() => {
    setImmersive(!done);
  }, [done, setImmersive]);
  useEffect(
    () => () => {
      setImmersive(false);
      audio.cancel();
    },
    [setImmersive]
  );

  function speak(w: Word) {
    void audio.speak(w.ptForSpeech, { rate: speechRate, voiceURI });
  }

  /** 状態を進める。遷移先が紹介カードなら、同じ handler の中で読み上げる */
  function commit(next: SessionState) {
    if (next === sRef.current) return;
    sRef.current = next;
    inputLockRef.current = performance.now() + INPUT_LOCK_MS;
    setS(next);
    const it = currentItem(next);
    if (it?.kind === "intro" && autoPlay) speak(it.word);
  }

  function dispatch(a: SessionAction) {
    commit(step(sRef.current, a));
  }

  function reveal() {
    const st = sRef.current;
    const it = currentItem(st);
    if (!it || it.kind !== "test" || st.phase !== "front") return;
    commit(step(st, { t: "reveal" }));
    if (autoPlay) speak(it.word);
  }

  /**
   * 産出カードの答え合わせ（入力）。input が null なら「わからない」（採点なし・おすすめは「もう一度」）。
   * 採点 → 裏返し → 読み上げを同じ handler の中で行う（自動再生の制限を避けるため）。
   * 正解の集合は見出しの表記ゆれ ＋ 和訳が同じ別見出し（クイズの和→葡の入力式と同じ）。
   */
  function answerProd(input: string | null) {
    const it = currentItem(sRef.current);
    if (!it) return;
    const result = input === null ? null : gradeWord(input, quizAnswers(it.word, true), { isKnownForm });
    showProdAnswer(it.key, {
      input: input ?? "",
      result,
      suggested: result ? ratingForGrade(result.grade, false) : "again",
      via: "type",
    });
  }

  /**
   * 産出カードを「🎤 言ってみる」で答えた（SayItButton が採点済み。正解の集合は入力と同じ、アクセントの違いは正解）。
   * 聞き取りの間に別のカードへ進んでいたら何もしない（key で確かめる）。
   * 読み上げは聞き取りの後になる（🎤 のタップでページは操作済みなので、Chrome は読み上げを許す）。
   */
  function answerProdSpeech(key: string, sc: SpeechScore) {
    if (sc.kind !== "word") return;
    showProdAnswer(key, { input: sc.heard, result: sc.result, suggested: sc.suggestedRating, via: "speech" });
  }

  /** 産出カードの採点を記録して裏返し、（設定なら）読み上げる。表面の産出カードでなければ何もしない */
  function showProdAnswer(key: string, answer: ProdAnswer) {
    const st = sRef.current;
    const it = currentItem(st);
    if (!it || it.key !== key || it.dir !== "prod" || it.kind !== "test" || st.phase !== "front") return;
    setAnswers((a) => ({ ...a, [it.key]: answer }));
    commit(step(st, { t: "reveal" }));
    if (autoPlay) speak(it.word);
  }

  function introNext() {
    audio.cancel();
    dispatch({ t: "introNext" });
  }

  function rate(r: Rating) {
    const st = sRef.current;
    const it = currentItem(st);
    if (!it || it.kind !== "test" || st.phase !== "back") return;
    audio.cancel();
    // 評価はカードキーで（産出カードは "id@p"。理解カードとは別の SRS）
    useProgress.getState().rate(it.cardKey, r);
    onRated?.(it.cardKey, r);
    undoRef.current = { snap: st, key: it.cardKey };
    const label = it.dir === "prod" ? `✍「${it.word.pt}」` : `「${it.word.pt}」`;
    setToast((t) => ({ token: (t?.token ?? 0) + 1, message: `${label}→ ${RATING_LABEL[r]}` }));
    commit(step(st, { t: "rate", r }));
  }

  function undo() {
    const u = undoRef.current;
    undoRef.current = null;
    setToast(null);
    if (!u) return;
    const P = useProgress.getState();
    // 取り消しは1段だけ。別の操作（クイズ等）で破棄されていたら何もしない
    if (!P.canUndo(u.key)) return;
    if (P.undo() !== u.key) return;
    onUnrated?.(u.key);
    audio.cancel();
    sRef.current = u.snap;
    inputLockRef.current = performance.now() + INPUT_LOCK_MS;
    setS(u.snap);
  }

  function againRound(ws: StudyItem[]) {
    undoRef.current = null;
    setToast(null);
    dispatch({ t: "append", items: ws });
  }

  function replay() {
    const st = sRef.current;
    const it = currentItem(st);
    if (!it) return;
    // 和→葡の表面（産出カード・和→葡で出した理解カード）では答え（葡）を読み上げない
    if (it.kind === "test" && st.phase === "front" && (it.dir === "prod" || testDirection(it.word.id, today, direction) === "ja2pt")) return;
    speak(it.word);
  }

  // キー操作: Space/Enter 表示・次へ、1〜4 評価、U / Ctrl+Z 取り消し、R 音声
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.key === "Tab") kbdFocusRef.current = true;
    if (ignoreKey(e)) return;
    const key = e.key;
    const lower = key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey && lower === "z") {
      e.preventDefault();
      undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const st = sRef.current;
    const it = currentItem(st);
    if (key === " " || key === "Enter") {
      if (!it) return;
      // Tab で選んだボタン・リンク（取り消す・✕・一覧表示・音声・評価）は、標準どおりそのボタンを押す
      const t = e.target as HTMLElement | null;
      if (kbdFocusRef.current && t && t !== document.body && t.closest?.("button, a[href]")) return;
      // タップ・クリックで押したボタンにフォーカスが残っていても、クリックを二重に起こさない
      e.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (it.kind === "intro") introNext();
      else if (st.phase === "front") reveal();
      return;
    }
    if (/^[1-4]$/.test(key)) {
      if (it?.kind === "test" && st.phase === "back") {
        e.preventDefault();
        rate(RATING_KEYS[Number(key) - 1]);
      }
      return;
    }
    if (lower === "u") {
      e.preventDefault();
      undo();
      return;
    }
    if (lower === "r") {
      e.preventDefault();
      replay();
    }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    // タップ・クリックでフォーカスが動いたら、Tab で選んだ状態ではなくなる
    const p = () => {
      kbdFocusRef.current = false;
    };
    window.addEventListener("keydown", h);
    window.addEventListener("pointerdown", p, true);
    return () => {
      window.removeEventListener("keydown", h);
      window.removeEventListener("pointerdown", p, true);
    };
  }, []);

  const toastEl = toast && (
    <UndoToast
      key={toast.token}
      message={toast.message}
      onUndo={undo}
      onClose={() => setToast(null)}
      // 学習中は操作バーの上、完了画面では下部ナビの上
      bottom={done ? "calc(4.5rem + env(safe-area-inset-bottom))" : "calc(6rem + env(safe-area-inset-bottom))"}
    />
  );

  if (done || !cur) {
    return (
      <div className="pb-4">
        <Done s={s} onAgainRound={againRound} onExtra={onExtra} reason={reason} quizPath={quizPath} />
        {toastEl}
      </div>
    );
  }

  const dir = testDirection(cur.word.id, today, direction);
  const progress = s.queue.length ? s.pos / s.queue.length : 0;

  return (
    <div className="pb-[calc(5rem+env(safe-area-inset-bottom))]">
      {/* フェードインは中身だけ。transform のアニメーション中は fixed の子（操作バー・トースト）の
          基準がこの要素になり、バーが画面の途中に出てしまうため、fixed の要素は外に置く */}
      <div className="animate-fade-in">
        {/* 上部: ✕・タイトル・一覧表示・進捗バー */}
        <div className="mb-3 space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onExit}
              className="-ml-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-xl text-slate-400 transition hover:bg-slate-100"
              aria-label="学習をやめて単語帳へ"
              title="単語帳へ"
            >
              ✕
            </button>
            <div className="min-w-0 flex-1 truncate text-center text-sm font-bold text-brand-ink">{title}</div>
            <span className="text-xs tabular-nums text-slate-400">
              {s.pos}/{s.queue.length}
            </span>
            {onHandsfree && (
              <button
                type="button"
                onClick={onHandsfree}
                className="min-h-11 px-1 text-xs text-brand-green"
                title="耳だけ復習（葡 → 考える間 → 和 を読み上げ）"
              >
                🎧 耳だけ
              </button>
            )}
            {onSwitchView && (
              <button type="button" onClick={onSwitchView} className="min-h-11 px-1 text-xs text-brand-green">
                一覧表示
              </button>
            )}
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={s.queue.length}
            aria-valuenow={s.pos}
          >
            <div className="h-full rounded-full bg-brand-green transition-all" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        </div>

        <ReviewCard
          key={cur.key}
          word={cur.word}
          kind={cur.kind}
          phase={s.phase}
          direction={dir}
          showKana={showKana}
          showIpa={showIpa}
          card={cards[cur.cardKey]}
          today={today}
          onReveal={reveal}
          dir={cur.dir}
          answer={answers[cur.key]}
          answerMode={answerMode}
          onAnswer={guard((input: string | null) => answerProd(input))}
          speechSlot={
            speechOn && cur.dir === "prod" && cur.kind === "test" && s.phase === "front" && speechInput.isSupported() ? (
              <SayItButton
                mode="word"
                expected={quizAnswers(cur.word, true)}
                gradeOptions={{ isKnownForm }}
                showResult={false}
                onScored={(sc) => answerProdSpeech(cur.key, sc)}
              />
            ) : undefined
          }
        />
        <p className="mt-3 hidden text-center text-[11px] text-slate-400 md:block">
          Space: 答えを見る・次へ ／ 1〜4: 評価 ／ U: 取り消す ／ R: 音声
        </p>
      </div>

      <ActionBar>
        {/* key を分けて DOM を使い回さない（押したボタンのフォーカスが次の操作に残らないように）。
            切り替え直後の押下は guard で無視する（ダブルタップの2回目で評価・スキップしない） */}
        {cur.kind === "intro" ? (
          <button key="intro" type="button" onClick={guard(introNext)} className="btn-primary h-14 w-full text-base">
            覚えた → 次へ
          </button>
        ) : s.phase === "front" ? (
          <button key="reveal" type="button" onClick={guard(reveal)} className="btn-primary h-14 w-full text-base">
            答えを見る
          </button>
        ) : (
          <RatingButtons
            card={cards[cur.cardKey]}
            onRate={guard(rate)}
            size="lg"
            today={today}
            suggested={cur.dir === "prod" ? answers[cur.key]?.suggested : undefined}
          />
        )}
      </ActionBar>
      {toastEl}
    </div>
  );
}
