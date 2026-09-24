import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PATTERNS } from "../data/content";
import type { Pattern } from "../data/types";
import SayItButton from "../components/SayItButton";
import SpeakerButton from "../components/SpeakerButton";
import { audio, delay } from "../services/audio";
import { speechInput } from "../services/speechInput";
import { toKana } from "../services/pronunciation";
import {
  SELF_RATINGS,
  fillSlot,
  frameParts,
  interleave,
  newDrill,
  optionJa,
  patternItems,
  rateEntry,
  slotOptions,
  summarizeDrill,
  type DrillEntry,
  type PatternItem,
  type SelfRating,
} from "../services/patternDrill";
import { useVisibleStopwatch } from "../hooks/useActivityTimer";
import { useSequencePlayer } from "../hooks/useSequencePlayer";
import { useWakeLock } from "../hooks/useWakeLock";
import { useProgress } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { frameBlank, patternGroups } from "../services/materials";

/** 1文に記録する時間の上限（秒）。前の文からこれより空いた分は放置とみなす */
const SENTENCE_CAP_SEC = 60;

/** 発話ドリルの問題数（全文型から混ぜて出す） */
const DRILL_SIZE = 10;

/** 発話ドリルの考える時間（ms）。過ぎても自動では答えを出さない（音声はタップの処理の中で始める） */
const THINK_MS = 3000;

/** 答えの「ゆっくり」の速さ */
const SLOW_RATE = 0.7;

/** オートの考える時間の選択肢（秒）と既定値 */
const AUTO_GAPS_SEC = [2, 3, 5] as const;
const DEFAULT_AUTO_GAP_SEC = 3;

/** オート: ポルトガル語を読んだ後、次の文へ進むまでの間（ms）。答えを見て言い直す分 */
const AUTO_AFTER_MS = 1500;

/** ドリル・オートで出す文（すべての文型 × 選択肢） */
const ALL_ITEMS: PatternItem[] = patternItems(PATTERNS);

/** 見て覚えるの一覧（「カポエイラ：誘う」のようなカテゴリは「：」の前でまとめる） */
const PATTERN_GROUPS = patternGroups(PATTERNS);

/** 練習のしかた（URL の ?mode=。既定は browse） */
type Mode = "browse" | "drill" | "auto";

const MODES: { id: Mode; label: string }[] = [
  { id: "browse", label: "見て覚える" },
  { id: "drill", label: "発話ドリル" },
  { id: "auto", label: "オート" },
];

const MODE_DESC: Record<Mode, string> = {
  browse: "文型をタップして開き、スロットの語を入れ替えて口に馴染ませよう。",
  drill: `和文を見て、3秒でポルトガル語を口に出す → 答えと音声で確認 → 自己評価。全文型から${DRILL_SIZE}問、言えなかった文は最後にもう一度出ます。`,
  auto: "和文 → 考える間 → ポルトガル語の音声 を自動でくり返します。画面を見ながら、手を使わずに練習できます。",
};

function parseMode(v: string | null): Mode {
  return v === "drill" || v === "auto" ? v : "browse";
}

/** 自己評価のボタンと結果の印 */
const RATING_UI: Record<SelfRating, { label: string; mark: string; btn: string; text: string }> = {
  said: { label: "言えた", mark: "○", btn: "bg-emerald-50 text-emerald-600 ring-emerald-200", text: "text-emerald-600" },
  close: { label: "惜しい", mark: "△", btn: "bg-amber-50 text-amber-600 ring-amber-200", text: "text-amber-500" },
  missed: { label: "言えなかった", mark: "×", btn: "bg-rose-50 text-rose-600 ring-rose-200", text: "text-rose-500" },
};

/** 入れ替え部分を強調したポルトガル語の文 */
function SlotSentence({ pattern, value }: { pattern: Pattern; value: string }) {
  return (
    <>
      {frameParts(pattern.frame, value).map((part, i) =>
        part.slot ? (
          <span key={i} className="rounded bg-brand-yellow/40 px-1 text-brand-ink">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  );
}

/**
 * 考える時間の輪（マウントした時点から ms かけて減る）。0 になったら onDone を1回呼ぶ。
 * 次の問題では key を変えて作り直す
 */
function CountdownRing({ ms, onDone }: { ms: number; onDone?: () => void }) {
  const [left, setLeft] = useState(ms);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const t0 = Date.now();
    setLeft(ms);
    const id = setInterval(() => {
      const l = Math.max(0, ms - (Date.now() - t0));
      setLeft(l);
      if (l === 0) {
        clearInterval(id);
        doneRef.current?.();
      }
    }, 100);
    return () => clearInterval(id);
  }, [ms]);

  const r = 30;
  const c = 2 * Math.PI * r;
  const frac = ms > 0 ? left / ms : 0;
  const sec = Math.ceil(left / 1000);
  return (
    <div className="relative h-20 w-20" role="timer" aria-label={left > 0 ? `残り${sec}秒` : "時間です"}>
      <svg viewBox="0 0 72 72" className="h-full w-full -rotate-90" aria-hidden>
        <circle cx="36" cy="36" r={r} fill="none" strokeWidth="6" className="stroke-slate-100" />
        <circle
          cx="36"
          cy="36"
          r={r}
          fill="none"
          strokeWidth="6"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          className="stroke-brand-green transition-[stroke-dashoffset] duration-100 ease-linear"
        />
      </svg>
      <span aria-hidden className="absolute inset-0 flex items-center justify-center text-2xl font-bold text-brand-ink">
        {left > 0 ? sec : "🗣️"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 見て覚える（文型ごとのカード。スロットの語をタップで入れ替える）
// ---------------------------------------------------------------------------

function PatternCard({ pattern, onSentence }: { pattern: Pattern; onSentence: () => void }) {
  const options = slotOptions(pattern);
  const showKana = useSettings((s) => s.showKana);
  const [idx, setIdx] = useState(0);
  const [showJa, setShowJa] = useState(true);
  const opt = options[idx] ?? options[0];

  const sentence = opt ? fillSlot(pattern.frame, opt.pt) : "";
  // 和文は選択肢の jaFull（自然な全文）があればそれ。無ければ型に差し込む
  const sentenceJa = opt ? optionJa(pattern, opt) : "";
  const kana = useMemo(() => toKana(sentence), [sentence]);

  // 学習ログ: 文（入れ替え語）ごとに1回だけ。音声を聴いた・訳を開いたときに数える
  const practiced = useRef(new Set<number>());
  const mark = () => {
    if (practiced.current.has(idx)) return;
    practiced.current.add(idx);
    onSentence();
  };

  /** 今と違う選択肢をランダムに選ぶ */
  const shuffleOne = () => {
    const n = options.length;
    if (n > 1) setIdx((idx + 1 + Math.floor(Math.random() * (n - 1))) % n);
  };

  if (!opt) return null;

  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="chip bg-brand-blue/10 font-bold text-brand-blue">{pattern.category}</span>
        <button onClick={shuffleOne} className="-my-2 min-h-11 px-2 text-xs text-slate-400">
          🔀 ランダム
        </button>
      </div>

      <div className="rounded-xl bg-slate-50 p-4 text-center">
        <div className="flex items-center justify-center gap-1">
          <span className="text-xl font-bold text-brand-ink">
            <SlotSentence pattern={pattern} value={opt.pt} />
          </span>
          <SpeakerButton text={sentence} onPlay={mark} className="h-11 w-11 shrink-0" />
        </div>
        {/* カナは設定（カナを表示）に従う */}
        {showKana && <div className="mt-1 text-xs text-slate-400">{kana}</div>}
        <button
          onClick={() => {
            if (!showJa) mark();
            setShowJa((v) => !v);
          }}
          className="mt-1 min-h-11 px-2 text-sm"
        >
          {showJa ? <span className="text-slate-600">{sentenceJa}</span> : <span className="text-brand-blue">訳を表示</span>}
        </button>
      </div>

      {pattern.note && <p className="text-xs text-slate-400">💡 {pattern.note}</p>}

      <div>
        <div className="mb-1 text-xs font-medium text-slate-400">入れ替え語（タップ）</div>
        <div className="flex flex-wrap gap-1.5">
          {options.map((o, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              aria-pressed={i === idx}
              className={`chip min-h-11 px-3 ring-1 transition ${
                i === idx ? "bg-brand-green text-white ring-brand-green" : "bg-white text-slate-600 ring-slate-200"
              }`}
            >
              {o.pt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 見て覚えるの一覧。文型は見出し（カテゴリ・型・和文の型）だけを並べ、タップで開く（開くのは1つだけ）。
 * 文型が増えても一覧で見渡せるように。開いている文型は URL（?open=、置き換え）に持つ
 */
function PatternBrowser({ onSentence }: { onSentence: () => void }) {
  const [params, setParams] = useSearchParams();
  const q = params.get("open");
  const openId = q && PATTERNS.some((p) => p.id === q) ? q : null;
  const setOpen = (id: string | null) => setParams(id ? { open: id } : {}, { replace: true });
  const titled = PATTERN_GROUPS.length > 1;

  return (
    <div className="space-y-4">
      {PATTERN_GROUPS.map((g) => (
        <section key={g.name ?? ""} className="space-y-2">
          {titled && (
            <h2 className="px-1 text-xs font-bold text-slate-400">
              {g.name ?? "基本の文型"}（{g.entries.length}）
            </h2>
          )}
          {g.entries.map(({ pattern, label }) => {
            const open = pattern.id === openId;
            return (
              <div key={pattern.id} className="space-y-2">
                <button
                  type="button"
                  onClick={() => setOpen(open ? null : pattern.id)}
                  aria-expanded={open}
                  className={`card flex min-h-11 w-full items-center gap-3 p-3 text-left transition ${open ? "ring-brand-green/50" : "hover:ring-brand-green/40"}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold text-brand-blue">{label}</div>
                    <div className="truncate font-medium text-brand-ink">{frameBlank(pattern.frame)}</div>
                    <div className="truncate text-xs text-slate-400">{frameBlank(pattern.ja)}</div>
                  </div>
                  <span className={`inline-block text-slate-300 transition ${open ? "rotate-90" : ""}`} aria-hidden>
                    ›
                  </span>
                </button>
                {open && <PatternCard pattern={pattern} onSentence={onSentence} />}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 発話ドリル（和文を見る → 3秒 → 答えと音声 → 自己評価。言えなかった文は最後にもう一度）
// ---------------------------------------------------------------------------

function DrillResult({ queue, onRestart, onBrowse }: { queue: DrillEntry[]; onRestart: () => void; onBrowse: () => void }) {
  const s = summarizeDrill(queue);
  /** 再出題の自己評価（文の id → 評価。まだなら null） */
  const retryOf = new Map(queue.filter((e) => e.retry).map((e) => [e.item.id, e.rating] as const));
  const retryPlanned = retryOf.size;
  const retryDone = s.retry.said + s.retry.close + s.retry.missed;
  const rows = queue.filter((e) => !e.retry && e.rating);

  return (
    <div className="animate-fade-in space-y-4">
      <div className="card bg-gradient-to-br from-brand-green to-emerald-600 p-6 text-center text-white">
        <div className="text-sm opacity-90">発話ドリルの結果</div>
        <div className="my-1 text-5xl font-extrabold">
          {s.first.said}/{s.answered}
        </div>
        <div className="text-sm opacity-90">
          言えた {s.first.said} ・ 惜しい {s.first.close} ・ 言えなかった {s.first.missed}
        </div>
        {s.answered < s.planned && (
          <div className="mt-1 text-xs opacity-80">
            {s.planned}問中 {s.answered}問で中断
          </div>
        )}
        {retryPlanned > 0 && (
          <div className="mt-1 text-xs opacity-80">
            もう一度: 言えた {s.retry.said}/{retryDone}
            {retryDone < retryPlanned ? `（${retryPlanned}問中 ${retryDone}問）` : ""}
          </div>
        )}
      </div>

      <h2 className="px-1 text-sm font-bold text-slate-500">ふり返り</h2>
      <div className="space-y-2">
        {rows.map((e) => {
          const ui = RATING_UI[e.rating!];
          const again = retryOf.get(e.item.id);
          return (
            <div key={e.item.id} className={`card flex items-center gap-3 p-3 ${e.rating === "missed" ? "ring-1 ring-rose-200" : ""}`}>
              <div className="flex w-10 shrink-0 flex-col items-center leading-tight" aria-label={`${ui.label}${again ? ` → もう一度: ${RATING_UI[again].label}` : ""}`}>
                <span className={`text-lg ${ui.text}`}>{ui.mark}</span>
                {again && <span className={`text-[11px] ${RATING_UI[again].text}`}>→{RATING_UI[again].mark}</span>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-brand-ink">
                  <SlotSentence pattern={e.item.pattern} value={e.item.option.pt} />
                </div>
                <div className="text-xs text-slate-500">{e.item.ja}</div>
              </div>
              <SpeakerButton text={e.item.pt} className="h-11 w-11 shrink-0" />
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        <button onClick={onBrowse} className="btn-ghost min-h-11 flex-1 py-3">
          見て覚える
        </button>
        <button onClick={onRestart} className="btn-primary min-h-11 flex-1 py-3">
          新しい{DRILL_SIZE}問
        </button>
      </div>
    </div>
  );
}

function Drill({ onBrowse }: { onBrowse: () => void }) {
  const showKana = useSettings((s) => s.showKana);
  // 音声認識の「🎤 言ってみる」（T2-8。オフなら何も出さない）
  const speechOn = useSettings((s) => s.speechInputEnabled) && speechInput.isSupported();
  const [queue, setQueue] = useState<DrillEntry[]>(() => newDrill(ALL_ITEMS, DRILL_SIZE));
  const [pos, setPos] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
  const [finished, setFinished] = useState(false);
  /** 出題のたびに増やす（考える時間の輪を作り直す） */
  const [turn, setTurn] = useState(0);
  // 答えの音声（どの再生も前の再生を止めてから始める。画面を離れたら停止）
  const player = useSequencePlayer();
  // 1問の所要時間（前の問題から画面を見ていた時間。上限つき）
  const lap = useVisibleStopwatch();

  const entry: DrillEntry | undefined = queue[pos];
  const pt = entry?.item.pt ?? "";
  const kana = useMemo(() => (pt ? toKana(pt) : ""), [pt]);

  function next(q: DrillEntry[], p: number) {
    setRevealed(false);
    setTimeUp(false);
    setTurn((t) => t + 1);
    if (p >= q.length) setFinished(true);
    else setPos(p);
  }

  /** 「🎤 言ってみる」の聞き取りを取りやめる（答えの音声を認識に拾わせない）。音声認識がオフなら何もしない */
  function stopListening() {
    if (useSettings.getState().speechInputEnabled) speechInput.cancel();
  }

  /**
   * 答え: ポルトガル語を見せて読む（音声はタップの処理の中で読み始める）。
   * 「🎤 言ってみる」の採点の後にも呼ぶ（🎤 のタップでページは操作済みなので、Chrome は読み上げを許す）
   */
  function reveal() {
    if (!entry || revealed) return;
    stopListening();
    void player.playOne(entry.item.pt, 0);
    setRevealed(true);
  }

  /** 答えをもう一度・ゆっくり（同じボタンで再生中なら止める） */
  function replay(slow: boolean) {
    if (!entry) return;
    stopListening();
    const idx = slow ? 1 : 0;
    if (player.activeIdx === idx) {
      player.stop();
      return;
    }
    void player.playOne(entry.item.pt, idx, slow ? { rate: SLOW_RATE } : undefined);
  }

  function rate(r: SelfRating) {
    if (!entry || !revealed) return;
    player.stop();
    // 学習ログ: 自己評価した1問ごと（再出題も数える）
    useProgress.getState().logActivity("pattern", 1, lap(SENTENCE_CAP_SEC));
    const q = rateEntry(queue, pos, r);
    setQueue(q);
    next(q, pos + 1);
  }

  /** やめる: 1問でも評価していれば結果へ、まだなら「見て覚える」に戻る */
  function quit() {
    player.stop();
    if (queue.some((e) => e.rating)) setFinished(true);
    else onBrowse();
  }

  function restart() {
    player.stop();
    setQueue(newDrill(ALL_ITEMS, DRILL_SIZE));
    setPos(0);
    setRevealed(false);
    setTimeUp(false);
    setFinished(false);
    setTurn((t) => t + 1);
    // 結果を見ていた時間は数えない
    lap(0);
  }

  if (finished) return <DrillResult queue={queue} onRestart={restart} onBrowse={onBrowse} />;
  if (!entry) return <p className="card p-4 text-sm text-slate-500">出題できる文がありません。</p>;

  const { item } = entry;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={quit} className="min-h-11 pr-2 text-sm text-brand-green">
          ‹ やめる
        </button>
        <div className="flex items-center gap-2 text-sm font-bold text-slate-500">
          {entry.retry && <span className="chip bg-amber-100 text-amber-700">もう一度</span>}
          {pos + 1} / {queue.length}
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-brand-green transition-all" style={{ width: `${((pos + 1) / queue.length) * 100}%` }} />
      </div>

      <div key={turn} className="card animate-fade-in space-y-4 p-5 text-center">
        <span className="chip bg-brand-blue/10 font-bold text-brand-blue">{item.pattern.category}</span>
        {/* 問題: 和文 */}
        <p className="text-xl font-bold leading-relaxed text-brand-ink">{item.ja}</p>

        {!revealed ? (
          <div className="flex flex-col items-center gap-2">
            <CountdownRing ms={THINK_MS} onDone={() => setTimeUp(true)} />
            <p className="text-xs text-slate-400" aria-live="polite">
              {timeUp
                ? "言えたら（言えなくても）答えを確認しよう"
                : speechOn
                  ? "ポルトガル語で言ってみよう（🎤 で判定もできます）"
                  : "ポルトガル語で口に出して言ってみよう"}
            </p>
          </div>
        ) : (
          <div className="animate-fade-in space-y-2 rounded-xl bg-slate-50 p-4">
            {/* 答え: 入れ替えた部分を強調 */}
            <p className="text-xl font-bold leading-relaxed text-brand-ink">
              <SlotSentence pattern={item.pattern} value={item.option.pt} />
            </p>
            {showKana && <p className="text-xs text-slate-400">{kana}</p>}
            <div className="flex justify-center gap-2 pt-1">
              <button onClick={() => replay(false)} aria-pressed={player.activeIdx === 0} className="btn-ghost min-h-11 px-3 text-sm">
                {player.activeIdx === 0 ? "■ 止める" : "▶ もう一度"}
              </button>
              <button onClick={() => replay(true)} aria-pressed={player.activeIdx === 1} className="btn-ghost min-h-11 px-3 text-sm">
                {player.activeIdx === 1 ? "■ 止める" : "🐢 ゆっくり"}
              </button>
            </div>
            {item.pattern.note && <p className="pt-1 text-left text-xs text-slate-400">💡 {item.pattern.note}</p>}
          </div>
        )}
        {/* 🎤 言ってみる（音声認識がオンのときだけ出る）。採点したら答えを開く。答えの後も言い直せる */}
        <SayItButton mode="sentence" expected={item.pt} onStart={() => player.stop()} onScored={() => reveal()} />
      </div>

      {!revealed ? (
        <button onClick={reveal} className="btn-primary min-h-12 w-full py-3 text-base">
          答え
        </button>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="自己評価">
            {SELF_RATINGS.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => rate(r)}
                className={`flex h-14 items-center justify-center rounded-lg px-1 text-sm font-bold ring-1 transition active:scale-95 ${RATING_UI[r].btn}`}
              >
                {RATING_UI[r].label}
              </button>
            ))}
          </div>
          {!entry.retry && <p className="text-center text-[11px] text-slate-400">「言えなかった」文は、最後にもう一度出ます</p>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// オート（和文 → 考える間 → ポルトガル語の音声 → 次へ、を止めるまで自動でくり返す）
// ---------------------------------------------------------------------------

/** オートでいま出している文 */
interface AutoCurrent {
  item: PatternItem;
  /** 周の中の番号（1から）と、1周の文の数 */
  no: number;
  total: number;
  /** 何周目か（1から） */
  round: number;
  /** think = 和文を見て考えている、say = ポルトガル語を読んでいる（読んだ後） */
  phase: "think" | "say";
  /** 考える時間（ms。この文を出したときの値） */
  gapMs: number;
  /** 出すたびに増やす（考える時間の輪を作り直す） */
  key: number;
}

function AutoDrill() {
  const showKana = useSettings((s) => s.showKana);
  const [gapSec, setGapSec] = useState<number>(DEFAULT_AUTO_GAP_SEC);
  const gapRef = useRef(gapSec);
  gapRef.current = gapSec;
  const [running, setRunning] = useState(false);
  const [cur, setCur] = useState<AutoCurrent | null>(null);
  /** このオートで読んだ文の数 */
  const [spoken, setSpoken] = useState(0);
  const ctrlRef = useRef<AbortController | null>(null);
  /** 出す順（1周分）・次に出す位置・周の番号。止めても残し、再開はその文から */
  const orderRef = useRef<PatternItem[]>([]);
  const posRef = useRef(0);
  const roundRef = useRef(0);
  const keyRef = useRef(0);
  /** 画面を離れた後に state を触らないための印 */
  const aliveRef = useRef(true);
  // 1文の所要時間（前の文から画面を見ていた時間。上限つき）
  const lap = useVisibleStopwatch();
  // 動いている間は画面を消さない
  useWakeLock(running);

  const stop = useCallback(() => {
    const c = ctrlRef.current;
    ctrlRef.current = null;
    c?.abort();
    audio.cancel();
    setRunning(false);
  }, []);

  async function loop(ctrl: AbortController) {
    const { signal } = ctrl;
    try {
      while (!signal.aborted) {
        // 1周したら、順番を変えて次の周へ（前の周の最後と同じ文型からは始めない）
        if (posRef.current >= orderRef.current.length) {
          const last = orderRef.current[orderRef.current.length - 1];
          orderRef.current = interleave(ALL_ITEMS, ALL_ITEMS.length, Math.random, last?.pattern.id);
          posRef.current = 0;
          roundRef.current += 1;
          if (orderRef.current.length === 0) return;
        }
        const item = orderRef.current[posRef.current];
        const base = {
          item,
          no: posRef.current + 1,
          total: orderRef.current.length,
          round: roundRef.current,
          gapMs: gapRef.current * 1000,
          key: ++keyRef.current,
        };
        // 和文を見て考える
        setCur({ ...base, phase: "think" });
        await delay(base.gapMs, signal);
        // ポルトガル語を見せて読む（スタートのタップで、ページはすでに操作済み）
        setCur({ ...base, phase: "say" });
        const s = useSettings.getState();
        await audio.speak(item.pt, { rate: s.rate > 0 ? s.rate : 1, voiceURI: s.voiceURI });
        if (signal.aborted) return;
        // 学習ログ: 読み終えた1文ごと
        useProgress.getState().logActivity("pattern", 1, lap(SENTENCE_CAP_SEC));
        setSpoken((n) => n + 1);
        posRef.current += 1;
        await delay(AUTO_AFTER_MS, signal);
      }
    } catch {
      // 止めた（間の待ちが AbortError で終わった）
    } finally {
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null;
        if (aliveRef.current) setRunning(false);
      }
    }
  }

  function start() {
    if (ctrlRef.current) return;
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRunning(true);
    // 止めていた間の時間は数えない
    lap(0);
    void loop(ctrl);
  }

  // 画面が隠れたら止める（和文が見えないまま進まないように）
  useEffect(() => {
    if (!running) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [running, stop]);

  // 画面を離れたら止める（state は更新しない）
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      const c = ctrlRef.current;
      ctrlRef.current = null;
      if (c) {
        c.abort();
        audio.cancel();
      }
    };
  }, []);

  const curKana = useMemo(() => (cur && showKana ? toKana(cur.item.pt) : ""), [cur, showKana]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={running ? stop : start}
          className={`btn ${running ? "bg-rose-500 text-white" : "btn-primary"} min-h-11 px-4 text-sm`}
        >
          {running ? "■ 停止" : cur ? "▶ 再開" : "▶ スタート"}
        </button>
        <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs" role="group" aria-label="考える時間">
          <span className="px-1.5 text-slate-400">考える時間</span>
          {AUTO_GAPS_SEC.map((s) => {
            const on = gapSec === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setGapSec(s)}
                aria-pressed={on}
                className={`min-h-11 min-w-11 rounded px-1.5 ${on ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}
              >
                {s}秒
              </button>
            );
          })}
        </div>
      </div>

      <div className="card flex min-h-[240px] flex-col items-center justify-center gap-4 p-5 text-center">
        {cur ? (
          <>
            <div className="flex w-full items-center justify-between gap-2 text-xs text-slate-400">
              <span className="chip bg-brand-blue/10 font-bold text-brand-blue">{cur.item.pattern.category}</span>
              <span>
                {cur.round > 1 ? `${cur.round}周目 ・ ` : ""}
                {cur.no} / {cur.total}
              </span>
            </div>
            <p className="text-xl font-bold leading-relaxed text-brand-ink">{cur.item.ja}</p>
            {cur.phase === "think" ? (
              running ? (
                <div className="flex flex-col items-center gap-2">
                  <CountdownRing key={cur.key} ms={cur.gapMs} />
                  <p className="text-xs text-slate-400">ポルトガル語で言ってみよう</p>
                </div>
              ) : (
                <p className="text-sm text-slate-400">⏸ 停止中（再開すると、この文から）</p>
              )
            ) : (
              <div key={cur.key} className="w-full animate-fade-in space-y-1 rounded-xl bg-slate-50 p-4">
                <p className="text-xl font-bold leading-relaxed text-brand-ink">
                  <SlotSentence pattern={cur.item.pattern} value={cur.item.option.pt} />
                </p>
                {showKana && <p className="text-xs text-slate-400">{curKana}</p>}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm leading-relaxed text-slate-500">
            ▶ スタートで、全{ALL_ITEMS.length}文を文型を混ぜた順に出します。
            <br />
            和文を見て言ってみる → 音声で答え合わせ、を止めるまでくり返します。
          </p>
        )}
      </div>

      <p className="text-xs leading-relaxed text-slate-400">
        動いている間は画面が消えません。別のアプリに切り替えたり画面を消したりすると止まります。考える時間の変更は次の文から効きます。
        {spoken > 0 && ` 読んだ文: ${spoken}`}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function PatternPractice() {
  const [params, setParams] = useSearchParams();
  const mode = parseMode(params.get("mode"));
  // 1文ごとの所要時間は、前の文から（最初は開いてから）画面を見ていた時間（上限つき）
  const lap = useVisibleStopwatch();
  const onSentence = useCallback(
    () => useProgress.getState().logActivity("pattern", 1, lap(SENTENCE_CAP_SEC)),
    [lap]
  );

  /** 練習のしかたを変える（URL の ?mode=、置き換え。browse は既定なので付けない） */
  const setMode = useCallback(
    (m: Mode) => {
      // ほかのモードで過ごした時間を「見て覚える」の1文目に数えない
      lap(0);
      setParams(m === "browse" ? {} : { mode: m }, { replace: true });
    },
    [lap, setParams]
  );
  const toBrowse = useCallback(() => setMode("browse"), [setMode]);

  return (
    <div className="animate-fade-in space-y-4">
      <Link to="/practice" className="inline-flex min-h-11 items-center pr-2 text-sm text-brand-green">
        ‹ 練習に戻る
      </Link>
      <div>
        <h1 className="text-xl font-bold text-brand-ink">パターンプラクティス</h1>
        <p className="text-sm text-slate-500">{MODE_DESC[mode]}</p>
      </div>

      <div className="flex rounded-xl bg-slate-100 p-1 text-sm" role="group" aria-label="練習のしかた">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => m.id !== mode && setMode(m.id)}
            aria-pressed={mode === m.id}
            className={`min-h-11 flex-1 rounded-lg px-2 transition ${
              mode === m.id ? "bg-white font-bold text-brand-ink shadow-sm" : "text-slate-500"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode !== "browse" && !audio.isSupported() && (
        <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-700">
          🔇 このブラウザでは読み上げが使えません。答えは画面で確かめてください。
        </p>
      )}

      {mode === "drill" ? (
        <Drill onBrowse={toBrowse} />
      ) : mode === "auto" ? (
        <AutoDrill />
      ) : (
        <PatternBrowser onSentence={onSentence} />
      )}
    </div>
  );
}
