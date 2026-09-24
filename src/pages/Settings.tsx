import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../store/useSettings";
import { applyBackup, describeBackup, parseBackup, resetAllProgress, saveBackupFile } from "../store/backup";
import { useMeta } from "../store/useMeta";
import { formatBytes, requestPersist, storageStatus, type StorageStatus } from "../services/platform";
import { diffDays, todayStr } from "../srs/scheduler";
import { audio, type VoiceInfo } from "../services/audio";
import type { StudyDirection, StudyViewMode } from "../data/types";
import UpdateBanner from "../components/UpdateBanner";
import { checkForUpdate, type UpdateCheckResult } from "../pwa/usePwa";

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

const isBrVoice = (v: VoiceInfo) => /^pt[-_]br/i.test(v.lang);

/** 今使われる音声と、その注意（pt-BR 以外・ネットワーク音声） */
function VoiceStatus({ supported, current }: { supported: boolean; current: VoiceInfo | null }) {
  if (!supported) {
    return (
      <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
        このブラウザは音声の読み上げに対応していません。Android の Chrome で開いてください。
      </p>
    );
  }
  if (!current) {
    return (
      <p className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
        ⚠ ポルトガル語の音声がありません。端末の既定の音声で読むため、発音が正しくありません。下の手順で pt-BR の音声を入れてください。
      </p>
    );
  }
  const br = isBrVoice(current);
  return (
    <div className="mb-2 space-y-1 px-1">
      <div className="text-xs text-slate-500">
        使用中: <span className="font-medium text-brand-ink">{current.name}</span> ({current.lang})
      </div>
      {!br && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          ⚠ ブラジルの音声ではありません（{current.lang}）。ポルトガル（欧州）の発音はブラジルとかなり違います。下の手順で pt-BR の音声を入れてください。
        </p>
      )}
      {!current.localService && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          ⚠ ネットワーク音声です。オフライン（機内モードなど）では鳴りません。端末に入っている音声を選ぶと、オフラインでも読み上げます。
        </p>
      )}
    </div>
  );
}

/** ビルド時刻（ISO）を端末の時刻で「2026-09-24 14:05」の形に */
function formatBuildTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const UPDATE_MSG: Record<UpdateCheckResult, string> = {
  found: "新しいバージョンがあります。準備ができると画面の上に「更新」が出ます",
  latest: "最新のバージョンです",
  unsupported: "この環境では更新を確認できません（開発版、または Service Worker が無効）",
  error: "確認できませんでした。ネットにつながっているか確かめてください",
};

/** バージョン表示と「更新を確認」 */
function AppInfo({ onMessage }: { onMessage: (m: string) => void }) {
  const [checking, setChecking] = useState(false);

  async function check() {
    setChecking(true);
    const r = await checkForUpdate();
    setChecking(false);
    onMessage(UPDATE_MSG[r]);
  }

  return (
    <div className="space-y-2 text-center">
      <p className="text-xs text-slate-400">
        ブラジルポルトガル語 学習帳 v{__APP_VERSION__} ({__BUILD_ID__}, {formatBuildTime(__BUILD_TIME__)})
      </p>
      <button type="button" onClick={() => void check()} disabled={checking} className="btn-ghost min-h-11 text-sm">
        {checking ? "確認中…" : "更新を確認"}
      </button>
    </div>
  );
}

/** データ保護（storage.persist）の状態と使用量。未保護なら理由と「保護を要求する」 */
function DataProtection({ onMessage }: { onMessage: (m: string, ms?: number) => void }) {
  const persistResult = useMeta((m) => m.persistResult);
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let alive = true;
    void storageStatus().then((st) => {
      if (alive) setStatus(st);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function ask() {
    setAsking(true);
    const r = await requestPersist();
    setStatus(await storageStatus());
    setAsking(false);
    onMessage(
      r === true
        ? "データ保護が有効になりました"
        : r === false
          ? "今は保護されませんでした。アプリとしてインストールすると許可されやすくなります"
          : "この環境では保護を要求できません",
      4000
    );
  }

  // 確かめられない環境では、前回要求したときの結果を出す
  const persisted = status === null ? null : (status.persisted ?? persistResult);
  const label = status === null ? "確認中…" : persisted === true ? "有効" : persisted === false ? "未保護" : "不明";
  const tone =
    persisted === true
      ? "bg-emerald-100 text-emerald-700"
      : persisted === false
        ? "bg-amber-100 text-amber-700"
        : "bg-slate-200 text-slate-600";

  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-slate-600">データ保護</span>
        <span className={`chip ${tone}`}>{label}</span>
      </div>
      {status?.usage != null && (
        <div className="mt-1">
          使用量 {formatBytes(status.usage)}
          {status.quota ? `（上限の目安 ${formatBytes(status.quota)}）` : ""}
        </div>
      )}
      {persisted === false && (
        <>
          <p className="mt-1">
            端末の空き容量が少なくなると、ブラウザが学習データを消すことがあります。アプリとしてインストールすると保護されやすくなります。バックアップも定期的に保存してください。
          </p>
          <button type="button" onClick={() => void ask()} disabled={asking} className="btn-ghost mt-2 min-h-11 w-full text-sm">
            {asking ? "要求中…" : "保護を要求する"}
          </button>
        </>
      )}
    </div>
  );
}

/** 前回のバックアップ（「2026-09-20（4日前）」） */
function LastBackup() {
  const lastBackupAt = useMeta((m) => m.lastBackupAt);
  const at = lastBackupAt ? new Date(lastBackupAt) : null;
  if (!at || Number.isNaN(at.getTime())) {
    return <p className="px-1 text-xs text-amber-700">まだバックアップを保存していません。</p>;
  }
  const day = todayStr(at);
  const ago = diffDays(todayStr(), day);
  return (
    <p className="px-1 text-xs text-slate-500">
      前回のバックアップ: {day}（{ago <= 0 ? "今日" : `${ago}日前`}）
    </p>
  );
}

/** Android で pt-BR の音声データを入れる手順（pt-BR が無いときは開いておく） */
function VoiceHelp({ open }: { open: boolean }) {
  return (
    <details open={open} className="mt-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
      <summary className="cursor-pointer py-2 font-medium text-slate-600">Android で pt-BR の音声を入れるには</summary>
      <ol className="mt-1 list-decimal space-y-1 pl-5">
        <li>端末の「設定」で「テキスト読み上げ」を検索して開きます（多くの機種: システム → 言語と入力 → テキスト読み上げの出力）。</li>
        <li>「優先するエンジン」を「Google 音声サービス」にします。無ければ Play ストアで「Google 音声サービス」を入れます。</li>
        <li>エンジンの ⚙ →「音声データをインストール」→「ポルトガル語（ブラジル）」をダウンロードします（Wi-Fi 推奨）。</li>
        <li>Chrome（このアプリ）をいったん閉じて開き直し、ここに pt-BR の音声が出るか確かめます。</li>
      </ol>
      <p className="mt-2 text-slate-400">PC（Windows）の場合: 設定 → 時刻と言語 → 音声 → 音声の追加 → ポルトガル語（ブラジル）。</p>
    </details>
  );
}

export default function Settings() {
  const s = useSettings();

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout>>();
  const fileRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [paste, setPaste] = useState("");

  // 音声一覧は後から届く・増える（Android は遅い。音声データを入れて戻ってきたときも読み直す）
  const [voicesLoaded, setVoicesLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      if (!alive) return;
      setVoices(audio.getVoices());
      setVoicesLoaded(true);
    };
    void audio.ready().then(refresh);
    const off = audio.onVoicesChanged?.(refresh);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      off?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // 今の設定で実際に使われる音声（voices が変わるたびに引き直す）
  const current = useMemo(
    () => audio.currentVoice?.("pt-BR", s.voiceURI) ?? null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [voices, s.voiceURI]
  );

  function flash(m: string, ms = 2500) {
    setMsg(m);
    clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(null), ms);
  }
  useEffect(() => () => clearTimeout(msgTimer.current), []);

  /** スマホは共有シート（.txt）、PC や共有できない環境では .json のダウンロード */
  async function doExport() {
    setSaving(true);
    try {
      const r = await saveBackupFile();
      if (r === "shared") flash("バックアップを共有しました");
      else if (r === "downloaded") flash("バックアップをダウンロードしました");
    } catch {
      flash("バックアップを保存できませんでした", 4000);
    } finally {
      setSaving(false);
    }
  }

  /** バックアップのテキストを読み、確認のうえ今のデータを置き換える。置き換えたら true */
  function importText(text: string): boolean {
    const r = parseBackup(text);
    if (!r.ok) {
      flash(r.error, 4000);
      return false;
    }
    const lines = [
      "このバックアップで今の進捗を置き換えます。よろしいですか？",
      "",
      describeBackup(r.data),
      ...r.warnings.map((w) => `⚠ ${w}`),
    ];
    if (!confirm(lines.join("\n"))) return false;
    if (!applyBackup(r.data)) {
      flash("学習データを取り込めませんでした", 4000);
      return false;
    }
    flash(r.warnings.length ? `復元しました。${r.warnings.join(" ")}` : "進捗を復元しました", r.warnings.length ? 6000 : 2500);
    return true;
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => importText(String(reader.result));
    reader.onerror = () => flash("ファイルを読めませんでした", 4000);
    reader.readAsText(file);
    input.value = ""; // 同じファイルをもう一度選んでも読み込めるように
  }

  return (
    <div className="animate-fade-in space-y-5">
      <h1 className="text-xl font-bold text-brand-ink">設定</h1>

      <UpdateBanner />

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
        <Row label="今日の学習の表示" hint="1枚ずつ: 思い出してから答えを見る（おすすめ）">
          <select
            value={s.studyView}
            onChange={(e) => s.set({ studyView: e.target.value as StudyViewMode })}
            className="rounded-lg border border-slate-200 px-2 py-1.5"
          >
            <option value="session">1枚ずつ</option>
            <option value="list">一覧</option>
          </select>
        </Row>
        <Row label="出題の向き" hint="1枚ずつ学習の表に出す言語">
          <select
            value={s.studyDirection}
            onChange={(e) => s.set({ studyDirection: e.target.value as StudyDirection })}
            className="rounded-lg border border-slate-200 px-2 py-1.5"
          >
            <option value="pt2ja">葡 → 和</option>
            <option value="ja2pt">和 → 葡</option>
            <option value="mixed">ミックス</option>
          </select>
        </Row>
        <Row label="答えを見たら発音を再生" hint="1枚ずつ学習の裏面・新しい語の紹介で自動再生">
          <input
            type="checkbox"
            checked={s.autoPlayOnReveal}
            onChange={(e) => s.set({ autoPlayOnReveal: e.target.checked })}
            className="h-5 w-5 accent-brand-green"
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
        <Row
          label="音声(ボイス)"
          hint={!voicesLoaded ? "音声を確認中…" : voices.length ? `${voices.length}件のpt系音声` : "pt系の音声が見つかりません"}
        >
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
        {/* 使用中の音声を返せない Provider では出さない */}
        {voicesLoaded && audio.currentVoice && <VoiceStatus supported={audio.isSupported()} current={current} />}
        <button
          onClick={() => audio.speak("Olá! Tudo bem? Eu estou aprendendo português.", { rate: s.rate, voiceURI: s.voiceURI })}
          className="btn-ghost w-full"
        >
          🔊 テスト再生
        </button>
        <VoiceHelp open={voicesLoaded && !!audio.currentVoice && audio.isSupported() && (!current || !isBrVoice(current))} />
      </section>

      {/* データ */}
      <section className="card space-y-2 p-3">
        <h2 className="px-1 text-sm font-bold text-slate-500">データとバックアップ</h2>
        <DataProtection onMessage={flash} />
        <p className="px-1 text-xs text-slate-400">
          進捗・曲の和訳・曲から追加した単語・設定を保存します（歌詞そのものと音声の選択は含みません）。スマホでは共有メニューから
          Google ドライブやメールに保存できます（ファイルは .txt ですが、そのままインポートできます）。PC ではファイル（.json）をダウンロードします。
        </p>
        <LastBackup />
        <div className="flex gap-2">
          <button type="button" onClick={() => void doExport()} disabled={saving} className="btn-ghost min-h-11 flex-1">
            {saving ? "準備中…" : "⬇ バックアップを保存"}
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} className="btn-ghost min-h-11 flex-1">
            ⬆ インポート
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,.txt,application/json,text/plain"
            onChange={onFile}
            className="hidden"
          />
        </div>
        <details className="rounded-lg bg-slate-50 px-3 py-1 text-xs text-slate-500">
          <summary className="cursor-pointer py-2 font-medium text-slate-600">テキストを貼り付けて復元</summary>
          <textarea
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            rows={4}
            placeholder="バックアップの中身（{ で始まるテキスト）をここに貼り付けます"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 font-mono text-xs text-brand-ink"
          />
          <button
            type="button"
            onClick={() => {
              if (importText(paste)) setPaste("");
            }}
            disabled={!paste.trim()}
            className="btn-ghost mb-2 mt-1 min-h-11 w-full text-sm"
          >
            貼り付けた内容で復元
          </button>
        </details>
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

      <AppInfo onMessage={flash} />
    </div>
  );
}
