import { useCallback, useEffect, useRef, useState } from "react";
import type { Rating, SrsCard } from "../../data/types";
import { useProgress } from "../../store/useProgress";
import { useSpeak, type SpeakDaily } from "../../store/useSpeak";
import { CAN_SAY_DAYS, type SayItem } from "../../speak/catalog";
import { Undo2 } from "lucide-react";
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
  /** この回で「言える文」（復習の間隔 CAN_SAY_DAYS 日以上）になった文 */
  gained: SayItem[];
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
  /** この評価で「言える文」になったか（取り消すときに外す） */
  gained: boolean;
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
 * - 直前の評価は取り消せる（1段。次の文を評価するまで）。
 */
export default function SayRunner({ items, onDone, hideIntervals }: Props) {
  const [queue, setQueue] = useState<Entry[]>(() => items.map((item) => ({ item, rep: 0 })));
  const [idx, setIdx] = useState(0);
  const [undo, setUndo] = useState<Undo | null>(null);
  const stats = useRef({ good: 0, hard: 0, again: 0, missed: [] as SayItem[], gained: [] as SayItem[] });
  const doneRef = useRef(false);
  const cur = queue[idx];
  const card = useSpeak((s) => (cur ? s.cards[cur.item.id] : undefined));

  const finish = useCallback(() => {
    if (doneRef.current) return;
    doneRef.current = true;
    const s = stats.current;
    onDone({ total: items.length, good: s.good, hard: s.hard, again: s.again, missed: s.missed, gained: s.gained });
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
      // 今の評価で「言える文」になった（間隔が CAN_SAY_DAYS 日に届いた）
      const nowDays = useSpeak.getState().cards[e.item.id]?.intervalDays ?? 0;
      const becameCanSay = (prevCard?.intervalDays ?? 0) < CAN_SAY_DAYS && nowDays >= CAN_SAY_DAYS;
      if (becameCanSay) stats.current.gained.push(e.item);
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
        gained: becameCanSay,
        requeued,
        rating,
        rep: e.rep,
        label: SAY_RATINGS.find((b) => b.rating === rating)?.label ?? "",
      });
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
    if (u.gained) stats.current.gained = stats.current.gained.filter((m) => m.id !== u.id);
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
      {/* 直前の評価の取り消し（次の文を評価するまで出す。評価ボタンに重ならないよう、上に置く） */}
      {undo && (
        <button type="button" onClick={doUndo} className="mx-auto flex min-h-9 items-center gap-1 rounded-full bg-slate-100 px-3 text-xs font-semibold text-slate-600 active:scale-95">
          <Undo2 size={14} aria-hidden />
          前の文の「{undo.label}」を取り消す
        </button>
      )}
      {cur.rep > 0 && <p className="text-center text-xs font-bold text-rose-500">もう一度（さっき言えなかった文）</p>}
      <SayCard key={`${cur.item.id}#${cur.rep}`} item={cur.item} card={card} onRate={rate} hideIntervals={hideIntervals} />
    </div>
  );
}
