// ============================================================================
// AI 先生の発言を出す。返事は format.ts の parseTeacherText で段落・箇条書き・太字・例文カードに分け、
// すべて React の文字として出す（HTML として差し込まない。API キーが localStorage にあるため）。
// 例文カード（🇧🇷 / 🇯🇵 の組）: ポルトガル語・カナ（設定の「カナを表示」）・読み上げ・日本語の意味
// ============================================================================

import { memo, useMemo } from "react";
import { parseTeacherText, type Span, type TeacherBlock } from "../../services/ai/format";
import { aiModelLabel } from "../../services/ai";
import { toKana } from "../../services/pronunciation";
import { useSettings } from "../../store/useSettings";
import SpeakerButton from "../SpeakerButton";
import { MediaIcon, TeacherAvatar } from "../icons";

function Spans({ spans }: { spans: Span[] }) {
  return (
    <>
      {spans.map((s, i) =>
        s.b ? (
          <strong key={i} className="font-bold text-brand-ink">
            {s.text}
          </strong>
        ) : s.i ? (
          <em key={i}>{s.text}</em>
        ) : s.code ? (
          <code key={i} className="rounded bg-slate-100 px-1 font-mono text-[0.9em]">
            {s.text}
          </code>
        ) : (
          <span key={i}>{s.text}</span>
        )
      )}
    </>
  );
}

function ExampleCard({ pt, ja }: { pt: string; ja: string | null }) {
  const showKana = useSettings((s) => s.showKana);
  const kana = useMemo(() => (showKana ? toKana(pt) : ""), [pt, showKana]);
  return (
    <div className="flex items-start gap-1 rounded-xl bg-emerald-50/70 py-1.5 pl-3 pr-1 ring-1 ring-emerald-100">
      <div className="min-w-0 flex-1 py-1">
        <div className="text-[15px] font-medium leading-snug text-brand-ink" lang="pt-BR">
          {pt}
        </div>
        {kana && <div className="text-[11px] leading-snug text-slate-400">{kana}</div>}
        {ja && <div className="mt-0.5 text-[13px] leading-snug text-slate-600">{ja}</div>}
      </div>
      <SpeakerButton text={pt} size={18} title="例文を再生" className="h-11 w-11 shrink-0" />
    </div>
  );
}

function Block({ b }: { b: TeacherBlock }) {
  switch (b.kind) {
    case "p":
      return (
        <p className="leading-relaxed">
          {b.lines.map((l, i) => (
            <span key={i}>
              {i > 0 && <br />}
              <Spans spans={l} />
            </span>
          ))}
        </p>
      );
    case "h":
      return (
        <p className="pt-1 font-bold text-brand-ink">
          <Spans spans={b.spans} />
        </p>
      );
    case "ul":
      return (
        <ul className="list-disc space-y-0.5 pl-5 leading-relaxed">
          {b.items.map((it, i) => (
            <li key={i}>
              <Spans spans={it} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol start={b.start} className="list-decimal space-y-0.5 pl-5 leading-relaxed">
          {b.items.map((it, i) => (
            <li key={i}>
              <Spans spans={it} />
            </li>
          ))}
        </ol>
      );
    case "example":
      return <ExampleCard pt={b.pt} ja={b.ja} />;
  }
}

/** 先生の返事の本文（受信中の途中の文でもよい） */
export const TeacherAnswer = memo(function TeacherAnswer({ text }: { text: string }) {
  const blocks = useMemo(() => parseTeacherText(text), [text]);
  return (
    <div className="space-y-2 text-[15px] text-slate-700">
      {blocks.map((b, i) => (
        <Block key={i} b={b} />
      ))}
    </div>
  );
});

interface Props {
  role: "user" | "assistant";
  text: string;
  model?: string;
  stopped?: boolean;
}

/** 1つの発言（学習者の質問は右、先生の返事は左） */
const TeacherMessage = memo(function TeacherMessage({ role, text, model, stopped }: Props) {
  if (role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-green px-3.5 py-2 text-[15px] leading-relaxed text-white">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      <TeacherAvatar className="mt-1" />
      <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-slate-50 px-3.5 py-2.5 ring-1 ring-slate-100">
        <TeacherAnswer text={text} />
        {(stopped || model) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-x-0.5 text-[10px] text-slate-400">
            {stopped && (
              <>
                <MediaIcon kind="stop" size={8} />
                途中で停止しました
              </>
            )}
            {stopped && model ? "・" : ""}
            {model ? aiModelLabel(model) : ""}
          </div>
        )}
      </div>
    </div>
  );
});

export default TeacherMessage;
