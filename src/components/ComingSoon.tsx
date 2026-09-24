import { Link } from "react-router-dom";

export default function ComingSoon({ title, emoji, note }: { title: string; emoji: string; note?: string }) {
  return (
    <div className="animate-fade-in space-y-4">
      <Link to="/practice" className="text-sm text-brand-green">‹ 練習に戻る</Link>
      <div className="card flex flex-col items-center gap-3 p-8 text-center">
        <span className="text-4xl">{emoji}</span>
        <h1 className="text-lg font-bold text-brand-ink">{title}</h1>
        <p className="text-sm text-slate-500">{note ?? "この機能はまもなく実装されます。"}</p>
      </div>
    </div>
  );
}
