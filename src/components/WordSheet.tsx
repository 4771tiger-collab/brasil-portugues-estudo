// ============================================================================
// 歌詞の単語をタップした時のボトムシート
// 原形・活用の説明・意味・品詞・カナ/IPA・読み上げ・「単語帳に追加」。
// 同綴りで複数の読みがある場合は「他の可能性」、縮約は各要素ごとに追加できる。
// 辞書に無い語は機械翻訳の候補を出し、意味を直して自分の単語として追加できる。
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { resolveWord } from "../data/loadWords";
import type { SrsLevel, Word } from "../data/types";
import { getLemmatizer } from "../data/music";
import { isCovered, type Candidate, type LexRef, type Token } from "../services/lemmatize";
import { translateText } from "../services/translate";
import { displayLevel } from "../srs/scheduler";
import { useMusic, userWordId, useUserWordMap } from "../store/useMusic";
import { useProgress } from "../store/useProgress";
import { useSettings } from "../store/useSettings";
import SpeakerButton from "./SpeakerButton";

/** 表示は displayLevel（現在の間隔から導く）で引く。保存済みの card.level は使わない */
const LEVEL_JA: Record<SrsLevel, string> = { new: "未学習", learning: "学習中", young: "定着中", mature: "習得" };
const POS_OPTIONS = ["名詞", "動詞", "形容詞", "副詞", "代名詞", "前置詞", "接続詞", "間投詞", "フレーズ", "固有名詞"];

interface Props {
  tokens: Token[];
  index: number;
  videoId: string;
  onClose: () => void;
  onMove?: (index: number) => void;
}

/** 同じ意味の見出しをまとめる（casa 家 ×2 → 1つ） */
function groupRefs(refs: LexRef[]): LexRef[][] {
  const m = new Map<string, LexRef[]>();
  for (const r of refs) {
    const k = r.ja.replace(/\s+/g, "") + "|" + r.pos;
    const l = m.get(k);
    if (l) l.push(r);
    else m.set(k, [r]);
  }
  return [...m.values()];
}

function AddButton({ ids, surface, videoId }: { ids: string[]; surface: string; videoId: string }) {
  const cards = useProgress((s) => s.cards);
  const addedWords = useMusic((s) => s.addedWords);
  const addWord = useMusic((s) => s.addWord);
  const removeWord = useMusic((s) => s.removeWord);
  // この曲で追加済みか（別の曲で追加した語は、この曲のデッキにも入れられるよう追加ボタンを出す）
  const addedId = ids.find((id) => addedWords.some((w) => w.id === id && w.videoId === videoId));
  const addedElsewhere = !addedId && ids.some((id) => addedWords.some((w) => w.id === id));
  // 既に学習中の同義ID（単語帳とカポエイラ単語帳の同じ語など）があればそちらに追加する
  const cardId = ids.find((id) => cards[id]);
  const card = cardId ? cards[cardId] : undefined;

  if (addedId) {
    return (
      <div className="flex items-center gap-2">
        <span className="chip bg-emerald-50 text-emerald-600">
          ✓ 追加済み{card ? `（${LEVEL_JA[displayLevel(card)]}）` : ""}
        </span>
        {/* この曲の記録だけを外す（別の曲で追加した記録と学習履歴は残す） */}
        <button onClick={() => removeWord(addedId, videoId)} className="text-[11px] text-slate-400 underline">
          この曲から外す
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={() => addWord(cardId ?? ids[0], videoId, surface)} className="btn-primary px-3 py-1.5 text-sm">
        ＋ 単語帳に追加
      </button>
      {addedElsewhere ? (
        <span className="text-[11px] text-slate-400">別の曲で追加済み</span>
      ) : (
        card && <span className="text-[11px] text-slate-400">単語帳で{LEVEL_JA[displayLevel(card)]}</span>
      )}
    </div>
  );
}

function WordLine({ word, showKana, showIpa }: { word: Word | undefined; showKana: boolean; showIpa: boolean }) {
  if (!word) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-400">
      {showKana && word.kana && <span>{word.kana}</span>}
      {showIpa && word.ipa && <span className="font-mono">/{word.ipa}/</span>}
    </div>
  );
}

function CandidateBlock({
  c,
  surface,
  videoId,
  primary,
}: {
  c: Candidate;
  surface: string;
  videoId: string;
  primary: boolean;
}) {
  const userMap = useUserWordMap();
  const showKana = useSettings((s) => s.showKana);
  const showIpa = useSettings((s) => s.showIpa);
  const groups = groupRefs(c.refs);
  const head = c.refs[0] ? resolveWord(c.refs[0].id, userMap) : undefined;

  return (
    <div className={primary ? "space-y-2" : "space-y-1 rounded-lg bg-slate-50 p-2"}>
      <div className="flex items-center gap-2">
        <span className={`font-bold text-brand-ink ${primary ? "text-lg" : "text-sm"}`}>{c.lemma}</span>
        {head && <SpeakerButton text={head.ptForSpeech} size={primary ? 18 : 15} />}
      </div>
      {primary && <WordLine word={head} showKana={showKana} showIpa={showIpa} />}
      {c.note && <div className="text-xs text-brand-blue">{c.note}</div>}
      {groups.map((g) => (
        <div key={g[0].id} className="space-y-1">
          <div className="flex items-start gap-2">
            <span className="chip shrink-0 bg-slate-100 text-slate-500">{g[0].pos}</span>
            <span className={`${primary ? "text-base" : "text-sm"} text-slate-700`}>{g[0].ja}</span>
          </div>
          {g[0].source === "capoeira" && <div className="text-[11px] text-slate-400">※カポエイラ単語帳の意味</div>}
          <AddButton ids={g.map((r) => r.id)} surface={surface} videoId={videoId} />
        </div>
      ))}
      {c.parts && (
        <div className="space-y-1.5">
          {c.parts.map((p, i) => (
            <div key={i} className="rounded-lg bg-slate-50 p-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-bold text-brand-ink">{p.surface}</span>
                {p.top?.refs[0] && <span className="text-slate-600">{p.top.refs[0].ja}</span>}
              </div>
              {p.top?.note && <div className="text-[11px] text-brand-blue">{p.top.note}</div>}
              {p.top?.refs[0] && (
                <div className="mt-1">
                  <AddButton ids={p.top.refs.map((r) => r.id)} surface={p.surface} videoId={videoId} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 辞書に無い語: 機械翻訳の候補 → 意味を直して自分の単語として追加 */
function UnknownWord({ surface, videoId }: { surface: string; videoId: string }) {
  const key = surface.normalize("NFC").toLowerCase().replace(/^['’]+/, "");
  const userWords = useMusic((s) => s.userWords);
  const addUserWord = useMusic((s) => s.addUserWord);
  const addWord = useMusic((s) => s.addWord);
  const uid = userWordId(key);
  const existing = userWords.find((u) => u.id === uid);
  const [ja, setJa] = useState(existing?.ja ?? "");
  const [pos, setPos] = useState(existing?.pos ?? "名詞");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function suggest() {
    setBusy(true);
    setErr(null);
    try {
      setJa(await translateText(key));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "翻訳に失敗しました");
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!ja.trim()) return;
    const id = addUserWord(key, ja, pos);
    addWord(id, videoId, surface);
  }

  return (
    <div className="space-y-2">
      <div className="text-sm text-slate-500">辞書にない語です。意味を調べて自分の単語として追加できます。</div>
      {existing && (
        <div className="space-y-1.5 rounded-lg bg-emerald-50 p-2">
          <div className="text-sm text-emerald-700">
            登録済み: {existing.ja}（{existing.pos}）
          </div>
          <AddButton ids={[uid]} surface={surface} videoId={videoId} />
        </div>
      )}
      <button onClick={suggest} disabled={busy} className="btn-ghost w-full py-2 text-sm">
        {busy ? "翻訳中…" : "🌐 機械翻訳で意味の候補を出す"}
      </button>
      {err && <div className="text-xs text-rose-500">{err}</div>}
      <div className="flex gap-2">
        <input
          value={ja}
          onChange={(e) => setJa(e.target.value)}
          placeholder="意味（日本語）"
          className="min-w-0 flex-1 rounded-lg border border-slate-200 p-2 text-sm"
        />
        <select value={pos} onChange={(e) => setPos(e.target.value)} className="rounded-lg border border-slate-200 px-1 text-sm">
          {POS_OPTIONS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>
      <button onClick={save} disabled={!ja.trim()} className="btn-primary w-full py-2 text-sm">
        {existing ? "意味を更新して単語帳に追加" : "＋ この意味で単語帳に追加"}
      </button>
    </div>
  );
}

export default function WordSheet({ tokens, index, videoId, onClose, onMove }: Props) {
  const tok = tokens[index];
  const lem = getLemmatizer();
  const [showOthers, setShowOthers] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input,textarea,select,[contenteditable='true']")) {
        // 入力欄では Esc は入力欄から抜けるだけ（入力内容を失わない）
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && onMove && index > 0) onMove(index - 1);
      if (e.key === "ArrowRight" && onMove && index < tokens.length - 1) onMove(index + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onMove, index, tokens.length]);

  useEffect(() => setShowOthers(false), [index]);

  const res = useMemo(() => (lem && tok ? lem.lookup(tok.text, { lineStart: index === 0 }) : null), [lem, tok, index]);
  const cands = res?.candidates ?? [];
  const primary = cands[0];
  const others = cands.slice(1, 4);
  const covered = cands.some(isCovered);

  if (!tok) return null;

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} aria-hidden />
      {/* 高さはアドレスバーの出入りに追従する dvh（非対応の端末は vh）。
          vh と dvh の2クラスを並べるだけだと CSS の出力順で vh が勝つため、supports で上書きする */}
      <div
        role="dialog"
        aria-label={`単語: ${tok.text}`}
        className="fixed inset-x-0 bottom-0 z-30 mx-auto max-h-[55vh] supports-[height:100dvh]:max-h-[55dvh] max-w-2xl animate-fade-in overflow-y-auto rounded-t-2xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl"
      >
        <div className="mb-3 flex items-center gap-2">
          <button
            onClick={() => onMove?.(index - 1)}
            disabled={!onMove || index === 0}
            className="rounded-full px-2 py-1 text-lg text-slate-400 disabled:opacity-20"
            aria-label="前の単語"
          >
            ‹
          </button>
          <div className="min-w-0 flex-1 text-center">
            <span className="text-xl font-extrabold text-brand-ink">{tok.text}</span>
            <SpeakerButton text={tok.key} size={16} className="ml-1 align-middle" />
          </div>
          <button
            onClick={() => onMove?.(index + 1)}
            disabled={!onMove || index >= tokens.length - 1}
            className="rounded-full px-2 py-1 text-lg text-slate-400 disabled:opacity-20"
            aria-label="次の単語"
          >
            ›
          </button>
          <button onClick={onClose} className="rounded-full px-2 py-1 text-slate-400" aria-label="閉じる">
            ✕
          </button>
        </div>

        {!lem ? (
          <div className="py-6 text-center text-sm text-slate-400">辞書を準備中…</div>
        ) : (
          <div className="space-y-3">
            {tok.phrase && (
              <div className="rounded-xl bg-blue-50 p-3">
                <div className="text-[11px] font-bold text-blue-500">成句</div>
                <div className="font-bold text-brand-ink">{tok.phrase.key}</div>
                <div className="text-sm text-slate-700">{tok.phrase.refs[0]?.ja}</div>
                <div className="mt-1">
                  <AddButton ids={tok.phrase.refs.map((r) => r.id)} surface={tok.phrase.key} videoId={videoId} />
                </div>
              </div>
            )}

            {primary && <CandidateBlock c={primary} surface={tok.text} videoId={videoId} primary />}

            {others.length > 0 && (
              <div>
                <button onClick={() => setShowOthers((v) => !v)} className="text-xs font-medium text-brand-blue">
                  {showOthers ? "他の可能性を隠す" : `他の可能性（${others.length}）`}
                </button>
                {showOthers && (
                  <div className="mt-2 space-y-2">
                    {others.map((c, i) => (
                      <CandidateBlock key={i} c={c} surface={tok.text} videoId={videoId} primary={false} />
                    ))}
                  </div>
                )}
              </div>
            )}

            {!covered && <UnknownWord key={`${index}:${tok.key}`} surface={tok.text} videoId={videoId} />}
          </div>
        )}
      </div>
    </>
  );
}
