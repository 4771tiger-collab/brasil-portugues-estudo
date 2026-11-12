import { useEffect, useMemo, useRef, useState } from "react";
import { Headphones, Pause, Play, SkipForward, X } from "lucide-react";
import { useBack } from "../../hooks/useBack";
import { useCatalog } from "../../hooks/useDailyMenu";
import { useActivityTimer } from "../../hooks/useActivityTimer";
import { useToday } from "../../hooks/useToday";
import { useWakeLock } from "../../hooks/useWakeLock";
import { audio, delay } from "../../services/audio";
import { answerShown, runHandsfree, type HandsfreePhase } from "../../services/handsfree";
import { dueItems, extraItems, type SayItem } from "../../speak/catalog";
import { useProgress } from "../../store/useProgress";
import { useSettings } from "../../store/useSettings";
import { useSpeak } from "../../store/useSpeak";
import NextMenu from "../../components/speak/NextMenu";

/** 1回に流す文の数 */
const LIST_MAX = 20;
/** 考える間（言う時間）: 文の語数 × この ms。短い文でも MIN_GAP_MS は空ける */
const GAP_PER_WORD_MS = 650;
const MIN_GAP_MS = 2500;
const JA_LANG = "ja-JP";
/** 無音の発話（読み上げを、再生を始めたタップの処理の中で始めておく） */
const SILENT = "\u200B";

/** その文を言うための間（ms）。文の長さに合わせる */
export function sayGapMs(pt: string): number {
  return Math.max(MIN_GAP_MS, pt.split(/\s+/).filter(Boolean).length * GAP_PER_WORD_MS);
}

/**
 * 耳だけ口慣らし: 日本語 → 言う間 → ポルトガル語（お手本）→ もう一度、を自動で繰り返す。
 * 画面を見ずに、歩きながら・家事をしながら声に出せる（services/handsfree.ts の進め方を、文に使う）。
 * SRS には書かない（言えたかどうかを確かめられないため）。評価は、ふだんの口慣らしで行う。
 */
export default function SpeakHandsfree() {
  const back = useBack("/");
  const today = useToday();
  const catalog = useCatalog();
  // 開いた時点の記録で流す文を決める: 今日の復習の文 → あやふやな文の順
  const items = useMemo<SayItem[]>(() => {
    const cards = useSpeak.getState().cards;
    const due = dueItems(cards, catalog, today);
    return [...due, ...extraItems(cards, catalog, today, LIST_MAX)].slice(0, LIST_MAX);
  }, [catalog, today]);
  const list = useMemo(() => items.map((it) => ({ ptForSpeech: it.pt, ja: it.ja })), [items]);

  const [playing, setPlaying] = useState(false);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<HandsfreePhase | null>(null);
  const [finished, setFinished] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const idxRef = useRef(0);
  useWakeLock(playing);
  // 耳だけ復習（単語）と同じ「listen」に記録する（声に出したかは確かめられないので、口慣らしの回数には数えない）
  useActivityTimer("listen", playing);

  function stop() {
    ctrlRef.current?.abort();
    ctrlRef.current = null;
    audio.cancel();
    setPlaying(false);
  }
  useEffect(() => stop, []);

  /** from 番目から流す（タップの処理の中で呼ぶ） */
  function start(from: number) {
    stop();
    if (!list.length) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setFinished(false);
    setPlaying(true);
    // config()（言う間の長さ）は文を始める前に呼ばれるので、次に流す文の番号を先に持っておく
    idxRef.current = from;
    void runHandsfree(
      list,
      from,
      {
        speak: (text, lang) => {
          const s = useSettings.getState();
          return lang === "ja" ? audio.speak(text, { lang: JA_LANG, rate: 1 }) : audio.speak(text, { rate: s.rate > 0 ? s.rate : 1, voiceURI: s.voiceURI });
        },
        prime: () => void audio.speak(SILENT),
        wait: (ms, signal) => delay(ms, signal),
        config: () => ({ dir: "ja2pt", gapMs: sayGapMs(list[idxRef.current]?.ptForSpeech ?? ""), jaVoice: audio.hasVoice?.("ja") ?? false }),
        onWord: (i) => setIdx(i),
        onStep: (_i, st) => setPhase(st.phase),
        onWordDone: (i) => {
          idxRef.current = i + 1;
          useProgress.getState().logActivity("listen", 1, 0);
        },
      },
      ctrl.signal
    ).then((r) => {
      if (ctrlRef.current !== ctrl) return;
      ctrlRef.current = null;
      setPlaying(false);
      setPhase(null);
      if (r === "end") setFinished(true);
    });
  }

  const cur = items[idx];
  if (!items.length) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <div className="card space-y-2 p-6 text-center">
          <h1 className="text-xl font-bold text-brand-ink">耳だけ口慣らし</h1>
          <p className="text-sm leading-relaxed text-slate-500">レッスンを終えると、練習した文をここで流せます（日本語 → 言う間 → お手本）。</p>
        </div>
        <NextMenu />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-center justify-between">
        <button type="button" onClick={back} aria-label="閉じる" className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-slate-500 active:scale-90">
          <X size={22} aria-hidden />
        </button>
        <h1 className="flex items-center gap-1.5 text-sm font-bold text-brand-ink">
          <Headphones size={16} className="text-teal-600" aria-hidden />
          耳だけ口慣らし
        </h1>
        <span className="w-11 text-right text-xs tabular-nums text-slate-500">
          {idx + 1}/{items.length}
        </span>
      </div>

      <div className="card flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center" aria-live="polite">
        {finished ? (
          <>
            <p className="text-xl font-bold text-brand-ink">最後まで流しました 🎉</p>
            <p className="text-sm text-slate-500">声に出せましたか？ あやふやだった文は、口慣らしで確かめよう。</p>
          </>
        ) : (
          <>
            <p className="text-xs font-bold text-slate-400">
              {!playing && phase === null
                ? "日本語 → 言う間 → お手本 → もう一度 を自動で流します"
                : phase === "prompt"
                  ? "🇯🇵 これをポルトガル語で…"
                  : phase === "think"
                    ? "🗣 今、声に出して言おう"
                    : phase === "repeat"
                      ? "🔁 お手本のあとについて、もう一度"
                      : "🇧🇷 お手本"}
            </p>
            <p className="text-xl font-bold leading-relaxed text-brand-ink">{cur.ja}</p>
            {phase !== null && answerShown(phase) ? (
              <p className="text-2xl font-bold leading-snug text-brand-green" lang="pt-BR">
                {cur.pt}
              </p>
            ) : (
              <p className="text-2xl font-bold text-slate-200">…</p>
            )}
            <span className="chip bg-slate-100 text-slate-500">{cur.label}</span>
          </>
        )}
      </div>

      <div className="flex items-center justify-center gap-3">
        <button type="button" onClick={() => (playing ? stop() : start(finished ? 0 : idx))} className="btn-primary h-16 min-w-40 text-base">
          {playing ? <Pause size={22} className="fill-current" aria-hidden /> : <Play size={22} className="fill-current" aria-hidden />}
          {playing ? "止める" : finished ? "もう一度" : phase === null && idx === 0 ? "はじめる" : "つづける"}
        </button>
        <button type="button" onClick={() => start(Math.min(items.length - 1, idx + 1))} disabled={idx >= items.length - 1} aria-label="次の文へ" className="btn-ghost h-16 w-16 px-0">
          <SkipForward size={22} aria-hidden />
        </button>
      </div>
      <p className="text-center text-xs leading-relaxed text-slate-400">
        画面を見なくても進みます（再生中は画面を消しません）。記録（SRS）は変わりません。
        {!(audio.hasVoice?.("ja") ?? false) && " この端末には日本語の音声が無いため、日本語は画面に表示します。"}
      </p>
      {finished && <NextMenu />}
    </div>
  );
}
