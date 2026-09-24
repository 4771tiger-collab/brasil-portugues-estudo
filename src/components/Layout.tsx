import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { currentStreak, studiedToday, useProgress } from "../store/useProgress";
import { useToday } from "../hooks/useToday";
import { useUi } from "../store/useUi";

const tabs = [
  { to: "/", label: "ホーム", icon: "M3 11.5 12 4l9 7.5M5 10v9h14v-9", exact: true },
  { to: "/flashcards", label: "単語帳", icon: "M4 5h16v14H4zM4 9h16" },
  { to: "/quiz", label: "クイズ", icon: "M9 9a3 3 0 1 1 4 2.8c-.8.4-1 .9-1 1.7M12 17h.01" },
  { to: "/practice", label: "練習", icon: "M12 3v18M5 8l7-5 7 5M5 8v8l7 5 7-5V8" },
  { to: "/music", label: "音楽", icon: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" },
  { to: "/settings", label: "設定", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1l2-1.6-2-3.4-2.4 1a7 7 0 0 0-1.7-1L14.5 2h-5l-.3 2.9a7 7 0 0 0-1.7 1l-2.4-1-2 3.4L3 11a7 7 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.3 3h5l.3-2.9a7 7 0 0 0 1.7-1l2.4 1 2-3.4-2-1.6c.1-.3.1-.7.1-1z" },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  // 表示用の連続記録（途切れていれば 0）。日付の切替は useToday が拾う
  const today = useToday();
  const streak = useProgress((s) => currentStreak(s, today));
  const doneToday = useProgress((s) => studiedToday(s, today));
  const loc = useLocation();
  const immersive = useUi((s) => s.immersive);
  const headerRef = useRef<HTMLElement>(null);

  // ヘッダーの実高さを CSS 変数 --hdr に（sticky 要素の top 位置合わせ用）
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const apply = () => document.documentElement.style.setProperty("--hdr", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col">
      {/* 横向きのノッチ端末でも切れないよう、左右に safe-area を足す（px-4 の代わりに calc） */}
      <header
        ref={headerRef}
        className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-200 bg-white/90 py-3 pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] backdrop-blur"
      >
        <NavLink to="/" className="flex items-center gap-2">
          <span className="text-lg">🇧🇷</span>
          <span className="font-bold text-brand-ink">ポル語学習帳</span>
        </NavLink>
        {/* 今日まだ学習していなければ炎をグレーに */}
        <div
          className={`flex items-center gap-1 rounded-full px-3 py-1 text-sm font-bold ${
            doneToday ? "bg-orange-50 text-orange-600" : "bg-slate-100 text-slate-400"
          }`}
          title={doneToday ? `連続 ${streak}日（今日は学習済み）` : "今日はまだ学習していません"}
        >
          <span className={doneToday ? "" : "opacity-60 grayscale"} aria-hidden="true">
            🔥
          </span>
          <span>{streak}</span>
          <span className="sr-only">{doneToday ? "日連続。今日は学習済み" : "日連続。今日はまだ学習していません"}</span>
        </div>
      </header>

      <main className="flex-1 pb-24 pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] pt-4">{children}</main>

      {/* 1枚ずつ学習の間（immersive）は下部ナビを隠す。親指ゾーンは学習の操作バーが使う */}
      <nav
        hidden={immersive}
        className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-2xl border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur"
      >
        <div className="grid grid-cols-6">
          {tabs.map((t) => {
            const active = t.exact ? loc.pathname === "/" : loc.pathname.startsWith(t.to);
            return (
              <NavLink
                key={t.to}
                to={t.to}
                className={`flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium transition ${
                  active ? "text-brand-green" : "text-slate-400"
                }`}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d={t.icon} />
                </svg>
                {t.label}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
