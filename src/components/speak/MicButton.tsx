import { useState } from "react";
import { Mic, Square } from "lucide-react";
import { useSettings } from "../../store/useSettings";
import { useSpeechInput } from "../../hooks/useSpeechInput";
import { useOnline } from "../../hooks/useOnline";
import { audio } from "../../services/audio";
import { speechErrorMessage, speechInput, type SpeechResult } from "../../services/speechInput";
import { SPEECH_CONSENT_LINES } from "./speakPt";

/** このブラウザで音声認識（🎤）が使えるか */
export const micSupported = (): boolean => speechInput.isSupported();

interface Props {
  /** 聞き取れたら呼ぶ（認識の候補の一覧） */
  onResult: (r: SpeechResult) => void;
  /** 聞き取りを始める直前に呼ぶ（タップの処理の中で同期に呼ぶ） */
  onStart?: () => void;
  /** 聞き取りの上限（ms。既定は speechInput の8秒） */
  timeoutMs?: number;
  disabled?: boolean;
  size?: "lg" | "md";
  /** 待っている間、ボタンの下に出す一言 */
  hint?: string;
  className?: string;
}

/**
 * 話す練習の 🎤 ボタン。押すと聞き取りを始め、もう一度押すとそこまでで終える。
 * 音声認識（設定の speechInputEnabled）がまだオフなら、最初に説明を出して、同意したらオンにして聞き取りを始める。
 * 音声は Chrome が Google の音声認識サービスに送る。このアプリは音声も認識結果も保存しない。
 * ブラウザが非対応なら何も描かない（親が「答えを見る」などの別の手段を出す）。
 */
export default function MicButton({ onResult, onStart, timeoutMs, disabled = false, size = "lg", hint, className = "" }: Props) {
  const enabled = useSettings((s) => s.speechInputEnabled);
  const set = useSettings((s) => s.set);
  const online = useOnline();
  const sp = useSpeechInput(timeoutMs ? { timeoutMs } : {});
  const [consent, setConsent] = useState(false);
  if (!speechInput.isSupported()) return null;
  const listening = sp.status === "listening";

  function listen() {
    onStart?.();
    // お手本の読み上げを止めてから聞く（読み上げの声を拾わない）
    audio.cancel();
    // start は同期に認識エンジンを始める（タップの処理の中）
    void sp.start().then((r) => {
      if (r) onResult(r);
    });
  }

  function press() {
    if (listening) return sp.stop();
    if (disabled || !online) return;
    if (!enabled) return setConsent(true);
    listen();
  }

  const box = size === "lg" ? "h-[4.5rem] w-[4.5rem]" : "h-14 w-14";
  const icon = size === "lg" ? 32 : 24;
  return (
    <div className={`flex flex-col items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={press}
        disabled={(disabled || !online) && !listening}
        aria-pressed={listening}
        aria-label={listening ? "聞き取りを終える" : "マイクで言う"}
        title="話した音声は Chrome が Google の音声認識に送って文字にします（このアプリは保存しません）"
        className={`relative flex ${box} items-center justify-center rounded-full text-white shadow-lg transition active:scale-95 disabled:opacity-40 ${
          listening ? "bg-rose-500 shadow-rose-500/30" : "bg-gradient-to-br from-brand-blue to-indigo-600 shadow-blue-600/30"
        }`}
      >
        {listening && <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-rose-400/50" />}
        {listening ? <Square size={icon - 8} className="relative fill-current" aria-hidden /> : <Mic size={icon} aria-hidden />}
      </button>
      <p className="min-h-5 max-w-full break-words text-center text-sm text-slate-500" aria-live="polite">
        {listening ? sp.interim || "どうぞ…（押すと終える）" : !online ? "オフラインではマイクを使えません" : hint ?? ""}
      </p>
      {sp.status === "error" && sp.error && (
        <p role="alert" className="w-full rounded-lg bg-rose-50 p-3 text-left text-xs leading-relaxed text-rose-600">
          {speechErrorMessage(sp.error)}
        </p>
      )}
      {consent && (
        <div role="dialog" aria-label="マイクで採点する" className="w-full space-y-2 rounded-xl bg-blue-50 p-3 text-left ring-1 ring-blue-200">
          <p className="text-sm font-bold text-brand-ink">🎤 マイクで話して採点しますか？</p>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-slate-600">
            {SPEECH_CONSENT_LINES.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary min-h-11 flex-1 text-sm"
              onClick={() => {
                set({ speechInputEnabled: true });
                setConsent(false);
                listen();
              }}
            >
              オンにして話す
            </button>
            <button type="button" className="btn-ghost min-h-11 text-sm" onClick={() => setConsent(false)}>
              今はしない
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
