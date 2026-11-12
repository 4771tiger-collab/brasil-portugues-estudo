import { audio } from "../../services/audio";
import { useSettings } from "../../store/useSettings";

/** ゆっくり再生の倍率（設定の速さに掛ける） */
export const SLOW_FACTOR = 0.7;

/** 会話の役ごとの声の高さ（音声は1つなので、高さで聞き分けられるようにする） */
export const PITCH_YOU = 1.12;
export const PITCH_PARTNER = 0.88;

/** 設定の速さ・音声でポルトガル語を読み上げる（slow = ゆっくり） */
export function speakPt(text: string, opts: { slow?: boolean; pitch?: number } = {}): Promise<void> {
  const { rate, voiceURI } = useSettings.getState();
  return audio.speak(text, { rate: opts.slow ? rate * SLOW_FACTOR : rate, voiceURI, ...(opts.pitch ? { pitch: opts.pitch } : {}) });
}

/** 音声認識をオンにするときの説明（設定画面と、練習の画面で最初に 🎤 を押したときに出す） */
export const SPEECH_CONSENT_LINES = [
  "🎤 を押して話した音声は、Chrome が Google の音声認識サービスに送って文字にします。",
  "このアプリは音声も認識結果（文字）も保存しません。",
  "ネットにつながっているときだけ使えます。",
] as const;
