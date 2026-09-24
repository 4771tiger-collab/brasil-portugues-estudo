import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { PASSAGES, SCRIPTS } from "../data/content";
import type { ContentLevel, Passage, Script } from "../data/types";
import { useSettings } from "../store/useSettings";
import { useProgress } from "../store/useProgress";
import { audio, delay } from "../services/audio";
import { toKana } from "../services/pronunciation";
import {
  RecorderError,
  createUrlBag,
  recErrorMessage,
  recorderSupport,
  startRecording,
  type RecordingHandle,
} from "../services/recorder";
import { passageToScript } from "../services/sentenceGroups";
import { speedOptions, useSequencePlayer } from "../hooks/useSequencePlayer";
import { useWakeLock } from "../hooks/useWakeLock";
import { useBack } from "../hooks/useBack";
import { elapsedSec } from "../services/activityClock";
import { speechInput } from "../services/speechInput";
import { LEVEL_FILTERS, LEVEL_LABEL, dialogueSpeakers, lineSpeaker, matchesLevel, parseLevelFilter } from "../services/materials";
import { PARTNER_GAP_MS, myTurns, runRolePlay, turnGapMs, waitTurn, type RolePlayDeps } from "../services/rolePlay";
import SayItButton from "../components/SayItButton";
import FilterChips from "../components/FilterChips";

/**
 * 一覧の URL。詳細は /practice/shadowing/:id
 * id はスクリプトの id（scr_…）か、読み物（チャンクリーディングの教材）から作った "p:<passageId>"
 */
const LIST_PATH = "/practice/shadowing";

/** 録音・通し再生1回に記録する時間の上限（秒） */
const LOG_CAP_SEC = 600;

/** 全文再生の文と文の間（ms） */
const LINE_GAP_MS = 500;

/** 聞き比べ: お手本を読み終えてから自分の録音を流すまでの間（ms） */
const COMPARE_GAP_MS = 400;

/** 全文モードの録音のキー（1文ずつモードは行の番号 0, 1, 2…） */
const FULL_KEY = -1;

/**
 * 練習のしかた: 1文ずつ（お手本→録音→聞き比べ）／全文で通す（従来のシャドーイング）／
 * ロールプレイ（会話だけ。相手のセリフを読み上げ、自分の番で言う）
 */
type Mode = "line" | "full" | "role";

const MODE_LABEL: Record<Mode, string> = { line: "1文ずつ", full: "全文で通す", role: "ロールプレイ" };

/** 会話の話者の色（出てくる順に 0・1） */
const SPEAKER_TONE = [
  { chip: "bg-sky-100 text-sky-700", on: "bg-sky-500 text-white ring-sky-500" },
  { chip: "bg-violet-100 text-violet-700", on: "bg-violet-500 text-white ring-violet-500" },
] as const;

/** シャドーイングの教材（スクリプト、または読み物を1文ずつに変換したもの） */
interface Material {
  script: Script;
  /** dialogue = 2人の会話（ロールプレイができる）、script = そのほかのスクリプト、passage = 読み物 */
  kind: "dialogue" | "script" | "passage";
  /** 難易度（スクリプトは任意） */
  level?: ContentLevel;
  /** 読み物のとき: 取り込み元（original 以外はチップを出す） */
  source?: Passage["source"];
  /** 会話のとき: 2人の話者（出てくる順） */
  speakers?: [string, string];
}

/** 一覧と詳細で共通の教材（スクリプト → 自作の読み物 → 同梱の読み物） */
function useMaterials(): Material[] {
  const customPassages = useProgress((s) => s.customPassages);
  return useMemo(() => {
    const scripts: Material[] = SCRIPTS.map((script) => {
      const speakers = dialogueSpeakers(script);
      return speakers
        ? { script, kind: "dialogue", level: script.level, speakers }
        : { script, kind: "script", level: script.level };
    });
    const passages: Material[] = [...customPassages, ...PASSAGES]
      .map((p): Material => ({ script: passageToScript(p), kind: "passage", level: p.level, source: p.source }))
      .filter((m) => m.script.lines.length > 0);
    return [...scripts, ...passages];
  }, [customPassages]);
}

/** 会話の話者のチップ（idx = 話者の番号 0・1。自分の役なら印をつける） */
function SpeakerChip({ name, idx, me = false }: { name: string; idx: number; me?: boolean }) {
  const tone = SPEAKER_TONE[idx === 1 ? 1 : 0];
  return (
    <span className={`chip shrink-0 font-bold ${tone.chip}`}>
      {me ? "🙋 " : ""}
      {name}
    </span>
  );
}

/** 自分の番の考える間（ms かけて減る帯）。次の番では key を変えて作り直す */
function GapBar({ ms }: { ms: number }) {
  const [go, setGo] = useState(false);
  useEffect(() => {
    // 幅 100% を一度描いてから 0% へ（2フレーム待たないと、変化が transition にならないことがある）
    let id2 = 0;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => setGo(true));
    });
    return () => {
      cancelAnimationFrame(id1);
      cancelAnimationFrame(id2);
    };
  }, []);
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-amber-100" role="timer" aria-label={`考える間 ${Math.round(ms / 100) / 10}秒`}>
      <div className="h-full rounded-full bg-amber-400" style={{ width: go ? "0%" : "100%", transition: `width ${ms}ms linear` }} />
    </div>
  );
}

/** 自分の番（ロールプレイ）。gapMs が null なら「次へ」を押すまで待つ（🎤 言ってみるを使うとき） */
interface Turn {
  line: number;
  gapMs: number | null;
  /** 番のたびに増やす（帯と 🎤 を作り直す） */
  key: number;
}

/** 録音中・開始中の録音（同時に1つだけ） */
interface RecSession {
  key: number;
  /** マイクが開くまでは null */
  handle: RecordingHandle | null;
  /** 録音を始めた時刻（学習ログに録音の長さを記録する） */
  startedAt: number | null;
}

/** 自分の録音の再生 */
interface OwnPlayback {
  key: number;
  el: HTMLAudioElement;
  /** 再生を終える（流し終えたら true）。何度呼んでもよい */
  finish: (ok: boolean) => void;
}

/** 行ごとの操作ボタン（アイコンとラベルの2段。高さ 48px） */
function LineButton({
  icon,
  label,
  onClick,
  disabled = false,
  active = false,
  pulse = false,
  tone = "green",
  ariaLabel,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  pulse?: boolean;
  tone?: "green" | "rose";
  ariaLabel: string;
}) {
  const color = active
    ? tone === "rose"
      ? "bg-rose-500 text-white ring-rose-500"
      : "bg-brand-green text-white ring-brand-green"
    : tone === "rose"
      ? "bg-rose-50 text-rose-600 ring-rose-200"
      : "bg-white text-brand-ink ring-slate-200";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={`flex min-h-12 flex-col items-center justify-center gap-0.5 rounded-xl px-1 text-[11px] font-medium ring-1 transition active:scale-95 disabled:opacity-40 disabled:active:scale-100 ${color} ${
        pulse ? "animate-pulse" : ""
      }`}
    >
      <span className="text-base leading-none">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

function Player({ script, speakers, onBack }: { script: Script; speakers: [string, string] | null; onBack: () => void }) {
  const settingsRate = useSettings((s) => s.rate);
  const speechOn = useSettings((s) => s.speechInputEnabled);
  const initialRate = settingsRate > 0 ? settingsRate : 1;
  const speeds = useMemo(() => speedOptions(initialRate), [initialRate]);
  // 速さの初期値は設定の速さ
  const [speed, setSpeed] = useState(initialRate);
  /** ロールプレイの読み上げで使う最新の速さ（途中で変えたら次の行から効く） */
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const [params, setParams] = useSearchParams();
  const qMode = params.get("mode");
  // ロールプレイは会話（話者がちょうど2人）のときだけ
  const mode: Mode = qMode === "full" ? "full" : qMode === "role" && speakers ? "role" : "line";
  /** ロールプレイの自分の役（URL の ?role=。会話の話者でなければ未選択） */
  const qRole = params.get("role");
  const myRole = speakers && qRole && speakers.includes(qRole) ? qRole : null;
  /** 話者の番号（0・1。会話でなければ -1） */
  const speakerIdx = (name: string | null) => (speakers && name ? speakers.indexOf(name) : -1);
  const [showScript, setShowScript] = useState(true);
  const [showKana, setShowKana] = useState(false);
  const [showJa, setShowJa] = useState(false);

  const lines = script.lines;
  const kanas = useMemo(() => lines.map((l) => l.kana ?? toKana(l.pt)), [lines]);
  const fullKana = useMemo(() => kanas.join(" "), [kanas]);
  const fullJa = useMemo(() => lines.map((l) => l.ja).join(" "), [lines]);

  // お手本の再生（どの再生も前の再生を止めてから始める。全文再生の間は Wake Lock、画面を離れたら停止）
  const player = useSequencePlayer({ rate: speed, gapMs: LINE_GAP_MS });

  /** 画面を離れた後に state を触らないための印 */
  const aliveRef = useRef(true);

  // ---- 録音 ----
  const support = useMemo(() => recorderSupport(), []);
  // 録音の URL は入れ物でまとめて持ち、画面を離れるときに一括で解放する
  const [bag] = useState(createUrlBag);
  /** 録音の URL（キーは行の番号。全文モードは FULL_KEY） */
  const [recs, setRecs] = useState<Record<number, string>>({});
  const recsRef = useRef<Record<number, string>>({});
  const [rec, setRec] = useState<{ key: number; phase: "starting" | "on" } | null>(null);
  const sessionRef = useRef<RecSession | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const recording = rec !== null;
  // 録音の間も画面を消さない（話している間は画面に触れない）
  useWakeLock(recording);

  // ---- 自分の録音の再生・聞き比べ ----
  const [ownKey, setOwnKey] = useState<number | null>(null);
  const ownRef = useRef<OwnPlayback | null>(null);
  /** 聞き比べ中の行 */
  const [comparing, setComparing] = useState<number | null>(null);
  /** 聞き比べのたびに増やす。ほかの操作をしたら古い聞き比べは先へ進まない */
  const cmpTokRef = useRef(0);

  /** 自分の録音の再生を止める */
  function stopOwn() {
    const cur = ownRef.current;
    ownRef.current = null;
    if (cur) {
      cur.el.pause();
      cur.finish(false);
    }
    setOwnKey(null);
  }

  /** 自分の録音を流す。流し終えたら true（止めた・再生できなかったら false） */
  function playOwnUrl(url: string, key: number): Promise<boolean> {
    stopOwn();
    return new Promise<boolean>((resolve) => {
      const el = new Audio(url);
      let done = false;
      const entry: OwnPlayback = {
        key,
        el,
        finish: (ok) => {
          if (done) return;
          done = true;
          el.onended = null;
          el.onerror = null;
          if (ownRef.current === entry) {
            ownRef.current = null;
            if (aliveRef.current) setOwnKey(null);
          }
          resolve(ok);
        },
      };
      ownRef.current = entry;
      setOwnKey(key);
      el.onended = () => entry.finish(true);
      el.onerror = () => entry.finish(false);
      el.play().catch(() => entry.finish(false));
    });
  }

  /**
   * 「🎤 言ってみる」の聞き取りを取りやめる（お手本・自分の録音の音を認識に拾わせない。録音とマイクを取り合わない）。
   * 音声認識がオフなら何もしない
   */
  function stopListening() {
    if (useSettings.getState().speechInputEnabled) speechInput.cancel();
  }

  /** お手本・自分の録音・聞き比べをすべて止める */
  function stopAll() {
    cmpTokRef.current++;
    setComparing(null);
    player.stop();
    stopOwn();
  }

  /** 1文のお手本（連続再生の途中なら、それを止めてこの文だけ読む。この文だけを読んでいる最中なら止める） */
  function playModel(i: number) {
    stopListening();
    const soloHere = player.activeIdx === i && !player.playing && comparing !== i;
    cmpTokRef.current++;
    setComparing(null);
    stopOwn();
    if (soloHere) {
      player.stop();
      return;
    }
    void player.playOne(lines[i].pt, i);
  }

  async function playAllModel() {
    stopListening();
    cmpTokRef.current++;
    setComparing(null);
    stopOwn();
    const started = Date.now();
    const completed = await player.playAll(lines.map((l) => l.pt));
    // 学習ログ: 全文を最後まで流したとき（停止・行のタップ・画面の移動では記録しない）
    if (completed) useProgress.getState().logActivity("shadowing", 1, elapsedSec(started, LOG_CAP_SEC));
  }

  /** 自分の録音を聴く（同じ録音を再生中なら止める） */
  function playOwn(key: number) {
    const url = recsRef.current[key];
    if (!url) return;
    if (ownKey === key && comparing === null) {
      stopOwn();
      return;
    }
    stopListening();
    cmpTokRef.current++;
    setComparing(null);
    player.stop();
    void playOwnUrl(url, key);
  }

  /** 聞き比べ: お手本 → 少し間 → 自分の録音（聞き比べ中にもう一度押すと止める） */
  async function compare(i: number) {
    const url = recsRef.current[i];
    if (!url) return;
    if (comparing === i) {
      stopAll();
      return;
    }
    stopOwn();
    stopListening();
    const tok = ++cmpTokRef.current;
    setComparing(i);
    try {
      // お手本はクリック処理の中（同期）で読み始める
      const ok = await player.playOne(lines[i].pt, i);
      if (!ok || cmpTokRef.current !== tok) return;
      await delay(COMPARE_GAP_MS);
      if (cmpTokRef.current !== tok || !aliveRef.current) return;
      await playOwnUrl(url, i);
    } finally {
      if (cmpTokRef.current === tok && aliveRef.current) setComparing(null);
    }
  }

  /** 録音した URL を行に置く（前の録音は解放する） */
  function putRec(key: number, url: string) {
    const old = recsRef.current[key];
    if (old && ownRef.current?.key === key) stopOwn();
    recsRef.current = { ...recsRef.current, [key]: url };
    setRecs(recsRef.current);
    bag.revoke(old);
  }

  async function startRec(key: number) {
    if (sessionRef.current || !support.ok) return;
    setMicError(null);
    // 「🎤 言ってみる」の聞き取り中なら取りやめる（マイクを録音に使う）
    stopListening();
    // 自分の録音が録音に入らないよう止める（お手本は止めない: 流しながら録ってもよい）
    if (comparing !== null) player.stop();
    cmpTokRef.current++;
    setComparing(null);
    stopOwn();
    const sess: RecSession = { key, handle: null, startedAt: null };
    sessionRef.current = sess;
    setRec({ key, phase: "starting" });
    try {
      const handle = await startRecording({
        // マイクを取られた・外れた: そこまでの録音を残す
        onInterrupt: () => {
          if (sessionRef.current === sess) void stopRec();
        },
      });
      // 権限の確認を待つ間に画面を離れた・取り消した: 開いたマイクをすぐ閉じる
      if (!aliveRef.current || sessionRef.current !== sess) {
        handle.cancel();
        return;
      }
      sess.handle = handle;
      sess.startedAt = Date.now();
      setRec({ key, phase: "on" });
    } catch (e) {
      if (!aliveRef.current || sessionRef.current !== sess) return;
      sessionRef.current = null;
      setRec(null);
      setMicError(recErrorMessage(e instanceof RecorderError ? e.kind : "unknown"));
    }
  }

  /** 録音を止めて残す */
  async function stopRec() {
    const sess = sessionRef.current;
    if (!sess?.handle) return;
    sessionRef.current = null;
    setRec(null);
    // 学習ログ: 録音を止めたら1回（秒数は録音の長さ）
    if (sess.startedAt !== null) {
      useProgress.getState().logActivity("shadowing", 1, elapsedSec(sess.startedAt, LOG_CAP_SEC));
    }
    try {
      const blob = await sess.handle.stop();
      if (!aliveRef.current) return;
      if (blob.size === 0) {
        setMicError("録音が空でした。もう少し長く話してから止めてください。");
        return;
      }
      putRec(sess.key, bag.add(blob));
    } catch (e) {
      if (aliveRef.current) setMicError(recErrorMessage(e instanceof RecorderError ? e.kind : "unknown"));
    }
  }

  /** ●録音 ／ ■停止 の切り替え（開始中に押したら取り消す） */
  function toggleRec(key: number) {
    if (rec && rec.key === key) {
      if (rec.phase === "on") {
        void stopRec();
      } else {
        // マイクが開いたら startRec 側で閉じる
        sessionRef.current = null;
        setRec(null);
      }
      return;
    }
    void startRec(key);
  }

  // ---- ロールプレイ（会話だけ） ----
  // 相手のセリフだけを読み上げ、自分の番では「あなたの番」を出して待つ（考える間、または 🎤 と「次へ」）
  const [rpRunning, setRpRunning] = useState(false);
  /** いま進めている行と、それが自分の番か */
  const [rpLine, setRpLine] = useState<number | null>(null);
  const [rpMine, setRpMine] = useState(false);
  /** 止めたときに再開する行（最後まで通したら 0） */
  const [rpNext, setRpNext] = useState(0);
  /** 前回、最後まで通した */
  const [rpDone, setRpDone] = useState(false);
  const [turn, setTurn] = useState<Turn | null>(null);
  const rpCtrlRef = useRef<AbortController | null>(null);
  /** 自分の番を終える（「次へ」）。待っていなければ null */
  const advanceRef = useRef<(() => void) | null>(null);
  const turnKeyRef = useRef(0);
  // ロールプレイの間も画面を消さない（画面に触れずに聴き、話す）
  useWakeLock(rpRunning);

  /** 🎤 言ってみるで答えるか（設定がオンで、ブラウザが音声認識に対応しているとき） */
  const micTurn = () => useSettings.getState().speechInputEnabled && speechInput.isSupported();

  /** ロールプレイを止める（止めた行は rpNext に残り、そこから再開できる） */
  function stopRole() {
    const c = rpCtrlRef.current;
    rpCtrlRef.current = null;
    advanceRef.current = null;
    if (c) {
      c.abort();
      audio.cancel();
    }
    stopListening();
    setRpRunning(false);
    setTurn(null);
  }

  /**
   * ロールプレイを from 行目から始める（省略時は止めた行から。最後まで通した後は最初から）。
   * 最初の行が相手のセリフなら、このクリック処理の中で読み始める
   */
  function startRole(from?: number) {
    if (!speakers || !myRole || rpCtrlRef.current || recording) return;
    stopAll();
    stopListening();
    const ctrl = new AbortController();
    rpCtrlRef.current = ctrl;
    const start = from ?? (rpNext < lines.length ? rpNext : 0);
    const started = Date.now();
    setRpRunning(true);
    setRpDone(false);
    const deps: RolePlayDeps = {
      speak: (text) => {
        const s = useSettings.getState();
        return audio.speak(text, { rate: speedRef.current, voiceURI: s.voiceURI });
      },
      turn: (i, signal) => {
        // 🎤 を使うときは「次へ」を押すまで待つ。使わないときは考える間が過ぎたら次へ
        const gapMs = micTurn() ? null : turnGapMs(lines[i].pt, speedRef.current);
        setTurn({ line: i, gapMs, key: ++turnKeyRef.current });
        return waitTurn(gapMs, signal, (fn) => {
          if (rpCtrlRef.current === ctrl) advanceRef.current = fn;
        }).finally(() => {
          // 番が終わったら聞き取りも終える（🎤 を押したまま「次へ」・考える間が過ぎた）
          stopListening();
          if (aliveRef.current && rpCtrlRef.current === ctrl) setTurn(null);
        });
      },
      pause: (ms, signal) => delay(ms, signal),
      onLine: (i, mine) => {
        if (!aliveRef.current || rpCtrlRef.current !== ctrl) return;
        setRpLine(i);
        setRpMine(mine);
      },
    };
    void runRolePlay(lines, myTurns(lines, myRole), start, deps, ctrl.signal, PARTNER_GAP_MS).then((res) => {
      // 新しいロールプレイが始まっていれば、表示はそちらに任せる
      if (rpCtrlRef.current !== null && rpCtrlRef.current !== ctrl) return;
      if (rpCtrlRef.current === ctrl) rpCtrlRef.current = null;
      if (!aliveRef.current) return;
      setRpRunning(false);
      setRpLine(null);
      setTurn(null);
      setRpNext(res.completed ? 0 : res.next);
      setRpDone(res.completed);
      // 学習ログ: 最後まで通したら1回（止めた回は記録しない）
      if (res.completed) useProgress.getState().logActivity("shadowing", 1, elapsedSec(started, LOG_CAP_SEC));
    });
  }

  /** 自分の番を終えて次へ（聞き取り中なら取りやめる） */
  function advance() {
    stopListening();
    advanceRef.current?.();
  }

  /** 自分の役を選ぶ（ロールプレイ中は選べない。選び直したら最初から） */
  function chooseRole(name: string) {
    if (rpRunning) return;
    setParams({ mode: "role", role: name }, { replace: true });
    setRpNext(0);
    setRpDone(false);
  }

  // ロールプレイ中に画面が隠れたら止める（あなたの番が見えないまま進まないように）。再開はその行から
  useEffect(() => {
    if (!rpRunning) return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") stopRole();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
    // stopRole は ref と state の setter だけを使うので、依存は rpRunning だけでよい
  }, [rpRunning]);

  function setMode(m: Mode) {
    if (m === mode || recording) return;
    stopAll();
    stopRole();
    // 自分の役はほかのモードに移っても覚えておく（ロールプレイに戻ったときに選び直さなくてよい）
    const next: Record<string, string> = m === "line" ? {} : { mode: m };
    if (myRole) next.role = myRole;
    setParams(next, { replace: true });
  }

  // 1文ずつモードの連続再生: 読んでいる行を画面に入れる
  const lineRefs = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    if (mode !== "line" || !player.playing || player.activeIdx === null) return;
    lineRefs.current[player.activeIdx]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [mode, player.playing, player.activeIdx]);

  // 画面を離れたら: 録音を捨ててマイクを閉じ、再生とロールプレイを止め、録音の URL をすべて解放する
  // （お手本の読み上げは useSequencePlayer が止める。🎤 の聞き取りは SayItButton が止める）
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      cmpTokRef.current++;
      const rp = rpCtrlRef.current;
      rpCtrlRef.current = null;
      advanceRef.current = null;
      if (rp) {
        rp.abort();
        audio.cancel();
      }
      const sess = sessionRef.current;
      sessionRef.current = null;
      sess?.handle?.cancel();
      const own = ownRef.current;
      ownRef.current = null;
      if (own) {
        own.el.pause();
        own.finish(false);
      }
      bag.revokeAll();
    };
  }, [bag]);

  // ロールプレイ: 進めている行を画面の中ほどに入れる
  useEffect(() => {
    if (mode !== "role" || !rpRunning || rpLine === null) return;
    lineRefs.current[rpLine]?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [mode, rpRunning, rpLine]);

  const fullPhase = rec?.key === FULL_KEY ? rec.phase : null;
  const modes: Mode[] = speakers ? ["line", "full", "role"] : ["line", "full"];
  /** 行の話者のチップ（会話のときだけ） */
  const speakerChip = (i: number) => {
    const sp = lineSpeaker(lines[i]);
    const idx = speakerIdx(sp);
    return sp !== null && idx >= 0 ? <SpeakerChip name={sp} idx={idx} me={mode === "role" && sp === myRole} /> : null;
  };
  // 上の固定バーの主ボタン: ロールプレイでは開始／停止、それ以外はお手本の全文再生
  const roleLabel = rpRunning ? "■ 停止" : rpNext > 0 ? "▶ 続きから" : "▶ スタート";

  return (
    <div className="animate-fade-in space-y-4">
      <button onClick={onBack} className="min-h-11 pr-2 text-sm text-brand-green">‹ 一覧</button>
      <h1 className="text-lg font-bold text-brand-ink">{script.title}</h1>
      {speakers && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
          <span>💬 会話:</span>
          <SpeakerChip name={speakers[0]} idx={0} />
          <SpeakerChip name={speakers[1]} idx={1} />
        </div>
      )}

      {/* 練習のしかた（録音中は切り替えない） */}
      <div className="flex rounded-xl bg-slate-100 p-1 text-sm" role="group" aria-label="練習のしかた">
        {modes.map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            disabled={recording && mode !== m}
            aria-pressed={mode === m}
            className={`min-h-11 flex-1 rounded-lg px-2 transition disabled:opacity-40 ${
              mode === m ? "bg-white font-bold text-brand-ink shadow-sm" : "text-slate-500"
            }`}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      {/* お手本コントロール（スクロールしても止められるよう、ヘッダーの下に固定） */}
      <div className="sticky top-[var(--hdr,53px)] z-10 -mx-4 flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white/95 px-4 py-1.5 backdrop-blur">
        {mode === "role" ? (
          <button
            onClick={rpRunning ? stopRole : () => startRole()}
            disabled={!rpRunning && !myRole}
            className={`btn ${rpRunning ? "bg-rose-500 text-white" : "btn-primary"} min-h-11 px-3 py-1.5 text-sm`}
          >
            {roleLabel}
          </button>
        ) : (
          <button
            onClick={player.playing ? stopAll : () => void playAllModel()}
            className={`btn ${player.playing ? "bg-rose-500 text-white" : "btn-primary"} min-h-11 px-3 py-1.5 text-sm`}
          >
            {player.playing ? "■ 停止" : "▶ お手本(全文)"}
          </button>
        )}
        <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs" role="group" aria-label="再生の速さ">
          {speeds.map((s) => {
            const on = Math.abs(speed - s) < 0.001;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                aria-pressed={on}
                className={`min-h-11 min-w-11 rounded px-2 ${on ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}
              >
                {s.toFixed(1)}x
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-xs">
        <button onClick={() => setShowScript((v) => !v)} className={`chip min-h-11 px-3.5 ring-1 ${showScript ? "bg-white text-slate-600 ring-slate-200" : "bg-brand-green text-white ring-brand-green"}`}>
          {showScript ? "🙈 スクリプトを隠す" : "👁 スクリプトを表示"}
        </button>
        <button onClick={() => setShowKana((v) => !v)} className={`chip min-h-11 min-w-11 justify-center px-3.5 ring-1 ${showKana ? "bg-brand-green text-white ring-brand-green" : "bg-white text-slate-600 ring-slate-200"}`}>
          カナ
        </button>
        <button onClick={() => setShowJa((v) => !v)} className={`chip min-h-11 min-w-11 justify-center px-3.5 ring-1 ${showJa ? "bg-brand-green text-white ring-brand-green" : "bg-white text-slate-600 ring-slate-200"}`}>
          訳
        </button>
      </div>

      {mode !== "role" && !support.ok && (
        <p className="rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-700">🎤 {recErrorMessage(support.kind)}</p>
      )}
      {micError && (
        <p role="alert" className="rounded-xl bg-rose-50 p-3 text-xs leading-relaxed text-rose-600">
          {micError}
        </p>
      )}

      {mode === "role" && speakers ? (
        <>
          {/* 自分の役（ロールプレイ中は変えない） */}
          <div className="card space-y-2 p-3">
            <div className="text-xs font-medium text-slate-400">🙋 自分の役を選ぶ</div>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="自分の役">
              {speakers.map((sp, k) => {
                const on = myRole === sp;
                return (
                  <button
                    key={sp}
                    type="button"
                    onClick={() => chooseRole(sp)}
                    disabled={rpRunning}
                    aria-pressed={on}
                    className={`min-h-11 truncate rounded-xl px-3 text-sm font-bold ring-1 transition disabled:opacity-60 ${
                      on ? SPEAKER_TONE[k].on : "bg-white text-slate-600 ring-slate-200"
                    }`}
                  >
                    {on ? "🙋 " : ""}
                    {sp}
                  </button>
                );
              })}
            </div>
            {!rpRunning && rpNext > 0 && (
              <button type="button" onClick={() => startRole(0)} className="btn-ghost min-h-11 w-full text-sm">
                ↺ 最初から
              </button>
            )}
            <p className="text-[11px] leading-relaxed text-slate-400">
              {myRole
                ? `相手（${speakers.find((s) => s !== myRole)}）のセリフを読み上げます。黄色の「あなたの番」で、自分のセリフを言いましょう。`
                : "どちらの役を話すか選んでから ▶ スタート。"}
              {myRole &&
                (speechOn && speechInput.isSupported()
                  ? " あなたの番では 🎤 言ってみる で言ってから「次へ」。"
                  : " 考える間が過ぎると次へ進みます（「次へ」で先へ）。")}
              {myRole && " スクリプトを隠すと、自分のセリフは訳だけになります。"}
            </p>
          </div>
          {rpDone && (
            <p className="animate-fade-in rounded-xl bg-emerald-50 p-3 text-sm leading-relaxed text-emerald-700" aria-live="polite">
              ✓ 最後まで通しました。役を交代して、もう一度やってみよう。
            </p>
          )}

          {/* 会話（相手の行は左、自分の行は右寄せ） */}
          <ol className="space-y-2">
            {lines.map((l, i) => {
              const sp = lineSpeaker(l);
              const mineLine = myRole !== null && sp === myRole;
              const current = rpRunning && rpLine === i;
              const myTurnHere = turn?.line === i;
              const soloModel = player.activeIdx === i && !player.playing;
              const ring = current
                ? rpMine
                  ? "bg-amber-50 ring-2 ring-amber-300"
                  : "bg-emerald-50 ring-2 ring-emerald-300"
                : soloModel
                  ? "bg-emerald-50 ring-2 ring-emerald-200"
                  : "";
              return (
                <li
                  key={i}
                  ref={(el) => {
                    lineRefs.current[i] = el;
                  }}
                  className={`card p-3 transition ${mineLine ? "ml-6" : "mr-6"} ${ring}`}
                >
                  <div className="flex items-center gap-2">
                    {speakerChip(i)}
                    {current && rpMine && <span className="text-xs font-bold text-amber-600">🗣 あなたの番</span>}
                    {current && !rpMine && <span className="text-xs text-emerald-600">🔊 再生中</span>}
                    {/* 止まっている間は、行ごとにお手本を聴ける */}
                    {!rpRunning && (
                      <button
                        type="button"
                        onClick={() => playModel(i)}
                        aria-label={soloModel ? `${i + 1}行目のお手本を止める` : `${i + 1}行目のお手本を再生`}
                        className="-my-2 ml-auto flex min-h-11 min-w-11 items-center justify-center rounded-lg text-sm text-brand-green"
                      >
                        {soloModel ? "■" : "▶"}
                      </button>
                    )}
                  </div>
                  <div className="mt-1">
                    {showScript ? (
                      <>
                        <p className="text-[17px] leading-relaxed text-brand-ink">{l.pt}</p>
                        {showKana && <p className="text-xs leading-relaxed text-slate-400">{kanas[i]}</p>}
                        {showJa && l.ja && <p className="mt-0.5 text-sm leading-relaxed text-slate-500">{l.ja}</p>}
                      </>
                    ) : mineLine ? (
                      // 自分のセリフは訳を手がかりに言う
                      <p className="text-[15px] leading-relaxed text-slate-600">
                        <span className="mr-1 text-xs text-slate-400">🙈 訳を見て言おう:</span>
                        {l.ja || "（訳なし）"}
                      </p>
                    ) : (
                      <>
                        <p className="py-1 text-sm text-slate-300">🙈 音だけで</p>
                        {showJa && l.ja && <p className="mt-0.5 text-sm leading-relaxed text-slate-500">{l.ja}</p>}
                      </>
                    )}
                  </div>
                  {myTurnHere && turn && (
                    <div key={turn.key} className="mt-2 animate-fade-in space-y-2">
                      {turn.gapMs !== null ? (
                        <GapBar ms={turn.gapMs} />
                      ) : (
                        <SayItButton mode="sentence" expected={l.pt} />
                      )}
                      <button type="button" onClick={advance} className="btn-primary min-h-11 w-full text-sm">
                        次へ ›
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      ) : mode === "line" ? (
        <>
          <p className="text-xs leading-relaxed text-slate-400">
            ▶お手本を聴く → ●録音でまねして言う（■で止める）→ ⇄聞き比べ で、お手本と自分の声を続けて聴けます。
            {speechOn && speechInput.isSupported() && " 🎤言ってみる で、言えたかを音声認識で判定します。"}
            {speakers && " 会話は「ロールプレイ」で、片方の役を話す練習もできます。"}
          </p>
          <ol className="space-y-2">
            {lines.map((l, i) => {
              const active = player.activeIdx === i;
              // この文だけのお手本を再生中（聞き比べのお手本は除く）
              const soloModel = active && !player.playing && comparing !== i;
              const url = recs[i];
              const phase = rec?.key === i ? rec.phase : null;
              const ownHere = ownKey === i && comparing !== i;
              const chip = speakerChip(i);
              return (
                <li
                  key={i}
                  ref={(el) => {
                    lineRefs.current[i] = el;
                  }}
                  className={`card p-3 transition ${active ? "bg-emerald-50 ring-2 ring-emerald-300" : ""}`}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-1 w-5 shrink-0 text-right text-xs font-bold text-slate-300">{i + 1}</span>
                    <div className="min-w-0 flex-1">
                      {chip && <div className="mb-0.5">{chip}</div>}
                      {showScript ? (
                        <>
                          <p className="text-[17px] leading-relaxed text-brand-ink">{l.pt}</p>
                          {showKana && <p className="text-xs leading-relaxed text-slate-400">{kanas[i]}</p>}
                        </>
                      ) : (
                        <p className="py-1 text-sm text-slate-300">🙈 音だけで</p>
                      )}
                      {showJa && l.ja && <p className="mt-0.5 text-sm leading-relaxed text-slate-500">{l.ja}</p>}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-4 gap-1.5">
                    <LineButton
                      icon={soloModel ? "■" : "▶"}
                      label="お手本"
                      active={soloModel}
                      onClick={() => playModel(i)}
                      ariaLabel={soloModel ? `${i + 1}文目のお手本を止める` : `${i + 1}文目のお手本を再生`}
                    />
                    <LineButton
                      tone="rose"
                      icon={phase === "on" ? "■" : phase === "starting" ? "…" : "●"}
                      label={phase === "on" ? "停止" : phase === "starting" ? "準備中" : "録音"}
                      active={phase !== null}
                      pulse={phase === "on"}
                      disabled={!support.ok || (recording && phase === null)}
                      onClick={() => toggleRec(i)}
                      ariaLabel={phase === "on" ? `${i + 1}文目の録音を止める` : phase === "starting" ? "録音の準備を取り消す" : `${i + 1}文目を録音`}
                    />
                    <LineButton
                      icon={ownHere ? "■" : "▶"}
                      label="自分"
                      active={ownHere}
                      disabled={!url || recording}
                      onClick={() => playOwn(i)}
                      ariaLabel={ownHere ? "自分の録音を止める" : `${i + 1}文目の自分の録音を再生`}
                    />
                    <LineButton
                      icon={comparing === i ? "■" : "⇄"}
                      label="聞き比べ"
                      active={comparing === i}
                      disabled={!url || recording}
                      onClick={() => void compare(i)}
                      ariaLabel={comparing === i ? "聞き比べを止める" : `${i + 1}文目をお手本→自分の順で再生`}
                    />
                  </div>
                  {/* 🎤 言ってみる（音声認識がオンのときだけ出る）。お手本・自分の録音は止めてから聞く。録音中は押せない */}
                  <SayItButton mode="sentence" expected={l.pt} onStart={stopAll} disabled={recording} className="mt-2" />
                </li>
              );
            })}
          </ol>
        </>
      ) : (
        <>
          {/* 録音コントロール（全文を通して） */}
          <div className="card space-y-2 p-3">
            <div className="text-xs font-medium text-slate-400">🎤 ボイスレコーダー（お手本を追いかけて発話）</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleRec(FULL_KEY)}
                disabled={!support.ok || (recording && fullPhase === null)}
                className={`btn min-h-11 flex-1 py-2 text-sm ${
                  fullPhase === "on"
                    ? "animate-pulse bg-rose-500 text-white"
                    : fullPhase === "starting"
                      ? "bg-rose-500 text-white"
                      : "bg-rose-50 text-rose-600 ring-1 ring-rose-200"
                }`}
              >
                {fullPhase === "on" ? "■ 録音停止" : fullPhase === "starting" ? "… 準備中" : "● 録音開始"}
              </button>
              <button onClick={() => playOwn(FULL_KEY)} disabled={!recs[FULL_KEY] || recording} className="btn-ghost min-h-11 flex-1 py-2 text-sm">
                {ownKey === FULL_KEY ? "■ 止める" : "▶ 自分の声を聴く"}
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              録音しながら ▶お手本(全文) を流すと、追いかけて話した声を録れます。イヤホンを使うと、お手本の音が録音に入りにくくなります。
            </p>
          </div>

          {/* まとまった長文パッセージ（文をタップでその文だけ再生。全文再生の途中なら止めて読む）。会話は行ごとに話者を出す */}
          <div className="card p-4">
            {showScript ? (
              <>
                {speakers ? (
                  <ol className="space-y-1.5">
                    {lines.map((l, i) => (
                      <li
                        key={i}
                        onClick={() => playModel(i)}
                        className={`flex min-h-11 cursor-pointer items-center gap-2 rounded px-1 py-0.5 transition ${
                          player.activeIdx === i ? "bg-emerald-100" : "hover:bg-slate-50"
                        }`}
                      >
                        {speakerChip(i)}
                        <span className="text-[17px] leading-relaxed text-brand-ink">{l.pt}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-[17px] leading-loose">
                    {lines.map((l, i) => (
                      <span
                        key={i}
                        onClick={() => playModel(i)}
                        className={`cursor-pointer rounded px-0.5 transition ${
                          player.activeIdx === i ? "bg-emerald-100 text-brand-ink" : "text-brand-ink hover:text-brand-green"
                        }`}
                      >
                        {l.pt}{" "}
                      </span>
                    ))}
                  </p>
                )}
                {showKana && <p className="mt-3 border-t border-slate-100 pt-2 text-xs leading-relaxed text-slate-400">{fullKana}</p>}
                {showJa && <p className="mt-2 text-sm leading-relaxed text-slate-500">{fullJa}</p>}
              </>
            ) : (
              <div className="py-12 text-center text-sm leading-relaxed text-slate-400">
                🙈 スクリプト非表示中<br />
                音声だけを頼りに、1〜2語遅れて追いかけましょう。
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 詳細画面（/practice/shadowing/:id）。URL の ID で教材を開く（スクリプト、または "p:<読み物の id>"）。
 * Android の戻る操作で一覧に戻れるよう、画面の切替は state ではなくルートで行う。
 * 見つからない ID（削除した自作教材など）は一覧へ置き換えで戻す。
 */
export function ShadowingDetail() {
  const { id } = useParams();
  const materials = useMaterials();
  const material = materials.find((m) => m.script.id === id);
  const back = useBack(LIST_PATH);

  if (!material) return <Navigate to={LIST_PATH} replace />;
  // 別の教材へ移ったら録音や再生の状態を持ち越さないよう作り直す
  return <Player key={material.script.id} script={material.script} speakers={material.speakers ?? null} onBack={back} />;
}

const MATERIAL_ICON: Record<Material["kind"], string> = { dialogue: "💬", script: "🗣️", passage: "📖" };

function MaterialLink({ m }: { m: Material }) {
  const n = m.script.lines.length;
  const meta = [m.level ? LEVEL_LABEL[m.level] : null, `${n}文`, m.speakers ? `${m.speakers[0]} / ${m.speakers[1]}` : null]
    .filter(Boolean)
    .join(" ・ ");
  const desc = m.kind !== "passage" ? m.script.description : undefined;
  return (
    <Link
      to={`${LIST_PATH}/${encodeURIComponent(m.script.id)}`}
      className="card flex w-full items-center gap-3 p-3 text-left transition hover:ring-brand-green/40"
    >
      <span className="text-xl">{MATERIAL_ICON[m.kind]}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-brand-ink">{m.script.title}</div>
        {desc && <div className="truncate text-xs text-slate-500">{desc}</div>}
        <div className="truncate text-xs text-slate-400">{meta}</div>
      </div>
      {m.source && m.source !== "original" && (
        <span className="chip shrink-0 bg-amber-100 text-amber-600">{m.source === "custom" ? "自作" : "取込"}</span>
      )}
      <span className="text-slate-300">›</span>
    </Link>
  );
}

/** 一覧のまとまり（会話 → スクリプト → 読み物） */
const SECTIONS: { kind: Material["kind"]; title: string }[] = [
  { kind: "dialogue", title: "会話（ロールプレイもできる）" },
  { kind: "script", title: "スクリプト" },
  { kind: "passage", title: "読み物（チャンクリーディングの教材を1文ずつ）" },
];

export default function Shadowing() {
  const materials = useMaterials();
  // 難易度の絞り込みは URL（?level=、置き換え）に持つ。詳細から戻っても同じ絞り込みで開く
  const [params, setParams] = useSearchParams();
  const level = parseLevelFilter(params.get("level"));
  const shown = materials.filter((m) => matchesLevel(m.level, level));

  return (
    <div className="animate-fade-in space-y-4">
      <Link to="/practice" className="inline-flex min-h-11 items-center pr-2 text-sm text-brand-green">‹ 練習に戻る</Link>
      <div>
        <h1 className="text-xl font-bold text-brand-ink">シャドーイング</h1>
        <p className="text-sm text-slate-500">1文ずつ お手本→録音→聞き比べ。慣れたら全文を追いかけて発話しよう。会話は片方の役を話すロールプレイもできます。</p>
      </div>
      <FilterChips
        label="難易度"
        options={LEVEL_FILTERS}
        value={level}
        onChange={(v) => setParams(v === "all" ? {} : { level: v }, { replace: true })}
      />
      {shown.length === 0 && <p className="card p-4 text-center text-sm text-slate-400">この難易度の教材はありません。</p>}
      {SECTIONS.map((sec) => {
        const list = shown.filter((m) => m.kind === sec.kind);
        if (list.length === 0) return null;
        return (
          <section key={sec.kind} className="space-y-2">
            <h2 className="px-1 text-xs font-bold text-slate-400">
              {sec.title}（{list.length}）
            </h2>
            {list.map((m) => (
              <MaterialLink key={m.script.id} m={m} />
            ))}
          </section>
        );
      })}
    </div>
  );
}
