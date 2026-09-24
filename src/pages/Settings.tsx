import { useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "../store/useSettings";
import { applyBackup, describeBackup, parseBackup, resetAllProgress, saveBackupFile, type ImportMode } from "../store/backup";
import { useMeta } from "../store/useMeta";
import { formatBytes, requestPersist, storageStatus, type StorageStatus } from "../services/platform";
import { diffDays, todayStr } from "../srs/scheduler";
import { audio, type VoiceInfo } from "../services/audio";
import { speechErrorMessage, speechInput } from "../services/speechInput";
import { useSpeechInput } from "../hooks/useSpeechInput";
import type { HandsfreeDirection, ProductionAnswerMode, StudyDirection, StudyViewMode } from "../data/types";
import { HANDSFREE_GAPS_SEC } from "../services/handsfree";
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

/** 1日の復習の上限の選択肢（枚） */
const REVIEW_LIMITS = [50, 100, 150, 200, 300];
/** カポエイラ語の割合の選択肢 */
const CAPOEIRA_SHARES = [0, 0.25, 0.33, 0.5];
/** 産出カード（和→葡）を新しく始める1日の上限の選択肢（backupFormat の SETTINGS_SCHEMA と同じ） */
const PROD_NEW_LIMITS = [0, 3, 5, 10];

/** 選択肢に今の値が無ければ足す（バックアップや将来版で入った値も select に出す） */
function withCurrent(options: number[], current: number): number[] {
  return options.includes(current) ? options : [...options, current].sort((a, b) => a - b);
}

function shareLabel(v: number): string {
  if (v <= 0) return "混ぜない";
  if (v === 0.25) return "4語に1語";
  if (v === 0.33) return "3語に1語";
  if (v === 0.5) return "2語に1語";
  return `${Math.round(v * 100)}%`;
}

/** インポートの方法（統合が既定。置き換えはこの端末だけの記録が消える） */
const IMPORT_MODES: { v: ImportMode; label: string; hint: string }[] = [
  {
    v: "merge",
    label: "統合（推奨）",
    hint: "この端末の記録とバックアップの記録を合わせます。同じ語は新しく学習した方を残し、設定はこの端末のままです。PC とスマホの記録をまとめるときにも使えます。",
  },
  {
    v: "replace",
    label: "置き換え",
    hint: "この端末の進捗・曲のデータ・設定を、バックアップの内容で置き換えます。この端末だけにある記録は消えます。",
  },
];

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

/** 音声認識をオンにするときの確認（設定画面の説明の要点） */
const SPEECH_CONSENT = [
  "音声認識をオンにします。",
  "",
  "・🎤 を押して話した音声は、Chrome が Google の音声認識サービスに送って文字にします。",
  "・このアプリは音声も認識結果（文字）も保存しません。",
  "・ネットにつながっているときだけ使えます。",
  "",
  "よろしいですか？",
].join("\n");

/** 音声認識のテスト: 話した言葉をそのまま文字で見せる（候補が複数あれば全部） */
function SpeechTest() {
  const sp = useSpeechInput();
  const listening = sp.status === "listening";
  return (
    <div className="space-y-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
      <button
        type="button"
        onClick={() => (listening ? sp.stop() : void sp.start())}
        aria-pressed={listening}
        className={`btn min-h-11 w-full text-sm ring-1 ${
          listening ? "animate-pulse bg-brand-blue text-white ring-brand-blue" : "bg-white text-brand-blue ring-brand-blue/30"
        }`}
      >
        {listening ? "■ 聞き取り中…（押すと終える）" : "🎤 テスト（ポルトガル語で話して、文字を確かめる）"}
      </button>
      {listening && <p className="text-center text-sm italic text-slate-500">{sp.interim || "どうぞ、話してください…"}</p>}
      {sp.status === "done" && sp.result && (
        <div aria-live="polite">
          <div className="text-[11px] text-slate-400">聞き取った文字{sp.result.transcripts.length > 1 ? "（候補）" : ""}</div>
          <ol className="list-decimal pl-5 text-sm text-brand-ink">
            {sp.result.transcripts.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        </div>
      )}
      {sp.status === "error" && sp.error && (
        <p role="alert" className="rounded-lg bg-rose-50 p-2 leading-relaxed text-rose-600">
          {speechErrorMessage(sp.error)}
        </p>
      )}
      <p className="text-[11px] text-slate-400">テストの結果もこの画面に出すだけで、保存しません。</p>
    </div>
  );
}

/**
 * 🎤 音声認識（言ってみる）の設定（T2-8。既定オフ）。
 * 説明（音声は Google に送られる・保存しない・オンラインのみ）を読んでからオンにする（オンにするときも確認する）。
 * 非対応のブラウザでは使えないことを示し、切り替えは押せない。テストはオンのときだけ出す
 */
function SpeechInputSettings() {
  const enabled = useSettings((st) => st.speechInputEnabled);
  const set = useSettings((st) => st.set);
  const supported = speechInput.isSupported();

  function toggle(on: boolean) {
    if (on) {
      if (!confirm(SPEECH_CONSENT)) return;
      set({ speechInputEnabled: true });
    } else {
      // 聞き取り中なら取りやめる（マイクを閉じる）
      speechInput.cancel();
      set({ speechInputEnabled: false });
    }
  }

  return (
    <section className="card space-y-2 p-3">
      <h2 className="px-1 text-sm font-bold text-slate-500">🎤 音声認識（言ってみる）</h2>
      <div className="space-y-1.5 px-1 text-xs leading-relaxed text-slate-500">
        <p>
          ポルトガル語を声に出して言うと、文字にして正しく言えたかを判定します。オンにすると、✍
          産出カード（和→葡）・シャドーイング（1文ずつ）・パターンプラクティス（発話ドリル）に「🎤 言ってみる」が出ます。
        </p>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            <span className="font-bold text-slate-600">話した音声は、Chrome が Google の音声認識サービスに送って文字にします。</span>
            音声が端末の外に出るのは、🎤 を押して聞き取っている間だけです。
          </li>
          <li>このアプリは音声も認識結果（文字）も保存しません（採点に使ったら捨てます。バックアップにも入りません）。</li>
          <li>ネットにつながっているときだけ使えます（オフラインでは使えません）。</li>
          <li>最初に使うとき、マイクの許可を求められます。</li>
        </ul>
      </div>
      {!supported && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          このブラウザは音声認識に対応していないため、使えません（Android の Chrome で使えます）。
        </p>
      )}
      <Row label="音声認識を使う" hint={supported ? "上の説明に同意してオンにする（既定はオフ）" : "このブラウザでは使えません"}>
        <label className={`-m-3 flex min-h-11 min-w-11 items-center justify-center p-3 ${supported ? "cursor-pointer" : ""}`}>
          <input
            type="checkbox"
            checked={enabled && supported}
            disabled={!supported}
            onChange={(e) => toggle(e.target.checked)}
            className="h-5 w-5 accent-brand-green disabled:opacity-40"
            aria-label="音声認識（言ってみる）を使う"
          />
        </label>
      </Row>
      {enabled && supported && <SpeechTest />}
    </section>
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
  // インポートの方法。開くたびに安全な「統合」に戻す（置き換えは消える記録があるため）
  const [importMode, setImportMode] = useState<ImportMode>("merge");

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

  /** バックアップのテキストを読み、確認のうえ選んだ方法（統合／置き換え）で取り込む。取り込んだら true */
  function importText(text: string): boolean {
    const r = parseBackup(text);
    if (!r.ok) {
      flash(r.error, 4000);
      return false;
    }
    const merge = importMode === "merge";
    const hasSettings = !!r.data.settings && Object.keys(r.data.settings).length > 0;
    const lines = [
      merge
        ? "このバックアップを今の進捗に統合します。よろしいですか？"
        : "このバックアップで今の進捗を置き換えます。よろしいですか？",
      merge
        ? "（両方の記録を残し、同じ語は新しく学習した方を採用します。設定はこの端末のままです）"
        : `（この端末だけにある記録は消えます${hasSettings ? "。設定もバックアップの内容になります" : ""}）`,
      "",
      describeBackup(r.data),
      ...r.warnings.map((w) => `⚠ ${w}`),
    ];
    if (!confirm(lines.join("\n"))) return false;
    const diff = applyBackup(r.data, importMode);
    if (!diff) {
      flash("学習データを取り込めませんでした", 4000);
      return false;
    }
    const done = merge ? `統合しました（新しく入った語 ${diff.added}・学習状況が変わった語 ${diff.updated}）` : "進捗を復元しました";
    flash(r.warnings.length ? `${done}。${r.warnings.join(" ")}` : done, r.warnings.length ? 6000 : merge ? 4000 : 2500);
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
        <Row label="1日の復習の上限" hint="超える日は延滞の大きい語から出し、新しい語はお休み">
          <select
            value={s.dailyReviewLimit}
            onChange={(e) => s.set({ dailyReviewLimit: Number(e.target.value) })}
            className="rounded-lg border border-slate-200 px-2 py-1.5"
          >
            {withCurrent(REVIEW_LIMITS, s.dailyReviewLimit).map((n) => (
              <option key={n} value={n}>
                {n}枚
              </option>
            ))}
          </select>
        </Row>
        <Row label="カポエイラ語の割合" hint="今日の学習の新しい語に混ぜるカポエイラ用語">
          <select
            value={s.capoeiraShare}
            onChange={(e) => s.set({ capoeiraShare: Number(e.target.value) })}
            className="rounded-lg border border-slate-200 px-2 py-1.5"
          >
            {withCurrent(CAPOEIRA_SHARES, s.capoeiraShare).map((v) => (
              <option key={v} value={v}>
                {shareLabel(v)}
              </option>
            ))}
          </select>
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
        {/* 和→葡の産出カード（T2-1）。理解カードとは別の SRS */}
        <Row label="✍ 和→葡の産出カード" hint="定着中（復習間隔7日以上）の語を、日本語から言う練習カードとして今日の学習に出す。オフにすると一時停止（記録は残る）">
          <label className="-m-3 flex min-h-11 min-w-11 cursor-pointer items-center justify-center p-3">
            <input
              type="checkbox"
              checked={s.productionEnabled}
              onChange={(e) => s.set({ productionEnabled: e.target.checked })}
              className="h-5 w-5 accent-brand-green"
              aria-label="和→葡の産出カードを出す"
            />
          </label>
        </Row>
        <Row label="✍ 産出カードの新規（1日）" hint="1日に新しく始める産出カードの数（新しい語の枠とは別）">
          <select
            value={s.dailyProductionNewLimit}
            onChange={(e) => s.set({ dailyProductionNewLimit: Number(e.target.value) })}
            disabled={!s.productionEnabled}
            className="min-h-11 rounded-lg border border-slate-200 px-2 py-1.5 disabled:opacity-40"
          >
            {withCurrent(PROD_NEW_LIMITS, s.dailyProductionNewLimit).map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "始めない" : `${n}語`}
              </option>
            ))}
          </select>
        </Row>
        <Row label="✍ 産出カードの答え方" hint="どちらでも、カードの上で「入力して答える」に切り替えられます">
          <select
            value={s.productionAnswerMode}
            onChange={(e) => s.set({ productionAnswerMode: e.target.value as ProductionAnswerMode })}
            disabled={!s.productionEnabled}
            className="min-h-11 rounded-lg border border-slate-200 px-2 py-1.5 disabled:opacity-40"
          >
            <option value="self">言ってから答えを見る</option>
            <option value="type">入力して答え合わせ</option>
          </select>
        </Row>
        <Row label="🎧 耳だけ復習の向き" hint="単語帳の「耳だけ」で読み上げる順">
          <select
            value={s.handsfreeDirection}
            onChange={(e) => s.set({ handsfreeDirection: e.target.value as HandsfreeDirection })}
            className="rounded-lg border border-slate-200 px-2 py-1.5"
          >
            <option value="pt2ja">葡 → 和</option>
            <option value="ja2pt">和 → 葡</option>
          </select>
        </Row>
        <Row label="🎧 耳だけ復習の考える間" hint="問いを読んでから答えを読むまでの時間">
          <select
            value={s.handsfreeGapSec}
            onChange={(e) => s.set({ handsfreeGapSec: Number(e.target.value) })}
            className="rounded-lg border border-slate-200 px-2 py-1.5"
          >
            {withCurrent([...HANDSFREE_GAPS_SEC], s.handsfreeGapSec).map((n) => (
              <option key={n} value={n}>
                {n}秒
              </option>
            ))}
          </select>
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
        <Row
          label="調べた後は行の頭から再開"
          hint={
            s.pauseOnWordTap
              ? "単語シートを閉じたら、調べた行を頭から聴き直す（時間同期のある歌詞）"
              : "「単語タップで一時停止」がオンのときに使えます"
          }
        >
          <input
            type="checkbox"
            checked={s.replayAfterLookup}
            disabled={!s.pauseOnWordTap}
            onChange={(e) => s.set({ replayAfterLookup: e.target.checked })}
            className="h-5 w-5 accent-brand-green disabled:opacity-40"
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

      {/* 音声認識（T2-8。オプトイン） */}
      <SpeechInputSettings />

      {/* データ */}
      <section className="card space-y-2 p-3">
        <h2 className="px-1 text-sm font-bold text-slate-500">データとバックアップ</h2>
        <DataProtection onMessage={flash} />
        <p className="px-1 text-xs text-slate-400">
          進捗（産出カード・日ごとの学習ログ・活用ドリルの成績を含む）・曲の和訳・曲から追加した単語・設定を保存します（歌詞そのもの・音声の選択・音声認識のオン／オフは含みません）。スマホでは共有メニューから
          Google ドライブやメールに保存できます（ファイルは .txt ですが、そのままインポートできます）。PC ではファイル（.json）をダウンロードします。
        </p>
        <LastBackup />
        {/* インポートの方法（ファイルと貼り付けの両方に効く） */}
        <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          <div className="mb-1.5 font-medium text-slate-600">インポートの方法</div>
          <div role="radiogroup" aria-label="インポートの方法" className="flex gap-0.5 rounded-lg bg-slate-200/70 p-0.5">
            {IMPORT_MODES.map((m) => (
              <button
                key={m.v}
                type="button"
                role="radio"
                aria-checked={importMode === m.v}
                onClick={() => setImportMode(m.v)}
                className={`min-h-11 flex-1 rounded-md px-2 text-sm ${
                  importMode === m.v ? "bg-white font-bold text-brand-ink shadow-sm" : "text-slate-500"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <p className={`mt-1.5 ${importMode === "replace" ? "text-amber-700" : ""}`}>
            {IMPORT_MODES.find((m) => m.v === importMode)?.hint}
          </p>
        </div>
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
            貼り付けた内容で{importMode === "merge" ? "統合" : "置き換え"}
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
