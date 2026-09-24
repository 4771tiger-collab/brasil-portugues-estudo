import { useState } from "react";
import { Link } from "react-router-dom";
import { useProgress } from "../store/useProgress";
import {
  BACKUP_NUDGE_DAYS,
  BACKUP_NUDGE_REVIEWS,
  backupNudgeReason,
  useMeta,
  type BackupNudgeReason,
} from "../store/useMeta";
import { saveBackupFile } from "../store/backup";

/** 「あとで」を押したら、アプリを開き直すまで出さない（永続化しない） */
let snoozedThisLaunch = false;

function reasonText(r: BackupNudgeReason): string {
  switch (r.kind) {
    case "never":
      return "まだ一度もバックアップしていません。機種変更や端末の不具合に備えて、ファイルに保存しておきましょう。";
    case "days":
      return `前回のバックアップから${r.days}日たちました。`;
    case "reviews":
      return `前回のバックアップから${r.reviews}回評価しました。`;
  }
}

/**
 * ホームのバックアップの催促。学習の記録があり、前回から7日以上、または200回以上評価していれば出す。
 * 「保存する」は設定画面と同じ（スマホは共有シート、PC や共有できない環境ではダウンロード）。
 */
export default function BackupNudge() {
  const totalReviews = useProgress((s) => s.totalReviews);
  const lastBackupAt = useMeta((s) => s.lastBackupAt);
  const reviewsAtLastBackup = useMeta((s) => s.reviewsAtLastBackup);
  const [hidden, setHidden] = useState(snoozedThisLaunch);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <p className="animate-fade-in rounded-xl bg-emerald-50 px-4 py-2 text-center text-xs text-emerald-700" role="status">
        ✓ バックアップを保存しました（次は{BACKUP_NUDGE_DAYS}日後か、{BACKUP_NUDGE_REVIEWS}回評価したらお知らせします）
      </p>
    );
  }
  const reason = backupNudgeReason({ lastBackupAt, reviewsAtLastBackup }, totalReviews);
  if (hidden || !reason) return null;

  async function save() {
    setBusy(true);
    try {
      const r = await saveBackupFile();
      if (r !== "cancelled") setDone(true);
    } catch {
      /* 失敗しても催促は出したまま（設定画面からも保存できる） */
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card animate-fade-in p-4 ring-brand-yellow/60" aria-label="バックアップのおすすめ">
      <div className="flex items-start gap-3">
        <span className="text-2xl" aria-hidden="true">
          💾
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-bold text-brand-ink">学習データをバックアップ</div>
          <p className="mt-0.5 text-xs text-slate-500">{reasonText(reason)}</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button type="button" onClick={() => void save()} disabled={busy} className="btn-primary min-h-11 flex-1">
          {busy ? "準備中…" : "保存する"}
        </button>
        <button
          type="button"
          onClick={() => {
            snoozedThisLaunch = true;
            setHidden(true);
          }}
          className="btn-ghost min-h-11"
        >
          あとで
        </button>
      </div>
      <Link to="/settings" className="-mb-2 flex min-h-11 items-center justify-center text-xs text-slate-400 underline-offset-2 hover:underline">
        復元・保存先について（設定）
      </Link>
    </section>
  );
}
