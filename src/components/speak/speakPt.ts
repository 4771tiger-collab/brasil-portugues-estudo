import { audio } from "../../services/audio";
import { speechInput } from "../../services/speechInput";
import { useSettings } from "../../store/useSettings";

/** ゆっくり再生の倍率（設定の速さに掛ける） */
export const SLOW_FACTOR = 0.7;

/** 会話の役ごとの声の高さ（音声は1つなので、高さで聞き分けられるようにする） */
export const PITCH_YOU = 1.12;
export const PITCH_PARTNER = 0.88;

interface SpeakPtOptions {
  slow?: boolean;
  pitch?: number;
}

function speakOptions(opts: SpeakPtOptions) {
  const { rate, voiceURI } = useSettings.getState();
  return { rate: opts.slow ? rate * SLOW_FACTOR : rate, voiceURI, ...(opts.pitch ? { pitch: opts.pitch } : {}) };
}

/** アプリが読み上げるときは、🎤 の聞き取りを止める（お手本・相手のセリフの音声を、学習者の発話として拾わない） */
function stopListening(): void {
  if (speechInput.isListening()) speechInput.cancel();
}

/** 設定の速さ・音声でポルトガル語を読み上げる（slow = ゆっくり） */
export function speakPt(text: string, opts: SpeakPtOptions = {}): Promise<void> {
  stopListening();
  return audio.speak(text, speakOptions(opts));
}

/**
 * speakPt と同じだが、最後まで鳴ったら true、鳴らなかった・途中で止められたら false で解決する
 * （ロールプレイで、相手のセリフを聞かせないまま先へ進まないために使う）
 */
export async function speakPtChecked(text: string, opts: SpeakPtOptions = {}): Promise<boolean> {
  stopListening();
  if (!audio.speakOutcome) {
    await audio.speak(text, speakOptions(opts));
    return true;
  }
  return (await audio.speakOutcome(text, speakOptions(opts))) === "ended";
}

/** 音声認識をオンにするときの説明（設定画面と、練習の画面で最初に 🎤 を押したときに出す） */
export const SPEECH_CONSENT_LINES = [
  "🎤 を押して話した音声は、Chrome が Google の音声認識サービスに送って文字にします。",
  "このアプリは音声も認識結果（文字）も保存しません。",
  "ネットにつながっているときだけ使えます。",
] as const;
