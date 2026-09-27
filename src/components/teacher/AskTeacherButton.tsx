import { openTeacher, type TeacherContext } from "../../services/ai/teacherContext";

interface Props {
  /** 渡す文脈（押したときに作る関数でもよい。歌詞の行など、作るのに少し手間がかかるもの） */
  context: TeacherContext | (() => TeacherContext | null);
  /** icon = 🧑‍🏫 だけ（44px の四角）/ chip = 「🧑‍🏫 先生に聞く」の枠付き / link = 文字だけ（高さ 44px） */
  variant?: "icon" | "chip" | "link";
  label?: string;
  className?: string;
  /** 開く前に呼ぶ（動画を止めるなど） */
  onOpen?: () => void;
}

/**
 * 「🧑‍🏫 先生に聞く」ボタン。押すと、この文脈で先生のシートを開く（新しい会話。自動では送らない。
 * すぐ聞ける質問のチップを押すか、入力して送る）。キーが無ければシートにキーの作り方を出す
 */
export default function AskTeacherButton({ context, variant = "chip", label = "先生に聞く", className = "", onOpen }: Props) {
  function open(e: React.MouseEvent) {
    // カードのタップ（答えを見る）などに伝えない
    e.stopPropagation();
    const ctx = typeof context === "function" ? context() : context;
    if (!ctx) return;
    onOpen?.();
    openTeacher(ctx);
  }
  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={open}
        title={`🧑‍🏫 ${label}`}
        aria-label={`AI先生に聞く（${label}）`}
        className={`inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-base transition active:scale-90 ${className}`}
      >
        <span aria-hidden>🧑‍🏫</span>
      </button>
    );
  }
  if (variant === "link") {
    return (
      <button
        type="button"
        onClick={open}
        aria-label={`AI先生に聞く（${label}）`}
        className={`inline-flex min-h-11 items-center gap-1 text-xs font-medium text-violet-700 ${className}`}
      >
        <span aria-hidden>🧑‍🏫</span>
        {label}
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      aria-label={`AI先生に聞く（${label}）`}
      className={`chip min-h-11 gap-1 bg-violet-50 px-3 text-violet-700 ring-1 ring-violet-200 transition active:scale-95 ${className}`}
    >
      <span aria-hidden>🧑‍🏫</span>
      {label}
    </button>
  );
}
