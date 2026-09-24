// ============================================================================
// 耳だけ復習（単語帳の学習画面 StudyView の「🎧 耳だけ」から開く）
// 今の並びの語を1語ずつ、葡 → 考える間 → 和 → 葡 の順に読み上げる（進め方は src/services/handsfree.ts）。
// - 全体を AbortController で止められる（一時停止・次へ・もう一度・終了・画面を離れる）
// - 再生中は画面を消さない（Wake Lock）。画面が隠れたら一時停止する
// - SRS には書かない。終わったら「怪しかった語」に印をつけ、「1枚ずつで確認」で印の語を先頭に
//   ReviewSession を始める（評価は通常の rate を通るので、据え置きの規則が効く）
// - 学習ログ: logActivity("listen", 聴き終えた語の数, 再生していた秒数)。一時停止・終了・画面を離れたときに記録
// - 最初の speak は再生を始めるタップの処理の中で呼ぶ（Android の Chrome の自動再生の制限）
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import type { HandsfreeDirection, Word } from "../data/types";
import { audio, delay } from "../services/audio";
import { clockRun, clockTake, newClock } from "../services/activityClock";
import {
  HANDSFREE_GAPS_SEC,
  answerShown,
  estimateSec,
  handsfreeDirection,
  handsfreeGapMs,
  markedFirst,
  runHandsfree,
  type HandsfreeIO,
  type HandsfreePhase,
} from "../services/handsfree";
import { useProgress } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { useUi } from "../store/useUi";
import { useWakeLock } from "../hooks/useWakeLock";
import SpeakerButton from "./SpeakerButton";

interface Props {
  /** 聴く語（学習画面の今の並び） */
  words: Word[];
  title: string;
  /** 学習画面（1枚ずつ / 一覧）へ戻る */
  onClose: () => void;
  /** 「1枚ずつで確認」: この並び（印の語が先頭）で ReviewSession を始める */
  onReview: (ordered: Word[]) => void;
}

/** 日本語の読み上げ（地域まで指定。音声は audio 側が ja の音声から選ぶ） */
const JA_LANG = "ja-JP";
const JA_RATE = 1;
/**
 * 無音の発話（ゼロ幅スペース）。和→葡で日本語の音声が無いと、最初の音は考える間の後の葡になるため、
 * 再生を始めるタップの処理の中でこれを speak して読み上げを始めておく
 */
const SILENT = "\u200B";
/** 1回に記録する再生時間の上限（秒）。止め忘れなどの異常値を切る */
const LOG_CAP_SEC = 2 * 60 * 60;

type Stage = "ready" | "playing" | "paused" | "done";

/** いま読んでいる語と段階 */
interface Cur {
  /** この回の語の番号 */
  idx: number;
  phase: HandsfreePhase;
  dir: HandsfreeDirection;
  /** 考える間（ms。この語を始めたときの設定） */
  thinkMs: number;
  /** 日本語を読まずに画面だけで出している（日本語の音声が無い・訳が無い） */
  jaShownOnly: boolean;
  /** 語を始めるたびに増やす（考える間のバーを作り直す） */
  key: number;
}

/** 1回分の再生（全部 / 怪しかった語だけ） */
interface Run {
  words: Word[];
  /** 始めた語の数（終わりの一覧に出す範囲） */
  reached: number;
  /** 最後の語まで聴き終えた（途中で終了していない） */
  finished: boolean;
}

const PHASE_LABEL: Record<HandsfreePhase, string> = {
  prompt: "🔊 聴いて",
  think: "🤔 考えて",
  answer: "💡 答え",
  repeat: "🔁 もう一度",
};

/** 操作バー（画面下部・safe-area の上。1枚ずつ学習と同じ） */
function ActionBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 mx-auto max-w-2xl border-t border-slate-200 bg-white/95 px-4 pb-[calc(.75rem+env(safe-area-inset-bottom))] pt-3 backdrop-blur">
      {children}
    </div>
  );
}

/** 考える間の残り（マウントした時点から ms かけて減る。次の語では key を変えて作り直す） */
function ThinkBar({ ms }: { ms: number }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    // 幅 100% を1回描いてから 0% へ（2フレーム待たないと transition が効かない）
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setGo(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden>
      <div
        className="h-full rounded-full bg-brand-green"
        style={{ width: go ? "0%" : "100%", transition: `width ${ms}ms linear` }}
      />
    </div>
  );
}

/** 印（怪しかった語）のチェック */
function MarkBox({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-sm font-bold ${
        on ? "border-amber-400 bg-amber-400 text-white" : "border-slate-300 text-transparent"
      }`}
    >
      ✓
    </span>
  );
}

/** 向きの説明（開始画面） */
function flowText(dir: HandsfreeDirection, gapSec: number): string {
  return dir === "ja2pt"
    ? `日本語 → 考える間（${gapSec}秒）→ ポルトガル語 → もう一度ポルトガル語 の順に読み上げます。聴こえる前にポルトガル語を口に出してみましょう。`
    : `ポルトガル語 → 考える間（${gapSec}秒）→ 日本語 → もう一度ポルトガル語 の順に読み上げます。日本語が聴こえる前に意味を思い出してみましょう。`;
}

export default function HandsfreePlayer({ words, title, onClose, onReview }: Props) {
  const showKana = useSettings((s) => s.showKana);
  const dirSetting = useSettings((s) => s.handsfreeDirection);
  const gapSetting = useSettings((s) => s.handsfreeGapSec);
  const setSettings = useSettings((s) => s.set);
  const setImmersive = useUi((s) => s.setImmersive);

  const [stage, setStage] = useState<Stage>("ready");
  const [run, setRun] = useState<Run>(() => ({ words, reached: 0, finished: false }));
  const [cur, setCur] = useState<Cur | null>(null);
  /** 怪しかった語（id）。この画面を閉じるまで残す */
  const [marked, setMarked] = useState<Set<string>>(() => new Set());
  /** この画面で聴き終えた語の数（のべ） */
  const [heard, setHeard] = useState(0);
  // 日本語の音声があるか（音声一覧は後から届く・増える）
  const [jaVoice, setJaVoice] = useState(() => audio.hasVoice?.("ja") ?? false);
  const supported = audio.isSupported();

  /** 再生中の AbortController（null = 止まっている） */
  const ctrlRef = useRef<AbortController | null>(null);
  /** いまの回の語と、読んでいる（止めた）語の番号。再開・次へ・続きからに使う */
  const runWordsRef = useRef<Word[]>(words);
  const posRef = useRef(0);
  const keyRef = useRef(0);
  /** 画面を離れた後に state を触らないための印 */
  const aliveRef = useRef(true);
  /** 再生していた時間（止めている間・画面が隠れている間は数えない）と、まだ記録していない聴き終えた語の数 */
  const clockRef = useRef(newClock());
  const pendingRef = useRef(0);

  const playing = stage === "playing";
  // 再生中は画面を消さない
  useWakeLock(playing);

  // 再生中・一時停止中は下部ナビを隠し、操作バーを親指の届く位置に置く。閉じたら必ず戻す
  useEffect(() => {
    setImmersive(stage === "playing" || stage === "paused");
  }, [stage, setImmersive]);
  useEffect(() => () => setImmersive(false), [setImmersive]);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (alive) setJaVoice(audio.hasVoice?.("ja") ?? false);
    };
    void audio.ready().then(refresh);
    const off = audio.onVoicesChanged?.(refresh);
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  /** 学習ログに記録する（聴き終えた語の数と、前回からの再生時間） */
  const flushLog = useCallback(() => {
    const { sec, clock } = clockTake(clockRef.current, Date.now());
    clockRef.current = clock;
    const n = pendingRef.current;
    pendingRef.current = 0;
    const s = Math.min(sec, LOG_CAP_SEC);
    if (n > 0 || s > 0) useProgress.getState().logActivity("listen", n, s);
  }, []);

  /** 再生を止める（読み上げ・間の待ちを打ち切り、時計を止める）。state は変えない */
  const halt = useCallback(() => {
    const c = ctrlRef.current;
    ctrlRef.current = null;
    if (c) {
      c.abort();
      audio.cancel();
    }
    clockRef.current = clockRun(clockRef.current, false, Date.now());
  }, []);

  /** 止めて、終わりの一覧へ */
  const finish = useCallback(
    (finished: boolean) => {
      halt();
      flushLog();
      setCur(null);
      setRun((r) => ({ ...r, finished: r.finished || finished }));
      setStage("done");
    },
    [halt, flushLog]
  );

  /** 一時停止（再開は、いまの語の最初から） */
  const pause = useCallback(() => {
    if (!ctrlRef.current) return;
    halt();
    flushLog();
    setStage("paused");
  }, [halt, flushLog]);

  /** 読み上げ・待ち・画面の更新（runHandsfree に渡す） */
  const io: HandsfreeIO = {
    speak: (text, lang) => {
      if (lang === "ja") return audio.speak(text, { lang: JA_LANG, rate: JA_RATE });
      // 速さ・音声は読むたびに設定から（再生中の変更も次の読み上げから効く）
      const s = useSettings.getState();
      return audio.speak(text, { rate: s.rate > 0 ? s.rate : 1, voiceURI: s.voiceURI });
    },
    prime: () => void audio.speak(SILENT),
    wait: delay,
    // 向き・考える間・日本語の音声は語ごとに読み直す（再生中の変更は次の語から効く）
    config: () => {
      const s = useSettings.getState();
      return {
        dir: handsfreeDirection(s.handsfreeDirection),
        gapMs: handsfreeGapMs(s.handsfreeGapSec),
        jaVoice: audio.hasVoice?.("ja") ?? false,
      };
    },
    onWord: (i) => {
      posRef.current = i;
      keyRef.current += 1;
      if (aliveRef.current) setRun((r) => (r.reached > i ? r : { ...r, reached: i + 1 }));
    },
    onStep: (i, st, info) => {
      if (aliveRef.current) {
        setCur({ idx: i, phase: st.phase, dir: info.dir, thinkMs: info.gapMs, jaShownOnly: !info.jaSpoken, key: keyRef.current });
      }
    },
    onWordDone: () => {
      pendingRef.current += 1;
      if (aliveRef.current) setHeard((h) => h + 1);
    },
  };

  async function loop(ctrl: AbortController, list: Word[], from: number) {
    // 1語目の最初の speak（または無音の発話）は、この関数を呼んだタップの処理の中で呼ばれる
    const r = await runHandsfree(list, from, io, ctrl.signal);
    // 最後まで聴いた（止めた・別の再生に替わったときは何もしない）
    if (r === "end" && ctrlRef.current === ctrl && aliveRef.current) finish(true);
  }

  /** list の from 番目から再生する（タップの処理の中で呼ぶ。最初の speak は同期で呼ばれる） */
  function play(list: Word[], from: number) {
    halt();
    if (!supported || from >= list.length) {
      finish(true);
      return;
    }
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    runWordsRef.current = list;
    clockRef.current = clockRun(clockRef.current, true, Date.now());
    setStage("playing");
    void loop(ctrl, list, from);
  }

  /** 新しい回を始める（全部 / 怪しかった語だけ） */
  function startRun(list: Word[]) {
    setRun({ words: list, reached: 0, finished: false });
    play(list, 0);
  }

  const resume = () => play(runWordsRef.current, posRef.current);
  const replay = () => play(runWordsRef.current, posRef.current);
  const next = () => {
    const list = runWordsRef.current;
    const i = posRef.current + 1;
    if (i >= list.length) {
      // 最後の語を飛ばした: 一覧に出す範囲は最後まで
      setRun((r) => ({ ...r, reached: list.length }));
      finish(true);
    } else play(list, i);
  };

  const toggleMark = (id: string) =>
    setMarked((m) => {
      const n = new Set(m);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  // 画面が隠れたら一時停止する（別のアプリ・画面を消した。裏では時間の計測も読み上げも当てにならない）
  useEffect(() => {
    if (!playing) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") pause();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [playing, pause]);

  // 画面を離れたら止めて、それまでの分を記録する（state は更新しない）
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      halt();
      flushLog();
    };
  }, [halt, flushLog]);

  const gapSec = handsfreeGapMs(gapSetting) / 1000;
  const dir = handsfreeDirection(dirSetting);

  // ---------------- 開始画面 ----------------
  if (stage === "ready") {
    const min = Math.max(1, Math.round(estimateSec(words.length, gapSec * 1000) / 60));
    return (
      <div className="animate-fade-in space-y-4 pb-4">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className="min-h-11 pr-2 text-sm text-brand-green">
            ‹ 戻る
          </button>
          <div className="min-w-0 flex-1 truncate text-right text-sm font-bold text-brand-ink">{title}</div>
        </div>

        <div className="card space-y-2 p-4">
          <h1 className="text-lg font-bold text-brand-ink">🎧 耳だけ復習</h1>
          <p className="text-sm leading-relaxed text-slate-600">{flowText(dir, gapSec)}</p>
          <p className="text-xs text-slate-400">
            {words.length}語 ・ 約{min}分 ・ 評価はしません（覚えた記録は変わりません）
          </p>
        </div>

        <div className="card divide-y divide-slate-100 p-3">
          <div className="flex items-center justify-between gap-3 px-1 py-2">
            <span className="text-sm font-medium text-brand-ink">向き</span>
            <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm" role="group" aria-label="向き">
              {(
                [
                  ["pt2ja", "葡 → 和"],
                  ["ja2pt", "和 → 葡"],
                ] as const
              ).map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setSettings({ handsfreeDirection: v })}
                  aria-pressed={dir === v}
                  className={`min-h-11 rounded px-3 ${dir === v ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 px-1 py-2">
            <span className="text-sm font-medium text-brand-ink">考える間</span>
            <div className="flex rounded-lg bg-slate-100 p-0.5 text-sm" role="group" aria-label="考える間">
              {HANDSFREE_GAPS_SEC.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSettings({ handsfreeGapSec: s })}
                  aria-pressed={gapSec === s}
                  className={`min-h-11 min-w-11 rounded px-2 ${gapSec === s ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}
                >
                  {s}秒
                </button>
              ))}
            </div>
          </div>
        </div>

        {!supported ? (
          <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-700">
            🔇 このブラウザでは読み上げが使えないため、耳だけ復習はできません。Android の Chrome で開いてください。
          </p>
        ) : (
          !jaVoice && (
            <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-700">
              日本語の音声が見つかりません。日本語は読み上げずに、画面に大きく表示します（1.5秒）。
            </p>
          )
        )}

        <button type="button" onClick={() => startRun(words)} disabled={!supported} className="btn-primary h-14 w-full text-base">
          ▶ スタート
        </button>
        <p className="text-xs leading-relaxed text-slate-400">
          再生中は画面が消えません。別のアプリに切り替えたり画面を消したりすると一時停止します。向き・考える間の変更は次の語から効きます。
        </p>
      </div>
    );
  }

  // ---------------- 終わりの一覧 ----------------
  if (stage === "done") {
    const listed = run.words.slice(0, run.reached);
    const markedWords = words.filter((w) => marked.has(w.id));
    return (
      <div className="animate-fade-in space-y-4 pb-4">
        <div className="flex items-center gap-2">
          <button type="button" onClick={onClose} className="min-h-11 pr-2 text-sm text-brand-green">
            ‹ 戻る
          </button>
          <div className="min-w-0 flex-1 truncate text-right text-sm font-bold text-brand-ink">{title}</div>
        </div>

        <div className="card space-y-1 p-4 text-center">
          <div className="text-2xl">🎧</div>
          <div className="text-lg font-bold text-brand-ink">{run.finished ? "おつかれさま！" : "ここまで聴きました"}</div>
          <p className="text-xs text-slate-500">
            この回 {listed.length}/{run.words.length}語{heard > 0 && ` ・ 聴き終えた語 のべ${heard}`}
          </p>
        </div>

        <p className="px-1 text-sm leading-relaxed text-slate-600">
          思い出せなかった・怪しかった語をタップして印をつけると、「1枚ずつで確認」で先頭に出します。
        </p>

        <ul className="space-y-2">
          {listed.map((w, i) => {
            const on = marked.has(w.id);
            return (
              <li
                key={`${w.id}#${i}`}
                className={`card flex items-center gap-1 pr-1 transition ${on ? "bg-amber-50 ring-amber-300" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => toggleMark(w.id)}
                  aria-pressed={on}
                  className="flex min-h-12 min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left"
                >
                  <MarkBox on={on} />
                  <span className="min-w-0">
                    <span className="block truncate font-bold text-brand-ink">{w.pt}</span>
                    <span className="block truncate text-xs text-slate-500">{w.ja}</span>
                  </span>
                </button>
                <SpeakerButton text={w.ptForSpeech} className="min-h-11 min-w-11" />
              </li>
            );
          })}
        </ul>

        <div className="space-y-2">
          <button type="button" onClick={() => onReview(markedFirst(words, marked))} className="btn-primary h-14 w-full flex-col gap-0 text-base">
            <span>1枚ずつで確認</span>
            <span className="text-[11px] font-medium opacity-90">
              {markedWords.length > 0
                ? `怪しかった語 ${markedWords.length}語を先頭に・全${words.length}語`
                : `全${words.length}語（評価は記録されます）`}
            </span>
          </button>
          {!run.finished && (
            <button type="button" onClick={() => play(run.words, posRef.current)} className="btn-ghost min-h-11 w-full text-sm">
              ▶ 続きから聴く（{Math.min(posRef.current + 1, run.words.length)}語目から）
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => startRun(markedWords)}
              disabled={markedWords.length === 0}
              className="btn-ghost min-h-11 px-2 text-sm"
            >
              🎧 印の語だけ聴く
            </button>
            <button type="button" onClick={() => startRun(words)} className="btn-ghost min-h-11 px-2 text-sm">
              🎧 最初から聴く
            </button>
          </div>
          <button type="button" onClick={onClose} className="min-h-11 w-full text-sm text-slate-500">
            閉じる（学習画面へ戻る）
          </button>
        </div>
      </div>
    );
  }

  // ---------------- 再生中・一時停止中 ----------------
  const w = cur ? run.words[cur.idx] : undefined;
  const total = run.words.length;
  const pos = cur ? cur.idx + 1 : 0;
  const shownAnswer = cur ? answerShown(cur.phase) : false;
  const ptVisible = !!cur && (cur.dir === "pt2ja" || shownAnswer);
  const jaVisible = !!cur && (cur.dir === "ja2pt" || shownAnswer);
  const on = !!w && marked.has(w.id);

  const ptBlock = w && (
    <div key="pt" className="min-h-[4.5rem] space-y-1">
      {ptVisible ? (
        <>
          <p className="break-words text-3xl font-extrabold leading-tight text-brand-ink">{w.pt}</p>
          {showKana && w.kana && <p className="text-sm text-slate-400">{w.kana}</p>}
        </>
      ) : (
        <p className="text-3xl font-extrabold text-slate-200" aria-label="ポルトガル語（まだ隠れています）">
          ？
        </p>
      )}
    </div>
  );
  const jaBlock = w && (
    <div key="ja" className="min-h-[4.5rem]">
      {jaVisible ? (
        <p
          className={`break-words font-bold leading-snug text-brand-ink ${
            cur?.jaShownOnly && cur.phase !== "think" ? "rounded-xl bg-brand-yellow/30 px-3 py-2 text-3xl" : "text-2xl"
          }`}
        >
          {w.ja || "（訳なし）"}
        </p>
      ) : (
        <p className="text-3xl font-extrabold text-slate-200" aria-label="日本語（まだ隠れています）">
          ？
        </p>
      )}
    </div>
  );

  return (
    <div className="pb-[calc(6rem+env(safe-area-inset-bottom))]">
      {/* フェードインは中身だけ（transform の間は fixed の操作バーの基準がずれるため、バーは外に置く） */}
      <div className="animate-fade-in space-y-3">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate text-sm font-bold text-brand-ink">🎧 {title}</div>
            <span className="text-xs tabular-nums text-slate-400">
              {pos}/{total}
            </span>
            <button type="button" onClick={() => finish(false)} className="min-h-11 px-2 text-xs font-medium text-rose-500">
              ■ 終了
            </button>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={pos}
          >
            <div className="h-full rounded-full bg-brand-green transition-all" style={{ width: `${total ? Math.round((pos / total) * 100) : 0}%` }} />
          </div>
        </div>

        <div className={`card flex min-h-[280px] flex-col gap-4 p-5 text-center ${on ? "ring-2 ring-amber-300" : ""}`}>
          {w && cur ? (
            <>
              <div className="flex items-center justify-between gap-2 text-xs text-slate-400">
                <span className="truncate">{w.category}</span>
                <span className="shrink-0 font-medium text-slate-500">{stage === "paused" ? "⏸ 一時停止中" : PHASE_LABEL[cur.phase]}</span>
              </div>
              <div className="flex flex-1 flex-col justify-center gap-4">
                {cur.dir === "ja2pt" ? [jaBlock, ptBlock] : [ptBlock, jaBlock]}
              </div>
              {stage === "playing" && cur.phase === "think" ? (
                <ThinkBar key={cur.key} ms={cur.thinkMs} />
              ) : (
                <div className="h-1.5" aria-hidden />
              )}
            </>
          ) : (
            <p className="m-auto text-sm text-slate-400">準備中…</p>
          )}
        </div>

        {w && (
          <button
            type="button"
            onClick={() => toggleMark(w.id)}
            aria-pressed={on}
            className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-medium ring-1 transition ${
              on ? "bg-amber-50 text-amber-700 ring-amber-300" : "bg-white text-slate-500 ring-slate-200"
            }`}
          >
            <MarkBox on={on} />
            怪しかった（あとで1枚ずつ確認）
          </button>
        )}

        <p className="text-center text-xs leading-relaxed text-slate-400">
          {stage === "paused"
            ? "再開すると、この語の最初から読み上げます。"
            : "画面を見なくても大丈夫。画面は消えません（別のアプリに切り替えると一時停止）。"}
        </p>
      </div>

      <ActionBar>
        <div className="grid grid-cols-4 gap-2">
          <button type="button" onClick={replay} className="btn-ghost h-14 flex-col gap-0 px-1 text-xs" aria-label="この語をもう一度">
            <span className="text-lg leading-none">↺</span>
            もう一度
          </button>
          <button
            type="button"
            onClick={stage === "paused" ? resume : pause}
            className={`btn col-span-2 h-14 text-base ${stage === "paused" ? "btn-primary" : "bg-slate-700 text-white"}`}
          >
            {stage === "paused" ? "▶ 再開" : "⏸ 一時停止"}
          </button>
          <button type="button" onClick={next} className="btn-ghost h-14 flex-col gap-0 px-1 text-xs" aria-label="次の語へ">
            <span className="text-lg leading-none">⏭</span>
            次へ
          </button>
        </div>
      </ActionBar>
    </div>
  );
}
