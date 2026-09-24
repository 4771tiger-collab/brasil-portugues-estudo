import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { PASSAGES } from "../data/content";
import type { Passage } from "../data/types";
import { useProgress } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { speedOptions, useSequencePlayer } from "../hooks/useSequencePlayer";
import { useVisibleStopwatch } from "../hooks/useActivityTimer";
import { useBack } from "../hooks/useBack";
import { elapsedSec } from "../services/activityClock";
import { groupChunks, type SentenceGroup } from "../services/sentenceGroups";

/** 一覧の URL。詳細は /practice/chunk/:id（id は custom_… か psg_…） */
const LIST_PATH = "/practice/chunk";

/** 全文再生1回・瞬間作文1周に記録する時間の上限（秒） */
const LOG_CAP_SEC = 600;

/** 全文再生の文と文の間（ms）。文の中はチャンクで区切らず1回の発話で読む */
const SENTENCE_GAP_MS = 400;

const LEVEL_LABEL: Record<Passage["level"], string> = { short: "短文", medium: "中文", long: "長文" };

/** いま声にしている範囲（チャンクの番号で [from, to)） */
interface Voiced {
  from: number;
  to: number;
  /** 文を通して読んでいるときはその文の番号。チャンク1つだけなら null */
  sentence: number | null;
}

/**
 * useSequencePlayer の activeIdx を「声にしている範囲」に直す。activeIdx の意味は再生のしかたで変わる:
 * - 全文再生（playing）: spoken の番号（読んでいる文）
 * - 1つだけの再生: チャンク数より小さければチャンクの番号、以上なら「チャンク数 + 文の番号」
 */
function voicedRange(
  activeIdx: number | null,
  playing: boolean,
  sentences: readonly SentenceGroup[],
  spoken: readonly number[],
  nChunks: number
): Voiced | null {
  if (activeIdx === null) return null;
  if (!playing && activeIdx < nChunks) return { from: activeIdx, to: activeIdx + 1, sentence: null };
  const gi: number | undefined = playing ? spoken[activeIdx] : activeIdx - nChunks;
  const g: SentenceGroup | undefined = gi === undefined ? undefined : sentences[gi];
  return g && gi !== undefined ? { from: g.start, to: g.end, sentence: gi } : null;
}

function Reader({ passage, onBack }: { passage: Passage; onBack: () => void }) {
  const settingsRate = useSettings((s) => s.rate);
  const initialRate = settingsRate > 0 ? settingsRate : 1;
  const speeds = useMemo(() => speedOptions(initialRate), [initialRate]);
  // 速さの初期値は設定の速さ（0.9 などなら、そのボタンを足して選んだ状態にする）
  const [speed, setSpeed] = useState(initialRate);
  const [showJaAll, setShowJaAll] = useState(false);
  const [jaFlips, setJaFlips] = useState<Set<number>>(new Set());
  // 瞬間作文: ポルトガル語を隠し、訳だけを見てチャンクごとに言ってから、タップで答えを確かめる。
  // 隠すかどうかは URL（?hide=pt、置き換え）に持つ。戻る操作や再読み込みでも同じ見え方で開き直せる
  const [params, setParams] = useSearchParams();
  const ptHidden = params.get("hide") === "pt";
  /** 隠しているときに答えを確かめたチャンクの番号 */
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  // 再生は共通のフック（どの再生も前の再生を止めてから始める。全文再生の間は Wake Lock、画面を離れたら停止）
  const player = useSequencePlayer({ rate: speed, gapMs: SENTENCE_GAP_MS });
  const { playing, activeIdx } = player;
  // 瞬間作文1周の所要時間（隠したときから、画面を見ていた時間だけ）。
  // 全文再生を最後まで流した時間はそちらで記録するので、1周の時間には入れない（二重に数えない）
  const lap = useVisibleStopwatch();
  /** 1周の所要時間のうち、全文再生を始める前までに数えた秒数 */
  const roundSecRef = useRef(0);

  const chunks = passage.chunks;
  const nChunks = chunks.length;
  /** 文末（. ! ? …）までのチャンクのまとまり。全文再生は1文を1回の発話で読む（自然な抑揚になる） */
  const sentences = useMemo(() => groupChunks(chunks), [chunks]);
  /** 全文再生で読む文の番号（本文の無い文は飛ばす） */
  const spoken = useMemo(() => sentences.flatMap((g, gi) => (g.pt ? [gi] : [])), [sentences]);
  /** 瞬間作文で答えを隠すチャンクの番号（本文の無いチャンクは除く） */
  const answerable = useMemo(() => chunks.flatMap((c, i) => (c.pt.trim() ? [i] : [])), [chunks]);

  const voiced = voicedRange(activeIdx, playing, sentences, spoken, nChunks);
  /** その文だけを通して読んでいる最中の文（全文再生中は null） */
  const soloSentence = !playing && voiced?.sentence != null ? voiced.sentence : null;
  const allRevealed = answerable.length > 0 && answerable.every((i) => revealed.has(i));

  const jaVisible = (i: number) => (showJaAll ? !jaFlips.has(i) : jaFlips.has(i));
  const toggleJa = (i: number) =>
    setJaFlips((s) => {
      const n = new Set(s);
      n.has(i) ? n.delete(i) : n.add(i);
      return n;
    });

  async function playAll() {
    const started = Date.now();
    // 1周の所要時間: 再生の前までの分を取っておく
    roundSecRef.current += lap(LOG_CAP_SEC);
    // 1文ずつ、チャンクをつないだ文を1回の発話で読む（1文目はクリック処理の中で読み始める）
    const completed = await player.playAll(spoken.map((gi) => sentences[gi].pt));
    // 学習ログ: 全文を最後まで流したとき（停止・チャンクや文のタップ・画面の移動では記録しない）
    if (completed) {
      useProgress.getState().logActivity("chunk", 1, elapsedSec(started, LOG_CAP_SEC));
      // 再生の時間は記録したので、1周の所要時間からは外す（途中で止めた再生は1周の時間に入れる）
      lap(0);
    }
  }

  /** チャンク1つだけ読む（全文再生の途中でも、止めてから読む） */
  function playChunk(i: number) {
    void player.playOne(chunks[i].pt, i);
  }

  /** 1文を通して読む（その文だけを読んでいる最中なら止める。全文再生の途中なら止めてこの文を読む） */
  function playSentence(gi: number) {
    if (soloSentence === gi) {
      player.stop();
      return;
    }
    void player.playOne(sentences[gi].pt, nChunks + gi);
  }

  /** 瞬間作文: 答え（ポルトガル語）を見せて読む。見せた後のタップは読み直すだけ */
  function reveal(i: number) {
    // 答えの音声はタップの処理の中で読み始める
    playChunk(i);
    if (revealed.has(i)) return;
    const next = new Set(revealed).add(i);
    setRevealed(next);
    // 学習ログ: 隠したチャンクをすべて確かめたら1周（隠してからの時間。最後まで流した全文再生の時間は除く）
    if (answerable.every((j) => next.has(j))) {
      const sec = Math.min(LOG_CAP_SEC, roundSecRef.current + lap(LOG_CAP_SEC));
      roundSecRef.current = 0;
      useProgress.getState().logActivity("chunk", 1, sec);
    }
  }

  /** 1周の所要時間を数え直す */
  function resetRound() {
    lap(0);
    roundSecRef.current = 0;
  }

  /** ポルトガル語を隠す／表示する（どちらも確かめた印は消す） */
  function setHidden(on: boolean) {
    setParams(on ? { hide: "pt" } : {}, { replace: true });
    setRevealed(new Set());
    // 所要時間は隠したときから数える（それまでの時間は捨てる）
    if (on) resetRound();
  }

  /** もう一周: 確かめた答えをすべて隠し直す */
  function rehide() {
    setRevealed(new Set());
    resetRound();
  }

  // 全文再生: 読んでいる文が画面の外なら、見える位置まで送る（見えていれば動かさない）
  const sentenceRefs = useRef<(HTMLLIElement | null)[]>([]);
  const readingSentence = playing ? voiced?.sentence ?? null : null;
  useEffect(() => {
    if (readingSentence === null) return;
    sentenceRefs.current[readingSentence]?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [readingSentence]);

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
        <button onClick={playing ? player.stop : () => void playAll()} className={`btn ${playing ? "bg-rose-500 text-white" : "btn-primary"} min-h-11 px-3 py-1.5 text-sm`}>
          {playing ? "■ 停止" : "▶ 全文再生"}
        </button>
        <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs" role="group" aria-label="再生の速さ">
          {speeds.map((s) => {
            const on = Math.abs(speed - s) < 0.001;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                aria-pressed={on}
                className={`min-h-11 min-w-11 rounded px-1.5 ${on ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}
              >
                {s.toFixed(1)}x
              </button>
            );
          })}
        </div>
        {/* 瞬間作文の間は訳が問題なので、訳の切替は出さない */}
        {!ptHidden && (
          <button onClick={() => { setShowJaAll((v) => !v); setJaFlips(new Set()); }} className="btn-ghost ml-auto min-h-11 px-3 py-1.5 text-sm">
            訳 {showJaAll ? "隠す" : "表示"}
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <button
          type="button"
          onClick={() => setHidden(!ptHidden)}
          aria-pressed={ptHidden}
          className={`chip min-h-11 px-3.5 ring-1 ${ptHidden ? "bg-brand-green text-white ring-brand-green" : "bg-white text-slate-600 ring-slate-200"}`}
        >
          {ptHidden ? "👁 ポルトガル語を表示" : "🙈 ポルトガル語を隠す"}
        </button>
        {ptHidden && (
          <>
            <button
              type="button"
              onClick={rehide}
              disabled={revealed.size === 0}
              className="chip min-h-11 bg-white px-3.5 text-slate-600 ring-1 ring-slate-200 disabled:opacity-40"
            >
              ↺ もう一度隠す
            </button>
            <span className={`ml-auto pr-1 ${allRevealed ? "font-bold text-brand-green" : "text-slate-400"}`} aria-live="polite">
              {allRevealed ? "✓ " : ""}確認 {revealed.size}/{answerable.length}
            </span>
          </>
        )}
      </div>

      <p className="text-xs leading-relaxed text-slate-400">
        {ptHidden
          ? "瞬間作文: 訳を見てポルトガル語で言ってみる → グレーの帯をタップで答えと音声を確認。文を言い切ったら左の ▶ でその文を通して聴けます。"
          : "意味のカタマリ（/）ごとに改行した1つの長文です。チャンクをタップでそのチャンクだけ、左の ▶ で1文を通して再生。「訳」で個別の意味確認（サイトトランスレーション）。"}
      </p>

      {/* 連結したスラッシュ長文（文ごとにまとめ、左の ▶ でその文を1回の発話で読む） */}
      <div className="card p-3">
        <ol className="space-y-1.5">
          {sentences.map((g, gi) => {
            const reading = voiced?.sentence === gi;
            const solo = soloSentence === gi;
            // scroll-m: 全文再生で送るときの余白（上はヘッダーと固定バー、下は下部ナビの分）
            return (
              <li
                key={gi}
                ref={(el) => {
                  sentenceRefs.current[gi] = el;
                }}
                className={`flex scroll-mb-24 scroll-mt-[calc(var(--hdr,53px)+7rem)] gap-1 rounded-xl transition ${
                  reading ? "ring-2 ring-emerald-300" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => playSentence(gi)}
                  disabled={!g.pt}
                  aria-pressed={solo}
                  aria-label={solo ? `${gi + 1}文目を止める` : `${gi + 1}文目を通して再生`}
                  className={`flex min-h-11 w-11 shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg transition active:scale-95 disabled:opacity-30 disabled:active:scale-100 ${
                    solo ? "bg-brand-green text-white" : "bg-slate-50 text-brand-green"
                  }`}
                >
                  <span className={`text-[10px] font-bold leading-none ${solo ? "text-white/80" : "text-slate-400"}`}>{gi + 1}</span>
                  <span className="text-sm leading-none">{solo ? "■" : "▶"}</span>
                </button>
                <div className="min-w-0 flex-1 space-y-0.5 py-0.5">
                  {chunks.slice(g.start, g.end).map((c, k) => {
                    const i = g.start + k;
                    // 声にしている範囲（全文再生・文の再生なら文のチャンクすべて、タップならそのチャンク）
                    const on = voiced !== null && i >= voiced.from && i < voiced.to;
                    const pt = c.pt.trim();
                    const ja = (c.ja ?? "").trim();
                    if (ptHidden && pt) {
                      return (
                        <div key={i} className={`rounded-lg px-2 py-1 transition ${on ? "bg-emerald-100" : ""}`}>
                          {/* 問題: 訳 */}
                          <p className={`text-[15px] leading-relaxed ${ja ? "text-slate-700" : "text-slate-300"}`}>{ja || "（訳なし）"}</p>
                          {revealed.has(i) ? (
                            <button
                              type="button"
                              onClick={() => playChunk(i)}
                              className="flex min-h-11 w-full animate-fade-in items-center gap-1.5 text-left text-[17px] font-medium leading-snug text-brand-ink"
                            >
                              <span>{c.pt}</span>
                              <span className="select-none text-lg font-bold text-brand-green/40">/</span>
                            </button>
                          ) : (
                            // 答えは暗記シートのように帯で隠す（帯の長さだけが手がかり）
                            <button
                              type="button"
                              onClick={() => reveal(i)}
                              aria-label={`答えを表示: ${ja || `${i + 1}番目のチャンク`}`}
                              className="flex min-h-11 w-full items-center text-left"
                            >
                              <span
                                aria-hidden
                                className="select-none rounded bg-slate-200 px-1 text-[17px] font-medium leading-snug text-transparent box-decoration-clone"
                              >
                                {c.pt}
                              </span>
                            </button>
                          )}
                        </div>
                      );
                    }
                    return (
                      <div key={i} className={`rounded-lg px-2 py-1 transition ${on ? "bg-emerald-100" : "hover:bg-slate-50"}`}>
                        <div className="flex items-baseline gap-1.5">
                          {/* 全文再生の途中でも、止めてからこのチャンクだけを読む */}
                          <button
                            onClick={() => playChunk(i)}
                            className="text-left text-[17px] font-medium leading-relaxed text-brand-ink"
                          >
                            {c.pt}
                          </button>
                          <span className="select-none text-lg font-bold text-brand-green/40">/</span>
                          {/* 押せる範囲は 44px。行の高さは増やさない（上下の余白に食い込ませる） */}
                          {!ptHidden && (
                            <button
                              onClick={() => toggleJa(i)}
                              className="-my-1.5 ml-auto flex min-h-11 min-w-11 shrink-0 items-center justify-center self-center text-[11px] text-brand-blue"
                            >
                              {jaVisible(i) ? "訳を隠す" : "訳"}
                            </button>
                          )}
                        </div>
                        {(ptHidden ? ja !== "" : jaVisible(i)) && <div className="pl-1 text-sm text-slate-500">{c.ja}</div>}
                      </div>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ol>
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
        <p className="text-sm text-slate-500">意味のカタマリ（/）ごとに、前から理解する練習。ポルトガル語を隠せば、訳からチャンクごとに言う瞬間作文にも。</p>
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
