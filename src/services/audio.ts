// ============================================================================
// 音声サービス（抽象化）
// 既定: Web Speech API (speechSynthesis) による pt-BR 読み上げ。
// 将来 CloudTTSProvider / FileAudioProvider に差し替え可能なよう interface 化。
// ============================================================================

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  lang?: string;
  voiceURI?: string | null;
}

export interface SequenceOptions extends SpeakOptions {
  gapMs?: number;
  onIndex?: (i: number) => void;
  signal?: AbortSignal;
}

export interface AudioProvider {
  isSupported(): boolean;
  ready(): Promise<void>;
  getVoices(): SpeechSynthesisVoice[];
  speak(text: string, opts?: SpeakOptions): Promise<void>;
  speakSequence(texts: string[], opts?: SequenceOptions): Promise<void>;
  cancel(): void;
}

const LANG = "pt-BR";

/** 読み上げ用にテキストを整形（"/" を「、」化して "barra" 誤読を防ぐ等） */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\s*\/\s*/g, ", ") // Obrigado/Obrigada -> Obrigado, Obrigada
    .replace(/\s*[（(][^）)]*[）)]\s*/g, " ") // 括弧注記を除去
    .replace(/\s+/g, " ")
    .trim();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const id = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(id);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

class WebSpeechProvider implements AudioProvider {
  private voices: SpeechSynthesisVoice[] = [];
  private readyPromise: Promise<void> | null = null;

  isSupported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  ready(): Promise<void> {
    if (!this.isSupported()) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve) => {
      const load = () => {
        this.voices = window.speechSynthesis.getVoices();
        if (this.voices.length > 0) resolve();
      };
      load();
      if (this.voices.length === 0) {
        window.speechSynthesis.onvoiceschanged = () => {
          this.voices = window.speechSynthesis.getVoices();
          resolve();
        };
        // フォールバック
        setTimeout(() => {
          this.voices = window.speechSynthesis.getVoices();
          resolve();
        }, 1000);
      }
    });
    return this.readyPromise;
  }

  getVoices(): SpeechSynthesisVoice[] {
    const all = this.voices.length ? this.voices : window.speechSynthesis?.getVoices() ?? [];
    return all.filter((v) => /pt[-_]?BR/i.test(v.lang) || /pt[-_]?PT/i.test(v.lang) || /^pt/i.test(v.lang));
  }

  private pickVoice(voiceURI?: string | null): SpeechSynthesisVoice | undefined {
    const ptVoices = this.getVoices();
    if (voiceURI) {
      const found = ptVoices.find((v) => v.voiceURI === voiceURI) ?? this.voices.find((v) => v.voiceURI === voiceURI);
      if (found) return found;
    }
    // pt-BR を最優先、ついで Google/Microsoft の自然な音声を優先
    const brFirst = ptVoices.filter((v) => /pt[-_]?BR/i.test(v.lang));
    const pool = brFirst.length ? brFirst : ptVoices;
    const preferred =
      pool.find((v) => /google/i.test(v.name)) ??
      pool.find((v) => /(maria|luciana|francisca|microsoft)/i.test(v.name)) ??
      pool[0];
    return preferred;
  }

  speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    if (!this.isSupported()) return Promise.resolve();
    const clean = cleanForSpeech(text);
    if (!clean) return Promise.resolve();
    window.speechSynthesis.cancel();
    return new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(clean);
      u.lang = opts.lang ?? LANG;
      u.rate = opts.rate ?? 1;
      u.pitch = opts.pitch ?? 1;
      const v = this.pickVoice(opts.voiceURI);
      if (v) u.voice = v;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    });
  }

  async speakSequence(texts: string[], opts: SequenceOptions = {}): Promise<void> {
    if (!this.isSupported()) return;
    const gap = opts.gapMs ?? 350;
    for (let i = 0; i < texts.length; i++) {
      if (opts.signal?.aborted) return;
      opts.onIndex?.(i);
      await this.speak(texts[i], opts);
      if (i < texts.length - 1) {
        try {
          await delay(gap, opts.signal);
        } catch {
          return; // aborted
        }
      }
    }
  }

  cancel(): void {
    if (this.isSupported()) window.speechSynthesis.cancel();
  }
}

export const audio: AudioProvider = new WebSpeechProvider();
