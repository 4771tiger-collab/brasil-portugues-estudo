import { useState } from "react";
import type { ProductionAnswerMode, Rating, SrsCard, Word } from "../data/types";
import { getExtra } from "../data/loadWords";
import { daysUntilDue } from "../srs/scheduler";
import type { Dir } from "../srs/cardKey";
import type { GradeResult } from "../services/grade";
import { isOwnAnswer } from "../services/gradeLexicon";
import ConjugationTable from "./ConjugationTable";
import DiffView from "./DiffView";
import PtInput from "./PtInput";
import { RATING_LABEL } from "./RatingButtons";
import SpeakerButton from "./SpeakerButton";

/** 産出カード（和→葡）を入力などで答えた結果（ReviewSession が採点して持つ） */
export interface ProdAnswer {
  /** 答えた文字列（「わからない」のときは ""。speech は採点に使った聞き取りの文字） */
  input: string;
  /** 採点（null = 「わからない」で答えを見た） */
  result: GradeResult | null;
  /** 採点から勧める評価（RatingButtons で強調する。選ぶのは学習者） */
  suggested: Rating;
  /** 答え方（type = 入力。speech = 音声認識の「🎤 言ってみる」。アクセント記号の違いは正解として採点済み） */
  via: "type" | "speech";
}

interface Props {
  word: Word;
  kind: "intro" | "test";
  phase: "front" | "back";
  /** 理解カードの test の出題方向（表に出す言語）。産出カードでは使わない */
  direction: "pt2ja" | "ja2pt";
  showKana: boolean;
  showIpa: boolean;
  /** 今の SRS カード（期限前の表示に使う。産出カードなら産出カード） */
  card?: SrsCard;
  today: string;
  /** 表面のタップで答えを開く */
  onReveal?: () => void;
  /** 出題方向（prod = 和→葡の産出カード。省略時は理解カード） */
  dir?: Dir;
  /** 産出カード: 入力などで答えた結果（裏面に採点を出す） */
  answer?: ProdAnswer;
  /** 産出カード: 答え方の既定（type なら入力欄を最初から開く） */
  answerMode?: ProductionAnswerMode;
  /** 産出カード: 入力の答え合わせ（null = 「わからない」）。採点・裏返し・読み上げは親の handler で行う */
  onAnswer?: (input: string | null) => void;
  /**
   * 産出カードの表面に置く「🎤 言ってみる」（音声認識）ボタンの差し込み口。
   * 「✍ 入力して答える」の下に出す。ReviewSession が設定（speechInputEnabled）がオンで対応ブラウザのときだけ渡す
   */
  speechSlot?: React.ReactNode;
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

/** 産出カードの目印 */
function ProdBadge() {
  return <span className="chip mb-3 bg-brand-blue/10 text-brand-blue">✍ 和 → 葡</span>;
}

/** 採点の見出し（クイズの入力式と同じ言い方） */
function verdictOf(a: ProdAnswer): { label: string; cls: string } {
  if (!a.result) return { label: "わからない", cls: "text-slate-500" };
  switch (a.result.grade) {
    case "exact":
      return { label: "正解！", cls: "text-emerald-600" };
    case "accent":
      return { label: "惜しい！アクセント記号", cls: "text-amber-600" };
    case "typo":
      return { label: "惜しい！つづり", cls: "text-amber-600" };
    case "wrong":
      return { label: "不正解", cls: "text-rose-600" };
  }
}

/** 裏面: 入力した答えの採点（差分・注記・同じ意味の別見出し）と評価のめやす */
function AnswerVerdict({ word, answer }: { word: Word; answer: ProdAnswer }) {
  const v = verdictOf(answer);
  const r = answer.result;
  const synonym = !!r && r.grade !== "wrong" && !!r.expected && !isOwnAnswer(word, r.expected);
  const speech = answer.via === "speech";
  return (
    <div className="mt-4 w-full space-y-1.5 rounded-lg bg-slate-50 p-3 text-left" aria-live="polite">
      <div className={`font-bold ${v.cls}`}>{v.label}</div>
      {/* 音声で答えたときは、正解でも聞き取った文字を見せる（アクセント記号の違いは数えない） */}
      {speech && r?.grade === "exact" && (
        <div className="text-xs text-slate-500">
          🎤 聞き取り: 「<span className="font-medium text-brand-ink">{answer.input}</span>」
        </div>
      )}
      {r && r.grade !== "exact" && (
        <div className="space-y-1">
          <div className="text-xs text-slate-400">{speech ? "🎤 聞き取った言葉" : "あなたの答え"}</div>
          {r.grade === "wrong" && !r.note ? (
            <div className="break-all text-lg text-rose-600 line-through">{answer.input}</div>
          ) : (
            <>
              <DiffView diff={r.diff} />
              <div className="text-[11px] text-slate-400">赤の取り消し線＝余分な文字、緑＝足りない文字</div>
            </>
          )}
          {r.note && <div className="text-sm text-slate-600">{r.note}</div>}
        </div>
      )}
      {synonym && r && <p className="text-xs text-slate-500">「{r.expected}」（同じ意味の別の見出し）として採点しました。</p>}
      {speech && <p className="text-[11px] text-slate-400">音声認識の結果で採点しました（アクセント記号の違いは数えません）。</p>}
      <p className="text-xs text-slate-500">
        評価のめやす: <span className="font-bold text-brand-ink">{RATING_LABEL[answer.suggested]}</span>（下のボタンで自分で選べます）
      </p>
    </div>
  );
}

/** 和訳の下の品詞とカテゴリ */
function PosLine({ word }: { word: Word }) {
  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
      <span className="chip bg-slate-100 text-slate-500">{word.pos}</span>
      {word.category && <span className="text-[11px] text-slate-400">{word.category}</span>}
    </div>
  );
}

/**
 * 産出カード（和→葡）の表面: 日本語（和訳の読みを外したもの。解説は出さない）・品詞・カテゴリ。
 * 言ってから「答えを見る」（自己評価）か、「✍ 入力して答える」で入力して採点する。
 * 入力欄は答え方の既定が type なら最初から開く。Enter は入力欄の答え合わせだけに使う
 * （ReviewSession のキー操作は入力欄の中では反応しない）。
 */
function ProductionFront({
  word,
  answerMode,
  onReveal,
  onAnswer,
  speechSlot,
}: Pick<Props, "word" | "answerMode" | "onReveal" | "onAnswer" | "speechSlot">) {
  const [typing, setTyping] = useState(answerMode === "type");
  const [draft, setDraft] = useState("");
  const submit = () => {
    if (!draft.trim()) return;
    onAnswer?.(draft);
  };
  // 入力中は表面を低くして、入力欄とアクセントバーがキーボードの上に収まるようにする
  const box = `card flex flex-col items-center justify-center p-6 animate-pop ${typing ? "min-h-[22vh]" : "min-h-[45vh]"}`;
  return (
    <div>
      <div
        className={typing ? box : `${box} cursor-pointer select-none`}
        onClick={typing ? undefined : onReveal}
        role={typing ? undefined : "button"}
        tabIndex={typing ? undefined : -1}
        aria-label={typing ? undefined : "答えを見る"}
      >
        <ProdBadge />
        <div className="text-center text-3xl font-bold leading-snug text-brand-ink">{word.ja}</div>
        <PosLine word={word} />
        <p className="mt-6 text-center text-xs text-slate-400">
          ポルトガル語で言ってみよう{typing ? "（入力して答え合わせ）" : "。言えたら「答えを見る」"}
        </p>
      </div>
      {typing && (
        <div className="card mt-3 space-y-2 p-3">
          <PtInput
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            autoFocus
            placeholder="ポルトガル語で入力…"
            aria-label="答え（ポルトガル語）"
          />
          <div className="flex gap-2">
            <button type="button" onClick={submit} disabled={!draft.trim()} className="btn-primary min-h-11 flex-1">
              答え合わせ
            </button>
            <button type="button" onClick={() => onAnswer?.(null)} className="btn-ghost min-h-11 px-4 text-sm">
              わからない
            </button>
          </div>
        </div>
      )}
      {!typing && (
        <div className="mt-3 flex justify-center">
          <button type="button" onClick={() => setTyping(true)} className="btn-ghost min-h-11 text-sm">
            ✍ 入力して答える
          </button>
        </div>
      )}
      {/* 🎤 言ってみる（音声認識。設定でオンのときだけ ReviewSession が渡す） */}
      {speechSlot && <div className="mt-3">{speechSlot}</div>}
    </div>
  );
}

/** 産出カードの裏面: 問い（日本語）・採点（入力したとき）・答え（葡・カナ/IPA・音声）・解説・活用表・例文 */
function ProductionBack({
  word,
  answer,
  showKana,
  showIpa,
  card,
  today,
}: Pick<Props, "word" | "answer" | "showKana" | "showIpa" | "card" | "today">) {
  return (
    <div className="card flex min-h-[45vh] flex-col items-center justify-center p-6 animate-pop">
      <ProdBadge />
      <div className="text-center text-lg font-bold text-slate-600">{word.ja}</div>
      <PosLine word={word} />
      {answer && <AnswerVerdict word={word} answer={answer} />}
      <div className="mt-4 w-full border-t border-dashed border-slate-200 pt-4">
        <PtBlock word={word} showKana={showKana} showIpa={showIpa} big />
      </div>
      <NoteToggle word={word} />
      <ConjugationTable pt={word.pt} pos={word.pos} />
      <ExampleBlock word={word} />
      <NotDueNote card={card} today={today} />
    </div>
  );
}

/**
 * 1枚ずつ学習のカード本体（表・裏・紹介）。
 * 操作ボタン（答えを見る・評価）は親（ReviewSession）の親指ゾーンに置く。
 * dir="prod" は和→葡の産出カード（紹介は無く、表は日本語・答えはポルトガル語）。
 */
export default function ReviewCard(props: Props) {
  const { word, kind, phase, direction, showKana, showIpa, card, today, onReveal, dir } = props;
  const box = "card flex min-h-[45vh] flex-col items-center justify-center p-6 animate-pop";

  if (dir === "prod") {
    return phase === "front" ? <ProductionFront {...props} /> : <ProductionBack {...props} />;
  }

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
      {/* 動詞は活用表（折りたたみ・自動生成） */}
      <ConjugationTable pt={word.pt} pos={word.pos} />
      <ExampleBlock word={word} />
      <NotDueNote card={card} today={today} />
    </div>
  );
}
