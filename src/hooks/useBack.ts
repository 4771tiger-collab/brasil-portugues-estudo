// ============================================================================
// 画面内の「‹ 一覧」ボタン用の戻る処理
// アプリ内で遷移してきたなら履歴を1つ戻る（Android の戻る操作と同じ結果になる）。
// 直接開いた・再読み込みした等で戻り先の履歴が無いときは、fallback へ置き換えで移動する
// （push すると「戻る」で詳細画面に戻ってしまうため replace）。
// react-router の history は window.history.state.idx に、このタブでの履歴の位置を入れている。
// ============================================================================

import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

export function useBack(fallback: string): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    if (typeof idx === "number" && idx > 0) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}
