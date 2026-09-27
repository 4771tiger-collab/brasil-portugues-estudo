// ============================================================================
// 🧑‍🏫 AI 先生に質問を送り、返事を受け取る（先生のシートから呼ぶ）
//   検証: scripts/check-ai.ts（偽のサービスで: 少しずつ届く返事・停止・失敗・再試行）
// - sendTeacherMessage: 質問を会話の履歴（store/useTeacher.ts。端末だけ）に足し、返事を受け取る。
//   会話が無ければ、そのときの文脈で新しい会話を作る。
// - 受信中の返事は useTeacherUi.run（保存しない）に少しずつ入れ、届き終わったら履歴に足す
//   （届くたびに localStorage へ書かない）。
// - 停止（中止）: 途中まで届いた返事があれば「停止しました」の印を付けて履歴に足す。
//   まだ1文字も届いていなければ、run を「返事が届く前に停止しました」の失敗にする（画面で「再試行」）。
// - 失敗: 履歴には足さず、run に種類・日本語の説明・途中まで届いた返事を入れる（画面で「再試行」）。
//   再試行（retryTeacher）は、最後の発言が質問のときだけ、同じ会話でもう一度頼む。
// - シートを閉じても受信は続ける（閉じても最後まで受け取って履歴に入る）。
// ============================================================================

import { useTeacher, type TeacherMessage } from "../../store/useTeacher";
import { buildTeacherSystem, buildTurns, type TeacherProfile } from "./teacherPrompt";
import { useTeacherUi, type TeacherContext } from "./teacherContext";
import { AiError, type AiProvider } from "./types";

export interface TeacherSendOptions {
  /** 今使うサービス（キーが無ければ null → no-key の失敗） */
  provider: AiProvider | null;
  /** 質問 */
  text: string;
  /** 送る先の会話（null = 新しい会話を作る） */
  convId: string | null;
  /** 新しい会話の文脈（convId があるときは、その会話に保存した文脈を使う） */
  context: TeacherContext | null;
  profile: TeacherProfile;
  /** 時刻（検証用） */
  now?: () => string;
}

const isoNow = () => new Date().toISOString();

/** 質問の文字数の上限 */
export const MAX_QUESTION_CHARS = 2000;

/** 受信中の返事を止めて run を消す（会話を消したとき・すべて消したとき） */
export function resetTeacherRun(): void {
  const { ctrl } = useTeacherUi.getState();
  ctrl?.abort();
  useTeacherUi.setState({ run: null, ctrl: null });
}

/** 会話を1つ消す（受信中ならその返事も止める。開いていた会話なら、新しい会話に戻す） */
export function deleteTeacherConversation(id: string): void {
  const ui = useTeacherUi.getState();
  if (ui.run?.convId === id) resetTeacherRun();
  useTeacher.getState().remove(id);
  if (ui.activeId === id) useTeacherUi.setState({ activeId: null });
}

/** 会話の履歴をすべて消す（受信中の返事も止める） */
export function clearTeacherHistory(): void {
  resetTeacherRun();
  useTeacher.getState().clearAll();
  useTeacherUi.setState({ activeId: null });
}

/**
 * 質問を送る。送った会話の ID を返す（質問が空なら何もしないで null）。
 * 返事は useTeacherUi.run に少しずつ入り、届き終わったら会話の履歴に入る（失敗は run に）
 */
export async function sendTeacherMessage(o: TeacherSendOptions): Promise<string | null> {
  const text = o.text.trim().slice(0, MAX_QUESTION_CHARS);
  if (!text) return null;
  const now = o.now ?? isoNow;
  const store = useTeacher.getState();
  const exists = o.convId !== null && store.conversations.some((c) => c.id === o.convId);
  const convId = exists && o.convId !== null ? o.convId : store.newConversation({ context: o.context, at: now() });
  useTeacher.getState().append(convId, { role: "user", text, at: now() });
  // 開いている会話をこれにする（新しい会話を作ったとき・前の会話が消えていたとき）
  if (useTeacherUi.getState().activeId !== convId) useTeacherUi.setState({ activeId: convId });
  await streamReply(convId, o.provider, o.profile, now);
  return convId;
}

/** 失敗した回をもう一度頼む（最後の発言が質問のときだけ。そうでなければ何もしない） */
export async function retryTeacher(convId: string, provider: AiProvider | null, profile: TeacherProfile, now: () => string = isoNow): Promise<void> {
  const conv = useTeacher.getState().conversations.find((c) => c.id === convId);
  const last = conv?.messages[conv.messages.length - 1];
  if (!conv || last?.role !== "user") {
    useTeacherUi.setState((s) => (s.run?.convId === convId ? { run: null } : {}));
    return;
  }
  await streamReply(convId, provider, profile, now);
}

/** 返事を受け取る（会話の最後が質問のとき） */
async function streamReply(convId: string, provider: AiProvider | null, profile: TeacherProfile, now: () => string): Promise<void> {
  // 前の受信は止める（重ねて頼まない）
  useTeacherUi.getState().ctrl?.abort();
  if (!provider) {
    useTeacherUi.setState({
      run: { convId, status: "error", kind: "no-key", message: "AI の APIキーが設定されていません（設定の「🤖 AI」で入れてください）", partial: "" },
      ctrl: null,
    });
    return;
  }
  const conv = useTeacher.getState().conversations.find((c) => c.id === convId);
  if (!conv) return;
  const system = buildTeacherSystem(profile, conv.context ?? null);
  const turns = buildTurns(conv.messages);
  const ctrl = new AbortController();
  const mine = () => useTeacherUi.getState().ctrl === ctrl;
  useTeacherUi.setState({ run: { convId, status: "streaming", text: "", model: provider.model }, ctrl });
  let acc = "";
  try {
    const r = await provider.streamChat({
      system,
      turns,
      signal: ctrl.signal,
      onText: (d) => {
        acc += d;
        if (mine()) useTeacherUi.setState({ run: { convId, status: "streaming", text: acc, model: provider.model } });
      },
    });
    if (ctrl.signal.aborted) throw new AiError("aborted", "中止しました", { code: "aborted", partialText: acc });
    const msg: TeacherMessage = { role: "assistant", text: r.text, at: now(), model: r.model };
    useTeacher.getState().append(convId, msg);
    if (mine()) useTeacherUi.setState({ run: null, ctrl: null });
  } catch (e) {
    const err = e instanceof AiError ? e : new AiError("unknown", "AIの呼び出しに失敗しました", { code: "unknown" });
    const partial = err.partialText ?? acc;
    if (err.kind === "aborted" || ctrl.signal.aborted) {
      // 停止: 途中まで届いた返事は「停止しました」の印を付けて残す（会話が消えていれば何もしない）。
      // モデルは答えていたもの（Gemini が上限で 3.5 Flash-Lite に替えていれば、そちら）
      if (partial.trim()) {
        useTeacher.getState().append(convId, { role: "assistant", text: partial, at: now(), model: err.model ?? provider.model, stopped: true });
      }
      // まだ1文字も届いていなければ、停止したことを出して「再試行」できるようにする（質問だけが残るので）
      if (mine()) {
        useTeacherUi.setState(
          partial.trim()
            ? { run: null, ctrl: null }
            : { run: { convId, status: "error", kind: "aborted", message: "返事が届く前に停止しました", partial: "" }, ctrl: null }
        );
      }
      return;
    }
    if (mine()) useTeacherUi.setState({ run: { convId, status: "error", kind: err.kind, message: err.message, partial }, ctrl: null });
  }
}
