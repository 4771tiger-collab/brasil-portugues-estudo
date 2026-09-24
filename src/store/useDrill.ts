// ============================================================================
// 活用ドリルの成績と出題の設定（端末内に保存）
// - stats: 形ごと（"inf|tense|person"）の出題回数・正解回数・最後に答えた日。バックアップの任意フィールド drill に入る
// - prefs: 出題する動詞のグループ・時制・人称・問題数（端末ごとの好み。バックアップには入れない）
// SRS のカード（useProgress.cards）には書かない。
// ============================================================================

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { todayStr } from "../srs/scheduler";
import { recordStat, type DrillStats } from "../services/conjugationDrill";
import { TABLE_PERSONS, TABLE_TENSES, isTablePerson, isTableTense, type TablePerson, type TableTense } from "../services/verbTable";
import { mergeDrill } from "./merge";

export type { DrillStat, DrillStats } from "../services/conjugationDrill";

/** バックアップに入れる部分（backupFormat.readDrill で読む） */
export interface DrillExport {
  stats: DrillStats;
}

/** 出題する動詞のグループ: 不規則動詞（基本）/ 不規則動詞（派生: manter ← ter など）/ 学習した規則動詞 */
export type VerbGroup = "basic" | "derived" | "studied";
export const VERB_GROUPS: readonly VerbGroup[] = ["basic", "derived", "studied"];

/** 1回の問題数の選択肢 */
export const DRILL_SIZES = [10, 20] as const;

export interface DrillPrefs {
  groups: VerbGroup[];
  tenses: TableTense[];
  persons: TablePerson[];
  size: number;
}

export const DEFAULT_DRILL_PREFS: DrillPrefs = {
  groups: ["basic", "studied"],
  tenses: ["pres", "pret"],
  persons: [...TABLE_PERSONS],
  size: 10,
};

/**
 * 保存された設定を確かめる（知らない値を落とし、空になった項目は既定値に戻す。並びは表の順にそろえる）。
 * 画面ではこれを通した値を使う。
 */
export function cleanPrefs(p: Partial<DrillPrefs> | undefined): DrillPrefs {
  const pick = <T>(all: readonly T[], v: unknown, ok: (x: unknown) => boolean, d: T[]): T[] => {
    const list = Array.isArray(v) ? all.filter((x) => v.includes(x) && ok(x)) : [];
    return list.length ? list : d;
  };
  return {
    groups: pick(VERB_GROUPS, p?.groups, () => true, DEFAULT_DRILL_PREFS.groups),
    tenses: pick(TABLE_TENSES, p?.tenses, (x) => typeof x === "string" && isTableTense(x), DEFAULT_DRILL_PREFS.tenses),
    persons: pick(TABLE_PERSONS, p?.persons, (x) => typeof x === "number" && isTablePerson(x), DEFAULT_DRILL_PREFS.persons),
    size: (DRILL_SIZES as readonly number[]).includes(p?.size as number) ? (p!.size as number) : DEFAULT_DRILL_PREFS.size,
  };
}

interface DrillState extends DrillExport {
  prefs: DrillPrefs;
  /** 1問分を記録する（最初の出題だけ呼ぶ。correct は完全一致のときだけ true） */
  record: (key: string, correct: boolean, today?: string) => void;
  setPrefs: (patch: Partial<DrillPrefs>) => void;
  exportData: () => DrillExport;
  /** バックアップの置き換え */
  importData: (d: DrillExport) => void;
  /** バックアップの統合（形ごとに last が新しい方。merge.mergeDrill） */
  mergeData: (d: DrillExport) => void;
  /** 成績を消す（進捗のリセット。出題の設定は残す） */
  reset: () => void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const useDrill = create<DrillState>()(
  persist(
    (set, get) => ({
      stats: {},
      prefs: DEFAULT_DRILL_PREFS,

      record: (key, correct, today = todayStr()) =>
        set((s) => ({ stats: { ...s.stats, [key]: recordStat(s.stats[key], correct, today) } })),
      setPrefs: (patch) => set((s) => ({ prefs: cleanPrefs({ ...s.prefs, ...patch }) })),
      exportData: () => ({ stats: get().stats }),
      importData: (d) => set({ stats: { ...d.stats } }),
      mergeData: (d) => set((s) => ({ stats: mergeDrill({ stats: s.stats }, d).stats })),
      reset: () => set({ stats: {} }),
    }),
    {
      // キー名は変えない
      name: "bp-drill-v1",
      // 保存済みの version と違い migrate も無いと、zustand は初期状態で起動して上書き保存してしまう。
      // 将来版のデータを旧版で開いても消えないよう、何もしない migrate で必ず通す。
      version: 0,
      migrate: (persisted) => persisted as DrillState,
      // 壊れた stats は空に、prefs は既定値と合わせる（知らない項目はそのまま残す）
      merge: (persisted, current) => {
        const p = (isObj(persisted) ? persisted : {}) as Partial<DrillState>;
        return {
          ...current,
          ...p,
          stats: isObj(p.stats) ? (p.stats as DrillStats) : {},
          prefs: { ...DEFAULT_DRILL_PREFS, ...(isObj(p.prefs) ? p.prefs : {}) },
        };
      },
    }
  )
);
