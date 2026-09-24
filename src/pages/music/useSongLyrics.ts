import { useCallback, useEffect, useState } from "react";
import type { Song } from "../../data/music";
import { getCachedLyrics, setCachedLyrics } from "../../store/lyricsCache";
import {
  getLyricsById,
  LyricsNotFoundError,
  pickBest,
  searchLyrics,
  toLoaded,
  type LoadedLyrics,
} from "../../services/lyrics";

export type LyricsStatus = "loading" | "ready" | "notfound" | "instrumental" | "error";

export interface SongLyricsState {
  status: LyricsStatus;
  lyrics: LoadedLyrics | null;
  error: string | null;
  retry: () => void;
}

/** 端末キャッシュ → 固定ID(/api/get/{id}) → 検索(pickBest) の順で歌詞を取得 */
export function useSongLyrics(song: Song | undefined): SongLyricsState {
  const [status, setStatus] = useState<LyricsStatus>("loading");
  const [lyrics, setLyrics] = useState<LoadedLyrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!song) {
      setStatus("notfound");
      setLyrics(null);
      return;
    }
    const ctrl = new AbortController();
    const finish = (l: LoadedLyrics) => {
      setLyrics(l);
      setError(null);
      setStatus(l.instrumental ? "instrumental" : l.lines.length ? "ready" : "notfound");
    };

    const cached = getCachedLyrics(song.videoId);
    if (cached && (song.lrclibId == null || cached.id === song.lrclibId)) {
      finish(toLoaded(cached));
      return;
    }

    setStatus("loading");
    setLyrics(null);
    (async () => {
      try {
        let rec = song.lrclibId != null ? await getLyricsById(song.lrclibId, ctrl.signal).catch(() => null) : null;
        if (!rec) {
          const cands = await searchLyrics(song.lrcArtist, song.lrcTrack, ctrl.signal);
          rec = pickBest(cands, song.durationSec) ?? null;
        }
        if (!rec) throw new LyricsNotFoundError("歌詞が見つかりませんでした");
        setCachedLyrics(song.videoId, rec);
        finish(toLoaded(rec));
      } catch (e) {
        if (ctrl.signal.aborted) return;
        if (e instanceof LyricsNotFoundError) {
          setStatus("notfound");
          setError(e.message);
        } else {
          setStatus("error");
          setError(navigator.onLine ? "歌詞を取得できませんでした" : "オフラインです。通信環境を確認してください");
        }
      }
    })();
    return () => ctrl.abort();
  }, [song, nonce]);

  return { status, lyrics, error, retry };
}
