// ============================================================================
// 音楽タブの状態（端末内に保存）
// - 曲ごとの同期オフセット・和訳（行テキストのハッシュをキーに保存。行番号基準にせず、歌詞本文も残さない）
// - 曲から「単語帳に追加」した語と、辞書に無い語をユーザーが意味入力して追加した語
// 歌詞そのものは lyricsCache.ts（別キー・バックアップ対象外）に置く。
// ============================================================================

import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UserWordRaw } from "../data/loadWords";
import { userWordMap } from "../data/loadWords";
import { lineHash } from "../services/lyrics";
import { useProgress } from "./useProgress";

export interface LineTranslation {
  text: string;
  edited: boolean;
}

export interface SongState {
  offsetMs: number;
  /** key = lineHash(歌詞の行)（歌詞本文を保存しないためハッシュ） */
  translations: Record<string, LineTranslation>;
}

export interface AddedWord {
  id: string;
  videoId: string;
  /** 歌詞に出てきた形（活用形など） */
  surface: string;
  /** この追加でカードを新規作成したか（削除時にカードを消してよいかの判定用） */
  createdCard: boolean;
  addedAt: string;
}

export interface MusicPrefs {
  showKana: boolean;
  showJa: boolean;
  autoScroll: boolean;
  /** all = 連続再生 / one = 1曲リピート */
  playMode: "all" | "one";
  rate: number;
}

export interface MusicExport {
  songs: Record<string, SongState>;
  addedWords: AddedWord[];
  userWords: UserWordRaw[];
}

interface MusicState extends MusicExport {
  prefs: MusicPrefs;

  setPrefs: (patch: Partial<MusicPrefs>) => void;
  setOffset: (videoId: string, offsetMs: number) => void;
  /** 機械翻訳の結果を反映（ユーザーが編集した行は上書きしない） */
  mergeTranslations: (videoId: string, map: Record<string, string>) => void;
  editTranslation: (videoId: string, key: string, text: string) => void;
  addWord: (id: string, videoId: string, surface: string) => void;
  /**
   * 曲の単語から外す。videoId を渡すとその曲の記録だけ（他の曲で追加した記録は残す）。
   * どの曲にも残らなくなった時だけ、この機能が作った未評価のカードを SRS から消す。
   */
  removeWord: (id: string, videoId?: string) => void;
  /** 辞書に無い語を意味入力して追加。戻り値は単語ID */
  addUserWord: (pt: string, ja: string, pos: string) => string;
  clearAddedWords: () => void;
  /** reconcile でカードを作り直した語を「この機能が作ったカード」として記録 */
  markCreated: (id: string) => void;
  exportData: () => MusicExport;
  importData: (data: Partial<MusicExport>) => void;
}

const DEFAULT_PREFS: MusicPrefs = { showKana: true, showJa: true, autoScroll: true, playMode: "all", rate: 1 };

/** ハッシュ済みのキー（cyrb53 の base36・11文字以下）か */
const isHashKey = (k: string) => /^[0-9a-z]{1,11}$/.test(k);

/** 旧形式（行テキストそのもの）のキーをハッシュに変換 */
function hashTranslationKeys(songs: Record<string, SongState>): Record<string, SongState> {
  const out: Record<string, SongState> = {};
  for (const [vid, s] of Object.entries(songs)) {
    const translations: Record<string, LineTranslation> = {};
    for (const [k, v] of Object.entries(s?.translations ?? {})) translations[isHashKey(k) ? k : lineHash(k)] = v;
    out[vid] = { ...s, translations };
  }
  return out;
}

export function userWordId(pt: string): string {
  return "user:" + pt.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

function song(state: MusicState, videoId: string): SongState {
  return state.songs[videoId] ?? { offsetMs: 0, translations: {} };
}

export const useMusic = create<MusicState>()(
  persist(
    (set, get) => ({
      songs: {},
      addedWords: [],
      userWords: [],
      prefs: DEFAULT_PREFS,

      setPrefs: (patch) => set({ prefs: { ...get().prefs, ...patch } }),

      setOffset: (videoId, offsetMs) => {
        const s = song(get(), videoId);
        set({ songs: { ...get().songs, [videoId]: { ...s, offsetMs } } });
      },

      mergeTranslations: (videoId, map) => {
        const s = song(get(), videoId);
        const translations = { ...s.translations };
        for (const [k, text] of Object.entries(map)) {
          if (translations[k]?.edited) continue;
          translations[k] = { text, edited: false };
        }
        set({ songs: { ...get().songs, [videoId]: { ...s, translations } } });
      },

      editTranslation: (videoId, key, text) => {
        const s = song(get(), videoId);
        const translations = { ...s.translations };
        // 空で保存したら削除（未翻訳に戻り、機械翻訳で作り直せる）
        if (text.trim()) translations[key] = { text: text.trim(), edited: true };
        else delete translations[key];
        set({ songs: { ...get().songs, [videoId]: { ...s, translations } } });
      },

      addWord: (id, videoId, surface) => {
        const state = get();
        if (state.addedWords.some((w) => w.id === id && w.videoId === videoId)) return;
        const progress = useProgress.getState();
        const createdCard = !progress.cards[id];
        progress.addCard(id);
        set({
          addedWords: [...state.addedWords, { id, videoId, surface, createdCard, addedAt: new Date().toISOString() }],
        });
      },

      removeWord: (id, videoId) => {
        const state = get();
        // videoId があればその曲の記録だけ、無ければその語の全記録を外す
        const hit = (w: AddedWord) => w.id === id && (videoId === undefined || w.videoId === videoId);
        const removed = state.addedWords.filter(hit);
        if (!removed.length) return;
        let rest = state.addedWords.filter((w) => !hit(w));
        const created = removed.some((w) => w.createdCard);
        const remaining = rest.filter((w) => w.id === id);
        if (!remaining.length) {
          // どの曲にも残っていない。この機能が作ったカードで、まだ一度も評価していない時だけカードも消す（学習履歴は消さない）
          const progress = useProgress.getState();
          const card = progress.cards[id];
          if (created && card && card.last === null) progress.removeCard(id);
        } else if (created && !remaining.some((w) => w.createdCard)) {
          // 他の曲に記録が残る → 「カードを作った」印を残る記録へ引き継ぐ（最後に外した時に未評価カードを片付けるため）
          const heir = remaining[0];
          rest = rest.map((w) => (w === heir ? { ...w, createdCard: true } : w));
        }
        set({ addedWords: rest });
      },

      addUserWord: (pt, ja, pos) => {
        const id = userWordId(pt);
        const others = get().userWords.filter((u) => u.id !== id);
        set({ userWords: [...others, { id, pt: pt.trim(), ja: ja.trim(), pos }] });
        return id;
      },

      clearAddedWords: () => set({ addedWords: [] }),

      exportData: () => {
        const { songs, addedWords, userWords } = get();
        return { songs, addedWords, userWords };
      },

      importData: (data) =>
        set({
          songs: data.songs && typeof data.songs === "object" ? hashTranslationKeys(data.songs) : {},
          addedWords: Array.isArray(data.addedWords) ? data.addedWords : [],
          userWords: Array.isArray(data.userWords) ? data.userWords : [],
        }),

      markCreated: (id) =>
        set({ addedWords: get().addedWords.map((w) => (w.id === id ? { ...w, createdCard: true } : w)) }),
    }),
    {
      name: "bp-music-v1",
      version: 1,
      // v0 は和訳のキーが歌詞の行テキストそのものだった → ハッシュに移行
      migrate: (persisted, version) => {
        const p = (persisted ?? {}) as Partial<MusicState>;
        if (version < 1 && p.songs) p.songs = hashTranslationKeys(p.songs);
        return p as MusicState;
      },
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<MusicState>;
        return { ...current, ...p, prefs: { ...DEFAULT_PREFS, ...(p.prefs ?? {}) } };
      },
    }
  )
);

/** userWords → Word のMap（resolveWord / reviewPool に渡す） */
export function useUserWordMap() {
  const userWords = useMusic((s) => s.userWords);
  return useMemo(() => userWordMap(userWords), [userWords]);
}

/** 曲から追加した語のID一覧（重複なし・追加順） */
export function useAddedIds(videoId?: string): string[] {
  const addedWords = useMusic((s) => s.addedWords);
  return useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const w of addedWords) {
      if (videoId && w.videoId !== videoId) continue;
      if (seen.has(w.id)) continue;
      seen.add(w.id);
      out.push(w.id);
    }
    return out;
  }, [addedWords, videoId]);
}
