import { useEffect } from "react";
import { useUi } from "../store/useUi";

/**
 * active の間、下部ナビと 🧑‍🏫 の浮かぶボタンを隠す（練習に集中する画面。親指ゾーンを操作に使う）。
 * false に戻す・アンマウントで必ず戻す。
 */
export function useImmersive(active: boolean): void {
  const setImmersive = useUi((s) => s.setImmersive);
  useEffect(() => {
    setImmersive(active);
    return () => setImmersive(false);
  }, [active, setImmersive]);
}
