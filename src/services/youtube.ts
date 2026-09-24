// ============================================================================
// YouTube IFrame Player API ローダー（npm 依存なし）
// - スクリプトは1回だけ読み込む（Promise をメモ化）
// - 失敗（オフライン等）時はメモと window.YT を消し、次回の呼び出しで再試行できる
// ============================================================================

/** 使用する範囲だけの最小型定義 */
export interface YTPlayer {
  loadVideoById(videoId: string, startSeconds?: number): void;
  cueVideoById(videoId: string, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setPlaybackRate(rate: number): void;
  getPlaybackRate(): number;
  getAvailablePlaybackRates(): number[];
  getVideoUrl(): string;
  destroy(): void;
}

export interface YTPlayerEvent {
  target: YTPlayer;
  data: number;
}

export interface YTNamespace {
  loaded?: number;
  ready?: (cb: () => void) => void;
  Player: new (
    el: HTMLElement,
    opts: {
      width?: string | number;
      height?: string | number;
      videoId?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: YTPlayerEvent) => void;
        onStateChange?: (e: YTPlayerEvent) => void;
        onError?: (e: YTPlayerEvent) => void;
        onAutoplayBlocked?: (e: YTPlayerEvent) => void;
      };
    }
  ) => YTPlayer;
}

/** YT.PlayerState */
export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const;

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

const SRC = "https://www.youtube.com/iframe_api";
const TIMEOUT_MS = 15000;
let pending: Promise<YTNamespace> | null = null;

export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.loaded === 1 && window.YT.Player) return Promise.resolve(window.YT);
  if (pending) return pending;

  pending = new Promise<YTNamespace>((resolve, reject) => {
    let settled = false;
    const done = (ok: boolean, err?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok && window.YT) resolve(window.YT);
      else {
        // 次回の呼び出しで script を入れ直せるよう状態を掃除
        pending = null;
        delete window.YT;
        document.querySelectorAll(`script[src="${SRC}"]`).forEach((s) => s.remove());
        reject(err ?? new Error("YouTube API の読み込みに失敗しました"));
      }
    };
    const timer = setTimeout(() => done(false, new Error("YouTube API の読み込みがタイムアウトしました")), TIMEOUT_MS);

    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      done(true);
    };

    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.onerror = () => done(false);
    document.head.appendChild(s);
  });
  return pending;
}

export function watchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function thumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;
}
