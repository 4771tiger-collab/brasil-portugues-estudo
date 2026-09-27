// ============================================================================
// 音楽タブのデータ: 再生リストのメタデータ（歌詞は含まない）と、歌詞引き用の原形推定器
// ============================================================================

import playlistsRaw from "../../data/music-playlists.json";
import colloquialRaw from "../../data/colloquial.json";
import { DICT_RAW, WORDS_CAPOEIRA, WORDS_GENERAL } from "./loadWords";
import { getConjugator, irregularTable } from "./conjugator";
import { createLemmatizer, type ColloquialTable, type LexRef, type Lemmatizer } from "../services/lemmatize";

export interface Song {
  videoId: string;
  title: string;
  artist: string;
  /** LRCLIB 検索用のアーティスト名・曲名 */
  lrcArtist: string;
  lrcTrack: string;
  durationSec: number;
  /** 動画に合う LRCLIB の版（scripts/pin-lyrics.ts で固定。未固定なら検索） */
  lrclibId: number | null;
  /** 映画の日本語タイトル（ディズニーなど。一覧と曲画面に小さく表示） */
  film?: string;
  /**
   * LRCLIB に動画と合う正しい歌詞が無いと確認済み（別言語・別の歌手の版しか無い等）。
   * 歌詞を取りに行かない（誤った歌詞を出さないため）。lrclibId は null にする
   */
  lrcMissing?: boolean;
}

export interface Playlist {
  id: string;
  title: string;
  url: string;
  songs: Song[];
}

export const PLAYLISTS: Playlist[] = playlistsRaw as Playlist[];
export const SONGS: Song[] = PLAYLISTS.flatMap((p) => p.songs);
export const SONG_BY_ID = new Map(SONGS.map((s) => [s.videoId, s]));
const PLAYLIST_BY_SONG = new Map(PLAYLISTS.flatMap((p) => p.songs.map((s) => [s.videoId, p] as const)));

/** 曲が入っている再生リスト */
export function playlistOf(videoId: string | null | undefined): Playlist | undefined {
  return videoId ? PLAYLIST_BY_SONG.get(videoId) : undefined;
}

/** 同じ再生リストの中で dir 曲先の曲（端は反対側へ）。不明な曲なら最初の再生リストの先頭 */
export function neighborSong(videoId: string | null | undefined, dir: 1 | -1): Song {
  const pl = playlistOf(videoId);
  if (!pl) return PLAYLISTS[0].songs[0];
  const n = pl.songs.length;
  const i = pl.songs.findIndex((s) => s.videoId === videoId);
  return pl.songs[(i + dir + n) % n];
}

/** 再生リストのタブ用の短い名前（末尾の全角かっこ書きを省く: 「ディズニー（ポルトガル語吹替）」→「ディズニー」） */
export function playlistShortTitle(pl: Playlist): string {
  return pl.title.replace(/（[^）]*）$/, "").trim() || pl.title;
}

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 原形推定器（辞書数千語の索引を作るので、音楽画面を開いた時に遅延構築）
// ---------------------------------------------------------------------------
let lemmatizer: Lemmatizer | null = null;
let preparing: Promise<Lemmatizer> | null = null;

export function lexiconEntries(): LexRef[] {
  const refs: LexRef[] = [...WORDS_GENERAL, ...WORDS_CAPOEIRA].map((w) => ({
    id: w.id,
    pt: w.pt,
    ja: w.ja,
    pos: w.pos,
    source: w.source,
  }));
  DICT_RAW.forEach((r, i) => {
    refs.push({ id: `dict:${String(i).padStart(4, "0")}`, pt: r.ポルトガル語, ja: r.日本語, pos: r.品詞, source: "dict" });
  });
  return refs;
}

export function getLemmatizer(): Lemmatizer | null {
  return lemmatizer;
}

export function prepareLemmatizer(): Promise<Lemmatizer> {
  if (lemmatizer) return Promise.resolve(lemmatizer);
  if (preparing) return preparing;
  preparing = new Promise<Lemmatizer>((resolve) => {
    const build = () => {
      lemmatizer = createLemmatizer({
        entries: lexiconEntries(),
        irregular: irregularTable(),
        // 活用表・活用ドリルと同じ生成器（活用形の索引を共有する）
        conjugator: getConjugator(),
        colloquial: colloquialRaw as unknown as ColloquialTable,
      });
      resolve(lemmatizer);
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback;
    if (ric) ric(build, { timeout: 800 });
    else setTimeout(build, 50);
  });
  return preparing;
}
