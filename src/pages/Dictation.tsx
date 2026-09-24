import { useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { DICTATIONS } from "../data/content";
import type { DictationItem } from "../data/types";
import { useSettings } from "../store/useSettings";
import { audio } from "../services/audio";
import { toKana } from "../services/pronunciation";
import SpeakerButton from "../components/SpeakerButton";
import { useBack } from "../hooks/useBack";

/** 一覧の URL。詳細は /practice/dictation/:id（id は DICTATIONS の id） */
const LIST_PATH = "/practice/dictation";

const LEVELS = [
  { v: "all", label: "すべて" },
  { v: "short", label: "短文" },
  { v: "medium", label: "中文" },
  { v: "long", label: "長文" },
] as const;
type LevelFilter = (typeof LEVELS)[number]["v"];
const isLevelFilter = (v: string | null): v is LevelFilter => LEVELS.some((l) => l.v === v);

/** 書き取りの入力欄: 端末の自動修正・先頭の大文字化・予測変換を止め、pt-BR のキーボードを促す */
const PT_INPUT_PROPS = {
  autoCapitalize: "none",
  autoCorrect: "off",
  autoComplete: "off",
  spellCheck: false,
  lang: "pt-BR",
} as const;

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.,!?；;:—–\-"'“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function maskWord(w: string): string {
  let seen = false;
  let out = "";
  for (const ch of w) {
    if (/\p{L}/u.test(ch)) {
      if (!seen) { out += ch; seen = true; } else out += "_";
    } else out += ch;
  }
  return out;
}

function grade(user: string, answer: string) {
  const ua = norm(user).split(" ").filter(Boolean);
  const aa = norm(answer).split(" ").filter(Boolean);
  const words = aa.map((w, i) => ({ w, ok: ua[i] === w }));
  const correct = words.filter((x) => x.ok).length;
  return { correct, total: aa.length, words };
}

function Runner({ item, onBack }: { item: DictationItem; onBack: () => void }) {
  const voiceURI = useSettings((s) => s.voiceURI);
  const rate = useSettings((s) => s.rate);
  const [step, setStep] = useState(1);
  const [input1, setInput1] = useState("");
  const [input3, setInput3] = useState("");
  const [graded1, setGraded1] = useState(false);
  const [graded3, setGraded3] = useState(false);

  const hint = useMemo(() => item.text.split(" ").map(maskWord).join(" "), [item.text]);
  const play = (r = rate) => audio.speak(item.text, { rate: r, voiceURI });

  const steps = ["聴き取り", "語彙予習", "ヒント入力", "訳・定着"];

  return (
    <div className="animate-fade-in space-y-4">
      <button onClick={onBack} className="min-h-11 pr-2 text-sm text-brand-green">‹ 一覧</button>

      {/* ステップ表示 */}
      <div className="flex items-center gap-1">
        {steps.map((s, i) => (
          <div key={i} className="flex flex-1 flex-col items-center">
            <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${step === i + 1 ? "bg-brand-green text-white" : step > i + 1 ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
              {i + 1}
            </div>
            <div className={`mt-1 text-[10px] ${step === i + 1 ? "font-bold text-brand-ink" : "text-slate-400"}`}>{s}</div>
          </div>
        ))}
      </div>

      <div className="card space-y-3 p-4">
        {/* STEP 1 */}
        {step === 1 && (
          <>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-brand-ink">STEP 1: 聴き取り（ヒントなし）</h2>
              <SpeakerButton text={item.text} size={26} />
            </div>
            <p className="text-xs text-slate-400">音声を聴いて、聞こえたポルトガル語を入力しましょう。</p>
            <div className="flex gap-2 text-sm">
              <button onClick={() => play(rate)} className="btn-ghost flex-1 py-2">▶ 通常</button>
              <button onClick={() => play(0.8)} className="btn-ghost flex-1 py-2">▶ ゆっくり(0.8x)</button>
            </div>
            <textarea
              value={input1}
              onChange={(e) => setInput1(e.target.value)}
              {...PT_INPUT_PROPS}
              rows={2}
              placeholder="ここに入力…"
              className="w-full rounded-xl border border-slate-200 p-3"
            />
            {!graded1 ? (
              <button onClick={() => setGraded1(true)} className="btn-primary w-full py-2">答え合わせ</button>
            ) : (
              <Result user={input1} item={item} />
            )}
          </>
        )}

        {/* STEP 2 */}
        {step === 2 && (
          <>
            <h2 className="font-bold text-brand-ink">STEP 2: 重要語彙の予習</h2>
            <p className="text-xs text-slate-400">例文に含まれる重要な語を確認しましょう。</p>
            <div className="space-y-2">
              {item.keyVocab.length === 0 && <p className="text-sm text-slate-400">この例文に登録された重要語はありません。</p>}
              {item.keyVocab.map((v, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg bg-slate-50 p-3">
                  <div className="flex-1">
                    <div className="font-bold text-brand-ink">{v.pt}</div>
                    <div className="text-xs text-slate-400">{toKana(v.pt)}</div>
                    <div className="text-sm text-slate-500">{v.ja}</div>
                  </div>
                  <SpeakerButton text={v.pt} />
                </div>
              ))}
            </div>
          </>
        )}

        {/* STEP 3 */}
        {step === 3 && (
          <>
            <div className="flex items-center justify-between">
              <h2 className="font-bold text-brand-ink">STEP 3: ヒントあり入力</h2>
              <SpeakerButton text={item.text} size={26} />
            </div>
            <div className="rounded-lg bg-slate-50 p-3 font-mono text-lg tracking-wide text-slate-600">{hint}</div>
            <textarea
              value={input3}
              onChange={(e) => setInput3(e.target.value)}
              {...PT_INPUT_PROPS}
              rows={2}
              placeholder="頭文字と文字数を手がかりに入力…"
              className="w-full rounded-xl border border-slate-200 p-3"
            />
            {!graded3 ? (
              <button onClick={() => setGraded3(true)} className="btn-primary w-full py-2">答え合わせ</button>
            ) : (
              <Result user={input3} item={item} />
            )}
          </>
        )}

        {/* STEP 4 */}
        {step === 4 && (
          <>
            <h2 className="font-bold text-brand-ink">STEP 4: 訳の確認＋オーバーラッピング</h2>
            <div className="flex items-center gap-2 rounded-lg bg-emerald-50 p-3">
              <div className="flex-1 text-lg font-bold text-brand-ink">{item.text}</div>
              <SpeakerButton text={item.text} />
            </div>
            <div className="text-xs text-slate-400">{toKana(item.text)}</div>
            <div className="rounded-lg bg-slate-50 p-3 text-slate-600">{item.ja}</div>
            <div className="rounded-xl bg-brand-green/5 p-3">
              <p className="mb-2 text-xs text-slate-500">
                🔁 仕上げ：本文を見ながら、音声に<strong>合わせて同時に声に出して</strong>読みましょう（オーバーラッピング）。発音・リズムが定着します。
              </p>
              <div className="flex gap-2">
                <button onClick={() => play(rate)} className="btn-primary flex-1 py-2 text-sm">▶ 音声に合わせて音読</button>
                <button onClick={() => play(0.8)} className="btn-ghost flex-1 py-2 text-sm">▶ ゆっくり(0.8x)</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* ナビゲーション */}
      <div className="flex gap-2">
        <button onClick={() => setStep((s) => Math.max(1, s - 1))} disabled={step === 1} className="btn-ghost flex-1 py-2.5">‹ 前へ</button>
        <button onClick={() => setStep((s) => Math.min(4, s + 1))} disabled={step === 4} className="btn-primary flex-1 py-2.5">次へ ›</button>
      </div>
    </div>
  );
}

function Result({ user, item }: { user: string; item: DictationItem }) {
  const g = grade(user, item.text);
  const pct = Math.round((g.correct / g.total) * 100);
  return (
    <div className="space-y-2 rounded-xl bg-slate-50 p-3">
      <div className="flex items-center justify-between">
        <span className="font-bold text-brand-ink">正解 {g.correct}/{g.total}語</span>
        <span className={`font-bold ${pct >= 80 ? "text-emerald-600" : pct >= 50 ? "text-amber-600" : "text-rose-600"}`}>{pct}%</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {g.words.map((x, i) => (
          <span key={i} className={`chip ${x.ok ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-600"}`}>{x.w}</span>
        ))}
      </div>
      <div className="border-t border-slate-200 pt-2 text-sm">
        <span className="text-slate-400">正解: </span>
        <span className="font-medium text-brand-ink">{item.text}</span>
      </div>
    </div>
  );
}

/**
 * 詳細画面（/practice/dictation/:id）。URL の ID で問題を開く。
 * Android の戻る操作で一覧に戻れるよう、画面の切替は state ではなくルートで行う。
 * 見つからない ID は一覧へ置き換えで戻す。
 */
export function DictationDetail() {
  const { id } = useParams();
  const item = DICTATIONS.find((d) => d.id === id);
  const back = useBack(LIST_PATH);

  if (!item) return <Navigate to={LIST_PATH} replace />;
  // 別の問題へ移ったら入力やステップを持ち越さないよう作り直す
  return <Runner key={item.id} item={item} onBack={back} />;
}

export default function Dictation() {
  // 難易度の絞り込みは URL（?level=）に持つ。一覧は詳細を開くとアンマウントされるので、
  // state だと戻ったときに「すべて」に戻ってしまう。履歴を増やさないよう replace で書き換える
  const [params, setParams] = useSearchParams();
  const q = params.get("level");
  const level: LevelFilter = isLevelFilter(q) ? q : "all";
  const setLevel = (v: LevelFilter) => setParams(v === "all" ? {} : { level: v }, { replace: true });
  const list = useMemo(() => (level === "all" ? DICTATIONS : DICTATIONS.filter((d) => d.level === level)), [level]);

  const levelLabel: Record<string, string> = { short: "短文", medium: "中文", long: "長文" };

  return (
    <div className="animate-fade-in space-y-4">
      <Link to="/practice" className="text-sm text-brand-green">‹ 練習に戻る</Link>
      <div>
        <h1 className="text-xl font-bold text-brand-ink">ディクテーション</h1>
        <p className="text-sm text-slate-500">音声を聴いて書き取る、4ステップの集中学習。</p>
      </div>
      <div className="flex gap-1.5">
        {LEVELS.map((l) => (
          <button key={l.v} onClick={() => setLevel(l.v)} className={`chip ring-1 ${level === l.v ? "bg-brand-green text-white ring-brand-green" : "bg-white text-slate-500 ring-slate-200"}`}>
            {l.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-slate-400">※ 一覧では答え（本文・和訳）は伏せています。挑戦してから答え合わせしましょう。</p>
      <div className="space-y-2">
        {list.map((d) => {
          const no = DICTATIONS.filter((x) => x.level === d.level).findIndex((x) => x.id === d.id) + 1;
          return (
            <Link key={d.id} to={`${LIST_PATH}/${encodeURIComponent(d.id)}`} className="card flex w-full items-center gap-3 p-3 text-left transition hover:ring-brand-green/40">
              <span className="text-xl">✍️</span>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-brand-ink">
                  {levelLabel[d.level]} 第{no}問{d.isDialogue ? "（会話）" : ""}
                </div>
                <div className="text-xs text-slate-400">音声を聴いて書き取り（約{d.text.split(/\s+/).length}語）</div>
              </div>
              <span className="text-slate-300">›</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
