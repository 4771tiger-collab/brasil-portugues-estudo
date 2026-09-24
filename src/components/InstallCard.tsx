import { useState } from "react";
import { usePwa } from "../pwa/usePwa";
import { installSnoozed, useMeta } from "../store/useMeta";
import { isStandalone } from "../services/platform";

/**
 * ホームの先頭に出す「アプリとしてインストール」の案内。
 * - ホーム画面のアプリ（standalone）で開いているとき・閉じてから30日以内は出さない。
 * - beforeinstallprompt を受け取っていれば、ボタンで Chrome のインストール画面を出す。
 * - 受け取っていなければ、Chrome のメニューからの手順を案内する（インストール済みなら出さない）。
 */
export default function InstallCard() {
  const installEvent = usePwa((s) => s.installEvent);
  const dismissedAt = useMeta((s) => s.installDismissedAt);
  const installedAt = useMeta((s) => s.installedAt);
  const [busy, setBusy] = useState(false);

  if (isStandalone() || installSnoozed(dismissedAt)) return null;
  // Chrome はインストール済みだと beforeinstallprompt を出さない → 手順の案内も要らない
  if (!installEvent && installedAt) return null;

  const dismiss = () => useMeta.getState().dismissInstall();

  async function install() {
    if (!installEvent) return;
    setBusy(true);
    try {
      await installEvent.prompt();
      const { outcome } = await installEvent.userChoice;
      // 断られたら案内も閉じる（入れた場合は appinstalled で片付く）
      if (outcome === "dismissed") dismiss();
    } catch {
      /* prompt() は1つのイベントで1回だけ。失敗しても下で手放す */
    } finally {
      usePwa.getState().setInstallEvent(null);
      setBusy(false);
    }
  }

  return (
    <section className="card flex animate-fade-in items-start gap-3 p-4" aria-label="アプリのインストール">
      <span className="text-2xl" aria-hidden="true">
        📲
      </span>
      <div className="min-w-0 flex-1">
        <div className="font-bold text-brand-ink">アプリとしてインストール</div>
        <p className="mt-0.5 text-xs text-slate-500">
          ホーム画面から1タップで開け、オフラインでも使えます。学習データも消えにくくなります。
        </p>
        {installEvent ? (
          <button type="button" onClick={() => void install()} disabled={busy} className="btn-primary mt-3 min-h-11">
            {busy ? "確認中…" : "インストール"}
          </button>
        ) : (
          <p className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Chrome のメニュー <span className="font-bold">⋮</span> →『アプリをインストール』（または『ホーム画面に追加』）から入れられます。
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="案内を閉じる"
        className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-400 transition active:scale-95"
      >
        ✕
      </button>
    </section>
  );
}
