import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { IconBadge, type FeatureKey } from "../components/icons";

interface Item {
  to: string;
  title: string;
  feature: FeatureKey;
  desc: string;
}

/** ライブラリ: 毎日のメニュー（口慣らし・レッスン・会話・単語）を支える、目的別の練習と教材 */
const GROUPS: { title: string; note: string; items: Item[] }[] = [
  {
    title: "話す・口を動かす",
    note: "言える文を増やし、口の動きを慣らす",
    items: [
      { to: "/phrases", title: "フレーズ帳・言いたいことメモ", feature: "phrases", desc: "口慣らしに出る文の一覧。言いたい文を足せます。" },
      { to: "/speak/handsfree", title: "耳だけ口慣らし", feature: "handsfree", desc: "日本語 → 言う間 → お手本 を自動で。歩きながら声に出せます。" },
      { to: "/practice/pattern", title: "パターンプラクティス", feature: "pattern", desc: "文型の語を入れ替えて言う。和文を見て言う発話ドリルも。" },
      { to: "/practice/shadowing", title: "シャドーイング", feature: "shadowing", desc: "お手本を追いかけて発話＋録音で聞き比べ。会話のロールプレイも。" },
    ],
  },
  {
    title: "語彙・文法",
    note: "話す材料を増やす",
    items: [
      { to: "/flashcards", title: "単語帳", feature: "flashcards", desc: "デッキ別の一覧・目隠し・連続再生・耳だけ復習。" },
      { to: "/quiz", title: "クイズ", feature: "quiz", desc: "4択・入力・リスニングで単語を確認。" },
      { to: "/practice/conjugation", title: "活用ドリル", feature: "conjugation", desc: "動詞の活用形を入力。不規則動詞と、学習した動詞から出題。" },
    ],
  },
  {
    title: "聞く・読む",
    note: "相手の言うことが分かるように",
    items: [
      { to: "/practice/chunk", title: "チャンクリーディング", feature: "chunk", desc: "意味のカタマリで前から理解。内容チェックの問題も。" },
      { to: "/practice/dictation", title: "ディクテーション", feature: "dictation", desc: "音声を聴いて書き取る4ステップ学習。" },
      { to: "/practice/add", title: "教材を追加", feature: "addMaterial", desc: "ポルトガル語テキストを貼り付けて自分だけの教材に。" },
    ],
  },
  {
    title: "アプリ",
    note: "",
    items: [{ to: "/settings", title: "設定", feature: "settings", desc: "速度・音声・マイク・AI・バックアップ。" }],
  },
];

export default function Library() {
  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <h1 className="text-xl font-bold text-brand-ink">ライブラリ</h1>
        <p className="mt-1 text-sm leading-relaxed text-slate-500">毎日のメニューに足して使う、目的別の練習と教材です。</p>
      </div>
      {GROUPS.map((g) => (
        <section key={g.title} className="space-y-2">
          <h2 className="px-1 text-sm font-bold text-slate-500">
            {g.title}
            {g.note && <span className="ml-2 text-xs font-normal text-slate-400">{g.note}</span>}
          </h2>
          <div className="card divide-y divide-slate-100 overflow-hidden">
            {g.items.map((it) => (
              <Link key={it.to} to={it.to} className="flex items-center gap-3 p-3.5 transition active:bg-slate-50">
                <IconBadge feature={it.feature} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-brand-ink">{it.title}</div>
                  <div className="text-xs leading-relaxed text-slate-500">{it.desc}</div>
                </div>
                <ChevronRight size={20} className="shrink-0 text-slate-300" aria-hidden />
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
