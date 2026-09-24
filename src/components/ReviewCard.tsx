import { useState } from "react";
import type { SrsCard, Word } from "../data/types";
import { getExtra } from "../data/loadWords";
import { daysUntilDue } from "../srs/scheduler";
import SpeakerButton from "./SpeakerButton";

interface Props {
  word: Word;
  kind: "intro" | "test";
  phase: "front" | "back";
  /** test の出題方向（表に出す言語） */
  direction: "pt2ja" | "ja2pt";
  showKana: boolean;
  showIpa: boolean;
  /** 今の SRS カード（期限前の表示に使う） */
  card?: SrsCard;
  today: string;
  /** 表面のタップで答えを開く */
  onReveal?: () => void;
}

/** 葡の見出し（綴り・品詞・発音ガイド・音声） */
function PtBlock({ word, showKana, showIpa, big }: { word: Word; showKana: boolean; showIpa: boolean; big?: boolean }) {
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <div className="flex items-center gap-1">
        <span className={`font-bold text-brand-ink ${big ? "text-3xl" : "text-2xl"}`}>{word.pt}</span>
        <SpeakerButton text={word.ptForSpeech} size={22} />
      </div>
      {(showKana || showIpa) && (
        <div className="flex flex-wrap items-center justify-center gap-x-2 text-sm text-slate-400">
          {showKana && word.kana && <span>{word.kana}</span>}
          {showIpa && word.ipa && <span className="font-mono">/{word.ipa}/</span>}
        </div>
      )}
    </div>
  );
}

/** 例文1件（あれば） */
function ExampleBlock({ word }: { word: Word }) {
  const ex = getExtra(word)?.examples?.[0];
  if (!ex) return null;
  return (
    <div className="mt-4 w-full rounded-lg bg-slate-50 p-3 text-left text-sm">
      <div className="flex items-center gap-1">
        <span className="font-medium text-brand-ink">{ex.pt}</span>
        <SpeakerButton text={ex.pt} size={16} title="例文を再生" />
      </div>
      {ex.kana && <div className="text-[11px] text-slate-400">{ex.kana}</div>}
      <div className="text-xs text-slate-500">{ex.ja}</div>
    </div>
  );
}

/**
 * 解説（カポエイラ語の元の訳「読み（意味）」）の切替。読み＝答えの音写を含むので、
 * 答えを開いた後（裏）と紹介のときだけ出す。
 */
function NoteToggle({ word }: { word: Word }) {
  const [open, setOpen] = useState(false);
  if (!word.note) return null;
  return (
    <div className="mt-3 flex w-full flex-col items-center">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="min-h-11 px-3 text-xs font-medium text-brand-blue"
      >
        {open ? "解説を隠す" : "解説"}
      </button>
      {open && <div className="w-full rounded-lg bg-slate-50 p-3 text-left text-sm text-slate-600">{word.note}</div>}
    </div>
  );
}

/** 期限前のカード: 今評価しても「もう一度」以外は間隔が変わらないことを示す */
function NotDueNote({ card, today }: { card?: SrsCard; today: string }) {
  if (!card?.last) return null;
  const n = daysUntilDue(card, today);
  if (n <= 0) return null;
  return (
    <div className="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-center text-xs text-slate-500">
      復習日まで {n}日 ・ 今の評価は据え置き（「もう一度」だけ反映）
    </div>
  );
}

/**
 * 1枚ずつ学習のカード本体（表・裏・紹介）。
 * 操作ボタンは親（ReviewSession）の親指ゾーンに置く。
 */
export default function ReviewCard({ word, kind, phase, direction, showKana, showIpa, card, today, onReveal }: Props) {
  const box = "card flex min-h-[45vh] flex-col items-center justify-center p-6 animate-pop";

  if (kind === "intro") {
    return (
      <div className={box}>
        <span className="chip mb-3 bg-brand-yellow/30 text-amber-800">新しい語</span>
        <PtBlock word={word} showKana={showKana} showIpa={showIpa} big />
        <span className="chip mt-2 bg-slate-100 text-slate-500">{word.pos}</span>
        <div className="mt-4 border-t border-dashed border-slate-200 pt-4 text-center text-lg text-slate-700">{word.ja}</div>
        <NoteToggle word={word} />
        <ExampleBlock word={word} />
        <p className="mt-4 text-center text-xs text-slate-400">数枚あとに、表だけでテストします</p>
      </div>
    );
  }

  const prompt =
    direction === "pt2ja" ? (
      <PtBlock word={word} showKana={showKana} showIpa={showIpa} big />
    ) : (
      <div className="text-center text-2xl font-bold text-brand-ink">{word.ja}</div>
    );

  if (phase === "front") {
    return (
      <div
        className={`${box} cursor-pointer select-none`}
        onClick={onReveal}
        role="button"
        tabIndex={-1}
        aria-label="答えを見る"
      >
        {prompt}
        <span className="chip mt-2 bg-slate-100 text-slate-500">{word.pos}</span>
        <p className="mt-6 text-center text-xs text-slate-400">
          {direction === "pt2ja" ? "意味を思い出してから" : "ポルトガル語を思い出してから"}「答えを見る」
        </p>
      </div>
    );
  }

  // 裏面: 問い（表と同じ）＋ 答え
  return (
    <div className={box}>
      {prompt}
      <span className="chip mt-2 bg-slate-100 text-slate-500">{word.pos}</span>
      <div className="mt-4 w-full border-t border-dashed border-slate-200 pt-4">
        {direction === "pt2ja" ? (
          <div className="text-center text-xl font-bold text-slate-700">{word.ja}</div>
        ) : (
          <PtBlock word={word} showKana={showKana} showIpa={showIpa} />
        )}
      </div>
      <NoteToggle word={word} />
      <ExampleBlock word={word} />
      <NotDueNote card={card} today={today} />
    </div>
  );
}
