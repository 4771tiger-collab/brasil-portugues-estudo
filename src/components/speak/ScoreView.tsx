import type { SpeechSentenceScore } from "../../services/grade";
import { answerView, type TokenKind } from "../../services/dictation";

/** 語ごとの色（ディクテーション・言ってみる と同じ色づかい） */
const TOKEN_CLS: Record<TokenKind, string> = {
  exact: "bg-emerald-100 text-emerald-700",
  accent: "bg-amber-100 text-amber-700",
  typo: "bg-amber-100 text-amber-700",
  wrong: "bg-rose-100 text-rose-600",
  missing: "bg-slate-100 text-slate-500 underline decoration-dotted underline-offset-4",
  extra: "bg-rose-50 text-rose-400 line-through",
};

/** 点数の色 */
export function percentTone(percent: number): string {
  return percent >= 85 ? "text-emerald-600" : percent >= 55 ? "text-amber-600" : "text-rose-600";
}

/**
 * 言ってみた結果: 点数と、正解の語の色分け（緑＝聞き取れた・黄＝惜しい・赤＝違う語に聞こえた・点線＝聞き取れなかった）。
 * 音声認識は学習者の発音をいつも正しく聞き取れるわけではないので、目安として見せる
 */
export default function ScoreView({ score, compact = false }: { score: SpeechSentenceScore; compact?: boolean }) {
  const view = answerView(score.alignment);
  return (
    <div className="w-full space-y-1.5 rounded-xl bg-slate-50 p-3 text-left" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-bold text-slate-500">🎤 聞き取りの結果</span>
        <span className={`text-lg font-bold tabular-nums ${percentTone(score.percent)}`}>{score.percent}%</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {view.map((t, i) => (
          <span key={i} className={`chip flex-col items-start text-sm ${TOKEN_CLS[t.kind]}`}>
            <span>{t.text}</span>
            {t.got !== undefined && <span className="text-[10px] font-normal text-slate-500 line-through">{t.got}</span>}
          </span>
        ))}
      </div>
      <p className="break-words text-xs text-slate-500">聞こえた文: 「{score.heard || "（聞き取れませんでした）"}」</p>
      {!compact && (
        <p className="text-[11px] leading-relaxed text-slate-400">緑＝聞き取れた語、黄＝惜しい語、赤＝違う語に聞こえた、点線＝聞き取れなかった語（目安です）。</p>
      )}
    </div>
  );
}
