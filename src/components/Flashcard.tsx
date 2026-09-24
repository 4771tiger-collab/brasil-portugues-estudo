import { useState } from "react";
import type { Rating, SrsCard, Word } from "../data/types";
import { getExtra } from "../data/loadWords";
import Maskable from "./Maskable";
import SpeakerButton from "./SpeakerButton";
import RatingButtons from "./RatingButtons";

interface Props {
  word: Word;
  ptVisible: boolean;
  jaVisible: boolean;
  showKana: boolean;
  showIpa: boolean;
  active?: boolean;
  rated?: boolean;
  card?: SrsCard;
  onTogglePt: () => void;
  onToggleJa: () => void;
  onRate?: (r: Rating) => void;
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
  onTogglePt,
  onToggleJa,
  onRate,
}: Props) {
  const [openExample, setOpenExample] = useState(false);
  const extra = getExtra(word);
  const hasExample = !!(extra?.examples?.length || extra?.collocations?.length);

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

      {hasExample && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setOpenExample((v) => !v)}
            className="text-xs font-medium text-brand-blue"
          >
            {openExample ? "例文を隠す" : "例文・コロケーション"}
          </button>
          {openExample && (
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

      {onRate && (
        <div className="mt-3">
          {rated ? (
            <div className="flex items-center justify-center gap-1 py-1 text-sm font-medium text-emerald-600">
              ✓ 評価済み（次回 {card?.intervalDays ?? 0}日後）
            </div>
          ) : (
            <RatingButtons card={card} onRate={onRate} size="sm" />
          )}
        </div>
      )}
    </div>
  );
}
