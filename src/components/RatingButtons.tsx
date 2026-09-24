import type { Rating, SrsCard } from "../data/types";
import { newCard, previewInterval } from "../srs/scheduler";

/** 評価の表示名（取り消しトーストなどでも使う） */
export const RATING_LABEL: Record<Rating, string> = {
  again: "もう一度",
  hard: "あいまい",
  good: "普通",
  easy: "簡単",
};

/** キーボードの 1〜4 に対応する評価（ReviewSession のキー操作と表示をそろえる） */
export const RATING_KEYS: Rating[] = ["again", "hard", "good", "easy"];

const BUTTONS: { rating: Rating; cls: string; strong: string }[] = [
  { rating: "again", cls: "bg-rose-50 text-rose-600 ring-rose-200", strong: "ring-2 ring-rose-500" },
  { rating: "hard", cls: "bg-amber-50 text-amber-600 ring-amber-200", strong: "ring-2 ring-amber-500" },
  { rating: "good", cls: "bg-emerald-50 text-emerald-600 ring-emerald-200", strong: "ring-2 ring-emerald-500" },
  { rating: "easy", cls: "bg-blue-50 text-blue-600 ring-blue-200", strong: "ring-2 ring-blue-500" },
];

const SIZE = {
  // 一覧のカード内
  sm: { grid: "gap-1.5", btn: "px-1 py-1", label: "text-xs" },
  md: { grid: "gap-1.5", btn: "px-2 py-1.5", label: "text-sm" },
  // 1枚ずつ学習の親指ゾーン（高さ 56px）
  lg: { grid: "gap-2", btn: "h-14 justify-center px-1", label: "text-base" },
} as const;

export default function RatingButtons({
  card,
  onRate,
  size = "md",
  today,
  suggested,
}: {
  card?: SrsCard;
  onRate: (r: Rating) => void;
  size?: "sm" | "md" | "lg";
  /** 目安ラベルの基準日（省略時は実行時の今日） */
  today?: string;
  /** 採点から勧める評価（産出カードを入力で答えたとき）。強調するだけで、選ぶのは学習者 */
  suggested?: Rating;
}) {
  const base = card ?? newCard(today);
  const sz = SIZE[size];
  return (
    <div className={`grid grid-cols-4 ${sz.grid}`}>
      {BUTTONS.map((b, i) => (
        <button
          key={b.rating}
          type="button"
          onClick={() => onRate(b.rating)}
          aria-describedby={suggested === b.rating ? "rating-suggested" : undefined}
          className={`relative flex flex-col items-center rounded-lg ring-1 transition active:scale-95 ${b.cls} ${sz.btn} ${
            suggested === b.rating ? `${b.strong} shadow-sm` : ""
          }`}
        >
          {suggested === b.rating && (
            <span
              id="rating-suggested"
              className="pointer-events-none absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-brand-ink px-1.5 text-[9px] font-bold leading-4 text-white"
            >
              おすすめ
            </span>
          )}
          <span className={`font-bold ${sz.label}`}>
            {/* PC（md 以上）ではキー番号を小さく添える */}
            <span className="mr-1 hidden align-middle text-[10px] font-normal opacity-60 md:inline">{i + 1}</span>
            {RATING_LABEL[b.rating]}
          </span>
          <span className="text-[10px] opacity-70">{previewInterval(base, b.rating, today)}</span>
        </button>
      ))}
    </div>
  );
}
