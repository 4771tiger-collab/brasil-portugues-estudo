import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Chunk, Passage } from "../data/types";
import { useProgress } from "../store/useProgress";
import { toKana } from "../services/pronunciation";
import SpeakerButton from "../components/SpeakerButton";

/** ポルトガル語テキストを句読点ヒューリスティックで意味のカタマリに分割 */
function chunkText(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[,.;:!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

function levelOf(chunks: Chunk[]): Passage["level"] {
  const words = chunks.reduce((a, c) => a + c.pt.split(/\s+/).length, 0);
  if (words <= 12) return "short";
  if (words <= 35) return "medium";
  return "long";
}

export default function AddMaterial() {
  const navigate = useNavigate();
  const customPassages = useProgress((s) => s.customPassages);
  const addCustomPassage = useProgress((s) => s.addCustomPassage);
  const removeCustomPassage = useProgress((s) => s.removeCustomPassage);

  const [title, setTitle] = useState("");
  const [raw, setRaw] = useState("");
  const [chunks, setChunks] = useState<Chunk[] | null>(null);

  function doSplit() {
    const parts = chunkText(raw);
    if (parts.length === 0) return;
    setChunks(parts.map((pt) => ({ pt, ja: "" })));
  }

  function updateChunk(i: number, patch: Partial<Chunk>) {
    setChunks((cs) => cs!.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function removeChunk(i: number) {
    setChunks((cs) => cs!.filter((_, idx) => idx !== i));
  }

  function save() {
    if (!chunks || chunks.length === 0) return;
    const passage: Passage = {
      id: "custom_" + Date.now(),
      title: title.trim() || "無題の教材",
      level: levelOf(chunks),
      source: "custom",
      chunks,
    };
    addCustomPassage(passage);
    setTitle("");
    setRaw("");
    setChunks(null);
    navigate("/practice/chunk");
  }

  return (
    <div className="animate-fade-in space-y-4">
      <Link to="/practice" className="text-sm text-brand-green">‹ 練習に戻る</Link>
      <div>
        <h1 className="text-xl font-bold text-brand-ink">教材を追加</h1>
        <p className="text-sm text-slate-500">ニュース記事などのポルトガル語を貼り付けて、自分だけのチャンク教材に。</p>
      </div>

      {!chunks ? (
        <div className="card space-y-3 p-4">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="タイトル（例: G1のニュース記事）"
            className="w-full rounded-xl border border-slate-200 p-3"
          />
          <textarea
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={6}
            placeholder="ここにポルトガル語のテキストを貼り付け…"
            className="w-full rounded-xl border border-slate-200 p-3"
          />
          <button onClick={doSplit} disabled={!raw.trim()} className="btn-primary w-full py-2.5">
            チャンクに分割する
          </button>
          <p className="text-xs text-slate-400">💡 句読点をもとに自動分割します。分割後に各チャンクの訳を追加できます。</p>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="card p-3">
            <div className="text-sm font-bold text-brand-ink">{title || "無題の教材"}</div>
            <div className="text-xs text-slate-400">{chunks.length} チャンク ・ 各チャンクの訳を入力（任意）</div>
          </div>

          {chunks.map((c, i) => (
            <div key={i} className="card space-y-2 p-3">
              <div className="flex items-start gap-2">
                <span className="pt-2 font-bold text-brand-green/50">/</span>
                <div className="flex-1 space-y-1">
                  <input
                    value={c.pt}
                    onChange={(e) => updateChunk(i, { pt: e.target.value })}
                    className="w-full rounded-lg border border-slate-200 p-2 font-medium text-brand-ink"
                  />
                  <div className="text-[11px] text-slate-400">{toKana(c.pt)}</div>
                  <input
                    value={c.ja}
                    onChange={(e) => updateChunk(i, { ja: e.target.value })}
                    placeholder="日本語訳（任意）"
                    className="w-full rounded-lg border border-slate-100 bg-slate-50 p-2 text-sm text-slate-600"
                  />
                </div>
                <div className="flex flex-col items-center gap-1">
                  <SpeakerButton text={c.pt} size={18} />
                  <button onClick={() => removeChunk(i)} className="text-xs text-rose-400">削除</button>
                </div>
              </div>
            </div>
          ))}

          <div className="flex gap-2">
            <button onClick={() => setChunks(null)} className="btn-ghost flex-1 py-2.5">やり直す</button>
            <button onClick={save} className="btn-primary flex-1 py-2.5">教材を保存</button>
          </div>
        </div>
      )}

      {/* 既存のカスタム教材 */}
      {customPassages.length > 0 && (
        <section className="space-y-2">
          <h2 className="px-1 text-sm font-bold text-slate-500">追加済みの教材</h2>
          {customPassages.map((p) => (
            <div key={p.id} className="card flex items-center gap-3 p-3">
              <span className="text-lg">📄</span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-brand-ink">{p.title}</div>
                <div className="text-xs text-slate-400">{p.chunks.length}チャンク</div>
              </div>
              <Link to="/practice/chunk" className="text-xs text-brand-green">開く</Link>
              <button onClick={() => removeCustomPassage(p.id)} className="text-xs text-rose-400">削除</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
