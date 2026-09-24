import type { DiffSeg } from "../services/grade";

/** 空白の差分は見えないので記号にする */
const showSpaces = (s: string) => s.replace(/ /g, "␣");

/**
 * 入力と正解の文字差分（grade.charDiff の結果）。赤の取り消し線 = 余分な文字、緑 = 足りない文字。
 * クイズの入力式・活用ドリル・産出カード（1枚ずつ学習）で共通。
 */
export default function DiffView({ diff }: { diff: DiffSeg[] }) {
  return (
    <div className="break-all font-mono text-lg tracking-wide text-brand-ink">
      {diff.map((d, i) =>
        d.kind === "same" ? (
          <span key={i}>{d.text}</span>
        ) : d.kind === "del" ? (
          <del key={i} className="rounded bg-rose-100 text-rose-600">
            {showSpaces(d.text)}
          </del>
        ) : (
          <ins key={i} className="rounded bg-emerald-100 font-bold text-emerald-700 no-underline">
            {showSpaces(d.text)}
          </ins>
        )
      )}
    </div>
  );
}
