// ============================================================================
// SRS スケジューラ・学習キュー・進捗ストア（と曲の単語の記録）の回帰テスト
//   npm run check:srs
// 基準日 T=2026-09-24 の固定データで検証する（実行日に左右されない）。
// ストアの操作（rate/undo/rateQuiz など）だけは実行日の todayStr() を使う。
// 1件でも失敗したら終了コード1。
// ============================================================================

import type { Rating, SrsCard, Word } from "../src/data/types";
import {
  addDays,
  daysUntilDue,
  displayLevel,
  isHeld,
  isKnownForLyrics,
  levelFor,
  previewInterval,
  quizDecision,
  review,
  todayStr,
} from "../src/srs/scheduler";
import {
  PROD_MIN_INTERVAL,
  REVIEWS_PER_NEW,
  SAME_WORD_GAP,
  buildSession,
  countDueOn,
  dueWords,
  forecast,
  glossRevealsAnswer,
  interleave,
  isProdEligible,
  masteryBreakdown,
  orderNew,
  pickForQuiz,
  prodCandidates,
  prodMastery,
  relativeOverdue,
  seededShuffle,
  separateSameWord,
  spreadCategories,
  spreadEvenly,
  WEAK_EASE,
  WEAK_MIN,
  weakWords,
} from "../src/srs/queue";
import {
  PROD_SUFFIX,
  baseOfKey,
  canHaveProd,
  cardKey,
  isProdKey,
  prodItem,
  prodKey,
  recogItem,
  toStudyItem,
  type StudyItem,
} from "../src/srs/cardKey";
import { ALIAS_IDS, ALIAS_KEEP, siblingKey } from "../src/data/siblings";
import {
  askableByJa,
  choiceKey,
  distractorTier,
  exclusionLevel,
  isProperNoun,
  pickDistractors,
  posClass,
  quizPieces,
} from "../src/services/quizChoices";
import capoeiraRaw from "../data/capoeira-words.json";
import irregularRaw from "../data/verb-irregular.json";
import colloquialRaw from "../data/colloquial.json";
import { createLemmatizer, tokenize, type ColloquialTable, type LexRef } from "../src/services/lemmatize";
import type { IrregularTable } from "../src/services/conjugate";
import {
  addTargetId,
  buildVocabItems,
  bulkAddCandidates,
  deckLabel,
  levelLabel,
  siblingCard,
  siblingNote,
  statusId,
  studiedId,
  type VocabItem,
} from "../src/services/songVocab";
import { clockRun, clockTake, elapsedSec, newClock } from "../src/services/activityClock";
import {
  DEFAULT_HANDSFREE_GAP_SEC,
  HANDSFREE_GAPS_SEC,
  JA_SHOW_MS,
  NEXT_WORD_MS,
  REPEAT_PAUSE_MS,
  answerShown,
  estimateSec,
  handsfreeDirection,
  handsfreeGapMs,
  handsfreeSteps,
  jaForSpeech,
  markedFirst,
  runHandsfree,
  type HandsfreeConfig,
  type HandsfreeIO,
  type HandsfreeStep,
} from "../src/services/handsfree";
import {
  GAP_MAX_MS,
  GAP_MIN_MS,
  GAP_MODES,
  gapDelayMs,
  gapFactor,
  gapMode,
  lookupResumeLine,
  perLineStop,
  repeatGapMs,
  selfTranslatedCount,
} from "../src/services/musicPractice";
import { lineHash } from "../src/services/lyrics";
import {
  AGAIN_GAP,
  INTRO_GAP,
  MAX_REQUEUE,
  againItems,
  currentItem,
  initSession,
  isDone,
  sessionStats,
  step,
  testDirection,
  type SessionState,
} from "../src/srs/session";

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

const T = "2026-09-24";
const D = (n: number) => addDays(T, n);
/** ease の浮動小数点誤差を丸めて比較する */
const norm = (c: SrsCard | undefined): SrsCard | undefined => c && { ...c, ease: Math.round(c.ease * 1000) / 1000 };
function card(p: Partial<SrsCard>): SrsCard {
  return { ease: 2.5, intervalDays: 0, due: T, reps: 0, lapses: 0, level: "new", last: null, ...p };
}
/** 期待値（level は levelFor から導く。しきい値の検証は下の levelFor 節で別に行う） */
function exp(p: { ease: number; intervalDays: number; due: string; reps: number; lapses: number }): SrsCard {
  return {
    ease: p.ease,
    intervalDays: p.intervalDays,
    reps: p.reps,
    lapses: p.lapses,
    level: levelFor(p.intervalDays, p.reps),
    due: p.due,
    last: T,
  };
}
function row(label: string, input: SrsCard, r: Rating, expected: SrsCard) {
  const before = JSON.stringify(input);
  eq(norm(review(input, r, T)), norm(expected), `${label} ${r}`);
  eq(JSON.stringify(input), before, `${label} ${r}: 入力を変更しない`);
}
function held(label: string, input: SrsCard, r: Rating) {
  const before = JSON.stringify(input);
  const out = review(input, r, T);
  ok(out === input, `${label} ${r}: 据え置き（同じオブジェクト）`);
  eq(JSON.stringify(out), before, `${label} ${r}: 入力と同一`);
  ok(isHeld(input, r, T), `${label} ${r}: isHeld=true`);
}

// ---------------------------------------------------------------------------
console.log("=== review() 真理値表（§2a） ===");
const NEW = card({});
row("A1 新規", NEW, "again", exp({ ease: 2.5, intervalDays: 0, due: T, reps: 0, lapses: 0 }));
eq(review(NEW, "again", T).level, "learning", "A1 新規 again: level=learning");
row("A2 新規", NEW, "hard", exp({ ease: 2.5, intervalDays: 1, due: D(1), reps: 1, lapses: 0 }));
row("A3 新規", NEW, "good", exp({ ease: 2.5, intervalDays: 1, due: D(1), reps: 1, lapses: 0 }));
row("A4 新規", NEW, "easy", exp({ ease: 2.5, intervalDays: 4, due: "2026-09-28", reps: 1, lapses: 0 }));

const RELEARN = review(NEW, "again", T); // A1 の結果（i0 r0 last=T）
row("B1 再学習中", RELEARN, "again", exp({ ease: 2.5, intervalDays: 0, due: T, reps: 0, lapses: 0 }));
row("B2 再学習中", RELEARN, "good", exp({ ease: 2.5, intervalDays: 1, due: "2026-09-25", reps: 1, lapses: 0 }));
ok(!isHeld(RELEARN, "good", T), "B2 再学習中 good: 据え置きにならない（i=0）");

const DUE = card({ ease: 2.5, intervalDays: 10, reps: 3, lapses: 0, level: "young", last: "2026-09-14", due: T });
row("C1 期限到来", DUE, "again", exp({ ease: 2.3, intervalDays: 0, due: T, reps: 0, lapses: 1 }));
row("C2 期限到来", DUE, "hard", exp({ ease: 2.35, intervalDays: 12, due: "2026-10-06", reps: 4, lapses: 0 }));
row("C3 期限到来", DUE, "good", exp({ ease: 2.5, intervalDays: 25, due: "2026-10-19", reps: 4, lapses: 0 }));
row("C4 期限到来", DUE, "easy", exp({ ease: 2.65, intervalDays: 34, due: "2026-10-28", reps: 4, lapses: 0 }));

const EARLY = card({ ease: 2.5, intervalDays: 10, reps: 3, lapses: 0, level: "young", last: "2026-09-22", due: "2026-10-02" });
for (const r of ["hard", "good", "easy"] as const) held("D1 期限前", EARLY, r);
row("D2 期限前", EARLY, "again", exp({ ease: 2.3, intervalDays: 0, due: T, reps: 0, lapses: 1 }));
ok(!isHeld(EARLY, "again", T), "D2 期限前 again: isHeld=false");

const PASSED = review(NEW, "good", T); // A3 の結果（i1 r1 last=T due=09-25）
for (const r of ["hard", "good", "easy"] as const) held("E1 今日合格", PASSED, r);
row("E2 今日合格", PASSED, "again", exp({ ease: 2.5, intervalDays: 0, due: T, reps: 0, lapses: 0 }));

const OVERDUE = card({ ease: 2.5, intervalDays: 10, reps: 3, lapses: 0, level: "young", last: "2026-08-25", due: "2026-09-04" });
row("F1 延滞", OVERDUE, "good", exp({ ease: 2.5, intervalDays: 25, due: "2026-10-19", reps: 4, lapses: 0 }));

const FAILED_YDAY = card({ ease: 2.3, intervalDays: 0, reps: 0, lapses: 1, level: "learning", last: "2026-09-23", due: "2026-09-23" });
row("G1 昨日失敗", FAILED_YDAY, "again", exp({ ease: 2.3, intervalDays: 0, due: T, reps: 0, lapses: 1 }));
row("G2 昨日失敗", FAILED_YDAY, "good", exp({ ease: 2.3, intervalDays: 1, due: "2026-09-25", reps: 1, lapses: 1 }));

const ADDED = card({ last: null, due: "2026-09-20", reps: 0 });
row("H1 曲から追加", ADDED, "good", exp({ ease: 2.5, intervalDays: 1, due: "2026-09-25", reps: 1, lapses: 0 }));
ok(!isHeld(ADDED, "good", T), "H1 曲から追加 good: 据え置きにならない（last=null）");

const FLOOR = card({ ease: 1.3, intervalDays: 5, reps: 2, lapses: 3, level: "young", last: "2026-09-19", due: T });
row("I1 下限", FLOOR, "again", exp({ ease: 1.3, intervalDays: 0, due: T, reps: 0, lapses: 4 }));
row("I2 下限", FLOOR, "hard", exp({ ease: 1.3, intervalDays: 6, due: "2026-09-30", reps: 3, lapses: 3 }));

const MATURE_TODAY = card({ ease: 2.5, intervalDays: 25, reps: 4, lapses: 0, level: "mature", last: T, due: "2026-10-19" });
row("J1 今日評価済みの成熟", MATURE_TODAY, "again", exp({ ease: 2.5, intervalDays: 0, due: T, reps: 0, lapses: 0 }));

const K = card({ ease: 2.5, intervalDays: 1, reps: 1, lapses: 0, level: "young", last: "2026-09-23", due: T });
row("K1", K, "good", exp({ ease: 2.5, intervalDays: 3, due: "2026-09-27", reps: 2, lapses: 0 }));
row("K2 hard 新規の次", K, "easy", exp({ ease: 2.65, intervalDays: 4, due: "2026-09-28", reps: 2, lapses: 0 }));

// 新規で easy（4日）にした語が期限を迎えたとき。good が4日より縮まず、hard > good にならない
const EASY_NEXT = card({ ease: 2.5, intervalDays: 4, reps: 1, lapses: 0, level: "learning", last: D(-4), due: T });
row("L1 easy 新規の次", EASY_NEXT, "hard", exp({ ease: 2.35, intervalDays: 5, due: D(5), reps: 2, lapses: 0 }));
row("L2 easy 新規の次", EASY_NEXT, "good", exp({ ease: 2.5, intervalDays: 10, due: D(10), reps: 2, lapses: 0 }));
row("L3 easy 新規の次", EASY_NEXT, "easy", exp({ ease: 2.65, intervalDays: 14, due: D(14), reps: 2, lapses: 0 }));

// 性質: 期限到来（据え置きでない）の reps≥1 のカードで hard ≤ good < easy、good ≥ 今の間隔
console.log("=== 評価ごとの間隔の順序 ===");
{
  let bad = 0;
  let n = 0;
  for (const reps of [1, 2, 3, 6]) {
    for (let i = 1; i <= 60; i++) {
      for (let e10 = 13; e10 <= 30; e10++) {
        const ease = e10 / 10;
        const c = card({ ease, intervalDays: i, reps, last: D(-i), due: T });
        const [h, g, x] = (["hard", "good", "easy"] as const).map((r) => review(c, r, T).intervalDays);
        n++;
        if (!(h <= g && g < x && g >= i)) {
          if (bad++ < 5) console.error(`  ✗ reps=${reps} i=${i} ease=${ease}: hard=${h} good=${g} easy=${x}`);
        }
      }
    }
  }
  eq(bad, 0, `hard ≤ good < easy かつ good ≥ 間隔（${n}通り）`);
}

// ease の範囲（下限 1.3・上限 3.0）
console.log("=== ease の範囲 ===");
{
  let c = card({ ease: 1.4, intervalDays: 10, reps: 3, last: "2026-09-10", due: "2026-09-20" });
  let min = c.ease;
  // 前日以前の合格カードを何度も落とす → 1.3 を下回らない
  for (let i = 0; i < 20; i++) {
    const day = addDays(T, i * 2);
    c = review(c, "again", day); // 罰あり（reps≥1 かつ前日以前）
    min = Math.min(min, c.ease);
    c = review(c, "good", addDays(day, 1)); // 翌日に合格し直す（reps=1）
    min = Math.min(min, c.ease);
  }
  ok(min >= 1.3, `again を繰り返しても ease≥1.3（最小 ${min}）`);
  eq(norm(c)?.ease, 1.3, "繰り返し後は下限 1.3 に張り付く");
  const high = card({ ease: 2.95, intervalDays: 10, reps: 3, last: "2026-09-14", due: T });
  eq(review(high, "easy", T).ease, 3.0, "easy でも ease≤3.0");
}

// isHeld の分岐 (b)（同じ日・間隔>0）単体
console.log("=== isHeld ===");
ok(isHeld(card({ last: T, intervalDays: 3, reps: 2, due: T }), "good", T), "(b) 同じ日・i>0 は due≤T でも据え置き");
ok(!isHeld(card({ last: T, intervalDays: 0, reps: 0, due: T }), "good", T), "同じ日でも i=0（再学習中）は進める");
ok(!isHeld(DUE, "good", T), "期限到来は据え置かない");
ok(!isHeld(OVERDUE, "easy", T), "延滞は据え置かない");
ok(!isHeld(K, "good", T), "昨日評価・今日期限は据え置かない");
for (const c of [EARLY, PASSED, MATURE_TODAY]) ok(!isHeld(c, "again", T), `again は常に据え置かない（due=${c.due}）`);

// ---------------------------------------------------------------------------
console.log("=== previewInterval ===");
eq(previewInterval(NEW, "again", T), "このあと", "A1 新規 again → このあと");
eq(previewInterval(NEW, "good", T), "1日", "A3 新規 good → 1日");
eq(previewInterval(NEW, "easy", T), "4日", "A4 新規 easy → 4日");
eq(previewInterval(EARLY, "good", T), "据え置き", "D1 期限前 good → 据え置き");
eq(previewInterval(EARLY, "easy", T), "据え置き", "D1 期限前 easy → 据え置き");
eq(previewInterval(EARLY, "again", T), "このあと", "D2 期限前 again → このあと");
eq(previewInterval(PASSED, "hard", T), "据え置き", "E1 今日合格 hard → 据え置き");
eq(previewInterval(PASSED, "again", T), "このあと", "E2 今日合格 again → このあと");
eq(previewInterval(DUE, "good", T), "25日", "C3 期限到来 good → 25日");
eq(previewInterval(DUE, "easy", T), "1ヶ月", "C4 期限到来 easy(34日) → 1ヶ月");
eq(
  (["hard", "good", "easy"] as const).map((r) => previewInterval(EASY_NEXT, r, T)),
  ["5日", "10日", "14日"],
  "L 新規 easy の次 → あいまい5日 / 普通10日 / 簡単14日"
);

console.log("=== daysUntilDue ===");
eq(daysUntilDue(EARLY, T), 8, "期限前（10-02）→ 8");
eq(daysUntilDue(DUE, T), 0, "期限当日 → 0");
eq(daysUntilDue(OVERDUE, T), -20, "延滞（09-04）→ -20");
eq(daysUntilDue(card({ due: "2026-10-05" }), "2026-09-28"), 7, "月をまたぐ");

// ---------------------------------------------------------------------------
// しきい値（B1-08）: reps0 または i<7 は learning、7〜20 は young、21 以上は mature
console.log("=== levelFor ===");
eq(levelFor(0, 0), "learning", "(0,0) → learning");
eq(levelFor(0, 3), "learning", "(0,3) → learning");
eq(levelFor(5, 0), "learning", "(5,0) reps0 → learning");
eq(levelFor(30, 0), "learning", "(30,0) reps0 → learning");
eq(levelFor(1, 1), "learning", "(1,1) 1日後に出るだけ → learning");
eq(levelFor(3, 2), "learning", "(3,2) → learning");
eq(levelFor(6, 2), "learning", "(6,2) → learning");
eq(levelFor(7, 2), "young", "(7,2) → young（境界）");
eq(levelFor(10, 3), "young", "(10,3) → young");
eq(levelFor(20, 5), "young", "(20,5) → young");
eq(levelFor(21, 5), "mature", "(21,5) → mature（境界）");
eq(levelFor(25, 4), "mature", "(25,4) → mature");
eq(review(NEW, "easy", T).level, "learning", "新規 easy（4日）→ 保存される level も learning");
eq(review(DUE, "good", T).level, "mature", "C3（25日）→ mature");

console.log("=== displayLevel（保存済みの level を使わない） ===");
eq(displayLevel(NEW), "new", "未評価（last=null）→ new");
eq(displayLevel(ADDED), "new", "曲から追加しただけ → new");
eq(displayLevel(card({ level: "young", intervalDays: 1, reps: 1, last: D(-1), due: T })), "learning", "旧しきい値で young と保存された1日間隔 → learning");
eq(displayLevel(card({ level: "young", intervalDays: 3, reps: 2, last: D(-3), due: T })), "learning", "旧 young の3日間隔 → learning");
eq(displayLevel(DUE), "young", "10日間隔 → young");
eq(displayLevel(card({ level: "learning", intervalDays: 22, reps: 5, last: D(-1), due: D(21) })), "mature", "保存値に関係なく22日間隔 → mature");
eq(displayLevel(RELEARN), "learning", "again 直後（i0 r0）→ learning");

console.log("=== isKnownForLyrics（歌詞の色分け・評価済みで間隔3日以上） ===");
ok(!isKnownForLyrics(undefined), "カード無し → false");
ok(!isKnownForLyrics(card({ last: null, intervalDays: 5, reps: 0 })), "未評価 → false（間隔があっても）");
ok(!isKnownForLyrics(PASSED), "1日間隔 → false");
ok(!isKnownForLyrics(card({ last: D(-1), intervalDays: 2, reps: 2, due: D(1) })), "2日間隔 → false");
ok(isKnownForLyrics(card({ last: D(-1), intervalDays: 3, reps: 2, due: D(2) })), "3日間隔 → true（定着の7日より手前）");
ok(isKnownForLyrics(DUE), "10日間隔 → true");
ok(!isKnownForLyrics(RELEARN), "again 直後 → false");

console.log("=== masteryBreakdown ===");
{
  const words = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => w(i));
  const cards = {
    "words:0000": ADDED, // 曲から追加しただけ → 未学習
    "words:0001": card({ level: "young", intervalDays: 1, reps: 1, last: D(-1), due: T }), // 旧 young → 学習中
    "words:0002": card({ level: "young", intervalDays: 6, reps: 2, last: D(-1), due: D(5) }), // 学習中
    "words:0003": card({ level: "young", intervalDays: 7, reps: 3, last: D(-1), due: D(6) }), // 定着中
    "words:0004": card({ level: "young", intervalDays: 21, reps: 4, last: D(-1), due: D(20) }), // 習得
    "words:0005": RELEARN, // 学習中
    "words:9999": DUE, // 対象外の語は数えない
  };
  const m = masteryBreakdown(words, cards);
  eq(
    [m.total, m.notIntroduced, m.new, m.unstudied, m.learning, m.young, m.mature],
    [10, 4, 1, 5, 3, 1, 1],
    "件数（displayLevel で集計・未学習＝カード無し＋未評価）"
  );
  eq(m.unstudied + m.learning + m.young + m.mature, m.total, "4マスの合計＝全語数");
  eq([m.startedRatio, m.retainedRatio], [0.5, 0.2], "着手率（評価済み）と定着率（7日以上）");
  eq(masteryBreakdown([], cards).startedRatio, 0, "語が0件 → 0");
}

// ---------------------------------------------------------------------------
console.log("=== quizDecision ===");
eq(quizDecision(undefined, "good", T), "log", "カード無し good → log");
eq(quizDecision(undefined, "again", T), "log", "カード無し again → log");
eq(quizDecision(ADDED, "good", T), "log", "last=null good → log");
eq(quizDecision(ADDED, "again", T), "log", "last=null again → log");
eq(quizDecision(PASSED, "good", T), "none", "last=T good → none");
eq(quizDecision(PASSED, "again", T), "none", "last=T again → none");
eq(quizDecision(DUE, "good", T), "rate", "期限到来 good → rate");
eq(quizDecision(DUE, "again", T), "rate", "期限到来 again → rate");
eq(quizDecision(OVERDUE, "good", T), "rate", "延滞 good → rate");
eq(quizDecision(EARLY, "again", T), "rate", "期限前 again → rate");
eq(quizDecision(EARLY, "good", T), "none", "期限前 good → none");
eq(quizDecision(EARLY, "hard", T), "none", "期限前 hard → none");
eq(quizDecision(EARLY, "easy", T), "none", "期限前 easy → none");

// ---------------------------------------------------------------------------
console.log("=== seededShuffle / spreadCategories / interleave ===");
function w(i: number): Word {
  const id = `words:${String(i).padStart(4, "0")}`;
  return { id, source: "words", index: i, category: "c", pt: `p${i}`, ja: `j${i}`, pos: "名詞", ptForSpeech: `p${i}`, kana: "", ipa: "" };
}
/**
 * orderNew / buildSession 用の語。id は実データと重ならない 9000 番台
 * （同じ綴りの判定は実データの兄弟グループに無い id なので pt の headKey で決まる）。
 */
let fxSeq = 0;
function fx(source: "words" | "capoeira" | "dict", category: string, o: { pos?: string; pt?: string } = {}): Word {
  const n = 9000 + fxSeq++;
  const pt = o.pt ?? `${source}-${category}-${n}`;
  return { id: `${source}:${n}`, source, index: n, category, pt, ja: `j${n}`, pos: o.pos ?? "名詞", ptForSpeech: pt, kana: "", ipa: "" };
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const idsOf = (ws: Word[]) => ws.map((x) => x.id);
const sortedIds = (ws: Word[]) => idsOf(ws).sort();
const isCapW = (x: Word) => x.source === "capoeira";
/** 同じカテゴリ（ソース＋カテゴリ）が続く最大の長さ */
function maxRun(ws: Word[]): number {
  let best = 0;
  let run = 0;
  let prev = "";
  for (const x of ws) {
    const k = `${x.source}:${x.category}`;
    run = k === prev ? run + 1 : 1;
    prev = k;
    best = Math.max(best, run);
  }
  return best;
}
function countBy(ws: Word[], key: (x: Word) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of ws) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}
{
  const a = range(20);
  const frozen = JSON.stringify(a);
  const s1 = seededShuffle(a, T);
  eq(seededShuffle(a, T), s1, "seededShuffle: 同じ種 → 同じ並び");
  eq([...s1].sort((x, y) => x - y), a, "seededShuffle: 要素は同じ（並べ替えだけ）");
  ok(JSON.stringify(s1) !== frozen, "seededShuffle: 並びが変わる");
  ok(JSON.stringify(seededShuffle(a, D(1))) !== JSON.stringify(s1), "seededShuffle: 種（日付）が違えば並びも違う");
  eq(JSON.stringify(a), frozen, "seededShuffle: 入力は変更しない");
  eq(seededShuffle([], T), [], "seededShuffle: 空");

  const A = range(4).map(() => fx("words", "A"));
  const B = range(3).map(() => fx("words", "B"));
  const C = range(3).map(() => fx("words", "C"));
  const sp = spreadCategories([...A, ...B, ...C]);
  eq(sortedIds(sp), sortedIds([...A, ...B, ...C]), "spreadCategories: 要素は同じ");
  eq(maxRun(sp), 1, "spreadCategories: A4 B3 C3 → 同じカテゴリが隣り合わない");
  eq(idsOf(sp.filter((x) => x.category === "A")), idsOf(A), "spreadCategories: 同じカテゴリの中の順は保つ");
  eq(maxRun(spreadCategories([...A, B[0]])), 2, "spreadCategories: A4 B1（隣接を避けられない）→ 連続は2語まで");
  eq(
    spreadCategories([...A, B[0]]).map((x) => x.category).join(""),
    "AABAA",
    "spreadCategories: A4 B1 → AABAA"
  );
  const sameName = [fx("words", "X"), fx("words", "X"), fx("capoeira", "X"), fx("capoeira", "X")];
  eq(maxRun(spreadCategories(sameName)), 1, "spreadCategories: ソースが違えば同じ名前のカテゴリでも別扱い");
  eq(spreadCategories([]), [], "spreadCategories: 空");

  eq(interleave(["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"], ["f1", "f2", "f3"], 4).join(" "), "r1 r2 r3 r4 f1 r5 r6 r7 r8 f2 f3", "interleave: 4枚ごとに1枚、残りは後ろ");
  eq(interleave([], ["f1", "f2"], 4), ["f1", "f2"], "interleave: 復習なし → 新規だけ");
  eq(interleave(["r1", "r2"], [], 4), ["r1", "r2"], "interleave: 新規なし → 復習だけ");
  eq(REVIEWS_PER_NEW, 4, "REVIEWS_PER_NEW = 4");
}

// ---------------------------------------------------------------------------
console.log("=== orderNew（新規語の導入順） ===");
{
  // 一般語彙: 6カテゴリ × 8語（ファイル順）、カポエイラ: 固有名詞 5語 + 3カテゴリ × 6語
  const gen = ["G1", "G2", "G3", "G4", "G5", "G6"].flatMap((c) => range(8).map(() => fx("words", c)));
  const nouns = range(5).map(() => fx("capoeira", "人物", { pos: "固有名詞（人名）" }));
  const cap = ["K1", "K2", "K3"].flatMap((c) => range(6).map(() => fx("capoeira", c)));
  const pool = [...gen, ...nouns, ...cap];
  const frozen = JSON.stringify(pool);
  const base = { limit: 16, capoeiraShare: 0.25, coreOrder: [] as string[], seed: T };

  const r = orderNew(pool, {}, base);
  eq(r.length, 16, "limit 語を返す");
  eq(new Set(idsOf(r)).size, 16, "同じ語は1回");
  eq(r.filter(isCapW).length, 4, "share 0.25 → 16語中4語がカポエイラ語");
  ok(!r.some((x) => /固有名詞/.test(x.pos)), "固有名詞は出さない");
  ok(maxRun(r) <= 2, "同じカテゴリは連続2語まで（セッション内の並び）");
  eq(orderNew(pool, {}, base), r, "同じ日（種）なら同じ結果");
  eq(JSON.stringify(pool), frozen, "入力は変更しない");
  eq(orderNew(pool, {}, { ...base, capoeiraShare: 0 }).filter(isCapW).length, 0, "share 0 → カポエイラ語なし");
  eq(orderNew(pool, {}, { ...base, capoeiraShare: 0.5 }).filter(isCapW).length, 8, "share 0.5 → 16語中8語");
  eq(orderNew(pool, {}, { ...base, limit: 15, capoeiraShare: 0.33 }).filter(isCapW).length, 5, "share 0.33（3語に1語）→ 15語中5語");
  eq(orderNew(pool, {}, { ...base, limit: 12, capoeiraShare: 0.33 }).filter(isCapW).length, 4, "share 0.33 → 12語中4語");
  eq(orderNew(pool, {}, { ...base, limit: 15, capoeiraShare: 0.3 }).filter(isCapW).length, 4, "share 0.3 は 1/3 に丸めない → 15語中4語");
  eq(orderNew(cap, {}, { ...base, capoeiraShare: 0, limit: 5 }).length, 5, "一般語が尽きたらカポエイラ語で埋める（share 0 でも）");
  eq(orderNew(gen.slice(0, 3), {}, { ...base, capoeiraShare: 0.5, limit: 5 }).length, 3, "候補が尽きたらそこまで");
  eq(orderNew(pool, {}, { ...base, limit: 0 }), [], "limit 0 → []");

  // カテゴリの巡回: 先頭4カテゴリから4語ずつ（ファイル順）。上限に達したら次のカテゴリが窓に入る
  const byCat = (ws: Word[]) => countBy(ws, (x) => x.category);
  const g16 = orderNew(gen, {}, { ...base, capoeiraShare: 0 });
  eq(byCat(g16), { G1: 4, G2: 4, G3: 4, G4: 4 }, "巡回: 先頭4カテゴリ × 4語");
  eq(sortedIds(g16.filter((x) => x.category === "G1")), sortedIds(gen.slice(0, 4)), "巡回: カテゴリの中はファイル順");
  const g20 = orderNew(gen, {}, { ...base, capoeiraShare: 0, limit: 20 });
  eq(byCat(g20), { G1: 4, G2: 4, G3: 4, G4: 4, G5: 2, G6: 2 }, "巡回: 上限に達したカテゴリの次（G5・G6）が窓に入る");
  const g7 = orderNew(gen, {}, { ...base, capoeiraShare: 0, limit: 7, width: 2, perCategoryCap: 3 });
  eq(byCat(g7), { G1: 3, G2: 3, G3: 1 }, "巡回: width 2・perCategoryCap 3");

  // カードのある語は候補にしない（曲から追加しただけのカードも）
  const withCards = {
    [gen[0].id]: card({ intervalDays: 2, reps: 1, last: D(-1), due: D(1) }),
    [gen[1].id]: card({ last: null }),
  };
  const rc = orderNew(gen, withCards, { ...base, capoeiraShare: 0 });
  ok(!idsOf(rc).includes(gen[0].id) && !idsOf(rc).includes(gen[1].id), "カードのある語は出さない");
  eq(sortedIds(rc.filter((x) => x.category === "G1")), sortedIds(gen.slice(2, 6)), "カードのある語を飛ばして次の語");

  // コア語が先（コア語はカテゴリの上限に数えない。一般語とカポエイラ語はそれぞれ core の順）
  const core = [gen[47].id, gen[46].id, gen[45].id, cap[17].id, gen[44].id, gen[43].id];
  const rcore = orderNew(pool, {}, { ...base, coreOrder: core, limit: 4 });
  eq(sortedIds(rcore), [gen[47].id, gen[46].id, gen[45].id, cap[17].id].sort(), "コア語が先（i=3 でカポエイラのコア語）");
  const rcore6 = orderNew(pool, {}, { ...base, coreOrder: core, limit: 6, capoeiraShare: 0 });
  eq(sortedIds(rcore6), [gen[47].id, gen[46].id, gen[45].id, gen[44].id, gen[43].id, gen[0].id].sort(), "コア語（同じカテゴリ5語も可）→ 尽きたら巡回");
  const rcore16 = orderNew(pool, {}, { ...base, coreOrder: core });
  ok(core.every((id) => idsOf(rcore16).includes(id)), "limit がコア語より多ければコア語はすべて入る");

  // dict はコア語か pinned のときだけ
  const d1 = fx("dict", "辞書");
  const d2 = fx("dict", "辞書");
  const d3 = fx("dict", "辞書");
  const rd = orderNew([...gen.slice(0, 8), d1, d2, d3], {}, { ...base, capoeiraShare: 0, coreOrder: [d1.id], pinned: [d3.id], limit: 20 });
  ok(idsOf(rd).includes(d1.id) && idsOf(rd).includes(d3.id) && !idsOf(rd).includes(d2.id), "dict はコア語・pinned だけ");

  // pinned は最優先（固有名詞でも入れる）。カードのある語・未知の id は無視
  const pinned = [nouns[0].id, gen[30].id, gen[30].id, "words:9999"];
  eq(sortedIds(orderNew(pool, {}, { ...base, pinned, limit: 2 })), [nouns[0].id, gen[30].id].sort(), "pinned が最優先（固有名詞も・重複除去）");
  ok(!idsOf(orderNew(pool, { [gen[30].id]: card({ last: D(-1), due: D(2), intervalDays: 3, reps: 1 }) }, { ...base, pinned: [gen[30].id], limit: 1 })).includes(gen[30].id), "カードのある pinned は出さない");
  eq(orderNew(pool, {}, { ...base, capoeiraShare: 0, pinned: [cap[0].id], limit: 3 }).filter(isCapW).length, 1, "pinned のカポエイラ語は share 0 でも入る");

  // 別名（data/word-aliases.json の alias 側）は候補にしない。pinned なら入れる
  ok(ALIAS_IDS.has("words:0954"), "前提: words:0954 は別名（bom dia の重複）");
  const alias: Word = { ...fx("words", "G1", { pt: "Bom dia" }), id: "words:0954", index: 954 };
  const all = { ...base, capoeiraShare: 0, limit: 100, perCategoryCap: 100, width: 100 };
  ok(!idsOf(orderNew([alias, ...gen], {}, all)).includes(alias.id), "別名は出さない");
  ok(idsOf(orderNew([alias, ...gen], {}, { ...all, pinned: [alias.id] })).includes(alias.id), "別名でも pinned なら出す");

  // 別名の登録でつながる語（keep/alias）にカードがあれば、同じ語を2枚目のカードとして導入しない（pinned でも）
  const rated = card({ intervalDays: 3, reps: 1, last: D(-2), due: D(1) });
  eq(ALIAS_KEEP.get("capoeira:0077"), "words:0092", "前提: capoeira:0077 falar の keep は words:0092");
  eq(ALIAS_KEEP.get("words:0546"), "words:0013", "前提: words:0546 sim の keep は words:0013");
  eq([ALIAS_KEEP.get("words:0951"), ALIAS_KEEP.get("words:0957")], ["words:0012", "words:0012"], "前提: words:0012 の別名は 0951 と 0957");
  const falar: Word = { ...fx("words", "G1", { pt: "falar" }), id: "words:0092", index: 92 };
  ok(idsOf(orderNew([falar, ...gen], {}, { ...all, coreOrder: [falar.id] })).includes(falar.id), "keep（コア語）はどれにもカードが無ければ出す");
  ok(!idsOf(orderNew([falar, ...gen], { "capoeira:0077": rated }, { ...all, coreOrder: [falar.id] })).includes(falar.id), "alias にカードがあれば keep（コア語）は出さない");
  ok(!idsOf(orderNew([falar, ...gen], { "capoeira:0077": card({ last: null }) }, { ...all, coreOrder: [falar.id] })).includes(falar.id), "曲から追加しただけの alias のカードでも keep は出さない");
  ok(!idsOf(orderNew([falar, ...gen], { "capoeira:0077": rated }, { ...all, pinned: [falar.id] })).includes(falar.id), "alias にカードがあれば pinned の keep も出さない");
  const sim: Word = { ...fx("words", "G1", { pt: "sim" }), id: "words:0546", index: 546 };
  ok(!idsOf(orderNew([sim, ...gen], { "words:0013": rated }, { ...all, pinned: [sim.id] })).includes(sim.id), "keep にカードがあれば pinned の alias は出さない");
  const lic: Word = { ...fx("words", "G1", { pt: "com licença" }), id: "words:0957", index: 957 };
  ok(!idsOf(orderNew([lic, ...gen], { "words:0951": rated }, { ...all, pinned: [lic.id] })).includes(lic.id), "同じ keep の別の alias にカードがあれば pinned の alias も出さない");

  // 同じ綴り（兄弟グループ）は1回の選出で1語まで
  const sw = fx("words", "G1", { pt: "roda" });
  const sc = fx("capoeira", "K1", { pt: "Roda" });
  eq(siblingKey(sw), siblingKey(sc), "前提: words と capoeira の roda は同じ兄弟グループ");
  const rs = orderNew([sw, sc, ...gen.slice(0, 8), ...cap.slice(0, 6)], {}, { ...base, capoeiraShare: 0.5, coreOrder: [sw.id, sc.id], limit: 10 });
  eq(rs.filter((x) => x.id === sw.id || x.id === sc.id).length, 1, "同じ綴りの語は1語だけ");

  // isExcluded
  ok(!orderNew(gen, {}, { ...base, capoeiraShare: 0, isExcluded: (x) => x.category === "G1" }).some((x) => x.category === "G1"), "isExcluded の語は出さない");
}

// ---------------------------------------------------------------------------
console.log("=== buildSession（復習の上限・延滞順・新規の混ぜ方・同じ綴り） ===");
{
  // 評価済みで期限の来たカード（due の offset 日、間隔 i 日）
  const rv = (dueOff: number, i: number) => card({ ease: 2.5, intervalDays: i, reps: 2, last: D(dueOff - i), due: D(dueOff) });
  const R = range(6).map(() => fx("words", "R"));
  // 相対延滞度 (延滞+1)/間隔: R0 0.1 / R1 3 / R2 2 / R3 0.367 / R4 1 / R5 1.33
  const reviewCards = {
    [R[0].id]: rv(0, 10),
    [R[1].id]: rv(-5, 2),
    [R[2].id]: rv(-1, 1),
    [R[3].id]: rv(-10, 30),
    [R[4].id]: rv(0, 1),
    [R[5].id]: rv(-3, 3),
  };
  const N = ["N1", "N2", "N3"].flatMap((c) => range(4).map(() => fx("words", c)));
  const K = range(4).map(() => fx("capoeira", "K"));
  const pool = [...R, ...N, ...K];
  const base = { newLimit: 3, introducedToday: 0, today: T, coreOrder: [] as string[], capoeiraShare: 0 };
  const byOverdue = [R[1], R[2], R[5], R[4], R[3], R[0]].map((x) => x.id);

  eq(relativeOverdue(rv(-5, 2), T), 3, "relativeOverdue: (延滞5+1)/間隔2 = 3");
  eq(relativeOverdue(card({ intervalDays: 0, last: T, due: T }), T), 1, "relativeOverdue: 間隔0 は1として割る");

  const s = buildSession(pool, reviewCards, base);
  eq(idsOf(s.review), byOverdue, "復習は相対延滞度の降順");
  eq([s.reason, s.dueTotal, s.fresh.length], [undefined, 6, 3], "上限内 → 新規も出す");
  eq(
    s.all.map((x) => (s.fresh.includes(x) ? "f" : "r")).join(""),
    "rrrrfrrff",
    "all = 復習4枚ごとに新規1枚（残りは後ろ）"
  );
  eq(s.fresh.filter(isCapW).length, 0, "capoeiraShare 0 → カポエイラ語なし");
  eq(buildSession(pool, reviewCards, { ...base, capoeiraShare: 0.5, newLimit: 4 }).fresh.filter(isCapW).length, 2, "capoeiraShare を orderNew に渡す");

  // 上限
  const cap4 = buildSession(pool, reviewCards, { ...base, reviewLimit: 4 });
  eq(idsOf(cap4.review), byOverdue.slice(0, 4), "reviewLimit 4 → 延滞の大きい4枚");
  eq([cap4.reason, cap4.fresh, cap4.dueTotal], ["backlog", [], 6], "延滞が上限を超える → fresh=[]・reason=backlog");
  eq(idsOf(cap4.all), byOverdue.slice(0, 4), "backlog の日は復習だけ");
  const used = buildSession(pool, reviewCards, { ...base, reviewLimit: 8, reviewedToday: 5 });
  eq([idsOf(used.review), used.reason], [byOverdue.slice(0, 3), "backlog"], "今日の評価済み5枚 → 残りの上限3枚");
  const exact = buildSession(pool, reviewCards, { ...base, reviewLimit: 6 });
  eq([exact.review.length, exact.reason, exact.fresh.length], [6, undefined, 3], "延滞がちょうど上限 → backlog ではない");
  const spent = buildSession(pool, reviewCards, { ...base, reviewLimit: 100, reviewedToday: 100 });
  eq([spent.all, spent.reason], [[], "backlog"], "上限を使い切って期限の語が残る → 何も出さず backlog");
  const noDue = buildSession(N, {}, { ...base, reviewLimit: 1, reviewedToday: 100 });
  eq([noDue.reason, noDue.fresh.length], [undefined, 3], "期限の語が無ければ上限を使い切っていても新規は出す");

  // 今日 again にした語（再学習）は上限の外で必ず出す
  const relearnW = fx("words", "R");
  const withRelearn = { ...reviewCards, [relearnW.id]: card({ lapses: 1, last: T, due: T }) };
  const rl = buildSession([...pool, relearnW], withRelearn, { ...base, reviewLimit: 2 });
  eq(idsOf(rl.review), [...byOverdue.slice(0, 2), relearnW.id], "今日の再学習は上限の外（復習の後ろ）");
  eq(rl.dueTotal, 6, "dueTotal に今日の再学習は数えない");

  // 曲から追加した語（未評価）は別枠で後ろ
  const m1 = fx("dict", "曲の単語");
  const m2 = fx("dict", "曲の単語");
  const withAdded = { ...reviewCards, [m1.id]: card({ last: null, due: D(-2) }), [m2.id]: card({ last: null, due: T }) };
  const ad = buildSession([...pool, m1, m2], withAdded, { ...base, addedLimit: 1 });
  eq([idsOf(ad.added), ad.all[ad.all.length - 1].id], [[m1.id], m1.id], "曲の語は上限まで・最後に");
  eq(buildSession([...pool, m1, m2], withAdded, { ...base, addedLimit: 5, addedToday: 4 }).added.length, 1, "曲の語は今日の導入数を引く");
  ok(!idsOf(ad.fresh).includes(m1.id), "カードのある曲の語は新規（fresh）に入らない");

  // pinned（「今日の学習に追加」）は新規枠の中で最優先
  const P0 = N[11].id;
  const pn = buildSession(pool, reviewCards, { ...base, pinned: [P0, R[1].id, "words:9999"] });
  ok(idsOf(pn.fresh).includes(P0) && pn.fresh.length === 3, "pinned が新規枠に入る");
  ok(!idsOf(pn.fresh).includes(R[1].id), "カード作成済みの pinned は復習側のまま");
  eq(idsOf(buildSession(pool, reviewCards, { ...base, introducedToday: 2, pinned: [P0] }).fresh), [P0], "新規枠の残りが1なら pinned だけ");
  eq(buildSession(pool, reviewCards, { ...base, introducedToday: 3, pinned: [P0] }).fresh, [], "新規枠が尽きたら pinned も出さない");
  eq(buildSession(pool, reviewCards, { ...base, reviewLimit: 1, pinned: [P0] }).fresh, [], "backlog の日は pinned も出さない");

  // コア語（buildSession から orderNew へ）
  const coreS = buildSession(pool, reviewCards, { ...base, coreOrder: [N[10].id, N[9].id, N[8].id] });
  eq(sortedIds(coreS.fresh), [N[10].id, N[9].id, N[8].id].sort(), "新規はコア語から");

  // 同じ綴り（兄弟グループ）は1日1枚まで
  const rodaR = fx("words", "S", { pt: "roda" }); // 復習（期限）
  const rodaN = fx("words", "K", { pt: "Roda" }); // 新規候補（コア語の先頭）
  const casaT = fx("words", "S", { pt: "casa" }); // 今日評価済み（明日が期限）
  const casaD = fx("capoeira", "K", { pt: "casa" }); // その兄弟が期限
  const boaA = fx("words", "S", { pt: "bola" }); // 期限（延滞小）
  const boaB = fx("capoeira", "K", { pt: "Bola" }); // 期限（延滞大）
  const mesaR = fx("words", "S", { pt: "mesa" }); // 期限
  const mesaM = fx("dict", "曲の単語", { pt: "mesa" }); // 曲から追加（同じ綴り）
  const sib = [rodaR, rodaN, casaT, casaD, boaA, boaB, mesaR, mesaM];
  const sibCards = {
    [rodaR.id]: rv(0, 3),
    [casaT.id]: card({ intervalDays: 1, reps: 1, last: T, due: D(1) }),
    [casaD.id]: rv(-2, 4),
    [boaA.id]: rv(0, 10),
    [boaB.id]: rv(-4, 2),
    [mesaR.id]: rv(0, 5),
    [mesaM.id]: card({ last: null, due: T }),
  };
  const ss = buildSession([...sib, ...N], sibCards, { ...base, coreOrder: [rodaN.id], addedLimit: 5 });
  const sIds = idsOf(ss.all);
  ok(sIds.includes(rodaR.id) && !sIds.includes(rodaN.id), "復習の語と同じ綴りの新規語は出さない");
  ok(!sIds.includes(casaD.id), "今日評価した語と同じ綴りの語は、期限でも明日へ");
  ok(sIds.includes(boaB.id) && !sIds.includes(boaA.id), "同じ綴りの復習が2つ → 延滞の大きい方だけ");
  ok(sIds.includes(mesaR.id) && !sIds.includes(mesaM.id), "曲の語も同じ綴りの復習があれば出さない");
  eq(ss.dueTotal, 3, "dueTotal は同じ綴りで明日に回した語を除く（roda・bola・mesa）");
  eq(new Set(ss.all.map((x) => siblingKey(x))).size, ss.all.length, "all の中に同じ綴りの語は1つだけ");

  // countDueOn
  const fw = [0, 1, 2, 3, 4, 5, 6, 0].map(w);
  const fcards = {
    "words:0000": card({ last: D(-1), due: T }),
    "words:0001": card({ last: D(-5), due: D(-2) }),
    "words:0002": card({ last: T, intervalDays: 1, reps: 1, due: D(1) }),
    "words:0003": card({ last: T, intervalDays: 3, reps: 2, due: D(3) }),
    "words:0006": card({ last: null, due: T }),
  };
  eq(countDueOn(fw, fcards, T), 2, "countDueOn 今日（評価済みで期限・重複は1回・未評価は数えない）");
  eq(countDueOn(fw, fcards, D(1)), forecast(fw, fcards, T)[0], "countDueOn 明日 = 予報の1日目");
  eq(countDueOn(fw, fcards, D(3)), 4, "countDueOn 3日後");
}

// ---------------------------------------------------------------------------
console.log("=== クイズの誤答（quizChoices） ===");
{
  // id は実データと重ならない 9500 番台（同じ綴りの判定は pt の headKey で決まる）
  let seq = 9500;
  const qx = (o: { pt: string; ja: string; pos?: string; category?: string; source?: "words" | "capoeira" | "dict"; id?: string }): Word => {
    const source = o.source ?? "words";
    const n = seq++;
    return {
      id: o.id ?? `${source}:${n}`,
      source,
      index: n,
      category: o.category ?? "c1",
      pt: o.pt,
      ja: o.ja,
      pos: o.pos ?? "名詞",
      ptForSpeech: o.pt,
      kana: "",
      ipa: "",
    };
  };
  const ids = (ws: Word[]) => ws.map((x) => x.id);

  // 表示の比較キー
  eq(choiceKey({ pt: "Você", ja: "" }, "pt"), choiceKey({ pt: "voce?", ja: "" }, "pt"), "choiceKey pt: 大小・アクセント・記号を無視");
  ok(choiceKey({ pt: "", ja: "ガム" }, "ja") !== choiceKey({ pt: "", ja: "カム" }, "ja"), "choiceKey ja: 濁点は区別する（fold しない）");
  eq(choiceKey({ pt: "", ja: "トイレ ・浴室" }, "ja"), "トイレ・浴室", "choiceKey ja: 空白だけ除く");

  // 品詞の大分類・固有名詞
  eq(
    ["固有名詞（人名）", "名詞・形容詞", "動詞（現在分詞）", "名詞", "フレーズ"].map(posClass),
    ["固有名詞", "名詞", "動詞", "名詞", "フレーズ"],
    "posClass"
  );
  eq([isProperNoun({ pos: "固有名詞（地名）" }), isProperNoun({ pos: "名詞" })], [true, false], "isProperNoun");
  eq([askableByJa({ pos: "固有名詞（西暦）" }), askableByJa({ pos: "動詞" })], [false, true], "和→葡は固有名詞を出題しない");

  // 和訳の片: カポエイラ語のカタカナ間の「・」は名前の区切りなので分けない
  eq(quizPieces({ source: "capoeira", ja: "メストリ・ビンバの息子・マスター" }), ["メストリ・ビンバの息子", "マスター"], "quizPieces: カポエイラの名前は分けない");
  eq(quizPieces({ source: "words", ja: "ペースト・フォルダ" }), ["ペースト", "フォルダ"], "quizPieces: words の「・」は同義語の区切り");
  eq(quizPieces({ source: "words", ja: "足（足首から下）/ 脚" }), ["足", "脚"], "quizPieces: 括弧を除き / で分ける");

  const A = qx({ pt: "casa", ja: "家・住まい" });
  const B = qx({ pt: "carro", ja: "車" }); // 同品詞×同カテゴリ
  const Bdup = qx({ pt: "auto", ja: "車" }); // B と表示（訳）が同じ
  const C = qx({ pt: "lar", ja: "住まい" }); // 片が重なる → 段階1
  const D = qx({ pt: "cão", ja: "犬", category: "c2" }); // 同品詞
  const E = qx({ pt: "correr", ja: "走る", pos: "動詞" }); // 同カテゴリ
  const F = qx({ pt: "azul", ja: "青い", pos: "形容詞", category: "c3" }); // その他
  const G = qx({ pt: "Casa!", ja: "カーサ", category: "c9" }); // 同じ headKey → 段階2
  const H = qx({ pt: "cása", ja: "箱", pos: "形容詞", category: "c9" }); // その他。pt の表示が A と同じ（fold）

  eq([B, D, E, F].map((x) => distractorTier(A, x)), [0, 1, 2, 3], "distractorTier: 同品詞×同カテゴリ → 同品詞 → 同カテゴリ → その他");
  eq(
    [B, C, G, H].map((x) => exclusionLevel(A, x)),
    [0, 1, 2, 0],
    "exclusionLevel: 片の重なり=1・同じ headKey=2（綴りのアクセント違いは別の見出し）"
  );
  eq(exclusionLevel(qx({ pt: "meu/minha", ja: "私の" }), qx({ pt: "minha", ja: "わたしの" })), 2, "exclusionLevel: meu/minha と minha は同じ綴りのグループ");

  const rnd = () => 0.37;
  const pool = [A, F, E, D, B, Bdup, C, G, H];
  // 段の順（各段1語のとき）
  eq(ids(pickDistractors(A, [A, F, E, D, B], "ja", { n: 4, random: rnd })), ids([B, D, E, F]), "pickDistractors: 段の順に取る");
  // 3つ: 段0から1つ（B と Bdup は表示が同じなので片方だけ。C は片が重なる）→ 段1の D（G は同じ綴り）→ 段2の E
  const r3 = pickDistractors(A, pool, "ja", { random: rnd });
  eq(r3.length, 3, "pickDistractors: 3つ選ぶ");
  eq([r3.filter((x) => x === B || x === Bdup).length, r3[1]?.id, r3[2]?.id], [1, D.id, E.id], "pickDistractors: 表示が同じ候補は1つだけ・段の順");
  ok(!r3.includes(A) && !r3.includes(C) && !r3.includes(G), "pickDistractors: 正解・片の重なり・同じ綴りを除く");
  // 段階0（B|Bdup・D・E・F・H の5つ）が尽きたら段階1（片の重なり C）、さらに段階2（同じ綴り G）へ緩める
  const r6 = pickDistractors(A, pool, "ja", { n: 6, random: rnd });
  eq([r6.length, r6[5]?.id, r6.includes(G)], [6, C.id, false], "pickDistractors: 段階0 が尽きたら片の重なりを許す（同じ綴りはまだ）");
  const r7 = pickDistractors(A, pool, "ja", { n: 7, random: rnd });
  eq([r7.length, r7[5]?.id, r7[6]?.id], [7, C.id, G.id], "pickDistractors: さらに足りなければ同じ綴りも許す");
  const rAll = pickDistractors(A, pool, "ja", { n: 20, random: rnd });
  eq(rAll.length, 7, "pickDistractors: 表示の重複（B/Bdup）以外はすべて使える（ja）");
  ok(!rAll.includes(A), "pickDistractors: 正解は選ばない");
  // pt の表示が正解と同じ候補（cása）は、どの段階でも選ばない
  const rPt = pickDistractors(A, [A, H, B, D], "pt", { n: 3, random: rnd });
  eq(ids(rPt), ids([B, D]), "pickDistractors pt: 表示が正解と同じ（fold）候補は緩めても選ばない");
  // 別名は段階1: 段の優先より段階が先
  const aliasId = [...ALIAS_IDS][0];
  const Al = qx({ pt: "zzz-alias", ja: "別名の訳", id: aliasId });
  eq(exclusionLevel(A, Al), 1, "exclusionLevel: 別名（alias 側）=1");
  eq(ids(pickDistractors(A, [A, Al, D], "ja", { n: 1, random: rnd })), ids([D]), "pickDistractors: 段0の別名より段1の普通の語を先に取る");
  // 候補が少ないときは足りる分だけ（空でも落ちない）
  eq(pickDistractors(A, [A], "ja").length, 0, "pickDistractors: 候補なしは空");
  // 同じ乱数なら同じ結果
  eq(ids(pickDistractors(A, pool, "ja", { random: rnd })), ids(r3), "pickDistractors: 乱数が同じなら同じ結果");
}

// ---------------------------------------------------------------------------
// 曲の単語タブ（B2-13・バグ#15）。学習状況・追加済み・一括追加の除外は同じ綴りの見出しすべて（allIds）で見る
console.log("=== 曲の単語タブ（songVocab） ===");
{
  // 辞書とカポエイラ単語帳の両方にある語（berimbau 型）、同じ意味の2見出し（casa 型）、機能語、同じ綴りの別の意味（jogo）
  const ENTRIES: LexRef[] = [
    { id: "dict:9001", pt: "berimbau", ja: "ビリンバウ（弓形の楽器）", pos: "名詞", source: "dict" },
    { id: "capoeira:9002", pt: "berimbau", ja: "ホーダを司る弓形の楽器", pos: "名詞", source: "capoeira" },
    { id: "words:9003", pt: "casa", ja: "家", pos: "名詞", source: "words" },
    { id: "words:9004", pt: "casa", ja: "家", pos: "名詞", source: "words" },
    { id: "words:9005", pt: "o", ja: "その（定冠詞）", pos: "冠詞", source: "words" },
    { id: "words:9006", pt: "jogo", ja: "ゲーム", pos: "名詞", source: "words" },
    { id: "capoeira:9007", pt: "jogo", ja: "カポエイラの試合", pos: "名詞", source: "capoeira" },
    { id: "words:9008", pt: "mar", ja: "海", pos: "名詞", source: "words" },
    { id: "dict:9010", pt: "mar", ja: "（間投詞の用法）", pos: "間投詞", source: "dict" },
  ];
  const lem = createLemmatizer({
    entries: ENTRIES,
    irregular: irregularRaw as unknown as IrregularTable,
    colloquial: colloquialRaw as unknown as ColloquialTable,
  });
  const analyzed = ["Berimbau berimbau berimbaus", "mares casa o xyz blah", "o jogo o mar"].map((l) => lem.analyzeLine(l));
  const user = { id: "user:xyz", pt: "xyz", ja: "自分の語", pos: "名詞" };
  const { items, unknown } = buildVocabItems(lem, analyzed, (k) => (k === "xyz" ? user : undefined));
  const byKey = new Map(items.map((i) => [i.key, i]));
  const bIt = byKey.get("dict:9001");
  eq(
    bIt && [bIt.ids, bIt.allIds, bIt.count],
    [["dict:9001"], ["dict:9001", "capoeira:9002"], 3],
    "berimbau: ids は同じ意味だけ、allIds は同じ綴りすべて（複数形も同じ行に数える）"
  );
  eq(byKey.get("words:9003")?.ids, ["words:9003", "words:9004"], "casa: 同じ和訳・品詞の2見出しは ids にまとまる");
  const mIt = byKey.get("words:9008");
  eq(mIt && [mIt.allIds, mIt.count], [["words:9008", "dict:9010"], 2], "mares（名詞の見出しだけ）→ mar（全見出し）: 同じ行の allIds を足していく");
  const uIt = byKey.get("user:xyz");
  eq(uIt && [uIt.ids, uIt.allIds], [["user:xyz"], ["user:xyz"]], "自分の単語: ids = allIds = [user:…]");
  eq(unknown.map((u) => u.token.key), ["blah"], "辞書にも自分の単語にも無い語だけが unknown");
  eq(items.map((i) => i.key).slice(0, 2), ["dict:9001", "words:9005"], "出現回数の多い順（berimbau ×3、o ×3 は出てきた順）");
  ok(items.every((i) => i.ids.every((id) => i.allIds.includes(id)) && i.ids[0] === i.allIds[0]), "ids ⊆ allIds・先頭は同じ");

  const it = (ids: string[], allIds: string[], o: Partial<VocabItem> = {}): VocabItem => ({
    key: ids[0],
    ids,
    allIds,
    lemma: ids[0],
    ja: "訳",
    pos: "名詞",
    count: 1,
    surface: ids[0],
    ...o,
  });
  const B = it(["dict:9001"], ["dict:9001", "capoeira:9002"]);
  const rated = card({ last: T, intervalDays: 1, reps: 1 });
  const none = {};
  eq([studiedId(B.allIds, none), statusId(B, none), addTargetId(B, none)], [undefined, undefined, "dict:9001"], "カードが無い → 未学習・追加は先頭の見出し");
  const capOnly = { "capoeira:9002": rated };
  eq(
    [statusId(B, capOnly), addTargetId(B, capOnly)],
    ["capoeira:9002", "capoeira:9002"],
    "カポエイラ単語帳のカードがある → 学習中とみなし、追加もそのカード（バグ#15: 2枚目を作らない）"
  );
  eq(statusId(B, { "capoeira:9002": rated, "dict:9001": rated }), "dict:9001", "同じ意味の見出しのカードを優先");
  const C = it(["words:9003", "words:9004"], ["words:9003", "capoeira:9099", "words:9004"]);
  eq(
    [statusId(C, { "words:9004": rated, "capoeira:9099": rated }), addTargetId(C, { "words:9004": rated, "capoeira:9099": rated })],
    ["words:9004", "words:9004"],
    "ids のカード → allIds のカードの順（allIds の並びで別の見出しが先でも）"
  );
  // 別名（alias 側）が先頭で、keep 側が同じ候補にある → keep 側に追加する
  const [aliasOf, keepOf] = [...ALIAS_KEEP.entries()][0];
  eq(addTargetId(it([aliasOf], [aliasOf, keepOf]), none), keepOf, "先頭が別名で keep 側も同じ綴り → keep 側を追加");
  eq(addTargetId(it([aliasOf], [aliasOf]), none), aliasOf, "keep 側が候補に無ければ先頭のまま");
  eq(addTargetId(it([aliasOf], [aliasOf, keepOf]), { [aliasOf]: rated }), aliasOf, "別名でもカードがあればそのカード");

  // 一括追加
  const G = it(["words:9005"], ["words:9005"], { pos: "冠詞", ja: "その（定冠詞）" });
  const J = it(["words:9006"], ["words:9006", "capoeira:9007"]);
  const J2 = it(["capoeira:9007"], ["capoeira:9007"], { key: "capoeira:9007x" });
  const Mr = it(["words:9008"], ["words:9008"]);
  const bk = (xs: VocabItem[], cards: Record<string, SrsCard>, song: string[] = [], limit = 10) =>
    bulkAddCandidates(xs, cards, new Set(song), limit).map((x) => x.ids[0]);
  eq(bk([B, G, J, Mr], none), ["dict:9001", "words:9006", "words:9008"], "一括追加: 機能語（冠詞）を除く");
  eq(bk([B, G, J, Mr], capOnly), ["words:9006", "words:9008"], "一括追加: 別の見出しで学習中の語は除く");
  eq(bk([B, J, Mr], none, ["capoeira:9002"]), ["words:9006", "words:9008"], "一括追加: この曲で別の見出しを追加済みなら除く");
  eq(bk([J, J2, Mr], none), ["words:9006", "words:9008"], "一括追加: 見出しが重なる行は1回だけ");
  eq(bk([B, J, Mr], none, [], 2), ["dict:9001", "words:9006"], "一括追加: 最大 limit 語");

  // 表示
  eq(
    [deckLabel("capoeira:0001"), deckLabel("words:0001"), deckLabel("dict:0001"), deckLabel("user:x")],
    ["カポエイラ単語帳", "単語帳", "単語帳", "自分の単語"],
    "deckLabel"
  );
  eq(
    [card({ last: null }), rated, card({ last: T, intervalDays: 10, reps: 3 }), card({ last: T, intervalDays: 30, reps: 5 })].map(levelLabel),
    ["未学習", "学習中", "定着中", "習得"],
    "levelLabel = LEVEL_JA[displayLevel(card)]（未評価は未学習）"
  );
  const refs = ENTRIES.slice(0, 2);
  eq(siblingCard(["dict:9001"], refs, capOnly)?.ref.id, "capoeira:9002", "siblingCard: 別の見出しのカード");
  eq(siblingCard(["dict:9001"], refs, { "dict:9001": rated, "capoeira:9002": rated }), undefined, "siblingCard: 自分の見出しにカードがあれば出さない");
  eq(siblingCard(["capoeira:9002"], refs, capOnly), undefined, "siblingCard: 自分自身は兄弟に数えない");
  eq(siblingCard(["dict:9001"], refs, none), undefined, "siblingCard: どこにもカードが無い");
  eq(siblingNote("capoeira:9002", rated), "カポエイラ単語帳で学習中", "siblingNote");
}

// ---------------------------------------------------------------------------
console.log("=== dueWords（並び順） ===");
{
  const words = [0, 1, 2, 3].map(w);
  const cards = {
    "words:0000": card({ last: D(-5), due: D(-1) }),
    "words:0001": card({ last: D(-5), due: T }),
    "words:0002": card({ last: D(-5), due: D(-3) }),
    "words:0003": card({ last: D(-5), due: T }),
  };
  eq(
    dueWords(words, cards, T).map((x) => x.id),
    ["words:0002", "words:0000", "words:0001", "words:0003"],
    "due の昇順・同じ日は元の順"
  );
}

// ---------------------------------------------------------------------------
console.log("=== session.step（§2b） ===");
{
  const ids = (s: SessionState) => s.queue.map((q) => q.word.id.slice(-1) + (q.kind === "intro" ? "i" : ""));
  const seen = card({ intervalDays: 3, reps: 1, last: D(-3), due: T });
  // 0〜3: 評価済み（test）、4: カード無し（intro）、5: 曲から追加しただけ（last=null → intro）
  const cards = {
    "words:0000": seen,
    "words:0001": seen,
    "words:0002": seen,
    "words:0003": seen,
    "words:0005": ADDED,
  };
  const words = [0, 1, 2, 3, 4, 5].map(w);
  const s0 = initSession(words, cards);
  eq(ids(s0), ["0", "1", "2", "3", "4i", "5i"], "initSession: 新規（カード無し・last=null）は intro");
  eq(new Set(s0.queue.map((q) => q.key)).size, 6, "initSession: key は一意");
  eq([s0.pos, s0.phase, isDone(s0), s0.round], [0, "front", false, 1], "initSession: 先頭の表から");
  eq([AGAIN_GAP, INTRO_GAP, MAX_REQUEUE], [3, 3, 3], "定数");

  const frozen = JSON.stringify(s0);
  ok(step(s0, { t: "rate", r: "good" }) === s0, "表のままでは評価できない（同じ状態）");
  ok(step(s0, { t: "introNext" }) === s0, "test で introNext は無視");
  const b0 = step(s0, { t: "reveal" });
  eq(b0.phase, "back", "reveal → 裏");
  ok(step(b0, { t: "reveal" }) === b0, "裏で reveal は無視");

  // again → 3枚後（間に3枚）に再挿入
  const a1 = step(b0, { t: "rate", r: "again" });
  eq(ids(a1), ["0", "1", "2", "3", "0", "4i", "5i"], "again → pos+1+AGAIN_GAP に再挿入");
  eq([a1.pos, a1.phase], [1, "front"], "again → 次のカードの表へ");
  eq(a1.queue[4].kind, "test", "再挿入は test");
  eq(new Set(a1.queue.map((q) => q.key)).size, 7, "再挿入の key も一意");
  eq([a1.requeued, a1.first, a1.again], [{ "words:0000": 1 }, { "words:0000": "again" }, ["words:0000"]], "again の記録");
  eq(JSON.stringify(s0), frozen, "step は入力を変更しない");

  // 1〜3 を good で進める → 再挿入した 0 が来る → good
  let s = a1;
  for (let i = 0; i < 3; i++) s = step(step(s, { t: "reveal" }), { t: "rate", r: "good" });
  eq([s.pos, currentItem(s)?.word.id], [4, "words:0000"], "3枚後に again の語が再出題");
  s = step(step(s, { t: "reveal" }), { t: "rate", r: "good" });
  eq(s.first["words:0000"], "again", "first は最初の評価のまま");

  // intro → test を INTRO_GAP 枚後に挿入（残りが少なければ末尾）
  eq(currentItem(s)?.kind, "intro", "intro に到達");
  ok(step(s, { t: "reveal" }) === s, "intro で reveal は無視");
  ok(step(s, { t: "rate", r: "good" }) === s, "intro で rate は無視");
  const i1 = step(s, { t: "introNext" });
  eq(ids(i1), ["0", "1", "2", "3", "0", "4i", "5i", "4"], "introNext → min(pos+1+INTRO_GAP, len) に test");
  eq([i1.pos, i1.phase], [6, "front"], "introNext → 次へ");
  const i2 = step(i1, { t: "introNext" });
  eq(ids(i2), ["0", "1", "2", "3", "0", "4i", "5i", "4", "5"], "末尾近くの intro → 末尾に test");
  eq(currentItem(i2)?.kind, "test", "紹介した語のテスト");
  let d = i2;
  while (!isDone(d)) d = step(step(d, { t: "reveal" }), { t: "rate", r: "good" });
  eq([d.pos, d.queue.length, currentItem(d)], [9, 9, undefined], "isDone: pos>=queue.length");
  ok(step(d, { t: "reveal" }) === d && step(d, { t: "rate", r: "again" }) === d, "完了後の操作は無視");
  eq(sessionStats(d), { reviews: 7, words: 6, newWords: 2, firstCorrect: 5 }, "sessionStats（再出題を含む枚数・1回目の正答）");

  // 中央での again: 間に3枚
  const mid = initSession([0, 1, 2, 3, 4, 5, 6].map(w), { ...cards, "words:0004": seen, "words:0005": seen, "words:0006": seen });
  let m = mid;
  for (let i = 0; i < 2; i++) m = step(step(m, { t: "reveal" }), { t: "rate", r: "good" });
  m = step(step(m, { t: "reveal" }), { t: "rate", r: "again" });
  eq(ids(m), ["0", "1", "2", "3", "4", "5", "2", "6"], "途中の again → 間に3枚はさんで再出題");

  // 末尾近くの again は末尾へ
  let e = initSession([w(0), w(1)], cards);
  e = step(step(e, { t: "reveal" }), { t: "rate", r: "again" });
  eq(ids(e), ["0", "1", "0"], "残りが少なければ末尾に再挿入");

  // 1語 MAX_REQUEUE 回まで
  let one = initSession([w(0)], cards);
  let tests = 0;
  while (!isDone(one) && tests < 20) {
    one = step(step(one, { t: "reveal" }), { t: "rate", r: "again" });
    tests++;
  }
  eq([tests, one.queue.length, one.requeued["words:0000"]], [4, 4, 3], "again は1語3回まで再挿入（計4回出題）");
  ok(isDone(one), "上限後は完了");

  // 完了後「again の語をもう1周」
  const r2 = step(one, { t: "append", items: [w(0)] });
  eq([isDone(r2), r2.round, r2.again, r2.requeued, currentItem(r2)?.kind], [false, 2, [], {}, "test"], "append: 末尾に test・again と再挿入回数は数え直し");
  eq(r2.first, one.first, "append: first は変えない");
  eq(new Set(r2.queue.map((q) => q.key)).size, 5, "append の key も一意");
  const r3 = step(step(r2, { t: "reveal" }), { t: "rate", r: "again" });
  eq([r3.queue.length, r3.again], [6, ["words:0000"]], "2周目も again で再挿入できる");
  ok(step(one, { t: "append", items: [] }) === one, "append 空 → 変更なし");

  // 出題方向
  eq(testDirection("words:0001", T, "pt2ja"), "pt2ja", "testDirection pt2ja");
  eq(testDirection("words:0001", T, "ja2pt"), "ja2pt", "testDirection ja2pt");
  const mixed = Array.from({ length: 40 }, (_, i) => testDirection(`words:${String(i).padStart(4, "0")}`, T, "mixed"));
  ok(mixed.includes("pt2ja") && mixed.includes("ja2pt"), "testDirection mixed: 両方向が出る");
  eq(
    Array.from({ length: 40 }, (_, i) => testDirection(`words:${String(i).padStart(4, "0")}`, T, "mixed")),
    mixed,
    "testDirection mixed: 同じ語・同じ日なら同じ向き"
  );
}

// ---------------------------------------------------------------------------
console.log("=== forecast ===");
{
  const words = [0, 1, 2, 3, 4, 5, 6, 0].map(w); // words:0000 は重複（1回だけ数える）
  const cards = {
    "words:0000": card({ last: D(-1), due: T }), // 今日やり残し → 明日
    "words:0001": card({ last: D(-5), due: D(-2) }), // 延滞 → 明日
    "words:0002": card({ last: T, intervalDays: 1, reps: 1, due: D(1) }), // 明日
    "words:0003": card({ last: T, intervalDays: 3, reps: 2, due: D(3) }), // 3日目
    "words:0004": card({ last: D(-1), intervalDays: 8, reps: 3, due: D(7) }), // 7日目
    "words:0005": card({ last: D(-1), intervalDays: 9, reps: 3, due: D(8) }), // 範囲外
    "words:0006": card({ last: null, due: T }), // 曲から追加しただけ → 数えない
    "words:0007": card({ last: D(-1), due: D(2) }), // 対象外の語 → 数えない
  };
  eq(forecast(words, cards, T), [3, 0, 1, 0, 0, 0, 1], "7日分（1日目は明日以前すべて、以降はその日ちょうど）");
  eq(forecast(words, cards, T, 3), [3, 0, 1], "days=3");
  eq(forecast(words, {}, T), [0, 0, 0, 0, 0, 0, 0], "カード無し → 0");
  eq(forecast(words, cards, T, 0), [], "days=0 → []");
}

// ---------------------------------------------------------------------------
console.log("=== 産出カード（T2-1）: カードキー ===");
{
  eq(PROD_SUFFIX, "@p", "産出カードのキーの末尾は @p");
  eq([prodKey("words:0042"), prodKey("dict:12"), prodKey("user:saudade")], ["words:0042@p", "dict:12@p", "user:saudade@p"], "prodKey = 語の ID + @p");
  eq(
    [isProdKey("words:0042@p"), isProdKey("words:0042"), isProdKey("@p"), isProdKey("user:a@b@p"), isProdKey("dict:12@p"), isProdKey("words:0042@P")],
    [true, false, false, false, true, false],
    "isProdKey: @p で終わり、その前に @ が無いキーだけ"
  );
  eq(
    [baseOfKey("words:0042@p"), baseOfKey("words:0042"), baseOfKey("user:a@b@p")],
    ["words:0042", "words:0042", "user:a@b@p"],
    "baseOfKey: 産出カードのキー → 語の ID（それ以外はそのまま）"
  );
  eq([cardKey("words:0001", "recog"), cardKey("words:0001", "prod")], ["words:0001", "words:0001@p"], "cardKey(id, dir)");
  eq([canHaveProd("words:0001"), canHaveProd("user:a@b"), canHaveProd("")], [true, false, false], "canHaveProd: @ を含む ID・空は産出カードを作らない");
  // user: の語の ID は歌詞のトークン（文字・ハイフン・アポストロフィ）から作るので @ を含まない
  ok(tokenize("mail@dominio.com d'água bem-te-vi @p").every((t) => !t.key.includes("@")), "歌詞のトークンに @ は入らない（user: の ID に @ が現れない）");
  const X = w(40);
  eq(recogItem(X), { word: X, dir: "recog", key: X.id }, "recogItem");
  eq(prodItem(X), { word: X, dir: "prod", key: "words:0040@p" }, "prodItem");
  eq([toStudyItem(X), toStudyItem(prodItem(X))], [recogItem(X), prodItem(X)], "toStudyItem: Word は理解カード、StudyItem はそのまま");
}

console.log("=== 産出カード（T2-1）: 対象・候補の順・並べ方 ===");
{
  /** 評価済みで間隔 i 日（期限前）。lastOff = 最後に評価した日（今日からの日数） */
  const learned = (i: number, lastOff = -2) =>
    card({ ease: 2.5, intervalDays: i, reps: 3, level: levelFor(i, 3), last: D(lastOff), due: D(lastOff + i) });
  eq(PROD_MIN_INTERVAL, 7, "産出カードは理解カードの間隔7日以上から");
  const E = fx("words", "PE");
  eq(isProdEligible(E, {}, T), false, "isProdEligible: 理解カードが無い → 対象外");
  eq(isProdEligible(E, { [E.id]: card({ last: null, intervalDays: 10 }) }, T), false, "isProdEligible: 未評価（曲から追加しただけ）→ 対象外");
  eq(isProdEligible(E, { [E.id]: learned(6) }, T), false, "isProdEligible: 間隔6日 → 対象外");
  eq(isProdEligible(E, { [E.id]: learned(7) }, T), true, "isProdEligible: 間隔7日 → 対象");
  eq(isProdEligible(E, { [E.id]: learned(10, 0) }, T), false, "isProdEligible: 理解カードを今日評価 → 今日は対象外（翌日から）");
  eq(isProdEligible(E, { [E.id]: learned(10), [prodKey(E.id)]: learned(3) }, T), true, "isProdEligible: 産出カードの有無は見ない");
  const PN = fx("capoeira", "PE", { pos: "固有名詞（人名）" });
  eq(isProdEligible(PN, { [PN.id]: learned(10) }, T), false, "isProdEligible: 固有名詞 → 対象外");
  const AL: Word = { ...fx("words", "PE"), id: [...ALIAS_IDS][0] };
  eq(isProdEligible(AL, { [AL.id]: learned(10) }, T), false, "isProdEligible: 別名（alias 側）→ 対象外");
  const AT: Word = { ...fx("words", "PE"), id: "user:a@b" };
  eq(isProdEligible(AT, { [AT.id]: learned(10) }, T), false, "isProdEligible: @ を含む ID → 対象外");

  // 候補の順: 理解カードの間隔の長い順 → コア語の順 → 元の並び
  const C = range(5).map(() => fx("words", "PC"));
  const cc = {
    [C[0].id]: learned(8),
    [C[1].id]: learned(20),
    [C[2].id]: learned(8),
    [C[3].id]: learned(8),
    [C[4].id]: learned(30),
    [prodKey(C[4].id)]: learned(3), // 産出カードがもうある
  };
  eq(
    idsOf(prodCandidates([...C, C[0]], cc, T, [C[3].id, C[2].id])),
    [C[1].id, C[3].id, C[2].id, C[0].id],
    "prodCandidates: 間隔の長い順 → コア語の順 → 元の順・産出カードのある語と重複は除く"
  );
  eq(prodCandidates(C, {}, T), [], "prodCandidates: カード無し → []");

  // 均等に散らす
  const b8 = ["1", "2", "3", "4", "5", "6", "7", "8"];
  const frozen = JSON.stringify(b8);
  eq(spreadEvenly(b8, ["a", "b", "c"]).join(""), "12a34b56c78", "spreadEvenly: 8枚に3枚 → 2・4・6枚目の後ろ");
  eq(JSON.stringify(b8), frozen, "spreadEvenly: 入力を変更しない");
  eq(spreadEvenly(["1", "2"], ["a", "b", "c", "d", "e"]).join(""), "1abc2de", "spreadEvenly: 少ない base に多い extra → 先頭は base");
  eq(spreadEvenly(["1"], ["a"]).join(""), "1a", "spreadEvenly: 1枚と1枚");
  eq([spreadEvenly([], ["a"]), spreadEvenly(["1"], [])], [["a"], ["1"]], "spreadEvenly: 片方が空");

  // 同じ語を離す
  const L = range(6).map(() => fx("words", "PL"));
  const sig = (xs: StudyItem[]) => xs.map((x) => (x.dir === "prod" ? "p" : "r") + L.indexOf(x.word)).join(" ");
  const seq1 = [recogItem(L[0]), prodItem(L[0]), ...L.slice(1).map(recogItem)];
  eq(SAME_WORD_GAP, 4, "同じ語の2枚の間は4枚以上");
  eq(sig(separateSameWord(seq1)), "r0 r1 r2 r3 r4 p0 r5", "separateSameWord: 隣の同じ語を4枚後ろへ");
  eq(sig(separateSameWord([recogItem(L[0]), prodItem(L[0]), recogItem(L[1])])), "r0 r1 p0", "separateSameWord: 離しきれなければ末尾へ");
  const plain = [...L.map(recogItem), prodItem(L[5])];
  eq(sig(separateSameWord(plain.slice(0, 5))), sig(plain.slice(0, 5)), "separateSameWord: 同じ語が無ければそのまま");
  eq(sig(separateSameWord(seq1, 0)), sig(seq1), "separateSameWord: gap 0 → そのまま");
}

console.log("=== 産出カード（T2-1）: buildSession ===");
{
  const rv = (dueOff: number, i: number) => card({ ease: 2.5, intervalDays: i, reps: 2, last: D(dueOff - i), due: D(dueOff) });
  const learned = (i: number, lastOff = -2) =>
    card({ ease: 2.5, intervalDays: i, reps: 3, level: levelFor(i, 3), last: D(lastOff), due: D(lastOff + i) });
  const RR = range(4).map(() => fx("words", "PR")); // 理解カードの復習（期限）
  const KN = range(3).map(() => fx("words", "PK")); // 覚えた語（間隔7日以上・期限前）→ 産出カードの候補
  const NN = range(3).map(() => fx("words", "PN")); // 新しい語
  const cardsP: Record<string, SrsCard> = {
    [RR[0].id]: rv(0, 10), // 相対延滞度 0.1
    [RR[1].id]: rv(-5, 2), // 3
    [RR[2].id]: rv(-1, 1), // 2
    [RR[3].id]: rv(0, 1), // 1
    [KN[0].id]: learned(10),
    [KN[1].id]: learned(25),
    [KN[2].id]: learned(7),
  };
  const poolP = [...RR, ...KN, ...NN];
  const baseP = { newLimit: 2, introducedToday: 0, today: T, coreOrder: [] as string[], capoeiraShare: 0 };
  const dirs = (xs: StudyItem[]) => xs.map((x) => (x.dir === "prod" ? "p" : "r")).join("");

  const off = buildSession(poolP, cardsP, baseP);
  eq([off.prodReview, off.prodFresh], [[], []], "production 省略 → 産出カードなし（これまでと同じ）");
  eq(off.items, off.all.map(recogItem), "production 省略 → items は all の理解カード");

  const on = buildSession(poolP, cardsP, { ...baseP, production: true, prodNewLimit: 2 });
  eq(idsOf(on.prodFresh), [KN[1].id, KN[0].id], "新しく始める産出カード: 理解カードの間隔の長い順に上限まで");
  eq(idsOf(on.all), idsOf(off.all), "産出カードがあっても理解カードの出題は変わらない");
  eq(on.items.filter((x) => x.dir === "recog").map((x) => x.word), on.all, "items の理解カードは all の並び");
  eq(on.items.filter((x) => x.dir === "prod").map((x) => x.key), [prodKey(KN[1].id), prodKey(KN[0].id)], "items の産出カードのキーは id@p");
  eq(dirs(on.items), "rrprrprr", "産出カードは理解カードの間に均等に散らす（先頭は理解カード）");
  eq(new Set(on.items.map((x) => x.key)).size, on.items.length, "items のカードキーは重複しない");
  eq(buildSession(poolP, cardsP, { ...baseP, production: true, prodNewLimit: 2, prodIntroducedToday: 1 }).prodFresh.length, 1, "今日始めた産出カードの数を引く");
  eq(buildSession(poolP, cardsP, { ...baseP, production: true, prodNewLimit: 2, prodIntroducedToday: 3 }).prodFresh, [], "産出カードの新規枠を使い切った → 始めない");
  eq(buildSession(poolP, cardsP, { ...baseP, production: true, prodNewLimit: 0 }).prodFresh, [], "上限 0 → 始めない");
  eq(buildSession(poolP, cardsP, { ...baseP, production: false, prodNewLimit: 5 }).prodFresh, [], "production false → 始めない");
  const onlyProd = buildSession(KN, cardsP, { ...baseP, production: true, prodNewLimit: 5 });
  eq([onlyProd.all, dirs(onlyProd.items)], [[], "ppp"], "理解カードが無い日は産出カードだけ");
  const bl = buildSession(poolP, cardsP, { ...baseP, production: true, prodNewLimit: 2, reviewLimit: 3 });
  eq([bl.reason, bl.prodFresh, bl.fresh], ["backlog", [], []], "backlog の日は産出カードも新しく始めない");

  // 期限の来た産出カード: 理解カードの復習と合わせて1日の上限まで（相対延滞度の降順）
  const withProd: Record<string, SrsCard> = {
    ...cardsP,
    [prodKey(KN[0].id)]: rv(-4, 2), // 2.5
    [prodKey(KN[2].id)]: rv(0, 5), // 0.2
  };
  const cmb = buildSession(poolP, withProd, { ...baseP, production: true, prodNewLimit: 5, reviewLimit: 4 });
  eq(idsOf(cmb.review), [RR[1].id, RR[2].id, RR[3].id], "上限4: 理解 3・2・1（延滞の大きい順）");
  eq(idsOf(cmb.prodReview), [KN[0].id], "上限4: 産出 2.5（理解と合わせて延滞の大きい4枚）");
  eq([cmb.dueTotal, cmb.reason, cmb.fresh, cmb.prodFresh], [6, "backlog", [], []], "dueTotal は理解＋産出・超えたら backlog");
  const cmbAll = buildSession(poolP, withProd, { ...baseP, production: true, prodNewLimit: 5 });
  eq(idsOf(cmbAll.prodReview), [KN[0].id, KN[2].id], "上限なし: 期限の産出カードは延滞の大きい順");
  eq(idsOf(cmbAll.prodFresh), [KN[1].id], "産出カードのある語は新しく始めない");
  const used = buildSession(poolP, withProd, { ...baseP, production: true, reviewLimit: 6, reviewedToday: 3 });
  eq(used.review.length + used.prodReview.length, 3, "今日評価した復習（dueReviewed。産出を含む）を上限から引く");
  const offDue = buildSession(poolP, withProd, { ...baseP, reviewLimit: 4 });
  eq([offDue.dueTotal, offDue.prodReview, offDue.review.length, offDue.reason], [4, [], 4, undefined], "産出カードを止めているとき: 期限の産出カードも出さず、上限にも数えない");
  // 今日 again にした産出カードは上限の外
  const rl = buildSession(poolP, { ...withProd, [prodKey(KN[2].id)]: card({ lapses: 1, last: T, due: T }) }, { ...baseP, production: true, reviewLimit: 1 });
  eq([idsOf(rl.review), idsOf(rl.prodReview)], [[RR[1].id], [KN[2].id]], "今日 again にした産出カードは上限の外で出す");

  // 理解カードを今日評価した語は、産出カードを翌日から
  const TD = fx("words", "PT");
  eq(buildSession([TD], { [TD.id]: learned(10, 0) }, { ...baseP, production: true, prodNewLimit: 5 }).prodFresh, [], "理解カードを今日評価した語 → 今日は始めない");
  eq(idsOf(buildSession([TD], { [TD.id]: learned(10, -1) }, { ...baseP, production: true, prodNewLimit: 5 }).prodFresh), [TD.id], "前日に評価した語 → 始める");

  // 同じ語の理解カードと産出カードがどちらも期限 → 理解カードだけ出し、産出カードは明日へ
  // （答えのポルトガル語を見た直後に言わせない。一覧表示・耳だけ復習でも先に答えを見せない。出題方向の設定にもよらない）
  const B = fx("words", "PB");
  const MM = range(6).map(() => fx("words", "PM")); // 延滞の小さい復習（B の後ろに並ぶ）
  const mmCards = Object.fromEntries(MM.map((x) => [x.id, rv(0, 20)]));
  const bothCards = { ...cardsP, ...mmCards, [B.id]: rv(-3, 10), [prodKey(B.id)]: rv(-1, 3) };
  const both = buildSession([...poolP, B, ...MM], bothCards, { ...baseP, production: true, prodNewLimit: 0 });
  ok(idsOf(both.review).includes(B.id), "同じ語の理解・産出がどちらも期限 → 理解カードは出す");
  ok(!idsOf(both.prodReview).includes(B.id), "同じ語の理解カードが今日ある → 産出カードは明日へ");
  eq(both.items.filter((x) => x.word.id === B.id).map((x) => x.dir), ["recog"], "items に同じ語の2枚は入らない");
  eq(both.dueTotal, both.review.length + both.prodReview.length, "明日に回した同じ語の産出カードは dueTotal に数えない");
  eq(
    idsOf(buildSession([B], { [B.id]: learned(10, 0), [prodKey(B.id)]: rv(-1, 3) }, { ...baseP, production: true }).prodReview),
    [],
    "理解カードを今日評価した語 → 期限の産出カードも明日へ"
  );
  eq(
    idsOf(buildSession([B], { [B.id]: learned(10), [prodKey(B.id)]: rv(-1, 3) }, { ...baseP, production: true }).prodReview),
    [B.id],
    "理解カードが今日無い語 → 期限の産出カードを出す"
  );
  eq(
    idsOf(buildSession([B], { [B.id]: learned(10, 0), [prodKey(B.id)]: card({ lapses: 1, last: T, due: T }) }, { ...baseP, production: true }).prodReview),
    [],
    "今日 again にした産出カードでも、理解カードを今日評価した語なら明日へ"
  );

  // 同じ綴り（兄弟グループ）: 理解・産出を通して1日1枚（同じ語の両方が期限のときだけ例外）
  const S1 = fx("words", "PS", { pt: "xablau" }); // 理解カードが期限
  const S2 = fx("capoeira", "PS", { pt: "Xablau" }); // 同じ綴りの別の語。産出カードが期限
  const sb = buildSession([S1, S2], { [S1.id]: rv(0, 3), [S2.id]: learned(10), [prodKey(S2.id)]: rv(-2, 3) }, { ...baseP, production: true, prodNewLimit: 5 });
  eq([idsOf(sb.review), sb.prodReview, sb.prodFresh, sb.dueTotal], [[S1.id], [], [], 1], "同じ綴りの別の語の理解カードが期限 → 産出カードは明日へ（dueTotal にも数えない）");
  const S3 = fx("words", "PS", { pt: "Xablau!" }); // 同じ綴りの新しい語
  const sb2 = buildSession([S3, S2], { [S2.id]: learned(10), [prodKey(S2.id)]: rv(-2, 3) }, { ...baseP, production: true, coreOrder: [S3.id] });
  eq([idsOf(sb2.prodReview), sb2.fresh], [[S2.id], []], "今日の産出カードと同じ綴りの新しい語は出さない");
  const S4 = fx("capoeira", "PS", { pt: "xablau" }); // 覚えた語（産出カードの候補）
  const sb3 = buildSession([S1, S4], { [S1.id]: rv(0, 3), [S4.id]: learned(12) }, { ...baseP, production: true, prodNewLimit: 5 });
  eq([idsOf(sb3.review), sb3.prodFresh], [[S1.id], []], "理解カードで使う綴りの語は、産出カードを始めない");
  const S5 = fx("words", "PS", { pt: "blimbau" });
  const S6 = fx("capoeira", "PS", { pt: "Blimbau" });
  const sb4 = buildSession(
    [S5, S6],
    { [S5.id]: learned(10), [S6.id]: learned(10), [prodKey(S5.id)]: rv(0, 3), [prodKey(S6.id)]: rv(-3, 3) },
    { ...baseP, production: true, prodNewLimit: 5 }
  );
  eq([idsOf(sb4.prodReview), sb4.prodFresh], [[S6.id], []], "同じ綴りの産出カードは1日1枚（延滞の大きい方）");
  const S7 = fx("words", "PS", { pt: "gronga" });
  const S8 = fx("capoeira", "PS", { pt: "Gronga" });
  const sb5 = buildSession(
    [S7, S8],
    { [S7.id]: learned(10), [S8.id]: learned(10), [prodKey(S7.id)]: learned(3, 0) },
    { ...baseP, production: true, prodNewLimit: 5 }
  );
  eq(sb5.prodFresh, [], "今日評価した産出カードと同じ綴りの語は、産出カードを始めない");
}

console.log("=== 産出カード（T2-1）: 予報・集計 ===");
{
  const fw = [w(0), w(1), w(0)];
  const fc = {
    "words:0000": card({ last: D(-1), due: D(1) }),
    "words:0000@p": card({ last: D(-1), intervalDays: 2, reps: 1, due: D(2) }),
    "words:0001@p": card({ last: null, due: T }), // 未評価は数えない
  };
  eq(forecast(fw, fc, T, 3), [1, 0, 0], "forecast: production 省略 → 産出カードは数えない");
  eq(forecast(fw, fc, T, 3, { production: true }), [1, 1, 0], "forecast: production → 産出カードも数える（同じ語でも別の1枚）");
  eq([countDueOn(fw, fc, D(2)), countDueOn(fw, fc, D(2), { production: true })], [1, 2], "countDueOn: production で産出カードも数える");
  eq(
    prodMastery({
      "words:0001": card({ last: T, intervalDays: 30, reps: 5 }), // 理解カードは数えない
      "words:0001@p": card({ last: T, intervalDays: 3, reps: 1 }),
      "words:0002@p": card({ last: D(-1), intervalDays: 10, reps: 2 }),
      "words:0003@p": card({ last: D(-1), intervalDays: 25, reps: 4 }),
      "words:0004@p": card({ last: null }), // 未評価
    }),
    { started: 3, learning: 1, young: 1, mature: 1, canSay: 2 },
    "prodMastery: ポルトガル語で言える語 = 産出カードの定着中＋習得"
  );
  eq(prodMastery({}), { started: 0, learning: 0, young: 0, mature: 0, canSay: 0 }, "prodMastery: カード無し");
}

console.log("=== 産出カード（T2-1）: 1枚ずつ学習（同じ語の理解・産出） ===");
{
  const seen = card({ intervalDays: 10, reps: 3, last: D(-10), due: T });
  const [X, Y, Z, V, U] = [70, 71, 72, 73, 74].map(w);
  const cards = { [X.id]: seen, [Y.id]: seen, [Z.id]: seen, [V.id]: seen, [U.id]: seen, [prodKey(Y.id)]: seen };
  const items = [recogItem(X), prodItem(X), recogItem(Y), prodItem(Y), recogItem(Z), recogItem(V), recogItem(U)];
  const s0 = initSession(items, cards);
  eq(s0.queue.map((q) => `${q.dir}:${q.kind}`), ["recog:test", "prod:test", "recog:test", "prod:test", "recog:test", "recog:test", "recog:test"], "産出カードは紹介しない（カードが無くても test）");
  eq(s0.queue.map((q) => q.cardKey), items.map((x) => x.key), "QItem.cardKey = カードキー");
  eq(s0.queue.map((q) => !!q.newCard), [false, true, false, false, false, false, false], "カードの無い産出カードに newCard の印");
  eq(new Set(s0.queue.map((q) => q.key)).size, 7, "キューの key は一意（同じ語の理解・産出でも）");
  const sig = (s: SessionState) => s.queue.map((q) => `${q.dir[0]}${q.word.id.slice(-2)}`);

  // X の理解 → again、X の産出 → again
  let s = step(step(s0, { t: "reveal" }), { t: "rate", r: "again" });
  s = step(step(s, { t: "reveal" }), { t: "rate", r: "again" });
  eq(s.requeued, { [X.id]: 1, [prodKey(X.id)]: 1 }, "再挿入の回数はカードキーごと（理解と産出が混ざらない）");
  eq(s.again, [X.id, prodKey(X.id)], "again の記録もカードキーごと");
  eq(s.first, { [X.id]: "again", [prodKey(X.id)]: "again" }, "最初の評価もカードキーごと");
  eq(sig(s), ["r70", "p70", "r71", "p71", "r70", "p70", "r72", "r73", "r74"], "同じ語の理解・産出をそれぞれ3枚後に再挿入");
  eq(s.queue.slice(4, 6).map((q) => [q.dir, q.cardKey, q.kind]), [["recog", X.id, "test"], ["prod", prodKey(X.id), "test"]], "再挿入したカードも出題方向とカードキーを保つ");
  // 評価できないカード（紹介になってしまった産出カードなど）があっても止まらないよう、回数を区切る
  for (let guard = 0; !isDone(s) && guard < 50; guard++) s = step(step(s, { t: "reveal" }), { t: "rate", r: "good" });
  ok(isDone(s), "すべて評価して完了（産出カードも表→裏→評価で進む）");
  eq(s.first[X.id], "again", "再出題で合格しても最初の評価は again のまま");
  eq(
    sessionStats(s),
    { reviews: 6, words: 5, newWords: 0, firstCorrect: 4, prod: { reviews: 3, words: 2, firstCorrect: 1, newCards: 1 } },
    "sessionStats: 理解と産出を分けて数える（新しく始めた産出カード1枚）"
  );
  eq(againItems(s).map((x) => [x.dir, x.key]), [["recog", X.id], ["prod", prodKey(X.id)]], "againItems: again だったカード（出題方向つき）");
  const r2 = step(s, { t: "append", items: againItems(s) });
  eq(r2.queue.slice(-2).map((q) => [q.dir, q.cardKey, q.kind]), [["recog", X.id, "test"], ["prod", prodKey(X.id), "test"]], "もう1周: 産出カードは産出カードのまま");
  eq([r2.round, r2.again, r2.requeued], [2, [], {}], "もう1周: again と再挿入回数を数え直す");
  eq(new Set(r2.queue.map((q) => q.key)).size, r2.queue.length, "もう1周の key も一意");

  // 再挿入の上限もカードキーごと
  let m = initSession([recogItem(X), prodItem(X)], cards);
  let n = 0;
  while (!isDone(m) && n < 30) {
    m = step(step(m, { t: "reveal" }), { t: "rate", r: "again" });
    n++;
  }
  eq([n, m.requeued], [8, { [X.id]: MAX_REQUEUE, [prodKey(X.id)]: MAX_REQUEUE }], "再挿入の上限は理解・産出それぞれ3回（計8回出題）");
  ok(!("prod" in sessionStats(initSession([X, Y], cards))), "産出カードが無ければ sessionStats に prod は無い");
}

// ---------------------------------------------------------------------------
console.log("=== クイズの出題（pickForQuiz / weakWords） ===");
{
  // 優先順: 期限到来 → 延滞比の大きい順 → ease の低い順 → 最近 again（last の新しい順）→ 期限前 → 未評価
  const ws = range(13).map(w);
  const cards: Record<string, SrsCard> = {
    "words:0000": card({ ease: 2.5, intervalDays: 10, reps: 3, last: D(-20), due: D(-10) }), // 延滞比 1.1
    "words:0001": card({ ease: 2.5, intervalDays: 10, reps: 3, last: D(-10), due: T }), // 0.1
    "words:0002": card({ ease: 2.5, intervalDays: 1, reps: 1, last: D(-1), due: T }), // 1.0
    "words:0003": card({ ease: 1.8, intervalDays: 1, reps: 2, lapses: 1, last: D(-1), due: T }), // 1.0・ease が低い
    "words:0004": card({ ease: 2.5, intervalDays: 2, reps: 1, last: D(-1), due: D(1) }), // 期限前 0
    "words:0005": card({ ease: 1.5, intervalDays: 10, reps: 3, last: D(-5), due: D(5) }), // 期限前 -0.4（ease が低くても期限前）
    "words:0006": card({ ease: 2.5, intervalDays: 1, reps: 2, last: D(-2), due: D(-1) }), // 2.0
    "words:0007": card({ ease: 2.5, intervalDays: 0, reps: 0, lapses: 1, last: D(-1), due: D(-1) }), // 2.0・again（昨日）
    "words:0008": card({ ease: 2.5, intervalDays: 0, reps: 0, lapses: 0, last: D(-2), due: D(-1) }), // 2.0・again（一昨日）
    "words:0009": card({ ease: 2.5, intervalDays: 0, reps: 0, last: null, due: D(-3) }), // 曲から追加しただけ（未評価）
  };
  const expected = ["0007", "0008", "0006", "0000", "0003", "0002", "0001", "0004", "0005"].map((n) => `words:${n}`);
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const all = pickForQuiz([...ws, ws[2], ws[7]], cards, 50, T, rnd);
  eq(idsOf(all).slice(0, 9), expected, "期限到来 → 延滞比 → ease → 最近 again の順、期限前はその後");
  eq(sortedIds(all.slice(9)), ["words:0009", "words:0010", "words:0011", "words:0012"], "未評価（カード無し・追加しただけ）は最後");
  eq(all.length, 13, "同じ語は1回（プールの重複を除く）");
  eq(idsOf(pickForQuiz(ws, cards, 3, T, rnd)), expected.slice(0, 3), "n 語まで（優先の高い順）");
  eq(pickForQuiz(ws, cards, 0, T), [], "n=0 → []");
  eq(pickForQuiz([], cards, 5, T), [], "空のプール → []");
  // 同じ順位（未評価どうし）は random で混ざる。順位の違う語の並びは random に左右されない
  const orders = new Set<string>();
  for (let k = 0; k < 20; k++) {
    const r = pickForQuiz(ws, cards, 50, T, rnd);
    orders.add(idsOf(r.slice(9)).join(","));
    if (idsOf(r).slice(0, 9).join(",") !== expected.join(",")) orders.add("bad");
  }
  ok(!orders.has("bad") && orders.size > 1, "同順位は random で混ぜ、優先順は変わらない");
  let seedA = 11;
  let seedB = 11;
  const rA = () => (seedA = (seedA * 16807) % 2147483647) / 2147483647;
  const rB = () => (seedB = (seedB * 16807) % 2147483647) / 2147483647;
  eq(idsOf(pickForQuiz(ws, cards, 50, T, rA)), idsOf(pickForQuiz(ws, cards, 50, T, rB)), "同じ乱数なら同じ並び");
  // 延滞比の浮動小数点誤差は同じ値とみなし、ease で決める（(2+1)/3 と 1/1）
  const tie = {
    "words:0000": card({ ease: 2.5, intervalDays: 3, reps: 2, last: D(-5), due: D(-2) }), // 3/3 = 1
    "words:0001": card({ ease: 2.0, intervalDays: 1, reps: 2, last: D(-1), due: T }), // 1/1 = 1
  };
  eq(idsOf(pickForQuiz([w(0), w(1)], tie, 2, T, rnd)), ["words:0001", "words:0000"], "延滞比が同じなら ease の低い順");
  // ease の足し引きの誤差（1.3+0.15+0.15 = 1.5999…）は同じ ease とみなし、最近 again の語を先にする
  const drift = {
    "words:0000": card({ ease: 1.3 + 0.15 + 0.15, intervalDays: 1, reps: 2, last: D(-2), due: D(-1) }),
    "words:0001": card({ ease: 1.6, intervalDays: 0, reps: 0, lapses: 2, last: D(-1), due: D(-1) }),
  };
  eq(idsOf(pickForQuiz([w(0), w(1)], drift, 2, T, rnd)), ["words:0001", "words:0000"], "ease の小数の誤差は同じとみなす");
}
{
  const ws = range(8).map(w);
  const cards: Record<string, SrsCard> = {
    "words:0000": card({ ease: 2.5, lapses: 2, reps: 1, last: D(-1), due: D(3) }), // lapses≥2
    "words:0001": card({ ease: 2.0, lapses: 0, reps: 3, last: D(-1), due: D(3) }), // ease<2.1
    "words:0002": card({ ease: 2.5, lapses: 1, reps: 2, last: D(-1), due: D(3) }), // lapses 1（広げたときだけ）
    "words:0003": card({ ease: 2.5, lapses: 0, reps: 3, last: D(-1), due: D(3) }), // 苦手ではない
    "words:0004": card({ ease: WEAK_EASE, lapses: 0, reps: 3, last: D(-1), due: D(3) }), // ちょうど 2.1 は苦手ではない
    "words:0005": card({ ease: 1.3, lapses: 3, reps: 0, last: null, due: T }), // 未評価は対象外
  };
  eq(WEAK_MIN, 10, "苦手が10語未満なら広げる");
  eq(idsOf(weakWords(ws, cards)), ["words:0000", "words:0001", "words:0002"], "10語未満 → lapses≥1 まで広げる");
  eq(idsOf(weakWords(ws, cards, 2)), ["words:0000", "words:0001"], "min 以上あれば lapses≥2 か ease<2.1 だけ");
  eq(idsOf(weakWords([ws[0], ws[0], ws[1]], cards, 2)), ["words:0000", "words:0001"], "同じ語は1回");
  eq(weakWords(ws, {}), [], "カード無し → []");
  // 苦手が10語以上あれば広げない
  const many = range(12).map((i) => w(100 + i));
  const mc: Record<string, SrsCard> = {};
  many.forEach((x, i) => (mc[x.id] = card({ ease: 2.5, lapses: i < 10 ? 2 : 1, reps: 1, last: D(-1), due: D(2) })));
  eq(weakWords(many, mc).length, 10, "lapses≥2 が10語 → lapses 1 の語は入れない");
}

// ---------------------------------------------------------------------------
// 進捗ストア。Node には localStorage が無いのでメモリ実装を差し込み、保存済みデータを仕込んでから読み込む。
console.log("=== useProgress（純関数） ===");
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

// 将来版（version:2）のデータ。旧版（このビルド = version 1）で開いても消えないこと（前方互換の migrate）
const TODAY = todayStr();
const FUTURE_CARD = card({ ease: 2.2, intervalDays: 7, reps: 2, lapses: 1, level: "young", last: addDays(TODAY, -3), due: addDays(TODAY, 4) });
const FUTURE_HISTORY = { [addDays(TODAY, -3)]: { reviews: 9, newWords: 5, again: 1, act: { drill: { n: 3, sec: 60 } }, futureCount: 7 } };
mem.set(
  "bp-progress-v1",
  JSON.stringify({
    state: {
      cards: { "words:0100": FUTURE_CARD },
      daily: { date: addDays(TODAY, -3), newIntroduced: 5, reviewsDone: 9, studied: 9 },
      streak: 4,
      bestStreak: 9,
      lastStudyDate: addDays(TODAY, -3),
      totalReviews: 120,
      customPassages: [],
      pinnedNew: ["words:0200"],
      history: FUTURE_HISTORY,
      futureField: { x: 1 },
    },
    version: 2,
  })
);

const P = await import("../src/store/useProgress");
const { applyActivity, applyRating, currentStreak, migrateProgress, studiedToday, useProgress } = P;

eq(currentStreak({ streak: 5, lastStudyDate: T }, T), 5, "currentStreak 今日学習済み → streak");
eq(currentStreak({ streak: 5, lastStudyDate: D(-1) }, T), 5, "currentStreak 昨日まで → streak");
eq(currentStreak({ streak: 5, lastStudyDate: D(-2) }, T), 0, "currentStreak 2日前 → 0（途切れ）");
eq(currentStreak({ streak: 0, lastStudyDate: null }, T), 0, "currentStreak 未学習 → 0");
ok(studiedToday({ lastStudyDate: T }, T), "studiedToday 今日 → true");
ok(!studiedToday({ lastStudyDate: D(-1) }, T), "studiedToday 昨日 → false");

{
  const s0 = {
    cards: { "words:0001": EARLY, "words:0002": ADDED, "words:0003": DUE },
    daily: { date: D(-1), newIntroduced: 7, reviewsDone: 30, studied: 31, musicIntroduced: 2 },
    streak: 3,
    bestStreak: 3,
    lastStudyDate: D(-1),
    totalReviews: 50,
    pinnedNew: ["words:0009", "words:0005"],
  };
  const frozen = JSON.stringify(s0);
  const a = applyRating(s0, "words:0009", "good", T);
  eq(norm(a.cards!["words:0009"]), norm(review(card({}), "good", T)), "applyRating 新規語 → カード作成");
  eq(a.daily, { date: T, newIntroduced: 1, reviewsDone: 1, studied: 1, musicIntroduced: 0, dueReviewed: 0, prodIntroduced: 0 }, "applyRating 日付が変われば daily を作り直して加算");
  eq([a.totalReviews, a.streak, a.bestStreak, a.lastStudyDate], [51, 4, 4, T], "applyRating totalReviews と連続記録");
  eq(a.pinnedNew, ["words:0005"], "applyRating 評価した語を pinnedNew から外す");
  eq(JSON.stringify(s0), frozen, "applyRating は入力を変更しない");

  const h = applyRating(s0, "words:0001", "good", T);
  ok(h.cards === s0.cards, "applyRating 据え置き → cards は同じオブジェクト");
  eq([h.totalReviews, h.daily!.reviewsDone], [51, 1], "applyRating 据え置きでも評価回数は数える");
  ok(!("pinnedNew" in h), "applyRating pinnedNew に無い語 → pinnedNew を変えない");

  const m = applyRating({ ...s0, daily: { ...s0.daily, date: T } }, "words:0002", "good", T);
  eq([m.daily!.newIntroduced, m.daily!.musicIntroduced], [7, 3], "applyRating 曲から追加した語 → musicIntroduced を加算（新規枠は消費しない）");
  const same = applyRating({ ...s0, lastStudyDate: T, streak: 3 }, "words:0003", "again", T);
  ok(!("streak" in same), "applyRating 今日学習済みなら連続記録は変えない");

  // dueReviewed（1日の復習の上限の残りを数える）: 期限の来た復習を今日はじめて評価したときだけ +1
  eq(applyRating(s0, "words:0003", "good", T).daily!.dueReviewed, 1, "dueReviewed 期限到来の復習 → +1");
  eq(applyRating(s0, "words:0003", "again", T).daily!.dueReviewed, 1, "dueReviewed 期限到来の again も +1");
  eq(h.daily!.dueReviewed, 0, "dueReviewed 期限前（据え置き）→ 数えない");
  eq(a.daily!.dueReviewed, 0, "dueReviewed 新規語 → 数えない");
  eq(m.daily!.dueReviewed, 0, "dueReviewed 曲から追加しただけの語 → 数えない");
  const again1 = applyRating(s0, "words:0003", "again", T);
  const again2 = applyRating({ ...s0, cards: again1.cards!, daily: again1.daily! }, "words:0003", "good", T);
  eq(again2.daily!.dueReviewed, 1, "dueReviewed 同じ日の再評価（again の後）→ 数えない");
  const oldDaily = { date: T, newIntroduced: 2, reviewsDone: 5, studied: 5 }; // B2-04 より前に保存された daily
  eq(applyRating({ ...s0, daily: oldDaily }, "words:0003", "good", T).daily!.dueReviewed, 1, "dueReviewed 保存済みの daily に無い → 0 から数える");
  eq(
    applyRating({ ...s0, daily: { ...oldDaily, dueReviewed: 7 } }, "words:0003", "hard", T).daily!.dueReviewed,
    8,
    "dueReviewed 同じ日なら加算"
  );
  eq(
    applyRating({ ...s0, daily: { ...oldDaily, date: D(-1), dueReviewed: 7 } }, "words:0003", "hard", T).daily!.dueReviewed,
    1,
    "dueReviewed 日付が変われば数え直す"
  );
}

console.log("=== useProgress（産出カードの評価・純関数） ===");
{
  const K = "words:0003";
  const PK = prodKey(K);
  const s0 = {
    cards: { [K]: DUE } as Record<string, SrsCard>,
    daily: { date: T, newIntroduced: 2, reviewsDone: 5, studied: 5, musicIntroduced: 1, dueReviewed: 3 },
    streak: 1,
    bestStreak: 1,
    lastStudyDate: T,
    totalReviews: 10,
    pinnedNew: [K],
  };
  const frozen = JSON.stringify(s0);
  const a = applyRating(s0, PK, "good", T);
  eq(norm(a.cards![PK]), norm(review(card({}), "good", T)), "新しい産出カード → カードを作る（新規カードと同じ規則）");
  ok(a.cards![K] === s0.cards[K], "理解カードは変えない");
  eq(
    [a.daily!.newIntroduced, a.daily!.prodIntroduced, a.daily!.musicIntroduced, a.daily!.dueReviewed, a.daily!.reviewsDone, a.daily!.studied],
    [2, 1, 1, 3, 6, 6],
    "新しい産出カード → prodIntroduced +1（新規語の枠・曲の枠・dueReviewed は変えない。評価回数は数える）"
  );
  eq(a.history?.[T], { reviews: 1, newWords: 0, again: 0, act: {} }, "新しい産出カード → history の reviews だけ +1（newWords には数えない）");
  eq(a.totalReviews, 11, "totalReviews +1");
  ok(!("pinnedNew" in a), "産出カードの評価で pinnedNew（理解カードの新規指定）は変えない");
  eq(JSON.stringify(s0), frozen, "入力を変更しない");

  const b = applyRating({ ...s0, cards: { ...s0.cards, [PK]: DUE } }, PK, "again", T);
  eq([b.daily!.prodIntroduced, b.daily!.dueReviewed, b.history?.[T]?.again], [0, 4, 1], "期限の来た産出カードの again → dueReviewed・again を数える（prodIntroduced は数えない）");
  eq([b.cards![PK].lapses, b.cards![PK].intervalDays], [1, 0], "産出カードも同じ scheduler（合格済みから落とすと lapses+1）");
  const c = applyRating({ ...s0, cards: { ...s0.cards, [PK]: EARLY } }, PK, "good", T);
  ok(c.cards === s0.cards || c.cards![PK] === EARLY, "期限前の産出カード → 据え置き");
  eq(c.daily!.dueReviewed, 3, "期限前の産出カードは dueReviewed に数えない");
  const d = applyRating({ ...s0, daily: { date: T, newIntroduced: 0, reviewsDone: 0, studied: 0 } }, PK, "hard", T);
  eq(d.daily!.prodIntroduced, 1, "保存済みの daily に prodIntroduced が無い → 0 から数える");
  const e = applyRating({ ...s0, daily: { ...s0.daily, date: D(-1), prodIntroduced: 4 } }, PK, "good", T);
  eq(e.daily!.prodIntroduced, 1, "日付が変われば prodIntroduced も数え直す");
  const f = applyRating({ ...s0, cards: { ...s0.cards, [PK]: card({ last: null, due: T }) } }, PK, "good", T);
  eq([f.daily!.prodIntroduced, f.daily!.musicIntroduced, f.history?.[T]?.newWords], [1, 1, 0], "未評価の産出カード（取り込みなど）→ 新しく始めた扱い（曲の枠は使わない）");
  const g = applyRating(s0, "user:a@b@p", "good", T);
  eq([g.daily!.newIntroduced, g.daily!.prodIntroduced], [3, 0], "@ を含む ID は産出カードのキーとみなさない");
}

console.log("=== useProgress（学習ログ history・純関数） ===");
{
  const s0 = {
    cards: { "words:0002": ADDED, "words:0003": DUE },
    daily: { date: T, newIntroduced: 0, reviewsDone: 0, studied: 0 },
    streak: 2,
    bestStreak: 5,
    lastStudyDate: D(-1),
    totalReviews: 10,
    pinnedNew: [] as string[],
  };
  // history の無い古い状態（B1 の形）でも読める
  const a = applyRating(s0, "words:0009", "good", T);
  eq(a.history, { [T]: { reviews: 1, newWords: 1, again: 0, act: {} } }, "applyRating 新規語 → reviews・newWords +1（history 無し → 作る）");
  const b = applyRating({ ...s0, history: a.history }, "words:0003", "again", T);
  eq(b.history?.[T], { reviews: 2, newWords: 1, again: 1, act: {} }, "applyRating 復習の again → reviews・again +1");
  const c = applyRating({ ...s0, history: b.history }, "words:0002", "good", T);
  eq(c.history?.[T]?.newWords, 2, "applyRating 曲から追加しただけの語 → newWords +1");
  const held = applyRating({ ...s0, cards: { x: EARLY }, history: c.history }, "x", "good", T);
  eq(held.history?.[T]?.reviews, 4, "applyRating 据え置きでも reviews を数える（totalReviews と同じ）");
  const frozen = JSON.stringify(c.history);
  applyRating({ ...s0, history: c.history }, "words:0003", "good", T);
  eq(JSON.stringify(c.history), frozen, "applyRating は history を変更しない");

  // 400 日を超えた日は、その日のキーを新しく作るときに消す
  const old = {
    [D(-400)]: { reviews: 1, newWords: 0, again: 0, act: {} },
    [D(-399)]: { reviews: 2, newWords: 0, again: 0, act: {} },
    [D(-1)]: { reviews: 3, newWords: 0, again: 0, act: {} },
  };
  const p1 = applyRating({ ...s0, history: old }, "words:0003", "good", T);
  eq(Object.keys(p1.history ?? {}).sort(), [D(-399), D(-1), T].sort(), "新しい日を作るとき 400 日より古い日を消す（今日を含めて 400 日）");
  const p2 = applyRating({ ...s0, history: { ...old, [T]: { reviews: 1, newWords: 0, again: 0, act: {} } } }, "words:0003", "good", T);
  ok(!!p2.history?.[D(-400)], "今日のキーが既にあれば古い日は消さない（キーを作るときだけ）");

  // applyActivity（logActivity の本体）
  const q = applyActivity(s0, "dictation", 1, 42, T);
  eq(q?.history?.[T], { reviews: 0, newWords: 0, again: 0, act: { dictation: { n: 1, sec: 42 } } }, "applyActivity 回数と秒数を足す");
  eq([q?.streak, q?.lastStudyDate, q?.bestStreak], [3, T, 5], "applyActivity 練習でも学習日に数える（昨日からの連続）");
  ok(!q || !("daily" in q), "applyActivity は daily（単語の目標）を変えない");
  const q2 = applyActivity({ ...s0, history: q?.history }, "dictation", 2, 8, T);
  eq(q2?.history?.[T]?.act.dictation, { n: 3, sec: 50 }, "applyActivity 同じ日・同じ種類は加算");
  eq(applyActivity(s0, "quiz", 0, 0, T), null, "applyActivity n も sec も 0 → 何もしない（null）");
  eq(applyActivity(s0, "quiz", -3, Number.NaN, T), null, "applyActivity 負の数・NaN は 0 扱い");
  const m1 = applyActivity(s0, "music", 0, 170, T);
  eq([m1?.history?.[T]?.act.music, "lastStudyDate" in (m1 ?? {})], [{ n: 0, sec: 170 }, false], "applyActivity 音楽 170 秒 → 記録するが学習日にしない");
  const m2 = applyActivity({ ...s0, history: m1?.history }, "music", 0, 10, T);
  eq([m2?.history?.[T]?.act.music?.sec, m2?.lastStudyDate, m2?.streak], [180, T, 3], "applyActivity 音楽の合計が 180 秒に達したら学習日");
  const m3 = applyActivity({ ...s0, lastStudyDate: T }, "shadowing", 1, 0, T);
  ok(!!m3 && !("streak" in m3), "applyActivity 今日学習済みなら連続記録は変えない");

  // persist の移行（純関数）
  eq(migrateProgress({ cards: { a: DUE }, streak: 3 }, 0), { cards: { a: DUE }, streak: 3, history: {}, pinnedNew: [] }, "migrate v0 → history {}・pinnedNew [] を補う");
  eq(migrateProgress({ pinnedNew: ["x"], history: { [T]: { reviews: 1 } } }, 0).pinnedNew, ["x"], "migrate v0 でも既にある値は残す");
  const future = { cards: {}, history: { weird: 1 }, futureField: 2 };
  eq(migrateProgress(future, 2), future, "migrate v2（将来版）→ 何も変えずに通す");
  eq(migrateProgress(future, 1), future, "migrate v1 → そのまま");
  eq(migrateProgress(undefined, 0), { history: {}, pinnedNew: [] }, "migrate 保存データなし → 空で補う");
}

console.log("=== activityClock（練習・音楽の時間の積算） ===");
{
  let c = newClock();
  eq(clockTake(c, 1000).sec, 0, "止まっている時計 → 0 秒");
  c = clockRun(c, true, 1000);
  ok(clockRun(c, true, 5000) === c, "同じ状態への切り替えは同じオブジェクト（開始時刻を変えない）");
  let t = clockTake(c, 31_500);
  eq([t.sec, t.clock.acc, t.clock.since, t.clock.running], [30, 500, 31_500, true], "動いている時計: 整数の秒を取り出し、端数 500ms は持ち越す");
  c = clockRun(t.clock, false, 32_000); // 0.5 秒進めて止める（隠れた）
  eq(c.acc, 1000, "止めるとそこまでの ms を貯める");
  c = clockRun(c, true, 100_000); // 隠れていた 68 秒は数えない
  t = clockTake(c, 102_400);
  eq([t.sec, t.clock.acc], [3, 400], "隠れていた間は数えず、再開後の分と貯めた分を合わせる");
  eq(clockTake(clockRun(newClock(), true, 5000), 4000).sec, 0, "時刻が戻っても負にならない");
  eq([elapsedSec(1000, 600, 43_600), elapsedSec(0, 600, 3_600_000), elapsedSec(5000, 600, 1000)], [43, 600, 0], "elapsedSec: 四捨五入・上限・負にならない");
}

console.log("=== 耳だけ復習（handsfree の進め方） ===");
{
  // 手順を短い文字列にして比べる（say:pt@prompt / wait:3000@think / show:1500@answer）
  const sig = (steps: HandsfreeStep[]) => steps.map((s) => (s.t === "say" ? `say:${s.lang}@${s.phase}` : `${s.t}:${s.ms}@${s.phase}`));
  eq(
    sig(handsfreeSteps("pt2ja", 3000, true)),
    ["say:pt@prompt", "wait:3000@think", "say:ja@answer", `wait:${REPEAT_PAUSE_MS}@answer`, "say:pt@repeat"],
    "葡→和（日本語の音声あり）: 葡 → 考える間 → 和 → 600ms → 葡"
  );
  eq(
    sig(handsfreeSteps("pt2ja", 5000, false)),
    ["say:pt@prompt", "wait:5000@think", `show:${JA_SHOW_MS}@answer`, `wait:${REPEAT_PAUSE_MS}@answer`, "say:pt@repeat"],
    "葡→和（日本語の音声なし）: 和は読まずに画面に 1.5 秒"
  );
  eq(
    sig(handsfreeSteps("ja2pt", 2000, true)),
    ["say:ja@prompt", "wait:2000@think", "say:pt@answer", `wait:${REPEAT_PAUSE_MS}@answer`, "say:pt@repeat"],
    "和→葡（日本語の音声あり）: 和 → 考える間 → 葡 → 600ms → 葡"
  );
  eq(
    sig(handsfreeSteps("ja2pt", 3000, false)),
    [`show:${JA_SHOW_MS}@prompt`, "wait:3000@think", "say:pt@answer", `wait:${REPEAT_PAUSE_MS}@answer`, "say:pt@repeat"],
    "和→葡（日本語の音声なし）: 和を画面に出してから考える間"
  );
  eq([JA_SHOW_MS, REPEAT_PAUSE_MS], [1500, 600], "日本語の表示 1.5 秒・もう一度の前の間 600ms");
  ok(NEXT_WORD_MS > 0, "語と語の間がある");
  // 葡→和はどの場合も最初の手順が読み上げ（タップの処理の中で speak できる）
  ok(
    [true, false].every((v) => handsfreeSteps("pt2ja", 3000, v)[0].t === "say"),
    "葡→和の最初の手順は読み上げ（音声の有無によらない）"
  );
  eq(handsfreeSteps("ja2pt", 3000, false)[0].t, "show", "和→葡で日本語の音声が無いときだけ、最初の手順が読み上げでない（無音の発話で始める）");
  ok(
    (["pt2ja", "ja2pt"] as const).every((d) =>
      [true, false].every((v) => {
        const st = handsfreeSteps(d, 3000, v);
        return st[st.length - 1].t === "say" && (st[st.length - 1] as { lang: string }).lang === "pt" && st.filter((x) => x.phase === "think").length === 1;
      })
    ),
    "どの組み合わせも最後は葡をもう一度・考える間は1回"
  );
  eq(handsfreeSteps("pt2ja", -5, true)[1], { t: "wait", ms: 0, phase: "think" }, "考える間が負なら 0");

  // 考える間（設定の秒 → ms）
  eq([...HANDSFREE_GAPS_SEC], [2, 3, 5], "考える間の選択肢は 2 / 3 / 5 秒");
  eq(DEFAULT_HANDSFREE_GAP_SEC, 3, "考える間の既定は 3 秒");
  eq([handsfreeGapMs(2), handsfreeGapMs(3), handsfreeGapMs(5)], [2000, 3000, 5000], "選択肢の秒 → ms");
  eq(
    [handsfreeGapMs(0), handsfreeGapMs(-1), handsfreeGapMs(NaN), handsfreeGapMs("3"), handsfreeGapMs(undefined), handsfreeGapMs(Infinity)],
    [3000, 3000, 3000, 3000, 3000, 3000],
    "数でない・0 以下・無限大 → 既定の 3 秒"
  );
  eq([handsfreeGapMs(0.2), handsfreeGapMs(100), handsfreeGapMs(2.5)], [1000, 10000, 2500], "範囲外は 1〜10 秒に収める・小数はそのまま");
  eq(
    [handsfreeDirection("ja2pt"), handsfreeDirection("pt2ja"), handsfreeDirection("mixed"), handsfreeDirection(undefined)],
    ["ja2pt", "pt2ja", "pt2ja", "pt2ja"],
    "向き: 知らない値は pt2ja"
  );

  // 画面の出し分け
  eq(
    (["prompt", "think", "answer", "repeat"] as const).map(answerShown),
    [false, false, true, true],
    "答えは answer・repeat の段階でだけ出す"
  );

  // 日本語の読み上げ用の整形
  eq(
    [jaForSpeech("〜である（一時的・状態）"), jaForSpeech("決して〜ない"), jaForSpeech("～さん"), jaForSpeech("  こんにちは  （午後） ")],
    ["である（一時的・状態）", "決してない", "さん", "こんにちは （午後）"],
    "jaForSpeech: 〜・～ を消し、空白をまとめる（括弧の注記は audio 側で消す）"
  );
  eq(jaForSpeech("〜"), "", "〜だけの訳 → 空（読まずに画面に出す）");

  // 所要時間の目安
  eq(estimateSec(0, 3000), 0, "0語 → 0 秒");
  eq(estimateSec(1, 3000), Math.round((1200 * 3 + 3000 + REPEAT_PAUSE_MS) / 1000), "1語 → 読み上げ3回＋考える間＋600ms（語と語の間は無い）");
  ok(estimateSec(30, 5000) > estimateSec(30, 2000), "考える間が長いほど長い");

  // 「1枚ずつで確認」の並び（印の語が先頭）
  const ws = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const before = JSON.stringify(ws);
  eq(markedFirst(ws, new Set(["d", "b"])).map((w) => w.id), ["b", "d", "a", "c", "e"], "印の語を先頭に（それぞれ元の並びのまま）");
  eq(markedFirst(ws, new Set()).map((w) => w.id), ["a", "b", "c", "d", "e"], "印が無ければ元の並び");
  eq(markedFirst(ws, new Set(["zzz", "e"])).map((w) => w.id), ["e", "a", "b", "c", "d"], "words に無い id は無視");
  eq(markedFirst(ws, new Set(["a", "b", "c", "d", "e"])).length, 5, "全部に印 → 同じ語数（重複しない）");
  eq(JSON.stringify(ws), before, "入力を変えない");
}

console.log("=== 耳だけ復習（runHandsfree の進行） ===");
{
  const W = [
    { ptForSpeech: "casa", ja: "家" },
    { ptForSpeech: "mesa", ja: "〜のテーブル" },
    { ptForSpeech: "gato", ja: "" },
  ];
  const cfg = (dir: "pt2ja" | "ja2pt", jaVoice: boolean, gapMs = 3000): HandsfreeConfig => ({ dir, gapMs, jaVoice });
  /** 偽の io。読み上げ・待ちはすぐ終わる。stopWhen に当たった呼び出しで止める（signal を abort） */
  function fake(config: () => HandsfreeConfig, ctrl: AbortController, stopWhen?: (ev: string) => boolean) {
    const log: string[] = [];
    const steps: string[] = [];
    const hit = (ev: string) => {
      log.push(ev);
      if (stopWhen?.(ev)) ctrl.abort();
    };
    const io: HandsfreeIO = {
      speak: async (text, lang) => hit(`say:${lang}:${text}`),
      prime: () => hit("prime"),
      wait: (ms, signal) => {
        hit(`wait:${ms}`);
        return signal.aborted ? Promise.reject(new DOMException("aborted", "AbortError")) : Promise.resolve();
      },
      config,
      onWord: (i) => log.push(`word:${i}`),
      onStep: (i, st, info) => steps.push(`${i}:${st.phase}:${info.dir}:${info.jaSpoken ? "voice" : "screen"}`),
      onWordDone: (i) => log.push(`done:${i}`),
    };
    return { io, log, steps };
  }

  {
    const ctrl = new AbortController();
    const f = fake(() => cfg("pt2ja", true), ctrl);
    const p = runHandsfree(W, 0, f.io, ctrl.signal);
    eq(f.log, ["word:0", "say:pt:casa"], "最初の speak は呼び出しの中で同期的に（最初の await の前）");
    const r = await p;
    eq(r, "end", "最後まで読んだら end");
    eq(
      f.log,
      [
        "word:0", "say:pt:casa", "wait:3000", "say:ja:家", "wait:600", "say:pt:casa", "done:0", "wait:1200",
        "word:1", "say:pt:mesa", "wait:3000", "say:ja:のテーブル", "wait:600", "say:pt:mesa", "done:1", "wait:1200",
        "word:2", "say:pt:gato", "wait:3000", "wait:1500", "wait:600", "say:pt:gato", "done:2",
      ],
      "葡→和: 葡 → 考える間 → 和（〜を除く）→ 600ms → 葡、語の間 1.2 秒・最後の語の後は待たない・訳が無い語は画面に 1.5 秒"
    );
    ok(!f.log.includes("prime"), "葡→和では無音の発話を使わない");
    eq(f.steps.filter((s) => s.startsWith("2:")).map((s) => s.split(":").slice(1).join(":")), [
      "prompt:pt2ja:screen", "think:pt2ja:screen", "answer:pt2ja:screen", "answer:pt2ja:screen", "repeat:pt2ja:screen",
    ], "訳が無い語は jaSpoken=false（画面に出す）");
  }
  {
    const ctrl = new AbortController();
    const f = fake(() => cfg("ja2pt", false, 2000), ctrl);
    const p = runHandsfree(W, 0, f.io, ctrl.signal);
    eq(f.log, ["word:0", "prime", "wait:1500"], "和→葡で日本語の音声が無い: 呼び出しの中で無音の発話（prime）を始めてから和を画面に出す");
    await p;
    eq(f.log.filter((e) => e === "prime").length, 1, "prime は始めた語だけ（2語目以降は呼ばない）");
    eq(
      f.log.slice(0, 8),
      ["word:0", "prime", "wait:1500", "wait:2000", "say:pt:casa", "wait:600", "say:pt:casa", "done:0"],
      "和→葡（音声なし）: 和を画面に 1.5 秒 → 考える間 → 葡 → 600ms → 葡"
    );
  }
  {
    const ctrl = new AbortController();
    const f = fake(() => cfg("ja2pt", true), ctrl);
    const p = runHandsfree(W, 1, f.io, ctrl.signal);
    eq(f.log, ["word:1", "say:ja:のテーブル"], "from=1・和→葡（音声あり）: 最初に和を同期で読む");
    const r = await p;
    eq(r, "end", "from から最後まで → end");
    ok(!f.log.includes("word:0") && !f.log.includes("prime"), "from より前の語は読まない・2語目（訳なし）でも prime しない");
    eq(f.log.slice(-7), ["word:2", "wait:1500", "wait:3000", "say:pt:gato", "wait:600", "say:pt:gato", "done:2"], "訳が無い語（和→葡）は和を画面に 1.5 秒");
  }
  {
    // 読み上げの途中で止める（和の答えの読み上げ中）
    const ctrl = new AbortController();
    const f = fake(() => cfg("pt2ja", true), ctrl, (ev) => ev === "say:ja:家");
    const r = await runHandsfree(W, 0, f.io, ctrl.signal);
    eq(r, "aborted", "読み上げ中に止めた → aborted");
    eq(f.log, ["word:0", "say:pt:casa", "wait:3000", "say:ja:家"], "止めた後は何も読まない・待たない");
    ok(!f.log.some((e) => e.startsWith("done:")), "止めた語は聴き終えた数に入れない");
  }
  {
    // 最後の葡（もう一度）の読み上げ中に止める: その語は聴き終えた数に入れない
    const ctrl = new AbortController();
    let says = 0;
    const f = fake(() => cfg("pt2ja", true), ctrl, (ev) => ev === "say:pt:casa" && ++says === 2);
    const r = await runHandsfree(W, 0, f.io, ctrl.signal);
    eq([r, f.log.slice(-2)], ["aborted", ["wait:600", "say:pt:casa"]], "もう一度の葡の途中で止めた → aborted");
    ok(!f.log.includes("done:0"), "最後の葡の途中で止めた語は聴き終えた数に入れない");
  }
  {
    // 考える間の途中で止める（待ちが AbortError で終わる）
    const ctrl = new AbortController();
    const f = fake(() => cfg("pt2ja", true), ctrl, (ev) => ev === "wait:3000");
    const r = await runHandsfree(W, 0, f.io, ctrl.signal);
    eq([r, f.log], ["aborted", ["word:0", "say:pt:casa", "wait:3000"]], "考える間に止めた → aborted・和は読まない");
  }
  {
    // 語と語の間で止める: 1語目は聴き終えた数に入る
    const ctrl = new AbortController();
    const f = fake(() => cfg("pt2ja", true), ctrl, (ev) => ev === "wait:1200");
    const r = await runHandsfree(W, 0, f.io, ctrl.signal);
    eq([r, f.log.slice(-2)], ["aborted", ["done:0", "wait:1200"]], "語と語の間で止めた → 1語目は聴き終えた・2語目は始めない");
  }
  {
    // 設定は語ごとに読み直す（再生中の変更は次の語から）
    const ctrl = new AbortController();
    let n = 0;
    const f = fake(() => (n++ === 0 ? cfg("pt2ja", true, 2000) : cfg("ja2pt", true, 5000)), ctrl);
    await runHandsfree(W.slice(0, 2), 0, f.io, ctrl.signal);
    eq(
      f.log,
      ["word:0", "say:pt:casa", "wait:2000", "say:ja:家", "wait:600", "say:pt:casa", "done:0", "wait:1200",
        "word:1", "say:ja:のテーブル", "wait:5000", "say:pt:mesa", "wait:600", "say:pt:mesa", "done:1"],
      "向き・考える間の変更は次の語から"
    );
  }
  {
    const ctrl = new AbortController();
    const f = fake(() => cfg("pt2ja", true), ctrl);
    eq([await runHandsfree(W, 3, f.io, ctrl.signal), f.log], ["end", []], "from が語数以上 → 何もせず end");
    eq([await runHandsfree([], 0, f.io, ctrl.signal), f.log], ["end", []], "語が無い → 何もせず end");
    const g = fake(() => cfg("pt2ja", true), ctrl);
    await runHandsfree(W.slice(0, 1), -2, g.io, ctrl.signal);
    eq(g.log[1], "say:pt:casa", "from が負 → 0 から");
    const pre = new AbortController();
    pre.abort();
    const h = fake(() => cfg("pt2ja", true), pre);
    eq([await runHandsfree(W, 0, h.io, pre.signal), h.log], ["aborted", []], "始める前に止めてある → 何もせず aborted");
  }
}

console.log("=== 曲の練習（行の後の間・調べた後の再開・自分で訳した行） ===");
{
  eq(GAP_MODES, ["off", "1x", "1.5x"], "行の後の間の選択肢");
  eq(["off", "1x", "1.5x", "2x", undefined, 1].map(gapFactor), [0, 1, 1.5, 0, 0, 0], "gapFactor: 知らない値は 0");
  eq(["1x", "1.5x", "off", "2x", null, 1.5].map(gapMode), ["1x", "1.5x", "off", "off", "off", "off"], "gapMode: 保存値を選択肢に丸める（知らない値は off）");
  eq([GAP_MIN_MS, GAP_MAX_MS], [1000, 15000], "間の下限 1 秒・上限 15 秒");
  eq(
    [gapDelayMs(3, "1x", 1), gapDelayMs(3, "1.5x", 1), gapDelayMs(3, "1x", 0.75), gapDelayMs(2.5, "1.5x", 0.75)],
    [3000, 4500, 4000, 5000],
    "gapDelayMs: 行の長さ×係数÷再生速度（0.75 倍速なら実際に聞こえた長さ）"
  );
  eq([gapDelayMs(0.4, "1x", 1), gapDelayMs(20, "1.5x", 1), gapDelayMs(9, "1.5x", 0.75)], [1000, 15000, 15000], "gapDelayMs: 1〜15 秒に収める");
  eq(
    [gapDelayMs(3, "off", 1), gapDelayMs(0, "1x", 1), gapDelayMs(-2, "1x", 1), gapDelayMs(NaN, "1x", 1), gapDelayMs(Infinity, "1x", 1), gapDelayMs(3, "2x", 1)],
    [0, 0, 0, 0, 0, 0],
    "gapDelayMs: 間なし・長さ 0／負／読めない・知らない係数 → 0（間を置かない）"
  );
  eq([gapDelayMs(3, "1x", 0), gapDelayMs(3, "1x", NaN), gapDelayMs(3, "1x", -1)], [3000, 3000, 3000], "gapDelayMs: 再生速度が読めなければ 1 倍");

  eq(perLineStop(3, true, "off", 1), { kind: "pause" }, "1行停止・間なし → 行の頭で止める（従来どおり）");
  eq(perLineStop(3, false, "off", 1), { kind: "pause" }, "1行停止・間なし → 間奏の行でも止める（従来どおり）");
  eq(perLineStop(3, true, "unknown", 1), { kind: "pause" }, "知らない間の値 → 間なしと同じ");
  eq(perLineStop(3, true, "1x", 1), { kind: "gap", ms: 3000 }, "1行停止・×1 → 聴いた行と同じ長さだけ止めて自動で再開");
  eq(perLineStop(4, true, "1.5x", 0.75), { kind: "gap", ms: 8000 }, "1行停止・×1.5・0.75 倍速 → 4×1.5÷0.75 = 8 秒");
  eq(perLineStop(12, false, "1x", 1), { kind: "continue" }, "1行停止・間あり → 前奏・間奏（歌詞の無い行）の後は止めない");
  eq(perLineStop(0, true, "1x", 1), { kind: "continue" }, "1行停止・間あり → 長さ 0 の行（同じ時刻の行）の後は止めない");

  eq([repeatGapMs(3, true, "1x", 1), repeatGapMs(3, true, "1.5x", 1)], [3000, 4500], "行リピート: 行末で歌った長さ×係数だけ待ってから繰り返す");
  eq([repeatGapMs(3, false, "1x", 1), repeatGapMs(3, true, "off", 1)], [0, 0], "行リピート: 歌詞の無い行・間なし → すぐ繰り返す（従来どおり）");

  const base = { replay: true, synced: true, isCurrent: true, line: 3, lineCount: 10, repeatIdx: null };
  eq(lookupResumeLine(base), 3, "調べた後の再開: 調べた行の頭から");
  eq(
    [
      lookupResumeLine({ ...base, replay: false }),
      lookupResumeLine({ ...base, synced: false }),
      lookupResumeLine({ ...base, isCurrent: false }),
      lookupResumeLine({ ...base, line: null }),
    ],
    [null, null, null, null],
    "設定オフ・時間同期なし・別の曲を再生中・単語タブから開いた → 止めた位置から再開"
  );
  eq(
    [lookupResumeLine({ ...base, line: 10 }), lookupResumeLine({ ...base, line: -1 }), lookupResumeLine({ ...base, line: 1.5 })],
    [null, null, null],
    "行番号が範囲外・整数でない → 止めた位置から再開"
  );
  eq(lookupResumeLine({ ...base, repeatIdx: 5 }), 5, "行リピート中 → リピートしている行の頭へ");
  eq(lookupResumeLine({ ...base, repeatIdx: 12 }), 3, "リピートの行番号が範囲外 → 調べた行");
  eq(lookupResumeLine({ ...base, line: 0 }), 0, "最初の行（0）も戻れる");

  eq(selfTranslatedCount(["a", "b", "c"], { a: true, c: true, z: true }), 2, "自分で訳した行の数（この曲の行だけ数える）");
  eq(selfTranslatedCount(["a"], undefined), 0, "印が無い → 0");
  eq(selfTranslatedCount(["a", "b"], { a: "x" as unknown as true, b: true }), 1, "値が true でない印は数えない");
}

console.log("=== useProgress（ストア・移行・取り消し） ===");
{
  const st = useProgress.getState();
  eq(norm(st.cards["words:0100"]), norm(FUTURE_CARD), "version:2（将来版）のデータも cards を保持（migrate で素通し）");
  eq(st.pinnedNew, ["words:0200"], "version:2 のデータの pinnedNew を保持");
  eq(st.history, FUTURE_HISTORY as unknown, "version:2 のデータの history は中身を変えずに保持（未知の項目も）");
  eq((st as unknown as { futureField?: unknown }).futureField, { x: 1 }, "未知の最上位の項目も捨てない");
  const saved = JSON.parse(mem.get("bp-progress-v1") ?? "{}");
  ok(!!saved.state?.history && !!saved.state?.cards?.["words:0100"] && !!saved.state?.futureField, "書き戻しても history・cards・未知の項目が残る");
  eq(saved.version, 1, "書き戻した version は 1（このビルド）");

  // v0（B1 のビルドが保存したデータ）→ v1: history {} を補い、cards などは保持する
  mem.set(
    "bp-progress-v1",
    JSON.stringify({
      state: {
        cards: { "words:0101": FUTURE_CARD },
        daily: { date: addDays(TODAY, -1), newIntroduced: 1, reviewsDone: 2, studied: 2 },
        streak: 2,
        bestStreak: 6,
        lastStudyDate: addDays(TODAY, -1),
        totalReviews: 50,
        customPassages: [],
      },
      version: 0,
    })
  );
  await useProgress.persist.rehydrate();
  const v0 = useProgress.getState();
  eq(norm(v0.cards["words:0101"]), norm(FUTURE_CARD), "v0 → v1: cards を保持");
  eq([v0.streak, v0.bestStreak, v0.totalReviews], [2, 6, 50], "v0 → v1: 連続記録・評価回数を保持");
  eq([v0.history, v0.pinnedNew], [{}, []], "v0 → v1: history {}・pinnedNew [] を補う");
  const saved0 = JSON.parse(mem.get("bp-progress-v1") ?? "{}");
  eq([saved0.version, saved0.state?.history, !!saved0.state?.cards?.["words:0101"]], [1, {}, true], "v0 → v1: version 1 と history {} で書き戻す");
  // version の項目が無いデータ（手で書いたものなど）: zustand は migrate を通さずそのまま読む。消えないこと
  mem.set("bp-progress-v1", JSON.stringify({ state: { cards: { "words:0102": FUTURE_CARD }, streak: 1, bestStreak: 1, lastStudyDate: null, totalReviews: 1 } }));
  await useProgress.persist.rehydrate();
  eq([!!useProgress.getState().cards["words:0102"], useProgress.getState().history], [true, {}], "version 無し → cards を保持（history は既定値のまま）");
}
{
  const S = () => useProgress.getState();
  S().resetAll();
  mem.clear();
  eq([S().canUndo(), S().undo()], [false, null], "初期状態では取り消せない");

  S().pinNew(["words:0005", "words:0005", "words:0006"]);
  eq(S().pinnedNew, ["words:0005", "words:0006"], "pinNew 重複を除いて追加");
  S().rate("words:0005", "good");
  eq(S().pinnedNew, ["words:0006"], "rate で pinnedNew から外れる");
  ok(!!S().cards["words:0005"], "rate 新規語 → カード作成");
  eq([S().daily.newIntroduced, S().totalReviews, S().streak, S().lastStudyDate], [1, 1, 1, TODAY], "rate カウンタと連続記録");
  eq(S().history[TODAY], { reviews: 1, newWords: 1, again: 0, act: {} }, "rate で今日の history を記録");
  ok(S().canUndo() && S().canUndo("words:0005") && !S().canUndo("words:0006"), "canUndo(id)");
  eq(S().undo(), "words:0005", "undo は id を返す");
  ok(!S().cards["words:0005"], "undo 新規語 → カードを消す");
  eq(S().pinnedNew, ["words:0005", "words:0006"], "undo で pinnedNew も戻る");
  eq([S().daily.newIntroduced, S().totalReviews, S().streak, S().lastStudyDate], [0, 0, 0, null], "undo でカウンタと連続記録も戻る");
  ok(!(TODAY in S().history), "undo その日の最初の評価 → 今日の history のキーも消す");
  eq([S().canUndo(), S().undo()], [false, null], "取り消しは1段だけ");
  S().pinNew(["words:0007"]);
  S().rate("words:0007", "good");
  S().pinNew(["words:0007"]);
  eq(S().pinnedNew, ["words:0005", "words:0006"], "pinNew 評価済みの語は追加しない");

  // 既存カードの取り消し
  const prev = card({ ease: 2.5, intervalDays: 10, reps: 3, last: addDays(TODAY, -10), due: TODAY });
  useProgress.setState({ cards: { ...S().cards, "words:0010": prev } });
  const dr0 = S().daily.dueReviewed ?? 0;
  const h0 = S().history[TODAY];
  S().rate("words:0010", "again");
  eq(S().cards["words:0010"].lapses, 1, "期限到来カードの again → lapses+1");
  eq(S().daily.dueReviewed, dr0 + 1, "rate 期限到来 → dueReviewed +1");
  eq(S().history[TODAY], { reviews: 2, newWords: 1, again: 1, act: {} }, "rate again → 今日の history の reviews・again を加算");
  S().undo();
  eq(S().cards["words:0010"], prev, "undo 既存カード → 評価前に戻る");
  eq(S().daily.dueReviewed ?? 0, dr0, "undo で dueReviewed も戻る");
  eq(S().history[TODAY], h0, "undo で今日の history も評価前に戻る");

  // クイズ
  const studied0 = S().daily.studied;
  eq(S().rateQuiz("words:0300", "good"), "untracked", "rateQuiz 未学習 → untracked");
  ok(!S().cards["words:0300"], "rateQuiz 未学習 → カードを作らない（新規枠を消費しない）");
  eq(S().daily.studied, studied0 + 1, "rateQuiz 未学習 → 練習量は記録");
  eq(S().rateQuiz("words:0007", "again"), "unchanged", "rateQuiz 今日評価済み → unchanged");
  const early = card({ ease: 2.5, intervalDays: 10, reps: 3, last: addDays(TODAY, -2), due: addDays(TODAY, 8) });
  useProgress.setState({ cards: { ...S().cards, "words:0011": early, "words:0012": early, "words:0013": prev } });
  eq(S().rateQuiz("words:0011", "good"), "unchanged", "rateQuiz 期限前の正解 → unchanged");
  eq(S().cards["words:0011"], early, "rateQuiz 期限前の正解 → カードを変えない");
  eq(S().rateQuiz("words:0012", "again"), "lapsed", "rateQuiz 期限前の誤答 → lapsed");
  eq(S().cards["words:0012"].intervalDays, 0, "rateQuiz lapsed → 間隔0");
  S().rate("words:0006", "good");
  eq(S().rateQuiz("words:0013", "good"), "reviewed", "rateQuiz 期限到来の正解 → reviewed");
  eq(S().cards["words:0013"].intervalDays, 25, "rateQuiz reviewed → 間隔を伸ばす");
  ok(!S().canUndo(), "rateQuiz の後は直前の rate を取り消せない");
  // rate 0007・0006 と rateQuiz 0012（lapsed）・0013（reviewed）が評価。rateQuiz 5回すべてをクイズとして記録
  eq(
    S().history[TODAY],
    { reviews: 4, newWords: 2, again: 1, act: { quiz: { n: 5, sec: 0 } } },
    "rateQuiz: SRS に反映した回は reviews/again、どの回も act.quiz に1問"
  );

  const st1 = S().daily.studied;
  S().logPractice(3);
  eq(S().daily.studied, st1 + 3, "logPractice(3)");
  eq(S().lastStudyDate, TODAY, "logPractice で学習日を記録");

  // 練習・音楽の記録（logActivity）
  S().rate("words:0016", "good");
  const st2 = S().daily.studied;
  S().logActivity("dictation", 1, 30);
  eq(S().history[TODAY].act.dictation, { n: 1, sec: 30 }, "logActivity 回数と秒数を今日の history に記録");
  eq(S().daily.studied, st2, "logActivity は daily.studied（単語の目標）を変えない");
  ok(!S().canUndo(), "logActivity で取り消しを破棄（取り消しは今日の history ごと戻すため）");
  S().logActivity("pattern");
  eq(S().history[TODAY].act.pattern, { n: 1, sec: 0 }, "logActivity 既定は n=1・sec=0");
  S().logActivity("quiz", 0, 0);
  eq(S().history[TODAY].act.quiz, { n: 5, sec: 0 }, "logActivity n も sec も 0 → 何もしない");
  useProgress.setState({ lastStudyDate: addDays(TODAY, -1), streak: 3, bestStreak: 3 });
  S().logActivity("music", 0, 120);
  eq([S().history[TODAY].act.music, S().lastStudyDate, S().streak], [{ n: 0, sec: 120 }, addDays(TODAY, -1), 3], "音楽 2 分 → 記録するが学習日にしない");
  S().logActivity("music", 0, 60);
  eq([S().history[TODAY].act.music?.sec, S().lastStudyDate, S().streak, S().bestStreak], [180, TODAY, 4, 4], "音楽の合計 3 分 → 学習日に数え、連続記録を伸ばす");
  useProgress.setState({ lastStudyDate: addDays(TODAY, -1), streak: 3, bestStreak: 4 });
  S().logActivity("shadowing", 1, 12);
  eq([S().lastStudyDate, S().streak], [TODAY, 4], "練習（音楽以外）は1回で学習日に数える");

  // エクスポート / インポート
  const json = S().exportJSON();
  eq(JSON.parse(json).pinnedNew, S().pinnedNew, "exportJSON に pinnedNew を含める");
  eq(JSON.parse(json).history, S().history, "exportJSON に history を含める");
  S().rate("words:0014", "good");
  ok(S().importJSON(JSON.stringify({ cards: {} })), "importJSON 旧形式（pinnedNew・history 無し）");
  eq([S().pinnedNew, S().history], [[], {}], "importJSON pinnedNew・history 無し → []・{}");
  ok(!S().canUndo(), "importJSON で取り消しを破棄");
  ok(S().importJSON(json), "importJSON 書き出したデータ");
  eq(S().pinnedNew, JSON.parse(json).pinnedNew, "importJSON pinnedNew を復元");
  eq(S().history, JSON.parse(json).history, "importJSON history を復元");
  ok(
    S().importJSON(
      JSON.stringify({
        cards: {},
        history: {
          bad: { reviews: 1 },
          [addDays(TODAY, -500)]: { reviews: 3 },
          [TODAY]: { reviews: "x", again: -1, act: { quiz: { n: 2, sec: 5 }, unknownKind: { n: 1, sec: 1 }, chunk: 3 } },
        },
      })
    ),
    "importJSON 形の崩れた history"
  );
  eq(S().history, { [TODAY]: { reviews: 0, newWords: 0, again: 0, act: { quiz: { n: 2, sec: 5 } } } }, "importJSON history: 日付でないキー・400 日より古い日・不正な値・知らない種類を落とす");
  S().rate("words:0015", "good");
  S().resetAll();
  eq([S().pinnedNew, S().canUndo(), Object.keys(S().cards).length, S().history], [[], false, 0, {}], "resetAll で pinnedNew・取り消し・history も消える");
  eq(JSON.parse(mem.get("bp-progress-v1") ?? "{}").version, 1, "保存時の version は 1");
}

console.log("=== useProgress（産出カードの評価と取り消し・ストア） ===");
{
  const S = () => useProgress.getState();
  S().resetAll();
  const K = "words:0020";
  const known = card({ ease: 2.5, intervalDays: 10, reps: 3, level: "young", last: addDays(TODAY, -2), due: addDays(TODAY, 8) });
  useProgress.setState({ cards: { [K]: known } });
  S().rate(prodKey(K), "good");
  ok(!!S().cards[prodKey(K)] && S().cards[K] === known, "rate(産出カードのキー) → 産出カードだけ作る");
  eq([S().daily.prodIntroduced, S().daily.newIntroduced], [1, 0], "rate 新しい産出カード → prodIntroduced（新規語の枠は使わない）");
  ok(S().canUndo(prodKey(K)) && !S().canUndo(K), "canUndo はカードキーで判定（理解カードのキーでは取り消せない）");
  eq(S().undo(), prodKey(K), "undo はカードキーを返す");
  ok(!S().cards[prodKey(K)] && S().cards[K] === known, "undo → 産出カードだけ消え、理解カードは残る");
  eq(S().daily.prodIntroduced ?? 0, 0, "undo → prodIntroduced も戻る");
  S().rate(K, "good");
  S().rate(prodKey(K), "again");
  eq(S().undo(), prodKey(K), "理解カード → 産出カードの順に評価 → 取り消しは産出カードの1段だけ");
  ok(!S().cards[prodKey(K)] && S().cards[K] === known && S().totalReviews === 1, "理解カードの評価（期限前なので据え置き）は残る（評価回数 1）");
  S().resetAll();
}

// ---------------------------------------------------------------------------
// 曲の単語の記録（B1-10）。「この曲から外す」が他の曲で追加した記録と学習履歴を消さないこと
console.log("=== useMusic.removeWord（曲ごとの記録） ===");
{
  const { useMusic } = await import("../src/store/useMusic");
  const S = () => useProgress.getState();
  const M = () => useMusic.getState();
  S().resetAll();
  useMusic.setState({ addedWords: [] });
  // "0600@vidA*" = id 末尾4桁 @ 曲、* は createdCard（この記録がカードを作った）
  const entries = () => M().addedWords.map((a) => `${a.id.slice(-4)}@${a.videoId}${a.createdCard ? "*" : ""}`);
  const X = "words:0600";
  M().addWord(X, "vidA", "x");
  M().addWord(X, "vidB", "x");
  M().addWord("words:0601", "vidA", "y");
  eq(entries(), ["0600@vidA*", "0600@vidB", "0601@vidA*"], "addWord: 最初に追加した曲の記録だけがカードを作る");
  M().removeWord(X, "vidA");
  eq(entries(), ["0600@vidB*", "0601@vidA*"], "removeWord(id, videoId): その曲の記録だけ外し、カードを作った印は残る記録へ引き継ぐ");
  ok(!!S().cards[X], "他の曲に記録が残っていればカードは消さない");
  M().removeWord(X, "vidC");
  eq(entries(), ["0600@vidB*", "0601@vidA*"], "記録の無い曲 → 変更なし");
  M().removeWord(X, "vidB");
  eq(entries(), ["0601@vidA*"], "最後の曲から外す");
  ok(!S().cards[X], "どの曲にも残らず未評価 → カードも消す");

  M().addWord("words:0602", "vidA", "z");
  S().rate("words:0602", "good");
  M().removeWord("words:0602", "vidA");
  ok(!!S().cards["words:0602"], "評価済みのカードは消さない（学習履歴を残す）");
  M().addWord("words:0602", "vidB", "z");
  eq(M().addedWords.find((a) => a.id === "words:0602")?.createdCard, false, "既にカードがある語 → createdCard=false");
  M().removeWord("words:0602", "vidB");
  ok(!!S().cards["words:0602"], "この機能が作っていないカードは消さない");

  M().addWord("words:0603", "vidA", "w");
  M().addWord("words:0603", "vidB", "w");
  M().removeWord("words:0603");
  ok(!M().addedWords.some((a) => a.id === "words:0603") && !S().cards["words:0603"], "videoId 省略 → その語の全記録を外し、未評価のカードも消す");
  eq(entries(), ["0601@vidA*"], "他の語の記録は残る");
  S().resetAll();
  useMusic.setState({ addedWords: [] });

  // T2-1: 取り込みなどで残った未評価の産出カードも一緒に消す（評価済みの産出カードは残す）
  M().addWord("words:0610", "vidA", "q");
  useProgress.setState({ cards: { ...S().cards, "words:0610@p": card({ last: null, due: TODAY }) } });
  M().removeWord("words:0610", "vidA");
  ok(!S().cards["words:0610"] && !S().cards["words:0610@p"], "removeWord: 未評価のカードと一緒に、未評価の産出カードも消す");
  M().addWord("words:0611", "vidA", "q");
  const ratedProd = card({ intervalDays: 3, reps: 1, last: addDays(TODAY, -1), due: addDays(TODAY, 2) });
  useProgress.setState({ cards: { ...S().cards, "words:0611@p": ratedProd } });
  M().removeWord("words:0611", "vidA");
  ok(!S().cards["words:0611"] && S().cards["words:0611@p"] === ratedProd, "removeWord: 評価済みの産出カードは消さない");
  S().resetAll();
  useMusic.setState({ addedWords: [] });

  // B2-13: カポエイラ単語帳で学習中の語を、曲の単語タブ（辞書の見出しが先頭の行）から追加する
  const item: VocabItem = {
    key: "dict:9001",
    ids: ["dict:9001"],
    allIds: ["dict:9001", "capoeira:9002"],
    lemma: "berimbau",
    ja: "ビリンバウ",
    pos: "名詞",
    count: 1,
    surface: "berimbau",
  };
  S().addCard("capoeira:9002");
  S().rate("capoeira:9002", "good");
  M().addWord(addTargetId(item, S().cards), "vidA", item.surface);
  ok(!S().cards["dict:9001"], "別の見出しで学習中 → 辞書の見出しのカードは作らない");
  eq(entries(), ["9002@vidA"], "学習中のカードをこの曲の単語に入れる（createdCard=false）");
  const songIds = new Set(M().addedWords.filter((a) => a.videoId === "vidA").map((a) => a.id));
  eq(bulkAddCandidates([item], S().cards, songIds).length, 0, "一括追加の候補にもならない");
  S().resetAll();
  useMusic.setState({ addedWords: [] });
}

// ---------------------------------------------------------------------------
// 曲の和訳（B3-08）: 自分で訳した行の印はハッシュだけ・機械翻訳の採用・行の後の間の既定値
console.log("=== useMusic（自分で訳した行・機械翻訳の採用・行の後の間） ===");
{
  const { useMusic } = await import("../src/store/useMusic");
  const M = () => useMusic.getState();
  const LINE = "Linha inventada para o teste";
  const H = lineHash(LINE);
  useMusic.setState({ songs: { vidA: { offsetMs: 300, translations: { [H]: { text: "機械の訳", edited: false } } } } });
  M().markSelfTranslated("vidA", H);
  eq(M().songs.vidA, { offsetMs: 300, translations: { [H]: { text: "機械の訳", edited: false } }, selfTranslated: { [H]: true } }, "markSelfTranslated: 行のハッシュに印（同期・和訳はそのまま）");
  const before = M().songs;
  M().markSelfTranslated("vidA", H);
  ok(M().songs === before, "markSelfTranslated: 印のある行にもう一度 → 変えない");
  M().markSelfTranslated("vidA", LINE);
  M().markSelfTranslated("vidA", "Olá");
  eq(Object.keys(M().songs.vidA.selfTranslated ?? {}), [H], "markSelfTranslated: ハッシュの形でないキー（行の本文）は保存しない");
  ok(!JSON.stringify(M().songs).includes(LINE), "曲のデータに行の本文が残らない");
  M().markSelfTranslated("vidB", H);
  eq(M().songs.vidB, { offsetMs: 0, translations: {}, selfTranslated: { [H]: true } }, "markSelfTranslated: まだデータの無い曲にも付けられる");

  M().editTranslation("vidA", H, " 自分の訳 ");
  eq(M().songs.vidA.translations[H], { text: "自分の訳", edited: true }, "自分の訳を保存 → edited");
  eq(M().songs.vidA.selfTranslated, { [H]: true }, "editTranslation でも印は残る");
  M().mergeTranslations("vidA", { [H]: "機械の訳2" });
  eq(M().songs.vidA.translations[H].text, "自分の訳", "手で直した訳は機械翻訳で上書きしない（従来どおり）");
  M().adoptMachineTranslation("vidA", H, " 機械の訳2 ");
  eq(M().songs.vidA.translations[H], { text: "機械の訳2", edited: false }, "機械翻訳を採用 → 手で直した行も機械翻訳の訳（edited: false）に");
  M().adoptMachineTranslation("vidA", H, "  ");
  eq(M().songs.vidA.translations[H].text, "機械の訳2", "空の機械翻訳は採用しない");
  eq([M().songs.vidA.offsetMs, M().songs.vidA.selfTranslated], [300, { [H]: true }], "採用しても同期・印はそのまま");

  // 行の後の間（prefs.gapMode）は DEFAULT_PREFS とのマージで補う（保存データの移行は要らない）
  mem.set(
    "bp-music-v1",
    JSON.stringify({ state: { songs: {}, addedWords: [], userWords: [], prefs: { showKana: false, rate: 0.75, playMode: "one" } }, version: 1 })
  );
  await useMusic.persist.rehydrate();
  eq([M().prefs.gapMode, M().prefs.showKana, M().prefs.rate, M().prefs.playMode], ["off", false, 0.75, "one"], "gapMode の無い保存データ → off で補い、他の設定は保持");
  M().setPrefs({ gapMode: "1.5x" });
  eq(JSON.parse(mem.get("bp-music-v1") ?? "{}").state?.prefs?.gapMode, "1.5x", "gapMode を保存する");
  useMusic.setState({ songs: {}, addedWords: [], userWords: [] });
  M().setPrefs({ gapMode: "off", showKana: true, rate: 1, playMode: "all" });
}

// ---------------------------------------------------------------------------
// 設定ストア。将来版（version:1）の保存データを旧版で開いても消えず、新しいキーは既定値で補われること
console.log("=== useSettings（移行・既定値） ===");
{
  mem.set(
    "bp-settings-v1",
    JSON.stringify({ state: { rate: 0.8, dailyNewLimit: 7, showKana: false, futureKey: "x" }, version: 1 })
  );
  const { useSettings } = await import("../src/store/useSettings");
  const st = useSettings.getState();
  eq([st.rate, st.dailyNewLimit, st.showKana], [0.8, 7, false], "version:1 のデータも保持（migrate で素通し）");
  eq([st.studyView, st.studyDirection, st.autoPlayOnReveal], ["session", "pt2ja", true], "新しいキーは既定値");
  eq([st.capoeiraShare, st.dailyReviewLimit], [0.25, 100], "B2 の新しいキー（capoeiraShare・dailyReviewLimit）も既定値");
  eq([st.handsfreeGapSec, st.handsfreeDirection], [3, "pt2ja"], "B3-07 の新しいキー（耳だけ復習の考える間・向き）も既定値");
  eq(st.replayAfterLookup, true, "B3-08 の新しいキー（調べた後は行の頭から再開）も既定値 true");
  eq(
    [st.productionEnabled, st.dailyProductionNewLimit, st.productionAnswerMode],
    [true, 5, "self"],
    "T2-1 の新しいキー（産出カード: 出す・1日5語・言ってから答えを見る）も既定値"
  );
  eq(st.speechInputEnabled, false, "T2-8 の新しいキー（音声認識の「言ってみる」）は既定でオフ（オプトイン）");
  st.set({ studyView: "list" });
  const saved = JSON.parse(mem.get("bp-settings-v1") ?? "{}");
  eq([saved.version, saved.state?.studyView, saved.state?.rate, saved.state?.futureKey], [0, "list", 0.8, "x"], "書き戻しても既存の値と未知の項目が残る");
}

// ---------------------------------------------------------------------------
// 実データ: 和訳に答えのポルトガル語が書かれている語は産出カードにしない（F1）
console.log("=== 実データ: 産出カードの問いに答えが見える語（glossRevealsAnswer） ===");
{
  const L = await import("../src/data/loadWords");
  const learnedR = (i: number) => card({ ease: 2.5, intervalDays: i, reps: 3, level: levelFor(i, 3), last: D(-2), due: D(i - 2) });
  const capHits = L.WORDS_CAPOEIRA.filter(glossRevealsAnswer).map((x) => x.id);
  for (const id of ["capoeira:0150", "capoeira:0171", "capoeira:0235", "capoeira:0237"])
    ok(capHits.includes(id), `glossRevealsAnswer: ${id}（${L.WORD_BY_ID.get(id)?.pt}）の和訳に答えが書かれている`);
  eq(L.WORDS_GENERAL.filter(glossRevealsAnswer).map((x) => x.id), [], "glossRevealsAnswer: 一般語彙には無い");
  const hino = L.WORD_BY_ID.get("capoeira:0237")!;
  eq(isProdEligible(hino, { [hino.id]: learnedR(10) }, T), false, "isProdEligible: 和訳に答えが見える語（hino）→ 対象外");
  const bad = L.ALL_WORDS.filter((x) => isProdEligible(x, { [x.id]: learnedR(10) }, T) && glossRevealsAnswer(x));
  eq(bad.map((x) => x.id), [], "産出カードの対象語の和訳に答えは書かれていない");
  const plainW = fx("words", "PG", { pt: "casa" });
  eq(glossRevealsAnswer({ ...plainW, ja: "家" }), false, "glossRevealsAnswer: 和訳にラテン文字が無い → false");
  eq(glossRevealsAnswer({ ...plainW, ja: "家（Casa Grande などの Casa）" }), true, "glossRevealsAnswer: 大文字・アクセント違いも答えとみなす");
  eq(glossRevealsAnswer({ ...plainW, ja: "家（英語の house）" }), false, "glossRevealsAnswer: 答えと違うラテン文字は見ない");
}

// ---------------------------------------------------------------------------
// 実データ: コア語（data/core-order.json）・reviewPool・導入順（loadWords は発音生成を読み込むので動的 import）
console.log("=== 実データ: CORE_ORDER・reviewPool・導入順 ===");
{
  const L = await import("../src/data/loadWords");
  const { CORE_ORDER, CORE_DICT_IDS, reviewPool, resolveWord } = L;
  ok(CORE_ORDER.length >= 100, `CORE_ORDER を読み込む（${CORE_ORDER.length}語）`);
  eq(new Set(CORE_ORDER).size, CORE_ORDER.length, "CORE_ORDER に重複なし");
  ok(CORE_ORDER.every((id) => !!resolveWord(id)), "CORE_ORDER の ID はすべて解決できる");
  ok(!CORE_ORDER.some((id) => ALIAS_IDS.has(id)), "CORE_ORDER に別名（alias 側）が無い");
  eq(CORE_DICT_IDS, CORE_ORDER.filter((id) => id.startsWith("dict:")), "CORE_DICT_IDS = コア語の dict の ID");
  ok(CORE_DICT_IDS.length > 0, `コア語に dict がある（${CORE_DICT_IDS.length}語）`);
  const pool0 = reviewPool([]);
  const poolIds = new Set(pool0.map((x) => x.id));
  ok(CORE_DICT_IDS.every((id) => poolIds.has(id)), "reviewPool は曲の追加が無くてもコア語の dict を含む");
  const pool1 = reviewPool([CORE_DICT_IDS[0], "dict:0007"]);
  eq(pool1.length, pool0.length + 1, "reviewPool: 曲から追加した dict とコア語の dict が重複しない");
  eq(new Set(pool1.map((x) => x.id)).size, pool1.length, "reviewPool に重複なし");

  // 導入のシミュレーション（1日15語・カポエイラ 0.25・毎日すべて good）
  const coreSet = new Set(CORE_ORDER);
  const cards: Record<string, SrsCard> = {};
  const days: Word[][] = [];
  for (let d = 0; d < 12; d++) {
    const day = D(d);
    const picks = orderNew(pool0, cards, { limit: 15, capoeiraShare: 0.25, coreOrder: CORE_ORDER, seed: day });
    days.push(picks);
    for (const x of picks) cards[x.id] = card({ intervalDays: 1, reps: 1, last: day, due: addDays(day, 1) });
  }
  const flat = days.flat();
  ok(days.every((p) => p.length === 15), "毎日15語");
  eq(new Set(idsOf(flat)).size, flat.length, "同じ語を2回導入しない");
  ok(!flat.some((x) => /固有名詞/.test(x.pos)), "固有名詞を導入しない");
  ok(!flat.some((x) => ALIAS_IDS.has(x.id)), "別名を導入しない");
  ok(days.every((p) => new Set(p.map((x) => siblingKey(x))).size === p.length), "同じ日に同じ綴りの語を入れない");
  ok(days.every((p) => maxRun(p) <= 2), "毎日、同じカテゴリの連続は2語まで");
  ok(days.every((p) => p.filter(isCapW).length === 3), "毎日カポエイラ語は15語中3語（share 0.25）");
  ok(days[0].every((x) => coreSet.has(x.id)), "1日目はすべてコア語");
  const coreGen = CORE_ORDER.filter((id) => !id.startsWith("capoeira:")).length;
  const genDays = Math.floor(coreGen / 12) - 1; // 一般のコア語が尽きるより前の日
  ok(
    days.slice(0, genDays).every((p) => p.filter((x) => !isCapW(x)).every((x) => coreSet.has(x.id))),
    `一般語は最初の${genDays}日すべてコア語`
  );
  ok(flat.slice(0, 45).some((x) => x.source === "dict"), "コア語の dict も導入する");
  const introducedCore = CORE_ORDER.filter((id) => cards[id]).length;
  ok(introducedCore >= 140, `12日でコア語をほぼ導入（${introducedCore}/${CORE_ORDER.length}）`);
  const opts = { limit: 15, capoeiraShare: 0.25, coreOrder: CORE_ORDER, seed: T };
  eq(idsOf(orderNew(pool0, {}, opts)), idsOf(orderNew(pool0, {}, opts)), "実データ: 同じ日は同じ並び");
}

// ---------------------------------------------------------------------------
// 実データ: 産出カード（T2-1）。ID に @ が無いこと・対象と今日の学習の組み立て
console.log("=== 実データ: 産出カード ===");
{
  const L = await import("../src/data/loadWords");
  const { ALL_WORDS, CORE_ORDER, reviewPool } = L;
  ok(ALL_WORDS.every((x) => canHaveProd(x.id)) && CORE_ORDER.every(canHaveProd), "単語帳・コア語の ID に @ が無い（産出カードのキーと紛れない）");
  ok(ALL_WORDS.every((x) => !isProdKey(x.id)), "単語帳の ID は産出カードのキーに見えない");
  const pool = reviewPool([]);
  // 最初の200語を「間隔10日・2日前に評価」にして、産出カードの候補と今日の学習を作る
  const cards: Record<string, SrsCard> = {};
  const known = () => card({ ease: 2.5, intervalDays: 10, reps: 3, level: "young", last: D(-2), due: D(8) });
  const proper = pool.filter((x) => /固有名詞/.test(x.pos)).slice(0, 10);
  const aliases = pool.filter((x) => ALIAS_IDS.has(x.id)).slice(0, 10);
  for (const x of [...pool.slice(0, 200), ...proper, ...aliases]) cards[x.id] = known();
  ok(proper.length > 0 && aliases.length > 0, `前提: 学習済みの固有名詞 ${proper.length}語・別名 ${aliases.length}語`);
  const cand = prodCandidates(pool, cards, T, CORE_ORDER);
  ok(cand.length > 0 && cand.every((x) => cards[x.id] && !/固有名詞/.test(x.pos) && !ALIAS_IDS.has(x.id)), `候補（${cand.length}語）に固有名詞・別名・未学習の語が無い`);
  ok([...proper, ...aliases].every((x) => !isProdEligible(x, cards, T)), "学習済みでも固有名詞・別名は産出カードの対象外");
  const plan = buildSession(pool, cards, {
    newLimit: 15,
    introducedToday: 0,
    today: T,
    coreOrder: CORE_ORDER,
    capoeiraShare: 0.25,
    reviewLimit: 100,
    production: true,
    prodNewLimit: 5,
  });
  eq(plan.prodFresh.length, 5, "実データ: 産出カードを1日5語始める");
  eq(plan.items.length, plan.all.length + plan.prodReview.length + plan.prodFresh.length, "items = 理解カード＋産出カード");
  const wordIds = new Set(plan.items.map((x) => x.word.id));
  eq(new Set(plan.items.map((x) => siblingKey(x.word))).size, wordIds.size, "実データ: 理解・産出を通して、同じ綴りの別の語は1日1枚");
  ok(plan.items.slice(0, 1).every((x) => x.dir === "recog"), "実データ: 先頭は理解カード");
}

// ---------------------------------------------------------------------------
// 実データ: カポエイラ語の訳の分割（読みを外して解説へ）と、クイズの誤答
console.log("=== 実データ: カポエイラ訳の分割・クイズの誤答 ===");
{
  const L = await import("../src/data/loadWords");
  const { splitKanaGloss, makeWord, WORDS_CAPOEIRA, WORDS_GENERAL, ALL_WORDS, resolveWord } = L;

  // 純関数
  eq(splitKanaGloss("ジンガ（基本のステップ）"), { ja: "基本のステップ", note: "ジンガ（基本のステップ）" }, "splitKanaGloss: 読み（意味）→ 意味と解説");
  eq(
    splitKanaGloss("ケダ・ジ・ヒン（肘を脇腹（腎臓あたり）に当てる）").ja,
    "肘を脇腹（腎臓あたり）に当てる",
    "splitKanaGloss: 括弧の中の括弧はそのまま"
  );
  eq(splitKanaGloss("ピアォン・ジ·カベッサ（「頭上独楽」）").ja, "「頭上独楽」", "splitKanaGloss: 半角の中黒（·）も読みの一部");
  eq(splitKanaGloss("メストリ・トニー"), { ja: "メストリ・トニー" }, "splitKanaGloss: 括弧なしはそのまま");
  eq(splitKanaGloss("アウー（アウー・フェシャード）"), { ja: "アウー（アウー・フェシャード）" }, "splitKanaGloss: 括弧の中もカタカナだけならそのまま");
  eq(splitKanaGloss("足（足首から下）"), { ja: "足（足首から下）" }, "splitKanaGloss: 先頭が読みでなければそのまま");
  eq(splitKanaGloss("シルクのスカーフ（レンソ・ジ・セーダ）"), { ja: "シルクのスカーフ（レンソ・ジ・セーダ）" }, "splitKanaGloss: 意味（読み）の形はそのまま");
  const raw = { カテゴリ: "x", ポルトガル語: "ginga", 日本語: "ジンガ（基本のステップ）", 品詞: "名詞" };
  eq(makeWord(raw, "words", 0).ja, "ジンガ（基本のステップ）", "makeWord: words の訳は分けない");
  ok(!("note" in makeWord(raw, "words", 0)), "makeWord: 分けない語に note は付かない");
  eq([makeWord(raw, "capoeira", 0).ja, makeWord(raw, "capoeira", 0).note], ["基本のステップ", "ジンガ（基本のステップ）"], "makeWord: capoeira は分ける");

  // 実データ（データは書き換えず、実行時だけ分ける）
  const withNote = WORDS_CAPOEIRA.filter((x) => x.note);
  eq(withNote.length, 150, `カポエイラ語の訳の分割: ${withNote.length}語（形の一致149語＋半角中黒1語）`);
  ok(!WORDS_GENERAL.some((x) => x.note), "一般語には解説を付けない");
  const capRaw = capoeiraRaw as { 日本語: string }[];
  ok(withNote.every((x) => x.note === capRaw[x.index].日本語 && x.ja !== x.note), "解説 = 元の訳（生データのまま）");
  eq(resolveWord("capoeira:0040")?.ja, "カポエイラの基本となるリズミカルな左右のステップ動作", "ginga の訳から読み（ジンガ）を外す");
  ok(capRaw[40].日本語.startsWith("ジンガ（"), "capoeira-words.json は書き換えない");
  const kanaOnly = /^[\p{Script=Katakana}・ー·･\s]+$/u;
  ok(
    WORDS_CAPOEIRA.filter((x) => kanaOnly.test(x.ja)).every(isProperNoun),
    "訳がカタカナの読みだけの語は固有名詞だけ（和→葡では出題しない）"
  );

  // クイズの誤答（誤答の候補は単語帳の全語）
  ok(!ALL_WORDS.filter(askableByJa).some((x) => /固有名詞/.test(x.pos)), "和→葡の出題候補に固有名詞が無い");
  const w0931 = resolveWord("words:0931")!; // ao invés de（〜の代わりに）
  const w0934 = resolveWord("words:0934")!; // em vez de（〜の代わりに）
  eq(exclusionLevel(w0931, w0934), 1, "ao invés de と em vez de は訳が重なる（互いの誤答にしない）");
  eq(exclusionLevel(resolveWord("words:0001")!, resolveWord("words:0954")!), 2, "Bom dia と bom dia は同じ綴り");
  const wordsRoda = WORDS_GENERAL.find((x) => x.pt === "roda");
  if (wordsRoda) eq(exclusionLevel(resolveWord("capoeira:0063")!, wordsRoda), 2, "roda（ホーダ）と roda（車輪）は同じ綴りのグループ");
  eq(exclusionLevel(resolveWord("capoeira:0000")!, resolveWord("capoeira:0005")!), 0, "メストリ同士は「カポエイラ」の片だけでは重ならない");
  // 性質テスト: 全語に対して、3つ・正解なし・表示の重複なし・除外の段階0だけ（候補が多いので緩めない）
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let bad = 0;
  let relaxed = 0;
  for (const side of ["pt", "ja"] as const) {
    for (const x of ALL_WORDS) {
      const d = pickDistractors(x, ALL_WORDS, side, { random: rnd });
      const keys = new Set([x, ...d].map((c) => choiceKey(c, side)));
      if (d.length !== 3 || d.some((c) => c.id === x.id) || keys.size !== 4) bad++;
      if (d.some((c) => exclusionLevel(x, c) > 0)) relaxed++;
    }
  }
  eq([bad, relaxed], [0, 0], "全語で誤答3つ・正解や重複なし・もう1つの正解に見える語なし（pt/ja 両方）");
  let tier0 = 0;
  let total = 0;
  for (const x of ALL_WORDS) {
    for (const c of pickDistractors(x, ALL_WORDS, "ja", { random: rnd })) {
      total++;
      if (distractorTier(x, c) === 0) tier0++;
    }
  }
  ok(tier0 / total > 0.9, `誤答の9割以上が同品詞×同カテゴリ（${tier0}/${total}）`);
}

// ---------------------------------------------------------------------------
// 実データ: デッキの語（Flashcards と Quiz の /quiz/:deckId で共通）
console.log("=== 実データ: 曲の単語タブ（辞書とカポエイラ単語帳の同じ綴り） ===");
{
  const Mu = await import("../src/data/music");
  const { tokenize } = await import("../src/services/lemmatize");
  const lem = createLemmatizer({
    entries: Mu.lexiconEntries(),
    irregular: irregularRaw as unknown as IrregularTable,
    colloquial: colloquialRaw as unknown as ColloquialTable,
  });
  // berimbau: 辞書（dict）が先頭の見出し。カポエイラ単語帳は和訳が違うので ids に入らない → allIds で見る
  const b = buildVocabItems(lem, [lem.analyzeLine("berimbau")], () => undefined).items[0];
  const capId = b?.allIds.find((id) => id.startsWith("capoeira:"));
  ok(!!b && b.ids[0].startsWith("dict:") && !!capId && !b.ids.includes(capId), "berimbau: 先頭は辞書、カポエイラ単語帳の見出しは allIds にだけある");
  if (b && capId) {
    const cards = { [capId]: card({ last: T, intervalDays: 3, reps: 2 }) };
    eq([statusId(b, cards), addTargetId(b, cards)], [capId, capId], "berimbau: カポエイラ単語帳のカードで学習中・追加もそのカード");
    eq(bulkAddCandidates([b], cards, new Set()).length, 0, "berimbau: 一括追加から除く");
    const refs = lem.lookup("berimbau").candidates[0].refs;
    const sib = siblingCard([b.ids[0]], refs, cards);
    eq(sib && [sib.ref.id, siblingNote(sib.ref.id, sib.card)], [capId, "カポエイラ単語帳で学習中"], "WordSheet: 辞書の意味に「カポエイラ単語帳で学習中」の注記");
  }
  // 全見出しの語で: ids ⊆ allIds、allIds に重複なし、別の見出しのカードで学習中なら状況・追加ともそのカード
  const keys = new Set<string>();
  for (const e of Mu.lexiconEntries()) for (const t of tokenize(e.pt)) keys.add(t.key);
  const all = buildVocabItems(lem, [...keys].map((k) => tokenize(k)), () => undefined).items;
  ok(all.length > 1000, `全見出しから行を作れる（${all.length} 行）`);
  ok(
    all.every((i) => i.ids.length > 0 && i.ids.every((id) => i.allIds.includes(id)) && new Set(i.allIds).size === i.allIds.length),
    "ids ⊆ allIds・allIds に重複なし"
  );
  const wider = all.filter((i) => i.allIds.length > i.ids.length);
  ok(wider.length > 50, `同じ綴りで別の見出しがある行（${wider.length} 行）`);
  const bad = wider.filter((i) => {
    const other = i.allIds[i.allIds.length - 1];
    const cards = { [other]: card({ last: T, intervalDays: 1, reps: 1 }) };
    return statusId(i, cards) !== other || addTargetId(i, cards) !== other || bulkAddCandidates([i], cards, new Set()).length !== 0;
  });
  eq(bad.map((i) => i.lemma).slice(0, 5), [], "別の見出しで学習中 → どの行でも学習中と判定し、そのカードに追加し、一括追加から除く");
}

// ---------------------------------------------------------------------------
// 実データ: カポエイラ語のカテゴリの付け替え（data/capoeira-category-map.json。語と ID は変えない）
console.log("=== 実データ: カポエイラのカテゴリの付け替え ===");
{
  const L = await import("../src/data/loadWords");
  const { WORDS_CAPOEIRA, WORDS_GENERAL, DECKS_CAPOEIRA, CAPOEIRA_CATEGORY_MAP, capoeiraCategory, categoriesOf, makeWord, resolveWord, CORE_ORDER, reviewPool } = L;
  const capRaw = capoeiraRaw as { カテゴリ: string; ポルトガル語: string }[];
  eq(WORDS_CAPOEIRA.length, capRaw.length, "カポエイラ語の数は変わらない");
  ok(
    WORDS_CAPOEIRA.every((x, i) => x.id === `capoeira:${String(i).padStart(4, "0")}` && x.index === i && x.pt === capRaw[i].ポルトガル語),
    "ID・並び・綴りは変わらない（ソース内インデックス基準のまま）"
  );
  ok(WORDS_CAPOEIRA.every((x, i) => x.category === (CAPOEIRA_CATEGORY_MAP.get(capRaw[i].カテゴリ) ?? capRaw[i].カテゴリ)), "カテゴリは付け替え表どおり（表に無いカテゴリはそのまま）");
  eq(CAPOEIRA_CATEGORY_MAP.size, 7, "付け替え表は7件（_comment は読まない）");
  eq(
    [...CAPOEIRA_CATEGORY_MAP.keys()].filter((k) => !capRaw.some((w) => w.カテゴリ === k)),
    [],
    "付け替え表のキーはすべて実在するカテゴリ"
  );
  const cats = categoriesOf("capoeira");
  ok(!cats.some((c) => CAPOEIRA_CATEGORY_MAP.has(c)), `付け替え元のカテゴリはもう出ない（${cats.length} カテゴリ）`);
  eq(cats.length, new Set(capRaw.map((w) => capoeiraCategory(w.カテゴリ))).size, "カテゴリ一覧 = 付け替え後のカテゴリ（出現順・重複なし）");
  const count = (c: string) => WORDS_CAPOEIRA.filter((x) => x.category === c).length;
  eq(
    ["基本動作・技術", "状態・方向・評価", "日常・その他", "カポエイラ基本・文化・制度", "動作を表す動詞"].map(count),
    [15, 17, 5, 22, 13],
    "まとめたカテゴリの語数（14+1・12+5・2+3・15+7・13）"
  );
  // デッキ: どの語もちょうど1つのデッキに入り、デッキは50語まで、ID は重複しない
  const inDecks = DECKS_CAPOEIRA.flatMap((d) => d.words.map((x) => x.id));
  eq([inDecks.length, new Set(inDecks).size], [WORDS_CAPOEIRA.length, WORDS_CAPOEIRA.length], "カポエイラのデッキ: 全語がちょうど1回");
  ok(DECKS_CAPOEIRA.every((d) => d.words.length <= 50 && d.words.every((x) => x.category === d.category)), "カポエイラのデッキ: 50語まで・同じカテゴリの語だけ");
  eq(new Set(DECKS_CAPOEIRA.map((d) => d.id)).size, DECKS_CAPOEIRA.length, "カポエイラのデッキ: ID に重複なし");
  eq(
    DECKS_CAPOEIRA.map((d) => d.category).filter((c, i, a) => a.indexOf(c) === i),
    cats,
    "カポエイラのデッキの並び = カテゴリの出現順"
  );
  // 一般語彙・ユーザー語には効かない
  const raw = { カテゴリ: "基本動作", ポルトガル語: "x", 日本語: "j", 品詞: "名詞" };
  eq([makeWord(raw, "words", 0).category, makeWord(raw, "dict", 0).category, makeWord(raw, "capoeira", 0).category], ["基本動作", "基本動作", "基本動作・技術"], "付け替えはカポエイラ語だけ");
  eq(capoeiraCategory("未知のカテゴリ"), "未知のカテゴリ", "表に無いカテゴリはそのまま");
  const genRaw = (await import("../data/words.json")).default as { カテゴリ: string }[];
  ok(WORDS_GENERAL.length === genRaw.length && WORDS_GENERAL.every((x, i) => x.category === genRaw[i].カテゴリ), "一般語彙のカテゴリはそのまま");
  eq(resolveWord("capoeira:0158")?.category, "基本動作・技術", "capoeira:0158（元は「基本動作」）は「基本動作・技術」のデッキへ");
  // 導入順: カポエイラ語のカテゴリの巡回は、まとめた後のカテゴリで数える（1回の選出で1カテゴリ4語まで）
  const pool = reviewPool([]);
  const picks = orderNew(pool, {}, { limit: 24, capoeiraShare: 1, coreOrder: [], seed: T });
  const perCat = new Map<string, number>();
  for (const x of picks) perCat.set(x.category, (perCat.get(x.category) ?? 0) + 1);
  ok(
    picks.length === 24 && picks.every(isCapW) && [...perCat.values()].every((n) => n <= 4) && [...perCat.keys()].every((c) => cats.includes(c)),
    `導入順: カポエイラ語だけ24語 → まとめたカテゴリごとに4語まで（${[...perCat].map(([c, n]) => `${c}:${n}`).join(" ")}）`
  );
  ok(maxRun(picks) <= 2, "導入順: 同じカテゴリの連続は2語まで");
  const withCore = orderNew(pool, {}, { limit: 15, capoeiraShare: 0.25, coreOrder: CORE_ORDER, seed: T });
  ok(withCore.filter(isCapW).length === 3 && withCore.filter(isCapW).every((x) => !CAPOEIRA_CATEGORY_MAP.has(x.category)), "導入順（実際の設定）: カポエイラ語3語・付け替え元のカテゴリは出ない");
}

console.log("=== 実データ: parseDeckId / resolveDeckWords / deckTitle ===");
{
  const L = await import("../src/data/loadWords");
  const { ALL_DECKS, parseDeckId, resolveDeckWords, deckTitle, userWordMap } = L;
  eq(parseDeckId("today"), { kind: "today" }, "today");
  eq(parseDeckId("music"), { kind: "music", videoId: null }, "music");
  eq(parseDeckId("music:abc"), { kind: "music", videoId: "abc" }, "music:<videoId>");
  eq(parseDeckId("0")?.kind, "deck", "番号");
  eq(
    ["", "-1", "1.5", "abc", String(ALL_DECKS.length), "1e3"].map((x) => parseDeckId(x)),
    [null, null, null, null, null, null],
    "知らない ID・範囲外は null（空文字を 0 番にしない）"
  );
  eq(resolveDeckWords("0", []), ALL_DECKS[0].words, "番号のデッキ = ALL_DECKS の語");
  eq(resolveDeckWords("today", []), null, "今日の学習はデッキとしては解決しない");
  eq(resolveDeckWords("nope", []), null, "知らない ID は null");
  const added = [
    { id: "words:0001", videoId: "v1" },
    { id: "dict:0007", videoId: "v2" },
    { id: "words:0001", videoId: "v2" },
    { id: "user:xyz", videoId: "v1" },
    { id: "dict:9999999", videoId: "v1" },
  ];
  const um = userWordMap([{ id: "user:xyz", pt: "xyz", ja: "テスト", pos: "名詞" }]);
  eq(idsOf(resolveDeckWords("music", added, um)!), ["words:0001", "dict:0007", "user:xyz"], "music: 全曲の語（重複なし・解決できない ID は除く）");
  eq(idsOf(resolveDeckWords("music:v2", added, um)!), ["dict:0007", "words:0001"], "music:<videoId>: その曲の語");
  eq(resolveDeckWords("music:none", added, um), [], "語の無い曲は []");
  eq(idsOf(resolveDeckWords("music", added)!), ["words:0001", "dict:0007"], "userMap が無ければ user 語は解決しない");
  const d0 = ALL_DECKS[0];
  eq(deckTitle("0"), d0.totalParts > 1 ? `${d0.category} (${d0.part}/${d0.totalParts})` : d0.category, "番号のデッキの見出し");
  const multi = ALL_DECKS.findIndex((d) => d.totalParts > 1);
  if (multi >= 0) eq(deckTitle(String(multi)), `${ALL_DECKS[multi].category} (1/${ALL_DECKS[multi].totalParts})`, "分割したデッキは (n/m) を付ける");
  eq(deckTitle("music:v1", (v) => (v === "v1" ? "曲A" : undefined)), "🎵 曲A", "曲のデッキは曲名");
  eq(deckTitle("music:v9", () => undefined), "🎵 曲の単語", "曲名が無ければ「曲の単語」");
  eq([deckTitle("music"), deckTitle("today"), deckTitle("x")], ["🎵 曲の単語", "今日の学習", null], "music・today・不明");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
