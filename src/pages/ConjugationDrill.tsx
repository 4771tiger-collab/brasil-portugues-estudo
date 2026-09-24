import { useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import PtInput from "../components/PtInput";
import DiffView from "../components/DiffView";
import SpeakerButton from "../components/SpeakerButton";
import { ALL_WORDS, DICT_RAW, resolveWord } from "../data/loadWords";
import { getConjugator, irregularTable, irregularVerbs } from "../data/conjugator";
import type { SrsCard, Word } from "../data/types";
import { audio } from "../services/audio";
import { toKana } from "../services/pronunciation";
import {
  answerEntry,
  drillCandidates,
  gradeConjugation,
  newConjQueue,
  parseDrillKey,
  pickDrill,
  summarizeConj,
  toQuestions,
  weakKeys,
  type ConjEntry,
  type ConjGrade,
  type DrillStats,
  type DrillVerdict,
} from "../services/conjugationDrill";
import {
  PERSON_LABEL,
  PERSON_PROMPT,
  PERSON_PRONOUN,
  TABLE_PERSONS,
  TABLE_TENSES,
  TENSE_HINT,
  TENSE_PT,
  TENSE_SHORT,
  conjugationForm,
  isTablePerson,
  isTableTense,
  verbHead,
  withSubject,
  type TablePerson,
  type TableTense,
} from "../services/verbTable";
import { useVisibleStopwatch } from "../hooks/useActivityTimer";
import { useSequencePlayer } from "../hooks/useSequencePlayer";
import { DRILL_SIZES, VERB_GROUPS, cleanPrefs, useDrill, type DrillPrefs, type VerbGroup } from "../store/useDrill";
import { useUserWordMap } from "../store/useMusic";
import { useProgress } from "../store/useProgress";
import { useSettings } from "../store/useSettings";

// ============================================================================
// 活用ドリル（/practice/conjugation）
// 「falar ・ 現在 ・ nós」を見て活用形を入力 → 採点（アクセント違いは惜しい）→ 正解を表示して読み上げ。
// 出題は不規則動詞の表の動詞と、単語帳で学習した規則動詞。成績は useDrill（SRS のカードには書かない）。
// ============================================================================

/** 1問に記録する時間の上限（秒）。前の問題からこれより空いた分は放置とみなす */
const ANSWER_CAP_SEC = 60;

/** 答えの「ゆっくり」の速さ */
const SLOW_RATE = 0.7;

// ---------------------------------------------------------------------------
// 出題する動詞
// ---------------------------------------------------------------------------

/** 不規則動詞の表の動詞: 基本（派生元の無いもの）と派生（manter ← ter など） */
function irregularGroups(): { basic: string[]; derived: string[] } {
  const table = irregularTable();
  const verbs = irregularVerbs();
  return { basic: verbs.filter((v) => !table[v].like), derived: verbs.filter((v) => !!table[v].like) };
}

/** 学習した（一度でも評価した）語のうち、不規則動詞の表に無い動詞の不定詞（ABC順） */
function studiedRegularVerbs(cards: Record<string, SrsCard>, userMap: Map<string, Word>): string[] {
  const table = irregularTable();
  const out = new Set<string>();
  for (const [id, c] of Object.entries(cards)) {
    if (!c.last) continue;
    const w = resolveWord(id, userMap);
    if (!w) continue;
    const h = verbHead(w.pt, w.pos, table);
    if (h && !table[h.inf]) out.add(h.inf);
  }
  return [...out].sort((a, b) => a.localeCompare(b, "pt"));
}

let meaningCache: Map<string, string> | null = null;

/** 不定詞 → 意味（単語帳 → 辞書の順に最初に見つかったもの。再帰動詞の見出しは使わない） */
function verbMeaning(inf: string): string | undefined {
  if (!meaningCache) {
    const m = new Map<string, string>();
    const table = irregularTable();
    const add = (pt: string, pos: string, ja: string) => {
      const h = verbHead(pt, pos, table);
      if (h && !h.reflexive && ja && !m.has(h.inf)) m.set(h.inf, ja);
    };
    for (const w of ALL_WORDS) add(w.pt, w.pos, w.ja);
    for (const r of DICT_RAW) add(r.ポルトガル語, r.品詞, r.日本語);
    meaningCache = m;
  }
  return meaningCache.get(inf);
}

const GROUP_UI: Record<VerbGroup, { label: string; desc: string }> = {
  basic: { label: "不規則動詞", desc: "ser・ir・fazer など" },
  derived: { label: "不規則動詞（派生）", desc: "manter・compor など" },
  studied: { label: "学習した規則動詞", desc: "単語帳で学習した動詞" },
};

/** 設定から1回分の問題を作る（成績の重みで選ぶ） */
function buildQueue(prefs: DrillPrefs, groups: Record<VerbGroup, string[]>, stats: DrillStats): ConjEntry[] {
  const verbs = prefs.groups.flatMap((g) => groups[g]);
  const cands = drillCandidates(verbs, prefs.tenses, prefs.persons);
  return newConjQueue(toQuestions(getConjugator(), pickDrill(cands, stats, prefs.size)));
}

// ---------------------------------------------------------------------------
// 表示の部品
// ---------------------------------------------------------------------------

const VERDICT_UI: Record<DrillVerdict, { mark: string; text: string; ring: string }> = {
  correct: { mark: "○", text: "text-emerald-600", ring: "" },
  close: { mark: "△", text: "text-amber-500", ring: "ring-1 ring-amber-200" },
  wrong: { mark: "×", text: "text-rose-500", ring: "ring-1 ring-rose-200" },
};

/** 出題の見出し（「falar ・ 現在 ・ nós」） */
function Prompt({ inf, tense, person, big }: { inf: string; tense: TableTense; person: TablePerson; big?: boolean }) {
  return (
    <span className={`font-bold text-brand-ink ${big ? "text-2xl" : ""}`}>
      {inf}
      <span className="font-normal text-slate-300"> ・ </span>
      {TENSE_SHORT[tense]}
      <span className="font-normal text-slate-300"> ・ </span>
      {PERSON_PROMPT[person]}
    </span>
  );
}

/** 選ぶボタン（複数選択・1つ選択の両方で使う） */
function Toggle({
  on,
  onClick,
  disabled,
  children,
  className = "",
}: {
  on: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      disabled={disabled}
      className={`card min-h-11 px-2 py-2 text-sm transition disabled:opacity-40 ${
        on ? "font-bold text-brand-ink ring-2 ring-brand-green" : "text-slate-500"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** 複数選択の切り替え（最後の1つは外さない） */
function toggleIn<T>(all: readonly T[], list: readonly T[], v: T): T[] {
  if (list.includes(v)) return list.length > 1 ? list.filter((x) => x !== v) : [...list];
  return all.filter((x) => x === v || list.includes(x));
}

// ---------------------------------------------------------------------------
// 設定（出題範囲）
// ---------------------------------------------------------------------------

function Setup({
  prefs,
  groups,
  onStart,
}: {
  prefs: DrillPrefs;
  groups: Record<VerbGroup, string[]>;
  onStart: () => void;
}) {
  const setPrefs = useDrill((s) => s.setPrefs);
  const stats = useDrill((s) => s.stats);
  const verbs = prefs.groups.reduce((n, g) => n + groups[g].length, 0);
  const combos = verbs * prefs.tenses.length * prefs.persons.length;
  const total = useMemo(() => {
    let seen = 0;
    let correct = 0;
    for (const s of Object.values(stats)) {
      seen += s.seen;
      correct += s.correct;
    }
    return { seen, correct, forms: Object.keys(stats).length };
  }, [stats]);
  const weak = useMemo(() => weakKeys(stats, 5), [stats]);

  return (
    <div className="space-y-5">
      <section>
        <h2 className="mb-2 px-1 text-sm font-bold text-slate-500">出題する動詞</h2>
        <div className="grid grid-cols-1 gap-2">
          {VERB_GROUPS.map((g) => (
            <Toggle
              key={g}
              on={prefs.groups.includes(g)}
              onClick={() => setPrefs({ groups: toggleIn(VERB_GROUPS, prefs.groups, g) })}
              disabled={groups[g].length === 0 && !prefs.groups.includes(g)}
              className="flex items-center gap-2 px-3 text-left"
            >
              <span className="flex-1">
                {GROUP_UI[g].label}
                <span className="ml-2 text-xs font-normal text-slate-400">{GROUP_UI[g].desc}</span>
              </span>
              <span className="text-xs font-normal text-slate-400">{groups[g].length}語</span>
            </Toggle>
          ))}
        </div>
        {groups.studied.length === 0 && (
          <p className="mt-2 px-1 text-xs text-slate-400">単語帳で動詞を学習すると、その動詞もここから出題できます。</p>
        )}
      </section>

      <section>
        <h2 className="mb-2 px-1 text-sm font-bold text-slate-500">時制</h2>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="時制">
          {TABLE_TENSES.map((t) => (
            <Toggle key={t} on={prefs.tenses.includes(t)} onClick={() => setPrefs({ tenses: toggleIn(TABLE_TENSES, prefs.tenses, t) })}>
              <span className="block">{TENSE_SHORT[t]}</span>
              <span className="block text-[11px] font-normal text-slate-400">{TENSE_HINT[t]}</span>
            </Toggle>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 px-1 text-sm font-bold text-slate-500">主語</h2>
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="主語">
          {TABLE_PERSONS.map((p) => (
            <Toggle key={p} on={prefs.persons.includes(p)} onClick={() => setPrefs({ persons: toggleIn(TABLE_PERSONS, prefs.persons, p) })}>
              {PERSON_LABEL[p]}
            </Toggle>
          ))}
        </div>
        <p className="mt-2 px-1 text-xs text-slate-400">você・a gente は ele と、vocês は eles と同じ形です。</p>
      </section>

      <section>
        <h2 className="mb-2 px-1 text-sm font-bold text-slate-500">問題数</h2>
        <div className="flex gap-2" role="group" aria-label="問題数">
          {DRILL_SIZES.map((n) => (
            <Toggle key={n} on={prefs.size === n} onClick={() => setPrefs({ size: n })} className="flex-1">
              {n}問
            </Toggle>
          ))}
        </div>
      </section>

      <button onClick={onStart} disabled={combos === 0} className="btn-primary min-h-12 w-full py-3 text-base">
        スタート
      </button>
      <p className="px-1 text-xs leading-relaxed text-slate-400">
        {verbs}語 × 時制{prefs.tenses.length} × 主語{prefs.persons.length} = {combos}通りから、まだ出していない形・間違えやすい形を多めに出します。
        アクセント記号だけの違いは「惜しい」。正解できなかった問題は最後にもう一度出ます。
      </p>

      {total.seen > 0 && (
        <section className="card space-y-2 p-4">
          <h2 className="text-sm font-bold text-slate-500">これまでの成績</h2>
          <p className="text-sm text-slate-600">
            {total.forms}形 ・ {total.seen}問 ・ 正解 {Math.round((total.correct / total.seen) * 100)}%
          </p>
          {weak.length > 0 && (
            <div className="space-y-1">
              <div className="text-xs text-slate-400">間違えやすい形</div>
              {weak.map(({ key, stat }) => {
                const k = parseDrillKey(key);
                if (!k || !isTableTense(k.tense) || !isTablePerson(k.person)) return null;
                return (
                  <div key={key} className="flex items-baseline justify-between gap-2 text-sm">
                    <Prompt inf={k.inf} tense={k.tense} person={k.person} />
                    <span className="shrink-0 text-xs text-slate-400">
                      {conjugationForm(getConjugator(), k.inf, k.tense, k.person)} ・ {stat.correct}/{stat.seen}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ドリル（1問ずつ入力 → 答え合わせ）
// ---------------------------------------------------------------------------

/** 答え合わせの結果（「わからない」は grade が null） */
interface Answered {
  input: string;
  grade: ConjGrade | null;
  verdict: DrillVerdict;
}

function Run({ initial, onDone, onQuit }: { initial: ConjEntry[]; onDone: (q: ConjEntry[]) => void; onQuit: () => void }) {
  const showKana = useSettings((s) => s.showKana);
  const [queue, setQueue] = useState<ConjEntry[]>(initial);
  const [pos, setPos] = useState(0);
  const [draft, setDraft] = useState("");
  const [answered, setAnswered] = useState<Answered | null>(null);
  /** 答え合わせ済みの位置（連打で2回記録しないように。描画を待たずに見る） */
  const doneRef = useRef(new Set<number>());
  // 答えの音声（どの再生も前の再生を止めてから始める。画面を離れたら停止）
  const player = useSequencePlayer();
  // 1問の所要時間（前の問題から画面を見ていた時間。上限つき）
  const lap = useVisibleStopwatch();

  const entry: ConjEntry | undefined = queue[pos];
  const q = entry?.q;
  const spoken = q ? withSubject(q.answer, q.person) : "";
  const kana = useMemo(() => (spoken && showKana ? toKana(spoken) : ""), [spoken, showKana]);
  const row = useMemo(() => (q ? getConjugator().paradigm(q.inf)[q.tense] : null), [q]);
  const meaning = q ? verbMeaning(q.inf) : undefined;
  const like = q ? irregularTable()[q.inf]?.like : undefined;
  const irregular = q ? !!irregularTable()[q.inf] : false;

  /** 結果を記録して表示する。正解の音声はタップ（Enter）の処理の中で読み始める */
  function finish(input: string, grade: ConjGrade | null) {
    if (!entry || !q || answered || doneRef.current.has(pos)) return;
    doneRef.current.add(pos);
    const verdict: DrillVerdict = grade ? grade.verdict : "wrong";
    void player.playOne(spoken, 0);
    // 成績は最初の出題だけ（もう一度の出題は直前に答えを見ているので数えない）
    if (!entry.retry) useDrill.getState().record(q.key, verdict === "correct");
    // 学習ログ: 答えた1問ごと（もう一度の出題も数える）
    useProgress.getState().logActivity("drill", 1, lap(ANSWER_CAP_SEC));
    setQueue((cur) => answerEntry(cur, pos, verdict, input));
    setAnswered({ input, grade, verdict });
  }

  function submit() {
    const input = draft.trim();
    if (!q || !input) return;
    finish(input, gradeConjugation(getConjugator(), q, input));
  }

  function giveUp() {
    finish("", null);
  }

  function replay(slow: boolean) {
    const idx = slow ? 1 : 0;
    if (player.activeIdx === idx) {
      player.stop();
      return;
    }
    void player.playOne(spoken, idx, slow ? { rate: SLOW_RATE } : undefined);
  }

  function next() {
    player.stop();
    const p = pos + 1;
    setAnswered(null);
    setDraft("");
    if (p >= queue.length) onDone(queue);
    else setPos(p);
  }

  /** やめる: 1問でも答えていれば結果へ、まだなら設定に戻る */
  function quit() {
    player.stop();
    if (queue.some((e) => e.verdict)) onDone(queue);
    else onQuit();
  }

  if (!entry || !q || !row) return <p className="card p-4 text-sm text-slate-500">出題できる問題がありません。</p>;

  const g = answered?.grade?.result;
  const label = !answered
    ? ""
    : answered.verdict === "correct"
      ? "正解！"
      : answered.verdict === "close"
        ? g?.grade === "accent"
          ? "惜しい（アクセント記号）"
          : "惜しい（つづり）"
        : answered.input
          ? "不正解"
          : "答え";
  const last = pos + 1 >= queue.length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button onClick={quit} className="min-h-11 pr-2 text-sm text-brand-green">
          ‹ やめる
        </button>
        <div className="flex items-center gap-2 text-sm font-bold text-slate-500">
          {entry.retry && <span className="chip bg-amber-100 text-amber-700">もう一度</span>}
          {pos + 1} / {queue.length}
        </div>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="h-full bg-brand-green transition-all" style={{ width: `${((pos + 1) / queue.length) * 100}%` }} />
      </div>

      {!audio.isSupported() && (
        <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-700">
          🔇 このブラウザでは読み上げが使えません。答えは画面で確かめてください。
        </p>
      )}

      {/* 問題 */}
      <div key={`${pos}`} className="card animate-fade-in space-y-1 p-4 text-center">
        <div className="flex flex-wrap items-center justify-center gap-1.5 text-xs">
          {irregular && <span className="chip bg-rose-50 text-rose-600">不規則</span>}
          {meaning && <span className="text-slate-500">{meaning}</span>}
        </div>
        <p>
          <Prompt inf={q.inf} tense={q.tense} person={q.person} big />
        </p>
        <p className="text-[11px] text-slate-400">
          {TENSE_PT[q.tense]} ・ {TENSE_HINT[q.tense]}
        </p>
      </div>

      {!answered ? (
        <div className="space-y-2">
          <PtInput
            key={pos}
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            autoFocus
            placeholder={`${PERSON_PRONOUN[q.person]} …（活用形を入力）`}
            aria-label="活用形（ポルトガル語）"
          />
          <button onClick={submit} disabled={!draft.trim()} className="btn-primary min-h-11 w-full py-3">
            答え合わせ
          </button>
          <button type="button" onClick={giveUp} className="btn-ghost min-h-11 w-full text-sm">
            わからない（答えを見る）
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="card space-y-3 p-4">
            <div className={`text-lg font-bold ${answered.input ? VERDICT_UI[answered.verdict].text : "text-slate-600"}`}>{label}</div>
            {g && g.grade !== "exact" && (
              <div className="space-y-1">
                <div className="text-xs text-slate-400">あなたの答え</div>
                {g.grade === "wrong" && !g.note ? (
                  <div className="break-all text-lg text-rose-600 line-through">{answered.input}</div>
                ) : (
                  <>
                    <DiffView diff={g.diff} />
                    <div className="text-[11px] text-slate-400">赤の取り消し線＝余分な文字、緑＝足りない文字</div>
                  </>
                )}
                {g.note && <div className="text-sm text-slate-600">{g.note}</div>}
              </div>
            )}

            {/* 正解（主語つきで読み上げる） */}
            <div className="rounded-xl bg-slate-50 p-3 text-center">
              <div className="text-2xl font-bold text-brand-ink">
                <span className="font-normal text-slate-400">{PERSON_PRONOUN[q.person]} </span>
                {q.answer}
              </div>
              {showKana && <div className="text-xs text-slate-400">{kana}</div>}
              <div className="flex justify-center gap-2 pt-2">
                <button onClick={() => replay(false)} aria-pressed={player.activeIdx === 0} className="btn-ghost min-h-11 px-3 text-sm">
                  {player.activeIdx === 0 ? "■ 止める" : "▶ もう一度"}
                </button>
                <button onClick={() => replay(true)} aria-pressed={player.activeIdx === 1} className="btn-ghost min-h-11 px-3 text-sm">
                  {player.activeIdx === 1 ? "■ 止める" : "🐢 ゆっくり"}
                </button>
              </div>
            </div>

            {/* 同じ時制の4つの形（出題した形を強調） */}
            <div>
              <div className="mb-1 flex items-baseline gap-1.5 text-xs">
                <span className="font-bold text-slate-600">
                  {q.inf} の{TENSE_SHORT[q.tense]}
                </span>
                {like && <span className="text-slate-400">{like} と同じ活用</span>}
              </div>
              <div className="grid grid-cols-2 gap-1">
                {([0, 3, 2, 5] as const).map((p) => (
                  <div
                    key={p}
                    className={`rounded-md px-2 py-1 text-left ${p === q.person ? "bg-brand-yellow/30 ring-1 ring-brand-yellow" : "bg-slate-50"}`}
                  >
                    <div className="text-[10px] leading-tight text-slate-400">{PERSON_LABEL[p]}</div>
                    <div className="break-all text-sm font-medium text-brand-ink">{row[p]}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <button type="button" onClick={next} autoFocus className="btn-primary min-h-12 w-full py-3 text-base">
            {last ? "結果を見る" : "次へ"}
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 結果
// ---------------------------------------------------------------------------

function Result({ queue, onRestart, onSetup }: { queue: ConjEntry[]; onRestart: () => void; onSetup: () => void }) {
  const s = summarizeConj(queue);
  /** もう一度の出題の結果（キー → 結果。まだなら null） */
  const retryOf = new Map(queue.filter((e) => e.retry).map((e) => [e.q.key, e.verdict] as const));
  const retryPlanned = retryOf.size;
  const retryDone = s.retry.correct + s.retry.close + s.retry.wrong;
  const rows = queue.filter((e) => !e.retry && e.verdict);

  return (
    <div className="animate-fade-in space-y-4">
      <div className="card bg-gradient-to-br from-brand-green to-emerald-600 p-6 text-center text-white">
        <div className="text-sm opacity-90">活用ドリルの結果</div>
        <div className="my-1 text-5xl font-extrabold">
          {s.first.correct}/{s.answered}
        </div>
        <div className="text-sm opacity-90">
          正解 {s.first.correct} ・ 惜しい {s.first.close} ・ 不正解 {s.first.wrong}
        </div>
        {s.answered < s.planned && (
          <div className="mt-1 text-xs opacity-80">
            {s.planned}問中 {s.answered}問で中断
          </div>
        )}
        {retryPlanned > 0 && (
          <div className="mt-1 text-xs opacity-80">
            もう一度: 正解 {s.retry.correct}/{retryDone}
            {retryDone < retryPlanned ? `（${retryPlanned}問中 ${retryDone}問）` : ""}
          </div>
        )}
      </div>

      <h2 className="px-1 text-sm font-bold text-slate-500">ふり返り</h2>
      <div className="space-y-2">
        {rows.map((e) => {
          const ui = VERDICT_UI[e.verdict!];
          const again = retryOf.get(e.q.key);
          return (
            <div key={e.q.key} className={`card flex items-center gap-3 p-3 ${ui.ring}`}>
              <div className="flex w-10 shrink-0 flex-col items-center leading-tight">
                <span className={`text-lg ${ui.text}`}>{ui.mark}</span>
                {again && <span className={`text-[11px] ${VERDICT_UI[again].text}`}>→{VERDICT_UI[again].mark}</span>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm">
                  <Prompt inf={e.q.inf} tense={e.q.tense} person={e.q.person} />
                </div>
                <div className="font-bold text-brand-ink">
                  <span className="font-normal text-slate-400">{PERSON_PRONOUN[e.q.person]} </span>
                  {e.q.answer}
                </div>
                {e.verdict !== "correct" && (
                  <div className="break-all text-xs text-slate-400">{e.input ? `あなたの答え: ${e.input}` : "わからない"}</div>
                )}
              </div>
              <SpeakerButton text={withSubject(e.q.answer, e.q.person)} className="h-11 w-11 shrink-0" />
            </div>
          );
        })}
      </div>

      <div className="flex gap-2">
        <button onClick={onSetup} className="btn-ghost min-h-11 flex-1 py-3">
          出題範囲を変える
        </button>
        <button onClick={onRestart} className="btn-primary min-h-11 flex-1 py-3">
          新しい問題
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function ConjugationDrill() {
  const cards = useProgress((s) => s.cards);
  const userMap = useUserWordMap();
  const rawPrefs = useDrill((s) => s.prefs);
  const prefs = useMemo(() => cleanPrefs(rawPrefs), [rawPrefs]);
  const studied = useMemo(() => studiedRegularVerbs(cards, userMap), [cards, userMap]);
  const groups = useMemo<Record<VerbGroup, string[]>>(() => ({ ...irregularGroups(), studied }), [studied]);
  /** 出題中・結果表示中の問題の列（null は設定画面） */
  const [queue, setQueue] = useState<ConjEntry[] | null>(null);
  const [finished, setFinished] = useState(false);
  /** 出題のたびに増やす（ドリルの状態を作り直す） */
  const [run, setRun] = useState(0);

  function start() {
    const q = buildQueue(prefs, groups, useDrill.getState().stats);
    if (q.length === 0) return;
    setQueue(q);
    setFinished(false);
    setRun((n) => n + 1);
  }

  function toSetup() {
    setQueue(null);
    setFinished(false);
  }

  const running = queue !== null && !finished;
  return (
    <div className="animate-fade-in space-y-4">
      {!running && (
        <>
          <Link to="/practice" className="inline-flex min-h-11 items-center pr-2 text-sm text-brand-green">
            ‹ 練習に戻る
          </Link>
          <div>
            <h1 className="text-xl font-bold text-brand-ink">活用ドリル</h1>
            <p className="text-sm text-slate-500">
              動詞・時制・主語を見て、活用形を入力。正解は音声でも確認できます（単語帳の復習には記録しません）。
            </p>
          </div>
        </>
      )}
      {queue === null ? (
        <Setup prefs={prefs} groups={groups} onStart={start} />
      ) : finished ? (
        <Result queue={queue} onRestart={start} onSetup={toSetup} />
      ) : (
        <Run
          key={run}
          initial={queue}
          onDone={(q) => {
            setQueue(q);
            setFinished(true);
          }}
          onQuit={toSetup}
        />
      )}
    </div>
  );
}
