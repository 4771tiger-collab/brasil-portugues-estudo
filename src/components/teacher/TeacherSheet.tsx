// ============================================================================
// 🧑‍🏫 AI 先生のシート（どの画面からでも開くチャット。Layout に1つだけ置く）
// - スマホでは画面の高さいっぱいの下からのシート（PC では中央の max-w-2xl）。キーボードが出ても入力欄が
//   隠れないよう、高さは visualViewport に合わせる。開いている間は後ろの画面をスクロールさせない。
// - Android の戻る操作で閉じる: 開いたときに履歴を1つ積み（同じ URL・印付きの state）、戻る（popstate）で閉じる。
//   ボタンで閉じたときは、積んだ履歴を history.back() で外す（HashRouter の画面の履歴を壊さない）。
//   シートから別の画面へ移るとき（設定を開く）は、履歴を外し終えてから移る（closeThen）。
// - 見出し: 🧑‍🏫 先生・履歴・新しい会話・閉じる。その下に文脈のチップ（× で外せる）と、使うサービス・モデル。
// - 会話: 返事は少しずつ出す（入力中の点・停止ボタン）。失敗はその場に出して「再試行」。
//   文脈の種類ごとの「すぐ聞ける質問」のチップ（押すと送る。「〜」のあるものは入力欄に入れる）。
// - キーが無いとき: Gemini（無料枠）のキーの作り方と、設定を開くボタン。
// - Gemini のときは入力欄の下に、無料枠の内容が Google の改善に使われることを1行で出す。
// - 返事は React の文字として出す（HTML として差し込まない）。会話の履歴は端末だけ（store/useTeacher.ts）。
// ============================================================================

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { resolveWord, userWordMap } from "../../data/loadWords";
import { useAiProvider } from "../../hooks/useAiProvider";
import { useOnline } from "../../hooks/useOnline";
import { useScreenName } from "../../hooks/useScreenName";
import { aiModelLabel } from "../../services/ai";
import { clearTeacherHistory, deleteTeacherConversation, MAX_QUESTION_CHARS, retryTeacher, sendTeacherMessage } from "../../services/ai/teacherChat";
import { closeTeacher, generalContext, useTeacherUi, type TeacherContext } from "../../services/ai/teacherContext";
import { QUICK_QUESTIONS, learnerProfile, type QuickQuestion, type TeacherProfile } from "../../services/ai/teacherPrompt";
import { todayStr } from "../../srs/scheduler";
import { useMusic } from "../../store/useMusic";
import { useProgress } from "../../store/useProgress";
import { useTeacher, type TeacherConversation } from "../../store/useTeacher";
import TeacherMessage, { TeacherAnswer } from "./TeacherMessage";

/** 開いたときに積む履歴の state の印 */
const MARK = "bpTeacherSheet";
const isMarked = (st: unknown) => typeof st === "object" && st !== null && (st as Record<string, unknown>)[MARK] === true;

/** 今の履歴の state（react-router の key・idx）を写して、印を付けた履歴を積む（URL は変えない） */
function pushMark(): void {
  try {
    const st: unknown = window.history.state;
    window.history.pushState({ ...(typeof st === "object" && st !== null ? st : {}), [MARK]: true }, "");
  } catch {
    // 履歴を使えない環境では、戻る操作で閉じないだけ
  }
}

/** 今の学習者のようす（送るときに作る） */
function currentProfile(): TeacherProfile {
  const cards = useProgress.getState().cards;
  const userMap = userWordMap(useMusic.getState().userWords);
  return learnerProfile(cards, (id) => resolveWord(id, userMap), todayStr());
}

/** マウスのある端末（Enter で送る）。指で操作する端末では Enter は改行 */
function finePointer(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: fine)").matches;
}

/** 見えている範囲（キーボードを除く）に合わせた位置と高さ。visualViewport が無ければ null */
function useVisualViewport(active: boolean): { top: number; height: number } | null {
  const [box, setBox] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!active || !vv) {
      setBox(null);
      return;
    }
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setBox({ top: vv.offsetTop, height: vv.height }));
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [active]);
  return box;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 入力中の点（返事がまだ1文字も届いていないとき） */
function Typing() {
  return (
    <div className="flex gap-2" aria-live="polite">
      <span aria-hidden className="mt-1 shrink-0 text-xl">
        🧑‍🏫
      </span>
      <div className="flex items-center gap-1 rounded-2xl rounded-tl-md bg-slate-50 px-4 py-3 ring-1 ring-slate-100" aria-label="先生が考えています">
        {[0, 150, 300].map((ms) => (
          <span key={ms} className="h-2 w-2 animate-bounce rounded-full bg-slate-400" style={{ animationDelay: `${ms}ms` }} />
        ))}
      </div>
    </div>
  );
}

/** キーが無いとき: Gemini（無料枠）のキーの作り方と、設定を開くボタン */
function SetupCard({ onSettings }: { onSettings: () => void }) {
  return (
    <div className="space-y-2.5 rounded-2xl bg-violet-50 p-4 text-sm leading-relaxed text-slate-600 ring-1 ring-violet-100">
      <p className="font-bold text-violet-800">🧑‍🏫 AI先生を使うには、Gemini の APIキー（無料）が必要です</p>
      <p>Google AI Studio のアカウントがあれば、数分で用意できます。課金（請求先アカウント）を設定しなければ、無料枠のまま 0円で使えます。</p>
      <ol className="list-decimal space-y-1 pl-5">
        <li>
          <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-brand-blue underline">
            aistudio.google.com
          </a>{" "}
          を開いて、Google アカウントでログイン
        </li>
        <li>「Get API key」でキーを作り、コピー（AIza で始まる）</li>
        <li>このアプリの設定「🤖 AI」の Gemini の欄に貼り付けて「保存」</li>
      </ol>
      <p className="rounded-lg bg-amber-50 px-2 py-1 text-xs text-amber-800">
        ⚠ 無料枠では、送った内容と返事が Google の製品改善に使われ、人が読むこともあります。個人情報は書かないでください。
      </p>
      <button type="button" onClick={onSettings} className="btn-primary min-h-11 w-full">
        ⚙ 設定を開く
      </button>
    </div>
  );
}

/** 会話の履歴の一覧（開く・消す・すべて消す） */
function HistoryList({ conversations, activeId, onOpen }: { conversations: TeacherConversation[]; activeId: string | null; onOpen: (id: string) => void }) {
  return (
    <div className="space-y-2 p-3">
      <p className="px-1 text-xs leading-relaxed text-slate-500">
        会話の履歴 {conversations.length}件（この端末にだけ保存。バックアップには含めません。新しい順に 30件まで）
      </p>
      {conversations.length === 0 && <p className="card p-4 text-center text-sm text-slate-400">まだ会話はありません。</p>}
      <ul className="space-y-1.5">
        {conversations.map((c) => (
          <li key={c.id} className={`card flex items-center gap-1 p-1 ${c.id === activeId ? "ring-2 ring-brand-green/40" : ""}`}>
            <button type="button" onClick={() => onOpen(c.id)} className="min-h-11 min-w-0 flex-1 rounded-xl px-2 py-1.5 text-left">
              <div className="truncate text-sm font-medium text-brand-ink">{c.title || "（無題）"}</div>
              <div className="truncate text-[11px] text-slate-400">
                {c.contextLabel ? `${c.contextLabel} ・ ` : ""}
                {fmtWhen(c.updatedAt)} ・ {c.messages.length}件
              </div>
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm("この会話を削除します。よろしいですか？")) deleteTeacherConversation(c.id);
              }}
              aria-label={`会話「${c.title}」を削除`}
              className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-500"
            >
              🗑
            </button>
          </li>
        ))}
      </ul>
      {conversations.length > 0 && (
        <button
          type="button"
          onClick={() => {
            if (confirm("AI先生との会話の履歴をすべて消します。よろしいですか？（元に戻せません）")) clearTeacherHistory();
          }}
          className="btn min-h-11 w-full bg-rose-50 text-sm text-rose-600 ring-1 ring-rose-200"
        >
          会話の履歴をすべて消す
        </button>
      )}
    </div>
  );
}

export default function TeacherSheet() {
  const open = useTeacherUi((s) => s.open);
  const view = useTeacherUi((s) => s.view);
  const newContext = useTeacherUi((s) => s.context);
  const activeId = useTeacherUi((s) => s.activeId);
  const draft = useTeacherUi((s) => s.draft);
  const run = useTeacherUi((s) => s.run);
  const conversations = useTeacher((s) => s.conversations);
  const { provider } = useAiProvider();
  const online = useOnline();
  const screen = useScreenName();
  const navigate = useNavigate();
  const location = useLocation();
  const box = useVisualViewport(open);

  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 一番下を見ているか（返事が伸びたら一番下へ送る） */
  const atBottomRef = useRef(true);
  /** 閉じ終えてから（積んだ履歴を外してから）行うこと */
  const afterCloseRef = useRef<(() => void) | null>(null);
  /** 戻る操作で閉じている最中（画面の移動で履歴を積み直さない） */
  const poppingRef = useRef(false);

  const conv = activeId ? conversations.find((c) => c.id === activeId) ?? null : null;
  const ctx: TeacherContext | null = conv ? conv.context ?? null : newContext;
  const streaming = run?.status === "streaming";
  const runHere = run && conv && run.convId === conv.id ? run : null;
  const messages = conv?.messages ?? [];

  // 戻る操作で閉じる: 開いたら履歴を1つ積み、戻る（popstate）で閉じる。ボタンで閉じたら積んだ履歴を外す
  useEffect(() => {
    if (!open) return;
    poppingRef.current = false;
    if (!isMarked(window.history.state)) pushMark();
    const onPop = () => {
      if (isMarked(window.history.state)) return;
      poppingRef.current = true;
      closeTeacher();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      const after = afterCloseRef.current;
      afterCloseRef.current = null;
      if (isMarked(window.history.state)) {
        if (after) window.addEventListener("popstate", () => after(), { once: true });
        window.history.back();
      } else after?.();
    };
  }, [open]);

  // 開いている間に画面側が URL を置き換えた（曲の自動送りなど）→ 印が消えたので積み直す
  useEffect(() => {
    if (open && !poppingRef.current && !isMarked(window.history.state)) pushMark();
  }, [location, open]);

  // 後ろの画面をスクロールさせない。閉じたら、開く前にフォーカスしていた所へ戻す
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = "hidden";
    const prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      html.style.overflow = prevOverflow;
      prevFocus?.focus?.({ preventScroll: true });
    };
  }, [open]);

  const scrollToBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // 会話を開いた・画面を切り替えたら一番下へ
  useLayoutEffect(() => {
    if (!open || view !== "chat") return;
    atBottomRef.current = true;
    scrollToBottom();
  }, [open, view, activeId, scrollToBottom]);

  // 発言が増えた・返事が伸びた・キーボードが出てシートが縮んだら、一番下を見ていたときだけ送る
  // （縮んでも一覧の scrollTop は変わらず scroll も起きないので、最新の返事の最後が入力欄の下に隠れてしまう）
  const streamText = runHere?.status === "streaming" ? runHere.text : "";
  const boxHeight = box?.height;
  useLayoutEffect(() => {
    if (open && view === "chat" && atBottomRef.current) scrollToBottom();
  }, [open, view, messages.length, streamText, runHere?.status, boxHeight, scrollToBottom]);

  // 入力欄の高さを中身に合わせる（5行ほどまで）
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 144)}px`;
  }, [draft, open, view]);

  if (!open) return null;

  function closeThen(fn: () => void) {
    afterCloseRef.current = fn;
    closeTeacher();
  }

  function openSettings() {
    // 設定の画面から開いたときは履歴を積まない（置き換える。戻る操作が1回で設定の前の画面に戻るように）。
    // location.key は変わるので、設定は「🤖 AI」の欄へスクロールする
    const onSettings = location.pathname === "/settings";
    closeThen(() => navigate("/settings", { replace: onSettings, state: { focus: "ai" } }));
  }

  function startNew() {
    useTeacherUi.setState({ activeId: null, context: generalContext(screen), view: "chat", draft: "" });
  }

  function removeContext() {
    if (conv) useTeacher.getState().setContext(conv.id, null);
    else useTeacherUi.setState({ context: null });
  }

  const canSend = !!provider && online && !streaming;

  function send(text: string) {
    const t = text.trim();
    if (!t || !provider || !online || useTeacherUi.getState().run?.status === "streaming") return;
    // 入力欄の文を送ったときだけ入力欄を空にする（すぐ聞ける質問のチップでは、書きかけの文を残す）
    if (text === useTeacherUi.getState().draft) useTeacherUi.setState({ draft: "" });
    atBottomRef.current = true;
    void sendTeacherMessage({ provider, text: t, convId: conv?.id ?? null, context: conv ? null : newContext, profile: currentProfile() });
  }

  function quick(q: QuickQuestion) {
    if (!q.fill) {
      send(q.text);
      return;
    }
    // 「〜」を選んだ状態で入力欄に入れる（書き足してから送る）
    useTeacherUi.setState({ draft: q.text });
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const at = q.text.indexOf("〜");
      if (at >= 0) el.setSelectionRange(at, at + 1);
    });
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // シートの中のキー操作を、後ろの画面（1枚ずつ学習・単語シートなど）のキー操作に渡さない
    e.stopPropagation();
    if (e.key !== "Escape") return;
    const t = e.target as HTMLElement;
    if (t.tagName === "TEXTAREA" || t.tagName === "INPUT") {
      t.blur();
      panelRef.current?.focus({ preventScroll: true });
      return;
    }
    closeTeacher();
  }

  function onInputKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // PC は Enter で送る。スマホは Enter は改行（送るのはボタン）。どちらも Ctrl / ⌘ + Enter で送る
    if (!finePointer() && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (canSend) send(draft);
  }

  const kind = ctx?.kind ?? "general";
  const quickList = QUICK_QUESTIONS[kind];
  const providerLabel = provider ? `${aiModelLabel(provider.model)}・${provider.free ? "無料枠" : "有料"}` : "AI 未設定";

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex h-[100vh] flex-col pt-[max(0.75rem,env(safe-area-inset-top))] supports-[height:100dvh]:h-[100dvh] md:px-4 md:pb-4 md:pt-6"
      style={box ? { top: box.top, height: box.height } : undefined}
    >
      <div className="absolute inset-0 bg-slate-900/40" onClick={closeTeacher} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="AI先生"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative mx-auto flex min-h-0 w-full max-w-2xl flex-1 animate-fade-in flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl outline-none md:rounded-2xl"
      >
        {/* 見出し */}
        <div className="flex items-center gap-1 border-b border-slate-200 py-1 pl-3 pr-1">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <span aria-hidden className="text-xl">
              🧑‍🏫
            </span>
            <span className="font-bold text-brand-ink">先生</span>
            {streaming && run && run.convId !== activeId && <span className="truncate text-[11px] text-violet-600">別の会話で受信中…</span>}
          </div>
          <button
            type="button"
            onClick={() => useTeacherUi.setState({ view: view === "history" ? "chat" : "history" })}
            aria-pressed={view === "history"}
            className={`min-h-11 rounded-lg px-2 text-xs font-medium ${view === "history" ? "bg-slate-100 text-brand-ink" : "text-slate-500"}`}
          >
            🕘 履歴
          </button>
          <button type="button" onClick={startNew} className="min-h-11 rounded-lg px-2 text-xs font-medium text-slate-500">
            ＋ 新しい会話
          </button>
          <button type="button" onClick={closeTeacher} aria-label="閉じる" className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg text-slate-400">
            ✕
          </button>
        </div>
        {view === "chat" && (
          <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-1">
            {ctx ? (
              <span className="chip min-w-0 max-w-[70%] gap-0.5 bg-brand-blue/10 py-0 pr-0 text-brand-blue">
                <span className="min-w-0 truncate">{ctx.label}</span>
                <button
                  type="button"
                  onClick={removeContext}
                  aria-label="文脈を外す（この内容を先生に渡さない）"
                  className="-my-2 -mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base text-brand-blue/70"
                >
                  ×
                </button>
              </span>
            ) : (
              <span className="py-2 text-[11px] text-slate-400">文脈なし（何でも聞けます）</span>
            )}
            <span className="ml-auto truncate text-[11px] text-slate-400" title="使っている AI（設定の「🤖 AI」で変えられます）">
              {providerLabel}
            </span>
          </div>
        )}

        {/* 本文 */}
        <div
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {view === "history" ? (
            <HistoryList conversations={conversations} activeId={activeId} onOpen={(id) => useTeacherUi.setState({ activeId: id, view: "chat" })} />
          ) : (
            <div className="space-y-3 p-3">
              {!provider ? (
                <SetupCard onSettings={openSettings} />
              ) : (
                messages.length === 0 &&
                !runHere && (
                  <div className="rounded-2xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-600">
                    🧑‍🏫 なんでも聞いてください。
                    {ctx && ctx.kind !== "general" ? "上のチップの内容（いま見ているもの）について答えます。" : ""}
                    下の質問を押すか、入力して送ってください。例文には 🔊 と読みが付きます。
                  </div>
                )
              )}
              {messages.map((m, i) => (
                <TeacherMessage key={`${m.at}-${i}`} role={m.role} text={m.text} model={m.model} stopped={m.stopped} />
              ))}
              {runHere?.status === "streaming" &&
                (runHere.text ? (
                  <div className="flex gap-2" aria-live="polite">
                    <span aria-hidden className="mt-1 shrink-0 text-xl">
                      🧑‍🏫
                    </span>
                    <div className="min-w-0 flex-1 rounded-2xl rounded-tl-md bg-slate-50 px-3.5 py-2.5 ring-1 ring-slate-100">
                      <TeacherAnswer text={runHere.text} />
                    </div>
                  </div>
                ) : (
                  <Typing />
                ))}
              {runHere?.status === "error" && (
                <div role="alert" className="space-y-2 rounded-2xl bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-rose-100">
                  {runHere.partial.trim() && (
                    <div className="rounded-xl bg-white/70 p-2 opacity-70">
                      <TeacherAnswer text={runHere.partial} />
                    </div>
                  )}
                  <p>{runHere.message}</p>
                  <div className="flex flex-wrap gap-2">
                    {runHere.kind !== "no-key" && (
                      <button
                        type="button"
                        onClick={() => conv && void retryTeacher(conv.id, provider, currentProfile())}
                        disabled={!provider || !online || streaming}
                        className="btn-ghost min-h-11 px-4 text-sm"
                      >
                        再試行
                      </button>
                    )}
                    {(runHere.kind === "no-key" || runHere.kind === "auth" || runHere.kind === "quota") && (
                      <button type="button" onClick={openSettings} className="btn-ghost min-h-11 px-4 text-sm">
                        ⚙ 設定を開く
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 入力 */}
        {view === "chat" && provider && (
          <div className="border-t border-slate-200 bg-white pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
            <div className="flex gap-1.5 overflow-x-auto px-3 pt-1.5" role="group" aria-label="すぐ聞ける質問">
              {quickList.map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => quick(q)}
                  disabled={!canSend}
                  className="chip min-h-11 shrink-0 whitespace-nowrap bg-violet-50 px-3 text-violet-700 ring-1 ring-violet-200 transition active:scale-95 disabled:opacity-40"
                >
                  {q.label}
                </button>
              ))}
            </div>
            <div className="flex items-end gap-2 px-3 pt-1.5">
              <textarea
                ref={inputRef}
                value={draft}
                onChange={(e) => useTeacherUi.setState({ draft: e.target.value })}
                onKeyDown={onInputKey}
                rows={1}
                maxLength={MAX_QUESTION_CHARS}
                enterKeyHint={finePointer() ? "send" : "enter"}
                placeholder={online ? "先生に質問する…" : "オフラインです（つながると送れます）"}
                aria-label="先生への質問"
                className="max-h-36 min-h-11 min-w-0 flex-1 resize-none rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-base leading-snug text-brand-ink placeholder:text-slate-400 focus:border-brand-green focus:outline-none focus:ring-2 focus:ring-brand-green/25"
              />
              {/* 受信中は「停止」（別の会話の返事を受信中でも、それを止める。止めるまで次の質問は送れない） */}
              {streaming ? (
                <button
                  type="button"
                  onClick={() => useTeacherUi.getState().ctrl?.abort()}
                  className="btn min-h-11 shrink-0 bg-rose-500 px-3 text-sm text-white"
                  aria-label="返事を止める"
                >
                  ■ 停止
                </button>
              ) : (
                <button type="button" onClick={() => send(draft)} disabled={!canSend || !draft.trim()} className="btn-primary min-h-11 shrink-0 px-4 text-sm">
                  送信
                </button>
              )}
            </div>
            {provider.id === "gemini" && (
              <p className="px-3 pt-1 text-[10px] leading-snug text-slate-400">無料枠の内容は Google の改善に使われます。個人情報は書かないでください</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
