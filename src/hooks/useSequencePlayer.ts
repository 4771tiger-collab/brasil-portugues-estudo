// ============================================================================
// 読み上げの連続再生と1文再生（シャドーイング・チャンクリーディングで共通）
// - どの再生も、始める前に前の再生の AbortController を abort し、audio.cancel() を呼ぶ。
//   連続再生の途中で行をタップすると、その行だけを読み、連続再生は先へ進まない（バグ#19）
// - playAll の間は Wake Lock を取る（画面に触れずに聴き続けられるように）
// - 画面を離れたら（アンマウント）止める。止めるのは自分の再生中だけ（ほかの読み上げは止めない）
// - 最初の speak は呼び出し（クリック処理）の中で同期的に呼ぶ。呼ぶ側も await の前に呼ぶこと
// 速さ・音声などは、フックの引数（既定）→ 呼び出しごとの opts の順に上書きする。
// 何も指定しなければ、設定の速さ（rate）と音声（voiceURI）を使う。
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { audio, delay } from "../services/audio";
import { useSettings } from "../store/useSettings";
import { useWakeLock } from "./useWakeLock";

export interface SequencePlayOptions {
  /** 速さ（既定: 設定の rate） */
  rate?: number;
  /** 音声（既定: 設定の voiceURI） */
  voiceURI?: string | null;
  /** 言語（既定: pt-BR） */
  lang?: string;
  /** 連続再生の文と文の間（ms） */
  gapMs?: number;
}

export interface SequencePlayer {
  /** playAll の途中か（1文だけの再生では false） */
  playing: boolean;
  /** いま読んでいる文の番号（playOne で idx を渡さなかったとき・止まっているときは null） */
  activeIdx: number | null;
  /**
   * texts を from 番目から順に読む。最後まで読んだら true、止めた・別の再生に替わった・読み上げ非対応なら false。
   * activeIdx は texts の番号（from を足した位置）。
   */
  playAll(texts: string[], from?: number, opts?: SequencePlayOptions): Promise<boolean>;
  /**
   * 1文だけ読む（連続再生の途中なら、それを止めてから読む）。idx を渡すと、その間 activeIdx になる。
   * 読み終えたら true、止めた・別の再生に替わった・読み上げ非対応なら false。
   */
  playOne(text: string, idx?: number, opts?: SequencePlayOptions): Promise<boolean>;
  /** 止める */
  stop(): void;
}

/** 連続再生の文と文の間（ms）の既定値（audio.speakSequence と同じ） */
const DEFAULT_GAP_MS = 350;

/** 速度の選択肢（設定の速さが含まれなければ足す） */
const BASE_SPEEDS = [0.8, 1.0, 1.2];

/**
 * 画面の速度ボタンの選択肢（シャドーイング・チャンクリーディングで共通）。
 * 設定の速さ（0.7 / 0.9 など）が無ければ加え、初期値のボタンが選ばれて見えるようにする
 */
export function speedOptions(rate: number): number[] {
  if (!(rate > 0) || BASE_SPEEDS.some((s) => Math.abs(s - rate) < 0.001)) return BASE_SPEEDS;
  return [...BASE_SPEEDS, rate].sort((a, b) => a - b);
}

interface Resolved {
  rate: number;
  voiceURI: string | null;
  lang: string | undefined;
  gapMs: number;
}

export function useSequencePlayer(defaults: SequencePlayOptions = {}): SequencePlayer {
  const settingsRate = useSettings((s) => s.rate);
  const settingsVoice = useSettings((s) => s.voiceURI);
  const [playing, setPlaying] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 再生のたびに増やす。前の再生が終わったときに、新しい再生の表示を消さないため
  const tokRef = useRef(0);

  // 呼び出しの時点の既定値（毎回の描画で最新にする。コールバックは作り直さない）
  const baseRef = useRef<Resolved>({ rate: 1, voiceURI: null, lang: undefined, gapMs: DEFAULT_GAP_MS });
  baseRef.current = {
    rate: defaults.rate ?? (settingsRate > 0 ? settingsRate : 1),
    voiceURI: defaults.voiceURI ?? settingsVoice,
    lang: defaults.lang,
    gapMs: defaults.gapMs ?? DEFAULT_GAP_MS,
  };

  // 連続再生の間は画面を消さない
  useWakeLock(playing);

  const resolve = useCallback((o?: SequencePlayOptions): Resolved => {
    const b = baseRef.current;
    return {
      rate: o?.rate ?? b.rate,
      voiceURI: o?.voiceURI ?? b.voiceURI,
      lang: o?.lang ?? b.lang,
      gapMs: o?.gapMs ?? b.gapMs,
    };
  }, []);

  /** 前の再生を止めて、新しい再生の AbortController と番号を用意する */
  const begin = useCallback(() => {
    abortRef.current?.abort();
    audio.cancel();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const tok = ++tokRef.current;
    return { ctrl, tok };
  }, []);

  /** tok の再生がまだ最新なら、表示を止まった状態に戻す */
  const settle = useCallback((tok: number) => {
    if (tokRef.current !== tok) return;
    abortRef.current = null;
    setPlaying(false);
    setActiveIdx(null);
  }, []);

  const stop = useCallback(() => {
    tokRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    audio.cancel();
    setPlaying(false);
    setActiveIdx(null);
  }, []);

  const playAll = useCallback(
    async (texts: string[], from = 0, opts?: SequencePlayOptions): Promise<boolean> => {
      const { ctrl, tok } = begin();
      const o = resolve(opts);
      const start = Math.max(0, Math.floor(from));
      if (!audio.isSupported() || start >= texts.length) {
        settle(tok);
        return false;
      }
      setPlaying(true);
      try {
        for (let i = start; i < texts.length; i++) {
          if (ctrl.signal.aborted) return false;
          setActiveIdx(i);
          // 1文目はクリック処理の中（同期）で speak を呼ぶ
          await audio.speak(texts[i], { rate: o.rate, voiceURI: o.voiceURI, lang: o.lang });
          if (ctrl.signal.aborted) return false;
          if (i < texts.length - 1 && o.gapMs > 0) await delay(o.gapMs, ctrl.signal);
        }
        return !ctrl.signal.aborted;
      } catch {
        return false; // 間の待ちで止められた（AbortError）
      } finally {
        settle(tok);
      }
    },
    [begin, resolve, settle]
  );

  const playOne = useCallback(
    async (text: string, idx?: number, opts?: SequencePlayOptions): Promise<boolean> => {
      const { ctrl, tok } = begin();
      const o = resolve(opts);
      setPlaying(false);
      if (!audio.isSupported()) {
        settle(tok);
        return false;
      }
      setActiveIdx(idx ?? null);
      try {
        await audio.speak(text, { rate: o.rate, voiceURI: o.voiceURI, lang: o.lang });
        return !ctrl.signal.aborted;
      } finally {
        settle(tok);
      }
    },
    [begin, resolve, settle]
  );

  // 画面を離れたら、自分が再生中のときだけ止める（state は更新しない）。
  // 何も再生していない・読み終えたフック（閉じた活用表など）が、ほかの画面の読み上げ
  // （1枚ずつ学習の新出語の自動再生・一覧の連続再生）を止めないように
  useEffect(
    () => () => {
      tokRef.current++;
      const c = abortRef.current;
      abortRef.current = null;
      if (c) {
        c.abort();
        audio.cancel();
      }
    },
    []
  );

  return useMemo(() => ({ playing, activeIdx, playAll, playOne, stop }), [playing, activeIdx, playAll, playOne, stop]);
}
