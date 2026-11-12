import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, Lightbulb, Snail, Volume2 } from "lucide-react";
import type { Rating, SrsCard } from "../../data/types";
import { newCard, previewInterval } from "../../srs/scheduler";
import { useSettings } from "../../store/useSettings";
import { audio } from "../../services/audio";
import { scoreSpeechSentence, hintText, type SpeechSentenceScore } from "../../services/grade";
import { sentenceListenTimeoutMs, type SpeechResult } from "../../services/speechInput";
import { toKana } from "../../services/pronunciation";
import { sentenceContext, useTeacherUi } from "../../services/ai/teacherContext";
import { answersOf, ratingFromPercent, type SayItem } from "../../speak/catalog";
import AskTeacherButton from "../teacher/AskTeacherButton";
import MicButton, { micSupported } from "./MicButton";
import ScoreView from "./ScoreView";
import { speakPt } from "./speakPt";

/** 口慣らしの評価（3段階。言えなかった = again / 惜しい = hard / 言えた = good） */
export const SAY_RATINGS: { rating: Rating; label: string; cls: string; strong: string }[] = [
  { rating: "again", label: "言えなかった", cls: "bg-rose-50 text-rose-600 ring-rose-200", strong: "ring-2 ring-rose-500" },
  { rating: "hard", label: "惜しい", cls: "bg-amber-50 text-amber-700 ring-amber-200", strong: "ring-2 ring-amber-500" },
  { rating: "good", label: "言えた", cls: "bg-emerald-50 text-emerald-700 ring-emerald-200", strong: "ring-2 ring-emerald-500" },
];

interface Props {
  item: SayItem;
  /** 今のカード（次回までの目安を出す。無ければ新しいカードとして出す） */
  card?: SrsCard;
  /** 評価したら呼ぶ */
  onRate: (rating: Rating) => void;
  /** 評価ボタンに次回までの目安を出さない（レッスンの中など） */
  hideIntervals?: boolean;
}

/**
 * 口慣らしの1枚: 日本語を見て → ポルトガル語を声に出して言う → 答えとお手本 → 自分で評価。
 * 🎤 が使えれば、言った文を聞き取って採点し、おすすめの評価を強調する（選ぶのは自分）。
 * 使えない・使わないときは「言ってから 答えを見る」で自己評価する。
 * キー操作: Space = 答えを見る、1〜3 = 評価、R = お手本をもう一度。
 */
export default function SayCard({ item, card, onRate, hideIntervals = false }: Props) {
  const showKana = useSettings((s) => s.showKana);
  const autoPlay = useSettings((s) => s.autoPlayOnReveal);
  const [revealed, setRevealed] = useState(false);
  const [hint, setHint] = useState(0);
  const [score, setScore] = useState<SpeechSentenceScore | null>(null);
  /** 答えを見る前の最初の採点から決めたおすすめ（答えを見た後の言い直しでは変えない） */
  const [suggested, setSuggested] = useState<Rating | undefined>(undefined);
  const answers = useMemo(() => answersOf(item), [item]);
  const kana = useMemo(() => (showKana ? toKana(item.pt) : ""), [showKana, item.pt]);
  const timeoutMs = useMemo(() => sentenceListenTimeoutMs(answers), [answers]);
  const mic = micSupported();
  const revealedRef = useRef(revealed);
  revealedRef.current = revealed;
  const hintRef = useRef(hint);
  hintRef.current = hint;

  // 次の文に替わったら最初の状態に戻す（親は key を変えて作り直してもよい）
  useEffect(() => {
    setRevealed(false);
    setHint(0);
    setScore(null);
    setSuggested(undefined);
    return () => audio.cancel();
  }, [item.id]);

  function reveal(play = true) {
    setRevealed(true);
    if (play && autoPlay) void speakPt(item.pt);
  }

  function onHeard(r: SpeechResult) {
    const s = scoreSpeechSentence(r.transcripts, answers);
    setScore(s);
    if (!revealedRef.current) {
      setSuggested(ratingFromPercent(s.percent, hintRef.current > 0));
      reveal();
    }
  }

  // キー操作（PC）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      // 先生のシートを開いている間は、後ろのカードを操作しない
      if (useTeacherUi.getState().open) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      // ボタンにフォーカスがあるときの Space / Enter は、そのボタンの操作（ヒントなど）に任せる
      const onButton = !!t && (t.tagName === "BUTTON" || t.tagName === "A");
      if (!revealedRef.current) {
        if ((e.key === " " || e.key === "Enter") && !onButton) {
          e.preventDefault();
          reveal();
        }
        return;
      }
      if (e.key === "r" || e.key === "R") void speakPt(item.pt);
      const i = ["1", "2", "3"].indexOf(e.key);
      if (i >= 0) onRate(SAY_RATINGS[i].rating);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, onRate]);

  const base = card ?? newCard();
  return (
    <div className="animate-fade-in space-y-4">
      <div className="card space-y-4 p-5 text-center">
        <span className="chip bg-slate-100 text-slate-500">{item.label}</span>
        <p className="text-xs text-slate-400">{revealed ? "お手本をまねて、もう一度声に出そう" : "ポルトガル語で、声に出して言ってみよう"}</p>
        <p className={`font-bold leading-relaxed text-brand-ink ${revealed ? "text-base" : "text-2xl"}`}>{item.ja}</p>

        {!revealed && hint > 0 && (
          <p className="rounded-lg bg-amber-50 px-3 py-2 font-mono text-base tracking-wide text-amber-800" aria-label="ヒント">
            {hintText(item.pt, hint === 1 ? 1 : 2)}
          </p>
        )}

        {revealed && (
          <div className="space-y-2 border-t border-dashed border-slate-200 pt-4">
            <p className="text-2xl font-bold leading-snug text-brand-green" lang="pt-BR">
              {item.pt}
            </p>
            {kana && <p className="text-sm text-slate-400">{kana}</p>}
            <div className="flex items-center justify-center gap-2">
              <button type="button" onClick={() => void speakPt(item.pt)} className="btn-ghost min-h-11 px-3 text-sm" aria-label="お手本を聞く">
                <Volume2 size={18} aria-hidden />
                お手本
              </button>
              <button type="button" onClick={() => void speakPt(item.pt, { slow: true })} className="btn-ghost min-h-11 px-3 text-sm" aria-label="ゆっくり聞く">
                <Snail size={18} aria-hidden />
                ゆっくり
              </button>
            </div>
            {item.alt?.length ? (
              <p className="text-xs text-slate-500" lang="pt-BR">
                <span lang="ja">ほかの言い方: </span>
                {item.alt.join(" ／ ")}
              </p>
            ) : null}
            {item.note && <p className="rounded-lg bg-slate-50 px-3 py-2 text-left text-xs leading-relaxed text-slate-600">💡 {item.note}</p>}
            {score && <ScoreView score={score} compact />}
          </div>
        )}
      </div>

      {!revealed ? (
        <div className="space-y-3">
          {/* 答えの前と後で別の 🎤 にする（key）。答えを見ると前の 🎤 が外れて聞き取りを止めるので、お手本の読み上げを拾わない */}
          {mic && <MicButton key="before" onResult={onHeard} timeoutMs={timeoutMs} hint="押して話す → 採点して答えを表示" />}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setHint((h) => Math.min(2, h + 1))}
              disabled={hint >= 2}
              className="btn-ghost min-h-12 px-3 text-sm"
            >
              <Lightbulb size={18} aria-hidden />
              ヒント
            </button>
            <button type="button" onClick={() => reveal()} className={`${mic ? "btn-ghost" : "btn-primary"} min-h-12 flex-1`}>
              <Eye size={18} aria-hidden />
              {mic ? "言ってから 答えを見る" : "声に出して言ったら 答えを見る"}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {mic && <MicButton key="after" size="md" onResult={onHeard} timeoutMs={timeoutMs} hint="もう一度言ってみる" />}
          <div className="grid grid-cols-3 gap-2">
            {SAY_RATINGS.map((b, i) => (
              <button
                key={b.rating}
                type="button"
                onClick={() => onRate(b.rating)}
                className={`relative flex h-14 flex-col items-center justify-center rounded-xl px-1 ring-1 transition active:scale-95 ${b.cls} ${
                  suggested === b.rating ? `${b.strong} shadow-sm` : ""
                }`}
              >
                {suggested === b.rating && (
                  <span className="pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-brand-ink px-1.5 text-[9px] font-bold leading-4 text-white">
                    おすすめ
                  </span>
                )}
                <span className="text-sm font-bold">
                  <span className="mr-1 hidden align-middle text-[10px] font-normal opacity-60 md:inline">{i + 1}</span>
                  {b.label}
                </span>
                {!hideIntervals && <span className="text-[10px] opacity-70">{previewInterval(base, b.rating)}</span>}
              </button>
            ))}
          </div>
          <div className="flex justify-center">
            <AskTeacherButton variant="link" context={() => sentenceContext({ pt: item.pt, ja: item.ja, source: item.label })} />
          </div>
        </div>
      )}
    </div>
  );
}
