// ============================================================================
// 音声認識（src/services/speechInput.ts）を画面から使うフック（🎤 言ってみる）
// - start(): 聞き取りを始める。タップの処理の中で呼ぶ（認識エンジンの start はその場で同期に呼ばれる）。
//   結果で解決する（取りやめ・失敗は null。失敗の種類は error に入る）
// - stop(): 早めに終える（そこまでに聞き取れた分で結果を出す）
// - reset(): 聞き取り中なら取りやめ、最初の状態に戻す
// - 画面を離れたら（アンマウント）聞き取りを取りやめる（マイクを閉じる）
// 別の画面・ボタンが聞き取りを始めると、こちらの聞き取りは取りやめになり idle に戻る（同時に1つだけ）。
// 結果（認識した文字）はこのフックの state にだけ持ち、保存しない。
// ============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import {
  SpeechInputError,
  speechInput,
  type SpeechErrorKind,
  type SpeechInputProvider,
  type SpeechResult,
} from "../services/speechInput";

export type SpeechStatus = "idle" | "listening" | "done" | "error";

export interface SpeechInputHandle {
  status: SpeechStatus;
  /** 聞き取り中の途中経過（確定前の文字） */
  interim: string;
  /** 確定した結果（status が done のとき） */
  result: SpeechResult | null;
  /** 失敗の種類（status が error のとき） */
  error: SpeechErrorKind | null;
  /** 聞き取りを始める（タップの処理の中で呼ぶ）。結果で解決する（取りやめ・失敗は null） */
  start: () => Promise<SpeechResult | null>;
  /** 早めに終える（聞き取れた分で結果を出す） */
  stop: () => void;
  /** 取りやめて最初の状態に戻す */
  reset: () => void;
}

export interface UseSpeechInputOptions {
  lang?: string;
  maxAlternatives?: number;
  timeoutMs?: number;
  /** 使う認識エンジン（既定: speechInput。検査で差し替える） */
  provider?: SpeechInputProvider;
}

export function useSpeechInput(opts: UseSpeechInputOptions = {}): SpeechInputHandle {
  const provider = opts.provider ?? speechInput;
  const [status, setStatus] = useState<SpeechStatus>("idle");
  const [interim, setInterim] = useState("");
  const [result, setResult] = useState<SpeechResult | null>(null);
  const [error, setError] = useState<SpeechErrorKind | null>(null);
  /** 今の聞き取りの中断（聞いていなければ null） */
  const ctrlRef = useRef<AbortController | null>(null);
  /** 画面を離れた後に state を触らないための印 */
  const aliveRef = useRef(true);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      const c = ctrlRef.current;
      ctrlRef.current = null;
      c?.abort();
    };
  }, []);

  const start = useCallback(async (): Promise<SpeechResult | null> => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setStatus("listening");
    setInterim("");
    setResult(null);
    setError(null);
    const o = optsRef.current;
    const mine = () => ctrlRef.current === ctrl && aliveRef.current;
    try {
      // listen は同期に認識エンジンの start を呼ぶ（await の前に呼ぶこと）
      const r = await provider.listen({
        lang: o.lang,
        maxAlternatives: o.maxAlternatives,
        timeoutMs: o.timeoutMs,
        signal: ctrl.signal,
        onInterim: (t) => {
          if (mine()) setInterim(t);
        },
      });
      if (!mine()) return null;
      ctrlRef.current = null;
      setResult(r);
      setStatus("done");
      return r;
    } catch (e) {
      if (!mine()) return null;
      ctrlRef.current = null;
      const kind: SpeechErrorKind = e instanceof SpeechInputError ? e.kind : "unknown";
      // 取りやめ（別のボタンが聞き取りを始めた・reset など）は失敗として見せない
      if (kind === "aborted") {
        setStatus("idle");
        setInterim("");
      } else {
        setError(kind);
        setStatus("error");
      }
      return null;
    }
  }, [provider]);

  const stop = useCallback(() => {
    if (ctrlRef.current) provider.stop();
  }, [provider]);

  const reset = useCallback(() => {
    const c = ctrlRef.current;
    ctrlRef.current = null;
    c?.abort();
    setStatus("idle");
    setInterim("");
    setResult(null);
    setError(null);
  }, []);

  return { status, interim, result, error, start, stop, reset };
}
