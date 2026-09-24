import { Link } from "react-router-dom";

const items = [
  { to: "/practice/pattern", title: "パターンプラクティス", emoji: "🔁", desc: "文型を入れ替えて発話。和文を見て言う発話ドリル・オートも。" },
  { to: "/practice/conjugation", title: "活用ドリル", emoji: "🔤", desc: "動詞の活用形を入力。不規則動詞と、学習した動詞から出題。" },
  { to: "/practice/chunk", title: "チャンクリーディング", emoji: "📖", desc: "意味のカタマリ(/)で前から理解する速読特訓。" },
  { to: "/practice/shadowing", title: "シャドーイング", emoji: "🗣️", desc: "お手本を追いかけて発話＋マイク録音で聞き比べ。" },
  { to: "/practice/dictation", title: "ディクテーション", emoji: "✍️", desc: "音声を聴いて書き取る4ステップ学習。" },
  { to: "/practice/add", title: "教材を追加", emoji: "➕", desc: "ポルトガル語テキストを貼り付けて自分だけの教材に。" },
];

export default function Practice() {
  return (
    <div className="animate-fade-in space-y-4">
      <h1 className="text-xl font-bold text-brand-ink">練習</h1>
      <p className="text-sm text-slate-500">文章・発話・リスニングのトレーニング。</p>
      <div className="space-y-3">
        {items.map((it) => (
          <Link key={it.to} to={it.to} className="card flex items-center gap-3 p-4 transition hover:ring-brand-green/40">
            <span className="text-2xl">{it.emoji}</span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-brand-ink">{it.title}</div>
              <div className="truncate text-xs text-slate-500">{it.desc}</div>
            </div>
            <span className="text-slate-300">›</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
