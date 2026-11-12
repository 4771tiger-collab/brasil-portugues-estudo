import { useEffect, useMemo, useState } from "react";
import { toKana } from "../../services/pronunciation";
import { useSettings } from "../../store/useSettings";

/**
 * カタカナの読み（設定の「カナを表示」がオンのときだけ）。まねて言う・答えを確かめる場面では、最初は隠して
 * 「読みを見る」を押したときだけ出す。カタカナを見ながらだと、お手本の音（鼻母音・アクセント・語のつながり）
 * ではなくカタカナの音をまねてしまうので、まず耳で聞いてまねる。
 */
export default function KanaHint({ text, className = "" }: { text: string; className?: string }) {
  const showKana = useSettings((s) => s.showKana);
  const [open, setOpen] = useState(false);
  const kana = useMemo(() => (open ? toKana(text) : ""), [open, text]);
  // 文が替わったら、また隠す
  useEffect(() => setOpen(false), [text]);
  if (!showKana) return null;
  return open ? (
    <p className={`text-sm text-slate-400 ${className}`}>{kana}</p>
  ) : (
    <button type="button" onClick={() => setOpen(true)} className={`min-h-9 text-xs font-semibold text-slate-400 underline decoration-dotted underline-offset-4 ${className}`}>
      読み（カタカナ）を見る
    </button>
  );
}
