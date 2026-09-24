// ============================================================================
// 練習・音楽の時間を学習ログ（useProgress.history）に記録するフック
// - useActivityTimer(kind, active): active かつ画面が表示されている間の秒数を数え、
//   30 秒ごと・止まったとき・画面が隠れたとき・アンマウント時にまとめて logActivity(kind, 0, 秒) する。
//   音楽（MusicShell）で「動画の再生中」を渡して使う。3 分以上で学習日になる判定は logActivity 側。
// - useVisibleStopwatch(): 画面が表示されていた時間だけを数えるストップウォッチ。
//   lap(上限秒) で前回からの秒数を返して数え直す（放置した時間を上限で切る）。
//   ディクテーションの採点・パターン練習の1文など、回数と一緒に所要時間を記録するときに使う。
// 画面が隠れた（Android で画面を消した・別のアプリに移った）時間は数えない。
// ============================================================================

import { useCallback, useEffect, useRef } from "react";
import { clockRun, clockTake, newClock } from "../services/activityClock";
import { useProgress, type ActivityKind } from "../store/useProgress";

/** まとめて記録する間隔 */
export const ACTIVITY_FLUSH_MS = 30_000;

const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";

export function useActivityTimer(kind: ActivityKind, active: boolean): void {
  const clockRef = useRef(newClock());
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const flush = useCallback(() => {
    const { sec, clock } = clockTake(clockRef.current, Date.now());
    clockRef.current = clock;
    if (sec > 0) useProgress.getState().logActivity(kindRef.current, 0, sec);
  }, []);

  useEffect(() => {
    const update = () => {
      const run = active && isVisible();
      clockRef.current = clockRun(clockRef.current, run, Date.now());
      // 隠れたらすぐ記録する（バックグラウンドのタブは予告なく破棄されることがある）
      if (!run) flush();
    };
    update();
    document.addEventListener("visibilitychange", update);
    const timer = active ? setInterval(flush, ACTIVITY_FLUSH_MS) : null;
    return () => {
      document.removeEventListener("visibilitychange", update);
      if (timer !== null) clearInterval(timer);
      clockRef.current = clockRun(clockRef.current, false, Date.now());
      flush();
    };
  }, [active, flush]);
}

export function useVisibleStopwatch(): (capSec: number) => number {
  const clockRef = useRef(newClock());

  useEffect(() => {
    const update = () => {
      clockRef.current = clockRun(clockRef.current, isVisible(), Date.now());
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      clockRef.current = clockRun(clockRef.current, false, Date.now());
    };
  }, []);

  return useCallback((capSec: number) => {
    const { sec, clock } = clockTake(clockRef.current, Date.now());
    // 上限を超えた分（放置）は捨てる。端数の ms は持ち越す
    clockRef.current = clock;
    return Math.min(sec, Math.max(0, capSec));
  }, []);
}
