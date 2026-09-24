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
};

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (patch) => set(patch),
      reset: () => set(DEFAULTS),
    }),
    { name: "bp-settings-v1" }
  )
);
