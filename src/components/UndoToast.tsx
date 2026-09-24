import { useEffect, useRef } from "react";

interface Props {
  message: string;
  onUndo: () => void;
  /** 表示時間が過ぎたとき（または閉じたとき）に呼ぶ */
  onClose: () => void;
  /** 表示時間（ms）。既定 5 秒 */
  duration?: number;
  /** 画面下端からの位置（CSS の値）。操作バーや下部ナビの上に出す */
  bottom?: string;
}

/**
 * 評価の直後に出す「取り消す」トースト。
 * 評価のたびに key を変えて描き直すと、表示時間も数え直す。
 */
export default function UndoToast({
  message,
  onUndo,
  onClose,
  duration = 5000,
  bottom = "calc(5rem + env(safe-area-inset-bottom))",
}: Props) {
  // 親の再描画で onClose が変わってもタイマーを張り直さない
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const t = setTimeout(() => closeRef.current(), duration);
    return () => clearTimeout(t);
  }, [duration]);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-40 mx-auto flex max-w-2xl justify-center px-4"
      style={{ bottom }}
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-auto flex max-w-full animate-fade-in items-center gap-2 rounded-xl bg-brand-ink/95 py-1 pl-4 pr-1 text-sm text-white shadow-lg">
        <span className="min-w-0 truncate">{message}</span>
        <button
          type="button"
          onClick={onUndo}
          className="min-h-11 shrink-0 rounded-lg px-3 font-bold text-brand-yellow transition active:scale-95"
        >
          取り消す
          <span className="ml-1 hidden text-[10px] font-normal opacity-60 md:inline">U</span>
        </button>
      </div>
    </div>
  );
}
