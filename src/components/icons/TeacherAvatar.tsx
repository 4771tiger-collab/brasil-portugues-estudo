import { GraduationCap } from "lucide-react";

/** 丸の大きさ（px）と、中のアイコンの大きさ（px） */
const SIZES = {
  xs: { box: "h-6 w-6", icon: 14 },
  sm: { box: "h-7 w-7", icon: 16 },
  md: { box: "h-8 w-8", icon: 18 },
} as const;

/**
 * AI 先生の顔（紫のグラデーションの丸に角帽）。先生のシートの見出し・先生の発言の横に置く。
 * 飾り（aria-hidden）。先生だと分かる文字（見出し・発言の中身）が横にある前提
 */
export default function TeacherAvatar({ size = "sm", className = "" }: { size?: keyof typeof SIZES; className?: string }) {
  const s = SIZES[size];
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm shadow-violet-500/30 ${s.box} ${className}`}
    >
      <GraduationCap size={s.icon} strokeWidth={2} />
    </span>
  );
}
