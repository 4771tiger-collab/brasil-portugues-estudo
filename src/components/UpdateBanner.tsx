import { useEffect, useState } from "react";
import { usePwa } from "../pwa/usePwa";

/**
 * 新しい版が待機中のときだけ出す「更新」バナー。ホームと設定にだけ置く
 * （学習の途中の画面では出さない。更新すると画面を読み直すため）。
 */
export default function UpdateBanner() {
  const needRefresh = usePwa((s) => s.needRefresh);
  const updateServiceWorker = usePwa((s) => s.updateServiceWorker);
  const [busy, setBusy] = useState(false);

  // 切り替えが終わると再読み込みされる。起きなかったときはボタンを戻す
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setBusy(false), 10000);
    return () => clearTimeout(t);
  }, [busy]);

  if (!needRefresh || !updateServiceWorker) return null;

  return (
    <div className="card flex animate-fade-in items-center gap-3 p-3 ring-brand-blue/30" role="status">
      <span className="text-xl" aria-hidden="true">
        ✨
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-brand-ink">新しいバージョンがあります</div>
        <div className="text-xs text-slate-500">更新すると画面を読み直します。学習の記録は消えません。</div>
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          const reg = usePwa.getState().registration;
          // 待機中の SW が無い（初回訪問のページで新しい版がすぐ有効になった等）か、このページがまだ SW の
          // 管理下にない（初回訪問）ときは、切り替えの通知（controllerchange）が来ないので自分で読み直す
          if (!reg?.waiting || !navigator.serviceWorker?.controller) {
            window.location.reload();
            return;
          }
          void updateServiceWorker(true);
        }}
        className="btn-primary min-h-11 shrink-0"
      >
        {busy ? "更新中…" : "更新"}
      </button>
    </div>
  );
}
