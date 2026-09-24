// ============================================================================
// 耳だけ復習（HandsfreePlayer）の進め方（ストア・DOM・音声に直接は触らない。
// 読み上げ・待ち・画面への通知は runHandsfree の io で受け取る。ほかは純関数）
//   検証: scripts/check-srs.ts（npm run check:srs）
// 1語ごとに次の順で進める（向きは設定の handsfreeDirection）。
//   pt2ja: 葡を読む → 考える間 → 和を読む（日本語の音声が無ければ画面に出して 1.5 秒） → 600ms → 葡をもう一度
//   ja2pt: 和を読む（無ければ画面に出して 1.5 秒） → 考える間 → 葡を読む → 600ms → 葡をもう一度（後について言う）
// 語と語の間は NEXT_WORD_MS あける。SRS には書かない（評価は「1枚ずつで確認」で通常の rate を通す）。
// ============================================================================

import type { HandsfreeDirection } from "../data/types";

/** 考える間の選択肢（秒）と既定値（設定の handsfreeGapSec） */
export const HANDSFREE_GAPS_SEC = [2, 3, 5] as const;
export const DEFAULT_HANDSFREE_GAP_SEC = 3;
/** 考える間として受け付ける範囲（秒）。設定が壊れていてもこの範囲に収める */
const MIN_GAP_SEC = 1;
const MAX_GAP_SEC = 10;

/** 日本語の音声が無いとき、日本語を画面に大きく出して待つ時間 */
export const JA_SHOW_MS = 1500;
/** 答えの後、ポルトガル語をもう一度読むまでの間 */
export const REPEAT_PAUSE_MS = 600;
/** 語と語の間（前の語の最後の葡と、次の語の最初の音がつながらないように） */
export const NEXT_WORD_MS = 1200;

/**
 * 1語の中の段階（画面の出し分けに使う）。
 * prompt: 問いを読む / think: 考える間 / answer: 答えを読む（出す）・その後の間 / repeat: 葡をもう一度
 */
export type HandsfreePhase = "prompt" | "think" | "answer" | "repeat";

/** 1語分の手順の1つ */
export type HandsfreeStep =
  /** 読み上げる（pt は ptForSpeech、ja は jaForSpeech(ja)） */
  | { t: "say"; lang: "pt" | "ja"; phase: HandsfreePhase }
  /** 日本語の音声が無いとき: 日本語を画面に出して ms 待つ */
  | { t: "show"; ms: number; phase: HandsfreePhase }
  /** 間をあける */
  | { t: "wait"; ms: number; phase: HandsfreePhase };

/** 設定の考える間（秒）を ms にする。数でない・0 以下なら既定値、範囲外は 1〜10 秒に収める */
export function handsfreeGapMs(sec: unknown): number {
  const s = typeof sec === "number" && Number.isFinite(sec) && sec > 0 ? sec : DEFAULT_HANDSFREE_GAP_SEC;
  return Math.round(Math.min(MAX_GAP_SEC, Math.max(MIN_GAP_SEC, s)) * 1000);
}

/** 設定の向き（壊れていれば pt2ja） */
export function handsfreeDirection(v: unknown): HandsfreeDirection {
  return v === "ja2pt" ? "ja2pt" : "pt2ja";
}

/**
 * 1語分の手順。jaVoice は「日本語の音声があり、読む訳もある」とき true
 * （false なら日本語は読まずに画面に出して JA_SHOW_MS 待つ）。
 */
export function handsfreeSteps(dir: HandsfreeDirection, gapMs: number, jaVoice: boolean): HandsfreeStep[] {
  const ja = (phase: HandsfreePhase): HandsfreeStep =>
    jaVoice ? { t: "say", lang: "ja", phase } : { t: "show", ms: JA_SHOW_MS, phase };
  const think: HandsfreeStep = { t: "wait", ms: Math.max(0, gapMs), phase: "think" };
  const tail: HandsfreeStep[] = [
    { t: "wait", ms: REPEAT_PAUSE_MS, phase: "answer" },
    { t: "say", lang: "pt", phase: "repeat" },
  ];
  return dir === "ja2pt"
    ? [ja("prompt"), think, { t: "say", lang: "pt", phase: "answer" }, ...tail]
    : [{ t: "say", lang: "pt", phase: "prompt" }, think, ja("answer"), ...tail];
}

/** 答え（pt2ja なら和、ja2pt なら葡）を画面に出してよい段階か */
export function answerShown(phase: HandsfreePhase): boolean {
  return phase === "answer" || phase === "repeat";
}

/**
 * 日本語の訳を読み上げ用に整える。「〜」「～」は「から」と読まれることがあるので消す
 * （括弧の注記・「/」は audio.speak の cleanForSpeech が処理する）
 */
export function jaForSpeech(ja: string): string {
  return ja.replace(/[〜～]/g, "").replace(/\s+/g, " ").trim();
}

/** 1語あたりのおおよその秒数（読み上げ3回分の目安＋間）。開始画面の「約n分」に使う */
const SPEECH_EST_MS = 1200;
export function estimateSec(words: number, gapMs: number): number {
  if (!(words > 0)) return 0;
  const perWord = SPEECH_EST_MS * 3 + Math.max(0, gapMs) + REPEAT_PAUSE_MS + NEXT_WORD_MS;
  return Math.round((words * perWord - NEXT_WORD_MS) / 1000);
}

/**
 * 「1枚ずつで確認」に渡す並び: 印をつけた語を先頭に（それぞれ元の並びのまま）、残りをその後に。
 * 入力は変えない。marked に無い id・words に無い id は無視する
 */
export function markedFirst<T extends { id: string }>(words: readonly T[], marked: ReadonlySet<string>): T[] {
  return [...words.filter((w) => marked.has(w.id)), ...words.filter((w) => !marked.has(w.id))];
}

// ---------------------------------------------------------------------------
// 再生の進行（読み上げ・待ち・画面への通知は io で受け取る。検証では偽物を渡す）
// ---------------------------------------------------------------------------

/** その語を始めるときの設定（語ごとに読み直す。再生中の変更は次の語から効く） */
export interface HandsfreeConfig {
  dir: HandsfreeDirection;
  gapMs: number;
  /** 日本語の音声があるか */
  jaVoice: boolean;
}

/** onStep で渡す、その語の情報 */
export interface HandsfreeStepInfo extends HandsfreeConfig {
  /** この語の日本語を読み上げるか（音声があり、読む訳もある）。false なら画面に出すだけ */
  jaSpoken: boolean;
}

export interface HandsfreeIO {
  /** 読み上げる（読み終えた・止められたら resolve） */
  speak(text: string, lang: "pt" | "ja"): Promise<void>;
  /** 無音の発話。最初の手順が読み上げでないとき、再生を始めたタップの処理の中で読み上げを始めておく */
  prime(): void;
  /** ms 待つ（signal で止めたら reject） */
  wait(ms: number, signal: AbortSignal): Promise<void>;
  /** その語を始めるときの設定 */
  config(): HandsfreeConfig;
  /** 語を始めた（i は list の番号） */
  onWord?(i: number): void;
  /** 手順を始める直前（画面の段階を変える） */
  onStep?(i: number, step: HandsfreeStep, info: HandsfreeStepInfo): void;
  /** 1語を最後の葡まで聴き終えた */
  onWordDone?(i: number): void;
}

/** 耳だけ復習で読む語（Word のうち使う項目） */
export interface HandsfreeWord {
  ptForSpeech: string;
  ja: string;
}

/**
 * list の from 番目から最後まで読む。最後まで読んだら "end"、signal で止めたら "aborted"。
 * 最初の語の最初の speak（または prime）は、この関数を呼んだ処理の中で同期的に呼ぶ（最初の await の前）。
 * 語と語の間は NEXT_WORD_MS（最後の語の後には待たない）。止めた語は onWordDone を呼ばない。
 */
export async function runHandsfree(
  list: readonly HandsfreeWord[],
  from: number,
  io: HandsfreeIO,
  signal: AbortSignal
): Promise<"end" | "aborted"> {
  const start = Math.max(0, Math.floor(from));
  try {
    for (let i = start; i < list.length; i++) {
      if (signal.aborted) return "aborted";
      const w = list[i];
      const cfg = io.config();
      const jaText = jaForSpeech(w.ja);
      const jaSpoken = cfg.jaVoice && jaText !== "";
      const steps = handsfreeSteps(cfg.dir, cfg.gapMs, jaSpoken);
      const info: HandsfreeStepInfo = { ...cfg, jaSpoken };
      io.onWord?.(i);
      // タップから始めた最初の語で、最初の手順が読み上げでない（和→葡で日本語を読まない）ときは、
      // 次の葡が考える間の後になるため、タップの処理の中で無音の発話を始めておく
      if (i === start && steps[0].t !== "say") io.prime();
      for (const st of steps) {
        if (signal.aborted) return "aborted";
        io.onStep?.(i, st, info);
        if (st.t === "say") {
          await io.speak(st.lang === "pt" ? w.ptForSpeech : jaText, st.lang);
          if (signal.aborted) return "aborted";
        } else {
          await io.wait(st.ms, signal);
        }
      }
      io.onWordDone?.(i);
      if (i < list.length - 1) await io.wait(NEXT_WORD_MS, signal);
    }
    return signal.aborted ? "aborted" : "end";
  } catch {
    // 間の待ちが止められた（AbortError）
    return "aborted";
  }
}
