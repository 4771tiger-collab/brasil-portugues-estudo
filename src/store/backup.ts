// scripts/check-backup.ts（tsconfig.node.json）からも読むため、__APP_VERSION__ などの宣言を明示して参照する
/// <reference path="../vite-env.d.ts" />
// ============================================================================
// バックアップ（エクスポート/インポート/リセット）
// 形式（v1〜v3・未知の version の読み分け）は backupFormat.ts（純関数）。
// v3 = v2（進捗の最上位フィールド＋ music）に app・settings（B2-06 で history）を足したもの。旧版のアプリでも読める。
// 取り込みは「統合」（merge.ts の純関数。別の端末の記録と合わせる）と「置き換え」を選べる。
// 歌詞キャッシュ(lyricsCache)は含めない（再取得できるため・著作物のため）。
// ============================================================================

import { todayStr } from "../srs/scheduler";
import {
  composeBackup,
  parseBackup,
  type AppInfo,
  type BackupData,
  type ParseResult,
  type ProgressPart,
} from "./backupFormat";
import { cardDiff, mergeMusic, mergeProgress, type CardDiff, type ImportMode } from "./merge";
import { useMeta } from "./useMeta";
import { hashTranslationKeys, useMusic } from "./useMusic";
import { useProgress } from "./useProgress";
import { useSettings } from "./useSettings";

export { parseBackup, describeBackup, type BackupData, type ParseResult } from "./backupFormat";
export type { CardDiff, ImportMode } from "./merge";

/** このアプリの版（vite の define。scripts/ から tsx で読むときは未定義なので "dev"） */
function appInfo(): AppInfo {
  return {
    version: typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev",
    build: typeof __BUILD_ID__ !== "undefined" ? __BUILD_ID__ : "dev",
  };
}

export function exportAll(): string {
  const progress = JSON.parse(useProgress.getState().exportJSON()) as Record<string, unknown>;
  const backup = composeBackup({
    progress,
    music: useMusic.getState().exportData(),
    settings: useSettings.getState(),
    app: appInfo(),
  });
  return JSON.stringify(backup, null, 2);
}

/** 追加済みなのにカードが無い語（v1 ファイルの取り込み等）にカードを作り直す */
export function reconcile(): void {
  const { addedWords, markCreated } = useMusic.getState();
  const { cards, addCard } = useProgress.getState();
  for (const id of new Set(addedWords.map((w) => w.id))) {
    if (cards[id]) continue;
    addCard(id);
    markCreated(id); // 外す時にこの未評価カードも消せるように
  }
}

/** 端末の進捗を、バックアップの進捗と同じ形で取り出す（統合の入力） */
function localProgress(): ProgressPart {
  const s = useProgress.getState();
  return {
    cards: s.cards,
    streak: s.streak,
    bestStreak: s.bestStreak,
    lastStudyDate: s.lastStudyDate,
    totalReviews: s.totalReviews,
    customPassages: s.customPassages,
    pinnedNew: s.pinnedNew,
    history: s.history ?? {},
  };
}

/**
 * 読み取り済みのバックアップを端末に取り込む。取り込んだ前後のカードの変化を返す（失敗は null）。
 * - replace（置き換え）
 *   - 進捗: 置き換え（今日のカウンタ daily は端末側のまま）
 *   - 曲のデータ: ファイルにあれば置き換え、無ければ（v1）端末側のまま
 *   - 設定: ファイルにあれば上書き（voiceURI は端末側のまま）
 * - merge（統合。規則は merge.ts）
 *   - 進捗と曲のデータ: 端末とファイルの両方の記録を残して合わせる
 *   - 設定・daily: 端末側のまま（端末ごとの好みを変えない）
 * 最後に reconcile() で、曲から追加した語のカードを作り直す。
 */
export function applyBackup(data: BackupData, mode: ImportMode = "replace"): CardDiff | null {
  const before = useProgress.getState().cards;
  const progress = mode === "merge" ? mergeProgress(localProgress(), data.progress, todayStr()) : data.progress;
  if (!useProgress.getState().importJSON(JSON.stringify(progress))) return null;
  if (data.music) {
    // 統合は行のハッシュをキーにして比べる（ごく古いファイルは行の本文がキーなので先にハッシュにそろえる）
    const music =
      mode === "merge"
        ? mergeMusic(useMusic.getState().exportData(), { ...data.music, songs: hashTranslationKeys(data.music.songs) })
        : data.music;
    useMusic.getState().importData(music);
  }
  if (mode === "replace" && data.settings && Object.keys(data.settings).length) {
    useSettings.getState().set(data.settings);
  }
  reconcile();
  return cardDiff(before, useProgress.getState().cards);
}

export type ImportResult =
  | { ok: true; data: BackupData; warnings: string[]; diff: CardDiff }
  | { ok: false; error: string };

/** テキストを読んで取り込む（確認なし）。mode は "merge"（統合）か "replace"（置き換え）。失敗時は理由を返す */
export function importAll(json: string, mode: ImportMode): ImportResult {
  const r: ParseResult = parseBackup(json);
  if (!r.ok) return r;
  const diff = applyBackup(r.data, mode);
  if (!diff) return { ok: false, error: "学習データを取り込めませんでした" };
  return { ...r, diff };
}

/** 学習進捗のリセット。曲から追加した語の一覧も消す（和訳・同期設定は教材なので残す） */
export function resetAllProgress(): void {
  useProgress.getState().resetAll();
  useMusic.getState().clearAddedWords();
}

// ---------------------------------------------------------------------------
// ファイルとして保存（スマホは共有シート / PC はダウンロード）
// Android の Chrome の Web Share は JSON ファイルを共有できない（許可リスト外）ため、
// 共有するときは text/plain の .txt にする（中身は JSON のまま。インポートは .txt も読める）。
// ---------------------------------------------------------------------------

export type SaveResult = "shared" | "downloaded" | "cancelled";

function downloadText(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // すぐに revoke するとダウンロードが始まる前に URL が消える端末がある
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

/**
 * 共有シートを使う端末か（指で操作するスマホ・タブレット）。
 * PC の Chrome/Edge も Web Share でファイルを共有できるが、Windows の共有ダイアログには
 * 「ファイルに保存」が無く、閉じると何も保存されないため、マウスの PC ではダウンロードにする。
 */
function preferShareSheet(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/**
 * バックアップを保存する。クリックの処理の中から直接呼ぶ（共有にはユーザー操作が要る）。
 * スマホで共有できれば共有シート（.txt）、PC や共有できない環境では .json のダウンロード。
 * 共有シートを閉じた（AbortError）ときは "cancelled" で、前回のバックアップの記録は変えない。
 */
export async function saveBackupFile(): Promise<SaveResult> {
  const json = exportAll();
  const date = todayStr();
  const file =
    preferShareSheet() && typeof File !== "undefined"
      ? new File([json], `bp-backup-${date}.txt`, { type: "text/plain" })
      : null;
  if (file && typeof navigator.share === "function" && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "ブラジルポルトガル語 学習帳のバックアップ" });
      useMeta.getState().markBackup(useProgress.getState().totalReviews);
      return "shared";
    } catch (e) {
      if (isAbort(e)) return "cancelled";
      // 共有に失敗（NotAllowedError など）→ ダウンロードに切り替える
    }
  }
  downloadText(json, `bp-backup-${date}.json`, "application/json");
  useMeta.getState().markBackup(useProgress.getState().totalReviews);
  return "downloaded";
}
