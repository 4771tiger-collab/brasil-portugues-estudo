// ============================================================================
// 画面の一時的な状態（永続化しない）
// immersive: 1枚ずつ学習の間は下部ナビを隠し、親指ゾーンを操作バーに使う。
//            立てたコンポーネントがアンマウント時に必ず戻す。
// ============================================================================

import { create } from "zustand";

interface UiState {
  immersive: boolean;
  setImmersive: (v: boolean) => void;
}

export const useUi = create<UiState>()((set) => ({
  immersive: false,
  setImmersive: (immersive) => set({ immersive }),
}));
