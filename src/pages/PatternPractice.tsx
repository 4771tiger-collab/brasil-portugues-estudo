import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PATTERNS } from "../data/content";
import type { Pattern } from "../data/types";
import SpeakerButton from "../components/SpeakerButton";
import { toKana } from "../services/pronunciation";

function fill(template: string, value: string): string {
  return template.replace(/\{[^}]+\}/g, value);
}

function PatternCard({ pattern }: { pattern: Pattern }) {
  const slotKey = Object.keys(pattern.slots)[0];
  const options = pattern.slots[slotKey];
  const [idx, setIdx] = useState(0);
  const [showJa, setShowJa] = useState(true);
  const opt = options[idx];

  const sentence = fill(pattern.frame, opt.pt);
  const sentenceJa = fill(pattern.ja, opt.ja);
  const kana = useMemo(() => toKana(sentence), [sentence]);

  return (
    <div className="card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <span className="chip bg-brand-blue/10 font-bold text-brand-blue">{pattern.category}</span>
        <button onClick={() => setIdx(Math.floor(Math.random() * options.length))} className="text-xs text-slate-400">
          🔀 ランダム
        </button>
      </div>

      <div className="rounded-xl bg-slate-50 p-4 text-center">
        <div className="flex items-center justify-center gap-2">
          <span className="text-xl font-bold text-brand-ink">
            {pattern.frame.split(/(\{[^}]+\})/).map((part, i) =>
              /^\{.*\}$/.test(part) ? (
                <span key={i} className="rounded bg-brand-yellow/40 px-1 text-brand-ink">
                  {opt.pt}
                </span>
              ) : (
                <span key={i}>{part}</span>
              )
            )}
          </span>
          <SpeakerButton text={sentence} />
        </div>
        <div className="mt-1 text-xs text-slate-400">{kana}</div>
        <button onClick={() => setShowJa((v) => !v)} className="mt-2 text-sm">
          {showJa ? <span className="text-slate-600">{sentenceJa}</span> : <span className="text-brand-blue">訳を表示</span>}
        </button>
      </div>

      {pattern.note && <p className="text-xs text-slate-400">💡 {pattern.note}</p>}

      <div>
        <div className="mb-1 text-xs font-medium text-slate-400">入れ替え語（タップ）</div>
        <div className="flex flex-wrap gap-1.5">
          {options.map((o, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              className={`chip ring-1 transition ${
                i === idx ? "bg-brand-green text-white ring-brand-green" : "bg-white text-slate-600 ring-slate-200"
              }`}
            >
              {o.pt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function PatternPractice() {
  return (
    <div className="animate-fade-in space-y-4">
      <Link to="/practice" className="text-sm text-brand-green">‹ 練習に戻る</Link>
      <div>
        <h1 className="text-xl font-bold text-brand-ink">パターンプラクティス</h1>
        <p className="text-sm text-slate-500">スロットの語を入れ替えて、文型を口に馴染ませよう。</p>
      </div>
      <div className="space-y-4">
        {PATTERNS.map((p) => (
          <PatternCard key={p.id} pattern={p} />
        ))}
      </div>
    </div>
  );
}
