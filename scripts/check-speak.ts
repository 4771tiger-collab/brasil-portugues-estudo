// ============================================================================
// 話す練習（口慣らし・レッスン・AI との会話）の回帰テスト
//   npm run check:speak
// 前半は純関数（speak/catalog.ts・speak/speakData.ts・speak/talk.ts）。後半はストア（useSpeak）と
// バックアップをメモリ上の localStorage で動かす結合テスト。AI は偽のサービスで動かし、実際には通信しない。
// 1件でも失敗したら終了コード1。
// ============================================================================

import type { SrsCard } from "../src/data/types";
import { LESSONS, UNITS, buildUnits, nextLesson } from "../src/data/course";
import {
  CAN_SAY_DAYS,
  SAY_GOOD_PERCENT,
  SAY_HARD_PERCENT,
  answersOf,
  buildCatalog,
  dueCount,
  dueItems,
  extraItems,
  lessonItems,
  ratingFromPercent,
  speakStats,
  type SayItem,
} from "../src/speak/catalog";
import {
  LESSON_STEPS,
  TALK_LOG_MAX,
  emptySpeak,
  isMyPhraseId,
  mergeSpeak,
  newPhraseId,
  readSpeak,
  readUserPhrase,
  samePhraseText,
  type SpeakExport,
  type UserPhrase,
} from "../src/speak/speakData";
import {
  FREE_TOPICS,
  TALK_HISTORY_MAX,
  TALK_SCHEMA,
  buildSayUser,
  buildTalkSystem,
  buildTalkUser,
  customScenario,
  defaultTalkLevel,
  lessonScenario,
  parseHowToSay,
  parseTalkReply,
  requestHowToSay,
  requestTalkReply,
  type TalkTurn,
} from "../src/speak/talk";
import { AiError, type GenerateJsonOptions, type GenerateJsonResult } from "../src/services/ai/types";
import { scoreSpeechSentence } from "../src/services/grade";
import { addDays, newCard, review, todayStr } from "../src/srs/scheduler";
import { composeBackup, describeBackup, parseBackup, pickSettings } from "../src/store/backupFormat";
import { countsAsStudy, isStudyDay, readDayLog } from "../src/store/history";

let fail = 0;
let pass = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    console.error(`  ✗ ${label}\n      期待: ${e}\n      実際: ${a}`);
  }
}
function ok(cond: boolean, label: string) {
  eq(cond, true, label);
}

const TD = "2026-11-12";
function card(p: Partial<SrsCard> = {}): SrsCard {
  return { ease: 2.5, intervalDays: 1, due: TD, reps: 1, lapses: 0, level: "learning", last: addDays(TD, -1), ...p };
}
const item = (id: string, pt = "Tudo bem?"): SayItem => ({ id, ja: `和文 ${id}`, pt, label: "テスト" });
const cat = (...ids: string[]) => new Map(ids.map((id) => [id, item(id)]));

// ---------------------------------------------------------------------------
console.log("=== コース（data/course）の読み込み ===");
{
  eq(UNITS.length, 6, "ユニットは6つ");
  eq(LESSONS.length, 36, "レッスンは36課");
  eq(LESSONS.map((l) => l.no), Array.from({ length: 36 }, (_, i) => i + 1), "レッスンの番号は 1 から順");
  ok(LESSONS.every((l) => l.unitId === l.id.slice(0, 2)), "レッスンは自分のユニットに属する");
  eq(nextLesson("u1l1")?.id, "u1l2", "次のレッスン");
  eq(nextLesson("u1l6")?.id, "u2l1", "ユニットの最後の次は、次のユニットの最初");
  eq(nextLesson("u6l6"), null, "最後のレッスンの次は無い");
  eq(nextLesson("nope"), null, "知らない ID の次は無い");
  const ids = LESSONS.flatMap((l) => l.phrases.map((p) => p.id));
  eq(new Set(ids).size, ids.length, "フレーズの ID は重複しない");
  ok(ids.every((id) => !isMyPhraseId(id)), "レッスンのフレーズの ID は自分の文（my:）と衝突しない");
  const u = buildUnits([{ id: "x1", title: "t", goal: "g", lessons: [{ id: "x1l1", title: "a", goal: "b", scene: "c", partner: "d", lines: [], phrases: [], talk: { role: "r", setting: "s", opener: "o", missions: [] } }] }]);
  eq(u[0].lessons[0].tips, [], "tips が無いレッスンは空の配列で補う");
}

console.log("=== 文の一覧（buildCatalog / lessonItems） ===");
{
  const l = LESSONS[0];
  const items = lessonItems(l);
  eq(items.length, l.phrases.length, "レッスンの文の数");
  eq(items[0].label, `L1 ${l.title}`, "出どころの表示は「L番号 題名」");
  eq(items[0].lessonId, "u1l1", "レッスンの ID を持つ");
  const withAlt = items.find((i) => i.alt?.length);
  ok(!!withAlt && answersOf(withAlt).length === 1 + (withAlt.alt?.length ?? 0) && answersOf(withAlt)[0] === withAlt.pt, "正解の言い方は pt が先頭、続けて alt");
  const mine: UserPhrase = { id: "my:abc", ja: "テスト", pt: "Teste.", createdAt: TD, from: "manual" };
  const c = buildCatalog([mine]);
  eq(c.get("my:abc")?.label, "自分のフレーズ", "自分で足した文も一覧に入る");
  ok(c.has("u1l1p1") && c.size === LESSONS.reduce((n, x) => n + x.phrases.length, 0) + 1, "レッスンの全部の文 ＋ 自分の文");
}

console.log("=== 今日の口慣らし（dueItems / dueCount / extraItems） ===");
{
  const cards = {
    a: card({ due: TD }),
    b: card({ due: addDays(TD, -3), intervalDays: 8 }),
    c: card({ due: addDays(TD, 2) }),
    d: card({ due: addDays(TD, -3), intervalDays: 2 }),
    gone: card({ due: addDays(TD, -9) }),
    fresh: newCard(TD),
  };
  const c = cat("a", "b", "c", "d", "fresh");
  eq(dueItems(cards, c, TD).map((i) => i.id), ["d", "b", "fresh", "a"], "延滞の大きい順 → 間隔の短い順 → ID 順。教材に無い文・期限前の文は出さない");
  eq(dueItems(cards, c, TD, 2).map((i) => i.id), ["d", "b"], "今日の残りの枠まで");
  eq(dueItems(cards, c, TD, 0), [], "枠が 0 なら出さない");
  eq(dueItems(cards, c, TD, -5), [], "枠が負でも出さない");
  eq(dueCount(cards, c, TD), 4, "期限の来ている文の数（枠は見ない）");
  eq(dueItems({}, c, TD), [], "カードが無ければ空");
  // 追加練習: 期限前で、評価済みの文だけ
  const more = { ...cards, e: card({ due: addDays(TD, 5), intervalDays: 6, last: addDays(TD, -1) }), f: card({ due: addDays(TD, 9), intervalDays: 1, last: addDays(TD, -4) }) };
  const c2 = cat("a", "b", "c", "d", "e", "f", "fresh");
  eq(extraItems(more, c2, TD, 10).map((i) => i.id), ["f", "c", "e"], "追加練習は期限前の文を、間隔の短い順 → 久しぶりの順に");
  eq(extraItems(more, c2, TD, 1).map((i) => i.id), ["f"], "追加練習は n 個まで");
  eq(extraItems(more, c2, TD, 0), [], "n が 0 なら空");
}

console.log("=== 話す力の数字（speakStats）・おすすめの評価（ratingFromPercent） ===");
{
  const cards = {
    a: card({ intervalDays: CAN_SAY_DAYS }),
    b: card({ intervalDays: CAN_SAY_DAYS - 1 }),
    c: card({ intervalDays: 30 }),
    n: newCard(TD),
    gone: card({ intervalDays: 30 }),
  };
  eq(speakStats(cards, cat("a", "b", "c", "n")), { started: 3, canSay: 2, learning: 1 }, "言える文＝間隔7日以上。未評価・教材に無い文は数えない");
  eq(speakStats({}, cat("a")), { started: 0, canSay: 0, learning: 0 }, "カードが無ければ 0");
  eq(ratingFromPercent(100), "good", "満点 → 言えた");
  eq(ratingFromPercent(SAY_GOOD_PERCENT), "good", "しきい値ちょうど → 言えた");
  eq(ratingFromPercent(SAY_GOOD_PERCENT - 1), "hard", "しきい値の下 → 惜しい");
  eq(ratingFromPercent(SAY_HARD_PERCENT), "hard", "惜しいのしきい値ちょうど");
  eq(ratingFromPercent(SAY_HARD_PERCENT - 1), "again", "それ未満 → 言えなかった");
  eq(ratingFromPercent(100, true), "hard", "ヒントを見たら「言えた」にしない");
  eq(ratingFromPercent(10, true), "again", "ヒントを見ても、言えなければ「言えなかった」");
  // 採点: 別の言い方（alt）で言っても満点・アクセントや句読点の違いは数えない
  const s = scoreSpeechSentence(["tudo otimo obrigada"], ["Tudo ótimo, obrigado.", "Tudo ótimo, obrigada."]);
  eq(s.percent, 100, "alt の言い方（女性形）で言っても満点。アクセント・句読点は数えない");
  ok(scoreSpeechSentence(["bom dia"], ["Bom dia! Tudo bem?"]).percent < SAY_GOOD_PERCENT, "半分しか言えていなければ「言えた」にならない");
}

console.log("=== 文のカードの間隔（scheduler.review を文にも使う） ===");
{
  let c = review(newCard(TD), "good", TD);
  eq([c.intervalDays, c.due], [1, addDays(TD, 1)], "はじめて言えた → 翌日");
  c = review(c, "good", addDays(TD, 1));
  eq(c.intervalDays, 3, "2回目に言えた → 3日後");
  c = review(c, "good", addDays(TD, 4));
  ok(c.intervalDays >= CAN_SAY_DAYS, "3回続けて言えたら「言える文」（間隔7日以上）");
  const a = review(c, "again", addDays(TD, 12));
  eq([a.intervalDays, a.due], [0, addDays(TD, 12)], "言えなかった → その日のうちにもう一度");
  const held = review(card({ due: addDays(TD, 5), last: addDays(TD, -1), intervalDays: 6 }), "good", TD);
  eq(held.due, addDays(TD, 5), "期限前の「言えた」は間隔を変えない（追加練習で先送りしない）");
}

console.log("=== 保存データの読み込み（readSpeak / readUserPhrase） ===");
{
  eq(readSpeak(null), null, "object でなければ null");
  eq(readSpeak([]), null, "配列は null");
  eq(readSpeak({}), emptySpeak(), "空の object は空の記録");
  const raw = {
    cards: { u1l1p1: card(), bad: { ease: "x" }, "": card() },
    phrases: [
      { id: "my:1", ja: " こんにちは ", pt: "Olá!", from: "ai", createdAt: TD, note: "", alt: ["Oi!", "", 3] },
      { id: "my:1", ja: "重複", pt: "Dup" },
      { id: "u1l1p1", ja: "レッスンの ID は不可", pt: "x" },
      { id: "my:2", ja: "", pt: "空の和文" },
      { id: "my:3", ja: "出どころが変", pt: "Ok", from: "virus", createdAt: "nope", extra: 1 },
      "x",
    ],
    lessons: { u1l1: { step: 2, doneAt: null }, u1l2: { step: 1, doneAt: TD }, u1l3: { step: 99 }, u1l4: "x" },
    talks: [{ at: TD, id: "free:day", turns: 5, sec: 200 }, { at: "bad", id: "x", turns: 1, sec: 1 }, { at: TD, id: "", turns: 1, sec: 1 }],
    conversations: ["会話の中身は読まない"],
  };
  const d = readSpeak(raw);
  ok(!!d, "読める");
  if (d) {
    eq(Object.keys(d.cards), ["u1l1p1"], "壊れたカード・空の ID は落とす");
    eq(d.phrases.map((p) => p.id), ["my:1", "my:3"], "ID が my: でない・和文が空・重複の文は落とす");
    eq(d.phrases[0], { id: "my:1", ja: "こんにちは", pt: "Olá!", alt: ["Oi!"], createdAt: TD, from: "ai" }, "前後の空白を取り、空の note・alt は置かない");
    eq([d.phrases[1].from, d.phrases[1].createdAt], ["manual", "1970-01-01"], "知らない出どころ・壊れた日付は既定値に");
    ok(!("extra" in d.phrases[1]), "知らない項目は持ち込まない");
    eq(d.lessons, { u1l1: { step: 2, doneAt: null }, u1l2: { step: LESSON_STEPS, doneAt: TD }, u1l3: { step: LESSON_STEPS, doneAt: null } }, "終えたレッスンは全ステップ済み。ステップは上限で切る");
    eq(d.talks, [{ at: TD, id: "free:day", turns: 5, sec: 200 }], "日付・ID の無い会話の記録は落とす");
    ok(!JSON.stringify(d).includes("会話の中身"), "知らない最上位の項目（会話の中身）は持ち込まない");
  }
  eq(readUserPhrase({ id: "my:x", ja: "a".repeat(500), pt: "b" })?.ja.length, 200, "長すぎる文は 200 文字で切る");
  ok(samePhraseText("Vou, sim.", " vou,  sim ") && samePhraseText("Tudo bem?", "tudo bem") && samePhraseText("Oi!", "Oi"), "同じ文: 大文字と小文字・空白・文末の句読点の違いは同じとみなす");
  ok(!samePhraseText("Vou, sim.", "Vou sim.") && !samePhraseText("Eu vou.", "Eu fui."), "同じ文: 文の中の違いは別の文");
  ok(isMyPhraseId(newPhraseId()) && newPhraseId(1, 0.1) !== newPhraseId(2, 0.1), "新しい ID は my: で始まり、時刻で変わる");
  const many = { talks: Array.from({ length: TALK_LOG_MAX + 20 }, (_, i) => ({ at: addDays(TD, -i), id: "x", turns: 1, sec: i })) };
  const t = readSpeak(many)?.talks ?? [];
  eq([t.length, t[0].at], [TALK_LOG_MAX, TD], "会話の記録は新しい順に上限まで");
}

console.log("=== 統合インポート（mergeSpeak） ===");
{
  const L: SpeakExport = {
    cards: { a: card({ last: addDays(TD, -1), intervalDays: 3 }), b: card({ last: addDays(TD, -5), intervalDays: 8 }), onlyL: card() },
    phrases: [{ id: "my:1", ja: "端末", pt: "Local.", createdAt: TD, from: "manual" }],
    lessons: { u1l1: { step: LESSON_STEPS, doneAt: addDays(TD, -2) }, u1l2: { step: 1, doneAt: null }, u1l3: { step: 3, doneAt: null } },
    talks: [{ at: TD, id: "u1l1", turns: 4, sec: 100 }],
  };
  const R: SpeakExport = {
    cards: { a: card({ last: addDays(TD, -3), intervalDays: 9 }), b: card({ last: addDays(TD, -2), intervalDays: 1 }), onlyR: card() },
    phrases: [
      { id: "my:1", ja: "ファイル", pt: "Remote.", createdAt: TD, from: "ai" },
      { id: "my:2", ja: "別の文", pt: "Outra.", createdAt: TD, from: "talk" },
    ],
    lessons: { u1l1: { step: LESSON_STEPS, doneAt: addDays(TD, -7) }, u1l2: { step: LESSON_STEPS, doneAt: TD }, u1l3: { step: 2, doneAt: null }, u1l4: { step: 1, doneAt: null } },
    talks: [{ at: TD, id: "u1l1", turns: 4, sec: 100 }, { at: addDays(TD, -1), id: "free:day", turns: 2, sec: 50 }],
  };
  const m = mergeSpeak(L, R);
  ok(m.cards.a === L.cards.a && m.cards.b === R.cards.b, "カードは文ごとに、新しく学習した方");
  ok(m.cards.onlyL === L.cards.onlyL && m.cards.onlyR === R.cards.onlyR, "片方にだけある文のカードは残す");
  eq(m.phrases.map((p) => [p.id, p.pt]), [["my:1", "Local."], ["my:2", "Outra."]], "自分の文は両方を残す（同じ ID は端末の方）");
  eq(m.lessons.u1l1.doneAt, addDays(TD, -7), "レッスンを終えた日は早い方");
  eq(m.lessons.u1l2, { step: LESSON_STEPS, doneAt: TD }, "片方だけ終えていれば、終えた扱い");
  eq(m.lessons.u1l3, { step: 3, doneAt: null }, "途中のレッスンは進んでいる方のステップ");
  eq(m.lessons.u1l4, { step: 1, doneAt: null }, "ファイルにだけあるレッスンも残す");
  eq(m.talks.map((t) => t.id), ["u1l1", "free:day"], "会話の記録は両方（同じ記録は1つに・新しい順）");
  ok(mergeSpeak(L, null) === L, "ファイルに speak が無ければ端末のまま");
  // 同じ ID: あとで直した方（updatedAt）を残す。別の ID の同じ文は1つにまとめる
  const ph = (id: string, pt: string, updatedAt?: number): UserPhrase => ({ id, ja: "和文", pt, createdAt: TD, from: "manual", ...(updatedAt ? { updatedAt } : {}) });
  const eL: SpeakExport = { ...emptySpeak(), phrases: [ph("my:a", "Eu vim do Japão.", 100), ph("my:b", "Local novo.", 300), ph("my:c", "Sem data local.")], cards: { "my:same1": card({ last: addDays(TD, -5), intervalDays: 2 }) } };
  eL.phrases.push(ph("my:same1", "Tudo bem?", 50));
  const eR: SpeakExport = { ...emptySpeak(), phrases: [ph("my:a", "Eu sou do Japão.", 200), ph("my:b", "Remoto velho.", 100), ph("my:c", "Sem data remoto."), ph("my:same2", "tudo bem", 60), ph("my:new", "Só no arquivo.", 10)], cards: { "my:same2": card({ last: addDays(TD, -1), intervalDays: 9 }), "my:new": card() } };
  const em = mergeSpeak(eL, eR);
  eq(em.phrases.map((p) => [p.id, p.pt]), [["my:a", "Eu sou do Japão."], ["my:b", "Local novo."], ["my:c", "Sem data local."], ["my:same1", "Tudo bem?"], ["my:new", "Só no arquivo."]], "同じ ID は、あとで直した方の文（updatedAt が無ければ端末の方）。別の ID の同じ文は足さない");
  ok(em.cards["my:same1"] === eR.cards["my:same2"] && !("my:same2" in em.cards), "同じ文をまとめたとき、カードは新しく学習した方を残し、消した ID のカードは持たない");
  ok(em.cards["my:new"] === eR.cards["my:new"], "ファイルにだけある文のカードは残す");
  const back = mergeSpeak(eR, eL);
  eq([back.phrases.find((p) => p.id === "my:a")?.pt, back.phrases.find((p) => p.id === "my:b")?.pt], ["Eu sou do Japão.", "Local novo."], "逆向きに統合しても、直した文は同じ結果になる（2台で食い違わない）");
  eq(readUserPhrase({ id: "my:x", ja: "a", pt: "b", updatedAt: 123 })?.updatedAt, 123, "updatedAt を読む");
  ok(!("updatedAt" in (readUserPhrase({ id: "my:x", ja: "a", pt: "b", updatedAt: "x" }) ?? {})), "壊れた updatedAt は置かない");
}

console.log("=== バックアップの形式（speak・設定・学習ログの活動） ===");
{
  const speak: SpeakExport = {
    cards: { u1l1p1: card({ intervalDays: 9 }), "my:1": card() },
    phrases: [{ id: "my:1", ja: "テスト", pt: "Teste.", createdAt: TD, from: "talk" }],
    lessons: { u1l1: { step: LESSON_STEPS, doneAt: TD } },
    talks: [{ at: TD, id: "u1l1", turns: 3, sec: 90 }],
  };
  const progress = { cards: { "words:0001": card() }, streak: 1, bestStreak: 1, lastStudyDate: TD, totalReviews: 1, customPassages: [], pinnedNew: [], history: {} };
  const out = composeBackup({
    progress,
    music: { songs: {}, addedWords: [], userWords: [] },
    settings: { speakDailyLimit: 50, talkAutoSpeak: false, talkLevel: 2, speechInputEnabled: true },
    app: { version: "t", build: "t" },
    speak: { ...speak, conversations: ["x"], daily: { date: TD, dueReviewed: 3 } },
  });
  eq(out.speak, speak, "書き出し: speak は知っている項目だけで組み直す（今日のカウンタ・知らない項目は入れない）");
  eq(out.settings, { speakDailyLimit: 50, talkAutoSpeak: false, talkLevel: 2 }, "書き出し: 話す練習の設定は入る（音声認識の同意は入れない）");
  const r = parseBackup(JSON.stringify(out));
  ok(r.ok, "読める");
  if (r.ok) {
    eq(r.data.speak, speak, "読み込み: speak をそのまま読む");
    ok(describeBackup(r.data).includes("口慣らしの文 2文") && describeBackup(r.data).includes("レッスン 1課") && describeBackup(r.data).includes("自分のフレーズ 1文"), "取り込みの要約に、口慣らし・レッスン・自分のフレーズの数");
  }
  const old = parseBackup(JSON.stringify({ ...progress, version: 3 }));
  ok(old.ok && old.data.speak === null, "speak の無い古いファイルは null（端末の記録を消さない）");
  eq(pickSettings({ speakDailyLimit: 33, talkAutoSpeak: "yes", talkLevel: 9 }), {}, "話す練習の設定は、選択肢に無い値を読まない");
  eq(pickSettings({ speakDailyLimit: 100, talkAutoSpeak: true, talkLevel: -1 }), { speakDailyLimit: 100, talkAutoSpeak: true, talkLevel: -1 }, "選択肢にある値は読む");
  eq(readDayLog({ reviews: 1, act: { speak: { n: 12, sec: 300 }, lesson: { n: 1, sec: 600 }, talk: { n: 5, sec: 200 }, hack: { n: 1, sec: 1 } } })?.act, { speak: { n: 12, sec: 300 }, lesson: { n: 1, sec: 600 }, talk: { n: 5, sec: 200 } }, "学習ログ: speak・lesson・talk の活動を読む（知らない活動は落とす）");
}

console.log("=== 学習日（連続記録）に数える活動 ===");
{
  // 時間だけの記録（画面を開いていた秒数）は、話す練習では学習日に数えない。回数が 1 以上になったら数える
  for (const k of ["speak", "lesson", "talk"]) {
    ok(!countsAsStudy(k, { n: 0, sec: 600 }), `${k}: 時間だけ（n = 0）は学習日に数えない`);
    ok(countsAsStudy(k, { n: 1, sec: 0 }), `${k}: 回数が 1 以上なら数える`);
  }
  ok(countsAsStudy("listen", { n: 0, sec: 30 }) && countsAsStudy("pattern", { n: 1, sec: 0 }), "これまでの練習（listen・pattern など）は、回数か秒数があれば数える");
  ok(!countsAsStudy("music", { n: 0, sec: 179 }) && countsAsStudy("music", { n: 0, sec: 180 }), "音楽は 3 分以上");
  ok(!countsAsStudy("speak", undefined), "記録が無ければ数えない");
  ok(!isStudyDay({ reviews: 0, newWords: 0, again: 0, act: { lesson: { n: 0, sec: 40 }, talk: { n: 0, sec: 20 } } }), "レッスン・会話の画面を開いただけの日は学習日ではない");
  ok(isStudyDay({ reviews: 0, newWords: 0, again: 0, act: { lesson: { n: 0, sec: 40 }, speak: { n: 3, sec: 0 } } }), "文を声に出した日は学習日");
}

console.log("=== AI との会話: 場面・むずかしさ ===");
{
  const sc = lessonScenario(LESSONS[0]);
  eq([sc.id, sc.opener, sc.missions.length], ["u1l1", LESSONS[0].talk.opener, 3], "レッスンの場面");
  eq(sc.targets, LESSONS[0].phrases.map((p) => p.pt), "レッスンのフレーズが「練習した文」になる");
  ok(FREE_TOPICS.every((t) => t.id.startsWith("free:") && t.opener && t.missions.length === 3), "フリートークは最初のひとことと、ミッション3つを持つ");
  eq(new Set(FREE_TOPICS.map((t) => t.id)).size, FREE_TOPICS.length, "フリートークの ID は重複しない");
  const cu = customScenario("  美容院で\n髪を切ってもらう  ");
  eq([cu.id, cu.setting, cu.opener], ["custom", "美容院で 髪を切ってもらう", ""], "自分で書いた場面は空白を整え、最初のひとことは AI に任せる");
  eq(customScenario("あ".repeat(500)).setting.length, 200, "場面は 200 文字まで");
  eq([0, 5, 6, 11, 12, 23, 24, 36].map(defaultTalkLevel), [0, 0, 1, 1, 2, 2, 3, 3], "むずかしさは終えたレッスンの数から");
}

console.log("=== AI との会話: プロンプト ===");
{
  const sc = lessonScenario(LESSONS[3]);
  const sys = buildTalkSystem(sc, 0);
  ok(sys.includes(sc.role) && sc.missions.every((m, i) => sys.includes(`${i}: ${m}`)), "役と、番号つきのミッションが入る");
  ok(sys.includes(LESSONS[3].phrases[0].pt), "練習した文が入る");
  ok(sys.includes("入門") && !buildTalkSystem(sc, 3).includes("入門"), "むずかしさで話し方のきまりが変わる");
  ok(!buildTalkSystem(customScenario("x"), 1).includes("練習した文"), "練習した文の無い場面では、その見出しを出さない");
  const turns: TalkTurn[] = [
    { who: "ai", pt: "Bom dia! O que você vai querer?", ja: "" },
    { who: "me", text: "Um café,\npor favor.", feedback: null },
    { who: "ai", pt: "Mais alguma coisa?", ja: "" },
    { who: "me", text: "  Não,   obrigado.  " },
  ];
  const user = buildTalkUser(turns);
  ok(user.includes("あなた: Bom dia! O que você vai querer?") && user.includes("学習者: Um café, por favor."), "これまでの会話が、役の名前つきで1行ずつ入る");
  ok(user.trim().endsWith("# 学習者の今の発言\nNão, obrigado."), "最後の発言は「今の発言」として分け、空白を整える");
  ok(buildTalkUser([]).includes("最初のひとこと"), "会話が無ければ、始めてもらう");
  ok(buildTalkUser([turns[0]]).includes("まだ返事をしていません"), "相手の発言で終わっていれば、続きを頼む");
  const long: TalkTurn[] = Array.from({ length: 60 }, (_, i) => (i % 2 ? { who: "me", text: `m${i}` } : { who: "ai", pt: `a${i}`, ja: "" }));
  const lu = buildTalkUser(long);
  ok(!lu.includes("a0\n") && lu.includes("m59") && lu.split("\n").filter((l) => /^(あなた|学習者): /.test(l)).length === TALK_HISTORY_MAX - 1, "古い発言は省く（最後の 24 発言まで）");
  eq((TALK_SCHEMA.required as string[]).sort(), ["end", "feedback", "hints", "missions_done", "reply", "reply_ja"], "応答のスキーマの必須項目");
  ok(buildSayUser(" 辛くしないで\nください ", "レストラン").includes("言いたいこと（日本語）: 辛くしないで ください") && buildSayUser("x", "レストラン").includes("場面: レストラン"), "「なんて言う？」は言いたいことと場面を送る");
  ok(!buildSayUser("x").includes("場面"), "場面が無ければ送らない");
}

console.log("=== AI との会話: 応答の検査（parseTalkReply / parseHowToSay） ===");
{
  const good = {
    reply: " Tudo bem?\nE você? ",
    reply_ja: "元気？あなたは？",
    feedback: { ok: false, better: "Eu sou do Japão.", better_ja: "日本出身です。", note: "ser を使います" },
    hints: [{ pt: "Tudo bem.", ja: "元気です。" }, { pt: "", ja: "空" }, { pt: "E você?", ja: "あなたは？" }, { pt: "x", ja: "y" }, { pt: "多すぎ", ja: "" }],
    missions_done: [2, 0, 0, 7, -1, "1", 1.5],
    end: false,
  };
  const r = parseTalkReply(good, 3);
  eq(r.reply, "Tudo bem? E você?", "返事の空白・改行を整える");
  eq(r.feedback, { ok: false, better: "Eu sou do Japão.", ja: "日本出身です。", note: "ser を使います" }, "フィードバック（直す文・訳・理由）");
  eq(r.hints.map((h) => h.pt), ["Tudo bem.", "E você?", "x"], "ヒントは空のものを除いて3つまで");
  eq(r.missionsDone, [0, 2], "ミッションは範囲内の整数だけ・重複なし・昇順");
  eq(r.end, false, "end");
  eq(parseTalkReply({ ...good, feedback: { ok: true, better: "余計な文", better_ja: "x", note: "y" } }, 3).feedback, { ok: true, better: "", ja: "", note: "" }, "自然なら、直す文は空にする");
  eq(parseTalkReply({ ...good, feedback: { ok: false, better: "" } }, 3).feedback?.ok, true, "直す文が無いのに ok=false なら、自然とみなす（誤りとして見せない）");
  eq(parseTalkReply({ ...good, feedback: "x" }, 3).feedback?.ok, true, "フィードバックの形が崩れていれば、自然とみなす");
  eq(parseTalkReply(good, 3, false).feedback, null, "会話の始まり（学習者の発言なし）はフィードバックなし");
  eq(parseTalkReply({ reply: "Oi!", end: "true" }, 3), { reply: "Oi!", replyJa: "", feedback: { ok: true, better: "", ja: "", note: "" }, hints: [], missionsDone: [], end: false }, "足りない項目は空で補う（end は true のときだけ）");
  let err: unknown = null;
  try {
    parseTalkReply({ reply: "  " }, 3);
  } catch (e) {
    err = e;
  }
  ok(err instanceof AiError && err.kind === "bad-response", "返事が空なら AiError（bad-response）");
  for (const bad of [null, "x", [], 3]) {
    let e2: unknown = null;
    try {
      parseTalkReply(bad, 3);
    } catch (e) {
      e2 = e;
    }
    ok(e2 instanceof AiError, `object でない応答（${JSON.stringify(bad)}）は AiError`);
  }
  eq(parseHowToSay({ pt: " Sem pimenta, por favor. ", alt: ["Sem pimenta, por favor.", "Não quero pimenta.", "", "a", "b"], note: "店で使う" }), { pt: "Sem pimenta, por favor.", alt: ["Não quero pimenta.", "a"], note: "店で使う" }, "「なんて言う？」: pt と同じ・空の alt を除いて2つまで");
  eq(parseHowToSay({ pt: "Oi" }), { pt: "Oi", alt: [], note: "" }, "足りない項目は空で補う");
  let e3: unknown = null;
  try {
    parseHowToSay({ alt: ["x"] });
  } catch (e) {
    e3 = e;
  }
  ok(e3 instanceof AiError && e3.kind === "bad-response", "pt が無ければ AiError");
}

console.log("=== AI との会話: 呼び出し（偽のサービス・通信しない） ===");
{
  // fetch を止めて、通信しないことも確かめる
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (() => {
    fetched++;
    throw new Error("通信してはいけない");
  }) as typeof fetch;
  try {
    const calls: GenerateJsonOptions[] = [];
    const fake = (json: unknown, extra: Partial<GenerateJsonResult> = {}) => ({
      generateJson: async (o: GenerateJsonOptions): Promise<GenerateJsonResult> => {
        calls.push(o);
        return { json, model: "fake-model", ...extra };
      },
    });
    const sc = lessonScenario(LESSONS[0]);
    const turns: TalkTurn[] = [{ who: "ai", pt: sc.opener, ja: "" }, { who: "me", text: "Bom dia! Tudo bem?" }];
    const r = await requestTalkReply(
      fake({ reply: "Tudo ótimo! E você?", reply_ja: "元気！あなたは？", feedback: { ok: true, better: "", better_ja: "", note: "" }, hints: [], missions_done: [0], end: false }, { fallbackFrom: "big-model" }),
      sc,
      1,
      turns
    );
    eq([r.reply, r.model, r.fallbackFrom, r.missionsDone], ["Tudo ótimo! E você?", "fake-model", "big-model", [0]], "返事・答えたモデル・達成したミッション");
    eq(r.feedback?.ok, true, "学習者の発言へのフィードバックが返る");
    ok(calls[0].schema === TALK_SCHEMA && calls[0].system.includes(sc.role) && calls[0].user.endsWith("Bom dia! Tudo bem?"), "システムプロンプト・会話・スキーマを渡す");
    const first = await requestTalkReply(fake({ reply: "Oi!", feedback: { ok: false, better: "x", better_ja: "y", note: "z" } }), customScenario("店"), 0, []);
    eq(first.feedback, null, "会話の始まりでは、フィードバックを付けない");
    const ctrl = new AbortController();
    await requestTalkReply(fake({ reply: "Oi!" }), sc, 0, turns, ctrl.signal);
    ok(calls[calls.length - 1].signal === ctrl.signal, "中止の合図をサービスに渡す");
    let thrown: unknown = null;
    try {
      await requestTalkReply({ generateJson: async () => Promise.reject(new AiError("rate-limit", "上限です")) }, sc, 0, turns);
    } catch (e) {
      thrown = e;
    }
    ok(thrown instanceof AiError && thrown.kind === "rate-limit", "サービスのエラーはそのまま投げる（自動では頼み直さない）");
    const say = await requestHowToSay(fake({ pt: "Sem cebola, por favor.", alt: [], note: "" }), "玉ねぎ抜きで", "レストラン");
    eq(say.pt, "Sem cebola, por favor.", "「なんて言う？」の返事");
    ok(calls[calls.length - 1].user.includes("玉ねぎ抜きで") && calls[calls.length - 1].user.includes("レストラン"), "言いたいことと場面を送る");
    eq(fetched, 0, "通信していない");
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ---------------------------------------------------------------------------
// ここからストアの結合テスト。Node には localStorage が無いのでメモリ実装を差し込んでから読み込む。
const mem = new Map<string, string>();
const memStorage = {
  get length() {
    return mem.size;
  },
  key: (i: number) => [...mem.keys()][i] ?? null,
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
Object.defineProperty(globalThis, "localStorage", { value: memStorage, configurable: true, writable: true });

console.log("=== useSpeak（文のカード・自分の文・レッスン・会話の記録） ===");
{
  const { useSpeak, applySpeakRating, speakDailyToday } = await import("../src/store/useSpeak");
  const S = () => useSpeak.getState();
  const today = todayStr();

  // 純関数: 期限の来た文を今日はじめて評価したときだけ、1日の上限に数える
  const base = { cards: { due: card({ due: today, last: addDays(today, -1) }), early: card({ due: addDays(today, 3), last: addDays(today, -1) }) }, daily: { date: today, dueReviewed: 0 } };
  eq(applySpeakRating(base, "due", "good", today).daily.dueReviewed, 1, "期限の来た文の評価は上限に数える");
  eq(applySpeakRating(base, "early", "good", today).daily.dueReviewed, 0, "期限前の文は数えない");
  eq(applySpeakRating(base, "new", "good", today).daily.dueReviewed, 0, "新しい文は数えない");
  ok(applySpeakRating(base, "early", "good", today).cards === base.cards, "期限前の「言えた」はカードを変えない");
  const twice = applySpeakRating(applySpeakRating(base, "due", "again", today), "due", "good", today);
  eq(twice.daily.dueReviewed, 1, "同じ日の言い直しは二重に数えない");
  eq(twice.cards.due.due, addDays(today, 1), "言えなかった → 言い直して言えた → 翌日");
  eq(applySpeakRating({ ...base, daily: { date: addDays(today, -1), dueReviewed: 9 } }, "due", "good", today).daily, { date: today, dueReviewed: 1 }, "日付が変わったらカウンタを数え直す");
  eq(speakDailyToday({ date: addDays(today, -1), dueReviewed: 9 }, today).dueReviewed, 0, "前日のカウンタは 0 扱い");

  S().rate("u1l1p1", "good");
  eq([S().cards.u1l1p1.intervalDays, S().cards.u1l1p1.last], [1, today], "rate: カードが無ければ作って評価する");
  const prev = S().cards.u1l1p1;
  const prevDaily = S().daily;
  S().rate("u1l1p1", "again");
  eq(S().cards.u1l1p1.intervalDays, 0, "言えなかった → 間隔 0");
  S().restoreCard("u1l1p1", prev, prevDaily);
  ok(S().cards.u1l1p1 === prev, "restoreCard: 取り消しで元のカードに戻る");
  S().rate("u1l1p2", "hard");
  S().restoreCard("u1l1p2", undefined, prevDaily);
  ok(!("u1l1p2" in S().cards), "restoreCard: はじめての評価の取り消しはカードを消す");

  S().ensureCards(["u1l1p1", "u1l1p3", "u1l1p4", ""]);
  ok(S().cards.u1l1p1 === prev && S().cards.u1l1p3.last === null && S().cards.u1l1p3.due === today, "ensureCards: 無い文にだけ、今日が期限のカードを作る");
  ok(!("" in S().cards), "ensureCards: 空の ID は作らない");

  const id = S().addPhrase({ ja: " 日本ではITの仕事をしていました ", pt: "No Japão eu trabalhava com tecnologia.", note: "過去の習慣", from: "ai" });
  ok(!!id && isMyPhraseId(id ?? ""), "addPhrase: ID を返す");
  eq(S().phrases[0]?.ja, "日本ではITの仕事をしていました", "addPhrase: 空白を整えて先頭に足す");
  ok(!!id && S().cards[id]?.due === today && S().cards[id]?.last === null, "addPhrase: 足した文は今日から口慣らしに出る");
  eq(S().addPhrase({ ja: "別の和文でも", pt: "no japão eu trabalhava com tecnologia", from: "talk" }), id, "addPhrase: 同じポルトガル語の文は足さず、その文の ID を返す");
  eq(S().phrases.length, 1, "addPhrase: 同じ文は1つだけ");
  eq(S().addPhrase({ ja: "", pt: "x", from: "manual" }), null, "addPhrase: 和文が空なら足さない");
  eq(S().addPhrase({ ja: "x", pt: "  ", from: "manual" }), null, "addPhrase: ポルトガル語が空なら足さない");
  if (id) {
    S().updatePhrase(id, { pt: "No Japão eu trabalhava com TI." });
    eq(S().phrases[0].pt, "No Japão eu trabalhava com TI.", "updatePhrase: 文を直す");
    const stamped = S().phrases[0].updatedAt ?? 0;
    ok(stamped > 0, "addPhrase / updatePhrase: 直した時刻（updatedAt）を持つ");
    const before = S().phrases;
    S().updatePhrase(id, { pt: "No Japão eu trabalhava com TI." });
    ok(S().phrases === before, "updatePhrase: 変わっていなければ何もしない（直した時刻を進めない）");
    S().updatePhrase(id, { pt: "" });
    eq(S().phrases[0].pt, "No Japão eu trabalhava com TI.", "updatePhrase: 空にする変更は無視する");
    const c = buildCatalog(S().phrases);
    ok(dueItems(S().cards, c, today).some((i) => i.id === id), "足した文が今日の口慣らしに出る");
  }

  S().setLessonStep("u1l1", 2);
  eq(S().lessons.u1l1, { step: 2, doneAt: null }, "setLessonStep: 進んだステップを覚える");
  S().setLessonStep("u1l1", 1);
  eq(S().lessons.u1l1.step, 2, "setLessonStep: 戻さない");
  S().setLessonStep("u1l1", 99);
  eq(S().lessons.u1l1.step, LESSON_STEPS, "setLessonStep: 上限で切る");
  S().completeLesson("u1l1");
  eq(S().lessons.u1l1, { step: LESSON_STEPS, doneAt: today }, "completeLesson: 終えた日を記録する");
  const snap = S().lessons;
  S().completeLesson("u1l1");
  S().setLessonStep("u1l1", 0);
  ok(S().lessons === snap, "終えたレッスンは、もう一度終えても・復習しても記録を変えない");

  S().logTalk({ id: "u1l1", turns: 4, sec: 120 });
  eq(S().talks[0], { id: "u1l1", turns: 4, sec: 120, at: today }, "logTalk: 日付を付けて先頭に足す（会話の中身は持たない）");
  for (let i = 0; i < TALK_LOG_MAX + 5; i++) S().logTalk({ id: "x", turns: 1, sec: i });
  eq(S().talks.length, TALK_LOG_MAX, "logTalk: 上限まで");

  // 保存データを読み直す（壊れた項目は落とし、知っている項目は残る）
  const saved = JSON.parse(mem.get("bp-speak-v1") ?? "{}") as { state: Record<string, unknown>; version: number };
  eq(saved.version, 0, "保存データの version");
  ok(Object.keys(saved.state.cards as object).includes("u1l1p1") && (saved.state.phrases as unknown[]).length === 1, "bp-speak-v1 に保存される");
  mem.set("bp-speak-v1", JSON.stringify({ state: { ...saved.state, cards: { ...(saved.state.cards as object), broken: { ease: "x" } }, daily: "x", future: 1 }, version: 7 }));
  await useSpeak.persist.rehydrate();
  ok(!("broken" in S().cards) && "u1l1p1" in S().cards, "読み直し: 壊れたカードは落とす");
  eq(S().daily, { date: today, dueReviewed: 0 }, "読み直し: 壊れた今日のカウンタは作り直す");
  ok((S() as unknown as Record<string, unknown>).future === 1, "読み直し: 将来の版のデータ（知らない項目）は捨てない");

  // 進捗のリセット: 文のカード・レッスン・会話の記録を消す。自分で足した文は残す（今日が期限の新しいカードに戻す）
  S().reset();
  eq([Object.keys(S().lessons).length, S().talks.length], [0, 0], "reset: レッスンの進み具合・会話の記録を消す");
  eq(S().phrases.length, 1, "reset: 自分で足した文は残す");
  eq(Object.keys(S().cards), S().phrases.map((p) => p.id), "reset: レッスンの文のカードは消し、自分の文は新しいカードに戻す");
}

console.log("=== バックアップ（ストア）: 書き出し・置き換え・統合・リセット ===");
{
  const { exportAll, importAll, resetAllProgress } = await import("../src/store/backup");
  const { useSpeak } = await import("../src/store/useSpeak");
  const { useProgress } = await import("../src/store/useProgress");
  const { useSettings } = await import("../src/store/useSettings");
  const S = () => useSpeak.getState();
  const today = todayStr();

  resetAllProgress();
  for (const p of [...S().phrases]) S().removePhrase(p.id);
  eq([S().phrases.length, Object.keys(S().cards).length], [0, 0], "前提: 空にする（removePhrase は文とカードを消す）");
  S().rate("u1l1p1", "good");
  S().completeLesson("u1l1");
  const mine = S().addPhrase({ ja: "テスト", pt: "Teste.", from: "talk" });
  S().logTalk({ id: "u1l1", turns: 3, sec: 60 });
  // 画面を開いていた時間だけの記録では、学習日（連続記録）にならない
  useProgress.setState({ lastStudyDate: null, streak: 0 });
  useProgress.getState().logActivity("lesson", 0, 5);
  useProgress.getState().logActivity("talk", 0, 5);
  useProgress.getState().logActivity("speak", 0, 5);
  eq(useProgress.getState().lastStudyDate, null, "レッスン・会話・口慣らしの画面を開いただけ（時間だけの記録）では学習日にならない");
  useProgress.getState().logActivity("speak", 7, 120);
  useProgress.getState().logActivity("lesson", 1, 600);
  useProgress.getState().logActivity("talk", 3, 60);
  useSettings.getState().set({ speakDailyLimit: 50, talkAutoSpeak: false, talkLevel: 1 });

  const json = exportAll();
  const parsed = JSON.parse(json) as { speak: SpeakExport; settings: Record<string, unknown>; history: Record<string, { act: Record<string, { n: number }> }> };
  ok(!!parsed.speak.cards.u1l1p1 && parsed.speak.lessons.u1l1.doneAt === today && parsed.speak.phrases.length === 1 && parsed.speak.talks.length === 1, "書き出し: 文のカード・レッスン・自分の文・会話の記録が入る");
  ok(!("daily" in parsed.speak), "書き出し: 今日のカウンタは入れない");
  eq([parsed.settings.speakDailyLimit, parsed.settings.talkAutoSpeak, parsed.settings.talkLevel], [50, false, 1], "書き出し: 話す練習の設定が入る");
  eq(parsed.history[today].act.speak.n, 7, "書き出し: 学習ログに声に出した回数が入る");
  ok(useProgress.getState().lastStudyDate === today, "話す練習をした日は学習日（連続記録）に数える");

  // 置き換え
  S().rate("u1l1p2", "good");
  S().completeLesson("u1l2");
  useSettings.getState().set({ speakDailyLimit: 20 });
  ok(importAll(json, "replace").ok, "置き換えで取り込む");
  ok(!("u1l1p2" in S().cards) && !("u1l2" in S().lessons), "置き換え: ファイルに無い記録は消える");
  eq(useSettings.getState().speakDailyLimit, 50, "置き換え: 設定もファイルの値になる");

  // 統合
  S().rate("u1l1p2", "good");
  S().completeLesson("u1l2");
  const other = S().addPhrase({ ja: "端末だけの文", pt: "Só aqui.", from: "manual" });
  useSettings.getState().set({ speakDailyLimit: 20 });
  ok(importAll(json, "merge").ok, "統合で取り込む");
  ok("u1l1p1" in S().cards && "u1l1p2" in S().cards && !!S().lessons.u1l1 && !!S().lessons.u1l2, "統合: 両方の記録が残る");
  eq(S().phrases.map((p) => p.id).sort(), [mine, other].sort(), "統合: 自分の文は両方が残る（同じ文は1つ）");
  eq(useSettings.getState().speakDailyLimit, 20, "統合: 設定は端末のまま");

  // speak の無い古いファイルを取り込んでも、端末の記録を消さない
  const old = JSON.parse(json) as Record<string, unknown>;
  delete old.speak;
  ok(importAll(JSON.stringify(old), "replace").ok, "speak の無いファイルを置き換えで取り込む");
  ok("u1l1p2" in S().cards && S().phrases.length === 2, "古いファイルの置き換えでは、話す練習の記録は端末のまま");

  resetAllProgress();
  eq([Object.keys(S().lessons).length, S().talks.length, S().phrases.length], [0, 0, 2], "進捗のリセット: レッスン・会話の記録を消し、自分で足した文は残す");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
