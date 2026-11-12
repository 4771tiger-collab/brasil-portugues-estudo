import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { Check, Ear, Keyboard, Languages, Lightbulb, Mic, Plus, RotateCcw, Send, Snail, Volume2, X } from "lucide-react";
import { LESSON_BY_ID } from "../../data/course";
import { useAiProvider } from "../../hooks/useAiProvider";
import { useBack } from "../../hooks/useBack";
import { useImmersive } from "../../hooks/useImmersive";
import { useActivityTimer, useVisibleStopwatch } from "../../hooks/useActivityTimer";
import { useOnline } from "../../hooks/useOnline";
import { AiError, aiModelLabel } from "../../services/ai";
import { audio } from "../../services/audio";
import { translateText } from "../../services/translate";
import {
  FREE_TOPICS,
  TALK_INPUT_MAX,
  TALK_LEVELS,
  customScenario,
  defaultTalkLevel,
  lessonScenario,
  requestHowToSay,
  requestTalkReply,
  type HowToSay,
  type TalkFeedback,
  type TalkHint,
  type TalkLevel,
  type TalkScenario,
  type TalkTurn,
} from "../../speak/talk";
import { useProgress } from "../../store/useProgress";
import { useSettings } from "../../store/useSettings";
import { useSpeak } from "../../store/useSpeak";
import { samePhraseText } from "../../speak/speakData";
import PtInput from "../../components/PtInput";
import AiSetupCard from "../../components/speak/AiSetupCard";
import MicButton, { micSupported } from "../../components/speak/MicButton";
import NextMenu from "../../components/speak/NextMenu";
import { speakPt } from "../../components/speak/speakPt";

/** 自由に話すときの聞き取りの上限（文の採点より長め） */
const TALK_LISTEN_MS = 15000;

/** 場面を ID から引く（自分で書いた場面は location.state.scene） */
function useScenario(): TalkScenario | null {
  const { id = "" } = useParams();
  const location = useLocation();
  return useMemo(() => {
    const lesson = LESSON_BY_ID.get(id);
    if (lesson) return lessonScenario(lesson);
    const free = FREE_TOPICS.find((t) => t.id === id);
    if (free) return free;
    const scene = (location.state as { scene?: unknown } | null)?.scene;
    if (id === "custom" && typeof scene === "string" && scene.trim()) return customScenario(scene);
    return null;
  }, [id, location.state]);
}

/** 相手の最初のひとことの訳（レッスンの会話に同じ行があれば、その訳） */
function openerJa(sc: TalkScenario): string {
  return LESSON_BY_ID.get(sc.id)?.lines.find((l) => l.pt === sc.opener)?.ja ?? "";
}

export default function TalkSession() {
  const sc = useScenario();
  const { provider } = useAiProvider();
  const back = useBack("/talk");
  /** 「もう一度話す」で会話を作り直すための番号 */
  const [round, setRound] = useState(0);
  if (!sc) {
    return (
      <div className="card space-y-3 p-6 text-center">
        <p className="text-sm text-slate-500">この場面は見つかりませんでした。</p>
        <Link to="/talk" replace className="btn-primary">
          会話の一覧へ
        </Link>
      </div>
    );
  }
  if (!provider) {
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <button type="button" onClick={back} className="flex min-h-11 items-center text-sm font-semibold text-brand-green">
          ‹ 戻る
        </button>
        <AiSetupCard />
      </div>
    );
  }
  // 場面が替わったら、会話ごと作り直す
  return <Conversation key={`${sc.id}:${sc.setting}:${round}`} sc={sc} onAgain={() => setRound((n) => n + 1)} />;
}

/** 直された文を「口慣らし」に足すボタン（足したら「追加済み」） */
function AddToSay({ ja, pt, note, from }: { ja: string; pt: string; note?: string; from: "talk" | "ai" }) {
  // もう足してある文（会話の途中で足した文を、ふりかえりでもう一度足さない）
  const exists = useSpeak((s) => s.phrases.some((p) => samePhraseText(p.pt, pt)));
  const [justAdded, setAdded] = useState(false);
  const added = exists || justAdded;
  if (!ja || !pt) return null;
  return (
    <button
      type="button"
      disabled={added}
      onClick={() => {
        if (useSpeak.getState().addPhrase({ ja, pt, note, from })) setAdded(true);
      }}
      className="inline-flex min-h-9 items-center gap-1 rounded-lg bg-white px-2.5 text-xs font-bold text-brand-green ring-1 ring-emerald-200 transition active:scale-95 disabled:text-slate-400 disabled:ring-slate-200"
    >
      {added ? <Check size={14} aria-hidden /> : <Plus size={14} aria-hidden />}
      {added ? "口慣らしに追加済み" : "口慣らしに追加"}
    </button>
  );
}

/** 学習者の発言へのフィードバック（自然なら ✓、直すなら自然な言い方） */
function FeedbackView({ fb }: { fb: TalkFeedback | null | undefined }) {
  if (fb === undefined) return <p className="mt-1 text-right text-[11px] text-slate-400">…</p>;
  if (fb === null) return null;
  if (fb.ok) return <p className="mt-1 text-right text-[11px] font-bold text-emerald-600">✓ 自然に伝わりました</p>;
  return (
    <div className="mt-1.5 space-y-1.5 rounded-xl bg-amber-50 p-2.5 text-left ring-1 ring-amber-200">
      <p className="text-[11px] font-bold text-amber-700">💡 こう言うと自然</p>
      <button type="button" onClick={() => void speakPt(fb.better)} className="flex w-full items-start gap-1.5 text-left">
        <Volume2 size={16} className="mt-0.5 shrink-0 text-brand-green" aria-hidden />
        <span className="font-semibold leading-snug text-brand-ink" lang="pt-BR">
          {fb.better}
        </span>
      </button>
      {fb.ja && <p className="text-xs text-slate-600">{fb.ja}</p>}
      {fb.note && <p className="text-xs leading-relaxed text-slate-500">{fb.note}</p>}
      <AddToSay ja={fb.ja} pt={fb.better} note={fb.note} from="talk" />
    </div>
  );
}

/** 相手（AI）の吹き出し: 読み上げ・ゆっくり・訳。hide のときはタップするまで文字を出さない（耳で聞く練習） */
function AiBubble({ turn, role, hide, onJa }: { turn: Extract<TalkTurn, { who: "ai" }>; role: string; hide: boolean; onJa: () => Promise<string> }) {
  // 「耳だけ」を切ったら、隠していた吹き出しも出す（タップで出した吹き出しは、出したまま）
  const [revealed, setShown] = useState(false);
  const shown = !hide || revealed;
  const [ja, setJa] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function toggleJa() {
    if (ja !== null) return setJa(null);
    if (turn.ja) return setJa(turn.ja);
    setLoading(true);
    try {
      setJa((await onJa()) || "（訳を取得できませんでした）");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[88%]">
        <div className="mb-0.5 px-1 text-[11px] font-bold text-slate-500">{role}</div>
        <div className="rounded-2xl rounded-tl-md bg-white px-3.5 py-2.5 shadow-sm ring-1 ring-slate-200">
          {shown ? (
            <p className="font-semibold leading-snug text-brand-ink" lang="pt-BR">
              {turn.pt}
            </p>
          ) : (
            <button type="button" onClick={() => setShown(true)} className="flex min-h-9 items-center gap-2 text-sm text-slate-500">
              <Ear size={18} className="text-brand-green" aria-hidden />
              耳で聞こう（タップで文字）
            </button>
          )}
          {ja !== null && <p className="mt-1 text-xs leading-relaxed text-slate-500">{ja}</p>}
          <div className="-mb-1 -ml-1.5 mt-1 flex items-center gap-0.5 text-slate-500">
            <button type="button" onClick={() => void speakPt(turn.pt)} aria-label="もう一度聞く" className="flex h-9 w-9 items-center justify-center rounded-full text-brand-green active:scale-90">
              <Volume2 size={18} aria-hidden />
            </button>
            <button type="button" onClick={() => void speakPt(turn.pt, { slow: true })} aria-label="ゆっくり聞く" className="flex h-9 w-9 items-center justify-center rounded-full active:scale-90">
              <Snail size={18} aria-hidden />
            </button>
            <button type="button" onClick={() => void toggleJa()} disabled={loading} className="flex h-9 items-center gap-1 rounded-full px-2 text-xs font-semibold active:scale-95">
              <Languages size={16} aria-hidden />
              {loading ? "…" : ja !== null ? "訳を隠す" : "訳"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Conversation({ sc, onAgain }: { sc: TalkScenario; onAgain: () => void }) {
  const { provider } = useAiProvider();
  const back = useBack("/talk");
  const online = useOnline();
  const autoSpeak = useSettings((s) => s.talkAutoSpeak);
  const levelSetting = useSettings((s) => s.talkLevel);
  const lessonsDone = useSpeak((s) => Object.values(s.lessons).filter((l) => l.doneAt).length);
  const level: TalkLevel = (TALK_LEVELS as readonly number[]).includes(levelSetting) ? (levelSetting as TalkLevel) : defaultTalkLevel(lessonsDone);

  const [turns, setTurns] = useState<TalkTurn[]>(() => (sc.opener ? [{ who: "ai", pt: sc.opener, ja: openerJa(sc) }] : []));
  const [done, setDone] = useState<number[]>([]);
  const [hints, setHints] = useState<TalkHint[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  /** AI が「会話が一区切りついた」と返した */
  const [ended, setEnded] = useState(false);
  /** ふりかえりの画面 */
  const [finished, setFinished] = useState(false);
  const [draft, setDraft] = useState("");
  const [typing, setTyping] = useState(!micSupported());
  const [panel, setPanel] = useState<null | "hints" | "say">(null);
  const [hideText, setHideText] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const endRef = useRef<HTMLDivElement>(null);
  const lap = useVisibleStopwatch();
  const loggedRef = useRef(false);
  const myTurns = turns.filter((t) => t.who === "me").length;

  useImmersive(!finished);
  useActivityTimer("talk", !finished);

  /** 会話の記録（回数と秒数だけ）を1回だけ残す */
  const logOnce = useCallback(() => {
    if (loggedRef.current) return;
    const n = turnsRef.current.filter((t) => t.who === "me").length;
    if (!n) return;
    loggedRef.current = true;
    useSpeak.getState().logTalk({ id: sc.id, turns: n, sec: lap(3600) });
  }, [sc.id, lap]);

  const ask = useCallback(
    async (history: TalkTurn[]) => {
      if (!provider) return;
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setBusy(true);
      setError(null);
      try {
        const r = await requestTalkReply(provider, sc, level, history, ctrl.signal);
        if (ctrl.signal.aborted) return;
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.who === "me") next[next.length - 1] = { ...last, feedback: r.feedback };
          next.push({ who: "ai", pt: r.reply, ja: r.replyJa });
          return next;
        });
        setDone((d) => [...new Set([...d, ...r.missionsDone])].sort((a, b) => a - b));
        setHints(r.hints);
        setModel(r.model);
        if (r.end) setEnded(true);
        if (autoSpeak) void speakPt(r.reply);
      } catch (e) {
        if (ctrl.signal.aborted || (e instanceof AiError && e.kind === "aborted")) return;
        setError(e instanceof AiError ? e.message : "AIの返事を受け取れませんでした。もう一度お試しください");
      } finally {
        if (ctrlRef.current === ctrl) {
          ctrlRef.current = null;
          setBusy(false);
        }
      }
    },
    [provider, sc, level, autoSpeak]
  );

  // 始まり: 最初のひとことを読み上げる（無ければ AI に始めてもらう）。離れるときは通信と読み上げを止め、記録を残す
  useEffect(() => {
    if (sc.opener) {
      if (autoSpeak) void speakPt(sc.opener);
    } else void ask([]);
    return () => {
      ctrlRef.current?.abort();
      audio.cancel();
      logOnce();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, busy, error, panel, draft === ""]);

  function send(text = draft) {
    const t = text.replace(/\s+/g, " ").trim().slice(0, TALK_INPUT_MAX);
    if (!t || busy) return;
    audio.cancel();
    setDraft("");
    setPanel(null);
    // 返事をもらえなかった前の発言（エラーのあと、再試行せずに言い直したとき）は「フィードバックなし」にして、待ちの表示を残さない
    const earlier = turnsRef.current.map((x) => (x.who === "me" && x.feedback === undefined ? { ...x, feedback: null } : x));
    const next: TalkTurn[] = [...earlier, { who: "me", text: t }];
    setTurns(next);
    // 話した回数は、発言のたびに学習ログへ（画面を閉じても残る。学習日にも数える）
    useProgress.getState().logActivity("talk", 1, 0);
    void ask(next);
  }

  function finish() {
    ctrlRef.current?.abort();
    audio.cancel();
    logOnce();
    setFinished(true);
    window.scrollTo({ top: 0 });
  }

  if (finished) return <Summary sc={sc} turns={turns} done={done} onAgain={onAgain} />;

  const lastAi = [...turns].reverse().find((t) => t.who === "ai");
  return (
    <div className="mx-auto max-w-xl space-y-3 pb-64">
      {/* 見出し: 場面・ミッション */}
      <div className="flex items-start gap-1">
        <button type="button" onClick={back} aria-label="会話をやめる" className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 active:scale-90">
          <X size={22} aria-hidden />
        </button>
        <div className="min-w-0 flex-1 pt-1">
          <h1 className="truncate text-base font-bold text-brand-ink">{sc.title}</h1>
          <p className="text-xs leading-relaxed text-slate-500">{sc.setting}</p>
        </div>
        <button
          type="button"
          onClick={() => setHideText((v) => !v)}
          aria-pressed={hideText}
          title="相手の文字を隠して、耳で聞く"
          className={`flex h-11 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-bold ${hideText ? "bg-brand-green text-white" : "text-slate-500"}`}
        >
          <Ear size={16} aria-hidden />
          耳だけ
        </button>
        <button type="button" onClick={finish} disabled={myTurns === 0} className="h-11 shrink-0 rounded-full px-3 text-xs font-bold text-brand-blue disabled:text-slate-300">
          終える
        </button>
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label="この会話でやること">
        {sc.missions.map((m, i) => (
          <li key={m} className={`chip gap-1 px-2.5 py-1 ${done.includes(i) ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
            {done.includes(i) ? <Check size={12} strokeWidth={3} aria-hidden /> : <span className="h-1.5 w-1.5 rounded-full bg-slate-300" aria-hidden />}
            {m}
          </li>
        ))}
      </ul>

      {/* 会話 */}
      <div className="space-y-3" aria-live="polite">
        {turns.map((t, i) =>
          t.who === "ai" ? (
            <AiBubble key={i} turn={t} role={sc.role} hide={hideText} onJa={() => translateText(t.pt).catch(() => "")} />
          ) : (
            <div key={i} className="flex justify-end">
              <div className="max-w-[88%]">
                <div className="rounded-2xl rounded-tr-md bg-emerald-50 px-3.5 py-2.5 shadow-sm ring-1 ring-emerald-200">
                  <p className="leading-snug text-brand-ink" lang="pt-BR">
                    {t.text}
                  </p>
                </div>
                <FeedbackView fb={i === turns.length - 1 && error ? null : t.feedback} />
              </div>
            </div>
          )
        )}
        {busy && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-tl-md bg-white px-4 py-3 text-slate-400 shadow-sm ring-1 ring-slate-200" aria-label="相手が返事を考えています">
              <span className="inline-flex gap-1">
                <span className="h-2 w-2 animate-bounce rounded-full bg-slate-300" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-slate-300 [animation-delay:120ms]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-slate-300 [animation-delay:240ms]" />
              </span>
            </div>
          </div>
        )}
        {error && (
          <div role="alert" className="space-y-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-600">
            <p>{error}</p>
            <button type="button" onClick={() => void ask(turnsRef.current)} className="btn-ghost min-h-11 text-sm">
              <RotateCcw size={16} aria-hidden />
              再試行
            </button>
          </div>
        )}
        {ended && !busy && (
          <div className="space-y-2 rounded-xl bg-brand-green/5 p-3 text-center">
            <p className="text-sm font-bold text-emerald-700">会話が一区切りつきました 🎉</p>
            <button type="button" onClick={finish} className="btn-primary min-h-12 w-full">
              ふりかえりを見る
            </button>
            <p className="text-xs text-slate-500">このまま話を続けることもできます。</p>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* 入力（画面の下に固定） */}
      <div className="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-2xl border-t border-slate-200 bg-white/95 px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 backdrop-blur">
        <div className="mx-auto max-w-xl space-y-2">
          {panel === "hints" && (
            <div className="space-y-1.5 rounded-xl bg-amber-50 p-2.5">
              <p className="text-[11px] font-bold text-amber-700">たとえば、こう言えます（タップで聞く → 自分の声で言ってみよう）</p>
              {hints.length ? (
                hints.map((h) => (
                  <div key={h.pt} className="flex items-center gap-2">
                    <button type="button" onClick={() => void speakPt(h.pt)} className="min-w-0 flex-1 rounded-lg bg-white px-2.5 py-1.5 text-left ring-1 ring-amber-200">
                      <span className="block text-sm font-semibold text-brand-ink" lang="pt-BR">
                        {h.pt}
                      </span>
                      <span className="block text-xs text-slate-500">{h.ja}</span>
                    </button>
                    <button type="button" onClick={() => setDraft(h.pt)} className="h-11 shrink-0 rounded-lg px-2 text-xs font-bold text-brand-blue">
                      入力
                    </button>
                  </div>
                ))
              ) : (
                <p className="text-xs text-slate-500">相手の次の返事のあとに、返事の例が出ます。今は「なんて言う？」を使ってください。</p>
              )}
            </div>
          )}
          {panel === "say" && provider && <HowToSayPanel provider={provider} context={`${sc.setting}／相手の直前のセリフ: ${lastAi?.pt ?? ""}`} onUse={(pt) => setDraft(pt)} />}

          {draft || typing ? (
            <div className="space-y-1.5">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <PtInput value={draft} onChange={setDraft} onSubmit={() => send()} multiline rows={2} accentBar={typing} placeholder="ポルトガル語で入力…" aria-label="あなたの発言" />
                </div>
                <button type="button" onClick={() => send()} disabled={!draft.trim() || busy || !online} aria-label="送る" className="btn-primary h-12 w-12 shrink-0 px-0">
                  <Send size={20} aria-hidden />
                </button>
              </div>
              {!typing && <p className="text-[11px] text-slate-400">聞き取った文です。違っていたら直すか、🎤 で言い直してください。</p>}
            </div>
          ) : null}

          {/* 🎤（聞き取り中の文字・マイクの案内・エラーをボタンの下に出すので、横幅いっぱいに置く） */}
          {micSupported() && !typing && (
            <MicButton size="md" disabled={busy} timeoutMs={TALK_LISTEN_MS} onResult={(r) => setDraft(r.transcripts[0] ?? "")} hint={draft ? "言い直すときは、もう一度押す" : "押して話す（ポルトガル語で）"} />
          )}

          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPanel((p) => (p === "hints" ? null : "hints"))} aria-pressed={panel === "hints"} className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-xl bg-slate-100 text-xs font-bold text-slate-600">
              <Lightbulb size={16} className="text-amber-500" aria-hidden />
              ヒント
            </button>
            <button type="button" onClick={() => setPanel((p) => (p === "say" ? null : "say"))} aria-pressed={panel === "say"} className="flex min-h-11 flex-1 items-center justify-center gap-1 rounded-xl bg-slate-100 text-xs font-bold text-slate-600">
              <Languages size={16} className="text-brand-blue" aria-hidden />
              なんて言う？
            </button>
            {micSupported() && (
              <button
                type="button"
                onClick={() => setTyping((v) => !v)}
                aria-label={typing ? "マイクで話す" : "キーボードで入力する"}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-600"
              >
                {typing ? <Mic size={18} aria-hidden /> : <Keyboard size={18} aria-hidden />}
              </button>
            )}
          </div>
          <p className="text-center text-[10px] leading-snug text-slate-400">
            {!online ? "オフラインです。AI との会話はネットにつながっているときだけ使えます。" : provider?.free ? "無料枠の内容は Google の改善に使われます。個人情報は書かないでください" : "会話はこの端末から AI のサービスに直接送ります"}
            {model && online ? `（${aiModelLabel(model)}）` : ""}
          </p>
        </div>
      </div>
    </div>
  );
}

/** 「なんて言う？」: 日本語で言いたいことを書くと、自然なポルトガル語にする（言えなくて止まったとき用） */
export function HowToSayPanel({
  provider,
  context,
  onUse,
}: {
  provider: NonNullable<ReturnType<typeof useAiProvider>["provider"]>;
  context?: string;
  onUse?: (pt: string) => void;
}) {
  const [ja, setJa] = useState("");
  const [asked, setAsked] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<HowToSay | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  useEffect(() => () => ctrlRef.current?.abort(), []);

  async function run() {
    const q = ja.trim();
    if (!q || busy) return;
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      const r = await requestHowToSay(provider, q, context, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setRes(r);
      setAsked(q);
      void speakPt(r.pt);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setErr(e instanceof AiError ? e.message : "うまくいきませんでした。もう一度お試しください");
    } finally {
      if (ctrlRef.current === ctrl) setBusy(false);
    }
  }

  return (
    <div className="space-y-2 rounded-xl bg-blue-50 p-2.5">
      <p className="text-[11px] font-bold text-blue-700">言いたいことを日本語で（AI がポルトガル語にします）</p>
      <div className="flex gap-2">
        <input
          value={ja}
          onChange={(e) => setJa(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) void run();
          }}
          maxLength={200}
          placeholder="例: 辛くしないでください"
          aria-label="言いたいこと（日本語）"
          className="min-h-11 min-w-0 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-base text-brand-ink focus:border-brand-blue focus:outline-none"
        />
        <button type="button" onClick={() => void run()} disabled={!ja.trim() || busy} className="btn h-11 shrink-0 bg-brand-blue px-3 text-sm text-white">
          {busy ? "…" : "訳す"}
        </button>
      </div>
      {err && (
        <p role="alert" className="text-xs text-rose-600">
          {err}
        </p>
      )}
      {res && (
        <div className="space-y-1.5 rounded-lg bg-white p-2.5 ring-1 ring-blue-200">
          <button type="button" onClick={() => void speakPt(res.pt)} className="flex w-full items-start gap-1.5 text-left">
            <Volume2 size={16} className="mt-0.5 shrink-0 text-brand-green" aria-hidden />
            <span className="font-semibold leading-snug text-brand-ink" lang="pt-BR">
              {res.pt}
            </span>
          </button>
          {res.alt.length > 0 && (
            <p className="text-xs text-slate-500" lang="pt-BR">
              <span lang="ja">ほかの言い方: </span>
              {res.alt.join(" ／ ")}
            </p>
          )}
          {res.note && <p className="text-xs leading-relaxed text-slate-500">{res.note}</p>}
          <div className="flex flex-wrap gap-2">
            {onUse && (
              <button type="button" onClick={() => onUse(res.pt)} className="inline-flex min-h-9 items-center rounded-lg bg-brand-blue/10 px-2.5 text-xs font-bold text-brand-blue">
                入力欄に入れる
              </button>
            )}
            <AddToSay key={res.pt} ja={asked} pt={res.pt} note={res.note} from="ai" />
          </div>
        </div>
      )}
    </div>
  );
}

/** ふりかえり: 話した回数・達成したミッション・直された文（口慣らしに足せる） */
function Summary({ sc, turns, done, onAgain }: { sc: TalkScenario; turns: TalkTurn[]; done: number[]; onAgain: () => void }) {
  const mine = turns.filter((t): t is Extract<TalkTurn, { who: "me" }> => t.who === "me");
  const fixes = mine.filter((t) => t.feedback && !t.feedback.ok);
  const natural = mine.filter((t) => t.feedback?.ok).length;
  return (
    <div className="mx-auto max-w-xl animate-fade-in space-y-4">
      <div className="card space-y-3 p-6 text-center">
        <h1 className="text-xl font-bold text-brand-ink">おつかれさま！ {mine.length}回 話しました</h1>
        <p className="text-sm text-slate-500">「{sc.title}」</p>
        <div className="grid grid-cols-2 gap-2 text-center text-xs">
          <div className="rounded-lg bg-emerald-50 py-2">
            <div className="text-lg font-bold text-emerald-600">{natural}</div>
            <div className="text-slate-500">自然に伝わった発言</div>
          </div>
          <div className="rounded-lg bg-amber-50 py-2">
            <div className="text-lg font-bold text-amber-600">{fixes.length}</div>
            <div className="text-slate-500">もっと自然にできる発言</div>
          </div>
        </div>
        <ul className="space-y-1 text-left text-sm">
          {sc.missions.map((m, i) => (
            <li key={m} className={`flex items-center gap-2 ${done.includes(i) ? "text-emerald-700" : "text-slate-400"}`}>
              {done.includes(i) ? <Check size={16} strokeWidth={3} aria-hidden /> : <span className="inline-block h-4 w-4 rounded-full border-2 border-slate-300" aria-hidden />}
              {m}
            </li>
          ))}
        </ul>
      </div>

      {fixes.length > 0 && (
        <section className="space-y-2">
          <h2 className="px-1 text-sm font-bold text-slate-500">もっと自然な言い方（口慣らしに足すと、毎日の復習に出ます）</h2>
          {fixes.map((t, i) => (
            <div key={i} className="card space-y-1 p-3">
              <p className="text-xs text-slate-400">あなた: {t.text}</p>
              <FeedbackView fb={t.feedback} />
            </div>
          ))}
        </section>
      )}

      <div className="space-y-2">
        <button type="button" onClick={onAgain} className="btn-ghost min-h-12 w-full">
          <RotateCcw size={16} aria-hidden />
          この場面でもう一度話す
        </button>
        <NextMenu skip="talk" />
      </div>
    </div>
  );
}
