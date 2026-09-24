// ============================================================================
// 曲画面: 同期歌詞（現在行ハイライト・自動スクロール・行リピート・1行ずつ停止）
//         行ごとの和訳（機械翻訳＋編集）・単語タップで WordSheet・曲の単語一覧
// B3-08: 単語を調べた後は行の頭から聴き直す（replayAfterLookup）・行の後の間（gapMode）で自動再開・
//        ✍ 自分で訳してから機械翻訳と比べる（selfTranslated は行のハッシュだけ保存）
// 歌詞は端末で LRCLIB から取得したものを表示するだけ（アプリには同梱しない）。
// ============================================================================

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams } from "react-router-dom";
import { SONGS, SONG_BY_ID, getLemmatizer, prepareLemmatizer, songIndex } from "../../data/music";
import { isCovered, type Lemmatizer, type Token } from "../../services/lemmatize";
import { lineHash, lineKey, type LyricLine as Line } from "../../services/lyrics";
import {
  GAP_LABEL,
  GAP_MODES,
  gapMode as toGapMode,
  lookupResumeLine,
  perLineStop,
  repeatGapMs,
  selfTranslatedCount,
  type GapMode,
} from "../../services/musicPractice";
import { toKana } from "../../services/pronunciation";
import { translateLines } from "../../services/translate";
import {
  addTargetId,
  buildVocabItems,
  bulkAddCandidates,
  levelLabel,
  siblingNote,
  statusId,
  type VocabItem,
} from "../../services/songVocab";
import { YT_STATE } from "../../services/youtube";
import { isKnownForLyrics } from "../../srs/scheduler";
import { useMusic, userWordId } from "../../store/useMusic";
import { useProgress } from "../../store/useProgress";
import { useSettings } from "../../store/useSettings";
import WordSheet from "../../components/WordSheet";
import { useMusicPlayer } from "./MusicShell";
import { useSongLyrics } from "./useSongLyrics";

type TokenStatus = "none" | "plain" | "learning" | "known" | "added";

function fmtTime(sec: number): string {
  const s = Math.max(0, sec);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** t 以下で最後の行（前奏中は -1） */
function findLine(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

const TOKEN_CLS: Record<TokenStatus, string> = {
  none: "underline decoration-dotted decoration-slate-300 underline-offset-4",
  plain: "",
  added: "bg-amber-50",
  learning: "bg-amber-100",
  known: "bg-emerald-100",
};

interface LineProps {
  i: number;
  line: Line;
  tokens: Token[] | null;
  statuses: TokenStatus[] | null;
  active: boolean;
  synced: boolean;
  timeLabel: string;
  kana: string;
  showKana: boolean;
  ja: string | undefined;
  jaVisible: boolean;
  syncMode: boolean;
  repeat: boolean;
  /** この行を「自分で訳す」で訳した */
  selfDone: boolean;
  onChip: (i: number) => void;
  onToken: (i: number, j: number) => void;
  onFlip: (i: number) => void;
  onEdit: (i: number) => void;
  onProduce: (i: number) => void;
}

const LyricLine = memo(function LyricLine(p: LineProps) {
  const parts: React.ReactNode[] = [];
  if (p.tokens) {
    let pos = 0;
    p.tokens.forEach((t, j) => {
      if (t.start > pos) parts.push(p.line.text.slice(pos, t.start));
      parts.push(
        <button
          key={j}
          type="button"
          onClick={() => p.onToken(p.i, j)}
          className={`-my-1 rounded px-0.5 py-1 transition active:bg-emerald-200 ${TOKEN_CLS[p.statuses?.[j] ?? "plain"]} ${
            t.phrase ? "decoration-blue-300" : ""
          }`}
        >
          {t.text}
        </button>
      );
      pos = t.end;
    });
    if (pos < p.line.text.length) parts.push(p.line.text.slice(pos));
  } else parts.push(p.line.text);

  return (
    <div
      id={`ly-${p.i}`}
      className={`flex gap-2 rounded-xl px-1.5 py-1.5 transition ${p.active ? "bg-emerald-50 ring-1 ring-emerald-200" : ""}`}
    >
      {p.synced && (
        <button
          type="button"
          onClick={() => p.onChip(p.i)}
          title={p.syncMode ? "この行を今の再生位置に合わせる" : "この行から再生"}
          aria-label={p.syncMode ? `この行を今の再生位置に合わせる（${p.timeLabel}）` : `${p.timeLabel} から再生`}
          className={`mt-0.5 h-7 w-12 shrink-0 rounded-lg text-[11px] font-mono ${
            p.syncMode
              ? "bg-amber-400 text-white"
              : p.repeat
                ? "bg-brand-green text-white"
                : p.active
                  ? "bg-emerald-200 text-emerald-800"
                  : "bg-slate-100 text-slate-500"
          }`}
        >
          {p.timeLabel}
        </button>
      )}
      <div className="min-w-0 flex-1">
        {p.line.text ? (
          <div className={`text-[17px] leading-relaxed ${p.active ? "font-semibold text-brand-ink" : "text-slate-700"}`}>
            {parts}
          </div>
        ) : (
          <div className="py-0.5 text-slate-300">♪</div>
        )}
        {p.line.text && p.showKana && <div className="text-xs text-slate-400">{p.kana}</div>}
        {p.line.text && (
          <div className="flex items-start gap-1">
            {p.jaVisible ? (
              <div className={`flex-1 text-xs ${p.ja ? "text-slate-500" : "text-slate-300"}`}>{p.ja || "（和訳なし）"}</div>
            ) : (
              <div className="flex-1" />
            )}
            <button type="button" onClick={() => p.onFlip(p.i)} className="shrink-0 px-1 text-[11px] text-brand-blue">
              {p.jaVisible ? "訳を隠す" : "訳"}
            </button>
            {p.jaVisible && (
              <button type="button" onClick={() => p.onEdit(p.i)} className="shrink-0 px-1 text-[11px] text-slate-400" title="和訳を編集" aria-label="和訳を編集">
                ✏️
              </button>
            )}
            {/* 自分で訳す。押せる範囲は 44px、行の高さはあまり増やさない（下の余白に張り出す） */}
            <button
              type="button"
              onClick={() => p.onProduce(p.i)}
              className={`-mb-5 -mt-1 flex h-11 min-w-11 shrink-0 items-start justify-center rounded-lg pt-1 text-[11px] ${
                p.selfDone ? "font-bold text-emerald-600" : "text-slate-400"
              }`}
              title="自分で訳してから機械翻訳と比べる"
              aria-label={p.selfDone ? "自分で訳す（この行は訳しました）" : "自分で訳す"}
            >
              ✍{p.selfDone ? "✓" : ""}
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// 和訳のシート
// - edit: 保存済みの訳を直す（従来の ✏️）
// - produce: ✍ 自分で訳す。空欄で開き、送信したら機械翻訳と並べる（保存済みの機械翻訳があればそれ、
//   無ければこの1行だけ翻訳する。送信のタップからだけ呼ぶ）。自分の訳を保存するか機械翻訳を採用する
type EditorProps = { original: string; onClose: () => void } & (
  | { mode: "edit"; initial: string; onSave: (text: string) => void }
  | {
      mode: "produce";
      /** 保存済みの機械翻訳（手で直していない訳）。無ければ null */
      cachedMt: string | null;
      /** この1行だけ機械翻訳する（送信のタップから呼ぶ。失敗は例外） */
      fetchMt: (signal: AbortSignal) => Promise<string>;
      /** 自分の訳を送信した（比べる画面に進んだ） */
      onSubmit: () => void;
      onSaveOwn: (text: string) => void;
      onAdoptMt: (mt: string) => void;
    }
);

function TranslationEditor(props: EditorProps) {
  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={props.onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={props.mode === "produce" ? "自分で訳す" : "和訳を編集"}
        className="fixed inset-x-0 bottom-0 z-30 mx-auto max-h-[85vh] supports-[height:100dvh]:max-h-[85dvh] max-w-2xl overflow-y-auto rounded-t-2xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl"
      >
        {props.mode === "produce" ? <ProduceBody {...props} /> : <EditBody {...props} />}
      </div>
    </>
  );
}

function EditBody({ original, initial, onSave, onClose }: Extract<EditorProps, { mode: "edit" }>) {
  const [text, setText] = useState(initial);
  return (
    <>
      <div className="mb-1 text-xs font-bold text-slate-400">和訳を編集</div>
      <div className="mb-2 text-sm font-medium text-brand-ink">{original}</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        autoFocus
        className="w-full rounded-xl border border-slate-200 p-3 text-sm"
      />
      <div className="mt-2 flex gap-2">
        <button onClick={onClose} className="btn-ghost min-h-11 flex-1 py-2">
          キャンセル
        </button>
        <button onClick={() => onSave(text.trim())} className="btn-primary min-h-11 flex-1 py-2">
          保存
        </button>
      </div>
    </>
  );
}

type MtState = { status: "loading" } | { status: "ready"; text: string } | { status: "error"; error: string };

function ProduceBody({ original, cachedMt, fetchMt, onSubmit, onSaveOwn, onAdoptMt, onClose }: Extract<EditorProps, { mode: "produce" }>) {
  const [text, setText] = useState("");
  const [compare, setCompare] = useState(false);
  const [mt, setMt] = useState<MtState | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  // 閉じたら翻訳の通信も止める
  useEffect(() => () => ctrl.current?.abort(), []);

  function loadMt() {
    if (cachedMt) {
      setMt({ status: "ready", text: cachedMt });
      return;
    }
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setMt({ status: "loading" });
    fetchMt(c.signal).then(
      (t) => {
        if (!c.signal.aborted) setMt({ status: "ready", text: t });
      },
      (e: unknown) => {
        if (!c.signal.aborted) setMt({ status: "error", error: e instanceof Error ? e.message : "翻訳に失敗しました" });
      }
    );
  }

  function submit() {
    if (!text.trim()) return;
    setCompare(true);
    onSubmit();
    loadMt();
  }

  const mtText = mt?.status === "ready" ? mt.text.trim() : "";

  return (
    <>
      <div className="mb-1 text-xs font-bold text-slate-400">✍ 自分で訳す{compare ? " ・ 機械翻訳と比べる" : ""}</div>
      <div className="mb-2 text-sm font-medium text-brand-ink">{original}</div>
      {compare && <div className="mb-1 text-[11px] font-bold text-slate-500">あなたの訳（直してから保存できます）</div>}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={compare ? 2 : 3}
        autoFocus
        placeholder="まず自分で日本語に訳してみましょう"
        className="w-full rounded-xl border border-slate-200 p-3 text-sm"
      />
      {!compare ? (
        <div className="mt-2 flex gap-2">
          <button onClick={onClose} className="btn-ghost min-h-11 flex-1 py-2">
            キャンセル
          </button>
          <button onClick={submit} disabled={!text.trim()} className="btn-primary min-h-11 flex-1 py-2">
            機械翻訳と比べる
          </button>
        </div>
      ) : (
        <>
          <div className="mb-1 mt-2 text-[11px] font-bold text-slate-500">機械翻訳</div>
          <div className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700" aria-live="polite">
            {mt?.status === "loading" && <span className="text-slate-400">翻訳中…</span>}
            {mt?.status === "ready" && (mtText || <span className="text-slate-400">（訳が空でした）</span>)}
            {mt?.status === "error" && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-rose-500">{mt.error}</span>
                <button onClick={loadMt} className="btn-ghost min-h-11 px-3 py-1 text-xs">
                  再試行
                </button>
              </div>
            )}
          </div>
          <div className="mt-1 text-[11px] text-slate-400">意味が合っていれば十分です。言い回しの違いは気にしなくて大丈夫。</div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button onClick={() => onSaveOwn(text.trim())} disabled={!text.trim()} className="btn-primary min-h-11 py-2 text-sm">
              自分の訳を保存
            </button>
            <button onClick={() => mtText && onAdoptMt(mtText)} disabled={!mtText} className="btn-ghost min-h-11 py-2 text-sm">
              機械翻訳を採用
            </button>
          </div>
          <button onClick={onClose} className="mt-1 min-h-11 w-full text-xs text-slate-400">
            訳を保存せずに閉じる
          </button>
        </>
      )}
    </>
  );
}

/** 行の後の間の残り時間（縮んでいく帯）。間ごとに key を変えて作り直す */
function GapBar({ ms }: { ms: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    const a = el.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: ms, easing: "linear", fill: "forwards" });
    return () => a.cancel();
  }, [ms]);
  return (
    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100" aria-hidden>
      <div ref={ref} className="h-full origin-left rounded-full bg-brand-green" />
    </div>
  );
}

// ---------------------------------------------------------------------------
function VocabTab({
  lem,
  analyzed,
  videoId,
  onOpen,
}: {
  lem: Lemmatizer;
  analyzed: Token[][];
  videoId: string;
  onOpen: (tokens: Token[], index: number) => void;
}) {
  const cards = useProgress((s) => s.cards);
  const addedWords = useMusic((s) => s.addedWords);
  const userWords = useMusic((s) => s.userWords);
  const addWord = useMusic((s) => s.addWord);
  const [onlyNew, setOnlyNew] = useState(false);

  const { items, unknown } = useMemo(() => {
    // ids = 同じ意味の見出しID、allIds = 同じ綴りの見出しすべて（単語帳・カポエイラ単語帳・辞書）。
    // 学習状況・追加済み・一括追加の除外は allIds で判定する（berimbau などで2枚目のカードを作らない）
    const userById = new Map(userWords.map((u) => [u.id, u]));
    return buildVocabItems(lem, analyzed, (key) => userById.get(userWordId(key)));
  }, [lem, analyzed, userWords]);

  // 「追加済み」はこの曲で追加したかで判定（別の曲で追加した語もこの曲のデッキに入れられる）
  const songIds = useMemo(
    () => new Set(addedWords.filter((w) => w.videoId === videoId).map((w) => w.id)),
    [addedWords, videoId]
  );
  const inThisSong = (w: VocabItem) => w.allIds.some((id) => songIds.has(id));
  const shown = onlyNew ? items.filter((w) => !statusId(w, cards)) : items;
  // 一括追加は冠詞・前置詞・接続詞・目的格/再帰の代名詞を除く（o, a, do, na, pra… で枠を埋めない）。一覧からの個別追加はできる
  const candidatesToAdd = bulkAddCandidates(items, cards, songIds, 10);
  // 学習中のカードがあればそれを使う（同じ語で別のカードを作らない）
  const add = (w: VocabItem) => addWord(addTargetId(w, cards), videoId, w.surface);

  function bulkAdd() {
    if (!candidatesToAdd.length) return;
    const short = (s: string) => (s.length > 18 ? s.slice(0, 18) + "…" : s);
    const list = candidatesToAdd.map((w) => `・${w.lemma}（${w.pos}）${short(w.ja)}`).join("\n");
    const msg =
      `出現回数の多い未学習語 ${candidatesToAdd.length} 語を単語帳に追加します。\n` +
      `（冠詞・前置詞・接続詞・目的格や再帰の代名詞は除いています）\n\n${list}`;
    if (!confirm(msg)) return;
    for (const w of candidatesToAdd) add(w);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-slate-500">
          {items.length} 語{unknown.length ? ` ＋ 辞書にない語 ${unknown.length}` : ""}
        </span>
        <label className="ml-auto flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} className="accent-brand-green" />
          未学習のみ
        </label>
      </div>
      <div className="flex gap-2">
        <button onClick={bulkAdd} disabled={!candidatesToAdd.length} className="btn-ghost flex-1 py-2 text-sm">
          ＋ よく出る未学習語をまとめて追加（{candidatesToAdd.length}）
        </button>
        <Link to={`/flashcards/music:${videoId}`} className="btn-primary flex-1 py-2 text-sm">
          📇 この曲の単語で学習
        </Link>
      </div>
      <div className="card divide-y divide-slate-100">
        {shown.map((w) => {
          const sid = statusId(w, cards);
          const card = sid ? cards[sid] : undefined;
          const added = inThisSong(w);
          // 別の見出し（例: カポエイラ単語帳の berimbau）のカードで学習している
          const other = sid && card && !w.ids.includes(sid) ? siblingNote(sid, card) : null;
          return (
            <div key={w.key} className="flex items-center gap-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-brand-ink">{w.lemma}</span>
                  <span className="chip bg-slate-100 text-slate-500">{w.pos}</span>
                  <span className="text-[11px] text-slate-400">×{w.count}</span>
                </div>
                <div className="truncate text-xs text-slate-500">{w.ja}</div>
                {other && <div className="truncate text-[11px] text-slate-400">※{other}</div>}
              </div>
              {added ? (
                <span className="chip bg-emerald-50 text-emerald-600">✓ 追加済み{card ? `（${levelLabel(card)}）` : ""}</span>
              ) : (
                <div className="flex shrink-0 items-center gap-1.5">
                  {card && !other && <span className="text-[11px] text-slate-400">{levelLabel(card)}</span>}
                  <button onClick={() => add(w)} className="btn-primary px-2.5 py-1 text-xs">
                    ＋ 追加
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {shown.length === 0 && <div className="p-4 text-center text-sm text-slate-400">該当する単語はありません</div>}
      </div>
      {unknown.length > 0 && (
        <div className="space-y-1.5">
          <div className="px-1 text-xs font-bold text-slate-500">辞書にない語（タップで意味を調べて追加）</div>
          <div className="flex flex-wrap gap-1.5">
            {unknown.map((u) => (
              <button key={u.token.key} onClick={() => onOpen([u.token], 0)} className="chip bg-white text-slate-600 ring-1 ring-slate-200">
                {u.token.key}
                {u.count > 1 && <span className="ml-1 text-slate-400">×{u.count}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export default function SongView() {
  const { videoId = "" } = useParams();
  const navigate = useNavigate();
  const song = SONG_BY_ID.get(videoId);
  const player = useMusicPlayer();
  const lyr = useSongLyrics(song);
  const pauseOnWordTap = useSettings((s) => s.pauseOnWordTap);
  const replayAfterLookup = useSettings((s) => s.replayAfterLookup);

  const [lem, setLem] = useState<Lemmatizer | null>(getLemmatizer());
  useEffect(() => {
    if (!lem) prepareLemmatizer().then(setLem);
  }, [lem]);

  const prefs = useMusic((s) => s.prefs);
  const setPrefs = useMusic((s) => s.setPrefs);
  const songState = useMusic((s) => s.songs[videoId]);
  const setOffset = useMusic((s) => s.setOffset);
  const mergeTranslations = useMusic((s) => s.mergeTranslations);
  const editTranslation = useMusic((s) => s.editTranslation);
  const adoptMachineTranslation = useMusic((s) => s.adoptMachineTranslation);
  const markSelfTranslated = useMusic((s) => s.markSelfTranslated);
  const addedWords = useMusic((s) => s.addedWords);
  const cards = useProgress((s) => s.cards);

  const offsetMs = songState?.offsetMs ?? 0;
  const offsetSec = offsetMs / 1000;
  const translations = songState?.translations ?? {};
  const selfTranslated = songState?.selfTranslated;
  // 行の後の間（保存値が知らない値なら off）
  const gap = toGapMode(prefs.gapMode);

  const lines = useMemo(() => lyr.lyrics?.lines ?? [], [lyr.lyrics]);
  const synced = !!lyr.lyrics?.synced;
  const times = useMemo(() => lines.map((l) => l.t ?? 0), [lines]);
  const hasText = useMemo(() => lines.map((l) => !!l.text), [lines]);
  const analyzed = useMemo(() => (lem ? lines.map((l) => lem.analyzeLine(l.text)) : null), [lem, lines]);
  const kana = useMemo(() => lines.map((l) => (l.text ? toKana(l.text) : "")), [lines]);

  // 単語の学習状況（色分け用）。緑は isKnownForLyrics（評価済み・間隔3日以上）で、習熟度の「定着」とは別基準
  const addedSet = useMemo(() => new Set(addedWords.map((w) => w.id)), [addedWords]);
  const userIds = useMusic((s) => s.userWords);
  const statuses = useMemo<TokenStatus[][] | null>(() => {
    if (!lem || !analyzed) return null;
    const userSet = new Set(userIds.map((u) => u.id));
    const statusOf = (ids: string[]): TokenStatus => {
      // 同義の見出し（単語帳とカポエイラ単語帳の同じ語など）のどれかで覚えていれば緑
      if (ids.some((id) => isKnownForLyrics(cards[id]))) return "known";
      if (ids.some((id) => cards[id]?.last)) return "learning";
      if (ids.some((id) => addedSet.has(id))) return "added";
      return "plain";
    };
    return analyzed.map((toks) =>
      toks.map((t, j) => {
        const c = lem.lookup(t.text, { lineStart: j === 0 }).candidates[0];
        if (!c || !isCovered(c)) {
          const uid = userWordId(t.key);
          return userSet.has(uid) ? statusOf([uid]) : "none";
        }
        if (!c.refs.length) return "plain";
        return statusOf(c.refs.map((r) => r.id));
      })
    );
  }, [lem, analyzed, cards, addedSet, userIds]);

  const isCurrent = player.currentVideoId === videoId;
  const playing = isCurrent && player.playerState === YT_STATE.PLAYING;

  const [tab, setTab] = useState<"lyrics" | "words">("lyrics");
  const [activeIdx, setActiveIdx] = useState(-1);
  // line = 単語を開いた歌詞の行（単語タブから開いたときは null）
  const [sheet, setSheet] = useState<{ tokens: Token[]; index: number; line: number | null } | null>(null);
  const [editing, setEditing] = useState<{ i: number; mode: "edit" | "produce" } | null>(null);
  const [repeatIdx, setRepeatIdx] = useState<number | null>(null);
  const [stopPerLine, setStopPerLine] = useState(false);
  const [syncMode, setSyncMode] = useState(false);
  const [follow, setFollow] = useState(true);
  const [showJaAll, setShowJaAll] = useState(prefs.showJa);
  const [jaFlips, setJaFlips] = useState<Set<number>>(new Set());
  const [menu, setMenu] = useState(false);
  const [tr, setTr] = useState<{ busy: boolean; error: string | null; redo: boolean }>({ busy: false, error: null, redo: false });
  const [rates, setRates] = useState<number[]>([]);
  // 行の後の間の待ち（帯の表示用。id は間ごとに変える）
  const [gapWait, setGapWait] = useState<{ id: number; ms: number } | null>(null);

  const resumeRef = useRef(false);
  const overlayRef = useRef(false);
  const seekGuard = useRef(0);
  const activeRef = useRef(-1);
  const lastIdxRef = useRef(-1);
  /** 行の後の間のあとで再生を再開するタイマー（予約中は位置のポーリングを休む） */
  const gapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 行の後の間の予約を取り消す（ユーザーの操作・曲の切り替え・アンマウント） */
  const clearGap = useCallback(() => {
    if (gapTimer.current == null) return;
    clearTimeout(gapTimer.current);
    gapTimer.current = null;
    setGapWait(null);
  }, []);

  /** ms 後に再生を再開する（その間に言い返す）。画面が隠れていたら再開しない */
  const startGap = useCallback(
    (ms: number) => {
      if (gapTimer.current != null) clearTimeout(gapTimer.current);
      gapTimer.current = setTimeout(() => {
        gapTimer.current = null;
        setGapWait(null);
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        seekGuard.current = performance.now() + 500;
        player.play();
      }, ms);
      setGapWait({ id: performance.now(), ms });
    },
    [player]
  );

  // 曲が変わったら状態をリセット
  useEffect(() => {
    setActiveIdx(-1);
    activeRef.current = -1;
    lastIdxRef.current = -1;
    resumeRef.current = false;
    setRepeatIdx(null);
    setSheet(null);
    setEditing(null);
    setSyncMode(false);
    setJaFlips(new Set());
    setFollow(true);
    setTr({ busy: false, error: null, redo: false });
    window.scrollTo({ top: 0 });
  }, [videoId]);

  // 曲が変わった・プレーヤーの曲が替わったら、行の後の間の予約を取り消す
  useEffect(() => {
    clearGap();
  }, [videoId, player.currentVideoId, clearGap]);
  // 間の途中に（動画の画面などから）再生が始まったら予約を取り消す
  useEffect(() => {
    if (player.playerState === YT_STATE.PLAYING) clearGap();
  }, [player.playerState, clearGap]);
  // アンマウント時（state は触らない）
  useEffect(
    () => () => {
      if (gapTimer.current != null) clearTimeout(gapTimer.current);
      gapTimer.current = null;
    },
    []
  );

  // 単語シート・和訳編集中は自動追従しない
  overlayRef.current = !!sheet || editing != null;
  useEffect(() => {
    player.setBusy(!!sheet || editing != null);
    return () => player.setBusy(false);
  }, [sheet, editing, player]);

  useEffect(() => {
    if (player.ready && isCurrent) setRates(player.getRates());
  }, [player, isCurrent, player.ready]);

  // 再生位置のポーリング（行が変わった時だけ state 更新）
  const durationSec = song?.durationSec ?? 0;
  const liveNow = { times, hasText, offsetSec, repeatIdx, stopPerLine, playerState: player.playerState, durationSec, gapMode: gap, rate: prefs.rate };
  const live = useRef(liveNow);
  live.current = liveNow;

  /** 行の頭へ移って再生する。forcePlay は一時停止の直後（状態の通知がまだ来ていない）でも確実に再生するため */
  const seekLine = useCallback(
    (i: number, forcePlay = false) => {
      const t = live.current.times[i];
      if (t == null) return;
      player.seek(t + live.current.offsetSec);
      seekGuard.current = performance.now() + 500;
      activeRef.current = i;
      lastIdxRef.current = i;
      setActiveIdx(i);
      if (forcePlay || live.current.playerState !== YT_STATE.PLAYING) player.play();
    },
    [player]
  );

  useEffect(() => {
    if (!synced || !isCurrent) return;
    const fast = repeatIdx != null || stopPerLine;
    const id = setInterval(
      () => {
        const s = live.current;
        // 行の後の間（自動で再開するまで待つ）
        if (gapTimer.current != null) return;
        if (s.playerState !== YT_STATE.PLAYING) return;
        if (performance.now() < seekGuard.current) return;
        const t = player.getTime() - s.offsetSec;
        const idx = findLine(s.times, t);
        if (s.repeatIdx != null) {
          const r = s.repeatIdx;
          const start = s.times[r];
          // 最終行は次の行が無いので、動画の終わり（または20秒後）を行末とみなす
          const videoEnd = (player.getDuration() || s.durationSec) - s.offsetSec - 0.4;
          const end = s.times[r + 1] ?? Math.min(start + 20, videoEnd > start ? videoEnd : start + 20);
          if (t >= end - 0.08) {
            // 行末: 間があれば行の頭で止めて待ってから繰り返す（その間に言い返す）。無ければすぐ頭へ
            const ms = repeatGapMs(end - start, s.hasText[r], s.gapMode, s.rate);
            if (ms > 0) {
              player.pause();
              player.seek(start + s.offsetSec);
              seekGuard.current = performance.now() + 500;
              activeRef.current = r;
              lastIdxRef.current = r;
              setActiveIdx(r);
              startGap(ms);
            } else seekLine(r);
            return;
          }
          if (t < start - 1.5) {
            seekLine(r);
            return;
          }
        } else if (s.stopPerLine && lastIdxRef.current >= 0 && idx > lastIdxRef.current) {
          // 次の行に入ったら、その行の頭で止める（再開すると次の行を最初から聴ける）。
          // 間ありなら、聴いた行の長さ×係数だけ待って自動で再開する（前奏・間奏の行では止めない）
          const prev = lastIdxRef.current;
          const stop = perLineStop(s.times[idx] - s.times[prev], s.hasText[prev], s.gapMode, s.rate);
          if (stop.kind !== "continue") {
            player.pause();
            player.seek(s.times[idx] + s.offsetSec);
            seekGuard.current = performance.now() + 500;
          }
          if (stop.kind === "gap") {
            // 間の間は聴いた行をハイライトしたまま（再開後のポーリングで次の行へ移る）
            lastIdxRef.current = idx;
            startGap(stop.ms);
            return;
          }
        }
        lastIdxRef.current = idx;
        if (idx !== activeRef.current) {
          activeRef.current = idx;
          setActiveIdx(idx);
        }
      },
      fast ? 100 : 200
    );
    return () => clearInterval(id);
  }, [synced, isCurrent, repeatIdx, stopPerLine, player, seekLine, startGap]);

  // 自動スクロール（sticky 部分の下、見えている範囲の上から3割の位置へ）
  const scrollToLine = useCallback(
    (i: number, smooth = true) => {
      const el = document.getElementById(`ly-${i}`);
      if (!el) return;
      const stickyBottom = player.stickyEl?.getBoundingClientRect().bottom ?? 0;
      const avail = window.innerHeight - stickyBottom - 64;
      const top = el.getBoundingClientRect().top + window.scrollY - stickyBottom - avail * 0.3;
      window.scrollTo({ top: Math.max(0, top), behavior: smooth ? "smooth" : "auto" });
    },
    [player.stickyEl]
  );

  useEffect(() => {
    if (activeIdx < 0 || !prefs.autoScroll || !follow || tab !== "lyrics" || sheet || editing != null) return;
    scrollToLine(activeIdx);
  }, [activeIdx, prefs.autoScroll, follow, tab, sheet, editing, scrollToLine]);

  // 手動スクロールの意図（ホイール・スワイプ・キー）で自動追従を止める
  useEffect(() => {
    if (!prefs.autoScroll) return;
    const inOverlay = (e: Event) =>
      overlayRef.current || !!(e.target as Element | null)?.closest?.("[role=dialog],textarea,input,select");
    const stop = (e: Event) => {
      if (!inOverlay(e)) setFollow(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) stop(e);
    };
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("touchmove", stop, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", stop);
      window.removeEventListener("touchmove", stop);
      window.removeEventListener("keydown", onKey);
    };
  }, [prefs.autoScroll]);

  // ---------------- 操作 ----------------
  /** line = 単語をタップした歌詞の行（単語タブからは null） */
  const openSheet = useCallback(
    (tokens: Token[], index: number, line: number | null = null) => {
      // 行の後の間で待っている（止まっていて自動で再開する予定）ときも「再生中」とみなし、閉じたら再開する
      if (pauseOnWordTap && isCurrent && (live.current.playerState === YT_STATE.PLAYING || gapTimer.current != null)) {
        clearGap();
        player.pause();
        resumeRef.current = true;
      }
      setSheet({ tokens, index, line });
    },
    [pauseOnWordTap, player, isCurrent, clearGap]
  );
  const sheetLineRef = useRef<number | null>(null);
  sheetLineRef.current = sheet?.line ?? null;
  const closeSheet = useCallback(() => {
    const line = sheetLineRef.current;
    setSheet(null);
    if (!resumeRef.current) return;
    resumeRef.current = false;
    // 調べるために止めた → 調べた行の頭から聴き直す（設定・時間同期のある歌詞のとき）。それ以外は止めた位置から
    const target = lookupResumeLine({
      replay: replayAfterLookup,
      synced,
      isCurrent,
      line,
      lineCount: live.current.times.length,
      repeatIdx: live.current.repeatIdx,
    });
    if (target == null) player.play();
    else seekLine(target, true);
  }, [player, replayAfterLookup, synced, isCurrent, seekLine]);

  const analyzedRef = useRef(analyzed);
  analyzedRef.current = analyzed;
  const onToken = useCallback(
    (i: number, j: number) => {
      const toks = analyzedRef.current?.[i];
      if (toks) openSheet(toks, j, i);
    },
    [openSheet]
  );

  const syncRef = useRef({ syncMode, isCurrent, repeatIdx });
  syncRef.current = { syncMode, isCurrent, repeatIdx };
  const onChip = useCallback(
    (i: number) => {
      const s = syncRef.current;
      clearGap();
      if (!s.isCurrent) {
        player.playSong(videoId);
        return;
      }
      if (s.syncMode) {
        // この行が「今」歌われている → オフセット = 現在位置 − 行の時刻
        setOffset(videoId, Math.round((player.getTime() - live.current.times[i]) * 1000));
        setSyncMode(false);
        return;
      }
      if (s.repeatIdx != null) setRepeatIdx(i);
      setFollow(true);
      seekLine(i, true);
    },
    [player, videoId, setOffset, seekLine, clearGap]
  );
  const onFlip = useCallback(
    (i: number) =>
      setJaFlips((s) => {
        const n = new Set(s);
        n.has(i) ? n.delete(i) : n.add(i);
        return n;
      }),
    []
  );
  // 和訳のシートを開いたら、行の後の間の自動再開は取り消す（書いている間に曲が進まないように）
  const onEdit = useCallback(
    (i: number) => {
      clearGap();
      setEditing({ i, mode: "edit" });
    },
    [clearGap]
  );
  const onProduce = useCallback(
    (i: number) => {
      clearGap();
      setEditing({ i, mode: "produce" });
    },
    [clearGap]
  );

  function goSong(dir: 1 | -1) {
    clearGap();
    const i = songIndex(videoId);
    const n = SONGS.length;
    const target = SONGS[((i < 0 ? 0 : i) + dir + n) % n];
    player.playSong(target.videoId);
    navigate(`/music/${target.videoId}`, { replace: true });
  }

  function togglePlay() {
    // 行の後の間の途中なら、待たずにすぐ再開する
    clearGap();
    if (!isCurrent) player.playSong(videoId);
    else if (playing) player.pause();
    else player.play();
  }

  function rewindLine() {
    clearGap();
    const i = activeRef.current >= 0 ? activeRef.current : 0;
    seekLine(i, true);
  }

  function toggleRepeat() {
    clearGap();
    if (repeatIdx != null) setRepeatIdx(null);
    else {
      const i = activeRef.current >= 0 ? activeRef.current : 0;
      setRepeatIdx(i);
      setStopPerLine(false);
    }
  }

  function toggleStopPerLine() {
    clearGap();
    setStopPerLine((v) => !v);
    setRepeatIdx(null);
  }

  function setSpeed(r: number) {
    player.setRate(r);
  }

  /** 行の後の間を変える。なしにしたら待っている間の自動再開も取り消す（×1 ⇄ ×1.5 は次の行から） */
  function changeGap(m: GapMode) {
    if (m === "off") clearGap();
    setPrefs({ gapMode: m });
  }

  // ---------------- 和訳 ----------------
  // 和訳は行テキストのハッシュで保存（歌詞本文を保存・バックアップに残さない）
  const lineKeys = useMemo(() => lines.map((l) => (l.text ? lineHash(l.text) : "")), [lines]);
  const keyText = useMemo(() => {
    const m = new Map<string, string>();
    lines.forEach((l, i) => l.text && m.set(lineKeys[i], lineKey(l.text)));
    return m;
  }, [lines, lineKeys]);
  const uniqueKeys = useMemo(() => [...keyText.keys()], [keyText]);
  const missing = uniqueKeys.filter((k) => !translations[k]?.text);
  // 自分で訳した行（同じ歌詞の行は1行と数える）
  const selfCount = useMemo(() => selfTranslatedCount(uniqueKeys, selfTranslated), [uniqueKeys, selfTranslated]);

  /**
   * ✍ 自分で訳す: この1行だけ機械翻訳する（送信のタップから呼ぶ）。
   * 未翻訳の行ならこの訳を保存する（mergeTranslations は手で直した行を上書きしない）
   */
  async function fetchLineMt(key: string, signal: AbortSignal): Promise<string> {
    const text = keyText.get(key);
    if (!text) throw new Error("この行は翻訳できません");
    const [out = ""] = await translateLines([text], signal);
    if (out.trim()) mergeTranslations(videoId, { [key]: out });
    return out;
  }

  async function makeTranslation(redo: boolean, retry = false) {
    const keys = redo ? uniqueKeys.filter((k) => !translations[k]?.edited) : missing;
    if (!keys.length) {
      setTr({ busy: false, error: null, redo: false });
      return;
    }
    if (redo && !retry && !confirm("機械翻訳で作り直します（自分で編集した行はそのまま残ります）。")) return;
    setTr({ busy: true, error: null, redo });
    try {
      const out = await translateLines(keys.map((k) => keyText.get(k)!));
      mergeTranslations(videoId, Object.fromEntries(keys.map((k, i) => [k, out[i]])));
      setTr({ busy: false, error: null, redo: false });
      setShowJaAll(true);
      setPrefs({ showJa: true });
    } catch (e) {
      setTr({ busy: false, error: e instanceof Error ? e.message : "翻訳に失敗しました", redo });
    }
  }

  if (!song) {
    return (
      <div className="card p-6 text-center text-slate-500">
        曲が見つかりません。
        <div className="mt-3">
          <Link to="/music" className="text-brand-green">
            ‹ 一覧へ
          </Link>
        </div>
      </div>
    );
  }

  const rate = prefs.rate;
  const has075 = rates.length === 0 || rates.includes(0.75);

  const transport =
    isCurrent && player.transportSlot
      ? createPortal(
          <div className="border-b border-slate-200 bg-white/95 backdrop-blur">
            <div className="flex items-center gap-1 px-2 py-1.5 text-sm">
              <button onClick={rewindLine} disabled={!synced} className="rounded-lg px-2 py-1.5 text-slate-600 disabled:opacity-30" title="今の行の頭へ" aria-label="今の行の頭へ">
                ⏪
              </button>
              <button onClick={togglePlay} className="btn-primary h-9 w-11 px-0 py-0" title={playing ? "一時停止" : "再生"} aria-label={playing ? "一時停止" : "再生"}>
                {playing ? "❚❚" : "▶"}
              </button>
              <button
                onClick={toggleRepeat}
                disabled={!synced}
                className={`rounded-lg px-2 py-1.5 text-xs font-bold disabled:opacity-30 ${repeatIdx != null ? "bg-brand-green text-white" : "text-slate-600"}`}
                title="今の行を繰り返す"
                aria-label="今の行を繰り返す"
                aria-pressed={repeatIdx != null}
              >
                🔁行
              </button>
              <button
                onClick={toggleStopPerLine}
                disabled={!synced}
                className={`rounded-lg px-2 py-1.5 text-xs font-bold disabled:opacity-30 ${stopPerLine ? "bg-brand-green text-white" : "text-slate-600"}`}
                title="1行ごとに一時停止（リピート練習・シャドーイング用）"
                aria-label="1行ごとに一時停止"
                aria-pressed={stopPerLine}
              >
                ⏸1行
              </button>
              <button
                onClick={() => setSpeed(rate === 0.75 ? 1 : 0.75)}
                disabled={!has075}
                className={`rounded-lg px-2 py-1.5 text-xs font-bold disabled:opacity-30 ${rate === 0.75 ? "bg-brand-green text-white" : "text-slate-600"}`}
                title="ゆっくり再生"
                aria-label="0.75倍速で再生"
                aria-pressed={rate === 0.75}
              >
                0.75x
              </button>
              <div className="relative ml-auto" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => setMenu((v) => !v)} className="rounded-lg px-2 py-1.5 text-xs font-bold text-slate-600">
                  表示▾
                </button>
                {menu && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-44 space-y-2 rounded-xl bg-white p-3 text-sm shadow-lg ring-1 ring-slate-200">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked={prefs.showKana} onChange={(e) => setPrefs({ showKana: e.target.checked })} className="accent-brand-green" />
                      カナ
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={showJaAll}
                        onChange={(e) => {
                          setShowJaAll(e.target.checked);
                          setJaFlips(new Set());
                          setPrefs({ showJa: e.target.checked });
                        }}
                        className="accent-brand-green"
                      />
                      和訳
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={prefs.autoScroll}
                        onChange={(e) => {
                          setPrefs({ autoScroll: e.target.checked });
                          setFollow(true);
                        }}
                        className="accent-brand-green"
                      />
                      自動スクロール
                    </label>
                  </div>
                )}
              </div>
            </div>
            {/* 行の後の間（1行停止・行リピートのときだけ）。歌った長さ×係数だけ止めて自動で再開する */}
            {synced && (stopPerLine || repeatIdx != null) && (
              <div className="flex items-center gap-2 border-t border-slate-100 px-2 py-0.5 text-xs">
                <span className="shrink-0 text-slate-500">{repeatIdx != null ? "繰り返す前に間" : "行の後に間"}</span>
                <div role="radiogroup" aria-label="行の後の間（歌った長さの何倍か）" className="flex shrink-0 rounded-lg bg-slate-100">
                  {GAP_MODES.map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={gap === m}
                      onClick={() => changeGap(m)}
                      className={`min-h-11 min-w-11 rounded-lg px-2.5 ${gap === m ? "bg-brand-green font-bold text-white" : "text-slate-600"}`}
                    >
                      {GAP_LABEL[m]}
                    </button>
                  ))}
                </div>
                {gapWait ? (
                  <GapBar key={gapWait.id} ms={gapWait.ms} />
                ) : (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-slate-400">
                    {gap !== "off" ? "止まっている間に声に出して" : stopPerLine ? "▶ で次の行へ" : ""}
                  </span>
                )}
              </div>
            )}
          </div>,
          player.transportSlot
        )
      : null;

  const editingKey = editing != null ? lineKeys[editing.i] : null;

  return (
    <div className="animate-fade-in space-y-3 pb-4" onClick={() => menu && setMenu(false)}>
      {transport}

      {/* 曲情報・曲送り */}
      <div className="flex items-center gap-2">
        <Link to="/music" className="shrink-0 text-sm text-brand-green">
          ‹ 一覧
        </Link>
        <div className="min-w-0 flex-1 text-center">
          <h1 className="truncate text-base font-bold text-brand-ink">{song.title}</h1>
          <div className="truncate text-xs text-slate-500">{song.artist}</div>
        </div>
        <button onClick={() => goSong(-1)} className="rounded-lg px-2 py-1 text-slate-500" title="前の曲" aria-label="前の曲">
          ⏮
        </button>
        <button onClick={() => goSong(1)} className="rounded-lg px-2 py-1 text-slate-500" title="次の曲" aria-label="次の曲">
          ⏭
        </button>
      </div>

      {!isCurrent && (
        <button onClick={() => player.playSong(videoId)} className="btn-primary w-full py-3">
          ▶ この曲を再生
        </button>
      )}

      {/* 再生モード・同期調整 */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <div className="flex items-center rounded-lg bg-slate-100 p-0.5">
          {(
            [
              ["all", "➡ 連続"],
              ["one", "🔂 1曲"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setPrefs({ playMode: m })}
              className={`rounded px-2 py-1 ${prefs.playMode === m ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {synced && (
          <div className="ml-auto flex items-center gap-1">
            <span className="text-slate-400">同期</span>
            <button onClick={() => setOffset(videoId, offsetMs - 500)} className="rounded bg-slate-100 px-1.5 py-1">
              −0.5s
            </button>
            <span className="w-12 text-center font-mono text-slate-600">
              {offsetMs >= 0 ? "+" : ""}
              {(offsetMs / 1000).toFixed(1)}s
            </span>
            <button onClick={() => setOffset(videoId, offsetMs + 500)} className="rounded bg-slate-100 px-1.5 py-1">
              +0.5s
            </button>
            <button
              onClick={() => setSyncMode((v) => !v)}
              disabled={!isCurrent}
              className={`rounded px-1.5 py-1 disabled:opacity-30 ${syncMode ? "bg-amber-400 font-bold text-white" : "bg-slate-100"}`}
              title="歌われている行の時刻をタップして合わせる"
            >
              ⏱合わせる
            </button>
            {offsetMs !== 0 && (
              <button onClick={() => setOffset(videoId, 0)} className="px-1 text-slate-400 underline">
                戻す
              </button>
            )}
          </div>
        )}
      </div>
      {syncMode && (
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          いま歌われている行の時刻ボタンをタップすると、歌詞のタイミングをその位置に合わせます。
        </div>
      )}

      {/* 和訳 */}
      {lyr.status === "ready" && (
        <div className="flex flex-wrap items-center gap-2">
          {missing.length > 0 ? (
            <button onClick={() => makeTranslation(false)} disabled={tr.busy} className="btn-ghost flex-1 py-2 text-sm">
              {tr.busy ? "翻訳中…" : `🌐 和訳を作成（機械翻訳・${missing.length}行）`}
            </button>
          ) : (
            <button onClick={() => makeTranslation(true)} disabled={tr.busy} className="text-xs text-slate-400 underline">
              {tr.busy ? "翻訳中…" : "機械翻訳で作り直す"}
            </button>
          )}
          {uniqueKeys.length > 0 && (
            <span className={`chip ml-auto ${selfCount ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
              ✍ 自分で訳した行 {selfCount}/{uniqueKeys.length}
            </span>
          )}
          {tr.error && (
            <div className="w-full text-xs text-rose-500">
              {tr.error}
              <button onClick={() => makeTranslation(tr.redo, true)} className="ml-2 underline">
                再試行
              </button>
            </div>
          )}
          {uniqueKeys.length > 0 && selfCount === 0 && tab === "lyrics" && (
            <div className="w-full text-[11px] text-slate-400">
              各行の ✍ で、自分で訳してから機械翻訳と比べられます（和訳を隠しておくと練習になります）。
            </div>
          )}
        </div>
      )}

      {/* タブ */}
      <div className="grid grid-cols-2 rounded-xl bg-slate-100 p-1 text-sm">
        {(
          [
            ["lyrics", "歌詞"],
            ["words", "単語"],
          ] as const
        ).map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg py-1.5 ${tab === t ? "bg-white font-bold text-brand-ink shadow-sm" : "text-slate-500"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 本文 */}
      {lyr.status === "loading" && (
        <div className="space-y-3 py-2">
          {[70, 55, 80, 60, 75, 50].map((w, i) => (
            <div key={i} className="h-4 animate-pulse rounded bg-slate-200" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}
      {lyr.status === "instrumental" && <div className="card p-6 text-center text-slate-500">🎼 インストゥルメンタル（歌詞なし）</div>}
      {(lyr.status === "notfound" || lyr.status === "error") && (
        <div className="card space-y-2 p-6 text-center text-sm text-slate-500">
          <div>{lyr.error ?? "歌詞が見つかりませんでした"}</div>
          <button onClick={lyr.retry} className="btn-ghost px-4 py-1.5 text-sm">
            再試行
          </button>
        </div>
      )}

      {lyr.status === "ready" && tab === "lyrics" && (
        <div className="space-y-0.5">
          {!synced && (
            <div className="rounded-lg bg-slate-100 px-3 py-2 text-xs text-slate-500">
              この曲は時間同期のない歌詞です（行ハイライト・自動スクロールはありません）。
            </div>
          )}
          {lines.map((l, i) => {
            const ja = l.text ? translations[lineKeys[i]]?.text : undefined;
            // ✍ で訳している行は、答えが見えないように和訳を隠す
            const producing = editing?.mode === "produce" && editing.i === i;
            const jaVisible = (showJaAll ? !jaFlips.has(i) : jaFlips.has(i)) && !producing;
            return (
              <LyricLine
                key={i}
                i={i}
                line={l}
                tokens={analyzed?.[i] ?? null}
                statuses={statuses?.[i] ?? null}
                active={i === activeIdx && isCurrent}
                synced={synced}
                timeLabel={fmtTime(times[i] + offsetSec)}
                kana={kana[i]}
                showKana={prefs.showKana}
                ja={ja}
                jaVisible={jaVisible}
                syncMode={syncMode}
                repeat={repeatIdx === i}
                selfDone={!!l.text && selfTranslated?.[lineKeys[i]] === true}
                onChip={onChip}
                onToken={onToken}
                onFlip={onFlip}
                onEdit={onEdit}
                onProduce={onProduce}
              />
            );
          })}
          <div className="pt-4 text-center text-[11px] text-slate-400">
            歌詞: <a href="https://lrclib.net" target="_blank" rel="noreferrer" className="underline">LRCLIB</a>
            （端末で取得・アプリには同梱していません）
          </div>
        </div>
      )}

      {lyr.status === "ready" && tab === "words" && (
        lem && analyzed ? (
          <VocabTab lem={lem} analyzed={analyzed} videoId={videoId} onOpen={openSheet} />
        ) : (
          <div className="py-6 text-center text-sm text-slate-400">辞書を準備中…</div>
        )
      )}

      {/* 現在行へ */}
      {!follow && isCurrent && synced && tab === "lyrics" && prefs.autoScroll && (
        <button
          onClick={() => {
            setFollow(true);
            if (activeRef.current >= 0) scrollToLine(activeRef.current);
          }}
          className="btn-primary fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-[max(1rem,calc((100vw-42rem)/2+1rem))] z-[25] px-3 py-2 text-sm shadow-lg"
        >
          ⤵ 現在行へ
        </button>
      )}

      {sheet && (
        <WordSheet
          tokens={sheet.tokens}
          index={sheet.index}
          videoId={videoId}
          onClose={closeSheet}
          onMove={(i) => setSheet((s) => (s && i >= 0 && i < s.tokens.length ? { ...s, index: i } : s))}
        />
      )}

      {editing != null && editingKey && editing.mode === "edit" && (
        <TranslationEditor
          key={`e:${editing.i}`}
          mode="edit"
          original={lines[editing.i].text}
          initial={translations[editingKey]?.text ?? ""}
          onClose={() => setEditing(null)}
          onSave={(text) => {
            editTranslation(videoId, editingKey, text);
            setEditing(null);
          }}
        />
      )}
      {editing != null && editingKey && editing.mode === "produce" && (
        <TranslationEditor
          key={`p:${editing.i}`}
          mode="produce"
          original={lines[editing.i].text}
          // 保存済みの機械翻訳（手で直した訳は機械翻訳ではないので使わない）
          cachedMt={translations[editingKey] && !translations[editingKey].edited && translations[editingKey].text ? translations[editingKey].text : null}
          fetchMt={(signal) => fetchLineMt(editingKey, signal)}
          onSubmit={() => markSelfTranslated(videoId, editingKey)}
          onClose={() => setEditing(null)}
          onSaveOwn={(text) => {
            editTranslation(videoId, editingKey, text);
            setEditing(null);
          }}
          onAdoptMt={(mt) => {
            adoptMachineTranslation(videoId, editingKey, mt);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
