import type { Rating, SrsCard } from "../data/types";
import { newCard, previewInterval } from "../srs/scheduler";

const BUTTONS: { rating: Rating; label: string; cls: string }[] = [
  { rating: "again", label: "もう一度", cls: "bg-rose-50 text-rose-600 ring-rose-200" },
  { rating: "hard", label: "あいまい", cls: "bg-amber-50 text-amber-600 ring-amber-200" },
  { rating: "good", label: "普通", cls: "bg-emerald-50 text-emerald-600 ring-emerald-200" },
  { rating: "easy", label: "簡単", cls: "bg-blue-50 text-blue-600 ring-blue-200" },
];

export default function RatingButtons({
  card,
  onRate,
  size = "md",
}: {
  card?: SrsCard;
  onRate: (r: Rating) => void;
  size?: "sm" | "md";
}) {
  const base = card ?? newCard();
  return (
    <div className="grid grid-cols-4 gap-1.5">
      {BUTTONS.map((b) => (
        <button
          key={b.rating}
          type="button"
          onClick={() => onRate(b.rating)}
          className={`flex flex-col items-center rounded-lg ring-1 transition active:scale-95 ${b.cls} ${
            size === "sm" ? "px-1 py-1" : "px-2 py-1.5"
          }`}
        >
          <span className={`font-bold ${size === "sm" ? "text-xs" : "text-sm"}`}>{b.label}</span>
          <span className="text-[10px] opacity-70">{previewInterval(base, b.rating)}</span>
        </button>
      ))}
    </div>
  );
}
