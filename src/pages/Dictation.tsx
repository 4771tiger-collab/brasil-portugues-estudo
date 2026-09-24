import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { DICTATIONS } from "../data/content";
import type { DictationItem } from "../data/types";
import { useSettings } from "../store/useSettings";
import { audio } from "../services/audio";
import { toKana } from "../services/pronunciation";
import { alignTokens, type Alignment } from "../services/grade";
import { isKnownForm } from "../services/gradeLexicon";
import {
  alignCounts,
  answerView,
  learnerView,
  splitSentences,
  stepHint,
  type TokenKind,
} from "../services/dictation";
import SpeakerButton from "../components/SpeakerButton";
import PtInput from "../components/PtInput";
import { useBack } from "../hooks/useBack";
import { useWakeLock } from "../hooks/useWakeLock";
import { useVisibleStopwatch } from "../hooks/useActivityTimer";
import { useProgress } from "../store/useProgress";
import { LEVEL_FILTERS, LEVEL_LABEL, groupByLevel, parseLevelFilter, type LevelFilter } from "../services/materials";
import FilterChips from "../components/FilterChips";

/** 一覧の URL。詳細は /practice/dictation/:id（id は DICTATIONS の id） */
const LIST_PATH = "/practice/dictation";

/** 採点1回に記録する時間の上限（秒）。これより長い分は放置とみなす */
const GRADE_CAP_SEC = 600;

/** 全文の順次再生で、文と文の間に置く時間（ms） */
const SENTENCE_GAP_MS = 500;


/** 再生速度の選択肢（null = 設定の速さ） */
const SPEEDS: { rate: number | null; label: string }[] = [
  { rate: null, label: "通常" },
  { rate: 0.8, label: "0.8x" },
  { rate: 0.6, label: "0.6x" },
];

/** 会話文の先頭のダッシュ（— Oi, …）は読み上げない */
const forSpeech = (s: string) => s.replace(/^[—–-]\s*/, "");

/** 採点（語単位の対応付け。1語抜けても後ろがずれない。アクセント違いは「惜しい」、別の実在語は×） */
const gradeText = (input: string, text: string): Alignment => alignTokens(input, text, { isKnownForm });

/** 結果の色（○ 正しい・△ 惜しい・× 違う・抜けた語・余分な語） */
const KIND_STYLE: Record<TokenKind, { cls: string; label: string }> = {
  exact: { cls: "bg-emerald-100 text-emerald-700", label: "正しい" },
  accent: { cls: "bg-amber-100 text-amber-700", label: "惜しい（アクセント記号）" },
  typo: { cls: "bg-amber-100 text-amber-700", label: "惜しい（つづり）" },
  wrong: { cls: "bg-rose-100 text-rose-600", label: "違う" },
  missing: { cls: "bg-slate-100 font-mono tracking-wide text-slate-400", label: "抜けた語" },
  extra: { cls: "bg-rose-50 text-rose-400 line-through", label: "余分な語" },
};

// ---------------------------------------------------------------------------
// 再生（全文の順次再生・文ごとの再生・速さ）
// ---------------------------------------------------------------------------

interface Player {
  sentences: string[];
  /** 再生中の文（全文再生・1文の再生とも。止まっていれば null） */
  activeIdx: number | null;
  /** 全文の順次再生中か */
  playingAll: boolean;
  speedIdx: number;
  setSpeedIdx: (i: number) => void;
  playAll: () => void;
  playOne: (i: number) => void;
  stop: () => void;
}

/** 本文の再生。文ごとに分けて読み上げ、全文は speakSequence で順に流す（途中で止められる） */
function usePlayer(text: string): Player {
  const voiceURI = useSettings((s) => s.voiceURI);
  const settingsRate = useSettings((s) => s.rate);
  const sentences = useMemo(() => splitSentences(text), [text]);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [playingAll, setPlayingAll] = useState(false);
  const [speedIdx, setSpeedIdx] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // 再生のたびに増やす。前の再生が終わったときに、新しい再生の表示を消さないため
  const tokRef = useRef(0);
  // 全文再生の間は画面を消さない
  useWakeLock(playingAll);

  const rate = SPEEDS[speedIdx]?.rate ?? (settingsRate || 1);

  function stop() {
    tokRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    audio.cancel();
    setPlayingAll(false);
    setActiveIdx(null);
  }

  async function playAll() {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const tok = ++tokRef.current;
    setPlayingAll(true);
    try {
      await audio.speakSequence(sentences.map(forSpeech), {
        rate,
        voiceURI,
        gapMs: SENTENCE_GAP_MS,
        onIndex: (i) => {
          if (tokRef.current === tok) setActiveIdx(i);
        },
        signal: ctrl.signal,
      });
    } finally {
      if (tokRef.current === tok) {
        abortRef.current = null;
        setPlayingAll(false);
        setActiveIdx(null);
      }
    }
  }

  async function playOne(i: number) {
    // 全文再生中なら止めてから、その文だけを読む（クリック処理の中で speak を呼ぶ）
    abortRef.current?.abort();
    abortRef.current = null;
    const tok = ++tokRef.current;
    setPlayingAll(false);
    setActiveIdx(i);
    try {
      await audio.speak(forSpeech(sentences[i] ?? ""), { rate, voiceURI });
    } finally {
      if (tokRef.current === tok) setActiveIdx(null);
    }
  }

  // 画面を離れたら止める
  useEffect(
    () => () => {
      tokRef.current++;
      abortRef.current?.abort();
      audio.cancel();
    },
    []
  );

  return {
    sentences,
    activeIdx,
    playingAll,
    speedIdx,
    setSpeedIdx,
    playAll: () => void playAll(),
    playOne: (i) => void playOne(i),
    stop,
  };
}

/** 全文再生・停止と速さの切替 */
function PlayControls({ p, label = "▶ 全文を再生" }: { p: Player; label?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={p.playingAll ? p.stop : p.playAll}
        className={`btn ${p.playingAll ? "bg-rose-500 text-white" : "btn-primary"} min-h-11 flex-1 px-3 py-2 text-sm`}
      >
        {p.playingAll ? "■ 停止" : label}
      </button>
      <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs" role="group" aria-label="再生の速さ">
        {SPEEDS.map((s, i) => (
          <button
            key={s.label}
            type="button"
            onClick={() => p.setSpeedIdx(i)}
            aria-pressed={p.speedIdx === i}
            className={`min-h-11 min-w-11 rounded px-2 ${p.speedIdx === i ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 文ごとの再生ボタン（STEP1・3 では本文を見せないので番号だけ） */
function SentenceButtons({ p }: { p: Player }) {
  if (p.sentences.length < 2) return null;
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-slate-400">1文ずつ聴く（{p.sentences.length}文）</div>
      <div className="flex flex-wrap gap-1.5">
        {p.sentences.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => p.playOne(i)}
            aria-label={`${i + 1}文目を再生`}
            className={`min-h-11 min-w-11 rounded-xl px-3 text-sm font-medium ring-1 transition active:scale-95 ${
              p.activeIdx === i ? "bg-emerald-100 text-emerald-700 ring-emerald-300" : "bg-white text-brand-ink ring-slate-200"
            }`}
          >
            ▶ {i + 1}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 結果の表示
// ---------------------------------------------------------------------------

/** STEP1・3 の結果: 入力した語の色分けと件数だけ（抜けた語は頭文字マスク。正しい綴りは STEP4 で見せる） */
function Result({ al }: { al: Alignment }) {
  const c = alignCounts(al);
  const view = learnerView(al);
  const pct = c.total ? Math.round((c.correct / c.total) * 100) : 0;
  const kinds = (["exact", "accent", "wrong", "missing", "extra"] as const).filter((k) =>
    view.some((t) => t.kind === k || (k === "accent" && t.kind === "typo"))
  );
  return (
    <div className="space-y-2 rounded-xl bg-slate-50 p-3">
      <div className="flex items-center justify-between">
        <span className="font-bold text-brand-ink">
          正解 {c.correct}/{c.total}語
        </span>
        <span className={`font-bold ${pct >= 80 ? "text-emerald-600" : pct >= 50 ? "text-amber-600" : "text-rose-600"}`}>{pct}%</span>
      </div>
      <div className="text-xs text-slate-500">
        惜しい {c.partial} ・ 違う {c.wrong} ・ 抜け {c.missing}
        {c.extra > 0 && ` ・ 余分 ${c.extra}`}
      </div>
      <div className="flex flex-wrap gap-1">
        {view.map((t, i) => (
          <span key={i} title={KIND_STYLE[t.kind].label} className={`chip text-sm ${KIND_STYLE[t.kind].cls}`}>
            {t.text}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-400">
        {kinds.map((k) => (
          <span key={k} className="inline-flex items-center gap-1">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${KIND_STYLE[k].cls}`} />
            {k === "accent" ? "惜しい（アクセント・つづり）" : k === "missing" ? "抜けた語（頭文字）" : KIND_STYLE[k].label}
          </span>
        ))}
      </div>
      <p className="border-t border-slate-200 pt-2 text-xs text-slate-400">正しい綴りと全文は STEP 4 で確認できます。</p>
    </div>
  );
}

/** STEP4 の答え合わせ: 本文の語を直前の採点で色分けし、違った語には入力した形を添える */
function AnswerCompare({ al, label }: { al: Alignment; label: string }) {
  const view = answerView(al);
  return (
    <div className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-100">
      <div className="text-xs font-bold text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-1">
        {view.map((t, i) => (
          <span
            key={i}
            title={KIND_STYLE[t.kind].label}
            // 抜けた語はここでは綴りを見せる（点線の下線で「書けなかった語」と分かるように）
            className={`chip flex-col items-start text-sm ${
              t.kind === "missing" ? "bg-slate-100 text-slate-600 underline decoration-dotted underline-offset-4" : KIND_STYLE[t.kind].cls
            }`}
          >
            <span>{t.text}</span>
            {t.got !== undefined && <span className="text-[10px] font-normal text-slate-500 line-through">{t.got}</span>}
          </span>
        ))}
      </div>
      <p className="text-[11px] text-slate-400">小さな取り消し線は、あなたが書いた形。点線の下線は書けなかった語です。</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4ステップ
// ---------------------------------------------------------------------------

function Runner({ item, onBack }: { item: DictationItem; onBack: () => void }) {
  const [step, setStep] = useState(1);
  const [input1, setInput1] = useState("");
  const [input3, setInput3] = useState("");
  // 採点の結果（答え合わせした時点の入力で固定する。「書き直す」で消す）
  const [al1, setAl1] = useState<Alignment | null>(null);
  const [al3, setAl3] = useState<Alignment | null>(null);
  // 学習ログ: 採点のたびに、開いてから（前回の採点から）画面を見ていた時間を記録する
  const lap = useVisibleStopwatch();
  const logGrade = () => useProgress.getState().logActivity("dictation", 1, lap(GRADE_CAP_SEC));
  const player = usePlayer(item.text);

  // STEP3 のヒント: STEP1 で正しく書けた語はそのまま、それ以外は頭文字マスク
  const hint = useMemo(() => stepHint(item.text, al1), [item.text, al1]);
  const rows = item.level === "long" ? 4 : item.level === "medium" ? 3 : 2;

  function grade1() {
    if (al1 || !input1.trim()) return;
    setAl1(gradeText(input1, item.text));
    logGrade();
  }
  function grade3() {
    if (al3 || !input3.trim()) return;
    setAl3(gradeText(input3, item.text));
    logGrade();
  }

  const steps = ["聴き取り", "語彙予習", "ヒント入力", "訳・定着"];
  const multi = player.sentences.length > 1;
  // STEP4 の答え合わせに使う採点（STEP3 を優先）
  const lastAl = al3 ?? al1;

  return (
    <div className="animate-fade-in space-y-4">
      <button onClick={onBack} className="min-h-11 pr-2 text-sm text-brand-green">‹ 一覧</button>

      {/* ステップ表示 */}
      <div className="flex items-center gap-1">
        {steps.map((s, i) => (
          <div key={i} className="flex flex-1 flex-col items-center">
            <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${step === i + 1 ? "bg-brand-green text-white" : step > i + 1 ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
              {i + 1}
            </div>
            <div className={`mt-1 text-[10px] ${step === i + 1 ? "font-bold text-brand-ink" : "text-slate-400"}`}>{s}</div>
          </div>
        ))}
      </div>

      <div className="card space-y-3 p-4">
        {/* STEP 1 */}
        {step === 1 && (
          <>
            <h2 className="font-bold text-brand-ink">STEP 1: 聴き取り（ヒントなし）</h2>
            <p className="text-xs text-slate-400">
              音声を聴いて、聞こえたポルトガル語を入力しましょう。{multi && "番号のボタンで1文ずつ聴けます。"}
            </p>
            <PlayControls p={player} />
            <SentenceButtons p={player} />
            {/* Enter は改行（打ちかけで採点して残りの語のマスクを見せないよう、答え合わせはボタンだけ） */}
            <PtInput
              multiline
              rows={rows}
              value={input1}
              onChange={setInput1}
              readOnly={!!al1}
              placeholder="ここに入力…"
              aria-label="聴き取った文（ポルトガル語）"
            />
            {!al1 ? (
              <button onClick={grade1} disabled={!input1.trim()} className="btn-primary min-h-11 w-full py-2">
                答え合わせ
              </button>
            ) : (
              <>
                <Result al={al1} />
                <button onClick={() => setAl1(null)} className="btn-ghost min-h-11 w-full py-2 text-sm">
                  書き直す
                </button>
              </>
            )}
          </>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <>
            <h2 className="font-bold text-brand-ink">STEP 2: 重要語彙の予習</h2>
            <p className="text-xs text-slate-400">例文に含まれる重要な語を確認しましょう。</p>
            <div className="space-y-2">
              {item.keyVocab.length === 0 && <p className="text-sm text-slate-400">この例文に登録された重要語はありません。</p>}
              {item.keyVocab.map((v, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg bg-slate-50 p-3">
                  <div className="flex-1">
                    <div className="font-bold text-brand-ink">{v.pt}</div>
                    <div className="text-xs text-slate-400">{toKana(v.pt)}</div>
                    <div className="text-sm text-slate-500">{v.ja}</div>
                  </div>
                  <SpeakerButton text={v.pt} />
                </div>
              ))}
            </div>
          </>
        )}

        {/* STEP 3 */}
        {step === 3 && (
          <>
            <h2 className="font-bold text-brand-ink">STEP 3: ヒントあり入力</h2>
            <p className="text-xs text-slate-400">
              {al1
                ? "STEP 1 で正しく書けた語はそのまま、それ以外の語は頭文字と文字数だけを見せています。"
                : "頭文字と文字数を手がかりに入力しましょう（STEP 1 で答え合わせをすると、正しく書けた語はそのまま表示されます）。"}
            </p>
            <div className="break-words rounded-lg bg-slate-50 p-3 font-mono text-lg tracking-wide text-slate-600">{hint}</div>
            <PlayControls p={player} />
            <SentenceButtons p={player} />
            <PtInput
              multiline
              rows={rows}
              value={input3}
              onChange={setInput3}
              readOnly={!!al3}
              placeholder="頭文字と文字数を手がかりに入力…"
              aria-label="ヒントを見て書いた文（ポルトガル語）"
            />
            {!al3 ? (
              <button onClick={grade3} disabled={!input3.trim()} className="btn-primary min-h-11 w-full py-2">
                答え合わせ
              </button>
            ) : (
              <>
                <Result al={al3} />
                <button onClick={() => setAl3(null)} className="btn-ghost min-h-11 w-full py-2 text-sm">
                  書き直す
                </button>
              </>
            )}
          </>
        )}

        {/* STEP 4 */}
        {step === 4 && (
          <>
            <h2 className="font-bold text-brand-ink">STEP 4: 訳の確認＋オーバーラッピング</h2>
            <div className="space-y-1 rounded-lg bg-emerald-50 p-2">
              {player.sentences.map((s, i) => (
                <div
                  key={i}
                  className={`flex items-start gap-1 rounded-lg px-1 py-1 transition ${player.activeIdx === i ? "bg-emerald-100" : ""}`}
                >
                  <button
                    type="button"
                    onClick={() => player.playOne(i)}
                    aria-label={`${i + 1}文目を再生`}
                    className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-brand-green transition hover:bg-brand-green/10 active:scale-90"
                  >
                    ▶
                  </button>
                  <div className="min-w-0 flex-1 py-1.5">
                    <div className="text-lg font-bold leading-snug text-brand-ink">{s}</div>
                    <div className="text-xs text-slate-400">{toKana(forSpeech(s))}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-lg bg-slate-50 p-3 text-slate-600">{item.ja}</div>
            {lastAl && <AnswerCompare al={lastAl} label={al3 ? "STEP 3 の答え合わせ" : "STEP 1 の答え合わせ"} />}
            <div className="space-y-2 rounded-xl bg-brand-green/5 p-3">
              <p className="text-xs text-slate-500">
                🔁 仕上げ：本文を見ながら、音声に<strong>合わせて同時に声に出して</strong>読みましょう（オーバーラッピング）。発音・リズムが定着します。
              </p>
              <PlayControls p={player} label="▶ 音声に合わせて音読" />
            </div>
          </>
        )}
      </div>

      {/* ナビゲーション */}
      <div className="flex gap-2">
        <button onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1} className="btn-ghost min-h-11 flex-1 py-2.5">‹ 前へ</button>
        <button onClick={() => setStep((s) => Math.min(4, s + 1))} disabled={step === 4} className="btn-primary min-h-11 flex-1 py-2.5">次へ ›</button>
      </div>
    </div>
  );
}

/**
 * 詳細画面（/practice/dictation/:id）。URL の ID で問題を開く。
 * Android の戻る操作で一覧に戻れるよう、画面の切替は state ではなくルートで行う。
 * 見つからない ID は一覧へ置き換えで戻す。
 */
export function DictationDetail() {
  const { id } = useParams();
  const item = DICTATIONS.find((d) => d.id === id);
  const back = useBack(LIST_PATH);

  if (!item) return <Navigate to={LIST_PATH} replace />;
  // 別の問題へ移ったら入力やステップを持ち越さないよう作り直す
  return <Runner key={item.id} item={item} onBack={back} />;
}

/** 難易度ごとのまとまり（一覧の見出しと「第n問」の番号。番号は難易度の中の順） */
const DICTATION_GROUPS = groupByLevel(DICTATIONS);

export default function Dictation() {
  // 難易度の絞り込みは URL（?level=）に持つ。一覧は詳細を開くとアンマウントされるので、
  // state だと戻ったときに「すべて」に戻ってしまう。履歴を増やさないよう replace で書き換える
  const [params, setParams] = useSearchParams();
  const level = parseLevelFilter(params.get("level"));
  const setLevel = (v: LevelFilter) => setParams(v === "all" ? {} : { level: v }, { replace: true });
  const groups = level === "all" ? DICTATION_GROUPS : DICTATION_GROUPS.filter((g) => g.level === level);
  const options = LEVEL_FILTERS.map((o) => ({
    ...o,
    count: o.v === "all" ? DICTATIONS.length : DICTATION_GROUPS.find((g) => g.level === o.v)?.items.length ?? 0,
  }));

  return (
    <div className="animate-fade-in space-y-4">
      <Link to="/practice" className="inline-flex min-h-11 items-center pr-2 text-sm text-brand-green">‹ 練習に戻る</Link>
      <div>
        <h1 className="text-xl font-bold text-brand-ink">ディクテーション</h1>
        <p className="text-sm text-slate-500">音声を聴いて書き取る、4ステップの集中学習。</p>
      </div>
      <FilterChips label="難易度" options={options} value={level} onChange={setLevel} />
      <p className="text-xs text-slate-400">※ 一覧では答え（本文・和訳）は伏せています。挑戦してから答え合わせしましょう。</p>
      {groups.length === 0 && <p className="card p-4 text-center text-sm text-slate-400">この難易度の問題はありません。</p>}
      {groups.map((g) => (
        <section key={g.level} className="space-y-2" aria-labelledby={`dct-${g.level}`}>
          <h2 id={`dct-${g.level}`} className="px-1 text-xs font-bold text-slate-400">
            {LEVEL_LABEL[g.level]}（{g.items.length}問）
          </h2>
          <div className="space-y-2">
            {g.items.map((d, i) => (
              <Link key={d.id} to={`${LIST_PATH}/${encodeURIComponent(d.id)}`} className="card flex w-full items-center gap-3 p-3 text-left transition hover:ring-brand-green/40">
                <span className="text-xl">{d.isDialogue ? "💬" : "✍️"}</span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-brand-ink">
                    {LEVEL_LABEL[g.level]} 第{i + 1}問{d.isDialogue ? "（会話）" : ""}
                  </div>
                  <div className="text-xs text-slate-400">音声を聴いて書き取り（約{d.text.split(/\s+/).length}語）</div>
                </div>
                <span className="text-slate-300">›</span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
