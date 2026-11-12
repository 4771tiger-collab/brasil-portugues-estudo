import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bot, ChevronDown, Globe, Pencil, Plus, Trash2, Volume2 } from "lucide-react";
import { UNITS } from "../../data/course";
import { useAiProvider } from "../../hooks/useAiProvider";
import { useOnline } from "../../hooks/useOnline";
import { useToday } from "../../hooks/useToday";
import { AiError } from "../../services/ai";
import { translateJaToPt } from "../../services/translate";
import { daysUntilDue } from "../../srs/scheduler";
import type { SrsCard } from "../../data/types";
import { CAN_SAY_DAYS } from "../../speak/catalog";
import { PHRASE_TEXT_MAX, USER_PHRASE_MAX, type PhraseSource, type UserPhrase } from "../../speak/speakData";
import { requestHowToSay } from "../../speak/talk";
import { useSpeak } from "../../store/useSpeak";
import PtInput from "../../components/PtInput";
import { speakPt } from "../../components/speak/speakPt";

/** カードの状態の一言（言える / 練習中・次回まで / まだ） */
function CardChip({ card, today }: { card: SrsCard | undefined; today: string }) {
  if (!card || !card.last) return <span className="chip bg-slate-100 text-slate-500">これから</span>;
  const d = daysUntilDue(card, today);
  const when = d <= 0 ? "今日" : `${d}日後`;
  return card.intervalDays >= CAN_SAY_DAYS ? (
    <span className="chip bg-emerald-100 text-emerald-700">言える・{when}</span>
  ) : (
    <span className="chip bg-amber-100 text-amber-700">練習中・{when}</span>
  );
}

/** 文を足す欄: 日本語 → （AI か機械翻訳で）ポルトガル語 → 確かめて保存 */
function AddForm() {
  const { provider } = useAiProvider();
  const online = useOnline();
  const count = useSpeak((s) => s.phrases.length);
  const addPhrase = useSpeak((s) => s.addPhrase);
  const [ja, setJa] = useState("");
  const [pt, setPt] = useState("");
  const [note, setNote] = useState("");
  const [alt, setAlt] = useState<string[]>([]);
  const [from, setFrom] = useState<PhraseSource>("manual");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  // 画面を離れたら、訳の依頼を止める（別の画面で、遅れて届いた訳を読み上げない）
  useEffect(() => () => ctrlRef.current?.abort(), []);
  const full = count >= USER_PHRASE_MAX;

  async function translate() {
    const q = ja.trim();
    if (!q || busy) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setBusy(true);
    setMsg(null);
    try {
      if (provider) {
        const r = await requestHowToSay(provider, q, undefined, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setPt(r.pt);
        setNote(r.note);
        setAlt(r.alt);
        setFrom("ai");
        void speakPt(r.pt);
      } else {
        const r = await translateJaToPt(q, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setPt(r);
        setNote("");
        setAlt([]);
        setFrom("mt");
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setMsg({ kind: "error", text: e instanceof AiError ? e.message : "訳せませんでした。もう一度お試しください" });
    } finally {
      if (ctrlRef.current === ctrl) setBusy(false);
    }
  }

  function save() {
    const id = addPhrase({ ja, pt, note: note || undefined, alt: alt.length ? alt : undefined, from });
    if (!id) return setMsg({ kind: "error", text: "保存できませんでした（日本語とポルトガル語の両方を入れてください）" });
    setJa("");
    setPt("");
    setNote("");
    setAlt([]);
    setFrom("manual");
    setMsg({ kind: "ok", text: "足しました。今日の口慣らしから出ます。" });
  }

  return (
    <section className="card space-y-3 p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-bold text-slate-500">
        <Plus size={16} className="text-brand-green" aria-hidden />
        言いたいことを足す
      </h2>
      <p className="text-xs leading-relaxed text-slate-500">
        「あのとき言えなかった」「自分のことをこう説明したい」という文を足すと、毎日の口慣らしに出てきます。自分で使う文がいちばん身につきます。
      </p>
      <textarea
        value={ja}
        onChange={(e) => setJa(e.target.value.slice(0, PHRASE_TEXT_MAX))}
        rows={2}
        placeholder="日本語で（例: 日本ではITの仕事をしていました）"
        aria-label="言いたいこと（日本語）"
        className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-base text-brand-ink focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green/25"
      />
      <button type="button" onClick={() => void translate()} disabled={!ja.trim() || busy || !online} className="btn-ghost min-h-11 w-full text-sm">
        {provider ? <Bot size={16} className="text-violet-600" aria-hidden /> : <Globe size={16} className="text-brand-blue" aria-hidden />}
        {busy ? "訳しています…" : provider ? "AI に自然なポルトガル語にしてもらう" : "機械翻訳で下書きを作る"}
      </button>
      <PtInput value={pt} onChange={(v) => setPt(v.slice(0, PHRASE_TEXT_MAX))} multiline rows={2} placeholder="ポルトガル語（自分で入力してもOK）" aria-label="ポルトガル語" />
      {from === "mt" && pt && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          ⚠ 機械翻訳の下書きです。不自然なことがあるので、確かめてから保存してください（設定で AI のキーを入れると、自然な言い方にできます）。
        </p>
      )}
      {alt.length > 0 && (
        <p className="text-xs text-slate-500" lang="pt-BR">
          <span lang="ja">ほかの言い方: </span>
          {alt.join(" ／ ")}
        </p>
      )}
      {note && <p className="text-xs leading-relaxed text-slate-500">💡 {note}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={() => void speakPt(pt)} disabled={!pt.trim()} className="btn-ghost min-h-12 px-4" aria-label="読み上げる">
          <Volume2 size={18} aria-hidden />
        </button>
        <button type="button" onClick={save} disabled={!ja.trim() || !pt.trim() || full} className="btn-primary min-h-12 flex-1">
          口慣らしに足す
        </button>
      </div>
      {full && <p className="text-xs text-rose-500">自分のフレーズは {USER_PHRASE_MAX}文までです。使わない文を消してください。</p>}
      {msg && (
        <p role={msg.kind === "error" ? "alert" : "status"} className={`text-xs ${msg.kind === "error" ? "text-rose-600" : "font-bold text-emerald-600"}`}>
          {msg.text}
        </p>
      )}
    </section>
  );
}

const FROM_LABEL: Record<PhraseSource, string> = { manual: "手入力", ai: "AI", mt: "機械翻訳", talk: "会話で直された文" };

function MyPhraseRow({ p, card, today }: { p: UserPhrase; card: SrsCard | undefined; today: string }) {
  const update = useSpeak((s) => s.updatePhrase);
  const remove = useSpeak((s) => s.removePhrase);
  const [edit, setEdit] = useState(false);
  const [ja, setJa] = useState(p.ja);
  const [pt, setPt] = useState(p.pt);
  if (edit) {
    return (
      <li className="space-y-2 p-3">
        <textarea value={ja} onChange={(e) => setJa(e.target.value.slice(0, PHRASE_TEXT_MAX))} rows={2} aria-label="日本語" className="w-full rounded-xl border border-slate-200 px-3 py-2 text-base" />
        <PtInput value={pt} onChange={(v) => setPt(v.slice(0, PHRASE_TEXT_MAX))} multiline rows={2} aria-label="ポルトガル語" />
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary min-h-11 flex-1 text-sm"
            disabled={!ja.trim() || !pt.trim()}
            onClick={() => {
              update(p.id, { ja, pt });
              setEdit(false);
            }}
          >
            保存
          </button>
          <button type="button" className="btn-ghost min-h-11 text-sm" onClick={() => setEdit(false)}>
            やめる
          </button>
          <button
            type="button"
            className="btn min-h-11 bg-rose-50 px-3 text-sm text-rose-600"
            aria-label="この文を消す"
            onClick={() => {
              if (confirm(`「${p.pt}」を消しますか？（口慣らしの記録も消えます）`)) remove(p.id);
            }}
          >
            <Trash2 size={16} aria-hidden />
          </button>
        </div>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-1 pr-1">
      <button type="button" onClick={() => void speakPt(p.pt)} className="min-w-0 flex-1 px-3 py-2.5 text-left">
        <span className="block text-xs text-slate-500">{p.ja}</span>
        <span className="block font-semibold leading-snug text-brand-ink" lang="pt-BR">
          {p.pt}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-1.5">
          <CardChip card={card} today={today} />
          <span className="text-[11px] text-slate-400">{FROM_LABEL[p.from]}</span>
        </span>
      </button>
      <button type="button" onClick={() => setEdit(true)} aria-label="編集する" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-400 active:scale-90">
        <Pencil size={16} aria-hidden />
      </button>
    </li>
  );
}

/**
 * フレーズ帳: 自分で足した文（言いたいことメモ・会話で直された文）と、レッスンの文の一覧。
 * どの文も「口慣らし」（日本語を見て → ポルトガル語を言う）に出る。タップでお手本を聞ける。
 */
export default function Phrases() {
  const today = useToday();
  const phrases = useSpeak((s) => s.phrases);
  const cards = useSpeak((s) => s.cards);
  const progress = useSpeak((s) => s.lessons);
  const [open, setOpen] = useState<string | null>(null);
  const started = useMemo(() => UNITS.map((u) => ({ u, lessons: u.lessons.filter((l) => progress[l.id] || l.phrases.some((p) => cards[p.id])) })).filter((x) => x.lessons.length), [progress, cards]);

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <h1 className="text-xl font-bold text-brand-ink">フレーズ帳</h1>
        <p className="mt-1 text-sm text-slate-500">口慣らしに出る文の一覧です。タップでお手本を聞けます。</p>
      </div>

      <AddForm />

      <section className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-slate-500">自分のフレーズ（{phrases.length}）</h2>
        {phrases.length ? (
          <ul className="card divide-y divide-slate-100 overflow-hidden">
            {phrases.map((p) => (
              <MyPhraseRow key={p.id} p={p} card={cards[p.id]} today={today} />
            ))}
          </ul>
        ) : (
          <p className="card p-4 text-sm leading-relaxed text-slate-500">まだありません。上の欄から足すか、AI との会話で直された文を「口慣らしに追加」すると、ここに並びます。</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-slate-500">レッスンのフレーズ</h2>
        {started.length ? (
          started.map(({ u, lessons }) => (
            <div key={u.id} className="card overflow-hidden">
              <p className="bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-500">
                UNIT {u.no} {u.title}
              </p>
              <ul className="divide-y divide-slate-100">
                {lessons.map((l) => (
                  <li key={l.id}>
                    <button type="button" onClick={() => setOpen((o) => (o === l.id ? null : l.id))} aria-expanded={open === l.id} className="flex min-h-12 w-full items-center gap-2 px-3 text-left">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold text-brand-ink">
                        L{l.no} {l.title}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-400">
                        {l.phrases.filter((p) => (cards[p.id]?.intervalDays ?? 0) >= CAN_SAY_DAYS).length}/{l.phrases.length} 言える
                      </span>
                      <ChevronDown size={16} className={`shrink-0 text-slate-300 transition ${open === l.id ? "rotate-180" : ""}`} aria-hidden />
                    </button>
                    {open === l.id && (
                      <ul className="divide-y divide-slate-100 border-t border-slate-100 bg-slate-50/50">
                        {l.phrases.map((p) => (
                          <li key={p.id}>
                            <button type="button" onClick={() => void speakPt(p.pt)} className="w-full px-4 py-2 text-left">
                              <span className="block text-xs text-slate-500">{p.ja}</span>
                              <span className="block font-semibold leading-snug text-brand-ink" lang="pt-BR">
                                {p.pt}
                              </span>
                              <span className="mt-1 block">
                                <CardChip card={cards[p.id]} today={today} />
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <p className="card p-4 text-sm leading-relaxed text-slate-500">
            レッスンを始めると、練習した文がここに並びます。
            <Link to="/course" className="ml-1 font-semibold text-brand-green">
              レッスンへ ›
            </Link>
          </p>
        )}
      </section>
    </div>
  );
}
