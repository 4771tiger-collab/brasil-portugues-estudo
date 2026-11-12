import { useCallback, useEffect, useRef, useState } from "react";
import type { Rating, SrsCard } from "../../data/types";
import { useProgress } from "../../store/useProgress";
import { useSpeak, type SpeakDaily } from "../../store/useSpeak";
import type { SayItem } from "../../speak/catalog";
import UndoToast from "../UndoToast";
import SayCard, { SAY_RATINGS } from "./SayCard";

/** 「言えなかった」文を同じ回の最後にもう一度出す回数の上限（文ごと） */
export const SAY_REPEAT_MAX = 2;

export interface SayResult {
  /** 出した文の数（言い直しは数えない） */
  total: number;
  /** 最初の評価の内訳 */
  good: number;
  hard: number;
  again: number;
  /** 最初に言えなかった文 */
  missed: SayItem[];
}

interface Entry {
  item: SayItem;
  /** この文を出した回数（0 = 最初） */
  rep: number;
}

interface Undo {
  id: string;
  prevCard: SrsCard | undefined;
  prevDaily: SpeakDaily;
  /** 評価で末尾に足したか（取り消すときに外す） */
  requeued: boolean;
  rating: Rating;
  rep: number;
  label: string;
}

interface Props {
  items: readonly SayItem[];
  onDone: (r: SayResult) => void;
  /** 評価ボタンに次回までの目安を出さない */
  hideIntervals?: boolean;
}

/**
 * 口慣らしの文を順に出して、評価を記録する（復習セッションと、レッスンの「言う」ステップで共通）。
 * - 評価は useSpeak（文のカード）に書き、声に出した回数を学習ログ（speak）に足す。
 * - 「言えなかった」文は同じ回の最後にもう一度出す（言えるまで。文ごとに SAY_REPEAT_MAX 回まで）。
 * - 評価の直後は取り消せる（1段）。
 */
export default function SayRunner({ items, onDone, hideIntervals }: Props) {
  const [queue, setQueue] = useState<Entry[]>(() => items.map((item) => ({ item, rep: 0 })));
  const [idx, setIdx] = useState(0);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [toastKey, setToastKey] = useState(0);
  const stats = useRef({ good: 0, hard: 0, again: 0, missed: [] as SayItem[] });
  const doneRef = useRef(false);
  const cur = queue[idx];
  const card = useSpeak((s) => (cur ? s.cards[cur.item.id] : undefined));

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    const s = stats.current;
    onDone({ total: items.length, good: s.good, hard: s.hard, again: s.again, missed: s.missed });
  }, [items.length, onDone]);

  // 文が無いときはすぐ終える
  useEffect(() => {
    if (!items.length) finish();
  }, [items.length, finish]);

  const rate = useCallback(
    (rating: Rating) => {
      const e = queue[idx];
      if (!e) return;
      const sp = useSpeak.getState();
      const prevCard = sp.cards[e.item.id];
      const prevDaily = sp.daily;
      sp.rate(e.item.id, rating);
      useProgress.getState().logActivity("speak", 1, 0);
      if (e.rep === 0) {
        stats.current[rating === "easy" ? "good" : rating]++;
        if (rating === "again") stats.current.missed.push(e.item);
      }
      const requeued = rating === "again" && e.rep < SAY_REPEAT_MAX;
      const next = requeued ? [...queue, { item: e.item, rep: e.rep + 1 }] : queue;
      if (requeued) setQueue(next);
      setUndo({
        id: e.item.id,
        prevCard,
        prevDaily,
        requeued,
        rating,
        rep: e.rep,
        label: SAY_RATINGS.find((b) => b.rating === rating)?.label ?? "",
      });
      setToastKey((k) => k + 1);
      if (idx + 1 >= next.length) finish();
      else setIdx(idx + 1);
    },
    [queue, idx, finish]
  );

  function doUndo() {
    const u = undo;
    if (!u || doneRef.current) return;
    setUndo(null);
    useSpeak.getState().restoreCard(u.id, u.prevCard, u.prevDaily);
    if (u.rep === 0) {
      const s = stats.current;
      s[u.rating === "easy" ? "good" : u.rating]--;
      if (u.rating === "again") s.missed = s.missed.filter((m) => m.id !== u.id);
    }
    if (u.requeued) setQueue((q) => q.slice(0, -1));
    setIdx((i) => Math.max(0, i - 1));
  }

  if (!cur) return null;
  const total = queue.length;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={idx}>
          <div className="h-full rounded-full bg-brand-green transition-all" style={{ width: `${Math.round((idx / total) * 100)}%` }} />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-slate-500">
          {idx + 1} / {total}
        </span>
      </div>
      {cur.rep > 0 && <p className="text-center text-xs font-bold text-rose-500">もう一度（さっき言えなかった文）</p>}
      <SayCard key={`${cur.item.id}#${cur.rep}`} item={cur.item} card={card} onRate={rate} hideIntervals={hideIntervals} />
      {undo && (
        <UndoToast
          key={toastKey}
          message={`「${undo.label}」にしました`}
          onUndo={doUndo}
          onClose={() => setUndo(null)}
          bottom="calc(1rem + env(safe-area-inset-bottom))"
        />
      )}
    </div>
  );
}
