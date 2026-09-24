import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Settings } from "../data/types";

interface SettingsState extends Settings {
  set: (patch: Partial<Settings>) => void;
  reset: () => void;
}

const DEFAULTS: Settings = {
  rate: 1,
  dailyNewLimit: 15,
  dailyGoal: 30,
  voiceURI: null,
  showKana: true,
  showIpa: false,
  musicNewLimit: 10,
  pauseOnWordTap: true,
  studyView: "session",
  studyDirection: "pt2ja",
  autoPlayOnReveal: true,
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (patch) => set(patch),
      reset: () => set(DEFAULTS),
    }),
    {
      // キー名は絶対に変えない（既存の設定が読めなくなる）
      name: "bp-settings-v1",
      // zustand の persist は保存済みの version と違い migrate も無いと、初期状態で起動して
      // 既定値で上書き保存してしまう。将来版のデータを旧版で開いても消えないよう、何もしない
      // migrate で必ず通す。新しいキーは既定値との浅いマージで補われるので移行処理は要らない。
      version: 0,
      migrate: (persisted) => persisted as SettingsState,
    }
  )
);
