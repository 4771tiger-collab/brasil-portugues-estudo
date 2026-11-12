import { Link } from "react-router-dom";
import { ArrowRight, House } from "lucide-react";
import { useDailyMenu, type MenuKey } from "../../hooks/useDailyMenu";

/**
 * 練習の完了画面の「次へ」: 今日のメニューのうち、まだ済んでいない次の1つへ進むボタンと、ホームへ戻るボタン。
 * skip = 今終えた練習（同じものを次に勧めない）。
 */
export default function NextMenu({ skip }: { skip?: MenuKey }) {
  const menu = useDailyMenu();
  const next = menu.items.find((i) => i.state === "todo" && i.key !== skip) ?? null;
  return (
    <div className="space-y-2">
      {next && (
        <Link to={next.to} replace className="btn-primary min-h-14 w-full text-base">
          <span className="min-w-0 truncate">
            次へ：{next.title}
            <span className="ml-1 text-xs font-normal opacity-90">（約{next.minutes}分）</span>
          </span>
          <ArrowRight size={18} className="shrink-0" aria-hidden />
        </Link>
      )}
      <Link to="/" replace className={`${next ? "btn-ghost" : "btn-primary"} min-h-12 w-full`}>
        <House size={18} aria-hidden />
        {next ? "ホームへ" : "今日のメニューは完了！ホームへ"}
      </Link>
    </div>
  );
}
