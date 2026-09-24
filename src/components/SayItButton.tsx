import { useRef, useState } from "react";
import { useSettings } from "../store/useSettings";
import { useSpeechInput } from "../hooks/useSpeechInput";
import { sentenceListenTimeoutMs, speechErrorMessage, speechInput } from "../services/speechInput";
import {
  scoreSpeechSentence,
  scoreSpeechWord,
  type GradeOptions,
  type SpeechScore,
  type SpeechSentenceScore,
  type SpeechWordScore,
} from "../services/grade";
import { answerView, type TokenKind } from "../services/dictation";

interface Props {
  /** 正解（1語・1文。複数なら、いちばん合うものと比べる。語は "a/b" の表記ゆれも展開する） */
  expected: string | readonly string[];
  /** word = 1語（産出カード）、sentence = 1文（シャドーイング・パターンプラクティス） */
  mode: "word" | "sentence";
  /** 採点したら呼ぶ（最新の props の関数を呼ぶ） */
  onScored?: (s: SpeechScore) => void;
  /** 聞き取りを始める直前に呼ぶ（お手本の再生を止めるなど）。タップの処理の中で同期に呼ぶ */
  onStart?: () => void;
  /** 押せなくする（録音中など）。聞き取り中なら「終える」だけは押せる */
  disabled?: boolean;
  /** 聞き取った文字と評価をボタンの下に出す（既定 true。産出カードは裏面に出すので false） */
  showResult?: boolean;
  /** 採点の設定（word のとき。isKnownForm を渡すと入力式と同じく別の実在語を不正解にする） */
  gradeOptions?: GradeOptions;
  /** いちばん外側の要素の class（余白など。設定がオフのときは何も描かないので、余白もここに付ける） */
  className?: string;
}

/**
 * 「🎤 言ってみる」ボタン（T2-8）。音声認識で聞き取り、正解と比べて評価する。
 * 設定の speechInputEnabled がオフ・ブラウザが音声認識に非対応なら何も描かない（フックも動かさない）。
 * 聞き取り中は点滅し、途中経過を出す（もう一度押すと、そこまでで終える）。
 * 終わったら聞き取った文字と評価を出し、ボタンは「もう一度」になる。
 * 音声は Chrome が Google の音声認識サービスに送る。このアプリは音声も認識結果も保存しない。
 */
export default function SayItButton(props: Props) {
  const enabled = useSettings((s) => s.speechInputEnabled);
  if (!enabled || !speechInput.isSupported()) return null;
  return <SayIt {...props} />;
}

function SayIt({ expected, mode, onScored, onStart, disabled = false, showResult = true, gradeOptions, className = "" }: Props) {
  // 文は長さに合わせて聞き取りの上限を延ばす（既定の8秒では長い文の途中で切れてしまう）。
  // useSpeechInput は start() のときの値を読むので、props が変わっても次の聞き取りから反映される
  const sp = useSpeechInput(mode === "sentence" ? { timeoutMs: sentenceListenTimeoutMs(expected) } : {});
  const [score, setScore] = useState<SpeechScore | null>(null);
  // 聞き取りの後で採点するので、最新の props を読む
  const latest = useRef({ expected, mode, onScored, gradeOptions });
  latest.current = { expected, mode, onScored, gradeOptions };
  const listening = sp.status === "listening";

  /** タップ: 聞き取りを始める（聞き取り中なら、そこまでで終える） */
  function press() {
    if (listening) {
      sp.stop();
      return;
    }
    if (disabled) return;
    onStart?.();
    setScore(null);
    // start は同期に認識エンジンを始める（タップの処理の中）
    void sp.start().then((r) => {
      if (!r) return;
      const L = latest.current;
      const s: SpeechScore =
        L.mode === "word"
          ? scoreSpeechWord(r.transcripts, L.expected, L.gradeOptions)
          : scoreSpeechSentence(r.transcripts, L.expected, L.gradeOptions);
      setScore(s);
      L.onScored?.(s);
    });
  }

  const again = sp.status === "done" || sp.status === "error";
  return (
    <div className={`flex w-full flex-col items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={press}
        disabled={disabled && !listening}
        aria-pressed={listening}
        title="話した音声は Chrome が Google の音声認識に送って文字にします（このアプリは保存しません）"
        className={`btn min-h-11 px-4 text-sm ring-1 ${
          listening
            ? "animate-pulse bg-brand-blue text-white ring-brand-blue"
            : "bg-brand-blue/10 text-brand-blue ring-brand-blue/30"
        }`}
      >
        {listening ? "■ 聞き取り中…（押すと終える）" : again ? "🎤 もう一度" : "🎤 言ってみる"}
      </button>
      {listening && (
        <p className="min-h-5 text-center text-sm italic text-slate-500" aria-live="polite">
          {sp.interim || "どうぞ、話してください…"}
        </p>
      )}
      {sp.status === "error" && sp.error && (
        <p role="alert" className="w-full rounded-lg bg-rose-50 p-3 text-left text-xs leading-relaxed text-rose-600">
          {speechErrorMessage(sp.error)}
        </p>
      )}
      {showResult && sp.status === "done" && score &&
        (score.kind === "word" ? <WordResult s={score} /> : <SentenceResult s={score} />)}
    </div>
  );
}

/** 1語の評価（産出カード以外で使うとき） */
function WordResult({ s }: { s: SpeechWordScore }) {
  const v =
    s.grade === "exact"
      ? { label: "言えました！", cls: "text-emerald-600" }
      : s.grade === "wrong"
        ? { label: "違う語に聞こえました", cls: "text-rose-600" }
        : { label: "惜しい！", cls: "text-amber-600" };
  return (
    <div className="w-full space-y-1 rounded-xl bg-slate-50 p-3 text-left" aria-live="polite">
      <div className={`font-bold ${v.cls}`}>{v.label}</div>
      <p className="text-xs text-slate-500">🎤 聞き取り: 「{s.heard}」</p>
      {s.grade !== "exact" && s.result.expected && <p className="text-xs text-slate-500">正解: {s.result.expected}</p>}
    </div>
  );
}

/** 語ごとの色（ディクテーションの答え合わせと同じ色づかい） */
const TOKEN_CLS: Record<TokenKind, string> = {
  exact: "bg-emerald-100 text-emerald-700",
  accent: "bg-amber-100 text-amber-700",
  typo: "bg-amber-100 text-amber-700",
  wrong: "bg-rose-100 text-rose-600",
  missing: "bg-slate-100 text-slate-500 underline decoration-dotted underline-offset-4",
  extra: "bg-rose-50 text-rose-400 line-through",
};

const TOKEN_LABEL: Record<TokenKind, string> = {
  exact: "聞き取れた語",
  accent: "惜しい語",
  typo: "惜しい語",
  wrong: "違う語に聞こえた",
  missing: "聞き取れなかった語",
  extra: "余分に聞こえた語",
};

/** 1文の評価: 点数と、正解の語の色分け（違って聞こえた語には聞き取った形を小さく添える） */
function SentenceResult({ s }: { s: SpeechSentenceScore }) {
  const view = answerView(s.alignment);
  const tone = s.percent >= 80 ? "text-emerald-600" : s.percent >= 50 ? "text-amber-600" : "text-rose-600";
  return (
    <div className="w-full space-y-2 rounded-xl bg-slate-50 p-3 text-left" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-slate-500">🎤 聞き取りの結果</span>
        <span className={`text-lg font-bold ${tone}`}>{s.percent}%</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {view.map((t, i) => (
          <span key={i} title={TOKEN_LABEL[t.kind]} className={`chip flex-col items-start text-sm ${TOKEN_CLS[t.kind]}`}>
            <span>{t.text}</span>
            {t.got !== undefined && <span className="text-[10px] font-normal text-slate-500 line-through">{t.got}</span>}
          </span>
        ))}
      </div>
      <p className="break-words text-xs text-slate-500">聞き取り: 「{s.heard}」</p>
      <p className="text-[11px] leading-relaxed text-slate-400">
        緑＝聞き取れた語、黄＝惜しい語、赤＝違う語に聞こえた（小さい取り消し線が聞こえた形）、点線＝聞き取れなかった語。アクセント記号の違いは数えません。
      </p>
    </div>
  );
}
