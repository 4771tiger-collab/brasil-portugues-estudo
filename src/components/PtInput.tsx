import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useRef } from "react";

/**
 * ポルトガル語の入力欄の属性: 端末の自動修正・先頭の大文字化・予測変換・スペルチェックを止め、
 * pt-BR のキーボードを促す。確定キーは「完了」（PtInput の複数行で onSubmit が無いときは改行キー）。
 */
export const PT_INPUT_ATTRS = {
  autoCapitalize: "none",
  autoCorrect: "off",
  autoComplete: "off",
  spellCheck: false,
  lang: "pt-BR",
  enterKeyHint: "done",
} as const;

/** アクセントバーの文字（キーボードを切り替えずに打てるように） */
export const ACCENT_CHARS = ["á", "à", "â", "ã", "ç", "é", "ê", "í", "ó", "ô", "õ", "ú"] as const;

type Field = HTMLInputElement | HTMLTextAreaElement;

interface Props {
  value: string;
  onChange: (value: string) => void;
  /**
   * Enter（「完了」）で呼ぶ。複数行でも Shift+Enter 以外の Enter で呼ぶ
   * （無ければ Enter は改行で、キーボードの確定キーも改行の表示にする）
   */
  onSubmit?: () => void;
  /** 複数行（textarea）にする */
  multiline?: boolean;
  autoFocus?: boolean;
  /** 複数行のときの行数（既定 2） */
  rows?: number;
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  /** アクセントバーを出すか（既定 true。読み取り専用・無効のときは出さない） */
  accentBar?: boolean;
  /** 入力欄に足すクラス */
  className?: string;
  "aria-label"?: string;
}

/**
 * ポルトガル語の入力欄とアクセントバー。
 * アクセントのボタンは onPointerDown / onMouseDown で preventDefault してフォーカスを入力欄に残し、
 * カーソル位置に文字を入れる（入れたあとのカーソルは入れた文字の後ろ）。文字は text-base（16px。
 * これより小さいと Android/iOS がフォーカス時に拡大する）。
 */
const PtInput = forwardRef<Field | null, Props>(function PtInput(
  {
    value,
    onChange,
    onSubmit,
    multiline = false,
    autoFocus,
    rows = 2,
    placeholder,
    readOnly,
    disabled,
    accentBar = true,
    className = "",
    "aria-label": ariaLabel,
  },
  ref
) {
  const fieldRef = useRef<Field | null>(null);
  const setField = useCallback((el: Field | null) => {
    fieldRef.current = el;
  }, []);
  useImperativeHandle<Field | null, Field | null>(ref, () => fieldRef.current, [multiline]);
  // 手で文字を差し込んだあとに置くカーソル位置（value が反映された直後に合わせる）
  const caretRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = fieldRef.current;
    const pos = caretRef.current;
    if (!el || pos == null) return;
    caretRef.current = null;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // 選択範囲を持たない状態では何もしない
    }
  }, [value]);

  function insert(ch: string) {
    const el = fieldRef.current;
    if (!el || el.readOnly || el.disabled) return;
    if (document.activeElement !== el) el.focus();
    const before = el.value;
    // まずはブラウザの編集として入れる（IME の変換中の文字や取り消し履歴と整合する）
    // （フォーカスが入力欄に無いと別の場所に入ってしまうので、そのときは使わない）
    let done = false;
    if (document.activeElement === el) {
      try {
        done = document.execCommand("insertText", false, ch);
      } catch {
        done = false;
      }
    }
    if (done && el.value !== before) return;
    // 使えないときは値を組み立てて入れる
    const start = el.selectionStart ?? before.length;
    const end = el.selectionEnd ?? start;
    caretRef.current = start + ch.length;
    onChange(before.slice(0, start) + ch + before.slice(end));
  }

  function onKeyDown(e: React.KeyboardEvent<Field>) {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (!onSubmit) return; // 複数行で onSubmit が無ければ普通に改行
    e.preventDefault();
    onSubmit();
  }

  const cls = `min-h-11 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-base text-brand-ink placeholder:text-slate-400 focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green/25 ${
    readOnly || disabled ? "bg-slate-50" : "bg-white"
  } ${className}`;
  const common = {
    ...PT_INPUT_ATTRS,
    // 複数行で送信しない欄は、Android/iOS のキーボードの確定キーを「完了」ではなく改行にする
    enterKeyHint: multiline && !onSubmit ? ("enter" as const) : PT_INPUT_ATTRS.enterKeyHint,
    value,
    onChange: (e: React.ChangeEvent<Field>) => onChange(e.target.value),
    onKeyDown,
    autoFocus,
    placeholder,
    readOnly,
    disabled,
    "aria-label": ariaLabel,
    className: cls,
  };
  const showBar = accentBar && !readOnly && !disabled;

  return (
    <div className="space-y-1.5">
      {multiline ? (
        <textarea {...common} ref={setField} rows={rows} />
      ) : (
        <input {...common} ref={setField} type="text" inputMode="text" />
      )}
      {showBar && (
        <div className="grid grid-cols-6 gap-1" role="group" aria-label="アクセント記号つきの文字">
          {ACCENT_CHARS.map((ch) => (
            <button
              key={ch}
              type="button"
              tabIndex={-1}
              onPointerDown={(e) => e.preventDefault()}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(ch)}
              aria-label={`${ch} を入力`}
              className="min-h-11 rounded-lg bg-white text-base font-medium text-brand-ink ring-1 ring-slate-200 transition active:scale-95 active:bg-slate-100"
            >
              {ch}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default PtInput;
