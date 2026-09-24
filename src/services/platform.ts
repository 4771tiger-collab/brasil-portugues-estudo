// ============================================================================
// 端末・ブラウザまわり（インストール・保存領域の保護）
// main.tsx の先頭で読み込む。読み込んだ時点で beforeinstallprompt の受け取りを始める
// （React の描画より前に来ることがあるため、取り逃さないように）。
// ============================================================================

import { usePwa, type BeforeInstallPromptEvent } from "../pwa/usePwa";
import { useMeta } from "../store/useMeta";

/** ホーム画面のアプリ（PWA）として開いているか */
export function isStandalone(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(display-mode: standalone)").matches;
}

if (typeof window !== "undefined") {
  // Chrome の自動のミニバーは出さず、ホームの InstallCard から prompt() する
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    usePwa.getState().setInstallEvent(e as BeforeInstallPromptEvent);
  });
  // Chrome のメニューから入れた場合も届く
  window.addEventListener("appinstalled", () => {
    usePwa.getState().setInstallEvent(null);
    useMeta.getState().markInstalled();
  });
}

// ---------------------------------------------------------------------------
// 保存領域の保護（storage.persist）
// 保護されていないと、端末の空き容量が少ないときにブラウザが学習データ（localStorage）を消すことがある。
// Chrome は確認の画面を出さず、インストール済みか・よく使うサイトかで許可を決める。
// ---------------------------------------------------------------------------

let persistRequested = false;

/**
 * 保護を要求する（Settings の「保護を要求」からも呼ぶ）。
 * すでに保護されていれば persist() は呼ばない。結果を useMeta に残す。API が無ければ null。
 */
export async function requestPersist(): Promise<boolean | null> {
  const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
  if (!storage?.persist) return null;
  try {
    const already = storage.persisted ? await storage.persisted() : false;
    const result = already || (await storage.persist());
    useMeta.getState().setPersistResult(result);
    return result;
  } catch {
    return null;
  }
}

/**
 * 起動してから1回だけ保護を要求する。main.tsx が最初の評価（totalReviews の増加）の後に呼ぶ。
 * 起動ごとに1回なのは、インストールした後などに Chrome が許可に変えることがあるため。
 */
export async function requestPersistOnce(): Promise<boolean | null> {
  if (persistRequested) return useMeta.getState().persistResult;
  persistRequested = true;
  return requestPersist();
}

export interface StorageStatus {
  /** 保護されているか。確かめられなければ null */
  persisted: boolean | null;
  /** 使用量（バイト）。確かめられなければ null */
  usage: number | null;
  /** 使える上限の目安（バイト） */
  quota: number | null;
}

/** 保護の状態と使用量（設定画面の「データ保護」） */
export async function storageStatus(): Promise<StorageStatus> {
  const storage = typeof navigator !== "undefined" ? navigator.storage : undefined;
  const out: StorageStatus = { persisted: null, usage: null, quota: null };
  if (!storage) return out;
  try {
    if (storage.persisted) out.persisted = await storage.persisted();
  } catch {
    /* 確かめられない */
  }
  try {
    if (storage.estimate) {
      const e = await storage.estimate();
      out.usage = e.usage ?? null;
      out.quota = e.quota ?? null;
    }
  } catch {
    /* 確かめられない */
  }
  return out;
}

/** バイト数を「1.2 MB」の形に */
export function formatBytes(n: number): string {
  if (!(n >= 0)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
