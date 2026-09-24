/**
 * 一覧の絞り込みのチップ（難易度・話題など）。選べるのは1つ。押せる高さは 44px。
 * 行に収まらなければ折り返す
 */
export default function FilterChips<T extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
}: {
  options: readonly { v: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  /** まとまりの名前（読み上げ用。例: 「難易度」） */
  label: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap gap-1.5 ${className}`} role="group" aria-label={label}>
      {options.map((o) => {
        const on = o.v === value;
        return (
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            aria-pressed={on}
            className={`chip min-h-11 min-w-11 justify-center px-3.5 ring-1 transition ${
              on ? "bg-brand-green text-white ring-brand-green" : "bg-white text-slate-600 ring-slate-200"
            }`}
          >
            {o.label}
            {o.count !== undefined && <span className={`ml-1 ${on ? "text-white/80" : "text-slate-400"}`}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
