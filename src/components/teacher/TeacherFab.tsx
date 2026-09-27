// ============================================================================
// 🧑‍🏫 AI 先生の浮かぶボタン（どの画面でも右下。Layout に1つだけ置く）
// - 下部ナビの上（safe-area を足す）。PC では max-w-2xl の枠の右端に合わせる。
// - 出さないとき: 先生のシートが開いている・1枚ずつ学習／耳だけ復習の間（useUi.immersive。操作バーが下にある）・
//   文字を入力している間（キーボードとアクセントバーを隠さない）。
// - 曲の画面では「⤵ 現在行へ」（同じ右下）の上に置く。
// - 押すと、開いていた会話（無ければ、今の画面を文脈にした新しい会話）で先生のシートを開く。
//   返事を受信中（シートを閉じても続く）は、ボタンに点を出す。
// ============================================================================

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useScreenName } from "../../hooks/useScreenName";
import { generalContext, openTeacher, useTeacherUi } from "../../services/ai/teacherContext";
import { useUi } from "../../store/useUi";

/** 文字を入力する欄か（ボタン・チェックボックスなどは除く） */
function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    return !el.readOnly && !el.disabled && !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color", "image"].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/** 文字の入力欄にフォーカスがあるか（キーボードが出ている見込み） */
function useTyping(): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => setTyping(isTypingTarget(document.activeElement));
    // フォーカスが外れた直後は activeElement が body のことがあるので、次のタスクで確かめる
    const later = () => {
      clearTimeout(timer);
      timer = setTimeout(update, 0);
    };
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", later);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", later);
    };
  }, []);
  return typing;
}

export default function TeacherFab() {
  const open = useTeacherUi((s) => s.open);
  const streaming = useTeacherUi((s) => s.run?.status === "streaming");
  const immersive = useUi((s) => s.immersive);
  const typing = useTyping();
  const screen = useScreenName();
  const { pathname } = useLocation();
  if (open || immersive || typing) return null;

  // 曲の画面は「⤵ 現在行へ」（右下・下部ナビの上）の上に置く
  const onSong = /^\/music\/[^/]+/.test(pathname);
  return (
    <button
      type="button"
      onClick={() => openTeacher(useTeacherUi.getState().activeId ? undefined : generalContext(screen))}
      aria-label="AI先生に質問する"
      title="🧑‍🏫 AI先生に質問する"
      className="fixed z-[25] flex h-12 w-12 items-center justify-center rounded-full bg-white text-2xl shadow-lg ring-1 ring-violet-200 transition active:scale-90"
      style={{
        bottom: onSong ? "calc(7.75rem + env(safe-area-inset-bottom))" : "calc(4.5rem + env(safe-area-inset-bottom))",
        right: "max(calc(1rem + env(safe-area-inset-right)), calc((100vw - 42rem) / 2 + 1rem))",
      }}
    >
      <span aria-hidden>🧑‍🏫</span>
      {streaming && (
        <span aria-hidden className="absolute right-0.5 top-0.5 h-3 w-3 animate-pulse rounded-full bg-violet-500 ring-2 ring-white" />
      )}
    </button>
  );
}
