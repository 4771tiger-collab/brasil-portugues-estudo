// ============================================================================
// 「今日」の日付（YYYY-MM-DD）を購読するフック
// 常駐した PWA を翌日に開いても日付が変わらない問題への対策。
// 表示に戻ったとき（visibilitychange / pageshow / focus）と 60 秒ごとに todayStr() を読み直し、
// 変わっていれば購読中のコンポーネントを再描画する。あわせて useProgress.ensureToday() で
// 保存済みの日次カウンタ（daily）を今日のものに切り替える。
// リスナーと interval はモジュールで1組だけ持ち、複数のコンポーネントで共有する。
// ============================================================================

import { useSyncExternalStore } from "react";
import { todayStr } from "../srs/scheduler";
import { useProgress } from "../store/useProgress";

const CHECK_INTERVAL_MS = 60_000;

let current = todayStr();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** 日付を読み直す。変わっていれば購読者へ通知する */
function refresh() {
  // daily が前日のままなら今日に切り替える（同じ日なら何もしない冪等な処理）
  useProgress.getState().ensureToday();
  const t = todayStr();
  if (t === current) return;
  current = t;
  listeners.forEach((l) => l());
}

function onVisibilityChange() {
  if (document.visibilityState === "visible") refresh();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("focus", refresh);
    timer = setInterval(refresh, CHECK_INTERVAL_MS);
  }
  // 購読の開始時にも読み直す（前回の購読から日付が変わっている場合・保存済み daily が古い場合）
  refresh();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("focus", refresh);
      if (timer !== null) clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): string {
  return current;
}

/** 今日の日付（YYYY-MM-DD）。日付が変わると再描画される。useMemo の依存に入れて使う */
export function useToday(): string {
  return useSyncExternalStore(subscribe, getSnapshot);
}
