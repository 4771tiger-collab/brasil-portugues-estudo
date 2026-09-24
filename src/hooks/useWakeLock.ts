// ============================================================================
// active の間だけ画面の消灯を防ぐフック（src/services/wakeLock.ts）
// 連続再生のように画面に触れない時間が続く操作で使う。false に戻す・アンマウントで解除する。
// ============================================================================

import { useEffect } from "react";
import { acquireWakeLock, type ReleaseWakeLock } from "../services/wakeLock";

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    let release: ReleaseWakeLock | null = null;
    let disposed = false;
    void acquireWakeLock().then((r) => {
      // 取得を待つ間に解除された（再生がすぐ終わった等）
      if (disposed) r();
      else release = r;
    });
    return () => {
      disposed = true;
      release?.();
    };
  }, [active]);
}
