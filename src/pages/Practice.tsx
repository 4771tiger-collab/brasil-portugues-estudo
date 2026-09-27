import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { IconBadge, type FeatureKey } from "../components/icons";

const items: { to: string; title: string; feature: FeatureKey; desc: string }[] = [
  { to: "/practice/pattern", title: "パターンプラクティス", feature: "pattern", desc: "文型を入れ替えて発話。和文を見て言う発話ドリル・オートも。" },
  { to: "/practice/conjugation", title: "活用ドリル", feature: "conjugation", desc: "動詞の活用形を入力。不規則動詞と、学習した動詞から出題。" },
  { to: "/practice/chunk", title: "チャンクリーディング", feature: "chunk", desc: "意味のカタマリ(/)で前から理解。話題で選べて、内容チェックの問題も。" },
  { to: "/practice/shadowing", title: "シャドーイング", feature: "shadowing", desc: "お手本を追いかけて発話＋録音で聞き比べ。会話はロールプレイも。" },
  { to: "/practice/dictation", title: "ディクテーション", feature: "dictation", desc: "音声を聴いて書き取る4ステップ学習。" },
  { to: "/practice/add", title: "教材を追加", feature: "addMaterial", desc: "ポルトガル語テキストを貼り付けて自分だけの教材に。" },
];

export default function Practice() {
  return (
    <div className="animate-fade-in space-y-4">
      <h1 className="text-xl font-bold text-brand-ink">練習</h1>
      <p className="text-sm text-slate-500">文章・発話・リスニングのトレーニング。</p>
      <div className="space-y-3">
        {items.map((it) => (
          <Link key={it.to} to={it.to} className="card flex items-center gap-3 p-4 transition hover:ring-brand-green/40 active:scale-[0.99]">
            <IconBadge feature={it.feature} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-brand-ink">{it.title}</div>
              <div className="truncate text-xs text-slate-500">{it.desc}</div>
            </div>
            <ChevronRight size={20} className="shrink-0 text-slate-300" aria-hidden />
          </Link>
        ))}
      </div>
    </div>
  );
}
