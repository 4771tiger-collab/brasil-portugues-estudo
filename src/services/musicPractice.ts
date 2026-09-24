// ============================================================================
// 曲画面の練習機能の判定（純関数。ストア・DOM・プレーヤーに触らない）
//   検証: scripts/check-srs.ts（npm run check:srs）
// - 行の後の間（gapMode）: 1行停止・行リピートで、歌った長さ×係数だけ止めてから自動で再開する
//   （その間にシャドーイング・リピートする）
// - 単語を調べた後の再開位置（replayAfterLookup）
// - 「自分で訳した行」の数（selfTranslated は行のハッシュだけ。歌詞本文は扱わない）
// ============================================================================

/** 行の後の間: off = 間なし / 1x = 歌った長さと同じ / 1.5x = 歌った長さの 1.5 倍 */
export const GAP_MODES = ["off", "1x", "1.5x"] as const;
export type GapMode = (typeof GAP_MODES)[number];

export const GAP_LABEL: Record<GapMode, string> = { off: "なし", "1x": "×1", "1.5x": "×1.5" };

/** 間の下限・上限（ms）。短すぎる行でも言い返せるように、長い行（間奏を含む行など）で待ちすぎないように */
export const GAP_MIN_MS = 1000;
export const GAP_MAX_MS = 15000;

/** 係数（知らない値・off は 0） */
export function gapFactor(mode: unknown): number {
  return mode === "1x" ? 1 : mode === "1.5x" ? 1.5 : 0;
}

/** 保存値を選択肢に丸める（将来版の値や壊れた値は off） */
export function gapMode(v: unknown): GapMode {
  return (GAP_MODES as readonly unknown[]).includes(v) ? (v as GapMode) : "off";
}

/**
 * 行の後の間（ms）。lineSec は歌詞の時刻での行の長さ（秒）、rate は再生速度。
 * 実際に聞こえた長さ（lineSec / rate）× 係数を GAP_MIN_MS〜GAP_MAX_MS に収める。
 * 0 = 間を置かない（間なし・長さが読めない・長さ 0）。
 */
export function gapDelayMs(lineSec: number, mode: unknown, rate: number): number {
  const f = gapFactor(mode);
  if (!f || !Number.isFinite(lineSec) || lineSec <= 0) return 0;
  const r = Number.isFinite(rate) && rate > 0 ? rate : 1;
  return Math.round(Math.min(GAP_MAX_MS, Math.max(GAP_MIN_MS, (lineSec * f * 1000) / r)));
}

export type LineStop = { kind: "pause" } | { kind: "gap"; ms: number } | { kind: "continue" };

/**
 * 1行停止（⏸1行）で次の行に入ったときの動き。heardSec・heardHasText は直前に聴いた行。
 * - 間なし: pause（行の頭で止め、▶ で再開する。従来どおり）
 * - 間あり: 歌詞のある行なら gap（止めて ms 後に自動で再開）。前奏・間奏（♪）の行や長さ 0 の行は
 *   言い返すものが無いので止めずに続ける（continue）
 */
export function perLineStop(heardSec: number, heardHasText: boolean, mode: unknown, rate: number): LineStop {
  if (!gapFactor(mode)) return { kind: "pause" };
  if (!heardHasText) return { kind: "continue" };
  const ms = gapDelayMs(heardSec, mode, rate);
  return ms > 0 ? { kind: "gap", ms } : { kind: "continue" };
}

/**
 * 行リピート（🔁行）で行末に来たときの間（ms）。0 なら従来どおりすぐ行の頭へ戻る。
 * 歌詞の無い行（♪）をリピートしているときは間を置かない。
 */
export function repeatGapMs(lineSec: number, hasText: boolean, mode: unknown, rate: number): number {
  return hasText ? gapDelayMs(lineSec, mode, rate) : 0;
}

/**
 * 単語シートを閉じたときに頭から聴き直す行。null なら今の位置から再開する。
 * 時間同期のある歌詞・この曲を再生中・歌詞の行から開いたシート・設定 replayAfterLookup のときだけ。
 * 行リピート中はリピートしている行に戻る（別の行に飛んでもすぐリピートの行へ戻されるため）。
 * （一時停止して調べた時だけ呼ぶ。止めていなければ再開もしない）
 */
export function lookupResumeLine(p: {
  replay: boolean;
  synced: boolean;
  isCurrent: boolean;
  line: number | null;
  lineCount: number;
  repeatIdx: number | null;
}): number | null {
  if (!p.replay || !p.synced || !p.isCurrent || p.line == null) return null;
  if (!Number.isInteger(p.line) || p.line < 0 || p.line >= p.lineCount) return null;
  if (p.repeatIdx != null && p.repeatIdx >= 0 && p.repeatIdx < p.lineCount) return p.repeatIdx;
  return p.line;
}

/** 自分で訳した行の数（keys は曲の歌詞の行のハッシュ・重複なし） */
export function selfTranslatedCount(keys: readonly string[], self: Readonly<Record<string, true>> | undefined): number {
  if (!self) return 0;
  let n = 0;
  for (const k of keys) if (self[k] === true) n++;
  return n;
}
