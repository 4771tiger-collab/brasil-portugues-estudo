// ============================================================================
// 音声認識（抽象化）— 「🎤 言ってみる」（T2-8）
// 既定: Web Speech API の SpeechRecognition（Chrome は webkitSpeechRecognition）。pt-BR で1回だけ聞き取る。
// Chrome では、話した音声が Google の音声認識サービスに送られて文字になる（オンラインのときだけ使える）。
// このアプリは音声も認識結果も保存しない（採点に使ったら捨てる）。
// 設定の speechInputEnabled（既定オフ。設定画面で説明を読んでからオンにする）が true のときだけ呼ぶ。
// AudioProvider と同じく interface の後ろに置き、将来ほかの認識エンジンに差し替えられるようにする。
//
// - listen(): 聞き取りを始め、確定した結果（認識の候補の一覧）で解決する。タップの処理の中で呼ぶ
//   （start はその場で同期に呼ぶ）。同時に聞き取るのは1つだけ（新しい listen は前の聞き取りを取りやめる）。
//   聞く前にオフラインなら offline、読み上げ中なら止めてから聞く（読み上げの声を拾わないため）。
//   結果・失敗・取りやめ・時間切れのどの終わり方でも、認識エンジンは abort してマイクを閉じる。
// - stop(): 早めに終える（そこまでに聞き取れた分で解決する）。cancel(): 取りやめる（aborted で失敗）
// - SpeechInputError / speechErrorMessage(): 失敗の種類と、利用者向けの案内（日本語）
// ============================================================================

import { audio } from "./audio";

/** 失敗の種類 */
export type SpeechErrorKind =
  | "not-allowed"
  | "no-speech"
  | "network"
  | "offline"
  | "audio-capture"
  | "aborted"
  | "unsupported"
  | "language"
  | "unknown";

export class SpeechInputError extends Error {
  readonly kind: SpeechErrorKind;
  /** 元のエラー（認識エンジンのエラーコード・例外など）。調査用 */
  readonly original: unknown;
  constructor(kind: SpeechErrorKind, original?: unknown) {
    super(`音声認識エラー: ${kind}`);
    this.name = "SpeechInputError";
    this.kind = kind;
    this.original = original;
  }
}

export interface ListenOptions {
  /** 認識する言語（既定 pt-BR） */
  lang?: string;
  /** 認識の候補の数の上限（既定 5。Android の Chrome は1件しか返さないことが多い） */
  maxAlternatives?: number;
  /** 中断（abort で aborted の失敗） */
  signal?: AbortSignal;
  /** 聞き取り中の途中経過（確定前の文字）。画面に出すだけで、採点には使わない */
  onInterim?: (text: string) => void;
  /**
   * 時間の上限（ms。既定 8000。マイクの音を取り始めてから数える）。過ぎたら、それまでの途中経過で終える
   * （無ければ no-speech）。音を取り始めるまで（マイクの許可を求める表示の間）は START_GRACE_MS を足して待つ
   */
  timeoutMs?: number;
}

export interface SpeechResult {
  /** 認識の候補（確からしい順。空・重複は除く。1件以上） */
  transcripts: string[];
  /** 先頭の候補の確からしさ（0〜1。認識エンジンが返したときだけ） */
  confidence?: number;
}

export interface SpeechInputProvider {
  isSupported(): boolean;
  listen(opts?: ListenOptions): Promise<SpeechResult>;
  /** 聞き取りを早めに終える（そこまでに聞き取れた分で listen を解決する）。聞いていなければ何もしない */
  stop(): void;
  /** 聞き取りを取りやめる（listen は aborted で失敗する）。聞いていなければ何もしない */
  cancel(): void;
  /** 今聞き取っているか */
  isListening(): boolean;
}

// ---------------------------------------------------------------------------
// 失敗の種類と案内
// ---------------------------------------------------------------------------

/** SpeechRecognition の error イベントのコード → 失敗の種類（network はオフラインなら offline） */
export function classifySpeechError(code: string, online = true): SpeechErrorKind {
  switch (code) {
    // マイクの権限の拒否。service-not-allowed は音声認識サービス自体が使えない（Google アプリの音声入力が無効など）
    case "not-allowed":
    case "service-not-allowed":
      return "not-allowed";
    case "no-speech":
      return "no-speech";
    case "network":
      return online ? "network" : "offline";
    case "audio-capture":
      return "audio-capture";
    case "aborted":
      return "aborted";
    case "language-not-supported":
      return "language";
    default:
      return "unknown";
  }
}

/** start() の例外 → 失敗の種類 */
function classifyStartError(e: unknown): SpeechErrorKind {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "not-allowed";
  return "unknown";
}

/** 失敗の種類ごとの案内（画面にそのまま出す） */
export function speechErrorMessage(kind: SpeechErrorKind): string {
  switch (kind) {
    case "not-allowed":
      return "マイクの使用が許可されていません。アドレスバーの鍵アイコン（サイトの設定）→ 権限 でマイクを「許可」にしてください。ホーム画面のアプリから開いている場合は、Android の 設定 → アプリ → Chrome → 権限 → マイク も確認してください。それでも使えないときは、Google アプリ（音声入力）が有効になっているか確かめてください。";
    case "no-speech":
      return "声が聞き取れませんでした。🎤 を押してから、マイクに向かってはっきり言ってみてください。";
    case "network":
      return "音声認識のサービスにつながりませんでした。電波のよい所で、もう一度お試しください。";
    case "offline":
      return "オフラインのため音声認識を使えません。音声認識はネットにつながっているときだけ使えます。";
    case "audio-capture":
      return "マイクから音を取れませんでした。通話中でないか、ほかのアプリ（録音・ビデオ通話など）がマイクを使っていないか確認してください。";
    case "aborted":
      return "聞き取りを取りやめました。";
    case "unsupported":
      return "このブラウザは音声認識に対応していません。Android の Chrome でお試しください。";
    case "language":
      return "この端末ではポルトガル語（ブラジル）の音声認識を使えません。Google アプリを最新にして、音声入力の言語に「ポルトガル語（ブラジル）」を追加してからお試しください。";
    default:
      return "音声認識がうまくいきませんでした。もう一度お試しください。";
  }
}

// ---------------------------------------------------------------------------
// Web Speech API（SpeechRecognition）の実装
// ---------------------------------------------------------------------------

/** 使う認識エンジンの最小限の形（lib.dom に SpeechRecognition の型が無いため自前で持つ） */
interface RecAlternative {
  readonly transcript: string;
  readonly confidence: number;
}
interface RecResult {
  readonly length: number;
  readonly isFinal: boolean;
  readonly [index: number]: RecAlternative;
}
interface RecResultList {
  readonly length: number;
  readonly [index: number]: RecResult;
}
export interface RecEvent {
  readonly resultIndex: number;
  readonly results: RecResultList;
}
export interface RecErrorEvent {
  readonly error: string;
  readonly message?: string;
}
export interface RecognizerLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((e: RecEvent) => void) | null;
  onerror: ((e: RecErrorEvent) => void) | null;
  onend: (() => void) | null;
  /** マイクの音を取り始めた（権限の確認の後）。ここから時間の上限を数える */
  onaudiostart: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
export type RecognizerCtor = new () => RecognizerLike;

/** 環境への依存（検査では偽物に差し替える） */
export interface SpeechDeps {
  /** 認識エンジンのコンストラクタ（無ければ null = 非対応） */
  getCtor: () => RecognizerCtor | null;
  /** オンラインか（false なら聞く前に offline で失敗させる） */
  isOnline: () => boolean;
  /** 読み上げを止める（読み上げの声を認識に拾わせないため） */
  cancelAudio: () => void;
}

const LANG = "pt-BR";
const MAX_ALTERNATIVES = 5;
/** 1回の聞き取りの上限（ms。マイクの音を取り始めてから） */
export const LISTEN_TIMEOUT_MS = 8000;
/** 文を言うときの上限の見込み: 1語あたり（ms）と、話し始めるまでの余裕（ms） */
export const SENTENCE_MS_PER_WORD = 700;
export const SENTENCE_LEAD_MS = 3000;

/**
 * 1文を言ってもらうときの聞き取りの上限（ms）。いちばん長い正解の語数 × SENTENCE_MS_PER_WORD ＋ SENTENCE_LEAD_MS、
 * ただし LISTEN_TIMEOUT_MS より短くしない（20語の文なら 17秒。短い文は 8秒のまま。
 * 話し終えて間が空けば、認識エンジンが上限を待たずに終える）
 */
export function sentenceListenTimeoutMs(expected: string | readonly string[]): number {
  const list: readonly string[] = typeof expected === "string" ? [expected] : expected;
  const longest = Math.max(0, ...list.map((e) => e.split(/\s+/).filter(Boolean).length));
  return Math.max(LISTEN_TIMEOUT_MS, longest * SENTENCE_MS_PER_WORD + SENTENCE_LEAD_MS);
}

/**
 * マイクの音を取り始めるまでの猶予（ms）。初めて使うときはマイクの許可を求める表示が出るので、
 * その間は時間切れにしない（audiostart が来たら LISTEN_TIMEOUT_MS から数え直す）
 */
export const START_GRACE_MS = 15000;
/** stop() の後、確定の結果・終わりの知らせを待つ上限（ms）。来なければ途中経過で終える */
export const STOP_GRACE_MS = 1500;

function defaultCtor(): RecognizerCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const DEFAULT_DEPS: SpeechDeps = {
  getCtor: defaultCtor,
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  cancelAudio: () => audio.cancel(),
};

/** 聞き取り中の1回分（stop・cancel の対象） */
interface Active {
  stop: () => void;
  cancel: () => void;
}

/** 候補の文字の整形（前後・連続の空白） */
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * 結果の一覧から、途中経過の文字と、確定していれば候補の一覧を取り出す。
 * 1回だけ聞く（continuous=false）ので結果はふつう1つ。複数に分かれたら先頭の候補をつないだ1件にする
 */
function readResults(list: RecResultList): { interim: string; final: string[] | null; confidence?: number } {
  const parts: string[] = [];
  let allFinal = list.length > 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (!r || r.length === 0) continue;
    parts.push(r[0].transcript);
    if (!r.isFinal) allFinal = false;
  }
  const interim = clean(parts.join(" "));
  if (!allFinal) return { interim, final: null };
  let alts: string[];
  let confidence: number | undefined;
  if (list.length === 1) {
    const r = list[0];
    alts = [];
    for (let k = 0; k < r.length; k++) alts.push(clean(r[k].transcript));
    const c = r.length ? r[0].confidence : undefined;
    confidence = typeof c === "number" && c > 0 ? c : undefined;
  } else {
    alts = [interim];
  }
  const final = [...new Set(alts.filter(Boolean))];
  return { interim, final: final.length ? final : null, ...(confidence !== undefined ? { confidence } : {}) };
}

/** Web Speech API の音声認識（deps で環境を差し替えられる。検査用） */
export function createWebSpeechInput(deps: Partial<SpeechDeps> = {}): SpeechInputProvider {
  const d: SpeechDeps = { ...DEFAULT_DEPS, ...deps };
  let active: Active | null = null;

  function listen(opts: ListenOptions = {}): Promise<SpeechResult> {
    const Ctor = d.getCtor();
    if (!Ctor) return Promise.reject(new SpeechInputError("unsupported"));
    if (opts.signal?.aborted) return Promise.reject(new SpeechInputError("aborted"));
    if (!d.isOnline()) return Promise.reject(new SpeechInputError("offline"));
    // 同時に聞き取るのは1つだけ。読み上げの声を拾わないよう、読み上げも止める
    active?.cancel();
    d.cancelAudio();

    return new Promise<SpeechResult>((resolve, reject) => {
      let rec: RecognizerLike;
      try {
        rec = new Ctor();
      } catch (e) {
        reject(new SpeechInputError("unsupported", e));
        return;
      }
      let done = false;
      let interim = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      let grace: ReturnType<typeof setTimeout> | undefined;

      const finish = (r: { ok: true; value: SpeechResult } | { ok: false; err: SpeechInputError }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearTimeout(grace);
        opts.signal?.removeEventListener("abort", onAbort);
        rec.onresult = null;
        rec.onerror = null;
        rec.onend = null;
        rec.onaudiostart = null;
        if (active === me) active = null;
        // どの終わり方でも認識エンジンを止める（マイクを閉じる。止まっていれば何も起きない）
        try {
          rec.abort();
        } catch {
          // すでに止まっている
        }
        if (r.ok) resolve(r.value);
        else reject(r.err);
      };
      const fail = (kind: SpeechErrorKind, original?: unknown) => finish({ ok: false, err: new SpeechInputError(kind, original) });
      /** 確定の結果が来ないまま終わった: 途中経過があればそれを結果にする（無ければ no-speech） */
      const fromInterim = () => (interim ? finish({ ok: true, value: { transcripts: [interim] } }) : fail("no-speech"));
      const onAbort = () => fail("aborted");

      const me: Active = {
        stop: () => {
          if (done) return;
          try {
            rec.stop();
          } catch {
            // 止められなければ待たずに終える
            fromInterim();
            return;
          }
          if (grace === undefined) grace = setTimeout(fromInterim, STOP_GRACE_MS);
        },
        cancel: () => fail("aborted"),
      };

      rec.lang = opts.lang ?? LANG;
      rec.interimResults = true;
      rec.maxAlternatives = opts.maxAlternatives ?? MAX_ALTERNATIVES;
      rec.continuous = false;
      rec.onresult = (e) => {
        const r = readResults(e.results);
        if (r.interim) interim = r.interim;
        if (r.final) {
          finish({ ok: true, value: { transcripts: r.final, ...(r.confidence !== undefined ? { confidence: r.confidence } : {}) } });
          return;
        }
        if (r.interim) opts.onInterim?.(r.interim);
      };
      rec.onerror = (e) => {
        const kind = classifySpeechError(e.error, d.isOnline());
        // 途中まで聞き取れていたら、声が途切れた（no-speech）ではなく聞き取れた分を結果にする
        if (kind === "no-speech" && interim) fromInterim();
        else fail(kind, e.error);
      };
      rec.onend = fromInterim;
      const timeoutMs = opts.timeoutMs ?? LISTEN_TIMEOUT_MS;
      /** 時間の上限を ms 後に置き直す */
      const arm = (ms: number) => {
        clearTimeout(timer);
        timer = setTimeout(fromInterim, ms);
      };
      rec.onaudiostart = () => arm(timeoutMs);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      active = me;
      // マイクの許可を待つ間も含めた上限。音を取り始めたら timeoutMs から数え直す
      arm(timeoutMs + START_GRACE_MS);
      try {
        // タップの処理の中で同期に始める
        rec.start();
      } catch (e) {
        fail(classifyStartError(e), e);
      }
    });
  }

  return {
    isSupported: () => d.getCtor() !== null,
    listen,
    stop: () => active?.stop(),
    cancel: () => active?.cancel(),
    isListening: () => active !== null,
  };
}

export const speechInput: SpeechInputProvider = createWebSpeechInput();
