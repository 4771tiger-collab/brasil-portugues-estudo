import { ArrowLeftRight, Circle, LoaderCircle, Pause, Play, RotateCcw, Square, type LucideIcon } from "lucide-react";

/**
 * 再生・停止・録音などの操作のアイコン（どの画面でも同じ形にそろえる）。
 * 再生・一時停止・停止・録音は塗りつぶし（fill-current）、録音は赤。文字（「再生」「停止」など）と並べて使う
 */
export type MediaKind = "play" | "pause" | "stop" | "record" | "compare" | "restart" | "loading";

const ICONS: Record<MediaKind, { icon: LucideIcon; className: string }> = {
  play: { icon: Play, className: "fill-current" },
  pause: { icon: Pause, className: "fill-current" },
  stop: { icon: Square, className: "fill-current" },
  record: { icon: Circle, className: "fill-current text-rose-500" },
  compare: { icon: ArrowLeftRight, className: "" },
  restart: { icon: RotateCcw, className: "" },
  loading: { icon: LoaderCircle, className: "animate-spin" },
};

export default function MediaIcon({ kind, size = 14, className = "" }: { kind: MediaKind; size?: number; className?: string }) {
  const { icon: Icon, className: base } = ICONS[kind];
  return <Icon size={size} strokeWidth={2} className={`shrink-0 ${base} ${className}`} aria-hidden />;
}
