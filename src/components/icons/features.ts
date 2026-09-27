// ============================================================================
// アプリの機能ごとのアイコンと色（1か所で決める）。
// - アイコンは lucide-react（ISC・1つずつ import するので使った分だけ入る）。線の太さは 2 にそろえる。
// - 色（Tone）はブランドの緑・黄・青に、見分けやすい色を足したもの。淡い地（soft）には濃い色の線を置いて、
//   白地・淡い地のどちらでもアイコンのコントラストが 3:1 以上になるようにしている。
// - Tailwind は文字列をそのまま拾うので、クラス名は組み立てずに書き切る。
// ============================================================================

import {
  BookA,
  BookOpenText,
  Bot,
  CalendarCheck,
  DatabaseBackup,
  Drum,
  Dumbbell,
  FilePlus2,
  Flame,
  GraduationCap,
  Headphones,
  House,
  Languages,
  Layers,
  ListMusic,
  MessagesSquare,
  Mic,
  Music,
  PenLine,
  Repeat2,
  Settings,
  Smartphone,
  Sparkles,
  Speech,
  SpellCheck,
  Target,
  Volume2,
  type LucideIcon,
} from "lucide-react";

export type Tone = "green" | "blue" | "yellow" | "violet" | "rose" | "orange" | "teal" | "sky" | "indigo" | "slate";

export interface ToneClasses {
  /** 淡いグラデーションの地＋濃い色の線（一覧・タイル向け） */
  soft: string;
  /** 濃いグラデーションの地＋白（または濃紺）の線（選択中・目立たせたいとき） */
  solid: string;
  /** 地なしで線だけ置くときの色（見出し・ボタンの中の小さなアイコン） */
  text: string;
}

export const TONES: Record<Tone, ToneClasses> = {
  green: {
    soft: "bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-700 ring-emerald-200/70",
    solid: "bg-gradient-to-br from-brand-green to-emerald-700 text-white ring-emerald-700/20",
    text: "text-emerald-600",
  },
  blue: {
    soft: "bg-gradient-to-br from-blue-50 to-blue-100 text-blue-700 ring-blue-200/70",
    solid: "bg-gradient-to-br from-brand-blue to-blue-700 text-white ring-blue-700/20",
    text: "text-blue-600",
  },
  yellow: {
    soft: "bg-gradient-to-br from-amber-50 to-brand-yellow/40 text-amber-800 ring-amber-200/80",
    solid: "bg-gradient-to-br from-brand-yellow to-amber-400 text-brand-ink ring-amber-500/20",
    text: "text-amber-600",
  },
  violet: {
    soft: "bg-gradient-to-br from-violet-50 to-violet-100 text-violet-700 ring-violet-200/70",
    solid: "bg-gradient-to-br from-violet-500 to-indigo-600 text-white ring-indigo-700/20",
    text: "text-violet-600",
  },
  rose: {
    soft: "bg-gradient-to-br from-rose-50 to-rose-100 text-rose-600 ring-rose-200/70",
    solid: "bg-gradient-to-br from-rose-500 to-pink-600 text-white ring-pink-700/20",
    text: "text-rose-500",
  },
  orange: {
    soft: "bg-gradient-to-br from-orange-50 to-orange-100 text-orange-700 ring-orange-200/70",
    solid: "bg-gradient-to-br from-orange-400 to-orange-600 text-white ring-orange-700/20",
    text: "text-orange-600",
  },
  teal: {
    soft: "bg-gradient-to-br from-teal-50 to-teal-100 text-teal-700 ring-teal-200/70",
    solid: "bg-gradient-to-br from-teal-500 to-teal-700 text-white ring-teal-700/20",
    text: "text-teal-600",
  },
  sky: {
    soft: "bg-gradient-to-br from-sky-50 to-sky-100 text-sky-700 ring-sky-200/70",
    solid: "bg-gradient-to-br from-sky-500 to-sky-700 text-white ring-sky-700/20",
    text: "text-sky-600",
  },
  indigo: {
    soft: "bg-gradient-to-br from-indigo-50 to-indigo-100 text-indigo-700 ring-indigo-200/70",
    solid: "bg-gradient-to-br from-indigo-500 to-indigo-700 text-white ring-indigo-700/20",
    text: "text-indigo-600",
  },
  slate: {
    soft: "bg-gradient-to-br from-slate-50 to-slate-100 text-slate-600 ring-slate-200/80",
    solid: "bg-gradient-to-br from-slate-600 to-slate-800 text-white ring-slate-800/20",
    text: "text-slate-500",
  },
};

export interface Feature {
  icon: LucideIcon;
  tone: Tone;
  /** 画面での呼び名（読み上げ・見出しの既定） */
  label: string;
}

/** 機能 → アイコンと色。下部ナビ・ホームのタイル・練習の一覧・見出しで同じものを使う */
export const FEATURES = {
  // 下部ナビの6つ
  home: { icon: House, tone: "green", label: "ホーム" },
  flashcards: { icon: Layers, tone: "green", label: "単語帳" },
  quiz: { icon: Target, tone: "yellow", label: "クイズ" },
  practice: { icon: Dumbbell, tone: "blue", label: "練習" },
  music: { icon: Music, tone: "rose", label: "音楽" },
  settings: { icon: Settings, tone: "slate", label: "設定" },

  // 練習の中身
  pattern: { icon: Repeat2, tone: "teal", label: "パターンプラクティス" },
  conjugation: { icon: SpellCheck, tone: "indigo", label: "活用ドリル" },
  chunk: { icon: BookOpenText, tone: "sky", label: "チャンクリーディング" },
  shadowing: { icon: Speech, tone: "orange", label: "シャドーイング" },
  dictation: { icon: PenLine, tone: "blue", label: "ディクテーション" },
  addMaterial: { icon: FilePlus2, tone: "slate", label: "教材を追加" },
  dialogue: { icon: MessagesSquare, tone: "violet", label: "会話" },

  // 学習のしかた・単語の種類
  teacher: { icon: GraduationCap, tone: "violet", label: "AI先生" },
  production: { icon: Languages, tone: "blue", label: "産出（和→葡）" },
  handsfree: { icon: Headphones, tone: "teal", label: "耳だけ復習" },
  songWords: { icon: ListMusic, tone: "rose", label: "曲の単語" },
  general: { icon: BookA, tone: "green", label: "一般語彙" },
  capoeira: { icon: Drum, tone: "yellow", label: "カポエイラ" },
  streak: { icon: Flame, tone: "orange", label: "連続記録" },

  // 設定・お知らせ
  study: { icon: CalendarCheck, tone: "green", label: "学習" },
  voice: { icon: Volume2, tone: "green", label: "音声" },
  speechInput: { icon: Mic, tone: "rose", label: "音声認識" },
  ai: { icon: Bot, tone: "violet", label: "AI" },
  backup: { icon: DatabaseBackup, tone: "yellow", label: "バックアップ" },
  install: { icon: Smartphone, tone: "green", label: "インストール" },
  update: { icon: Sparkles, tone: "blue", label: "更新" },
} satisfies Record<string, Feature>;

export type FeatureKey = keyof typeof FEATURES;
