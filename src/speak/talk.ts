// ============================================================================
// AI との会話練習（ロールプレイ）: 場面・プロンプト・応答の検査（純関数）と、AI の呼び出し
//   検証: scripts/check-speak.ts（npm run check:speak。偽のサービスで動かし、実際には通信しない）
// - 場面はレッスン（data/course の talk）・フリートーク（FREE_TOPICS）・自分で書いた場面の3種類。
// - AI には毎回 JSON で答えさせる（AiProvider.generateJson）: 相手の返事（ポルトガル語）と訳、学習者の直前の発言への
//   フィードバック（自然か・より良い言い方）、次に言える例、達成したミッション、会話が終わったか。
// - 会話の中身は保存しない（画面を閉じたら消える）。直された文を「口慣らし」に足したときだけ、その文が残る。
// - 設定に自分の API キーを入れたときだけ動く（キーが無ければ Google・Anthropic とは通信しない）。
// ============================================================================

import type { Lesson } from "../data/course";
import { AiError, type AiProvider } from "../services/ai/types";

export interface TalkScenario {
  /** レッスンの ID / "free:…" / "custom" */
  id: string;
  title: string;
  /** AI が演じる相手 */
  role: string;
  /** 場面と流れ */
  setting: string;
  /** 相手の最初のひとこと（ポルトガル語）。空なら AI に始めてもらう */
  opener: string;
  /** 学習者がこの会話でやること */
  missions: string[];
  /** この場面で使いたい文（レッスンのフレーズ。AI が言う機会を作る） */
  targets?: string[];
}

export function lessonScenario(l: Lesson): TalkScenario {
  return {
    id: l.id,
    title: l.title,
    role: l.talk.role,
    setting: l.talk.setting,
    opener: l.talk.opener,
    missions: l.talk.missions,
    targets: l.phrases.map((p) => p.pt),
  };
}

/** フリートーク（レッスンに関係なく、自分のことを話す） */
export const FREE_TOPICS: TalkScenario[] = [
  {
    id: "free:intro",
    title: "自己紹介しあう",
    role: "カフェで隣に座ったブラジル人の Rafael",
    setting: "サンパウロのカフェ。隣の席の人が気さくに話しかけてくる。お互いのことを少し話す。",
    opener: "Oi! Você não é daqui, né? De onde você é?",
    missions: ["名前と出身を言う", "仕事か勉強の話をする", "相手に質問を1つする"],
  },
  {
    id: "free:day",
    title: "今日のことを話す",
    role: "友達の Camila",
    setting: "夕方、友達と会って、今日あったことを話す。",
    opener: "Oi! E aí, como foi o seu dia?",
    missions: ["今日したことを言う", "感想や気持ちを言う", "相手の一日も聞く"],
  },
  {
    id: "free:weekend",
    title: "週末の予定を話す",
    role: "同僚の Lucas",
    setting: "金曜の仕事終わり。同僚と週末の予定を話して、一緒に何かする約束をする。",
    opener: "E aí! O que você vai fazer no fim de semana?",
    missions: ["自分の予定を言う", "誘う・誘いに答える", "時間か場所を決める"],
  },
  {
    id: "free:food",
    title: "食べ物の話をする",
    role: "隣に住む Ana",
    setting: "隣人と立ち話。ブラジル料理と日本料理の話になる。",
    opener: "Você já experimentou comida brasileira? O que você mais gosta?",
    missions: ["好きな食べ物を言う", "理由を言う", "おすすめを聞く"],
  },
  {
    id: "free:music",
    title: "音楽の話をする",
    role: "カポエイラ仲間の Camila",
    setting: "練習の帰り道。好きな音楽や歌手の話をする。",
    opener: "Que tipo de música você gosta de ouvir?",
    missions: ["好きな音楽を言う", "相手の好みを聞く", "おすすめの曲を聞く"],
  },
  {
    id: "free:capoeira",
    title: "カポエイラの話をする",
    role: "カポエイラの先生 Mestre Bira",
    setting: "練習の前。先生が、これまでの経験や練習のことを聞いてくる。",
    opener: "E aí, tudo bem? Há quanto tempo você treina capoeira?",
    missions: ["始めた時期を言う", "好きなところを言う", "先生に質問を1つする"],
  },
  {
    id: "free:japan",
    title: "日本について聞かれる",
    role: "配車アプリの運転手",
    setting: "車の中。日本人だと分かった運転手が、日本のことをいろいろ聞いてくる。",
    opener: "Você é do Japão? Que legal! Como é a vida lá?",
    missions: ["日本のことを1つ説明する", "ブラジルの印象を言う", "相手に質問を1つする"],
  },
  {
    id: "free:trip",
    title: "旅行の話をする",
    role: "同僚の Lucas",
    setting: "昼休み。ブラジルで行った所・行きたい所の話をする。",
    opener: "Você já viajou pelo Brasil? Para onde você quer ir?",
    missions: ["行った所か行きたい所を言う", "理由を言う", "相手のおすすめを聞く"],
  },
];

/** 自分で書いた場面の長さの上限（文字） */
export const CUSTOM_SCENE_MAX = 200;

/** 自分で書いた場面（最初のひとことは AI に始めてもらう） */
export function customScenario(text: string): TalkScenario {
  const t = text.replace(/\s+/g, " ").trim().slice(0, CUSTOM_SCENE_MAX);
  return {
    id: "custom",
    title: t.length > 18 ? `${t.slice(0, 17)}…` : t,
    role: "この場面にふさわしい相手（店員・友達など。場面から決める）",
    setting: t,
    opener: "",
    missions: ["自分から用件を伝える", "相手の質問に答える", "お礼か別れのあいさつで締める"],
  };
}

// ---------------------------------------------------------------------------
// むずかしさ（相手の話し方）
// ---------------------------------------------------------------------------

export type TalkLevel = 0 | 1 | 2 | 3;
export const TALK_LEVELS: readonly TalkLevel[] = [0, 1, 2, 3];
export const TALK_LEVEL_LABEL: Record<TalkLevel, string> = { 0: "入門", 1: "やさしい", 2: "ふつう", 3: "自然" };

const LEVEL_RULE: Record<TalkLevel, string> = {
  0: "入門（学び始め）。現在形の短い決まり文句だけを使う。1文は6語まで、1回の返事は1〜2文。",
  1: "初級の前半。現在形のやさしい文だけを使う。1文は8語まで、1回の返事は1〜2文。",
  2: "初級。現在形・近い未来（ir + 不定詞）・完了過去のやさしい文を使う。1文は10語まで、1回の返事は1〜2文。",
  3: "初中級。日常会話の自然な言い方で話す（接続法など難しい形は避ける）。1文は14語まで、1回の返事は2文まで。",
};

/** 終えたレッスンの数からの既定のむずかしさ（6課ごとに1段。最後の段は 24 課から） */
export function defaultTalkLevel(lessonsDone: number): TalkLevel {
  if (lessonsDone < 6) return 0;
  if (lessonsDone < 12) return 1;
  if (lessonsDone < 24) return 2;
  return 3;
}

// ---------------------------------------------------------------------------
// 会話の形
// ---------------------------------------------------------------------------

/** 学習者の発言へのフィードバック */
export interface TalkFeedback {
  /** そのままで通じる・自然 */
  ok: boolean;
  /** より自然な言い方（ポルトガル語の全文）。ok なら "" */
  better: string;
  /** better の日本語訳。ok なら "" */
  ja: string;
  /** 一言の理由（日本語）。ok なら "" */
  note: string;
}

export interface TalkHint {
  pt: string;
  ja: string;
}

export type TalkTurn =
  | { who: "ai"; pt: string; ja: string }
  /** feedback: undefined = まだ返事を待っている / null = フィードバックなし */
  | { who: "me"; text: string; feedback?: TalkFeedback | null };

export interface TalkReply {
  reply: string;
  replyJa: string;
  /** 学習者の直前の発言へのフィードバック（会話の始まりでは null） */
  feedback: TalkFeedback | null;
  hints: TalkHint[];
  /** 達成したミッションの番号（0 始まり・昇順・範囲内だけ） */
  missionsDone: number[];
  end: boolean;
}

/** AI に送る会話の長さの上限（発言の数。古い発言は省く） */
export const TALK_HISTORY_MAX = 24;
/** 学習者の1回の発言の長さの上限（文字） */
export const TALK_INPUT_MAX = 300;

export const TALK_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    reply: { type: "string" },
    reply_ja: { type: "string" },
    feedback: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        better: { type: "string" },
        better_ja: { type: "string" },
        note: { type: "string" },
      },
      required: ["ok", "better", "better_ja", "note"],
      additionalProperties: false,
    },
    hints: {
      type: "array",
      items: {
        type: "object",
        properties: { pt: { type: "string" }, ja: { type: "string" } },
        required: ["pt", "ja"],
        additionalProperties: false,
      },
    },
    missions_done: { type: "array", items: { type: "integer" } },
    end: { type: "boolean" },
  },
  required: ["reply", "reply_ja", "feedback", "hints", "missions_done", "end"],
  additionalProperties: false,
};

/** 会話の相手としての役割・話し方（システムプロンプト） */
export function buildTalkSystem(sc: TalkScenario, level: TalkLevel): string {
  const targets = (sc.targets ?? []).slice(0, 8);
  return [
    "あなたは、日本語話者がブラジルポルトガル語を「話せるようになる」ための会話練習の相手です。下の場面で、役になりきって学習者と会話します。",
    "",
    "# 場面",
    `- あなたの役: ${sc.role}`,
    `- 場面: ${sc.setting}`,
    "- 学習者は、ブラジルにいる日本人の学習者本人として話します（名前や仕事は、本人が言うまで決めつけない）。",
    "",
    "# 学習者がこの会話でやること（ミッション）",
    ...sc.missions.map((m, i) => `${i}: ${m}`),
    ...(targets.length
      ? ["", "# この場面で学習者が練習した文（これらを言う機会が自然にできるように会話を運ぶ。あなたが先に言ってしまわない）", ...targets.map((t) => `- ${t}`)]
      : []),
    "",
    "# 話し方（reply）",
    "- 必ずブラジルポルトガル語だけで、役のセリフだけを書く（説明・訂正・日本語・絵文字・かっこ書きは書かない）。",
    `- 学習者のレベル: ${LEVEL_RULE[level]} ただし、この場面のミッション${targets.length ? "と、上の「練習した文」" : ""}に出てくる時制・言い方は使ってよい。`,
    "- ブラジルで実際に話される自然な言い方（você・a gente）。綴りは標準形で書く（tô・tá・pra ではなく estou・está・para）。数字は語で書く。",
    "- 質問は1回に1つだけ。学習者が話す番を作る（自分ばかり話さない）。",
    "- 学習者の発言が不完全でも、意味が分かれば会話を止めずに自然に続ける。分からなければ、役のまま聞き返す。",
    "- 学習者が日本語や英語で言ったら、役のまま、分かったこととして自然に続ける（言い方は feedback で教える）。",
    "- ミッションが全部済んだら、1〜2往復で自然に締めくくる。",
    "",
    "# 返す JSON",
    "- reply: 上のきまりで書いた、あなたの次のセリフ。",
    "- reply_ja: reply の自然な日本語訳。",
    "- feedback: 学習者の「今の発言」について。",
    "  - 通じて自然なら ok=true、better・better_ja・note は空文字。",
    "  - ok=false にするのは、活用・人称の誤り、性・数の不一致、前置詞・縮約の誤り、ser と estar の取り違え、語の選び方の誤り、または意味が伝わらないときだけ。正しくて通じる短い文を、もっと凝った文に書き換えない。",
    "  - 直すときは ok=false。直すのはいちばん大事な1か所だけにして、学習者が使った語はできるだけ残す。better に、学習者が言いたかったことの自然な言い方の全文（ポルトガル語・学習者のレベルで言える文）、better_ja にその日本語訳、note に理由を日本語で1文（40文字以内）。",
    "  - 学習者の発言は音声認識の文字かもしれない。句読点・大文字と小文字・アクセント記号の抜け・聞き間違いらしい綴りは誤りにしない。文法（活用・性数・前置詞）と語の選び方、言いたいことが伝わるかを見る。",
    "  - 学習者が日本語や英語で言ったときは ok=false にして、better にそのポルトガル語での言い方を書く。",
    "  - 会話の始まり（学習者がまだ何も言っていない）は ok=true で空文字。",
    "- hints: 学習者があなたの reply に対して次に言える短い返事の例を、ちょうど2つ（pt と、その日本語訳 ja）。学習者のレベルで言える文。まだ済んでいないミッションに進める文を優先する。",
    "- missions_done: これまでの会話全体で、学習者が達成したミッションの番号の一覧（0 始まり）。",
    "- end: 別れのあいさつが済んだ・用件が全部済んだなど、会話が自然に終わったら true。",
  ].join("\n");
}

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max);

/** AI に送る user メッセージ（これまでの会話と、学習者の今の発言） */
export function buildTalkUser(turns: readonly TalkTurn[]): string {
  const recent = turns.slice(-TALK_HISTORY_MAX);
  const last = recent[recent.length - 1];
  const history = (last?.who === "me" ? recent.slice(0, -1) : recent).map((t) =>
    t.who === "ai" ? `あなた: ${oneLine(t.pt, 400)}` : `学習者: ${oneLine(t.text, TALK_INPUT_MAX)}`
  );
  if (!last || last.who !== "me") {
    return [
      history.length ? "# これまでの会話" : "# 会話はまだ始まっていません",
      ...history,
      "",
      history.length ? "学習者はまだ返事をしていません。会話を続けるセリフを言ってください。" : "役になって、場面に合う最初のひとことで会話を始めてください。",
    ].join("\n");
  }
  return ["# これまでの会話", ...(history.length ? history : ["（まだありません）"]), "", "# 学習者の今の発言", oneLine(last.text, TALK_INPUT_MAX)].join(
    "\n"
  );
}

const str = (v: unknown, max: number): string => (typeof v === "string" ? oneLine(v, max) : "");

/** AI の応答（JSON）を確かめて TalkReply にする。reply が無ければ AiError（bad-response） */
export function parseTalkReply(json: unknown, missionCount: number, hadLearnerTurn = true): TalkReply {
  const o = (typeof json === "object" && json !== null && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const reply = str(o.reply, 600);
  if (!reply) throw new AiError("bad-response", "AIの返事を読めませんでした。もう一度お試しください", { code: "talk-empty" });
  const f = (typeof o.feedback === "object" && o.feedback !== null ? o.feedback : {}) as Record<string, unknown>;
  const better = str(f.better, 300);
  // 直す文が無ければ「自然」とみなす（ok=false なのに better が空の応答を、誤りとして見せない）
  const ok = f.ok !== false || !better;
  const feedback: TalkFeedback | null = hadLearnerTurn
    ? ok
      ? { ok: true, better: "", ja: "", note: "" }
      : { ok: false, better, ja: str(f.better_ja, 300), note: str(f.note, 120) }
    : null;
  const hints: TalkHint[] = Array.isArray(o.hints)
    ? o.hints
        .map((h) => {
          const x = (typeof h === "object" && h !== null ? h : {}) as Record<string, unknown>;
          return { pt: str(x.pt, 200), ja: str(x.ja, 200) };
        })
        .filter((h) => h.pt)
        .slice(0, 3)
    : [];
  const done = Array.isArray(o.missions_done)
    ? [...new Set(o.missions_done.filter((n): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) < missionCount))].sort(
        (a, b) => a - b
      )
    : [];
  return { reply, replyJa: str(o.reply_ja, 600), feedback, hints, missionsDone: done, end: o.end === true };
}

export interface TalkReplyResult extends TalkReply {
  /** 答えたモデル */
  model: string;
  /** 設定のモデルが上限だったので別のモデルが答えたとき、元のモデル */
  fallbackFrom?: string;
}

/** 相手（AI）の次の返事をもらう。turns の最後が学習者の発言なら、そのフィードバックも返る */
export async function requestTalkReply(
  provider: Pick<AiProvider, "generateJson">,
  sc: TalkScenario,
  level: TalkLevel,
  turns: readonly TalkTurn[],
  signal?: AbortSignal
): Promise<TalkReplyResult> {
  const last = turns[turns.length - 1];
  const res = await provider.generateJson({
    system: buildTalkSystem(sc, level),
    user: buildTalkUser(turns),
    schema: TALK_SCHEMA,
    signal,
  });
  const reply = parseTalkReply(res.json, sc.missions.length, last?.who === "me");
  return { ...reply, model: res.model, ...(res.fallbackFrom ? { fallbackFrom: res.fallbackFrom } : {}) };
}

// ---------------------------------------------------------------------------
// 「なんて言う？」（日本語 → 自然なブラジルポルトガル語）
// ---------------------------------------------------------------------------

export interface HowToSay {
  /** いちばん自然で、学習者にも言いやすい言い方 */
  pt: string;
  /** 別の言い方（0〜2個） */
  alt: string[];
  /** 一言の補足（日本語） */
  note: string;
}

export const SAY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    pt: { type: "string" },
    alt: { type: "array", items: { type: "string" } },
    note: { type: "string" },
  },
  required: ["pt", "alt", "note"],
  additionalProperties: false,
};

export const SAY_INPUT_MAX = 200;

export function buildSaySystem(): string {
  return [
    "あなたはブラジルポルトガル語の先生です。日本語話者の学習者が「これを言いたい」と書いた日本語を、ブラジルで実際に話される自然な口語のポルトガル語にします。",
    "- pt: いちばん自然で、初級の学習者にも言いやすい短い言い方を1つ（1〜2文）。直訳より、ブラジル人が実際に言う言い方を選ぶ。",
    "- 綴りは標準形で書く（tô・tá・pra ではなく estou・está・para）。数字は語で書く。você・a gente を使う（tu・vós は使わない）。",
    "- 話す人の性別で形が変わるとき（obrigado / obrigada、cansado / cansada など）は、pt に男性形、alt に女性形を入れる。",
    "- alt: 同じ意味の別の言い方を0〜2個（くだけた言い方・丁寧な言い方など）。無ければ空の配列。",
    "- note: 使い分け・ニュアンス・発音の注意を日本語で1文（60文字以内）。特に無ければ空文字。",
    "- 場面の説明があれば、その場面に合う言い方にする。",
  ].join("\n");
}

export function buildSayUser(ja: string, context?: string): string {
  const lines = [`言いたいこと（日本語）: ${oneLine(ja, SAY_INPUT_MAX)}`];
  if (context?.trim()) lines.push(`場面: ${oneLine(context, 300)}`);
  return lines.join("\n");
}

export function parseHowToSay(json: unknown): HowToSay {
  const o = (typeof json === "object" && json !== null && !Array.isArray(json) ? json : {}) as Record<string, unknown>;
  const pt = str(o.pt, 300);
  if (!pt) throw new AiError("bad-response", "AIの返事を読めませんでした。もう一度お試しください", { code: "say-empty" });
  const alt = Array.isArray(o.alt)
    ? [...new Set(o.alt.map((a) => str(a, 300)).filter((a) => a && a !== pt))].slice(0, 2)
    : [];
  return { pt, alt, note: str(o.note, 120) };
}

/** 日本語の「言いたいこと」を、自然なブラジルポルトガル語にしてもらう */
export async function requestHowToSay(
  provider: Pick<AiProvider, "generateJson">,
  ja: string,
  context?: string,
  signal?: AbortSignal
): Promise<HowToSay> {
  const res = await provider.generateJson({ system: buildSaySystem(), user: buildSayUser(ja, context), schema: SAY_SCHEMA, signal });
  return parseHowToSay(res.json);
}
