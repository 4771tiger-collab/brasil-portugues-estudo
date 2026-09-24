import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { SCRIPTS } from "../data/content";
import type { Script } from "../data/types";
import { useSettings } from "../store/useSettings";
import { audio } from "../services/audio";
import { toKana } from "../services/pronunciation";

const SPEEDS = [0.8, 1.0, 1.2];

function Player({ script, onBack }: { script: Script; onBack: () => void }) {
  const voiceURI = useSettings((s) => s.voiceURI);
  const [speed, setSpeed] = useState(1.0);
  const [showScript, setShowScript] = useState(true);
  const [showKana, setShowKana] = useState(false);
  const [showJa, setShowJa] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const fullKana = useMemo(() => script.lines.map((l) => l.kana ?? toKana(l.pt)).join(" "), [script]);
  const fullJa = useMemo(() => script.lines.map((l) => l.ja).join(" "), [script]);
  const [playing, setPlaying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // 録音
  const [recording, setRecording] = useState(false);
  const [recUrl, setRecUrl] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const ownAudioRef = useRef<HTMLAudioElement | null>(null);

  function stopModel() {
    abortRef.current?.abort();
    audio.cancel();
    setPlaying(false);
    setActiveIdx(null);
  }
  async function playAll() {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPlaying(true);
    try {
      await audio.speakSequence(script.lines.map((l) => l.pt), {
        rate: speed,
        voiceURI,
        gapMs: 500,
        onIndex: setActiveIdx,
        signal: ctrl.signal,
      });
    } finally {
      if (!ctrl.signal.aborted) {
        setPlaying(false);
        setActiveIdx(null);
      }
    }
  }

  async function startRec() {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size > 0 && chunksRef.current.push(e.data);
      rec.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (recUrl) URL.revokeObjectURL(recUrl);
        setRecUrl(URL.createObjectURL(blob));
        streamRef.current?.getTracks().forEach((t) => t.stop());
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
    } catch (e) {
      setMicError("マイクにアクセスできませんでした。ブラウザの権限を確認してください。");
    }
  }
  function stopRec() {
    recorderRef.current?.stop();
    setRecording(false);
  }
  function playOwn() {
    if (!recUrl) return;
    ownAudioRef.current?.pause();
    const a = new Audio(recUrl);
    ownAudioRef.current = a;
    a.play();
  }

  useEffect(
    () => () => {
      stopModel();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (recUrl) URL.revokeObjectURL(recUrl);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  return (
    <div className="animate-fade-in space-y-4">
      <button onClick={onBack} className="text-sm text-brand-green">‹ 一覧</button>
      <h1 className="text-lg font-bold text-brand-ink">{script.title}</h1>

      {/* お手本コントロール */}
      <div className="card space-y-2 p-3">
        <div className="flex items-center gap-2">
          <button onClick={playing ? stopModel : playAll} className={`btn ${playing ? "bg-rose-500 text-white" : "btn-primary"} px-3 py-1.5 text-sm`}>
            {playing ? "■ 停止" : "▶ お手本(全文)"}
          </button>
          <div className="flex items-center rounded-lg bg-slate-100 p-0.5 text-xs">
            {SPEEDS.map((s) => (
              <button key={s} onClick={() => setSpeed(s)} className={`rounded px-2 py-1 ${speed === s ? "bg-white font-bold shadow-sm" : "text-slate-500"}`}>
                {s.toFixed(1)}x
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <button onClick={() => setShowScript((v) => !v)} className={`chip ring-1 ${showScript ? "bg-white text-slate-600 ring-slate-200" : "bg-brand-green text-white ring-brand-green"}`}>
            {showScript ? "🙈 スクリプトを隠す" : "👁 スクリプトを表示"}
          </button>
          <button onClick={() => setShowKana((v) => !v)} className={`chip ring-1 ${showKana ? "bg-brand-green text-white ring-brand-green" : "bg-white text-slate-600 ring-slate-200"}`}>
            カナ
          </button>
          <button onClick={() => setShowJa((v) => !v)} className={`chip ring-1 ${showJa ? "bg-brand-green text-white ring-brand-green" : "bg-white text-slate-600 ring-slate-200"}`}>
            訳
          </button>
        </div>
      </div>

      {/* 録音コントロール */}
      <div className="card space-y-2 p-3">
        <div className="text-xs font-medium text-slate-400">🎤 ボイスレコーダー（お手本を追いかけて発話）</div>
        <div className="flex items-center gap-2">
          <button
            onClick={recording ? stopRec : startRec}
            className={`btn flex-1 py-2 text-sm ${recording ? "bg-rose-500 text-white animate-pulse" : "bg-rose-50 text-rose-600 ring-1 ring-rose-200"}`}
          >
            {recording ? "■ 録音停止" : "● 録音開始"}
          </button>
          <button onClick={playOwn} disabled={!recUrl} className="btn-ghost flex-1 py-2 text-sm">
            ▶ 自分の声を聴く
          </button>
        </div>
        {micError && <p className="text-xs text-rose-500">{micError}</p>}
      </div>

      {/* まとまった長文パッセージ */}
      <div className="card p-4">
        {showScript ? (
          <>
            <p className="text-[17px] leading-loose">
              {script.lines.map((l, i) => (
                <span
                  key={i}
                  onClick={() => audio.speak(l.pt, { rate: speed, voiceURI })}
                  className={`cursor-pointer rounded px-0.5 transition ${
                    activeIdx === i ? "bg-emerald-100 text-brand-ink" : "text-brand-ink hover:text-brand-green"
                  }`}
                >
                  {l.pt}{" "}
                </span>
              ))}
            </p>
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
    </div>
  );
}

export default function Shadowing() {
  const [selected, setSelected] = useState<Script | null>(null);
  if (selected) return <Player script={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="animate-fade-in space-y-4">
      <Link to="/practice" className="text-sm text-brand-green">‹ 練習に戻る</Link>
      <div>
        <h1 className="text-xl font-bold text-brand-ink">シャドーイング</h1>
        <p className="text-sm text-slate-500">お手本のすぐ後を追って発話。マイクで録音して聞き比べよう。</p>
      </div>
      <div className="space-y-2">
        {SCRIPTS.map((s) => (
          <button key={s.id} onClick={() => setSelected(s)} className="card flex w-full items-center gap-3 p-3 text-left transition hover:ring-brand-green/40">
            <span className="text-xl">🗣️</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium text-brand-ink">{s.title}</div>
              {s.description && <div className="truncate text-xs text-slate-400">{s.description}</div>}
            </div>
            <span className="text-slate-300">›</span>
          </button>
        ))}
      </div>
    </div>
  );
}
