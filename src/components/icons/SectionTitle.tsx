import type { LucideIcon } from "lucide-react";
import { FEATURES, TONES, type FeatureKey } from "./features";

interface Props {
  feature?: FeatureKey;
  /** feature の代わりに使うアイコン */
  icon?: LucideIcon;
  children: React.ReactNode;
  /** 見出しの段（既定 h2） */
  as?: "h2" | "h3";
  /** 既定: 灰色の小見出し（一覧・設定の区切り） */
  className?: string;
  id?: string;
}

/** 小見出し（先頭に機能の色のアイコン）。設定の区切り・単語帳のデッキの区切りなど */
export default function SectionTitle({ feature, icon, children, as: Tag = "h2", className = "px-1 text-sm font-bold text-slate-500", id }: Props) {
  const f = feature ? FEATURES[feature] : null;
  const Icon = icon ?? f?.icon;
  return (
    <Tag id={id} className={`flex items-center gap-1.5 ${className}`}>
      {Icon && <Icon size={16} strokeWidth={2} className={`shrink-0 ${TONES[f?.tone ?? "slate"].text}`} aria-hidden />}
      <span className="min-w-0">{children}</span>
    </Tag>
  );
}
