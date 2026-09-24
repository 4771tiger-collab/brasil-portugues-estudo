// ============================================================================
// 経過時間を積算する時計（純関数。時刻は引数で受け取る）
// useActivityTimer（音楽の再生時間など）と useVisibleStopwatch（練習の所要時間）で使う。
//   検証: scripts/check-srs.ts
// running の間だけ ms を数え、take で「整数の秒」を取り出す（端数の ms は次へ持ち越す）。
// ============================================================================

export interface ActiveClock {
  /** 数えている最中か */
  running: boolean;
  /** running になった時刻（ms）。running でなければ意味を持たない */
  since: number;
  /** 取り出していない ms（止めた区間の合計） */
  acc: number;
}

export const newClock = (): ActiveClock => ({ running: false, since: 0, acc: 0 });

/** 数える／止めるを切り替える（同じ状態なら同じオブジェクト）。止めるときはそこまでの ms を acc に足す */
export function clockRun(c: ActiveClock, running: boolean, now: number): ActiveClock {
  if (running === c.running) return c;
  if (running) return { running: true, since: now, acc: c.acc };
  return { running: false, since: 0, acc: c.acc + Math.max(0, now - c.since) };
}

/** ここまでの時間を整数の秒で取り出す。端数の ms は残し、数えている最中なら now から数え直す */
export function clockTake(c: ActiveClock, now: number): { sec: number; clock: ActiveClock } {
  const total = c.acc + (c.running ? Math.max(0, now - c.since) : 0);
  const sec = Math.floor(total / 1000);
  const rest = total - sec * 1000;
  return { sec, clock: { running: c.running, since: c.running ? now : 0, acc: rest } };
}

/** 開始から今までの秒数（四捨五入・上限つき・負にならない）。録音や通し再生の長さに使う */
export function elapsedSec(startMs: number, capSec: number, now: number = Date.now()): number {
  return Math.min(capSec, Math.max(0, Math.round((now - startMs) / 1000)));
}
