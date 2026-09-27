import type { LucideIcon } from "lucide-react";
import { FEATURES, TONES, type FeatureKey, type Tone } from "./features";

export type BadgeSize = "xs" | "sm" | "md" | "lg";

/** 地の大きさ（px）と、中のアイコンの大きさ（px）。md = 44px の地に 22px */
const SIZES: Record<BadgeSize, { box: string; icon: number }> = {
  xs: { box: "h-7 w-7 rounded-lg", icon: 16 },
  sm: { box: "h-9 w-9 rounded-xl", icon: 18 },
  md: { box: "h-11 w-11 rounded-2xl", icon: 22 },
  lg: { box: "h-14 w-14 rounded-2xl", icon: 28 },
};

interface Props {
  /** 機能の名前（アイコンと色を FEATURES から取る） */
  feature?: FeatureKey;
  /** feature の代わりに（または上書きで）使うアイコン */
  icon?: LucideIcon;
  /** feature の色を上書きする */
  tone?: Tone;
  size?: BadgeSize;
  /** soft = 淡い地＋濃い線（既定）/ solid = 濃い地＋白い線（選択中など） */
  variant?: "soft" | "solid";
  className?: string;
  /** 読み上げる名前。無ければ飾り（aria-hidden。横に文字の名前がある前提） */
  label?: string;
}

/**
 * 角の丸い色付きの地に、lucide のアイコンを1つ置いたもの（ホームのタイル・練習の一覧・お知らせの先頭など）。
 */
export default function IconBadge({ feature, icon, tone, size = "md", variant = "soft", className = "", label }: Props) {
  const f = feature ? FEATURES[feature] : null;
  const Icon = icon ?? f?.icon;
  if (!Icon) return null;
  const t = TONES[tone ?? f?.tone ?? "slate"];
  const s = SIZES[size];
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ring-1 ring-inset ${s.box} ${variant === "solid" ? `${t.solid} shadow-sm` : t.soft} ${className}`}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <Icon size={s.icon} strokeWidth={2} />
    </span>
  );
}
