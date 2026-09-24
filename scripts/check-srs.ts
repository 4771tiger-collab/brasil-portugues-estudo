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
import { buildSession, dueWords, forecast, masteryBreakdown } from "../src/srs/queue";
import {
  AGAIN_GAP,
  INTRO_GAP,
  MAX_REQUEUE,
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
console.log("=== buildSession（pinned） ===");
function w(i: number): Word {
  const id = `words:${String(i).padStart(4, "0")}`;
  return { id, source: "words", index: i, category: "c", pt: `p${i}`, ja: `j${i}`, pos: "名詞", ptForSpeech: `p${i}`, kana: "", ipa: "" };
}
{
  const words = [0, 1, 2, 3, 4, 5].map(w);
  const cards = { "words:0001": card({ intervalDays: 3, reps: 1, last: "2026-09-21", due: T }) };
  const ids = (ws: Word[]) => ws.map((x) => x.id);
  const base = { newLimit: 3, introducedToday: 0, today: T };
  eq(ids(buildSession(words, cards, base).fresh), ["words:0000", "words:0002", "words:0003"], "pinned 無し → ファイル順");
  const pinned = ["words:0004", "words:0001", "words:0004", "words:9999", "words:0002"];
  const s = buildSession(words, cards, { ...base, pinned });
  eq(ids(s.fresh), ["words:0004", "words:0002", "words:0000"], "pinned（カード無しのみ・重複除去）が先頭");
  eq(ids(s.review), ["words:0001"], "カード作成済みの pinned は復習側のまま");
  eq(ids(s.all), ["words:0001", "words:0004", "words:0002", "words:0000"], "all = 復習 + 新規");
  eq(ids(buildSession(words, cards, { ...base, introducedToday: 2, pinned }).fresh), ["words:0004"], "新規枠の残りが1なら pinned の先頭だけ");
  eq(ids(buildSession(words, cards, { ...base, introducedToday: 3, pinned }).fresh), [], "新規枠が尽きたら pinned も出さない");
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
  const r2 = step(one, { t: "append", words: [w(0)] });
  eq([isDone(r2), r2.round, r2.again, r2.requeued, currentItem(r2)?.kind], [false, 2, [], {}, "test"], "append: 末尾に test・again と再挿入回数は数え直し");
  eq(r2.first, one.first, "append: first は変えない");
  eq(new Set(r2.queue.map((q) => q.key)).size, 5, "append の key も一意");
  const r3 = step(step(r2, { t: "reveal" }), { t: "rate", r: "again" });
  eq([r3.queue.length, r3.again], [6, ["words:0000"]], "2周目も again で再挿入できる");
  ok(step(one, { t: "append", words: [] }) === one, "append 空 → 変更なし");

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

// 将来版（version:1）のデータ。旧版（このビルド）で開いても消えないこと（前方互換の migrate）
const TODAY = todayStr();
const FUTURE_CARD = card({ ease: 2.2, intervalDays: 7, reps: 2, lapses: 1, level: "young", last: addDays(TODAY, -3), due: addDays(TODAY, 4) });
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
      history: { [addDays(TODAY, -3)]: { reviews: 9, newWords: 5, again: 1, act: {} } },
    },
    version: 1,
  })
);

const P = await import("../src/store/useProgress");
const { applyRating, currentStreak, studiedToday, useProgress } = P;

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
  eq(a.daily, { date: T, newIntroduced: 1, reviewsDone: 1, studied: 1, musicIntroduced: 0 }, "applyRating 日付が変われば daily を作り直して加算");
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
}

console.log("=== useProgress（ストア・移行・取り消し） ===");
{
  const st = useProgress.getState();
  eq(norm(st.cards["words:0100"]), norm(FUTURE_CARD), "version:1 のデータも cards を保持（migrate で素通し）");
  eq(st.pinnedNew, ["words:0200"], "version:1 のデータの pinnedNew を保持");
  ok(!!(st as unknown as { history?: unknown }).history, "未知の項目（history）も捨てない");
  const saved = JSON.parse(mem.get("bp-progress-v1") ?? "{}");
  ok(!!saved.state?.history && !!saved.state?.cards?.["words:0100"], "書き戻しても history と cards が残る");
  eq(saved.version, 0, "書き戻した version は 0");
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
  ok(S().canUndo() && S().canUndo("words:0005") && !S().canUndo("words:0006"), "canUndo(id)");
  eq(S().undo(), "words:0005", "undo は id を返す");
  ok(!S().cards["words:0005"], "undo 新規語 → カードを消す");
  eq(S().pinnedNew, ["words:0005", "words:0006"], "undo で pinnedNew も戻る");
  eq([S().daily.newIntroduced, S().totalReviews, S().streak, S().lastStudyDate], [0, 0, 0, null], "undo でカウンタと連続記録も戻る");
  eq([S().canUndo(), S().undo()], [false, null], "取り消しは1段だけ");
  S().pinNew(["words:0007"]);
  S().rate("words:0007", "good");
  S().pinNew(["words:0007"]);
  eq(S().pinnedNew, ["words:0005", "words:0006"], "pinNew 評価済みの語は追加しない");

  // 既存カードの取り消し
  const prev = card({ ease: 2.5, intervalDays: 10, reps: 3, last: addDays(TODAY, -10), due: TODAY });
  useProgress.setState({ cards: { ...S().cards, "words:0010": prev } });
  S().rate("words:0010", "again");
  eq(S().cards["words:0010"].lapses, 1, "期限到来カードの again → lapses+1");
  S().undo();
  eq(S().cards["words:0010"], prev, "undo 既存カード → 評価前に戻る");

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

  const st1 = S().daily.studied;
  S().logPractice(3);
  eq(S().daily.studied, st1 + 3, "logPractice(3)");
  eq(S().lastStudyDate, TODAY, "logPractice で学習日を記録");

  // エクスポート / インポート
  const json = S().exportJSON();
  eq(JSON.parse(json).pinnedNew, S().pinnedNew, "exportJSON に pinnedNew を含める");
  S().rate("words:0014", "good");
  ok(S().importJSON(JSON.stringify({ cards: {} })), "importJSON 旧形式（pinnedNew 無し）");
  eq(S().pinnedNew, [], "importJSON pinnedNew 無し → []");
  ok(!S().canUndo(), "importJSON で取り消しを破棄");
  ok(S().importJSON(json), "importJSON 書き出したデータ");
  eq(S().pinnedNew, JSON.parse(json).pinnedNew, "importJSON pinnedNew を復元");
  S().rate("words:0015", "good");
  S().resetAll();
  eq([S().pinnedNew, S().canUndo(), Object.keys(S().cards).length], [[], false, 0], "resetAll で pinnedNew と取り消しも消える");
  eq(JSON.parse(mem.get("bp-progress-v1") ?? "{}").version, 0, "保存時の version は 0");
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
  st.set({ studyView: "list" });
  const saved = JSON.parse(mem.get("bp-settings-v1") ?? "{}");
  eq([saved.version, saved.state?.studyView, saved.state?.rate, saved.state?.futureKey], [0, "list", 0.8, "x"], "書き戻しても既存の値と未知の項目が残る");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
