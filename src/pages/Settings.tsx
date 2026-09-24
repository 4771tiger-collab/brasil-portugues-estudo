import { useEffect, useRef, useState } from "react";
import { useSettings } from "../store/useSettings";
import { exportAll, importAll, resetAllProgress } from "../store/backup";
import { audio } from "../services/audio";

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-1 py-3">
      <div className="min-w-0">
        <div className="font-medium text-brand-ink">{label}</div>
        {hint && <div className="text-xs text-slate-400">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export default function Settings() {
  const s = useSettings();

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    audio.ready().then(() => setVoices(audio.getVoices()));
  }, []);

  function flash(m: string) {
    setMsg(m);
    setTimeout(() => setMsg(null), 2500);
  }

  function doExport() {
    const blob = new Blob([exportAll()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bp-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const ok = importAll(String(reader.result));
      flash(ok ? "進捗を復元しました" : "ファイルの読み込みに失敗しました");
    };
    reader.readAsText(file);
  }

  return (
    <div className="animate-fade-in space-y-5">
      <h1 className="text-xl font-bold text-brand-ink">設定</h1>

      {/* 学習 */}
      <section className="card divide-y divide-slate-100 p-3">
        <Row label="再生速度" hint="音声のデフォルト速度">
          <select
            value={s.rate}
            onChange={(e) => s.set({ rate: Number(e.target.value) })}
            className="rounded-lg border border-slate-200 px-2 py-1.5"
          >
            {[0.7, 0.8, 0.9, 1.0, 1.1, 1.2].map((r) => (
              <option key={r} value={r}>
                {r.toFixed(1)}x
              </option>
            ))}
          </select>
        </Row>
        <Row label="1日の新規語数" hint="今日の学習で導入する新語の上限">
          <input
            type="number"
            min={0}
            max={100}
            value={s.dailyNewLimit}
            onChange={(e) => s.set({ dailyNewLimit: Math.max(0, Number(e.target.value)) })}
            className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-right"
          />
        </Row>
        <Row label="1日の目標枚数" hint="ホームの進捗バーの目標">
          <input
            type="number"
            min={0}
            max={500}
            value={s.dailyGoal}
            onChange={(e) => s.set({ dailyGoal: Math.max(0, Number(e.target.value)) })}
            className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-right"
          />
        </Row>
        <Row label="カタカナ発音ガイド">
          <input type="checkbox" checked={s.showKana} onChange={(e) => s.set({ showKana: e.target.checked })} className="h-5 w-5 accent-brand-green" />
        </Row>
        <Row label="IPA 発音記号">
          <input type="checkbox" checked={s.showIpa} onChange={(e) => s.set({ showIpa: e.target.checked })} className="h-5 w-5 accent-brand-green" />
        </Row>
      </section>

      {/* 音楽 */}
      <section className="card divide-y divide-slate-100 p-3">
        <Row label="🎵 曲の単語（1日の上限）" hint="曲から追加した語を今日の学習に出す数">
          <input
            type="number"
            min={0}
            max={100}
            value={s.musicNewLimit}
            onChange={(e) => s.set({ musicNewLimit: Math.max(0, Number(e.target.value)) })}
            className="w-20 rounded-lg border border-slate-200 px-2 py-1.5 text-right"
          />
        </Row>
        <Row label="単語タップで一時停止" hint="歌詞の単語を調べる間は動画を止める">
          <input
            type="checkbox"
            checked={s.pauseOnWordTap}
            onChange={(e) => s.set({ pauseOnWordTap: e.target.checked })}
            className="h-5 w-5 accent-brand-green"
          />
        </Row>
      </section>

      {/* 音声 */}
      <section className="card p-3">
        <Row label="音声(ボイス)" hint={voices.length ? `${voices.length}件のpt系音声` : "pt-BR音声が見つかりません"}>
          <select
            value={s.voiceURI ?? ""}
            onChange={(e) => s.set({ voiceURI: e.target.value || null })}
            className="max-w-[180px] rounded-lg border border-slate-200 px-2 py-1.5"
          >
            <option value="">自動選択</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} ({v.lang})
              </option>
            ))}
          </select>
        </Row>
        <button
          onClick={() => audio.speak("Olá! Tudo bem? Eu estou aprendendo português.", { rate: s.rate, voiceURI: s.voiceURI })}
          className="btn-ghost w-full"
        >
          🔊 テスト再生
        </button>
        {voices.length === 0 && (
          <p className="mt-2 text-xs text-slate-400">
            ブラジルポルトガル語の音声が無い場合、OSに音声を追加すると品質が向上します（Windows: 設定→時刻と言語→音声）。
          </p>
        )}
      </section>

      {/* データ */}
      <section className="card space-y-2 p-3">
        <h2 className="px-1 text-sm font-bold text-slate-500">バックアップ</h2>
        <p className="px-1 text-xs text-slate-400">進捗・曲の和訳・曲から追加した単語を保存します（歌詞そのものは含みません）。</p>
        <div className="flex gap-2">
          <button onClick={doExport} className="btn-ghost flex-1">
            ⬇ エクスポート
          </button>
          <button onClick={() => fileRef.current?.click()} className="btn-ghost flex-1">
            ⬆ インポート
          </button>
          <input ref={fileRef} type="file" accept="application/json" onChange={onFile} className="hidden" />
        </div>
        <button
          onClick={() => {
            if (confirm("学習の進捗をすべて消去します。よろしいですか？")) {
              resetAllProgress();
              flash("進捗をリセットしました");
            }
          }}
          className="btn w-full bg-rose-50 py-2 text-rose-600 ring-1 ring-rose-200"
        >
          進捗をリセット
        </button>
      </section>

      {msg && <div className="rounded-lg bg-brand-ink/90 px-4 py-2 text-center text-sm text-white">{msg}</div>}

      <p className="text-center text-xs text-slate-400">ブラジルポルトガル語 学習帳 v0.1</p>
    </div>
  );
}
