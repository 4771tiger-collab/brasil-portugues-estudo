// ============================================================================
// 画面の消灯を防ぐ（Screen Wake Lock API）
// 連続再生・シャドーイングの全文再生など、画面に触れずに聴く間だけ取る。
// 非対応・拒否（省電力モード、非 HTTPS など）のときは何もしない。
// 画面が非表示になるとブラウザが自動で解除するため、表示に戻ったとき、まだ必要なら取り直す。
// ============================================================================

export type ReleaseWakeLock = () => void;

const noop: ReleaseWakeLock = () => {};

export function isWakeLockSupported(): boolean {
  return typeof navigator !== "undefined" && typeof document !== "undefined" && "wakeLock" in navigator;
}

/**
 * 画面の Wake Lock を取る。戻り値の関数で解除する（何度呼んでもよい）。
 * 取れなかったときも解除関数を返す（表示に戻ったときの取り直しは続ける）。
 */
export async function acquireWakeLock(): Promise<ReleaseWakeLock> {
  if (!isWakeLockSupported()) return noop;

  /** 呼び出し側が解除するまで true */
  let held = true;
  let sentinel: WakeLockSentinel | null = null;
  let requesting = false;

  const request = async () => {
    if (!held || requesting || document.visibilityState !== "visible") return;
    if (sentinel && !sentinel.released) return;
    requesting = true;
    try {
      const s = await navigator.wakeLock.request("screen");
      if (!held) {
        // 取っている間に解除された
        void s.release().catch(() => {});
        return;
      }
      sentinel = s;
    } catch {
      // 拒否された（省電力モードなど）: 何もしない
    } finally {
      requesting = false;
    }
  };

  const onVisibility = () => {
    if (document.visibilityState === "visible") void request();
  };
  document.addEventListener("visibilitychange", onVisibility);
  await request();

  return () => {
    if (!held) return;
    held = false;
    document.removeEventListener("visibilitychange", onVisibility);
    const s = sentinel;
    sentinel = null;
    if (s && !s.released) void s.release().catch(() => {});
  };
}
