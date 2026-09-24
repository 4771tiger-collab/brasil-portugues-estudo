// ============================================================================
// 音楽タブの外枠: YouTube プレーヤーを1つだけ保持し、一覧⇄曲画面の移動でも再生を止めない。
// - プレーヤーのコンテナは付け替え・サイズ変更しない（iframe を動かすと再読み込みされるため）
// - host 要素は effect 内で命令的に作る（StrictMode の二重マウント対策）
// - onReady 前の命令はキューに溜める。子には生のプレーヤーではなく命令関数を渡す
// - 再生順は music-playlists.json の自前キュー（連続 / 1曲リピート）
// - 音楽タブを離れると再生は止まる（第1段階の仕様）
// ============================================================================

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useMatch, useNavigate } from "react-router-dom";
import { SONGS, SONG_BY_ID, songIndex } from "../../data/music";
import { loadYouTubeApi, watchUrl, YT_STATE, type YTPlayer } from "../../services/youtube";
import { useMusic } from "../../store/useMusic";
import { useActivityTimer } from "../../hooks/useActivityTimer";

export interface MusicPlayerApi {
  /** 再生中（または読み込み済み）の動画 */
  currentVideoId: string | null;
  playerState: number;
  ready: boolean;
  /** 再生要求したのに始まらない（モバイルの自動再生制限） */
  blocked: boolean;
  error: { code: number; videoId: string } | null;
  /** ユーザー操作のハンドラ内から同期的に呼ぶこと（自動再生制限対策） */
  playSong: (videoId: string) => void;
  play: () => void;
  pause: () => void;
  seek: (sec: number) => void;
  setRate: (rate: number) => void;
  getTime: () => number;
  /** 動画の長さ（秒）。未取得なら 0 */
  getDuration: () => number;
  getRates: () => number[];
  next: () => void;
  prev: () => void;
  /** 単語シートや和訳編集中は自動追従（曲画面の切替）を止める */
  setBusy: (busy: boolean) => void;
  /** 曲画面の操作バーをプレーヤー直下（sticky 内）に差し込む先 */
  transportSlot: HTMLDivElement | null;
  /** sticky 部分（プレーヤー＋操作バー）の要素。自動スクロール位置の計算用 */
  stickyEl: HTMLDivElement | null;
}

const Ctx = createContext<MusicPlayerApi | null>(null);

export function useMusicPlayer(): MusicPlayerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMusicPlayer は MusicShell の内側で使ってください");
  return v;
}

const ERROR_TEXT: Record<number, string> = {
  2: "動画IDが不正です",
  5: "この環境では再生できません",
  100: "動画が見つかりません（削除・非公開）",
  101: "この動画は埋め込み再生が許可されていません",
  150: "この動画は埋め込み再生が許可されていません",
  153: "再生できません（file:// で直接開いている場合は npm run dev / preview で開いてください）",
};

function parseVideoId(url: string): string | null {
  const m = url.match(/[?&]v=([\w-]{11})/);
  return m ? m[1] : null;
}

export default function MusicShell() {
  const navigate = useNavigate();
  const songMatch = useMatch("/music/:videoId");
  const onSongPage = !!songMatch;
  const playMode = useMusic((s) => s.prefs.playMode);
  const rate = useMusic((s) => s.prefs.rate);

  const [started, setStarted] = useState(false);
  const [ready, setReady] = useState(false);
  const [playerState, setPlayerState] = useState<number>(YT_STATE.UNSTARTED);
  const [currentVideoId, setCurrentVideoId] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<{ code: number; videoId: string } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [transportSlot, setTransportSlot] = useState<HTMLDivElement | null>(null);
  const [stickyEl, setStickyEl] = useState<HTMLDivElement | null>(null);

  // 学習ログ: 動画の再生中かつ画面の表示中の秒数を 30 秒ごとにまとめて記録（1日 3 分以上で学習日）
  useActivityTimer("music", playerState === YT_STATE.PLAYING);

  const hostParentRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const desiredRef = useRef<string | null>(null);
  const pendingRef = useRef<((p: YTPlayer) => void)[]>([]);
  const blockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const busyRef = useRef(false);

  // YT のコールバックから最新の値を読むための ref
  const live = useRef({ playMode, rate, onSongPage, navigate, currentVideoId });
  live.current = { playMode, rate, onSongPage, navigate, currentVideoId };

  const run = useCallback((fn: (p: YTPlayer) => void) => {
    const p = playerRef.current;
    if (p) {
      try {
        fn(p);
      } catch {
        /* プレーヤー破棄直後など */
      }
    } else pendingRef.current.push(fn);
  }, []);

  const armBlockCheck = useCallback(() => {
    if (blockTimer.current) clearTimeout(blockTimer.current);
    blockTimer.current = setTimeout(() => {
      const st = playerRef.current?.getPlayerState?.();
      if (st === YT_STATE.UNSTARTED || st === YT_STATE.CUED || st == null) setBlocked(true);
    }, 1500);
  }, []);

  const followTo = useCallback((videoId: string) => {
    const l = live.current;
    if (l.onSongPage && !busyRef.current) l.navigate(`/music/${videoId}`, { replace: true });
  }, []);

  const loadInto = useCallback(
    (videoId: string) => {
      desiredRef.current = videoId;
      setCurrentVideoId(videoId);
      setError(null);
      if (skipTimer.current) clearTimeout(skipTimer.current);
      run((p) => {
        p.loadVideoById(videoId);
        armBlockCheck();
      });
    },
    [run, armBlockCheck]
  );

  const playSong = useCallback(
    (videoId: string) => {
      if (!started) {
        desiredRef.current = videoId;
        setCurrentVideoId(videoId);
        setStarted(true);
        return;
      }
      loadInto(videoId);
    },
    [started, loadInto]
  );

  const step = useCallback(
    (dir: 1 | -1, fromAuto = false) => {
      const cur = live.current.currentVideoId;
      const i = cur ? songIndex(cur) : -1;
      const n = SONGS.length;
      const nextIdx = i < 0 ? 0 : (i + dir + n) % n;
      const id = SONGS[nextIdx].videoId;
      loadInto(id);
      if (fromAuto) followTo(id);
      return id;
    },
    [loadInto, followTo]
  );

  // イベントハンドラは ref 経由（プレーヤーは1度しか作らないため）
  const handlers = useRef({
    onState: (_s: number) => {},
    onError: (_c: number) => {},
  });
  handlers.current.onState = (s: number) => {
    setPlayerState(s);
    if (s === YT_STATE.PLAYING || s === YT_STATE.BUFFERING) {
      setBlocked(false);
      // YouTube 内で別動画に移った場合も追従
      const vid = parseVideoId(playerRef.current?.getVideoUrl?.() ?? "");
      if (vid && vid !== live.current.currentVideoId) setCurrentVideoId(vid);
    }
    if (s === YT_STATE.PLAYING) {
      const want = live.current.rate;
      if (want !== 1 && playerRef.current?.getPlaybackRate?.() !== want) playerRef.current?.setPlaybackRate(want);
    }
    if (s === YT_STATE.ENDED) {
      if (live.current.playMode === "one") {
        run((p) => {
          p.seekTo(0, true);
          p.playVideo();
        });
      } else step(1, true);
    }
  };
  handlers.current.onError = (code: number) => {
    const vid = live.current.currentVideoId ?? "";
    setError({ code, videoId: vid });
    // エラー時は「タップして再生」の判定を取り消す（エラー表示の上に出さない）
    if (blockTimer.current) clearTimeout(blockTimer.current);
    setBlocked(false);
    if (skipTimer.current) clearTimeout(skipTimer.current);
    if (live.current.playMode === "all" && code !== 153) {
      skipTimer.current = setTimeout(() => step(1, true), 3000);
    }
  };

  // プレーヤー生成（最初に曲が選ばれた時に1回だけ）
  useEffect(() => {
    if (!started) return;
    const parent = hostParentRef.current;
    if (!parent) return;
    const host = document.createElement("div");
    parent.appendChild(host);
    let cancelled = false;
    let p: YTPlayer | null = null;
    setLoadError(false);

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        p = new YT.Player(host, {
          width: "100%",
          height: "100%",
          videoId: desiredRef.current ?? undefined,
          playerVars: { autoplay: 1, playsinline: 1, rel: 0, iv_load_policy: 3 },
          events: {
            onReady: (e) => {
              if (cancelled) return;
              playerRef.current = e.target;
              setReady(true);
              const q = pendingRef.current;
              pendingRef.current = [];
              q.forEach((fn) => {
                try {
                  fn(e.target);
                } catch {
                  /* noop */
                }
              });
              armBlockCheck();
            },
            onStateChange: (e) => !cancelled && handlers.current.onState(e.data),
            onError: (e) => !cancelled && handlers.current.onError(e.data),
            onAutoplayBlocked: () => !cancelled && setBlocked(true),
          },
        });
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });

    return () => {
      cancelled = true;
      playerRef.current = null;
      setReady(false);
      try {
        p?.destroy();
      } catch {
        /* noop */
      }
      parent.replaceChildren();
    };
  }, [started, retryNonce, armBlockCheck]);

  useEffect(
    () => () => {
      if (blockTimer.current) clearTimeout(blockTimer.current);
      if (skipTimer.current) clearTimeout(skipTimer.current);
    },
    []
  );

  const api = useMemo<MusicPlayerApi>(
    () => ({
      currentVideoId,
      playerState,
      ready,
      blocked,
      error,
      playSong,
      play: () =>
        run((p) => {
          p.playVideo();
          armBlockCheck();
        }),
      pause: () => run((p) => p.pauseVideo()),
      seek: (sec) => run((p) => p.seekTo(Math.max(0, sec), true)),
      setRate: (r) => {
        useMusic.getState().setPrefs({ rate: r });
        run((p) => p.setPlaybackRate(r));
      },
      getTime: () => {
        try {
          return playerRef.current?.getCurrentTime?.() ?? 0;
        } catch {
          return 0;
        }
      },
      getDuration: () => {
        try {
          return playerRef.current?.getDuration?.() ?? 0;
        } catch {
          return 0;
        }
      },
      getRates: () => {
        try {
          return playerRef.current?.getAvailablePlaybackRates?.() ?? [];
        } catch {
          return [];
        }
      },
      next: () => {
        step(1);
      },
      prev: () => {
        step(-1);
      },
      setBusy: (b) => {
        busyRef.current = b;
      },
      transportSlot,
      stickyEl,
    }),
    [currentVideoId, playerState, ready, blocked, error, playSong, run, armBlockCheck, step, transportSlot, stickyEl]
  );

  const current = currentVideoId ? SONG_BY_ID.get(currentVideoId) : undefined;
  const errText = error ? ERROR_TEXT[error.code] ?? `再生エラー (${error.code})` : null;

  return (
    <Ctx.Provider value={api}>
      <div
        ref={setStickyEl}
        className={`${started ? "" : "hidden"} ${onSongPage ? "sticky top-[var(--hdr,53px)] z-10" : "mb-4"} -mx-4 bg-slate-900 shadow-sm`}
      >
        <div className="relative mx-auto aspect-video max-h-[40vh] min-h-[200px] w-full md:max-w-[calc(40vh*16/9)]">
          <div ref={hostParentRef} className="absolute inset-0 [&>iframe]:h-full [&>iframe]:w-full" />
          {loadError && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-900 p-4 text-center text-sm text-white">
              <div>YouTube プレーヤーを読み込めませんでした（オフライン？）</div>
              <button onClick={() => setRetryNonce((n) => n + 1)} className="btn bg-white px-3 py-1.5 text-sm text-brand-ink">
                再試行
              </button>
            </div>
          )}
          {errText && error && (
            <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-2 bg-black/80 p-2 text-xs text-white">
              <span className="flex-1">⚠ {errText}</span>
              <a href={watchUrl(error.videoId)} target="_blank" rel="noreferrer" className="underline">
                YouTubeで開く
              </a>
              {playMode === "all" && error.code !== 153 && <span className="text-white/60">3秒後に次の曲へ</span>}
            </div>
          )}
        </div>
        {blocked && (
          <div className="bg-amber-100 px-4 py-1.5 text-center text-xs font-medium text-amber-800">
            ▶ 動画をタップして再生を開始してください
          </div>
        )}
        {!onSongPage && current && (
          <button
            onClick={() => navigate(`/music/${current.videoId}`)}
            className="flex w-full items-center gap-2 bg-white px-4 py-2 text-left text-sm"
          >
            <span className="text-brand-green">♪ 再生中</span>
            <span className="min-w-0 flex-1 truncate font-medium text-brand-ink">
              {current.title} <span className="text-slate-400">— {current.artist}</span>
            </span>
            <span className="text-xs text-brand-green">歌詞を見る ›</span>
          </button>
        )}
        {/* 曲画面の操作バー（SongView から portal で差し込む） */}
        <div ref={setTransportSlot} className={onSongPage ? "" : "hidden"} />
      </div>
      <Outlet />
    </Ctx.Provider>
  );
}
