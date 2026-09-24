// ============================================================================
// 会話のロールプレイ（シャドーイングの会話教材 kind: "dialogue"。T2-3）
// - 自分の役（話者の1人）を選ぶと、相手のセリフだけを読み上げ、自分のセリフの番では待つ
// - 自分の番の待ち方: 考える間（turnGapMs）が過ぎたら自動で次へ、または「次へ」を押すまで
//   （🎤 言ってみるを使うときは、押すまで待つ）。どちらも「次へ」で先へ進める
// - どこでも AbortSignal で止められる。止めた行から再開できるよう、次に始める行の番号を返す
// - 最初の読み上げは呼び出し（クリック処理）の中で同期に始まる（runRolePlay は最初の await より前に speak を呼ぶ）
// 純関数と、依存（読み上げ・待ち）を差し替えられる進行役。ストア・DOM には触らない。
// 検証: scripts/check-content.ts
// ============================================================================

import { lineSpeaker } from "./materials";

/** 自分の番の考える間の下限（ms） */
export const TURN_GAP_MIN_MS = 1500;
/** 自分の番の考える間: 1文字あたり（ms。速さ 1.0 のとき） */
export const TURN_GAP_PER_CHAR_MS = 90;
/** 相手のセリフが続くときの間（ms） */
export const PARTNER_GAP_MS = 500;

/** 自分の番の考える間 = max(1.5秒, 文字数 × 90ms ÷ 速さ) */
export function turnGapMs(text: string, rate: number): number {
  const r = rate > 0 && Number.isFinite(rate) ? rate : 1;
  const chars = text.trim().length;
  return Math.max(TURN_GAP_MIN_MS, Math.round((chars * TURN_GAP_PER_CHAR_MS) / r));
}

/** 各行が自分（me の話者）の番か */
export function myTurns(lines: readonly { speaker?: string }[], me: string): boolean[] {
  return lines.map((l) => lineSpeaker(l) === me);
}

export interface RolePlayDeps {
  /** 相手のセリフを読む（読み終えたら resolve。止めたときも resolve でよい） */
  speak(text: string, line: number): Promise<unknown>;
  /** 自分の番を待つ（先へ進んでよくなったら resolve。止めたら reject してよい） */
  turn(line: number, signal: AbortSignal): Promise<void>;
  /** 相手のセリフが続くときの間（止めたら reject してよい） */
  pause(ms: number, signal: AbortSignal): Promise<void>;
  /** その行に進んだ（表示の更新。mine = 自分の番） */
  onLine?(line: number, mine: boolean): void;
}

export interface RolePlayResult {
  /** 最後の行まで通した */
  completed: boolean;
  /** 次に始める行（止めた行。言い終えた・読み終えた行の次） */
  next: number;
}

/**
 * from 行目から会話を進める。相手の行は speak、自分の行は turn を待つ。
 * 止めた（signal）ら、途中の行はその行から、終えた行の後ならその次から再開できる next を返す
 */
export async function runRolePlay(
  lines: readonly { pt: string }[],
  mine: readonly boolean[],
  from: number,
  deps: RolePlayDeps,
  signal: AbortSignal,
  gapMs: number = PARTNER_GAP_MS
): Promise<RolePlayResult> {
  const start = Math.max(0, Math.floor(from));
  if (start >= lines.length) return { completed: false, next: lines.length };
  let next = start;
  try {
    for (let i = start; i < lines.length; i++) {
      if (signal.aborted) break;
      deps.onLine?.(i, !!mine[i]);
      // 相手の行はここで（最初の行ならクリック処理の中で同期に）読み始める
      if (mine[i]) await deps.turn(i, signal);
      else await deps.speak(lines[i].pt, i);
      if (signal.aborted) break;
      next = i + 1;
      // 相手のセリフが続くときだけ間を置く（自分の番の後は、待った時間がそのまま間になる）
      if (!mine[i] && i + 1 < lines.length && !mine[i + 1] && gapMs > 0) await deps.pause(gapMs, signal);
    }
  } catch {
    // 止めた（待ちが AbortError で終わった）
  }
  return { completed: !signal.aborted && next >= lines.length, next };
}

const abortError = () => new DOMException("aborted", "AbortError");

/**
 * 自分の番を待つ。setAdvance に渡した関数（「次へ」）が呼ばれるか、gapMs が過ぎたら resolve
 * （gapMs が null なら「次へ」を押すまで待つ）。signal で止めたら AbortError で reject。
 * 終わったら setAdvance(null) を呼ぶ（「次へ」を消す）
 */
export function waitTurn(
  gapMs: number | null,
  signal: AbortSignal,
  setAdvance: (advance: (() => void) | null) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      setAdvance(null);
      if (ok) resolve();
      else reject(abortError());
    };
    const onAbort = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    if (gapMs !== null) timer = setTimeout(() => finish(true), Math.max(0, gapMs));
    setAdvance(() => finish(true));
  });
}
