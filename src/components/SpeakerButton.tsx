import { useState } from "react";
import { audio } from "../services/audio";
import { useSettings } from "../store/useSettings";

interface Props {
  text: string;
  rate?: number;
  className?: string;
  title?: string;
  /** アイコンサイズ(px) */
  size?: number;
  /** 押したときに呼ぶ（学習ログの記録など）。読み上げの前に同期で呼ぶ */
  onPlay?: () => void;
}

export default function SpeakerButton({ text, rate, className = "", title = "発音を再生", size = 20, onPlay }: Props) {
  const voiceURI = useSettings((s) => s.voiceURI);
  const defaultRate = useSettings((s) => s.rate);
  const [speaking, setSpeaking] = useState(false);

  async function play(e: React.MouseEvent) {
    e.stopPropagation();
    onPlay?.();
    setSpeaking(true);
    try {
      await audio.speak(text, { rate: rate ?? defaultRate, voiceURI });
    } finally {
      setSpeaking(false);
    }
  }

  return (
    <button
      type="button"
      onClick={play}
      title={title}
      aria-label={title}
      className={`inline-flex items-center justify-center rounded-full p-2 text-brand-green transition hover:bg-brand-green/10 active:scale-90 ${
        speaking ? "animate-pulse bg-brand-green/10" : ""
      } ${className}`}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 5 6 9H2v6h4l5 4V5z" />
        {speaking ? (
          <>
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
          </>
        ) : (
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
        )}
      </svg>
    </button>
  );
}
