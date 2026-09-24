// ============================================================================
// 音声サービス（抽象化）
// 既定: Web Speech API (speechSynthesis) による pt-BR 読み上げ。
// 将来 CloudTTSProvider / FileAudioProvider に差し替え可能なよう interface 化。
// ============================================================================

export interface SpeakOptions {
  rate?: number;
  pitch?: number;
  lang?: string;
  /** 使う音声の指定（pt 系の lang のときだけ使う） */
  voiceURI?: string | null;
}

export interface SequenceOptions extends SpeakOptions {
  gapMs?: number;
  onIndex?: (i: number) => void;
  signal?: AbortSignal;
}

/** 音声の情報（SpeechSynthesisVoice に依存しない形で設定画面などへ渡す） */
export interface VoiceInfo {
  name: string;
  lang: string;
  voiceURI: string;
  /** false はネットワーク音声（オフラインでは鳴らない） */
  localService: boolean;
}

export interface AudioProvider {
  isSupported(): boolean;
  ready(): Promise<void>;
  getVoices(): SpeechSynthesisVoice[];
  speak(text: string, opts?: SpeakOptions): Promise<void>;
  speakSequence(texts: string[], opts?: SequenceOptions): Promise<void>;
  cancel(): void;
  // ---- 以下は任意（実装しない Provider もある）----
  /** その lang（既定 pt-BR）で speak したときに使われる音声。voiceURI は pt のときだけ効く */
  currentVoice?(lang?: string, voiceURI?: string | null): VoiceInfo | null;
  /** lang の音声があるか。地域つき（ja-JP）なら地域まで一致、言語だけ（ja）なら地域は問わない */
  hasVoice?(lang: string): boolean;
  /** 音声一覧が変わったら cb を呼ぶ。戻り値で購読をやめる */
  onVoicesChanged?(cb: () => void): () => void;
}

const LANG = "pt-BR";

/**
 * cancel の直後に speak するまでの待ち時間（ms）。
 * Android の Chrome は cancel の直後の speak を取りこぼすことがあるため、1ティック遅らせる。
 * 実機で音が欠けるようなら、ここを 100〜250 に上げる。
 */
const RESTART_DELAY_MS = 0;

/** 読み上げ用にテキストを整形（"/" を「、」化して "barra" 誤読を防ぐ等） */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/\s*\/\s*/g, ", ") // Obrigado/Obrigada -> Obrigado, Obrigada
    .replace(/\s*[（(][^）)]*[）)]\s*/g, " ") // 括弧注記を除去
    .replace(/\s+/g, " ")
    .trim();
}

/** ms 待つ。signal で中断すると AbortError で reject する */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
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

/** "pt_BR" / "PT-br" などを "pt-br" にそろえる */
function normLang(l: string): string {
  return l.replace(/_/g, "-").toLowerCase();
}

/** 地域つき（ja-JP）なら地域まで一致、言語だけ（ja）なら地域は問わない */
function langMatches(voiceLang: string, lang: string): boolean {
  const v = normLang(voiceLang);
  const l = normLang(lang);
  return v === l || v.startsWith(l + "-");
}

const baseLang = (l: string) => normLang(l).split("-")[0];
const isPtLang = (l: string) => baseLang(l) === "pt";

/**
 * onend が来ないとき（Android の Chrome で起きる）に resolve するまでの時間。
 * 文字数と速度からの見積もりに余裕を足す。短すぎると長文の途中で次へ進んでしまう。
 */
function watchdogMs(text: string, rate: number): number {
  return Math.max(2500, (text.length * 110) / rate) + 3000;
}

function toInfo(v: SpeechSynthesisVoice): VoiceInfo {
  return { name: v.name, lang: v.lang, voiceURI: v.voiceURI, localService: v.localService };
}

class WebSpeechProvider implements AudioProvider {
  private voices: SpeechSynthesisVoice[] = [];
  private readyPromise: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private listening = false;

  /** 再生中の発話（GC で回収されると onend が来なくなるため保持する） */
  private utter: SpeechSynthesisUtterance | null = null;
  /** 今の speak の Promise を解決する（cancel・次の speak で呼ぶ） */
  private settle: (() => void) | null = null;
  /** speak / cancel のたびに増やす。遅延中の speak が古くなったかの判定に使う */
  private seq = 0;
  /** cancel した直後か（RESTART_DELAY_MS の間だけ 0 より大きい） */
  private cancelTicks = 0;

  isSupported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  /** 音声一覧を読み直す（Android は後から増えることがある） */
  private allVoices(): SpeechSynthesisVoice[] {
    if (!this.isSupported()) return [];
    const live = window.speechSynthesis.getVoices();
    if (live.length) this.voices = live;
    return this.voices;
  }

  /** voiceschanged を1回だけ購読する（onvoiceschanged の上書きはしない） */
  private listen(): void {
    if (this.listening || !this.isSupported()) return;
    this.listening = true;
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      this.allVoices();
      this.listeners.forEach((cb) => cb());
    });
  }

  ready(): Promise<void> {
    if (!this.isSupported()) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;
    this.listen();
    this.readyPromise = new Promise<void>((resolve) => {
      if (this.allVoices().length > 0) return resolve();
      const onChange = () => {
        if (this.voices.length === 0) return;
        this.listeners.delete(onChange);
        resolve();
      };
      this.listeners.add(onChange);
      // フォールバック（voiceschanged が来ない端末）。増えていれば購読者にも知らせる
      setTimeout(() => {
        this.listeners.delete(onChange);
        const before = this.voices.length;
        if (this.allVoices().length !== before) this.listeners.forEach((cb) => cb());
        resolve();
      }, 1000);
    });
    return this.readyPromise;
  }

  onVoicesChanged(cb: () => void): () => void {
    this.listen();
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getVoices(): SpeechSynthesisVoice[] {
    return this.allVoices().filter((v) => isPtLang(v.lang));
  }

  hasVoice(lang: string): boolean {
    return this.allVoices().some((v) => langMatches(v.lang, lang));
  }

  currentVoice(lang: string = LANG, voiceURI?: string | null): VoiceInfo | null {
    const v = this.pickVoice(voiceURI, lang);
    return v ? toInfo(v) : null;
  }

  /**
   * lang に合う音声を選ぶ。
   * - pt 系: 指定の voiceURI → pt-BR → pt の順。Google / Microsoft の自然な音声を優先
   * - それ以外: lang の前方一致（地域まで一致を優先）。voiceURI は使わない
   * 見つからなければ undefined（u.lang だけ指定してブラウザに任せる）
   */
  private pickVoice(voiceURI: string | null | undefined, lang: string = LANG): SpeechSynthesisVoice | undefined {
    if (!isPtLang(lang)) {
      const all = this.allVoices();
      const exact = all.filter((v) => langMatches(v.lang, lang));
      const pool = exact.length ? exact : all.filter((v) => baseLang(v.lang) === baseLang(lang));
      return pool.find((v) => v.localService) ?? pool[0];
    }
    const ptVoices = this.getVoices();
    if (voiceURI) {
      const found = ptVoices.find((v) => v.voiceURI === voiceURI) ?? this.voices.find((v) => v.voiceURI === voiceURI);
      if (found) return found;
    }
    // pt-BR を最優先、ついで Google/Microsoft の自然な音声を優先
    const brFirst = ptVoices.filter((v) => langMatches(v.lang, "pt-BR"));
    const pool = brFirst.length ? brFirst : ptVoices;
    const preferred =
      pool.find((v) => /google/i.test(v.name)) ??
      pool.find((v) => /(maria|luciana|francisca|microsoft)/i.test(v.name)) ??
      pool[0];
    return preferred;
  }

  /** cancel の直後の印を RESTART_DELAY_MS の間だけ立てる */
  private markCancelled(): void {
    this.cancelTicks++;
    setTimeout(() => {
      this.cancelTicks--;
    }, RESTART_DELAY_MS);
  }

  /** 今の発話と、遅延中の speak を打ち切る（その Promise は resolve する） */
  private stop(): void {
    this.seq++;
    const s = this.settle;
    this.settle = null;
    s?.();
    window.speechSynthesis.cancel();
    this.markCancelled();
  }

  speak(text: string, opts: SpeakOptions = {}): Promise<void> {
    if (!this.isSupported()) return Promise.resolve();
    const clean = cleanForSpeech(text);
    if (!clean) return Promise.resolve();
    const synth = window.speechSynthesis;
    // 再生中・待ち・遅延中の speak がある、または cancel の直後なら、打ち切って1ティック待つ。
    // 何も鳴っていなければ、その場で話す（クリック処理の中で呼ばれたときの自動再生制限を避ける）
    const wait = synth.speaking || synth.pending || this.settle !== null || this.cancelTicks > 0;
    if (wait) this.stop();
    else this.seq++;
    const my = this.seq;
    const lang = opts.lang ?? LANG;
    const rate = opts.rate && opts.rate > 0 ? opts.rate : 1;

    return new Promise<void>((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let u: SpeechSynthesisUtterance | null = null;
      const finish = () => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        if (this.settle === finish) this.settle = null;
        if (u && this.utter === u) this.utter = null;
        resolve();
      };
      this.settle = finish;

      const start = () => {
        // 待っている間に cancel・次の speak が来ていたら話さない
        if (done || my !== this.seq) return finish();
        const utt = new SpeechSynthesisUtterance(clean);
        utt.lang = lang;
        utt.rate = rate;
        utt.pitch = opts.pitch ?? 1;
        const v = this.pickVoice(opts.voiceURI, lang);
        if (v) utt.voice = v;
        utt.onend = finish;
        utt.onerror = finish;
        u = utt;
        this.utter = utt;
        // onend が来ない端末のためのウォッチドッグ
        timer = setTimeout(finish, watchdogMs(clean, rate));
        if (synth.paused) synth.resume();
        synth.speak(utt);
      };

      if (wait) setTimeout(start, RESTART_DELAY_MS);
      else start();
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
    if (this.isSupported()) this.stop();
  }
}

export const audio: AudioProvider = new WebSpeechProvider();
