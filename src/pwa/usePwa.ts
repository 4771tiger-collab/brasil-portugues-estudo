// ============================================================================
// PWA の状態（永続化しない）
// - needRefresh / updateServiceWorker: 新しい版の SW が待機中か、と切り替える関数。
//   PwaRegistrar が useRegisterSW の結果をここへ写す（登録は App に1回だけ）。
// - registration: 「更新を確認」と、表示に戻ったときの定期確認に使う。
// - installEvent: beforeinstallprompt を保持する（設定は platform.ts が行う）。
// ============================================================================

import { create } from "zustand";

/** Chrome の beforeinstallprompt（lib.dom に型が無いので最小限だけ定義） */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

interface PwaState {
  /** 新しい版がインストール済みで、切り替え待ち */
  needRefresh: boolean;
  /** 待機中の SW に切り替えて再読み込みする。登録前（開発時など）は null */
  updateServiceWorker: ((reloadPage?: boolean) => Promise<void> | void) | null;
  /** SW の登録。開発時や非対応のブラウザでは null */
  registration: ServiceWorkerRegistration | null;
  installEvent: BeforeInstallPromptEvent | null;
  setInstallEvent: (e: BeforeInstallPromptEvent | null) => void;
}

export const usePwa = create<PwaState>()((set) => ({
  needRefresh: false,
  updateServiceWorker: null,
  registration: null,
  installEvent: null,
  setInstallEvent: (installEvent) => set({ installEvent }),
}));

/** 表示に戻ったときの自動確認の最短間隔 */
export const AUTO_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** 最後に更新を確かめた時刻（手動・自動で共有。登録直後はブラウザが確かめている） */
let lastCheckAt = 0;

export const markUpdateChecked = (at = Date.now()) => {
  lastCheckAt = at;
};

export type UpdateCheckResult = "found" | "latest" | "unsupported" | "error";

/**
 * サーバーの sw.js を確かめる。新しい版が見つかれば "found"
 * （インストールが終わると needRefresh が立ち、更新バナーが出る）。
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const reg = usePwa.getState().registration;
  if (!reg) return "unsupported";
  if (reg.waiting) return "found";
  lastCheckAt = Date.now();
  try {
    await reg.update();
  } catch {
    // オフラインや sw.js の取得失敗
    return "error";
  }
  return reg.installing || reg.waiting ? "found" : "latest";
}

/** 前回の確認から AUTO_CHECK_INTERVAL_MS 以上たっていれば確かめる（表示に戻ったとき用） */
export function checkForUpdateThrottled(now = Date.now()): void {
  if (now - lastCheckAt < AUTO_CHECK_INTERVAL_MS) return;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  void checkForUpdate();
}
