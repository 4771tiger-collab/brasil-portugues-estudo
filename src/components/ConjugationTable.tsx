import { useMemo, useState } from "react";
import { getConjugator, irregularTable } from "../data/conjugator";
import { useSequencePlayer } from "../hooks/useSequencePlayer";
import {
  PERSON_LABEL,
  REFLEXIVE_PRONOUN,
  TABLE_PERSONS,
  TENSE_PT,
  TENSE_SHORT,
  buildConjugationTable,
  verbHead,
  withSubject,
  type TablePerson,
  type VerbHead,
} from "../services/verbTable";

interface Props {
  pt: string;
  pos: string;
  /** 「活用表」ボタンの位置（1枚ずつのカードは中央、一覧のカードは左） */
  align?: "center" | "start";
  /** 最初から開いておく（既定は閉じた状態） */
  defaultOpen?: boolean;
}

/** 表の中の並び（左に単数・右に複数: eu | nós / você・ele | vocês・eles） */
const GRID_ORDER: readonly TablePerson[] = [0, 3, 2, 5];

/** 表を開いたときだけ作る中身（読み上げのフックもここで持つ） */
function TableBody({ head }: { head: VerbHead }) {
  const data = useMemo(() => buildConjugationTable(getConjugator(), irregularTable(), head.inf), [head.inf]);
  // どの読み上げも前の読み上げを止めてから始める。表を閉じる・画面を離れると止まる
  const player = useSequencePlayer();

  /** 活用形を主語つきで読む（同じ形をもう一度押すと止める） */
  function play(e: React.MouseEvent, text: string, idx: number) {
    e.stopPropagation();
    if (player.activeIdx === idx) {
      player.stop();
      return;
    }
    void player.playOne(text, idx);
  }

  const cell = (label: string, prefix: string, form: string, text: string, idx: number) => {
    const active = player.activeIdx === idx;
    return (
      <button
        key={idx}
        type="button"
        onClick={(e) => play(e, text, idx)}
        aria-label={`${label} ${form} を再生`}
        aria-pressed={active}
        className={`min-h-11 rounded-md px-2 py-1 text-left transition active:bg-slate-100 ${
          active ? "bg-brand-green/10 ring-1 ring-brand-green/40" : ""
        }`}
      >
        <span className="block text-[10px] leading-tight text-slate-400">{label}</span>
        <span className="block break-all text-sm font-medium leading-snug text-brand-ink">
          {prefix && <span className="font-normal text-slate-400">{prefix} </span>}
          {form}
        </span>
      </button>
    );
  };

  const presEu = data.rows[0].forms[0];
  return (
    <div className="w-full space-y-2 rounded-lg bg-slate-50 p-3 text-left" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-bold text-brand-ink">{data.inf}</span>
        {data.irregular && <span className="chip bg-rose-50 text-rose-600">不規則</span>}
        {data.like && <span className="text-[11px] text-slate-400">{data.like} と同じ活用</span>}
        <span className="chip ml-auto bg-slate-200/70 text-slate-500">自動生成</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {data.rows.map((row, ri) => (
          <div key={row.tense} className="rounded-lg bg-white p-2 ring-1 ring-slate-100">
            <div className="flex flex-wrap items-baseline gap-x-1.5 px-1">
              <span className="text-xs font-bold text-slate-600">{TENSE_SHORT[row.tense]}</span>
              <span className="text-[10px] text-slate-400">{TENSE_PT[row.tense]}</span>
            </div>
            <div className="mt-0.5 grid grid-cols-2 gap-x-1">
              {GRID_ORDER.map((p) => {
                const form = row.forms[TABLE_PERSONS.indexOf(p)];
                const idx = ri * TABLE_PERSONS.length + TABLE_PERSONS.indexOf(p);
                return cell(PERSON_LABEL[p], head.reflexive ? REFLEXIVE_PRONOUN[p] : "", form, withSubject(form, p, head.reflexive), idx);
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-1 rounded-lg bg-white p-2 ring-1 ring-slate-100">
        {cell("現在分詞 gerúndio", "", data.ger, data.ger, 100)}
        {cell("過去分詞 particípio", "", data.pp.join(" / "), data.pp.join(", "), 101)}
      </div>
      {head.reflexive && (
        <p className="text-[11px] leading-relaxed text-slate-500">
          再帰動詞: 主語に合わせて me・se・nos・se を活用形の前に置きます（例: {withSubject(presEu, 0, true)}）。
        </p>
      )}
      <p className="text-[11px] leading-relaxed text-slate-400">
        規則と不規則動詞の表から自動で作った活用です（まれに誤りがあります）。タップで主語と一緒に発音します。
      </p>
    </div>
  );
}

/**
 * 動詞の活用表（折りたたみ。開いたときだけ作る）。
 * 品詞が「動詞」で、見出しが1語の不定詞の語だけに出す（それ以外は何も描かない）。
 * 人称は eu / você・ele・a gente / nós / vocês・eles、時制は現在・完了過去・不完了過去・未来と、現在分詞・過去分詞。
 */
export default function ConjugationTable({ pt, pos, align = "center", defaultOpen = false }: Props) {
  const head = useMemo(() => verbHead(pt, pos, irregularTable()), [pt, pos]);
  const [open, setOpen] = useState(defaultOpen);
  if (!head) return null;
  return (
    <div className={`flex w-full flex-col ${align === "center" ? "mt-3 items-center" : "mt-1 items-start"}`}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className={`min-h-11 text-xs font-medium text-brand-blue ${align === "center" ? "px-3" : "pr-3"}`}
      >
        {open ? "活用表を隠す" : "活用表"}
      </button>
      {open && <TableBody head={head} />}
    </div>
  );
}
