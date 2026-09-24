import { useState } from "react";
import type { Rating, SrsCard, Word } from "../data/types";
import { getExtra } from "../data/loadWords";
import { daysUntilDue } from "../srs/scheduler";
import ConjugationTable from "./ConjugationTable";
import Maskable from "./Maskable";
import SpeakerButton from "./SpeakerButton";
import RatingButtons from "./RatingButtons";

/** 一覧表示で評価した結果（表示用） */
export interface RatedInfo {
  rating: Rating;
  /** 期限前・同じ日の評価で間隔を変えなかった（scheduler.isHeld） */
  held: boolean;
  /** again で末尾にもう一度足した */
  requeued?: boolean;
}

interface Props {
  word: Word;
  ptVisible: boolean;
  jaVisible: boolean;
  showKana: boolean;
  showIpa: boolean;
  active?: boolean;
  /** 評価済みなら結果（未評価は null/undefined） */
  rated?: RatedInfo | null;
  card?: SrsCard;
  /** 表示の基準日（復習日までの日数・評価ボタンの目安） */
  today: string;
  onTogglePt: () => void;
  onToggleJa: () => void;
  onRate?: (r: Rating) => void;
}

/** 評価後の一言（据え置き・次回までの日数・もう一度） */
function RatedLabel({ rated, card, today }: { rated: RatedInfo; card?: SrsCard; today: string }) {
  const days = card ? daysUntilDue(card, today) : 0;
  let text: string;
  let cls = "text-emerald-600";
  if (rated.rating === "again") {
    text = rated.requeued ? "↻ もう一度 ・ 末尾にもう一度出します" : "↻ もう一度 ・ 今日の学習にまた出ます";
    cls = "text-rose-500";
  } else if (rated.held) {
    text = days > 0 ? `✓ 据え置き（復習日まで ${days}日）` : "✓ 据え置き";
    cls = "text-slate-500";
  } else {
    text = days > 0 ? `✓ 評価済み（次回 ${days}日後）` : "✓ 評価済み（このあと）";
  }
  return <div className={`flex items-center justify-center gap-1 py-1 text-sm font-medium ${cls}`}>{text}</div>;
}

export default function Flashcard({
  word,
  ptVisible,
  jaVisible,
  showKana,
  showIpa,
  active,
  rated,
  card,
  today,
  onTogglePt,
  onToggleJa,
  onRate,
}: Props) {
  const [openExample, setOpenExample] = useState(false);
  const [openNote, setOpenNote] = useState(false);
  const extra = getExtra(word);
  const hasExample = !!(extra?.examples?.length || extra?.collocations?.length);
  // 解説（カポエイラ語の元の訳）は読み（≒葡語）と意味の両方を含むので、葡・和の両方が見えている時だけ出す
  const showNote = !!word.note && ptVisible && jaVisible;
  const notDue = card?.last ? daysUntilDue(card, today) : 0;

  return (
    <div
      className={`card scroll-mt-24 p-4 transition ${active ? "ring-2 ring-brand-green shadow-md" : ""} ${
        rated ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Maskable visible={ptVisible} onToggle={onTogglePt} className="text-lg font-bold text-brand-ink">
              {word.pt}
            </Maskable>
            <span className="chip bg-slate-100 text-slate-500">{word.pos}</span>
          </div>
          {/* 発音ガイドは pt が見えている時のみ（暗記の妨げ防止） */}
          {ptVisible && (showKana || showIpa) && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
              {showKana && word.kana && <span>{word.kana}</span>}
              {showIpa && word.ipa && <span className="font-mono">/{word.ipa}/</span>}
            </div>
          )}
        </div>
        <SpeakerButton text={word.ptForSpeech} />
      </div>

      <div className="mt-2 border-t border-dashed border-slate-100 pt-2">
        <Maskable visible={jaVisible} onToggle={onToggleJa} className="text-slate-700">
          {word.ja}
        </Maskable>
      </div>

      {(hasExample || showNote) && (
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-x-4">
            {showNote && (
              <button
                type="button"
                onClick={() => setOpenNote((v) => !v)}
                aria-expanded={openNote}
                className="text-xs font-medium text-brand-blue"
              >
                {openNote ? "解説を隠す" : "解説"}
              </button>
            )}
            {hasExample && (
              <button
                type="button"
                onClick={() => setOpenExample((v) => !v)}
                className="text-xs font-medium text-brand-blue"
              >
                {openExample ? "例文を隠す" : "例文・コロケーション"}
              </button>
            )}
          </div>
          {showNote && openNote && (
            <div className="mt-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{word.note}</div>
          )}
          {hasExample && openExample && (
            <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3">
              {extra?.examples?.map((ex, i) => (
                <div key={i} className="text-sm">
                  <div className="flex items-center gap-1">
                    <span className="font-medium text-brand-ink">{ex.pt}</span>
                    <SpeakerButton text={ex.pt} size={16} />
                  </div>
                  {ex.kana && <div className="text-[11px] text-slate-400">{ex.kana}</div>}
                  <div className="text-xs text-slate-500">{ex.ja}</div>
                </div>
              ))}
              {extra?.collocations?.length ? (
                <div className="flex flex-wrap gap-1 pt-1">
                  {extra.collocations.map((c, i) => (
                    <span key={i} className="chip bg-white text-slate-500 ring-1 ring-slate-200">
                      {c}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {/* 動詞の活用表（折りたたみ・自動生成）。訳を開いたときに出す。
          葡語が隠れている（和→葡で思い出している）間は、活用形から答えが分かってしまうので出さない */}
      {ptVisible && jaVisible && <ConjugationTable pt={word.pt} pos={word.pos} align="start" />}

      {onRate && (
        <div className="mt-3">
          {rated ? (
            <RatedLabel rated={rated} card={card} today={today} />
          ) : (
            <>
              {/* 期限前: 今評価しても「もう一度」以外は間隔が変わらない */}
              {notDue > 0 && (
                <div className="mb-1.5 text-center text-[11px] text-slate-400">
                  復習日まで {notDue}日 ・ 今の評価は据え置き（「もう一度」だけ反映）
                </div>
              )}
              <RatingButtons card={card} onRate={onRate} size="sm" today={today} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
