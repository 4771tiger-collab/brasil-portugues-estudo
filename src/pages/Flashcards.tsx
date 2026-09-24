import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ALL_DECKS, deckTitle, resolveDeckWords, reviewPool } from "../data/loadWords";
import { SONG_BY_ID } from "../data/music";
import type { Rating, StudyViewMode, Word } from "../data/types";
import { todayCounters, useProgress } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { useAddedIds, useMusic, useUserWordMap } from "../store/useMusic";
import { countReview } from "../srs/queue";
import { isHeld, newCard, todayStr } from "../srs/scheduler";
import { MAX_REQUEUE } from "../srs/session";
import { recogItem, type StudyItem } from "../srs/cardKey";
import { audio } from "../services/audio";
import { useToday } from "../hooks/useToday";
import { planToday, useTodayPlan } from "../hooks/useTodayPlan";
import { useWakeLock } from "../hooks/useWakeLock";
import Flashcard, { type RatedInfo } from "../components/Flashcard";
import ReviewSession from "../components/ReviewSession";
import HandsfreePlayer from "../components/HandsfreePlayer";
import SessionComplete, { useForecast } from "../components/SessionComplete";
import UndoToast from "../components/UndoToast";
import { RATING_LABEL } from "../components/RatingButtons";

const SPEEDS = [0.8, 1.0, 1.2];

// ============================ デッキ選択 ============================
function DeckPicker() {
  const today = useToday();
  const cards = useProgress((s) => s.cards);
  const addedIds = useAddedIds();
  const addedWords = useMusic((s) => s.addedWords);
  // 数字は実際に始めるセッションと同じ計算（復習の上限・新しい語の選び方・同じ綴りは1日1枚）
  const plan = useTodayPlan();
  const due = plan.review.length;
  const newCount = plan.fresh.length;
  const musicNew = plan.added.length;
  // 和→葡の産出カード（期限の来たもの＋新しく始めるもの）
  const prodCount = plan.prodReview.length + plan.prodFresh.length;

  const decks = ALL_DECKS.map((d, i) => ({ ...d, i }));
  const sections: { source: "words" | "capoeira"; title: string }[] = [
    { source: "words", title: "一般語彙" },
    { source: "capoeira", title: "カポエイラ" },
  ];

  // 曲ごとの追加語
  const songDecks = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const w of addedWords) {
      if (!m.has(w.videoId)) m.set(w.videoId, new Set());
      m.get(w.videoId)!.add(w.id);
    }
    return [...m.entries()].map(([videoId, ids]) => ({ videoId, ids: [...ids], song: SONG_BY_ID.get(videoId) }));
  }, [addedWords]);

  return (
    <div className="animate-fade-in space-y-5">
      <h1 className="text-xl font-bold text-brand-ink">単語帳</h1>

      <Link to="/flashcards/today" className="card block bg-gradient-to-br from-brand-green to-emerald-600 p-4 text-white">
        <div className="text-sm opacity-90">今日の学習（おすすめ）</div>
        <div className="mt-1 text-2xl font-extrabold">
          復習 {due} ＋ 新規 {newCount}
          {musicNew > 0 && <span> ＋ 🎵 {musicNew}</span>}
          {prodCount > 0 && <span> ＋ ✍ {prodCount}</span>}
        </div>
        {prodCount > 0 && <div className="mt-0.5 text-xs opacity-90">✍ = 日本語からポルトガル語を言う産出カード</div>}
        <div className="mt-1 text-xs opacity-90">
          {plan.reason === "backlog"
            ? `復習が溜まっているため、新しい語はお休み中です（期限の来た復習 ${plan.dueTotal}語）›`
            : "間隔反復で最適な順に出題します ›"}
        </div>
      </Link>

      {/* 曲の単語 */}
      <section className="space-y-2">
        <h2 className="px-1 text-sm font-bold text-slate-500">🎵 曲の単語</h2>
        {addedIds.length === 0 ? (
          <Link to="/music" className="card block p-3 text-sm text-slate-500">
            音楽タブで歌詞の単語をタップして追加しましょう ›
          </Link>
        ) : (
          <div className="space-y-2">
            <Link to="/flashcards/music" className="card flex items-center gap-3 p-3 transition hover:ring-brand-green/40">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-brand-ink">すべての曲の単語</div>
                <div className="text-xs text-slate-400">
                  {addedIds.length}語 ・ 学習済み {addedIds.filter((id) => cards[id]?.last).length}
                </div>
              </div>
              <span className="text-slate-300">›</span>
            </Link>
            {songDecks.map((d) => (
              <Link
                key={d.videoId}
                to={`/flashcards/music:${d.videoId}`}
                className="card flex items-center gap-3 p-3 transition hover:ring-brand-green/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-brand-ink">{d.song?.title ?? d.videoId}</div>
                  <div className="text-xs text-slate-400">
                    {d.song?.artist ? `${d.song.artist} ・ ` : ""}
                    {d.ids.length}語
                  </div>
                </div>
                <span className="text-slate-300">›</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {sections.map((sec) => (
        <section key={sec.source} className="space-y-2">
          <h2 className="px-1 text-sm font-bold text-slate-500">{sec.title}</h2>
          <div className="space-y-2">
            {decks
              .filter((d) => d.source === sec.source)
              .map((d) => {
                const deckDue = countReview(d.words, cards, today);
                const learned = d.words.filter((w) => cards[w.id]).length;
                return (
                  <Link
                    key={d.id}
                    to={`/flashcards/${d.i}`}
                    className="card flex items-center gap-3 p-3 transition hover:ring-brand-green/40"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-brand-ink">
                        {d.category}
                        {d.totalParts > 1 && <span className="text-slate-400"> ({d.part}/{d.totalParts})</span>}
                      </div>
                      <div className="text-xs text-slate-400">
                        {d.words.length}語 ・ 学習済み {learned}
                      </div>
                    </div>
                    {deckDue > 0 && (
                      <span className="chip bg-orange-100 font-bold text-orange-600">復習{deckDue}</span>
                    )}
                    <span className="text-slate-300">›</span>
                  </Link>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ============================ 学習画面 ============================
/**
 * 出題するカードを確定し、表示（1枚ずつ / 一覧）を選ぶ。
 * カードは mount 時に1回だけ決める（学習中に並びが変わらないよう固定）。URL が変わったら
 * Flashcards 側の key で作り直す（「あと5語」の ?cap=… など）。
 * 今日の学習は和→葡の産出カード（T2-1）も含む（plan.items）。産出カードは1枚ずつ学習でだけ出し、
 * 一覧表示と耳だけ復習は理解カード（語）だけを扱う。評価の記録はカードキーで持つ。
 */
function StudyView({ deckId }: { deckId: string }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const today = useToday();
  const cards = useProgress((s) => s.cards);
  const daily = todayCounters(useProgress((s) => s.daily));
  const studyViewSetting = useSettings((s) => s.studyView);
  const addedWords = useMusic((s) => s.addedWords);
  const userMap = useUserWordMap();

  const isToday = deckId === "today";
  const isMusicDeck = deckId === "music" || deckId.startsWith("music:");
  // 完了画面の「あと5語」で来たとき: 今日の新規語の上限を cap 語まで広げる（今日の学習のみ・d が今日のときだけ）。
  // 増やす数ではなく上限そのものを持つので、戻る・再読み込みで同じ URL を開き直しても、使い切った分は増えない
  const capParam = isToday ? searchParams.get("cap") : null;
  const capDate = isToday ? searchParams.get("d") : null;

  // 出題するカードと、新しい語を止めた理由（今日の学習のみ）
  const { items, reason } = useMemo<{ items: StudyItem[]; reason?: "backlog" }>(() => {
    if (isToday) {
      const addedIds = [...new Set(addedWords.map((w) => w.id))];
      const settings = useSettings.getState();
      // 「あと5語」の上限。別の日の URL（タブの復元など）や既定の上限以下の値は無視し、
      // 書き換えた URL でも今の導入数 +50 語までにとどめる
      const cap = Math.floor(Number(capParam));
      const newLimit =
        capParam !== null && capDate === todayStr() && Number.isFinite(cap) && cap > settings.dailyNewLimit
          ? Math.min(cap, Math.max(settings.dailyNewLimit, daily.newIntroduced) + 50)
          : settings.dailyNewLimit;
      // ホームの数字と同じ計算（新しい語は orderNew。「あと5語」も上限を広げて同じ orderNew を通す）
      const plan = planToday({
        pool: reviewPool(addedIds, userMap),
        cards,
        daily,
        settings,
        pinned: useProgress.getState().pinnedNew,
        today,
        newLimit,
      });
      // 空なら完了画面を出す（上限を超えて新規を黙って足すことはしない）
      return { items: plan.items, reason: plan.reason };
    }
    // 単語帳のデッキ（番号）と曲の語（music = 全曲 / music:<videoId> = その曲）。クイズの /quiz/:deckId と共通
    return { items: (resolveDeckWords(deckId, addedWords, userMap) ?? []).map(recogItem) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId, capParam, capDate]);

  // 今日の学習は設定に従う（既定は1枚ずつ）。他のデッキは一覧が既定（つけたい機能.md）
  const [view, setView] = useState<StudyViewMode>(() => (isToday ? studyViewSetting : "list"));
  // 表示を切り替えたときに出すカード（null = items のまま）。この画面で最後の評価が合格だったカードは出し直さない
  // （出し直すと進捗が最初からになり、据え置きの評価で今日の枚数・総評価数だけが増えるため）
  const [remaining, setRemaining] = useState<StudyItem[] | null>(null);
  // この画面でのカードごと（カードキー）の評価の履歴（取り消しで1つ戻す）
  const ratingsRef = useRef(new Map<string, Rating[]>());
  const onRated = (key: string, r: Rating) => {
    const m = ratingsRef.current;
    m.set(key, [...(m.get(key) ?? []), r]);
  };
  const onUnrated = (key: string) => {
    const m = ratingsRef.current;
    m.set(key, (m.get(key) ?? []).slice(0, -1));
  };
  /** 今の並びから、この画面で合格したカードを除いたもの（again のままのカード・評価を取り消したカードは残す） */
  const unpassed = () => {
    const passed = (key: string) => {
      const rs = ratingsRef.current.get(key);
      return !!rs?.length && rs[rs.length - 1] !== "again";
    };
    // 耳だけ復習の「1枚ずつで確認」で並べ替えた後も、その並びのまま
    return (remaining ?? items).filter((it) => !passed(it.key));
  };
  const switchView = (v: StudyViewMode) => {
    setRemaining(unpassed());
    setView(v);
  };
  /** 理解カードの語だけ（一覧表示・耳だけ復習は産出カードを扱わない） */
  const recogWords = (list: readonly StudyItem[]) => list.filter((it) => it.dir === "recog").map((it) => it.word);
  // 耳だけ復習（🎧）で聴く語（null = 開いていない）。開いている間は学習の表示を閉じる
  // （戻るときは表示の切り替えと同じく、合格したカードを除いて作り直す）
  const [hfWords, setHfWords] = useState<Word[] | null>(null);
  const openHandsfree = () => {
    const rest = unpassed();
    setRemaining(rest);
    // すべて合格済みでも聴くことはできる（SRS には書かない）ので、そのときは今の並びをそのまま聴く
    const restWords = recogWords(rest);
    setHfWords(restWords.length ? restWords : recogWords(remaining ?? items));
  };

  const title = deckTitle(deckId, (id) => SONG_BY_ID.get(id)?.title) ?? "単語帳";
  // 「このデッキでクイズ」（今日の学習は日ごとに変わるので付けない）
  const quizPath = isToday ? undefined : `/quiz/${deckId}`;

  const onExit = () => navigate("/flashcards");
  // 「あと5語」: 今の導入数（上限を超えていればそこ）+5 を今日の上限にする。
  // 押すたびに今の数から計算し直す。同じ URL でも location.key が変わるので StudyView が作り直される
  const onExtra = isToday
    ? () => {
        const introduced = todayCounters(useProgress.getState().daily).newIntroduced;
        const cap = Math.max(useSettings.getState().dailyNewLimit, introduced) + 5;
        navigate(`/flashcards/today?cap=${cap}&d=${todayStr()}`, { replace: true });
      }
    : undefined;

  if (items.length === 0) {
    if (isToday) {
      return (
        <div className="space-y-4">
          <button onClick={onExit} className="min-h-11 text-sm text-brand-green">
            ‹ 単語帳に戻る
          </button>
          <EmptyToday onExtra={onExtra} reason={reason} />
        </div>
      );
    }
    return (
      <div className="animate-fade-in space-y-4">
        <button onClick={onExit} className="min-h-11 text-sm text-brand-green">
          ‹ 単語帳に戻る
        </button>
        <div className="card p-8 text-center text-slate-500">
          {isMusicDeck ? (
            <>
              まだ曲の単語がありません。
              <br />
              <Link to="/music" className="text-brand-green">
                音楽タブで歌詞の単語をタップして追加しましょう ›
              </Link>
            </>
          ) : (
            <>このデッキには単語がありません。</>
          )}
        </div>
      </div>
    );
  }

  if (hfWords) {
    return (
      <HandsfreePlayer
        words={hfWords}
        title={title}
        onClose={() => setHfWords(null)}
        // 印の語を先頭にした並びで1枚ずつ学習を始める（評価は通常の rate を通る）。
        // まだ合格していない産出カードはその後ろに残す
        onReview={(ordered) => {
          setRemaining([...ordered.map(recogItem), ...unpassed().filter((it) => it.dir === "prod")]);
          setView("session");
          setHfWords(null);
        }}
      />
    );
  }

  const shown = remaining ?? items;
  // 一覧表示・耳だけ復習に出す語（理解カード）と、1枚ずつ学習でだけ出す産出カードの数
  const shownWords = recogWords(shown);
  const prodShown = shown.length - shownWords.length;
  // 表示を切り替えた時点で、この画面のカードをすべて評価し終えていた
  if (shown.length === 0) {
    return (
      <div className="animate-fade-in space-y-4">
        <button onClick={onExit} className="min-h-11 text-sm text-brand-green">
          ‹ 単語帳に戻る
        </button>
        {isToday ? (
          <EmptyToday onExtra={onExtra} reason={reason} />
        ) : (
          <div className="card space-y-3 p-8 text-center text-slate-500">
            <div>この単語帳の語は、すべて評価し終えました。</div>
            {quizPath && (
              <Link to={quizPath} className="btn-primary min-h-11 w-full">
                🎯 このデッキでクイズ
              </Link>
            )}
          </div>
        )}
      </div>
    );
  }

  // 一覧に出す語が無い（今日は産出カードだけ）ときは、一覧表示の設定でも1枚ずつで出す
  if (view === "session" || shownWords.length === 0) {
    return (
      <ReviewSession
        items={shown}
        title={title}
        onExit={onExit}
        onSwitchView={shownWords.length ? () => switchView("list") : undefined}
        onHandsfree={shownWords.length ? openHandsfree : undefined}
        onExtra={onExtra}
        reason={reason}
        onRated={onRated}
        onUnrated={onUnrated}
        quizPath={quizPath}
      />
    );
  }
  return (
    <ListView
      words={shownWords}
      prodCount={prodShown}
      title={title}
      onExit={onExit}
      onSwitchView={() => switchView("session")}
      onHandsfree={shownWords.length ? openHandsfree : undefined}
      onExtra={onExtra}
      reason={reason}
      onRated={onRated}
      onUnrated={onUnrated}
      quizPath={quizPath}
    />
  );
}

/** 今日の分が最初から無いとき（「あと5語」と予報だけ出す。復習が溜まっていればその理由） */
function EmptyToday({ onExtra, reason }: { onExtra?: () => void; reason?: "backlog" }) {
  const fc = useForecast();
  return <SessionComplete stats={null} againItems={[]} forecast={fc} reason={reason} onExtra={onExtra} />;
}

// ============================ 一覧表示 ============================
/** 一覧の1行。同じ語の再出題は n で区別する（React の key は id#n） */
interface ListItem {
  word: Word;
  /** その語の何枚目か（0 = 元の並び） */
  n: number;
  /** again による再出題の回数（1周ごとに数え直す。MAX_REQUEUE まで） */
  req: number;
}

interface ListState {
  items: ListItem[];
  /** 評価済みの行（key → 結果） */
  rated: Record<string, RatedInfo>;
  /** 語ごとの最初の評価（完了時の1回目の正答率） */
  first: Record<string, Rating>;
  /** 今の周で again を付けた語 */
  again: string[];
  /** 最初の評価の時点で新しかった語の数 */
  fresh: number;
}

const itemKey = (it: ListItem) => `${it.word.id}#${it.n}`;

function ListView({
  words,
  prodCount = 0,
  title,
  onExit,
  onSwitchView,
  onHandsfree,
  onExtra,
  reason,
  onRated,
  onUnrated,
  quizPath,
}: {
  words: Word[];
  /** この画面の産出カードの数（一覧には出さず、1枚ずつ学習でだけ出す） */
  prodCount?: number;
  title: string;
  onExit: () => void;
  onSwitchView: () => void;
  /** 耳だけ復習（🎧）を開く */
  onHandsfree?: () => void;
  onExtra?: () => void;
  /** 今日の学習で新しい語を止めた理由（完了のまとめに出す） */
  reason?: "backlog";
  /** 評価・取り消しを親へ知らせる（表示を切り替えたときに合格済みの語を出し直さないため） */
  onRated?: (id: string, r: Rating) => void;
  onUnrated?: (id: string) => void;
  /** 「このデッキでクイズ」のリンク先（今日の学習では無し） */
  quizPath?: string;
}) {
  const today = useToday();
  const cards = useProgress((s) => s.cards);
  const showKana = useSettings((s) => s.showKana);
  const showIpa = useSettings((s) => s.showIpa);
  const voiceURI = useSettings((s) => s.voiceURI);
  const settingsRate = useSettings((s) => s.rate);

  const [st, setSt] = useState<ListState>(() => ({
    items: words.map((word) => ({ word, n: 0, req: 0 })),
    rated: {},
    first: {},
    again: [],
    fresh: 0,
  }));
  // 連打でも最新の状態を読む（同じ行を二重に評価しない）
  const stRef = useRef(st);
  const commit = (next: ListState) => {
    stRef.current = next;
    setSt(next);
  };
  const { items, rated } = st;

  // マスク状態（行の key ごと）
  const [ptShown, setPtShown] = useState(true);
  const [jaShown, setJaShown] = useState(true);
  const [ptFlips, setPtFlips] = useState<Set<string>>(new Set());
  const [jaFlips, setJaFlips] = useState<Set<string>>(new Set());

  const ptVisible = (k: string) => (ptShown ? !ptFlips.has(k) : ptFlips.has(k));
  const jaVisible = (k: string) => (jaShown ? !jaFlips.has(k) : jaFlips.has(k));
  const flip = (set: Set<string>, k: string) => {
    const n = new Set(set);
    n.has(k) ? n.delete(k) : n.add(k);
    return n;
  };
  const setGlobalPt = (shown: boolean) => {
    setPtShown(shown);
    setPtFlips(new Set());
  };
  const setGlobalJa = (shown: boolean) => {
    setJaShown(shown);
    setJaFlips(new Set());
  };

  // 評価と取り消し（1段）。again の語は末尾にもう一度足す（1語 MAX_REQUEUE 回まで）
  const undoRef = useRef<{ snap: ListState; id: string } | null>(null);
  const [toast, setToast] = useState<{ token: number; message: string } | null>(null);

  function handleRate(it: ListItem, r: Rating) {
    const cur = stRef.current;
    const key = itemKey(it);
    if (cur.rated[key]) return;
    const P = useProgress.getState();
    const before = P.cards[it.word.id];
    const held = isHeld(before ?? newCard(today), r, today);
    P.rate(it.word.id, r);
    onRated?.(it.word.id, r);
    undoRef.current = { snap: cur, id: it.word.id };
    setToast((t) => ({ token: (t?.token ?? 0) + 1, message: `「${it.word.pt}」→ ${RATING_LABEL[r]}` }));

    const id = it.word.id;
    const requeue = r === "again" && it.req < MAX_REQUEUE;
    const isFirst = !(id in cur.first);
    commit({
      items: requeue
        ? [...cur.items, { word: it.word, n: cur.items.filter((x) => x.word.id === id).length, req: it.req + 1 }]
        : cur.items,
      rated: { ...cur.rated, [key]: { rating: r, held, requeued: requeue } },
      first: isFirst ? { ...cur.first, [id]: r } : cur.first,
      again: r === "again" && !cur.again.includes(id) ? [...cur.again, id] : cur.again,
      fresh: cur.fresh + (isFirst && (!before || before.last === null) ? 1 : 0),
    });
  }

  function undo() {
    const u = undoRef.current;
    undoRef.current = null;
    setToast(null);
    if (!u) return;
    const P = useProgress.getState();
    // 取り消しは1段だけ。別の操作（クイズ等）で破棄されていたら何もしない
    if (!P.canUndo(u.id)) return;
    if (P.undo() !== u.id) return;
    onUnrated?.(u.id);
    commit(u.snap);
  }

  function againRound(ws: Word[]) {
    undoRef.current = null;
    setToast(null);
    const cur = stRef.current;
    commit({
      ...cur,
      items: [
        ...cur.items,
        ...ws.map((word) => ({ word, n: cur.items.filter((x) => x.word.id === word.id).length, req: 0 })),
      ],
      again: [],
    });
  }

  // Autoplay
  const [playing, setPlaying] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [speed, setSpeed] = useState(settingsRate || 1);
  const abortRef = useRef<AbortController | null>(null);
  // 連続再生の間は画面を消さない（手を離して聴けるように）
  useWakeLock(playing);

  function stopAutoplay() {
    abortRef.current?.abort();
    audio.cancel();
    setPlaying(false);
    setActiveIdx(null);
  }

  async function startAutoplay() {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPlaying(true);
    try {
      await audio.speakSequence(
        items.map((it) => it.word.ptForSpeech),
        { rate: speed, voiceURI, gapMs: 400, onIndex: (i) => setActiveIdx(i), signal: ctrl.signal }
      );
    } finally {
      if (!ctrl.signal.aborted) {
        setPlaying(false);
        setActiveIdx(null);
      }
    }
  }

  // アンマウント時に停止
  useEffect(() => () => stopAutoplay(), []);

  // アクティブカードを画面内に
  useEffect(() => {
    if (activeIdx == null) return;
    const el = document.getElementById(`fc-${activeIdx}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIdx]);

  const ratedCount = Object.keys(rated).length;
  const allRated = items.length > 0 && ratedCount >= items.length;
  const againWords = useMemo(() => {
    const byId = new Map(items.map((it) => [it.word.id, it.word]));
    return st.again.map((id) => byId.get(id)).filter((w): w is Word => !!w);
  }, [items, st.again]);

  return (
    <div className="animate-fade-in pb-4">
      {/* コントロールバー（top はヘッダーの実高さ --hdr。ボタンは指で押せる 44px 以上） */}
      <div className="sticky top-[var(--hdr,53px)] z-10 -mx-4 mb-3 border-b border-slate-200 bg-white/95 px-4 py-1.5 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <button onClick={onExit} className="min-h-11 pr-2 text-sm text-brand-green">‹ 一覧</button>
          <div className="min-w-0 truncate text-sm font-bold text-brand-ink">{title}</div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">
              {ratedCount}/{items.length}
            </span>
            {onHandsfree && (
              <button
                type="button"
                onClick={onHandsfree}
                className="min-h-11 px-1 text-xs font-medium text-brand-green"
                title="耳だけ復習（葡 → 考える間 → 和 を読み上げ）"
              >
                🎧 耳だけ
              </button>
            )}
            <button type="button" onClick={onSwitchView} className="min-h-11 px-1 text-xs font-medium text-brand-green">
              1枚ずつ
            </button>
          </div>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-2">
          {/* 一括マスク */}
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs">
            <span className="px-1 text-slate-500">葡</span>
            <button onClick={() => setGlobalPt(true)} className={`min-h-11 min-w-11 rounded px-2 ${ptShown ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}>表示</button>
            <button onClick={() => setGlobalPt(false)} className={`min-h-11 min-w-11 rounded px-2 ${!ptShown ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}>隠す</button>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs">
            <span className="px-1 text-slate-500">和</span>
            <button onClick={() => setGlobalJa(true)} className={`min-h-11 min-w-11 rounded px-2 ${jaShown ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}>表示</button>
            <button onClick={() => setGlobalJa(false)} className={`min-h-11 min-w-11 rounded px-2 ${!jaShown ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}>隠す</button>
          </div>

          {/* Autoplay */}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={playing ? stopAutoplay : startAutoplay}
              className={`btn ${playing ? "bg-rose-500 text-white" : "btn-primary"} min-h-11 px-3 py-1.5 text-sm`}
            >
              {playing ? "■ 停止" : "▶ 連続再生"}
            </button>
            <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`min-h-11 min-w-11 rounded px-1.5 ${speed === s ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}
                >
                  {s.toFixed(1)}x
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* 産出カード（和→葡）は一覧には出さない。1枚ずつ学習で出す */}
      {prodCount > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-brand-blue/5 px-3 py-2 text-sm text-brand-ink ring-1 ring-brand-blue/20">
          <span>✍ 産出カード（和→葡）{prodCount}枚は「1枚ずつ」で出ます</span>
          <button type="button" onClick={onSwitchView} className="min-h-11 px-1 text-sm font-medium text-brand-blue">
            1枚ずつへ ›
          </button>
        </div>
      )}

      {quizPath && (
        <Link
          to={quizPath}
          className="mb-3 flex min-h-11 items-center justify-between rounded-xl bg-brand-blue/5 px-3 text-sm font-medium text-brand-blue ring-1 ring-brand-blue/20"
        >
          <span>🎯 このデッキでクイズ</span>
          <span aria-hidden>›</span>
        </Link>
      )}

      {/* カード一覧 */}
      <div className="space-y-3">
        {items.map((it, i) => {
          const k = itemKey(it);
          return (
            <div id={`fc-${i}`} key={k}>
              {it.n > 0 && !rated[k] && (
                <div className="mb-1 px-1 text-[11px] font-medium text-rose-500">↻ もう一度</div>
              )}
              <Flashcard
                word={it.word}
                ptVisible={ptVisible(k)}
                jaVisible={jaVisible(k)}
                showKana={showKana}
                showIpa={showIpa}
                active={activeIdx === i}
                rated={rated[k] ?? null}
                card={cards[it.word.id]}
                today={today}
                onTogglePt={() => setPtFlips((s) => flip(s, k))}
                onToggleJa={() => setJaFlips((s) => flip(s, k))}
                onRate={(r) => handleRate(it, r)}
              />
            </div>
          );
        })}
      </div>

      {/* すべて評価したら完了のまとめ（産出カードが残っていれば、先に1枚ずつ学習へ案内する） */}
      {allRated && (
        <div className="mt-6 space-y-3">
          {prodCount > 0 && (
            <button type="button" onClick={onSwitchView} className="btn-primary min-h-11 w-full">
              ✍ 残りの産出カード {prodCount}枚へ（1枚ずつ）
            </button>
          )}
          <ListDone
            st={st}
            againWords={againWords}
            onAgainRound={againRound}
            onExtra={onExtra}
            reason={reason}
            quizPath={quizPath}
          />
        </div>
      )}

      {toast && (
        <UndoToast
          key={toast.token}
          message={toast.message}
          onUndo={undo}
          onClose={() => setToast(null)}
          bottom="calc(4.5rem + env(safe-area-inset-bottom))"
        />
      )}
    </div>
  );
}

/** 一覧表示の完了まとめ（予報はここでだけ計算する） */
function ListDone({
  st,
  againWords,
  onAgainRound,
  onExtra,
  reason,
  quizPath,
}: {
  st: ListState;
  againWords: Word[];
  onAgainRound: (ws: Word[]) => void;
  onExtra?: () => void;
  reason?: "backlog";
  quizPath?: string;
}) {
  const fc = useForecast();
  const firsts = Object.values(st.first);
  return (
    <SessionComplete
      stats={{
        reviews: Object.keys(st.rated).length,
        words: firsts.length,
        newWords: st.fresh,
        firstCorrect: firsts.filter((r) => r !== "again").length,
      }}
      againItems={againWords.map(recogItem)}
      forecast={fc}
      onAgainRound={againWords.length ? () => onAgainRound(againWords) : undefined}
      onExtra={onExtra}
      reason={reason}
      quizPath={quizPath}
    />
  );
}

export default function Flashcards() {
  const { deckId } = useParams();
  const location = useLocation();
  if (!deckId) return <DeckPicker />;
  // URL（「あと5語」の ?cap=… など）が変わる・同じ URL へ移動し直すたびに、出題する語を決め直す
  return <StudyView key={`${deckId}${location.search}#${location.key}`} deckId={deckId} />;
}
