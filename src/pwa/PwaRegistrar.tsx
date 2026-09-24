import { useEffect } from "react";
import { useRegisterSW } from "virtual:pwa-register/react";
import { checkForUpdateThrottled, markUpdateChecked, usePwa } from "./usePwa";

/**
 * Service Worker を登録し、更新の状態を usePwa へ写す。App に1回だけ置く（何も描かない）。
 * - registerType:"prompt" なので、新しい版は待機したまま。UpdateBanner の「更新」で切り替える。
 * - SPA（HashRouter）では画面遷移でブラウザが sw.js を確かめないため、
 *   アプリが表示に戻ったとき、1時間に1回まで reg.update() を呼ぶ。
 * - 開発時（npm run dev）は SW を登録しないスタブが返る。
 */
export default function PwaRegistrar() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    immediate: true,
    onRegisteredSW(_swUrl, reg) {
      if (!reg) return;
      usePwa.setState({ registration: reg });
      // 登録の時点でブラウザが sw.js を確かめている
      markUpdateChecked();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") checkForUpdateThrottled();
      });
    },
    onRegisterError(e) {
      console.warn("[pwa] Service Worker の登録に失敗しました", e);
    },
  });

  useEffect(() => {
    usePwa.setState({ needRefresh });
  }, [needRefresh]);

  useEffect(() => {
    usePwa.setState({ updateServiceWorker });
  }, [updateServiceWorker]);

  return null;
}
