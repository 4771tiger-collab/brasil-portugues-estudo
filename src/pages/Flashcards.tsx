import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ALL_DECKS, ALL_WORDS, resolveWord, reviewPool } from "../data/loadWords";
import { SONG_BY_ID } from "../data/music";
import type { Rating, Word } from "../data/types";
import { todayCounters, useProgress } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import { useAddedIds, useMusic, useUserWordMap } from "../store/useMusic";
import { buildSession, countAddedNew, countReview } from "../srs/queue";
import { audio } from "../services/audio";
import Flashcard from "../components/Flashcard";

const SPEEDS = [0.8, 1.0, 1.2];

// ============================ デッキ選択 ============================
function DeckPicker() {
  const cards = useProgress((s) => s.cards);
  const daily = todayCounters(useProgress((s) => s.daily));
  const dailyNewLimit = useSettings((s) => s.dailyNewLimit);
  const musicNewLimit = useSettings((s) => s.musicNewLimit);
  const addedIds = useAddedIds();
  const addedWords = useMusic((s) => s.addedWords);
  const userMap = useUserWordMap();
  const pool = useMemo(() => reviewPool(addedIds, userMap), [addedIds, userMap]);
  const due = useMemo(() => countReview(pool, cards), [pool, cards]);
  const addedNew = useMemo(() => countAddedNew(pool, cards), [pool, cards]);
  const newRemaining = Math.max(0, dailyNewLimit - daily.newIntroduced);
  const musicNew = Math.min(addedNew, Math.max(0, musicNewLimit - (daily.musicIntroduced ?? 0)));

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
          復習 {due} ＋ 新規 {newRemaining}
          {musicNew > 0 && <span> ＋ 🎵 {musicNew}</span>}
        </div>
        <div className="mt-1 text-xs opacity-90">間隔反復で最適な順に出題します ›</div>
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
                const deckDue = countReview(d.words, cards);
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
function StudyView({ deckId }: { deckId: string }) {
  const navigate = useNavigate();
  const cards = useProgress((s) => s.cards);
  const rate = useProgress((s) => s.rate);
  const daily = todayCounters(useProgress((s) => s.daily));
  const dailyNewLimit = useSettings((s) => s.dailyNewLimit);
  const musicNewLimit = useSettings((s) => s.musicNewLimit);
  const addedWords = useMusic((s) => s.addedWords);
  const userMap = useUserWordMap();
  const showKana = useSettings((s) => s.showKana);
  const showIpa = useSettings((s) => s.showIpa);
  const voiceURI = useSettings((s) => s.voiceURI);
  const settingsRate = useSettings((s) => s.rate);

  // 出題する語を初回に確定（学習中に並びが変わらないよう固定）
  const isMusicDeck = deckId === "music" || deckId.startsWith("music:");
  const musicVideoId = deckId.startsWith("music:") ? deckId.slice(6) : null;

  const words = useMemo<Word[]>(() => {
    if (isMusicDeck) {
      // 曲から追加した語（music = 全曲 / music:<videoId> = その曲）
      const ids = [...new Set(addedWords.filter((w) => !musicVideoId || w.videoId === musicVideoId).map((w) => w.id))];
      return ids.map((id) => resolveWord(id, userMap)).filter((w): w is Word => !!w);
    }
    if (deckId === "today") {
      const addedIds = [...new Set(addedWords.map((w) => w.id))];
      const { all } = buildSession(reviewPool(addedIds, userMap), cards, {
        newLimit: dailyNewLimit,
        introducedToday: daily.newIntroduced,
        addedLimit: musicNewLimit,
        addedToday: daily.musicIntroduced ?? 0,
      });
      return all.length ? all : ALL_WORDS.filter((w) => !cards[w.id]).slice(0, dailyNewLimit);
    }
    const idx = Number(deckId);
    return ALL_DECKS[idx]?.words ?? [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deckId]);

  const title = isMusicDeck
    ? musicVideoId
      ? `🎵 ${SONG_BY_ID.get(musicVideoId)?.title ?? "曲の単語"}`
      : "🎵 曲の単語"
    : deckId === "today"
      ? "今日の学習"
      : ALL_DECKS[Number(deckId)]?.category ?? "単語帳";

  // マスク状態
  const [ptShown, setPtShown] = useState(true);
  const [jaShown, setJaShown] = useState(true);
  const [ptFlips, setPtFlips] = useState<Set<string>>(new Set());
  const [jaFlips, setJaFlips] = useState<Set<string>>(new Set());

  const ptVisible = (id: string) => (ptShown ? !ptFlips.has(id) : ptFlips.has(id));
  const jaVisible = (id: string) => (jaShown ? !jaFlips.has(id) : jaFlips.has(id));
  const flip = (set: Set<string>, id: string) => {
    const n = new Set(set);
    n.has(id) ? n.delete(id) : n.add(id);
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

  // 評価済み
  const [rated, setRated] = useState<Set<string>>(new Set());
  function handleRate(w: Word, r: Rating) {
    rate(w.id, r);
    setRated((s) => new Set(s).add(w.id));
  }

  // Autoplay
  const [playing, setPlaying] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  const [speed, setSpeed] = useState(settingsRate || 1);
  const abortRef = useRef<AbortController | null>(null);

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
        words.map((w) => w.ptForSpeech),
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

  // 新規語をセッション開始時に導入記録（SRSの新規枠カウント用）
  // ※評価時にも記録されるが、見ただけでも導入扱いにしたい場合に備え rate に委ねる
  // ここでは何もしない（rate内でwasNew判定）

  // アクティブカードを画面内に
  useEffect(() => {
    if (activeIdx == null) return;
    const el = document.getElementById(`fc-${activeIdx}`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeIdx]);

  if (words.length === 0) {
    return (
      <div className="animate-fade-in space-y-4">
        <button onClick={() => navigate("/flashcards")} className="text-sm text-brand-green">‹ 単語帳に戻る</button>
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
            <>
              🎉 今日の復習は完了しました！
              <br />
              新しい語を学ぶには別のデッキを選んでください。
            </>
          )}
        </div>
      </div>
    );
  }

  const ratedCount = rated.size;

  return (
    <div className="animate-fade-in pb-4">
      {/* コントロールバー */}
      <div className="sticky top-[57px] z-10 -mx-4 mb-3 border-b border-slate-200 bg-white/95 px-4 py-2 backdrop-blur">
        <div className="flex items-center justify-between">
          <button onClick={() => navigate("/flashcards")} className="text-sm text-brand-green">‹ 一覧</button>
          <div className="text-sm font-bold text-brand-ink">{title}</div>
          <div className="text-xs text-slate-400">
            {ratedCount}/{words.length}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {/* 一括マスク */}
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs">
            <span className="px-1 text-slate-500">葡</span>
            <button onClick={() => setGlobalPt(true)} className={`rounded px-2 py-1 ${ptShown ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}>表示</button>
            <button onClick={() => setGlobalPt(false)} className={`rounded px-2 py-1 ${!ptShown ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}>隠す</button>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs">
            <span className="px-1 text-slate-500">和</span>
            <button onClick={() => setGlobalJa(true)} className={`rounded px-2 py-1 ${jaShown ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}>表示</button>
            <button onClick={() => setGlobalJa(false)} className={`rounded px-2 py-1 ${!jaShown ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}>隠す</button>
          </div>

          {/* Autoplay */}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={playing ? stopAutoplay : startAutoplay}
              className={`btn ${playing ? "bg-rose-500 text-white" : "btn-primary"} px-3 py-1.5 text-sm`}
            >
              {playing ? "■ 停止" : "▶ 連続再生"}
            </button>
            <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  onClick={() => setSpeed(s)}
                  className={`rounded px-1.5 py-1 ${speed === s ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}
                >
                  {s.toFixed(1)}x
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* カード一覧 */}
      <div className="space-y-3">
        {words.map((w, i) => (
          <div id={`fc-${i}`} key={w.id}>
            <Flashcard
              word={w}
              ptVisible={ptVisible(w.id)}
              jaVisible={jaVisible(w.id)}
              showKana={showKana}
              showIpa={showIpa}
              active={activeIdx === i}
              rated={rated.has(w.id)}
              card={cards[w.id]}
              onTogglePt={() => setPtFlips((s) => flip(s, w.id))}
              onToggleJa={() => setJaFlips((s) => flip(s, w.id))}
              onRate={(r) => handleRate(w, r)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Flashcards() {
  const { deckId } = useParams();
  if (!deckId) return <DeckPicker />;
  return <StudyView deckId={deckId} />;
}
