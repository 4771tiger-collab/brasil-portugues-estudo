// ============================================================================
// 音楽タブの状態（端末内に保存）
// - 曲ごとの同期オフセット・和訳（行テキストのハッシュをキーに保存。行番号基準にせず、歌詞本文も残さない）
//   文ごとの和訳（複数行をまとめて訳したもの）も同じ translations に、文の本文のハッシュ（lineGroupKey）をキーに置く
//   AI 翻訳（Claude。aiTranslate.ts）の訳も行のハッシュをキーに source "ai"・note（訳の補足）つきで置く
// - 「自分で訳す」をした行の印 selfTranslated（B3-08。行のハッシュだけ）
// - 曲から「単語帳に追加」した語と、辞書に無い語をユーザーが意味入力して追加した語
// 歌詞そのものは lyricsCache.ts（別キー・バックアップ対象外）に置く。
// ============================================================================

import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { UserWordRaw } from "../data/loadWords";
import { userWordMap } from "../data/loadWords";
import { isLineHash, lineHash } from "../services/lyrics";
import type { JaMode, TranslationSource } from "../services/lyricSentences";
import type { GapMode } from "../services/musicPractice";
import { canHaveProd, prodKey } from "../srs/cardKey";
import { useProgress } from "./useProgress";

export interface LineTranslation {
  text: string;
  edited: boolean;
  /**
   * 訳の出どころ（任意フィールド。無い古い記録は機械翻訳か自分の訳 = edited で見分ける）:
   * mt = 無料の機械翻訳 / ai = AI 翻訳 / user = 自分で書いた・直した訳
   */
  source?: TranslationSource;
  /** 訳の補足（任意フィールド。AI 翻訳の注など） */
  note?: string;
}

/** mergeTranslations に渡す訳1件（AI 翻訳の訳の補足つき） */
export interface TranslationInput {
  text: string;
  note?: string;
}

export interface SongState {
  offsetMs: number;
  /**
   * key = lineHash(歌詞の行)、または文ごとの訳は lineGroupKey(文)（どちらも歌詞本文を保存しないためハッシュ。
   * 1行だけの文のキーはその行のキーと同じ）
   */
  translations: Record<string, LineTranslation>;
  /**
   * 「自分で訳してから機械翻訳と比べる」をした行（B3-08 で足した任意フィールド）。
   * key = lineHash(歌詞の行)、値は常に true（ハッシュだけで、歌詞本文も訳文も持たない）
   */
  selfTranslated?: Record<string, true>;
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
  /** 1行停止・行リピートで、行の後に置く間（B3-08。無い古い保存データは DEFAULT_PREFS の off で補う） */
  gapMode: GapMode;
  /** 和訳の単位: 文ごと（既定）/ 行ごと（無い古い保存データは DEFAULT_PREFS の sentence で補う） */
  jaMode: JaMode;
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
  /**
   * 翻訳の結果を反映（source 既定は "mt"）。ユーザーが編集した訳は上書きしない。
   * 機械翻訳（mt）で AI の訳を上書きすることもしない（作り直しで訳が粗くならないように）。空の訳は反映しない。
   * 値は訳の文字列か { text, note }（AI 翻訳の訳の補足。空の note は付けない）。上書きした訳の古い note は残さない
   */
  mergeTranslations: (
    videoId: string,
    map: Record<string, string | TranslationInput>,
    source?: Exclude<TranslationSource, "user">
  ) => void;
  /** 自分の訳を保存（edited・source "user"。訳の補足 note は残す）。空なら削除（未翻訳に戻る） */
  editTranslation: (videoId: string, key: string, text: string) => void;
  /** 「機械翻訳を採用」: 手で直した行でも機械翻訳の訳（edited: false）に置き換える。空なら何もしない */
  adoptMachineTranslation: (videoId: string, key: string, text: string, source?: Exclude<TranslationSource, "user">) => void;
  /** 「自分で訳す」をした行に印を付ける（key は lineHash。ハッシュの形でなければ何もしない） */
  markSelfTranslated: (videoId: string, key: string) => void;
  addWord: (id: string, videoId: string, surface: string) => void;
  /**
   * 曲の単語から外す。videoId を渡すとその曲の記録だけ（他の曲で追加した記録は残す）。
   * どの曲にも残らなくなった時だけ、この機能が作った未評価のカードを SRS から消す。
   */
  removeWord: (id: string, videoId?: string) => void;
  /** 辞書に無い語を意味入力して追加。戻り値は単語ID */
  addUserWord: (pt: string, ja: string, pos: string) => string;
  clearAddedWords: () => void;
  /** 「自分で訳す」の印をすべての曲から消す（和訳・同期設定は残す。進捗のリセットで使う） */
  clearSelfTranslated: () => void;
  /** reconcile でカードを作り直した語を「この機能が作ったカード」として記録 */
  markCreated: (id: string) => void;
  exportData: () => MusicExport;
  importData: (data: Partial<MusicExport>) => void;
}

const DEFAULT_PREFS: MusicPrefs = {
  showKana: true,
  showJa: true,
  autoScroll: true,
  playMode: "all",
  rate: 1,
  gapMode: "off",
  jaMode: "sentence",
};

/** ハッシュ済みのキー（cyrb53 の base36・11文字以下）か */
const isHashKey = isLineHash;

/** 旧形式（行テキストそのもの）のキーをハッシュに変換（統合インポートの前にも使う） */
export function hashTranslationKeys(songs: Record<string, SongState>): Record<string, SongState> {
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

      mergeTranslations: (videoId, map, source = "mt") => {
        const s = song(get(), videoId);
        const translations = { ...s.translations };
        let changed = false;
        for (const [k, raw] of Object.entries(map)) {
          const obj = typeof raw === "object" && raw !== null ? raw : null;
          const text = typeof raw === "string" ? raw.trim() : typeof obj?.text === "string" ? obj.text.trim() : "";
          const note = typeof obj?.note === "string" ? obj.note.trim() : "";
          const cur = translations[k];
          if (!text || cur?.edited) continue;
          if (source === "mt" && cur?.source === "ai") continue;
          translations[k] = { text, edited: false, source, ...(note ? { note } : {}) };
          changed = true;
        }
        if (!changed) return;
        set({ songs: { ...get().songs, [videoId]: { ...s, translations } } });
      },

      editTranslation: (videoId, key, text) => {
        const s = song(get(), videoId);
        const translations = { ...s.translations };
        // 空で保存したら削除（未翻訳に戻り、機械翻訳で作り直せる）
        if (text.trim()) {
          const note = translations[key]?.note;
          translations[key] = { text: text.trim(), edited: true, source: "user", ...(note ? { note } : {}) };
        } else delete translations[key];
        set({ songs: { ...get().songs, [videoId]: { ...s, translations } } });
      },

      adoptMachineTranslation: (videoId, key, text, source = "mt") => {
        if (!text.trim()) return;
        const s = song(get(), videoId);
        // 訳の補足（note）は行についての説明なので残す
        const note = s.translations[key]?.note;
        const translations = { ...s.translations, [key]: { text: text.trim(), edited: false, source, ...(note ? { note } : {}) } };
        set({ songs: { ...get().songs, [videoId]: { ...s, translations } } });
      },

      markSelfTranslated: (videoId, key) => {
        if (!isLineHash(key)) return;
        const s = song(get(), videoId);
        if (s.selfTranslated?.[key] === true) return;
        const selfTranslated: Record<string, true> = { ...(s.selfTranslated ?? {}), [key]: true };
        set({ songs: { ...get().songs, [videoId]: { ...s, selfTranslated } } });
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
          if (created && card && card.last === null) {
            progress.removeCard(id);
            // 同じ語の未評価の産出カード（T2-1。通常は評価したときに作られるので残らないが、取り込んだ記録などに備える）
            if (canHaveProd(id) && progress.cards[prodKey(id)]?.last === null) progress.removeCard(prodKey(id));
          }
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

      clearSelfTranslated: () => {
        const cur = get().songs;
        if (!Object.values(cur).some((s) => s?.selfTranslated)) return;
        const songs: Record<string, SongState> = {};
        for (const [vid, s] of Object.entries(cur)) {
          if (!s?.selfTranslated) {
            songs[vid] = s;
            continue;
          }
          const { selfTranslated: _omit, ...rest } = s;
          songs[vid] = rest;
        }
        set({ songs });
      },

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
