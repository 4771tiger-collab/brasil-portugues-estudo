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

export function songIndex(videoId: string): number {
  return SONGS.findIndex((s) => s.videoId === videoId);
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
