import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowRight, Check, Eye, EyeOff, Headphones, Lightbulb, MessagesSquare, PartyPopper, RotateCcw, Snail, Volume2, X } from "lucide-react";
import { LESSON_BY_ID, nextLesson, type Lesson, type LessonLine } from "../../data/course";
import { useBack } from "../../hooks/useBack";
import { useImmersive } from "../../hooks/useImmersive";
import { useActivityTimer } from "../../hooks/useActivityTimer";
import { useWakeLock } from "../../hooks/useWakeLock";
import { useAiProvider } from "../../hooks/useAiProvider";
import { audio, delay } from "../../services/audio";
import type { SpeechSentenceScore } from "../../services/grade";
import { scoreSaid } from "../../speak/score";
import { sentenceListenTimeoutMs, type SpeechResult } from "../../services/speechInput";
import { toKana } from "../../services/pronunciation";
import { sentenceContext } from "../../services/ai/teacherContext";
import { lessonItems, lessonLabel } from "../../speak/catalog";
import { LESSON_STEPS } from "../../speak/speakData";
import { useProgress } from "../../store/useProgress";
import { useSettings } from "../../store/useSettings";
import { useSpeak } from "../../store/useSpeak";
import AskTeacherButton from "../../components/teacher/AskTeacherButton";
import KanaHint from "../../components/speak/KanaHint";
import MicButton, { micSupported } from "../../components/speak/MicButton";
import SayRunner, { type SayResult } from "../../components/speak/SayRunner";
import ScoreView from "../../components/speak/ScoreView";
import NextMenu from "../../components/speak/NextMenu";
import { PITCH_PARTNER, PITCH_YOU, speakPt, speakPtChecked } from "../../components/speak/speakPt";

const STEPS = [
  { label: "聞く", hint: "文字を見ずに、会話を聞いてみる" },
  { label: "まねる", hint: "この課の文を、お手本のすぐ後にまねて言う" },
  { label: "言う", hint: "日本語を見て、ポルトガル語で言う" },
  { label: "演じる", hint: "相手のセリフを聞いて、自分の役を言う" },
] as const;

const pitchOf = (l: LessonLine) => (l.who === "you" ? PITCH_YOU : PITCH_PARTNER);

/** 相手のセリフの読み上げが、これより短く終わったら「音声が出ていない」とみなす（ms） */
const MIN_SPOKEN_MS = 300;

/** 会話を1行ずつ順に読み上げる（役で声の高さを変える）。cur = 今読んでいる行 */
function useDialoguePlayer() {
  const ctrl = useRef<AbortController | null>(null);
  const [cur, setCur] = useState<number | null>(null);

  const stop = useCallback(() => {
    ctrl.current?.abort();
    ctrl.current = null;
    audio.cancel();
    setCur(null);
  }, []);

  /** from 行目から最後まで読む。最後まで読めたら true（止められたら false） */
  const play = useCallback(
    async (lines: readonly LessonLine[], opts: { from?: number; slow?: boolean } = {}): Promise<boolean> => {
      stop();
      const c = new AbortController();
      ctrl.current = c;
      for (let i = opts.from ?? 0; i < lines.length; i++) {
        if (c.signal.aborted) return false;
        setCur(i);
        await speakPt(lines[i].pt, { slow: opts.slow, pitch: pitchOf(lines[i]) });
        if (c.signal.aborted) return false;
        try {
          await delay(400, c.signal);
        } catch {
          return false;
        }
      }
      if (ctrl.current === c) {
        ctrl.current = null;
        setCur(null);
      }
      return true;
    },
    [stop]
  );

  useEffect(() => stop, [stop]);
  return { cur, play, stop, playing: cur !== null };
}

/** 会話の吹き出し（相手は左・自分は右） */
function Bubble({
  line,
  partner,
  active = false,
  showJa = true,
  showKana = false,
  onClick,
  children,
}: {
  line: LessonLine;
  partner: string;
  active?: boolean;
  showJa?: boolean;
  showKana?: boolean;
  onClick?: () => void;
  children?: React.ReactNode;
}) {
  const me = line.who === "you";
  return (
    <div className={`flex ${me ? "justify-end" : "justify-start"}`}>
      <div className="max-w-[88%]">
        <div className={`mb-0.5 px-1 text-[11px] font-bold ${me ? "text-right text-emerald-700" : "text-slate-500"}`}>{me ? "あなた" : partner}</div>
        <div
          role={onClick ? "button" : undefined}
          tabIndex={onClick ? 0 : undefined}
          onClick={onClick}
          onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && onClick() : undefined}
          className={`rounded-2xl px-3.5 py-2.5 text-left shadow-sm ring-1 transition ${onClick ? "cursor-pointer active:scale-[0.99]" : ""} ${
            me ? "rounded-tr-md bg-emerald-50 ring-emerald-200" : "rounded-tl-md bg-white ring-slate-200"
          } ${active ? "ring-2 ring-brand-yellow" : ""}`}
        >
          {children ?? (
            <>
              <p className="font-semibold leading-snug text-brand-ink" lang="pt-BR">
                {line.pt}
              </p>
              {showKana && <p className="mt-0.5 text-[11px] text-slate-400">{toKana(line.pt)}</p>}
              {showJa && <p className="mt-1 text-xs leading-relaxed text-slate-500">{line.ja}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ① 聞く
// ---------------------------------------------------------------------------
function ListenStep({ lesson, onNext }: { lesson: Lesson; onNext: () => void }) {
  const showKana = useSettings((s) => s.showKana);
  const player = useDialoguePlayer();
  const [heard, setHeard] = useState(0);
  const [script, setScript] = useState(false);
  const [showJa, setShowJa] = useState(true);
  useWakeLock(player.playing);

  async function listen(slow = false) {
    if (await player.play(lesson.lines, { slow })) setHeard((n) => n + 1);
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-2 p-4">
        <p className="text-sm leading-relaxed text-slate-700">🎬 {lesson.scene}</p>
        <p className="text-xs text-slate-500">
          相手: <span className="font-semibold text-slate-700">{lesson.partner}</span>
        </p>
        <p className="rounded-lg bg-brand-green/5 px-3 py-2 text-xs leading-relaxed text-emerald-800">🎯 {lesson.goal}</p>
      </section>

      <section className="card space-y-3 p-4 text-center">
        {!script && (
          <p className="text-sm leading-relaxed text-slate-500">
            {heard === 0 ? "まずは文字を見ずに。どんなやりとりか、想像しながら聞いてみよう。" : "聞き取れた言葉はありましたか？ もう一度聞くか、スクリプトで確かめよう。"}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-center gap-2">
          {player.playing ? (
            <button type="button" onClick={player.stop} className="btn-ghost min-h-12 px-5">
              ■ 止める
            </button>
          ) : (
            <>
              <button type="button" onClick={() => void listen()} className="btn-primary min-h-12 px-5">
                <Headphones size={18} aria-hidden />
                {heard ? "もう一度聞く" : "会話を聞く"}
              </button>
              <button type="button" onClick={() => void listen(true)} className="btn-ghost min-h-12 px-4 text-sm">
                <Snail size={18} aria-hidden />
                ゆっくり
              </button>
            </>
          )}
        </div>
        {player.playing && !script && player.cur !== null && (
          <p className="text-sm font-bold text-slate-600" aria-live="polite">
            🔊 {lesson.lines[player.cur].who === "you" ? "あなた" : lesson.partner}
            <span className="ml-2 text-xs font-normal tabular-nums text-slate-400">
              {player.cur + 1} / {lesson.lines.length}
            </span>
          </p>
        )}
        {!script && (
          <button type="button" onClick={() => setScript(true)} className="mx-auto flex min-h-11 items-center gap-1.5 text-sm font-semibold text-brand-blue">
            <Eye size={16} aria-hidden />
            スクリプトを見る
          </button>
        )}
      </section>

      {script && (
        <section className="space-y-2.5">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-bold text-slate-500">スクリプト（タップで1行ずつ再生）</h2>
            <button type="button" onClick={() => setShowJa((v) => !v)} className="flex min-h-11 items-center gap-1 text-xs font-semibold text-brand-blue">
              {showJa ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
              {showJa ? "訳を隠す" : "訳を出す"}
            </button>
          </div>
          {lesson.lines.map((l, i) => (
            <Bubble
              key={i}
              line={l}
              partner={lesson.partner}
              active={player.cur === i}
              showJa={showJa}
              showKana={showKana}
              onClick={() => {
                player.stop();
                void speakPt(l.pt, { pitch: pitchOf(l) });
              }}
            />
          ))}
        </section>
      )}

      {script && lesson.tips.length > 0 && (
        <section className="space-y-2">
          <h2 className="flex items-center gap-1.5 px-1 text-sm font-bold text-slate-500">
            <Lightbulb size={16} className="text-amber-500" aria-hidden />
            ポイント
          </h2>
          {lesson.tips.map((t) => (
            <div key={t.title} className="card space-y-1 p-4">
              <h3 className="text-sm font-bold text-brand-ink">{t.title}</h3>
              <p className="text-sm leading-relaxed text-slate-600">{t.body}</p>
            </div>
          ))}
        </section>
      )}

      <button
        type="button"
        onClick={() => {
          player.stop();
          onNext();
        }}
        className={`${script || heard > 0 ? "btn-primary" : "btn-ghost"} min-h-14 w-full text-base`}
      >
        次へ：まねて言う
        <ArrowRight size={18} aria-hidden />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ② まねる（この課の文を、お手本のあとに声に出す。次の「言う」で日本語から思い出す文を、先に口に乗せておく）
// ---------------------------------------------------------------------------
function RepeatStep({ lesson, onNext }: { lesson: Lesson; onNext: () => void }) {
  const targets = lesson.phrases;
  const [k, setK] = useState(0);
  const [score, setScore] = useState<SpeechSentenceScore | null>(null);
  const t = targets[k];

  // その文に来たら、お手本を1回流す
  useEffect(() => {
    if (!t) return;
    setScore(null);
    void speakPt(t.pt);
    return () => audio.cancel();
  }, [t]);

  // 採点が出たら、「次の文」のボタンが画面に入るところまで送る
  const nextRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (score) nextRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [score]);

  if (!t) return null;
  const answers = [t.pt, ...(t.alt ?? [])];
  function next() {
    useProgress.getState().logActivity("speak", 1, 0);
    if (k + 1 >= targets.length) onNext();
    else setK(k + 1);
  }
  const onHeard = (r: SpeechResult) => setScore(scoreSaid(r.transcripts, answers));

  return (
    <div className="space-y-4">
      <p className="text-center text-xs tabular-nums text-slate-500">
        この課の文 {k + 1} / {targets.length}
      </p>
      <div className="card space-y-3 p-5 text-center">
        <p className="text-sm text-slate-500">{t.ja}</p>
        <p className="text-2xl font-bold leading-snug text-brand-ink" lang="pt-BR">
          {t.pt}
        </p>
        <KanaHint text={t.pt} />
        <div className="flex items-center justify-center gap-2">
          <button type="button" onClick={() => void speakPt(t.pt)} className="btn-ghost min-h-11 px-3 text-sm">
            <Volume2 size={18} aria-hidden />
            お手本
          </button>
          <button type="button" onClick={() => void speakPt(t.pt, { slow: true })} className="btn-ghost min-h-11 px-3 text-sm">
            <Snail size={18} aria-hidden />
            ゆっくり
          </button>
        </div>
        {t.alt?.length ? (
          <p className="text-xs text-slate-500" lang="pt-BR">
            <span lang="ja">ほかの言い方: </span>
            {t.alt.slice(0, 3).join(" ／ ")}
          </p>
        ) : null}
        {t.note && <p className="rounded-lg bg-slate-50 px-3 py-2 text-left text-xs leading-relaxed text-slate-600">💡 {t.note}</p>}
        {score && <ScoreView score={score} compact />}
      </div>
      {micSupported() ? (
        // 文ごとに 🎤 を作り直す（前の文の聞き取りを止め、遅れて届いた結果を次の文に出さない）
        <MicButton key={t.id} onResult={onHeard} timeoutMs={sentenceListenTimeoutMs(answers)} hint="お手本をまねて、声に出して言おう（押すと採点）" />
      ) : (
        <p className="text-center text-sm text-slate-500">お手本をまねて、声に出して2〜3回言ってみよう。</p>
      )}
      <button ref={nextRef} type="button" onClick={next} className="btn-primary min-h-14 w-full scroll-mb-4 text-base">
        {k + 1 >= targets.length ? "次へ：日本語を見て言う" : "声に出した → 次の文"}
        <ArrowRight size={18} aria-hidden />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ④ 演じる（相手のセリフは音声で流れ、自分のセリフは日本語のヒントだけを見て言う）
// ---------------------------------------------------------------------------
function PlayStep({ lesson, onNext, replay = false }: { lesson: Lesson; onNext: () => void; replay?: boolean }) {
  const lines = lesson.lines;
  const [run, setRun] = useState(0);
  const [pos, setPos] = useState(0);
  /** 自分の番で、答えを見たか */
  const [shown, setShown] = useState(false);
  const [score, setScore] = useState<SpeechSentenceScore | null>(null);
  /** 自分のセリフに日本語のヒントを出す（2周目は隠して挑戦できる。場面の復習では最初から隠す） */
  const [hintJa, setHintJa] = useState(!replay);
  /** 今流れている相手のセリフの文字を出す（既定は隠す＝耳で聞く） */
  const [peek, setPeek] = useState(false);
  /** 相手のセリフの音声がすぐ終わった（音声が出ていない見込み）→ 文字を出して、自分で次へ進む */
  const [manual, setManual] = useState(false);
  const activeRef = useRef<HTMLDivElement>(null);
  const line = lines[pos];
  const finished = pos >= lines.length;
  useWakeLock(!finished);

  // 自分のセリフで言ってよい別の言い方（同じ文がフレーズにあれば、その alt も正解にする）
  const answers = useMemo(() => {
    if (!line) return [];
    const p = lesson.phrases.find((x) => x.pt === line.pt);
    return [line.pt, ...(p?.alt ?? [])];
  }, [line, lesson]);

  // 相手の番: セリフを流して、終わったら次の行へ
  useEffect(() => {
    if (!line || line.who !== "partner") return;
    let cancelled = false;
    setPeek(false);
    setManual(false);
    void (async () => {
      const started = Date.now();
      const played = await speakPtChecked(line.pt, { pitch: PITCH_PARTNER });
      if (cancelled) return;
      // 鳴らなかった（エラー・読み上げが始まらなかった・別の読み上げに割り込まれた）、または一瞬で終わった
      // （音の出ない音声でも「終わった」と返す端末がある）ときは、聞かせないまま先へ進めない。
      // 文字を出して、自分で「次へ」を押してもらう
      if (!played || Date.now() - started < MIN_SPOKEN_MS) {
        setPeek(true);
        setManual(true);
        return;
      }
      try {
        await delay(350);
      } catch {
        return;
      }
      if (!cancelled) setPos((p) => p + 1);
    })();
    return () => {
      cancelled = true;
      audio.cancel();
    };
  }, [line, run]);

  useEffect(() => {
    setShown(false);
    setScore(null);
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [pos, run]);

  function reveal(play: boolean) {
    setShown(true);
    if (play && line) void speakPt(line.pt);
  }
  function onHeard(r: SpeechResult) {
    const s = scoreSaid(r.transcripts, answers);
    setScore(s);
    // よく言えていれば、お手本は流さずに先へ進める
    if (!shown) reveal(s.percent < 85);
  }
  function next() {
    useProgress.getState().logActivity("speak", 1, 0);
    setPos((p) => p + 1);
  }
  function restart(withHint: boolean) {
    audio.cancel();
    setHintJa(withHint);
    setPos(0);
    setRun((n) => n + 1);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between px-1">
        <p className="text-xs leading-relaxed text-slate-500">相手のセリフは耳で聞いて、自分の番で言おう。</p>
        <button type="button" onClick={() => setHintJa((v) => !v)} className="flex min-h-11 shrink-0 items-center gap-1 text-xs font-semibold text-brand-blue">
          {hintJa ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}
          {hintJa ? "ヒントを隠す" : "ヒントを出す"}
        </button>
      </div>

      {/* 済んだ行はタップで聞き直せる。相手のセリフが流れている間は押せなくする（割り込むと、今のセリフを聞かないまま進んでしまう） */}
      {lines.slice(0, Math.min(pos, lines.length)).map((l, i) => (
        <Bubble
          key={`${run}-${i}`}
          line={l}
          partner={lesson.partner}
          onClick={line?.who === "partner" && !manual ? undefined : () => void speakPt(l.pt, { pitch: pitchOf(l) })}
        />
      ))}

      {line && line.who === "partner" && (
        <div ref={activeRef}>
          <Bubble line={line} partner={lesson.partner} active onClick={() => setPeek(true)}>
            {peek ? (
              <p className="font-semibold leading-snug text-brand-ink" lang="pt-BR">
                {line.pt}
              </p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-slate-500">
                <Volume2 size={18} className="animate-pulse text-brand-green" aria-hidden />
                聞いてください…（タップで文字）
              </p>
            )}
          </Bubble>
          {manual && (
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={() => void speakPt(line.pt, { pitch: PITCH_PARTNER })} className="btn-ghost min-h-12 px-4" aria-label="相手のセリフを聞く">
                <Volume2 size={18} aria-hidden />
              </button>
              <button type="button" onClick={() => setPos((p) => p + 1)} className="btn-primary min-h-12 flex-1">
                次へ
                <ArrowRight size={18} aria-hidden />
              </button>
            </div>
          )}
        </div>
      )}

      {line && line.who === "you" && (
        <div ref={activeRef} className="space-y-3">
          <Bubble line={line} partner={lesson.partner} active>
            <p className="text-[11px] font-bold text-emerald-700">🗣 あなたの番</p>
            {hintJa || shown ? <p className="mt-0.5 text-base font-bold leading-relaxed text-brand-ink">{line.ja}</p> : <p className="mt-0.5 text-sm text-slate-500">（ヒントなし。流れから言ってみよう）</p>}
            {shown && (
              <p className="mt-2 border-t border-dashed border-emerald-200 pt-2 text-lg font-bold leading-snug text-brand-green" lang="pt-BR">
                {line.pt}
              </p>
            )}
          </Bubble>
          {score && <ScoreView score={score} compact />}
          {!shown ? (
            <div className="space-y-2">
              {micSupported() && <MicButton key={`${run}-${pos}`} onResult={onHeard} timeoutMs={sentenceListenTimeoutMs(answers)} hint="押して、自分のセリフを言う" />}
              <button type="button" onClick={() => reveal(true)} className={`${micSupported() ? "btn-ghost" : "btn-primary"} min-h-12 w-full`}>
                <Eye size={18} aria-hidden />
                言ってから 答えを見る
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <button type="button" onClick={() => void speakPt(line.pt)} className="btn-ghost min-h-12 px-4" aria-label="お手本を聞く">
                <Volume2 size={18} aria-hidden />
              </button>
              <button type="button" onClick={next} className="btn-primary min-h-12 flex-1">
                次へ
                <ArrowRight size={18} aria-hidden />
              </button>
            </div>
          )}
        </div>
      )}

      {finished && (
        <div className="space-y-2 pt-2">
          <p className="text-center text-sm font-bold text-emerald-700">最後まで演じられました！</p>
          <button type="button" onClick={onNext} className="btn-primary min-h-14 w-full text-base">
            <Check size={18} aria-hidden />
            {replay ? "場面の復習を終える" : "レッスンを終える"}
          </button>
          <button type="button" onClick={() => restart(false)} className="btn-ghost min-h-12 w-full text-sm">
            <RotateCcw size={16} aria-hidden />
            もう一度（日本語のヒントなしで挑戦）
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 完了
// ---------------------------------------------------------------------------
function DoneStep({ lesson, result }: { lesson: Lesson; result: SayResult | null }) {
  const { provider } = useAiProvider();
  const next = nextLesson(lesson.id);
  return (
    <div className="animate-fade-in space-y-4">
      <div className="card space-y-3 p-6 text-center">
        <PartyPopper size={36} className="mx-auto text-brand-yellow" aria-hidden />
        <h2 className="text-xl font-bold text-brand-ink">{lessonLabel(lesson)} を終えました！</h2>
        <p className="rounded-lg bg-brand-green/5 px-3 py-2 text-sm leading-relaxed text-emerald-800">🎯 {lesson.goal}</p>
        <p className="text-sm leading-relaxed text-slate-600">
          この課の <span className="font-bold text-brand-ink">{lesson.phrases.length}文</span> が「口慣らし」に入りました。明日から、忘れかけた頃に出てきます。
          {result && result.again > 0 && `（言えなかった ${result.again}文は早めに出ます）`}
        </p>
      </div>

      <Link to={`/talk/${lesson.id}`} className="card flex items-center gap-3 p-4 ring-violet-200 transition active:scale-[0.99]">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white">
          <MessagesSquare size={22} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-brand-ink">この場面で AI と話してみる</span>
          <span className="block text-xs leading-relaxed text-slate-500">
            {provider ? "台本なしの本番。習った文を使って、自由にやりとりします。" : "台本なしの本番練習。無料の設定（数分）で使えます。"}
          </span>
        </span>
        <ArrowRight size={18} className="shrink-0 text-slate-300" aria-hidden />
      </Link>

      {next && (
        <Link to={`/course/${next.id}`} replace className="btn-ghost min-h-12 w-full">
          次のレッスン：L{next.no} {next.title}
          <ArrowRight size={18} aria-hidden />
        </Link>
      )}
      <NextMenu skip="lesson" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// レッスンの画面
// ---------------------------------------------------------------------------
export default function LessonPage() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const lesson = LESSON_BY_ID.get(id);
  // 場面の復習は、終えたレッスンだけ（まだのレッスンは、ふつうのレッスンとして開く）
  const done = useSpeak((s) => !!s.lessons[id]?.doneAt);
  const replay = params.get("replay") === "1" && done;
  if (!lesson) {
    return (
      <div className="card space-y-3 p-6 text-center">
        <p className="text-sm text-slate-500">このレッスンは見つかりませんでした。</p>
        <Link to="/course" className="btn-primary">
          レッスンの一覧へ
        </Link>
      </div>
    );
  }
  // レッスンが替わったら、状態ごと作り直す
  return replay ? <ReplayRunner key={`replay-${lesson.id}`} lesson={lesson} /> : <LessonRunner key={lesson.id} lesson={lesson} />;
}

/** 場面の復習（終えたレッスンのロールプレイを、ヒントなしでもう一度通す。?step=3&replay=1） */
function ReplayRunner({ lesson }: { lesson: Lesson }) {
  const back = useBack("/");
  const [finished, setFinished] = useState(false);
  useImmersive(!finished);
  useActivityTimer("lesson", !finished);
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-center gap-1">
        <button type="button" onClick={back} aria-label="場面の復習を閉じる" className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 active:scale-90">
          <X size={22} aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold text-orange-600">場面の復習（ヒントなし）</p>
          <h1 className="truncate text-base font-bold text-brand-ink">
            L{lesson.no} {lesson.title}
          </h1>
        </div>
      </div>
      {finished ? (
        <div className="animate-fade-in space-y-4">
          <div className="card space-y-2 p-6 text-center">
            <PartyPopper size={36} className="mx-auto text-brand-yellow" aria-hidden />
            <h2 className="text-xl font-bold text-brand-ink">場面を通して演じられました！</h2>
            <p className="text-sm leading-relaxed text-slate-600">相手のポルトガル語を聞いて、自分の言葉で返す練習です。この場面は、また忘れかけた頃に出てきます。</p>
          </div>
          <NextMenu skip="scene" />
        </div>
      ) : (
        <>
          <p className="rounded-xl bg-slate-100 px-3 py-2 text-xs leading-relaxed text-slate-600">🎬 {lesson.scene}</p>
          <PlayStep
            lesson={lesson}
            replay
            onNext={() => {
              audio.cancel();
              useSpeak.getState().logReplay(lesson.id);
              setFinished(true);
              window.scrollTo({ top: 0 });
            }}
          />
        </>
      )}
    </div>
  );
}

function LessonRunner({ lesson }: { lesson: Lesson }) {
  const [params] = useSearchParams();
  const back = useBack("/course");
  const saved = useSpeak((s) => s.lessons[lesson.id]);
  const [step, setStep] = useState(() => {
    const q = Number(params.get("step"));
    if (params.has("step") && Number.isInteger(q) && q >= 0 && q < LESSON_STEPS) return q;
    // 途中ならつづきから。終えたレッスンは最初から（復習）
    return saved && !saved.doneAt ? Math.min(saved.step, LESSON_STEPS - 1) : 0;
  });
  const [sayResult, setSayResult] = useState<SayResult | null>(null);
  const items = useMemo(() => lessonItems(lesson), [lesson]);
  const running = step < LESSON_STEPS;
  useImmersive(running);
  useActivityTimer("lesson", running);
  const loggedRef = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  const go = useCallback(
    (n: number) => {
      // 今のステップのタブを押しても、何もしない（読み上げを止めて行を飛ばさない）
      if (n === stepRef.current) return;
      audio.cancel();
      setStep(n);
      window.scrollTo({ top: 0 });
      const sp = useSpeak.getState();
      if (n >= LESSON_STEPS) {
        // 終えた: この課の文を口慣らしに入れ（まだ評価していない文は今日が期限）、レッスンを済みにする
        sp.ensureCards(items.map((it) => it.id));
        sp.completeLesson(lesson.id);
        if (!loggedRef.current) {
          loggedRef.current = true;
          useProgress.getState().logActivity("lesson", 1, 0);
        }
      } else sp.setLessonStep(lesson.id, n);
    },
    [items, lesson.id]
  );

  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="flex items-center gap-1">
        <button type="button" onClick={back} aria-label="レッスンを閉じる" className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-500 active:scale-90">
          <X size={22} aria-hidden />
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold text-brand-green">LESSON {lesson.no}</p>
          <h1 className="truncate text-base font-bold text-brand-ink">{lesson.title}</h1>
        </div>
        {running && (
          <AskTeacherButton
            variant="icon"
            label="このレッスンについて"
            context={() => sentenceContext({ pt: lesson.lines.map((l) => l.pt).join(" / "), source: lessonLabel(lesson), label: `🎬 ${lessonLabel(lesson)}` })}
          />
        )}
      </div>

      {running && (
        <>
          <ol className="grid grid-cols-4 gap-1.5">
            {STEPS.map((s, i) => (
              <li key={s.label}>
                <button
                  type="button"
                  onClick={() => go(i)}
                  aria-current={i === step ? "step" : undefined}
                  className={`flex min-h-11 w-full flex-col items-center justify-center rounded-xl text-xs font-bold transition active:scale-95 ${
                    i === step ? "bg-brand-green text-white shadow-sm" : i < step ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-400"
                  }`}
                >
                  <span className="text-[10px] font-normal opacity-80">{i < step ? "✓" : i + 1}</span>
                  {s.label}
                </button>
              </li>
            ))}
          </ol>
          <p className="text-center text-xs text-slate-500">{STEPS[step].hint}</p>
        </>
      )}

      {step === 0 && <ListenStep lesson={lesson} onNext={() => go(1)} />}
      {step === 1 && <RepeatStep lesson={lesson} onNext={() => go(2)} />}
      {step === 2 && (
        <SayRunner
          items={items}
          onDone={(r) => {
            setSayResult(r);
            go(3);
          }}
        />
      )}
      {step === 3 && <PlayStep lesson={lesson} onNext={() => go(LESSON_STEPS)} />}
      {step >= LESSON_STEPS && <DoneStep lesson={lesson} result={sayResult} />}
    </div>
  );
}
