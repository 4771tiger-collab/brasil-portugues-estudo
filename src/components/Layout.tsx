import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { currentStreak, studiedToday, useProgress } from "../store/useProgress";
import { useToday } from "../hooks/useToday";
import { useUi } from "../store/useUi";
import { Flame } from "lucide-react";
import TeacherFab from "./teacher/TeacherFab";
import TeacherSheet from "./teacher/TeacherSheet";
import { AppLogo, FEATURES, type FeatureKey } from "./icons";

/** 下部ナビ（アイコンと名前は icons/features.ts の FEATURES） */
const tabs: { to: string; feature: FeatureKey; exact?: boolean }[] = [
  { to: "/", feature: "home", exact: true },
  { to: "/flashcards", feature: "flashcards" },
  { to: "/quiz", feature: "quiz" },
  { to: "/practice", feature: "practice" },
  { to: "/music", feature: "music" },
  { to: "/settings", feature: "settings" },
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
        <NavLink to="/" end className="-my-2 flex min-h-11 items-center gap-2 rounded-xl pr-1" aria-label="ポル語学習帳（ホーム）">
          <AppLogo size={30} className="drop-shadow-sm" />
          <span className="font-bold tracking-tight text-brand-ink">ポル語学習帳</span>
        </NavLink>
        {/* 今日まだ学習していなければ炎をグレーに */}
        <div
          className={`flex items-center gap-1 rounded-full px-3 py-1 text-sm font-bold ${
            doneToday ? "bg-orange-50 text-orange-600" : "bg-slate-100 text-slate-500"
          }`}
          title={doneToday ? `連続 ${streak}日（今日は学習済み）` : "今日はまだ学習していません"}
        >
          <Flame size={16} strokeWidth={2} aria-hidden className={doneToday ? "fill-orange-400 text-orange-600" : "text-slate-400"} />
          <span className="tabular-nums">{streak}</span>
          <span className="sr-only">{doneToday ? "日連続。今日は学習済み" : "日連続。今日はまだ学習していません"}</span>
        </div>
      </header>

      {/* 下の余白は下部ナビと 🧑‍🏫 の浮かぶボタンの分（ページの最後までスクロールすればボタンに隠れない）。
          ボタンは safe-area の分だけ上がるので、余白にも safe-area を足す（曲の画面はさらに SongView が足す） */}
      <main className="flex-1 pb-[calc(8rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] pt-4">{children}</main>

      {/* 🧑‍🏫 AI 先生（どの画面からでも。浮かぶボタンと、開くシート） */}
      <TeacherFab />
      <TeacherSheet />

      {/* 1枚ずつ学習の間（immersive）は下部ナビを隠す。親指ゾーンは学習の操作バーが使う */}
      <nav
        hidden={immersive}
        className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-2xl border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur"
      >
        <div className="grid grid-cols-6 px-1">
          {tabs.map((t) => {
            const active = t.exact ? loc.pathname === "/" : loc.pathname.startsWith(t.to);
            const { icon: Icon, label } = FEATURES[t.feature];
            return (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.exact}
                className={`group flex min-h-14 flex-col items-center justify-center gap-0.5 pb-1.5 pt-2 text-[11px] leading-none transition ${
                  active ? "font-bold text-emerald-700" : "font-medium text-slate-500"
                }`}
              >
                {/* 選んでいるタブは、アイコンの後ろに淡い緑の丸い地（ピル）を敷く */}
                <span
                  className={`flex h-8 w-full max-w-[3.5rem] items-center justify-center rounded-full transition-colors ${
                    active ? "bg-brand-green/15 text-brand-green" : "text-slate-500 group-active:bg-slate-100"
                  }`}
                >
                  <Icon size={24} strokeWidth={active ? 2.25 : 2} aria-hidden />
                </span>
                {label}
              </NavLink>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
