import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { PASSAGES } from "../data/content";
import type { Passage } from "../data/types";
import { useProgress } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { audio } from "../services/audio";
import { useWakeLock } from "../hooks/useWakeLock";
import { useBack } from "../hooks/useBack";
import { elapsedSec } from "../services/activityClock";

/** 一覧の URL。詳細は /practice/chunk/:id（id は custom_… か psg_…） */
const LIST_PATH = "/practice/chunk";

/** 全文再生1回に記録する時間の上限（秒） */
const LOG_CAP_SEC = 600;

const SPEEDS = [0.8, 1.0, 1.2];

const LEVEL_LABEL: Record<Passage["level"], string> = { short: "短文", medium: "中文", long: "長文" };

function Reader({ passage, onBack }: { passage: Passage; onBack: () => void }) {
  const voiceURI = useSettings((s) => s.voiceURI);
  const settingsRate = useSettings((s) => s.rate);
  const [showJaAll, setShowJaAll] = useState(false);
  const [jaFlips, setJaFlips] = useState<Set<number>>(new Set());
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(settingsRate || 1);
  const abortRef = useRef<AbortController | null>(null);
  // 全文再生の間は画面を消さない
  useWakeLock(playing);

  const jaVisible = (i: number) => (showJaAll ? !jaFlips.has(i) : jaFlips.has(i));
  const toggleJa = (i: number) =>
    setJaFlips((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  function stop() {
    abortRef.current?.abort();
    audio.cancel();
    setPlaying(false);
    setActiveIdx(null);
  }
  async function playAll() {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPlaying(true);
    const started = Date.now();
    try {
      await audio.speakSequence(
        passage.chunks.map((c) => c.pt),
        { rate: speed, voiceURI, gapMs: 250, onIndex: setActiveIdx, signal: ctrl.signal }
      );
      // 学習ログ: 全文を最後まで流したとき（停止・画面の移動では記録しない）
      if (!ctrl.signal.aborted && audio.isSupported()) {
        useProgress.getState().logActivity("chunk", 1, elapsedSec(started, LOG_CAP_SEC));
      }
    } finally {
      if (!ctrl.signal.aborted) {
        setPlaying(false);
        setActiveIdx(null);
      }
    }
  }
  useEffect(() => () => stop(), []);

  return (
    <div className="animate-fade-in space-y-4">
      <button onClick={onBack} className="min-h-11 pr-2 text-sm text-brand-green">‹ 一覧</button>
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-bold text-brand-ink">{passage.title}</h1>
        <span className="chip bg-slate-100 text-slate-500">{LEVEL_LABEL[passage.level]}</span>
        {passage.source !== "original" && <span className="chip bg-amber-100 text-amber-600">取込</span>}
      </div>

      {/* top はヘッダーの実高さ --hdr。ボタンは指で押せる 44px 以上 */}
      <div className="sticky top-[var(--hdr,53px)] z-10 -mx-4 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white/95 px-4 py-1.5 backdrop-blur">
        <button onClick={playing ? stop : playAll} className={`btn ${playing ? "bg-rose-500 text-white" : "btn-primary"} min-h-11 px-3 py-1.5 text-sm`}>
          {playing ? "■ 停止" : "▶ 全文再生"}
        </button>
        <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs">
          {SPEEDS.map((s) => (
            <button key={s} onClick={() => setSpeed(s)} className={`min-h-11 min-w-11 rounded px-1.5 ${speed === s ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}>
              {s.toFixed(1)}x
            </button>
          ))}
        </div>
        <button onClick={() => { setShowJaAll((v) => !v); setJaFlips(new Set()); }} className="btn-ghost ml-auto min-h-11 px-3 py-1.5 text-sm">
          訳 {showJaAll ? "隠す" : "表示"}
        </button>
      </div>

      <p className="text-xs text-slate-400">
        意味のカタマリ（/）ごとに改行した1つの長文です。チャンクをタップで音声、「訳」で個別の意味確認（サイトトランスレーション）。
      </p>

      {/* 連結したスラッシュ長文 */}
      <div className="card p-4">
        <div className="space-y-0.5">
          {passage.chunks.map((c, i) => (
            <div
              key={i}
              className={`rounded-lg px-2 py-1 transition ${activeIdx === i ? "bg-emerald-100" : "hover:bg-slate-50"}`}
            >
              <div className="flex items-baseline gap-1.5">
                <button
                  onClick={() => audio.speak(c.pt, { rate: speed, voiceURI })}
                  className="text-left text-[17px] font-medium leading-relaxed text-brand-ink"
                >
                  {c.pt}
                </button>
                <span className="select-none text-lg font-bold text-brand-green/40">/</span>
                {/* 押せる範囲は 44px。行の高さは増やさない（上下の余白に食い込ませる） */}
                <button
                  onClick={() => toggleJa(i)}
                  className="-my-1.5 ml-auto flex min-h-11 min-w-11 shrink-0 items-center justify-center self-center text-[11px] text-brand-blue"
                >
                  {jaVisible(i) ? "訳を隠す" : "訳"}
                </button>
              </div>
              {jaVisible(i) && <div className="pl-1 text-sm text-slate-500">{c.ja}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 自作教材を先頭に、同梱の教材を続けた一覧（一覧と詳細の ID 解決で共通） */
function useAllPassages(): Passage[] {
  const customPassages = useProgress((s) => s.customPassages);
  return useMemo(() => [...customPassages, ...PASSAGES], [customPassages]);
}

/**
 * 詳細画面（/practice/chunk/:id）。URL の ID で教材を開く。
 * Android の戻る操作で一覧に戻れるよう、画面の切替は state ではなくルートで行う。
 * 見つからない ID（削除した自作教材など）は一覧へ置き換えで戻す。
 */
export function ChunkReadingDetail() {
  const { id } = useParams();
  const all = useAllPassages();
  const passage = all.find((p) => p.id === id);
  const back = useBack(LIST_PATH);

  if (!passage) return <Navigate to={LIST_PATH} replace />;
  // 別の教材へ移ったら再生状態などを持ち越さないよう作り直す
  return <Reader key={passage.id} passage={passage} onBack={back} />;
}

export default function ChunkReading() {
  const all = useAllPassages();

  return (
    <div className="animate-fade-in space-y-4">
      <Link to="/practice" className="text-sm text-brand-green">‹ 練習に戻る</Link>
      <div>
        <h1 className="text-xl font-bold text-brand-ink">チャンクリーディング</h1>
        <p className="text-sm text-slate-500">意味のカタマリ（/）ごとに、前から理解する練習。</p>
      </div>
      <div className="space-y-2">
        {all.map((p) => (
          <Link key={p.id} to={`${LIST_PATH}/${encodeURIComponent(p.id)}`} className="card flex w-full items-center gap-3 p-3 text-left transition hover:ring-brand-green/40">
            <span className="text-xl">📖</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-brand-ink">{p.title}</div>
              <div className="text-xs text-slate-400">{LEVEL_LABEL[p.level]} ・ {p.chunks.length}チャンク</div>
            </div>
            {p.source !== "original" && <span className="chip bg-amber-100 text-amber-600">取込</span>}
            <span className="text-slate-300">›</span>
          </Link>
        ))}
      </div>
      <Link to="/practice/add" className="btn-ghost w-full">➕ 教材を追加する</Link>
    </div>
  );
}
