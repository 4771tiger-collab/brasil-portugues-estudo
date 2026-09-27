import { useState } from "react";
import { Volume1, Volume2 } from "lucide-react";
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
      {/* 読み上げ中は音の波を2本に */}
      {speaking ? <Volume2 size={size} strokeWidth={2} aria-hidden /> : <Volume1 size={size} strokeWidth={2} aria-hidden />}
    </button>
  );
}
