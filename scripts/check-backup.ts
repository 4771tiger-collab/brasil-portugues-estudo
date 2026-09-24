// ============================================================================
// バックアップの形式（v1/v2/v3/未知の version）と、書き出しに歌詞が入らないことの回帰テスト
//   npm run check:backup
// 前半は純関数（backupFormat.ts）。後半はストアをメモリ上の localStorage で動かす結合テスト。
// 例は架空の短い文字列のみ（歌詞は使わない）。1件でも失敗したら終了コード1。
// ============================================================================

import type { SrsCard } from "../src/data/types";
import {
  BACKUP_VERSION,
  composeBackup,
  describeBackup,
  parseBackup,
  pickSettings,
  readDrill,
  readMusic,
  readSelfTranslated,
  type BackupData,
  type ParseResult,
  type ProgressPart,
} from "../src/store/backupFormat";
import {
  cardDiff,
  compareCards,
  compareDrillStats,
  mergeAddedWords,
  mergeCards,
  mergeDrill,
  mergeHistory,
  mergeMusic,
  mergeProgress,
  mergeSelfTranslated,
  mergeStreak,
  mergeTranslations,
  unionBy,
} from "../src/store/merge";
import type { AddedWord, MusicExport } from "../src/store/useMusic";
import { addDays, todayStr } from "../src/srs/scheduler";
import { lineHash } from "../src/services/lyrics";

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
/** 読めたときの中身（読めなければ失敗として記録して null） */
function data(r: ParseResult, label: string): BackupData | null {
  if (r.ok) return r.data;
  fail++;
  console.error(`  ✗ ${label}: 読めなかった（${r.error}）`);
  return null;
}
const errOf = (r: ParseResult) => (r.ok ? null : r.error);

function card(p: Partial<SrsCard> = {}): SrsCard {
  return { ease: 2.5, intervalDays: 3, due: "2026-09-27", reps: 2, lapses: 0, level: "learning", last: "2026-09-24", ...p };
}
const PROGRESS = {
  exportedAt: "2026-09-20T10:00:00.000Z",
  cards: { "words:0001": card(), "capoeira:0040": card({ intervalDays: 21, level: "mature" }) },
  streak: 4,
  bestStreak: 10,
  lastStudyDate: "2026-09-24",
  totalReviews: 321,
  customPassages: [{ id: "custom_1", title: "自作", level: "short", source: "custom", chunks: [{ pt: "Oi", ja: "やあ" }] }],
};
/** 日ごとの学習ログ（B2-06） */
const HISTORY = {
  "2026-09-23": { reviews: 12, newWords: 3, again: 2, act: { quiz: { n: 10, sec: 0 }, music: { n: 0, sec: 240 } } },
  "2026-09-24": { reviews: 5, newWords: 1, again: 0, act: {} },
};
const MUSIC = {
  songs: { vidA: { offsetMs: 250, translations: { abc123: { text: "訳の例", edited: true } } } },
  addedWords: [{ id: "words:0002", videoId: "vidA", surface: "casa", createdCard: true, addedAt: "2026-09-01T00:00:00.000Z" }],
  userWords: [{ id: "user:xyz", pt: "xyz", ja: "例", pos: "名詞" }],
};

// ---------------------------------------------------------------------------
console.log("=== parseBackup: 読めない入力 ===");
{
  ok(errOf(parseBackup("{ not json")) !== null, "壊れた JSON → エラー");
  ok(errOf(parseBackup("")) !== null, "空文字 → エラー");
  ok(errOf(parseBackup("[1,2]")) !== null, "配列 → エラー");
  ok(errOf(parseBackup("null")) !== null, "null → エラー");
  ok(errOf(parseBackup('"text"')) !== null, "文字列 → エラー");
  ok(errOf(parseBackup(JSON.stringify({ streak: 3 }))) !== null, "cards 無し → エラー");
  ok(errOf(parseBackup(JSON.stringify({ cards: [] }))) !== null, "cards が配列 → エラー");
  ok(errOf(parseBackup(JSON.stringify({ cards: null }))) !== null, "cards が null → エラー");
  ok(errOf(parseBackup(JSON.stringify({ cards: "x" }))) !== null, "cards が文字列 → エラー");
  ok(errOf(parseBackup(JSON.stringify({ version: "3", cards: {} }))) !== null, "version が文字列 → エラー");
  ok(errOf(parseBackup(JSON.stringify({ version: 0, cards: {} }))) !== null, "version 0 → エラー");
  ok(errOf(parseBackup(JSON.stringify({ version: 2.5, cards: {} }))) !== null, "version 2.5 → エラー");
  ok(errOf(parseBackup(JSON.stringify({ cards: { a: { foo: 1 }, b: 3 } }))) !== null, "カードが全部壊れている → エラー");
  // zustand の保存データ（{state, version}）を貼り付けた場合も cards が無いのでエラー
  ok(errOf(parseBackup(JSON.stringify({ state: { cards: {} }, version: 0 }))) !== null, "localStorage の中身 → エラー");
}

console.log("=== parseBackup: v1（version 無し・1。music を持たない） ===");
{
  const d = data(parseBackup(JSON.stringify(PROGRESS)), "v1（version 無し）");
  if (d) {
    eq(d.version, 1, "version 無し → 1");
    eq(Object.keys(d.progress.cards), ["words:0001", "capoeira:0040"], "cards");
    eq(d.progress.cards["words:0001"], card(), "カードの中身はそのまま");
    eq(
      [d.progress.streak, d.progress.bestStreak, d.progress.lastStudyDate, d.progress.totalReviews],
      [4, 10, "2026-09-24", 321],
      "streak・bestStreak・lastStudyDate・totalReviews"
    );
    eq(d.progress.customPassages.map((p) => p.id), ["custom_1"], "customPassages");
    eq(d.progress.pinnedNew, [], "pinnedNew が無い → []");
    eq(d.progress.history, {}, "history が無い（B2-06 より前のファイル）→ {}");
    eq([d.music, d.settings, d.app], [null, null, null], "music・settings・app は null");
    eq(d.exportedAt, PROGRESS.exportedAt, "exportedAt");
  }
  const d1 = data(parseBackup(JSON.stringify({ ...PROGRESS, version: 1, music: MUSIC })), "v1（version:1）");
  eq(d1?.music ?? null, null, "v1 に music があっても読まない");
  const r = parseBackup(JSON.stringify(PROGRESS));
  eq(r.ok && r.warnings, [], "v1 → 警告なし");
  const bare = data(parseBackup(JSON.stringify({ cards: {} })), "cards が空の v1");
  eq(
    bare && [bare.progress.streak, bare.progress.lastStudyDate, bare.progress.totalReviews, bare.progress.customPassages],
    [0, null, 0, []],
    "足りない項目は既定値"
  );
  // 前後の空白・改行と BOM（貼り付けやメモアプリ経由）
  ok(parseBackup("﻿\n  " + JSON.stringify(PROGRESS) + "\n\n").ok, "BOM・前後の空白を許す");
}

console.log("=== parseBackup: v2（＋ music） ===");
{
  const d = data(parseBackup(JSON.stringify({ ...PROGRESS, version: 2, music: MUSIC })), "v2");
  if (d) {
    eq(d.version, 2, "version 2");
    eq(d.music, MUSIC, "music をそのまま読む");
    eq(d.settings, null, "v2 は settings を持たない");
    eq(d.app, null, "v2 は app を持たない");
  }
  const s = data(parseBackup(JSON.stringify({ ...PROGRESS, version: 2, music: MUSIC, settings: { rate: 0.8 } })), "v2+settings");
  eq(s?.settings ?? null, null, "v2 に settings があっても読まない");
  const nm = data(parseBackup(JSON.stringify({ ...PROGRESS, version: 2, music: "x" })), "v2 music 不正");
  eq(nm?.music ?? null, null, "music が object でなければ null（端末側を残す）");
}

console.log("=== parseBackup: v3（＋ app・settings・pinnedNew） ===");
const V3 = {
  ...PROGRESS,
  version: 3,
  pinnedNew: ["words:0100", 5, "words:0101"],
  app: { version: "0.1.0", build: "abc1234" },
  music: MUSIC,
  settings: {
    rate: 0.9,
    dailyNewLimit: 12,
    dailyGoal: 40,
    voiceURI: "Google português do Brasil",
    showKana: false,
    showIpa: true,
    musicNewLimit: 5,
    pauseOnWordTap: false,
    studyView: "list",
    studyDirection: "mixed",
    autoPlayOnReveal: false,
  },
};
{
  const r = parseBackup(JSON.stringify(V3));
  const d = data(r, "v3");
  if (d) {
    eq(d.version, 3, "version 3");
    eq(d.app, { version: "0.1.0", build: "abc1234" }, "app");
    eq(d.progress.pinnedNew, ["words:0100", "words:0101"], "pinnedNew は文字列だけ");
    eq(d.music, MUSIC, "music");
    const { voiceURI: _v, ...rest } = V3.settings;
    eq(d.settings, rest, "settings（voiceURI は読まない）");
  }
  eq(r.ok && r.warnings, [], "v3 → 警告なし");
  eq(BACKUP_VERSION, 3, "現行の書き出し version は 3");
  ok(!!d?.settings && !("capoeiraShare" in d.settings) && !("dailyReviewLimit" in d.settings), "B2 より前の v3（新しい設定なし）→ 新しい設定は端末側のまま");
}
{
  // B2-03/B2-04 で足した設定（任意フィールド。version は 3 のまま）
  const V3B2 = { ...V3, settings: { ...V3.settings, capoeiraShare: 0.33, dailyReviewLimit: 150 } };
  const r = parseBackup(JSON.stringify(V3B2));
  const d = data(r, "v3 + B2 の設定");
  eq(d?.settings && [d.settings.capoeiraShare, d.settings.dailyReviewLimit], [0.33, 150], "v3: capoeiraShare・dailyReviewLimit を読む");
  eq(r.ok && r.warnings, [], "v3 + B2 の設定 → 警告なし");
  const bad = data(
    parseBackup(JSON.stringify({ ...V3, settings: { ...V3.settings, capoeiraShare: 1.5, dailyReviewLimit: 0 } })),
    "v3 + 範囲外の B2 設定"
  );
  ok(!!bad?.settings && !("capoeiraShare" in bad.settings) && !("dailyReviewLimit" in bad.settings), "範囲外の capoeiraShare・dailyReviewLimit は読まない");
  eq(bad?.settings?.dailyNewLimit, 12, "範囲外の項目があっても他の設定は読む");
}
{
  // B3-07 で足した設定（耳だけ復習の考える間・向き。任意フィールド。version は 3 のまま）
  const old = data(parseBackup(JSON.stringify(V3)), "B3-07 より前の v3");
  ok(
    !!old?.settings && !("handsfreeGapSec" in old.settings) && !("handsfreeDirection" in old.settings),
    "B3-07 より前の v3（耳だけ復習の設定なし）→ 端末側のまま"
  );
  const V3B7 = { ...V3, settings: { ...V3.settings, handsfreeGapSec: 5, handsfreeDirection: "ja2pt" } };
  const r = parseBackup(JSON.stringify(V3B7));
  const d = data(r, "v3 + B3-07 の設定");
  eq(d?.settings && [d.settings.handsfreeGapSec, d.settings.handsfreeDirection], [5, "ja2pt"], "v3: handsfreeGapSec・handsfreeDirection を読む");
  eq(r.ok && r.warnings, [], "v3 + B3-07 の設定 → 警告なし");
  const bad = data(
    parseBackup(JSON.stringify({ ...V3, settings: { ...V3.settings, handsfreeGapSec: 4, handsfreeDirection: "mixed" } })),
    "v3 + 選択肢に無い B3-07 設定"
  );
  ok(
    !!bad?.settings && !("handsfreeGapSec" in bad.settings) && !("handsfreeDirection" in bad.settings),
    "選択肢に無い handsfreeGapSec（4）・handsfreeDirection（mixed）は読まない"
  );
  eq(bad?.settings?.studyDirection, "mixed", "選択肢に無い項目があっても他の設定は読む");
}

{
  // B3-08 で足した任意フィールド: music.songs[].selfTranslated（自分で訳した行のハッシュだけ）と設定 replayAfterLookup
  const old = data(parseBackup(JSON.stringify(V3)), "B3-08 より前の v3");
  ok(!!old?.music && !("selfTranslated" in old.music.songs.vidA), "B3-08 より前の v3（selfTranslated なし）→ 項目を足さない");
  ok(!!old?.settings && !("replayAfterLookup" in old.settings), "B3-08 より前の v3（replayAfterLookup なし）→ 端末側のまま");
  const LINE = "Linha inventada para o teste";
  const V3B8 = {
    ...V3,
    music: {
      ...MUSIC,
      songs: {
        vidA: { ...MUSIC.songs.vidA, selfTranslated: { abc123: true, [lineHash(LINE)]: true, [LINE]: true, zzz: "x", yyy: false, "": true } },
        vidB: { offsetMs: 0, translations: {}, selfTranslated: ["abc123"] },
      },
    },
    settings: { ...V3.settings, replayAfterLookup: false },
  };
  const r = parseBackup(JSON.stringify(V3B8));
  const d = data(r, "v3 + B3-08 の項目");
  eq(d?.music?.songs.vidA.selfTranslated, { abc123: true, [lineHash(LINE)]: true }, "v3: selfTranslated はハッシュの形のキーで値が true のものだけ読む");
  ok(!!d?.music && !JSON.stringify(d.music).includes(LINE), "selfTranslated に行の本文のキーがあっても持ち込まない");
  ok(!!d?.music && !("selfTranslated" in d.music.songs.vidB), "selfTranslated が object でない → 項目を置かない");
  eq(d?.settings?.replayAfterLookup, false, "v3: replayAfterLookup を読む");
  eq(r.ok && r.warnings, [], "v3 + B3-08 の項目 → 警告なし");
  const bad = data(parseBackup(JSON.stringify({ ...V3, settings: { ...V3.settings, replayAfterLookup: "no" } })), "v3 + 不正な replayAfterLookup");
  ok(!!bad?.settings && !("replayAfterLookup" in bad.settings), "真偽値でない replayAfterLookup は読まない");
  const v2 = data(parseBackup(JSON.stringify({ ...V3B8, version: 2 })), "v2 + selfTranslated");
  eq(v2?.music?.songs.vidA.selfTranslated, { abc123: true, [lineHash(LINE)]: true }, "v2 のファイルでも selfTranslated を読む（music と同じ）");
}

console.log("=== parseBackup: 未知の version（新しいアプリで作ったファイル） ===");
{
  const future = {
    ...V3,
    version: 4,
    app: { version: "0.9.0", build: "fffffff" },
    history: { "2026-09-24": { reviews: 9 } },
    drill: { x: 1 },
    lyricsCache: { vidA: { plainLyrics: "linha inventada" } },
    settings: { ...V3.settings, capoeiraShare: 0.5, futureOption: "x" },
  };
  const r = parseBackup(JSON.stringify(future));
  const d = data(r, "v4");
  if (d) {
    eq(d.version, 4, "version 4 のまま返す");
    eq(Object.keys(d.progress.cards).length, 2, "知っている項目（cards）は読む");
    eq(d.music, MUSIC, "music も読む");
    ok(!!d.settings && !("futureOption" in d.settings), "知らない設定は読まない");
    eq(d.drill, null, "v4 でも drill は読むが、知らない形（stats が無い）なら無い扱い（null）");
    eq(d.settings?.capoeiraShare, 0.5, "v4 でも知っている設定（capoeiraShare）は読む");
    eq(d.progress.history, { "2026-09-24": { reviews: 9, newWords: 0, again: 0, act: {} } }, "v4 でも知っている項目（history）は読み、足りない数は 0");
    eq(Object.keys(d).sort(), ["app", "drill", "exportedAt", "music", "progress", "settings", "version"], "知らない最上位の項目は持ち込まない");
    ok(!JSON.stringify(d).includes("lyricsCache") && !JSON.stringify(d).includes("linha inventada"), "知らない項目（lyricsCache）は読まない");
  }
  eq(r.ok && r.warnings.length, 1, "警告が1件");
  ok(r.ok && /新しいバージョン/.test(r.warnings[0]) && r.warnings[0].includes("v0.9.0"), "警告に「新しいバージョン」と版");
}

console.log("=== parseBackup: 学習ログ history（B2-06 の任意フィールド。v1/v2/v3 のどれでも読む） ===");
{
  for (const v of [undefined, 1, 2, 3] as const) {
    const label = v === undefined ? "v1（version 無し）" : `v${v}`;
    const src = { ...PROGRESS, ...(v === undefined ? {} : { version: v }), ...(v && v >= 2 ? { music: MUSIC } : {}), history: HISTORY };
    const d = data(parseBackup(JSON.stringify(src)), `${label} + history`);
    eq(d?.progress.history, HISTORY, `${label}: history を読む`);
    // 読んだもの → 書き出し（v3）→ 読み直しで同じ中身（往復）
    if (d) {
      const out = composeBackup({
        progress: { version: 1, exportedAt: d.exportedAt, ...d.progress },
        music: d.music ?? { songs: {}, addedWords: [], userWords: [] },
        settings: d.settings ?? {},
        app: { version: "0.1.0", build: "abc1234" },
      });
      const back = data(parseBackup(JSON.stringify(out)), `${label} の往復`);
      eq(back?.progress.history, HISTORY, `${label} → v3 → 読み直し: history が同じ`);
      eq(back?.progress.cards, d.progress.cards, `${label} → v3 → 読み直し: cards が同じ`);
      eq([back?.progress.streak, back?.progress.totalReviews], [d.progress.streak, d.progress.totalReviews], `${label} → v3 → 読み直し: 連続記録・評価回数が同じ`);
    }
  }
  const messy = data(
    parseBackup(
      JSON.stringify({
        cards: {},
        history: {
          "2026-09-24": { reviews: 3, newWords: "2", again: -1, act: { quiz: { n: 2, sec: 0 }, conjugation: { n: 1, sec: 9 }, music: "x" }, lyric: "linha inventada" },
          "24/09/2026": { reviews: 1 },
          "2026-09-23": "x",
          "2026-09-22": null,
        },
      })
    ),
    "形の崩れた history"
  );
  eq(
    messy?.progress.history,
    { "2026-09-24": { reviews: 3, newWords: 0, again: 0, act: { quiz: { n: 2, sec: 0 } } } },
    "history: 日付でないキー・object でない日・不正な数・知らない種類・知らない項目を落とす"
  );
  ok(!JSON.stringify(messy).includes("linha inventada"), "history の知らない項目（文字列）を持ち込まない");
  for (const bad of [null, [], "x", 3]) {
    eq(data(parseBackup(JSON.stringify({ cards: {}, history: bad })), "history 不正")?.progress.history, {}, `history が ${JSON.stringify(bad)} → {}`);
  }
  const d = data(parseBackup(JSON.stringify({ ...PROGRESS, history: HISTORY })), "describe");
  ok(!!d && describeBackup(d).includes("学習ログ 2日分"), "describeBackup: 学習ログの日数");
}

console.log("=== parseBackup: 活用ドリルの成績 drill（B3-06 の任意フィールド。v1/v2/v3 のどれでも読む） ===");
const DRILL = {
  stats: {
    "falar|pres|3": { seen: 3, correct: 2, last: "2026-09-23" },
    "pôr|fut|5": { seen: 1, correct: 0, last: "2026-09-24" },
  },
};
{
  for (const v of [undefined, 1, 2, 3] as const) {
    const label = v === undefined ? "v1（version 無し）" : `v${v}`;
    const src = { ...PROGRESS, ...(v === undefined ? {} : { version: v }), ...(v && v >= 2 ? { music: MUSIC } : {}), drill: DRILL };
    const d = data(parseBackup(JSON.stringify(src)), `${label} + drill`);
    eq(d?.drill, DRILL, `${label}: drill を読む`);
  }
  eq(data(parseBackup(JSON.stringify({ ...PROGRESS, version: 3 })), "drill 無し")?.drill, null, "drill の無いファイル → null（端末側のまま）");
  for (const bad of [null, [], "x", 3, { x: 1 }, { stats: [] }, { stats: "x" }]) {
    eq(data(parseBackup(JSON.stringify({ cards: {}, drill: bad })), "drill 不正")?.drill, null, `drill が ${JSON.stringify(bad)} → null`);
  }
  const good = { seen: 1, correct: 1, last: "2026-09-24" };
  const messy = data(
    parseBackup(
      JSON.stringify({
        cards: {},
        drill: {
          future: 1,
          stats: {
            "falar|pres|3": { seen: 2.7, correct: 5, last: "2026-09-24", note: "linha inventada" },
            "comer|pret|0": { seen: 0, correct: 0, last: "2026-09-24" },
            "Falar|pres|3": good,
            "falar|pres|9": good,
            "falar|pres": good,
            "linha inventada|pres|0": good,
            "ser|impf|2": { seen: "3", correct: 1, last: "2026-09-24" },
            "ser|impf|5": { seen: 3, correct: 1, last: "24/09/2026" },
            "ser|fut|0": { seen: 3, correct: -1, last: "2026-09-24" },
            "ser|cond|0": good,
            "ir|pres|0": "x",
          },
        },
      })
    ),
    "形の崩れた drill"
  );
  eq(
    messy?.drill,
    {
      stats: {
        "falar|pres|3": { seen: 2, correct: 2, last: "2026-09-24" },
        "ser|fut|0": { seen: 3, correct: 0, last: "2026-09-24" },
        "ser|cond|0": good,
      },
    },
    "drill: キーの形・回数・日付を確かめる（seen は整数・0 は落とす、correct は 0〜seen、知らない時制のキーは残す）"
  );
  ok(!JSON.stringify(messy).includes("linha inventada") && !JSON.stringify(messy).includes("future"), "drill の知らない項目を持ち込まない");
  eq(readDrill({ stats: {} }), { stats: {} }, "readDrill: 空の成績");

  const app = { version: "0.1.0", build: "abc1234" };
  const out = composeBackup({
    progress: { version: 1, ...PROGRESS },
    music: MUSIC,
    settings: {},
    app,
    drill: { ...DRILL, prefs: { tenses: ["pres"] }, stats: { ...DRILL.stats, "x y|pres|0": good } },
  });
  eq(out.drill, DRILL, "composeBackup: drill は読み込みと同じ規則で組み直す（設定・壊れたキーは書き出さない）");
  const back = data(parseBackup(JSON.stringify(out)), "drill の往復");
  eq(back?.drill, DRILL, "drill: 書き出し → 読み直しで同じ");
  ok(!("drill" in composeBackup({ progress: { version: 1, ...PROGRESS }, music: MUSIC, settings: {}, app })), "drill を渡さなければ書き出さない");
  eq(composeBackup({ progress: { version: 1, ...PROGRESS }, music: MUSIC, settings: {}, app, drill: "x" }).drill, { stats: {} }, "壊れた drill は空の成績として書き出す");
  ok(!!back && describeBackup(back).includes("活用ドリル 2形"), "describeBackup: 活用ドリルの形の数");
  ok(!!back && !describeBackup({ ...back, drill: null }).includes("活用ドリル"), "describeBackup: drill が無ければ出さない");
}

console.log("=== parseBackup: カード・曲のデータの検査 ===");
{
  const mixed = {
    cards: {
      good: card(),
      noLast: { ...card(), last: undefined }, // last が無い → null として読む
      badLevel: card({ level: "??" as SrsCard["level"] }),
      badDue: card({ due: "tomorrow" }),
      badEase: { ...card(), ease: "2.5" },
      notObj: 42,
      future: { ...card(), notes: "メモ" }, // 将来版の項目は残す
    },
  };
  const r = parseBackup(JSON.stringify(mixed));
  const d = data(r, "壊れたカードを含む");
  if (d) {
    eq(Object.keys(d.progress.cards), ["good", "noLast", "badLevel", "future"], "壊れたカードだけ読み飛ばす");
    eq(d.progress.cards.noLast.last, null, "last が無い → null");
    eq(d.progress.cards.badLevel.level, "new", "level が不正 → new");
    eq((d.progress.cards.future as SrsCard & { notes?: string }).notes, "メモ", "カードの未知の項目は残す");
  }
  eq(r.ok && r.warnings.length, 1, "読み飛ばした件数の警告");
  ok(r.ok && r.warnings[0].includes("3件"), "警告に件数（3件）");

  const lp = data(parseBackup(JSON.stringify({ cards: {}, lastStudyDate: "昨日", streak: -3, totalReviews: "9" })), "不正な数値");
  eq(lp && [lp.progress.lastStudyDate, lp.progress.streak, lp.progress.totalReviews], [null, 0, 0], "不正な日付・負の数・文字列 → 既定値");

  const cp = data(
    parseBackup(JSON.stringify({ cards: {}, customPassages: [{ id: "ok", title: "t", chunks: [] }, { id: 1 }, "x", null] })),
    "customPassages"
  );
  eq(cp?.progress.customPassages.map((p) => p.id), ["ok"], "customPassages は形の正しいものだけ");

  // 曲のデータ: songs は既知の項目だけで組み直す（歌詞の本文などを端末に持ち込まない）
  const m = readMusic({
    songs: {
      vidA: {
        offsetMs: 100,
        translations: { k1: { text: "訳", edited: true }, k2: { text: 5 }, k3: "x", k4: { text: "訳2" } },
        syncedLyrics: "[00:01.00] linha inventada",
        plainLyrics: "linha inventada",
        lyrics: ["linha inventada"],
      },
      vidB: "x",
      vidC: { translations: null },
    },
    addedWords: [
      { id: "words:0002", videoId: "vidA", surface: "casa", createdCard: true, addedAt: "t", lineHash: "h1" },
      { id: "words:0003" },
      { videoId: "vidA" },
      null,
    ],
    userWords: [{ id: "user:a", pt: "a", ja: "あ", pos: "名詞" }, { id: "user:b" }, 3],
    lyricsCache: { vidA: "linha inventada" },
  });
  eq(
    m?.songs,
    {
      vidA: { offsetMs: 100, translations: { k1: { text: "訳", edited: true }, k4: { text: "訳2", edited: false } } },
      vidC: { offsetMs: 0, translations: {} },
    },
    "songs は offsetMs・translations だけ（歌詞の項目を落とす）"
  );
  ok(!JSON.stringify(m).includes("linha inventada"), "曲のデータに歌詞の文字列が残らない");
  eq(m?.addedWords.map((w) => w.id), ["words:0002"], "addedWords は id と videoId のあるものだけ");
  eq((m?.addedWords[0] as { lineHash?: string } | undefined)?.lineHash, "h1", "addedWords の未知の項目（将来版）は残す");
  eq(m?.userWords.map((u) => u.id), ["user:a"], "userWords は id と pt のあるものだけ");
  eq(readMusic("x"), null, "music が object でない → null");
  eq(readMusic({}), { songs: {}, addedWords: [], userWords: [] }, "空の music");

  // 自分で訳した行の印（B3-08）: ハッシュの形のキー・値 true だけ。1行も無ければ項目を置かない
  eq(readSelfTranslated({ abc123: true, k1: true }), { abc123: true, k1: true }, "readSelfTranslated: ハッシュのキー");
  eq(
    [readSelfTranslated({}), readSelfTranslated(null), readSelfTranslated(["abc123"]), readSelfTranslated("abc123"), readSelfTranslated({ abc123: 1, k1: "true" })],
    [null, null, null, null, null],
    "readSelfTranslated: 空・object でない・値が true でない → null"
  );
  eq(
    readSelfTranslated({ "linha inventada": true, "Linha": true, "abcdefghijkl": true, "ab-12": true, abc123: true }),
    { abc123: true },
    "readSelfTranslated: 空白・大文字・12文字以上・記号を含むキー（行の本文）は落とす"
  );
  const ms = readMusic({ songs: { vidA: { offsetMs: 5, translations: {}, selfTranslated: { abc123: true, "linha inventada": true } }, vidB: { selfTranslated: {} } } });
  eq(ms?.songs, { vidA: { offsetMs: 5, translations: {}, selfTranslated: { abc123: true } }, vidB: { offsetMs: 0, translations: {} } }, "readMusic: selfTranslated を読み、空なら項目を置かない");
  ok(!JSON.stringify(ms).includes("linha inventada"), "readMusic: selfTranslated の行の本文のキーを持ち込まない");
}

console.log("=== pickSettings ===");
{
  eq(
    pickSettings({ rate: 0, dailyNewLimit: -1, dailyGoal: 30, showKana: "yes", studyView: "grid", studyDirection: "ja2pt", voiceURI: "v", set: () => 0, extra: 1 }),
    { dailyGoal: 30, studyDirection: "ja2pt" },
    "型・範囲・選択肢の合わない値、voiceURI、関数、未知の項目を落とす"
  );
  eq(pickSettings(null), {}, "object でない → {}");
  eq(
    pickSettings({ capoeiraShare: 0, dailyReviewLimit: 100 }),
    { capoeiraShare: 0, dailyReviewLimit: 100 },
    "capoeiraShare 0（混ぜない）・dailyReviewLimit を読む"
  );
  eq(
    pickSettings({ capoeiraShare: 1 }),
    { capoeiraShare: 1 },
    "capoeiraShare 1 は範囲内"
  );
  eq(
    pickSettings({ capoeiraShare: -0.1, dailyReviewLimit: -5 }),
    {},
    "capoeiraShare が負・dailyReviewLimit が負 → 落とす"
  );
  eq(pickSettings({ capoeiraShare: "0.25", dailyReviewLimit: "100" }), {}, "文字列の数値は落とす");
  eq(
    [2, 3, 5].map((n) => pickSettings({ handsfreeGapSec: n }).handsfreeGapSec),
    [2, 3, 5],
    "handsfreeGapSec: 2 / 3 / 5 秒を読む"
  );
  eq(
    pickSettings({ handsfreeGapSec: "3" }),
    {},
    "handsfreeGapSec: 文字列の \"3\" は落とす（数の選択肢は型まで一致）"
  );
  eq(pickSettings({ handsfreeGapSec: 4 }), {}, "handsfreeGapSec: 選択肢に無い 4 は落とす");
  eq(pickSettings({ handsfreeGapSec: 0 }), {}, "handsfreeGapSec: 0 は落とす");
  eq(pickSettings({ handsfreeGapSec: NaN }), {}, "handsfreeGapSec: NaN は落とす");
  eq(
    pickSettings({ handsfreeDirection: "pt2ja" }),
    { handsfreeDirection: "pt2ja" },
    "handsfreeDirection: pt2ja を読む"
  );
  eq(
    [pickSettings({ handsfreeDirection: "mixed" }), pickSettings({ handsfreeDirection: 1 }), pickSettings({ studyView: 0 })],
    [{}, {}, {}],
    "handsfreeDirection の mixed・数、文字列の選択肢に数 → 落とす"
  );
  eq(pickSettings({ dailyNewLimit: Infinity, rate: NaN }), {}, "Infinity・NaN を落とす");
  eq(
    [pickSettings({ replayAfterLookup: true }), pickSettings({ replayAfterLookup: false })],
    [{ replayAfterLookup: true }, { replayAfterLookup: false }],
    "replayAfterLookup: true / false を読む"
  );
  eq([pickSettings({ replayAfterLookup: "true" }), pickSettings({ replayAfterLookup: 1 })], [{}, {}], "replayAfterLookup: 文字列・数は落とす");
}

console.log("=== composeBackup（v3 の書き出し） ===");
{
  const out = composeBackup({
    progress: {
      version: 1,
      ...PROGRESS,
      pinnedNew: ["words:0100"],
      // ストアに紛れ込んだ未知の項目は、学習ログでも書き出さない
      history: { ...HISTORY, "2026-09-20": { reviews: 1, newWords: 0, again: 0, act: {}, note: "linha inventada" } },
    },
    music: {
      ...MUSIC,
      // ストアに紛れ込んだ未知の項目も書き出さない
      songs: { vidA: { ...MUSIC.songs.vidA, plainLyrics: "linha inventada" } as (typeof MUSIC.songs)["vidA"] },
    },
    settings: { ...V3.settings, set: () => undefined, reset: () => undefined },
    app: { version: "0.1.0", build: "abc1234" },
  });
  eq(out.version, 3, "version は 3 に上書き");
  const HISTORY_OUT = { ...HISTORY, "2026-09-20": { reviews: 1, newWords: 0, again: 0, act: {} } };
  eq(out.history, HISTORY_OUT, "history は既知の項目だけで組み直して書き出す");
  for (const k of ["cards", "streak", "bestStreak", "lastStudyDate", "totalReviews", "customPassages", "exportedAt", "pinnedNew", "history"]) {
    ok(k in out, `進捗の ${k} は最上位に置く（旧版のアプリでも読める）`);
  }
  eq(out.app, { version: "0.1.0", build: "abc1234" }, "app");
  const settings = out.settings as Record<string, unknown>;
  ok(!("voiceURI" in settings), "settings に voiceURI を入れない");
  ok(!("set" in settings) && !("reset" in settings), "settings に関数を入れない");
  ok(!JSON.stringify(out).includes("linha inventada"), "songs の未知の項目（歌詞）を書き出さない");

  // 書き出し → 読み込みで同じ中身に戻る
  const r = parseBackup(JSON.stringify(out));
  const d = data(r, "書き出したものを読む");
  if (d) {
    eq(d.version, 3, "往復: version");
    eq(d.progress.cards, PROGRESS.cards, "往復: cards");
    eq(d.progress.pinnedNew, ["words:0100"], "往復: pinnedNew");
    eq(d.progress.history, HISTORY_OUT, "往復: history");
    eq(d.music, MUSIC, "往復: music");
    eq(d.settings, pickSettings(V3.settings), "往復: settings");
    ok(describeBackup(d).includes("学習した単語 2語") && describeBackup(d).includes("評価 321回"), "describeBackup: 語数と評価回数");
    ok(describeBackup(d).includes("曲の単語 1語") && describeBackup(d).includes("設定を含む"), "describeBackup: 曲の単語と設定");
  }
  eq(r.ok && r.warnings, [], "往復: 警告なし");
}
{
  // B3-08: 自分で訳した行の印は書き出す（ハッシュだけ）。行の本文のキーは書き出さない
  const out = composeBackup({
    progress: { version: 1, ...PROGRESS },
    music: {
      ...MUSIC,
      songs: {
        vidA: { ...MUSIC.songs.vidA, selfTranslated: { abc123: true, "linha inventada": true } as Record<string, true> },
        vidB: { offsetMs: 0, translations: {}, selfTranslated: {} },
      },
    },
    settings: { ...V3.settings, replayAfterLookup: false },
    app: { version: "0.1.0", build: "abc1234" },
  });
  const songs = (out.music as { songs: Record<string, unknown> }).songs;
  eq(songs.vidA, { ...MUSIC.songs.vidA, selfTranslated: { abc123: true } }, "書き出し: selfTranslated はハッシュのキーだけ");
  eq(songs.vidB, { offsetMs: 0, translations: {} }, "書き出し: 空の selfTranslated は書き出さない");
  ok(!JSON.stringify(out).includes("linha inventada"), "書き出し: 行の本文を書き出さない");
  eq((out.settings as Record<string, unknown>).replayAfterLookup, false, "書き出し: replayAfterLookup");
  const d = data(parseBackup(JSON.stringify(out)), "selfTranslated の往復");
  eq(d?.music?.songs.vidA.selfTranslated, { abc123: true }, "往復: selfTranslated");
  eq(d?.settings?.replayAfterLookup, false, "往復: replayAfterLookup");
  ok(!!d && describeBackup(d).includes("自分で訳した行 1行"), "describeBackup: 自分で訳した行の数");
  const plain = data(parseBackup(JSON.stringify({ ...V3 })), "selfTranslated の無いファイル");
  ok(!!plain && !describeBackup(plain).includes("自分で訳した行"), "describeBackup: 自分で訳した行が無ければ出さない");
}

// ---------------------------------------------------------------------------
// 統合インポート（merge.ts の純関数）
console.log("=== merge: cards（last → reps → intervalDays → 端末側） ===");
{
  const L: Record<string, SrsCard> = {
    same: card({ last: "2026-09-20", reps: 2 }),
    localNewer: card({ last: "2026-09-24", reps: 3 }),
    remoteNewer: card({ last: "2026-09-10", reps: 5 }),
    moreReps: card({ last: "2026-09-22", reps: 2, intervalDays: 3 }),
    longerIv: card({ last: "2026-09-22", reps: 2, intervalDays: 3 }),
    fullTie: card({ last: "2026-09-22", reps: 2, intervalDays: 3, ease: 2.6 }),
    nullLocal: card({ last: null, reps: 0 }),
    nullBoth: card({ last: null, reps: 0, due: "2026-09-01" }),
    onlyLocal: card(),
  };
  const R: Record<string, SrsCard> = {
    same: card({ last: "2026-09-20", reps: 2 }),
    localNewer: card({ last: "2026-09-20", reps: 9 }),
    remoteNewer: card({ last: "2026-09-12", reps: 1 }),
    moreReps: card({ last: "2026-09-22", reps: 4, intervalDays: 1 }),
    longerIv: card({ last: "2026-09-22", reps: 2, intervalDays: 7 }),
    fullTie: card({ last: "2026-09-22", reps: 2, intervalDays: 3, ease: 2.2 }),
    nullLocal: card({ last: "2026-09-01", reps: 1 }),
    nullBoth: card({ last: null, reps: 0, due: "2026-09-30" }),
    onlyRemote: card({ last: "2026-09-21" }),
  };
  const lFrozen = JSON.stringify(L);
  const rFrozen = JSON.stringify(R);
  const m = mergeCards(L, R);
  const from = Object.fromEntries(Object.entries(m).map(([id, c]) => [id, c === L[id] ? "L" : c === R[id] ? "R" : "?"]));
  eq(
    from,
    {
      same: "L",
      localNewer: "L",
      remoteNewer: "R",
      moreReps: "R",
      longerIv: "R",
      fullTie: "L",
      nullLocal: "R",
      nullBoth: "L",
      onlyLocal: "L",
      onlyRemote: "R",
    },
    "語ごと: last が新しい方（reps より優先）・同じなら reps・intervalDays・それも同じなら端末側、null は最も古い"
  );
  eq(Object.keys(m), [...Object.keys(L), "onlyRemote"], "端末側の順に並べ、ファイルにだけある語を後ろに足す");
  eq([JSON.stringify(L), JSON.stringify(R)], [lFrozen, rFrozen], "mergeCards は入力を変更しない");
  for (const id of Object.keys(R)) {
    if (!L[id]) continue;
    eq(Math.sign(compareCards(L[id], R[id])), -Math.sign(compareCards(R[id], L[id])), `compareCards は対称（${id}）`);
  }
  eq(mergeCards({}, R), R, "端末が空 → ファイルのカード");
  eq(mergeCards(L, {}), L, "ファイルが空 → 端末のカード");

  eq(
    cardDiff({ a: card(), b: card({ reps: 1 }), c: card() }, { a: card(), b: card({ reps: 2 }), d: card() }),
    { added: 1, updated: 1, removed: 1 },
    "cardDiff: 追加・学習状況の変化・削除を数える"
  );
  eq(cardDiff({ a: card() }, { a: { ...card(), level: "young" as const } }), { added: 0, updated: 0, removed: 0 }, "cardDiff: level（表示用）だけの違いは数えない");
}

console.log("=== merge: 連続記録（streak を数え直す）・学習ログ ===");
{
  const day = (reviews: number, act: Record<string, { n: number; sec: number }> = {}) => ({ reviews, newWords: 0, again: 0, act });
  eq(
    mergeStreak({ streak: 10, bestStreak: 12, lastStudyDate: "2026-09-20" }, { streak: 1, bestStreak: 3, lastStudyDate: "2026-09-24" }, {}),
    { streak: 1, bestStreak: 12, lastStudyDate: "2026-09-24" },
    "途切れた古い大きな streak は引き継がない（lastStudyDate は新しい方・bestStreak は大きい方）"
  );
  eq(
    mergeStreak({ streak: 5, bestStreak: 5, lastStudyDate: "2026-09-23" }, { streak: 1, bestStreak: 1, lastStudyDate: "2026-09-24" }, {}),
    { streak: 6, bestStreak: 6, lastStudyDate: "2026-09-24" },
    "続いている2つの連続区間はつなぐ（9/19〜9/23 と 9/24 → 6日）"
  );
  eq(
    mergeStreak({ streak: 5, bestStreak: 7, lastStudyDate: "2026-09-24" }, { streak: 3, bestStreak: 3, lastStudyDate: "2026-09-24" }, {}),
    { streak: 5, bestStreak: 7, lastStudyDate: "2026-09-24" },
    "同じ日まで → 大きい方"
  );
  eq(
    mergeStreak(
      { streak: 1, bestStreak: 1, lastStudyDate: "2026-09-24" },
      { streak: 1, bestStreak: 1, lastStudyDate: "2026-09-23" },
      {
        "2026-09-22": day(3),
        "2026-09-21": day(0, { music: { n: 0, sec: 200 } }),
        "2026-09-20": day(0, { music: { n: 0, sec: 100 } }),
        "2026-09-19": day(4),
      }
    ),
    { streak: 4, bestStreak: 4, lastStudyDate: "2026-09-24" },
    "端末を交互に使った日も、学習ログで学習日だった日（音楽は 3 分以上）をつないで数える"
  );
  eq(
    mergeStreak({ streak: 0, bestStreak: 0, lastStudyDate: null }, { streak: 3, bestStreak: 4, lastStudyDate: "2026-09-24" }, {}),
    { streak: 3, bestStreak: 4, lastStudyDate: "2026-09-24" },
    "端末が未学習 → ファイル側"
  );
  eq(
    mergeStreak({ streak: 0, bestStreak: 0, lastStudyDate: null }, { streak: 0, bestStreak: 2, lastStudyDate: null }, {}),
    { streak: 0, bestStreak: 2, lastStudyDate: null },
    "どちらも学習日なし"
  );

  const LH = {
    "2026-09-23": { reviews: 5, newWords: 2, again: 1, act: { quiz: { n: 3, sec: 0 }, music: { n: 0, sec: 100 } } },
    "2026-09-24": day(2),
  };
  const RH = {
    "2026-09-23": { reviews: 2, newWords: 4, again: 0, act: { quiz: { n: 5, sec: 0 }, dictation: { n: 1, sec: 30 } } },
    "2026-09-22": day(7),
  };
  eq(
    mergeHistory(LH, RH),
    {
      "2026-09-23": { reviews: 5, newWords: 4, again: 1, act: { quiz: { n: 5, sec: 0 }, dictation: { n: 1, sec: 30 }, music: { n: 0, sec: 100 } } },
      "2026-09-24": day(2),
      "2026-09-22": day(7),
    },
    "history: 日ごと・項目ごとに大きい方（片方にしか無い日・種類はそのまま）"
  );
  eq(mergeHistory(LH, LH), LH, "history: 同じもの同士 → 変わらない");
}

console.log("=== merge: 進捗全体（mergeProgress） ===");
{
  const base: ProgressPart = { cards: {}, streak: 0, bestStreak: 0, lastStudyDate: null, totalReviews: 0, customPassages: [], pinnedNew: [], history: {} };
  const psg = (id: string, title: string) => ({ id, title, level: "short" as const, source: "custom" as const, chunks: [] });
  const local: ProgressPart = {
    ...base,
    cards: { a: card({ last: "2026-09-24" }), p1: card({ last: null }) },
    streak: 3,
    bestStreak: 8,
    lastStudyDate: "2026-09-24",
    totalReviews: 300,
    customPassages: [psg("custom_1", "端末の題")],
    pinnedNew: ["p1", "p2"],
    history: { "2026-09-24": { reviews: 4, newWords: 1, again: 0, act: {} } },
  };
  const remote: ProgressPart = {
    ...base,
    cards: { a: card({ last: "2026-09-20" }), p3: card({ last: "2026-09-23" }) },
    streak: 9,
    bestStreak: 9,
    lastStudyDate: "2026-09-23",
    totalReviews: 250,
    customPassages: [psg("custom_1", "ファイルの題"), psg("custom_2", "新しい教材")],
    pinnedNew: ["p2", "p3", "p4"],
    history: {
      "2026-09-24": { reviews: 1, newWords: 3, again: 2, act: {} },
      "2025-01-01": { reviews: 9, newWords: 0, again: 0, act: {} }, // 400 日より前 → 消す
    },
  };
  const m = mergeProgress(local, remote, "2026-09-24");
  ok(m.cards.a === local.cards.a && m.cards.p3 === remote.cards.p3, "cards を語ごとに統合");
  eq([m.streak, m.bestStreak, m.lastStudyDate], [10, 10, "2026-09-24"], "連続記録: 9/15〜9/23 と 9/22〜9/24 をつないで 10日");
  eq(m.totalReviews, 300, "totalReviews は大きい方");
  eq(m.customPassages.map((p) => `${p.id}:${p.title}`), ["custom_1:端末の題", "custom_2:新しい教材"], "customPassages: 和集合（同じ ID は端末側）");
  eq(m.pinnedNew, ["p1", "p2", "p4"], "pinnedNew: 和集合。ファイル側で評価済みになった語（p3）は外す");
  eq(m.history, { "2026-09-24": { reviews: 4, newWords: 3, again: 2, act: {} } }, "history: 項目ごとに大きい方・400 日より前の日は消す");
  const again = mergeProgress(m, m, "2026-09-24");
  eq(again, m, "同じもの同士の統合は変わらない（何度統合しても同じ）");
  eq(unionBy([1, 2], [2, 3, 3], String), [1, 2, 3], "unionBy: 端末側の順、重複を除く");
}

console.log("=== merge: 曲のデータ（和訳・同期・曲の単語） ===");
{
  const tr = (text: string, edited: boolean) => ({ text, edited });
  eq(
    mergeTranslations(
      { k1: tr("端末1", false), k2: tr("端末2", true), k3: tr("端末3", false) },
      { k1: tr("ファイル1", true), k2: tr("ファイル2", true), k3: tr("ファイル3", false), k4: tr("ファイル4", false) }
    ),
    { k1: tr("ファイル1", true), k2: tr("端末2", true), k3: tr("端末3", false), k4: tr("ファイル4", false) },
    "和訳: 手で直した方を優先（どちらも直した・どちらも機械翻訳なら端末側）、端末に無い行は足す"
  );

  const aw = (id: string, videoId: string, createdCard: boolean, addedAt: string): AddedWord => ({ id, videoId, surface: id, createdCard, addedAt });
  const merged = mergeAddedWords(
    [aw("w1", "A", false, "2026-09-10T00:00:00.000Z"), aw("w2", "A", true, "2026-09-05T00:00:00.000Z"), aw("w3", "A", false, "")],
    [
      aw("w1", "A", true, "2026-09-01T00:00:00.000Z"),
      aw("w1", "B", false, "2026-09-02T00:00:00.000Z"),
      aw("w2", "A", false, "2026-09-20T00:00:00.000Z"),
      aw("w3", "A", false, "2026-09-03T00:00:00.000Z"),
    ]
  );
  eq(
    merged.map((w) => `${w.id}@${w.videoId}${w.createdCard ? "*" : ""} ${w.addedAt.slice(0, 10)}`),
    ["w1@A* 2026-09-01", "w2@A* 2026-09-05", "w3@A 2026-09-03", "w1@B 2026-09-02"],
    "addedWords: (id, videoId) の和集合・addedAt は古い方（空は無視）・createdCard は OR"
  );
  const extra = { ...aw("w9", "A", false, "2026-09-01T00:00:00.000Z"), lineHash: "h1" } as AddedWord;
  eq((mergeAddedWords([extra], [aw("w9", "A", true, "2026-09-02T00:00:00.000Z")])[0] as AddedWord & { lineHash?: string }).lineHash, "h1", "addedWords: 端末側の未知の項目は残す");

  const LM: MusicExport = {
    songs: { vidA: { offsetMs: 100, translations: { k1: tr("端末", false) } } },
    addedWords: [aw("w1", "vidA", true, "2026-09-10T00:00:00.000Z")],
    userWords: [{ id: "user:a", pt: "a", ja: "端末", pos: "名詞" }],
  };
  const RM: MusicExport = {
    songs: { vidA: { offsetMs: 300, translations: { k1: tr("ファイル", true), k2: tr("ファイル2", false) } }, vidB: { offsetMs: 50, translations: {} } },
    addedWords: [aw("w2", "vidB", true, "2026-09-11T00:00:00.000Z")],
    userWords: [{ id: "user:a", pt: "a", ja: "ファイル", pos: "名詞" }, { id: "user:b", pt: "b", ja: "び", pos: "名詞" }],
  };
  const mm = mergeMusic(LM, RM);
  eq(mm.songs.vidA, { offsetMs: 100, translations: { k1: tr("ファイル", true), k2: tr("ファイル2", false) } }, "songs: offsetMs は端末側、和訳は行ごとに統合");
  eq(mm.songs.vidB, RM.songs.vidB, "songs: 端末に無い曲はファイル側");
  eq(mm.addedWords.map((w) => w.id), ["w1", "w2"], "addedWords を統合");
  eq(mm.userWords.map((u) => `${u.id}:${u.ja}`), ["user:a:端末", "user:b:び"], "userWords: 和集合（同じ ID は端末側）");
  ok(mergeMusic(LM, null) === LM, "ファイルに曲のデータが無い（v1）→ 端末側のまま");

  // 自分で訳した行の印（B3-08）: 和集合。どちらにも無ければ項目を置かない
  eq(mergeSelfTranslated({ a1: true, b2: true }, { b2: true, c3: true }), { a1: true, b2: true, c3: true }, "mergeSelfTranslated: 和集合（端末側の順）");
  eq([mergeSelfTranslated(undefined, undefined), mergeSelfTranslated({}, {})], [undefined, undefined], "mergeSelfTranslated: どちらにも無い → undefined");
  eq([mergeSelfTranslated({ a1: true }, undefined), mergeSelfTranslated(undefined, { c3: true })], [{ a1: true }, { c3: true }], "mergeSelfTranslated: 片方だけ → その印");
  const LS: MusicExport = {
    songs: {
      vidA: { offsetMs: 100, translations: { k1: tr("端末", true) }, selfTranslated: { k1: true } },
      vidB: { offsetMs: 0, translations: {} },
      vidC: { offsetMs: 7, translations: {}, selfTranslated: { k9: true } },
    },
    addedWords: [],
    userWords: [],
  };
  const RS: MusicExport = {
    songs: {
      vidA: { offsetMs: 300, translations: { k2: tr("ファイル", false) }, selfTranslated: { k2: true, k1: true } },
      vidB: { offsetMs: 5, translations: {} },
      vidD: { offsetMs: 1, translations: {}, selfTranslated: { k4: true } },
    },
    addedWords: [],
    userWords: [],
  };
  const beforeS = JSON.stringify([LS, RS]);
  const ms = mergeMusic(LS, RS);
  eq(ms.songs.vidA, { offsetMs: 100, translations: { k1: tr("端末", true), k2: tr("ファイル", false) }, selfTranslated: { k1: true, k2: true } }, "songs: 自分で訳した行の印は和集合");
  eq(ms.songs.vidB, { offsetMs: 0, translations: {} }, "songs: どちらにも印が無い曲には selfTranslated を足さない");
  ok(!("selfTranslated" in ms.songs.vidB), "songs: どちらにも印が無い曲には selfTranslated の項目自体を置かない");
  eq(ms.songs.vidC, LS.songs.vidC, "songs: 端末にだけある曲の印はそのまま");
  eq(ms.songs.vidD, RS.songs.vidD, "songs: ファイルにだけある曲の印も入る");
  eq(JSON.stringify([LS, RS]), beforeS, "mergeMusic: 元のデータを書き換えない");
  eq(mergeMusic(ms, RS), ms, "mergeMusic: 同じファイルをもう一度統合しても同じ");
}

console.log("=== merge: 活用ドリルの成績（形ごとに last → seen → correct → 端末側） ===");
{
  const st = (seen: number, correct: number, last: string) => ({ seen, correct, last });
  const L = {
    stats: {
      a: st(3, 1, "2026-09-20"),
      b: st(1, 1, "2026-09-24"),
      c: st(2, 2, "2026-09-22"),
      d: st(2, 1, "2026-09-22"),
      e: st(4, 4, "2026-09-10"),
      g: st(2, 1, "2026-09-22"),
    },
  };
  const R = {
    stats: {
      a: st(5, 5, "2026-09-21"),
      b: st(9, 9, "2026-09-23"),
      c: st(3, 0, "2026-09-22"),
      d: st(2, 2, "2026-09-22"),
      f: st(1, 0, "2026-09-01"),
      g: st(2, 1, "2026-09-22"),
    },
  };
  const before = JSON.stringify([L, R]);
  const m = mergeDrill(L, R);
  eq(m.stats.a, R.stats.a, "ファイルの方が新しい → ファイル側");
  eq(m.stats.b, L.stats.b, "端末の方が新しい → 端末側（回数が少なくても）");
  eq(m.stats.c, R.stats.c, "同じ日 → seen が大きい方");
  eq(m.stats.d, R.stats.d, "同じ日・同じ seen → correct が大きい方");
  ok(m.stats.g === L.stats.g, "まったく同じ → 端末側");
  eq(m.stats.e, L.stats.e, "端末にだけある形は残す");
  eq(m.stats.f, R.stats.f, "ファイルにだけある形を足す");
  eq(Object.keys(m.stats), ["a", "b", "c", "d", "e", "g", "f"], "端末側の順に並べ、ファイルにだけある形を後ろに足す");
  eq(JSON.stringify([L, R]), before, "元の成績を書き換えない");
  eq(mergeDrill(m, R), m, "同じファイルをもう一度統合しても同じ");
  ok(mergeDrill(L, null) === L, "ファイルに drill が無い → 端末側のまま");
  ok(compareDrillStats(st(1, 0, "2026-09-21"), st(9, 9, "2026-09-20")) > 0, "compareDrillStats: 日付を最初に比べる");
  eq(compareDrillStats(st(1, 0, "2026-09-21"), st(1, 0, "2026-09-21")), 0, "compareDrillStats: 同じなら 0");
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

console.log("=== useMeta（催促の判定・前方互換） ===");
// 将来版（version:1）の保存データ。旧版で開いても消えないこと
mem.set(
  "bp-meta-v1",
  JSON.stringify({
    state: { lastBackupAt: "2026-09-20T00:00:00.000Z", reviewsAtLastBackup: 50, installDismissedAt: null, persistResult: true, futureKey: 1 },
    version: 1,
  })
);
{
  const { backupNudgeReason, installSnoozed, useMeta, BACKUP_NUDGE_DAYS, BACKUP_NUDGE_REVIEWS, INSTALL_SNOOZE_DAYS } = await import(
    "../src/store/useMeta"
  );
  const m = useMeta.getState();
  eq([m.lastBackupAt, m.reviewsAtLastBackup, m.persistResult, m.installedAt], ["2026-09-20T00:00:00.000Z", 50, true, null], "version:1 のデータも保持し、新しい項目は既定値");
  m.markBackup(80, "2026-09-24T00:00:00.000Z");
  const saved = JSON.parse(mem.get("bp-meta-v1") ?? "{}");
  eq([saved.version, saved.state?.reviewsAtLastBackup, saved.state?.futureKey], [0, 80, 1], "書き戻しても未知の項目が残る");

  const DAY = 86400000;
  const base = Date.parse("2026-09-24T12:00:00.000Z");
  const at = (days: number) => new Date(base - days * DAY).toISOString();
  eq([BACKUP_NUDGE_DAYS, BACKUP_NUDGE_REVIEWS, INSTALL_SNOOZE_DAYS], [7, 200, 30], "しきい値");
  eq(backupNudgeReason({ lastBackupAt: null, reviewsAtLastBackup: 0 }, 0, base), null, "評価0 → 出さない");
  eq(backupNudgeReason({ lastBackupAt: null, reviewsAtLastBackup: 0 }, 1, base), { kind: "never" }, "未バックアップ → never");
  eq(backupNudgeReason({ lastBackupAt: "壊れた値", reviewsAtLastBackup: 0 }, 5, base), { kind: "never" }, "時刻が壊れている → never");
  eq(backupNudgeReason({ lastBackupAt: at(6.9), reviewsAtLastBackup: 100 }, 299, base), null, "6.9日・199回 → 出さない");
  eq(backupNudgeReason({ lastBackupAt: at(7), reviewsAtLastBackup: 100 }, 101, base), { kind: "days", days: 7 }, "7日 → days");
  eq(backupNudgeReason({ lastBackupAt: at(1), reviewsAtLastBackup: 100 }, 300, base), { kind: "reviews", reviews: 200 }, "200回 → reviews");
  eq(backupNudgeReason({ lastBackupAt: at(1), reviewsAtLastBackup: 500 }, 20, base), null, "リセット後（回数が減った）→ 回数では出さない");
  eq(backupNudgeReason({ lastBackupAt: at(10), reviewsAtLastBackup: 500 }, 20, base), { kind: "days", days: 10 }, "リセット後でも日数では出す");
  eq(installSnoozed(null, base), false, "閉じていない → 出す");
  eq(installSnoozed(at(29), base), true, "閉じて29日 → 出さない");
  eq(installSnoozed(at(30), base), false, "閉じて30日 → また出す");
  eq(installSnoozed("x", base), false, "時刻が壊れている → 出す");
}

console.log("=== useDrill（前方互換・記録・出題の設定） ===");
// 将来版（version:1）の保存データ。旧版で開いても消えないこと
mem.set(
  "bp-drill-v1",
  JSON.stringify({
    state: {
      stats: { "ser|pres|0": { seen: 2, correct: 1, last: "2026-09-20" } },
      prefs: { tenses: ["impf"], futurePref: 1 },
      futureKey: 1,
    },
    version: 1,
  })
);
{
  const { useDrill, cleanPrefs, DEFAULT_DRILL_PREFS } = await import("../src/store/useDrill");
  const D = () => useDrill.getState();
  eq(D().stats, { "ser|pres|0": { seen: 2, correct: 1, last: "2026-09-20" } }, "version:1 のデータも保持する");
  eq(cleanPrefs(D().prefs).tenses, ["impf"], "保存された出題の設定を読む");
  eq(cleanPrefs(D().prefs).persons, DEFAULT_DRILL_PREFS.persons, "保存されていない設定は既定値");
  D().record("ser|pres|0", true, "2026-09-24");
  D().record("falar|pret|3", false, "2026-09-24");
  eq(D().stats["ser|pres|0"], { seen: 3, correct: 2, last: "2026-09-24" }, "record: 回数を足し、最後に答えた日を更新");
  eq(D().stats["falar|pret|3"], { seen: 1, correct: 0, last: "2026-09-24" }, "record: 初めての形（不正解）");
  const saved = JSON.parse(mem.get("bp-drill-v1") ?? "{}");
  eq([saved.version, saved.state?.futureKey, saved.state?.prefs?.futurePref], [0, 1, 1], "書き戻しても未知の項目が残る");
  eq(
    cleanPrefs({ groups: [], tenses: ["cond" as never], persons: [7 as never, 3], size: 15 }),
    { groups: DEFAULT_DRILL_PREFS.groups, tenses: DEFAULT_DRILL_PREFS.tenses, persons: [3], size: 10 },
    "cleanPrefs: 知らない値を落とし、空になった項目・知らない問題数は既定値"
  );
  eq(cleanPrefs(undefined), DEFAULT_DRILL_PREFS, "cleanPrefs: 設定が無い → 既定値");
  D().setPrefs({ tenses: ["fut", "pres"], size: 20 });
  eq([cleanPrefs(D().prefs).tenses, cleanPrefs(D().prefs).size], [["pres", "fut"], 20], "setPrefs: 時制は表の順にそろえる");
  eq(D().exportData(), { stats: D().stats }, "exportData は成績だけ（出題の設定はバックアップに入れない）");
  D().reset();
  eq(D().stats, {}, "reset: 成績を消す");
  eq(cleanPrefs(D().prefs).tenses, ["pres", "fut"], "reset: 出題の設定は残す");
}

console.log("=== exportAll / importAll（ストア） ===");
{
  // 歌詞キャッシュ（別キー）に目印の文字列を入れておき、書き出しに混ざらないことを確かめる
  const MARK = "LINHA_INVENTADA_PARA_TESTE";
  mem.set(
    "bp-lyrics-cache-v1",
    JSON.stringify({
      vidA: { id: 1, syncedLyrics: `[00:01.00] ${MARK}`, plainLyrics: MARK, instrumental: false, fetchedAt: "2026-09-24T00:00:00.000Z" },
    })
  );
  const { exportAll, importAll } = await import("../src/store/backup");
  const { useProgress } = await import("../src/store/useProgress");
  const { useMusic } = await import("../src/store/useMusic");
  const { useSettings } = await import("../src/store/useSettings");
  const { getCachedLyrics } = await import("../src/store/lyricsCache");
  const { useDrill } = await import("../src/store/useDrill");
  const P = () => useProgress.getState();
  const M = () => useMusic.getState();
  const D = () => useDrill.getState();
  ok(getCachedLyrics("vidA")?.plainLyrics === MARK, "前提: 歌詞キャッシュに目印がある");

  P().resetAll();
  P().rate("words:0010", "good");
  P().rate("words:0011", "again");
  P().pinNew(["words:0300"]);
  useMusic.setState({
    songs: {
      vidA: {
        offsetMs: 120,
        translations: { abc123: { text: "訳の例", edited: true } },
        // 自分で訳した行の印（B3-08）。紛れ込んだ行の本文のキーは書き出さない
        selfTranslated: { abc123: true, [MARK]: true },
        plainLyrics: MARK,
      } as never,
    },
    addedWords: [{ id: "words:0020", videoId: "vidA", surface: "x", createdCard: true, addedAt: "2026-09-24T00:00:00.000Z" }],
    userWords: [],
  });
  P().addCard("words:0020");
  useSettings.getState().set({
    rate: 0.8,
    dailyNewLimit: 9,
    voiceURI: "voz-do-aparelho",
    capoeiraShare: 0.5,
    dailyReviewLimit: 200,
    handsfreeGapSec: 5,
    handsfreeDirection: "ja2pt",
    replayAfterLookup: false,
  });
  P().logActivity("dictation", 1, 40);
  D().reset();
  D().record("falar|pres|3", true, "2026-09-24");
  const DRILL_STATS = { "falar|pres|3": { seen: 1, correct: 1, last: "2026-09-24" } };
  const hist = P().history;
  eq(hist[todayStr()], { reviews: 2, newWords: 2, again: 1, act: { dictation: { n: 1, sec: 40 } } }, "前提: 今日の学習ログがある");

  const json = exportAll();
  const out = JSON.parse(json) as Record<string, unknown>;
  eq(out.history, hist, "書き出しに学習ログ（history）を含める");
  eq(out.drill, { stats: DRILL_STATS }, "書き出しに活用ドリルの成績（drill）を含める（出題の設定は含めない）");
  ok(!json.includes(MARK), "書き出しに歌詞キャッシュ・歌詞の文字列が入らない");
  for (const k of ["syncedLyrics", "plainLyrics", "instrumental", "fetchedAt", "bp-lyrics-cache-v1", "lyricsCache"]) {
    ok(!json.includes(`"${k}"`), `書き出しに歌詞キャッシュの項目 ${k} が無い`);
  }
  eq(out.version, 3, "書き出しは v3");
  eq(out.app, { version: "dev", build: "dev" }, "tsx では app は dev");
  eq(Object.keys(out.cards as object).sort(), ["words:0010", "words:0011", "words:0020"], "cards");
  eq(out.pinnedNew, ["words:0300"], "pinnedNew");
  const s = out.settings as Record<string, unknown>;
  eq([s.rate, s.dailyNewLimit, "voiceURI" in s], [0.8, 9, false], "settings（voiceURI を除く）");
  eq([s.capoeiraShare, s.dailyReviewLimit], [0.5, 200], "settings に capoeiraShare・dailyReviewLimit を書き出す");
  eq([s.handsfreeGapSec, s.handsfreeDirection], [5, "ja2pt"], "settings に耳だけ復習の考える間・向きを書き出す");
  eq(
    (out.music as { songs: unknown }).songs,
    { vidA: { offsetMs: 120, translations: { abc123: { text: "訳の例", edited: true } }, selfTranslated: { abc123: true } } },
    "music.songs（自分で訳した行の印はハッシュのキーだけ）"
  );
  eq(s.replayAfterLookup, false, "settings に replayAfterLookup を書き出す");

  // 置き換えで戻る。voiceURI は端末側のまま
  P().resetAll();
  M().clearAddedWords();
  useMusic.setState({ songs: {} });
  useSettings.getState().set({
    rate: 1.2,
    dailyNewLimit: 20,
    voiceURI: "outra-voz",
    capoeiraShare: 0,
    dailyReviewLimit: 50,
    handsfreeGapSec: 2,
    handsfreeDirection: "pt2ja",
    replayAfterLookup: true,
  });
  D().reset();
  D().record("ir|pret|0", false, "2026-09-25");
  const r = importAll(json, "replace");
  ok(r.ok, "importAll 書き出したもの → ok");
  eq(Object.keys(P().cards).sort(), ["words:0010", "words:0011", "words:0020"], "cards を復元");
  eq([P().totalReviews, P().pinnedNew], [2, ["words:0300"]], "totalReviews・pinnedNew を復元");
  eq(P().history, hist, "学習ログ（history）を復元");
  eq(M().addedWords.map((w) => w.id), ["words:0020"], "曲の単語を復元");
  eq(M().songs.vidA?.offsetMs, 120, "曲の同期を復元");
  eq(M().songs.vidA?.selfTranslated, { abc123: true }, "自分で訳した行の印を復元");
  const st = useSettings.getState();
  eq([st.rate, st.dailyNewLimit, st.voiceURI], [0.8, 9, "outra-voz"], "設定を復元（voiceURI は端末側のまま）");
  eq([st.capoeiraShare, st.dailyReviewLimit], [0.5, 200], "capoeiraShare・dailyReviewLimit を復元");
  eq([st.handsfreeGapSec, st.handsfreeDirection], [5, "ja2pt"], "耳だけ復習の考える間・向きを復元");
  eq(st.replayAfterLookup, false, "調べた後は行の頭から再開（replayAfterLookup）を復元");
  eq(D().stats, DRILL_STATS, "置き換え: 活用ドリルの成績もファイルの内容");

  // 読めないものは何も変えない
  const before = JSON.stringify(P().cards);
  const bad = importAll("{ broken", "replace");
  ok(!bad.ok, "importAll 壊れた JSON → ok:false");
  eq(JSON.stringify(P().cards), before, "失敗したときは進捗を変えない");

  // v1（music 無し）: 曲のデータは端末側のまま、追加済みの語のカードを作り直す（reconcile）
  const v1 = JSON.stringify({ version: 1, cards: { "words:0030": card() }, streak: 1, bestStreak: 1, lastStudyDate: "2026-09-24", totalReviews: 1 });
  ok(importAll(v1, "replace").ok, "importAll v1 → ok");
  eq(Object.keys(P().cards).sort(), ["words:0020", "words:0030"], "v1: cards を置き換え、曲の単語のカードを作り直す");
  eq(M().addedWords.map((w) => w.id), ["words:0020"], "v1: 曲の単語は端末側のまま");
  eq(P().cards["words:0020"]?.last, null, "v1: 作り直したカードは未評価");
  eq(useSettings.getState().rate, 0.8, "v1: 設定は変えない");
  eq(P().history, {}, "v1（history 無し）で置き換え → history は {}");
  eq(D().stats, DRILL_STATS, "v1（drill 無し）で置き換え → 活用ドリルの成績は端末側のまま");

  // 進捗のリセットでは活用ドリルの成績も消す
  const { resetAllProgress } = await import("../src/store/backup");
  resetAllProgress();
  eq([Object.keys(P().cards).length, D().stats], [0, {}], "resetAllProgress: 進捗と活用ドリルの成績を消す");
  eq([M().songs.vidA?.selfTranslated, M().songs.vidA?.offsetMs], [undefined, 120], "resetAllProgress: ✍の印は消し、同期設定は残す");
  ok(!!M().songs.vidA && "translations" in M().songs.vidA, "resetAllProgress: 曲の和訳（translations）は残す");

  P().resetAll();
  M().clearAddedWords();
  useMusic.setState({ songs: {} });
}

console.log("=== importAll 統合（ストア） ===");
{
  const { exportAll, importAll } = await import("../src/store/backup");
  const { useProgress } = await import("../src/store/useProgress");
  const { useMusic } = await import("../src/store/useMusic");
  const { useSettings } = await import("../src/store/useSettings");
  const { useDrill } = await import("../src/store/useDrill");
  const P = () => useProgress.getState();
  const M = () => useMusic.getState();
  const D = () => useDrill.getState();
  const TD = todayStr();
  const ds = (seen: number, correct: number, last: string) => ({ seen, correct, last });
  const tr = (text: string, edited: boolean) => ({ text, edited });
  const hday = (reviews: number, newWords: number, again: number, act = {}) => ({ reviews, newWords, again, act });

  // この端末（スマホ）の状態
  P().resetAll();
  useProgress.setState({
    cards: {
      "words:0001": card({ last: TD, reps: 3, due: addDays(TD, 6) }),
      "words:0002": card({ last: addDays(TD, -5), reps: 2 }),
    },
    streak: 2,
    bestStreak: 5,
    lastStudyDate: TD,
    totalReviews: 40,
    customPassages: [],
    pinnedNew: ["words:0050", "words:0003"],
    history: { [TD]: hday(3, 1, 0, { music: { n: 0, sec: 60 } }) },
  });
  useMusic.setState({
    songs: { vidA: { offsetMs: 100, translations: { k1: tr("端末の訳", true) }, selfTranslated: { k1: true } } },
    addedWords: [{ id: "words:0001", videoId: "vidA", surface: "x", createdCard: false, addedAt: "2026-09-10T00:00:00.000Z" }],
    userWords: [],
  });
  useSettings.getState().set({ rate: 0.9, dailyNewLimit: 11, handsfreeGapSec: 3, handsfreeDirection: "pt2ja", replayAfterLookup: true });
  useDrill.setState({ stats: { "ser|pres|0": ds(2, 1, TD), "ir|pres|0": ds(1, 0, addDays(TD, -3)) } });
  const dailyBefore = JSON.stringify(P().daily);

  // 別の端末（PC）で作ったバックアップ
  const remote = {
    version: 3,
    app: { version: "0.1.0", build: "abc1234" },
    exportedAt: "2026-09-23T10:00:00.000Z",
    cards: {
      "words:0001": card({ last: addDays(TD, -1), reps: 9 }),
      "words:0002": card({ last: addDays(TD, -1), reps: 3, intervalDays: 8 }),
      "words:0003": card({ last: addDays(TD, -2) }),
    },
    streak: 4,
    bestStreak: 4,
    lastStudyDate: addDays(TD, -1),
    totalReviews: 55,
    customPassages: [{ id: "custom_9", title: "PC の教材", level: "short", source: "custom", chunks: [] }],
    pinnedNew: ["words:0060"],
    history: { [TD]: hday(1, 2, 1), [addDays(TD, -1)]: hday(8, 0, 2, { quiz: { n: 10, sec: 0 } }) },
    music: {
      songs: { vidA: { offsetMs: 999, translations: { k1: tr("PC の訳", true), k2: tr("機械翻訳", false) }, selfTranslated: { k2: true } } },
      addedWords: [{ id: "words:0004", videoId: "vidB", surface: "y", createdCard: true, addedAt: "2026-09-12T00:00:00.000Z" }],
      userWords: [{ id: "user:x", pt: "x", ja: "エックス", pos: "名詞" }],
    },
    settings: { rate: 1.2, dailyNewLimit: 30, handsfreeGapSec: 5, handsfreeDirection: "ja2pt", replayAfterLookup: false },
    drill: {
      stats: { "ser|pres|0": ds(9, 9, addDays(TD, -1)), "ir|pres|0": ds(4, 2, addDays(TD, -1)), "ter|pret|5": ds(1, 1, addDays(TD, -2)) },
    },
  };
  const r = importAll(JSON.stringify(remote), "merge");
  ok(r.ok, "importAll 統合 → ok");
  eq(r.ok && r.diff, { added: 2, updated: 1, removed: 0 }, "統合: 新しく入った語 2（0003 と曲の単語 0004）・変わった語 1（0002）");
  eq(P().cards["words:0001"].last, TD, "cards: 端末の方が新しい語は端末側");
  eq([P().cards["words:0002"].last, P().cards["words:0002"].intervalDays], [addDays(TD, -1), 8], "cards: ファイルの方が新しい語はファイル側");
  ok(!!P().cards["words:0003"], "cards: ファイルにだけある語を足す");
  eq(P().cards["words:0004"]?.last, null, "曲の単語（ファイル側）のカードを作り直す（reconcile）");
  eq([P().streak, P().bestStreak, P().lastStudyDate], [5, 5, TD], "連続記録: 端末の2日とファイルの4日をつないで 5日");
  eq(P().totalReviews, 55, "totalReviews は大きい方");
  eq(P().pinnedNew, ["words:0050", "words:0060"], "pinnedNew: 和集合。ファイル側で評価済みの語（0003）は外す");
  eq(P().customPassages.map((p) => p.id), ["custom_9"], "customPassages: 和集合");
  eq(
    P().history,
    { [TD]: hday(3, 2, 1, { music: { n: 0, sec: 60 } }), [addDays(TD, -1)]: hday(8, 0, 2, { quiz: { n: 10, sec: 0 } }) },
    "history: 日ごと・項目ごとに大きい方"
  );
  eq(JSON.stringify(P().daily), dailyBefore, "daily（今日のカウンタ）は端末側のまま");
  eq(
    M().songs.vidA,
    { offsetMs: 100, translations: { k1: tr("端末の訳", true), k2: tr("機械翻訳", false) }, selfTranslated: { k1: true, k2: true } },
    "曲: offsetMs は端末側、和訳は両方の行を合わせ、自分で訳した行の印は和集合"
  );
  eq(M().addedWords.map((w) => `${w.id}@${w.videoId}`), ["words:0001@vidA", "words:0004@vidB"], "曲の単語: 和集合");
  eq(M().userWords.map((u) => u.id), ["user:x"], "userWords: 和集合");
  const st = useSettings.getState();
  eq([st.rate, st.dailyNewLimit], [0.9, 11], "統合では設定を変えない（端末側のまま）");
  eq([st.handsfreeGapSec, st.handsfreeDirection], [3, "pt2ja"], "統合では耳だけ復習の設定も端末側のまま");
  eq(st.replayAfterLookup, true, "統合では replayAfterLookup も端末側のまま");
  const DRILL_MERGED = { "ser|pres|0": ds(2, 1, TD), "ir|pres|0": ds(4, 2, addDays(TD, -1)), "ter|pret|5": ds(1, 1, addDays(TD, -2)) };
  eq(D().stats, DRILL_MERGED, "drill: 形ごとに最後に答えた日が新しい方（端末だけ・ファイルだけの形も残す）");

  // 同じファイルをもう一度統合しても変わらない
  const snapshot = () => JSON.stringify([P().cards, P().history, P().streak, P().bestStreak, P().lastStudyDate, P().totalReviews, P().pinnedNew, P().customPassages, M().songs, M().addedWords, M().userWords]);
  const s1 = snapshot();
  const r2 = importAll(JSON.stringify(remote), "merge");
  eq(r2.ok && r2.diff, { added: 0, updated: 0, removed: 0 }, "同じファイルをもう一度統合 → 変化なし");
  eq(snapshot(), s1, "同じファイルをもう一度統合 → 状態も同じ");
  // 自分のバックアップを統合しても変わらない
  const r3 = importAll(exportAll(), "merge");
  eq(r3.ok && r3.diff, { added: 0, updated: 0, removed: 0 }, "自分のバックアップを統合 → 変化なし");
  eq(snapshot(), s1, "自分のバックアップを統合 → 状態も同じ");
  eq(D().stats, DRILL_MERGED, "同じファイル・自分のバックアップを統合 → 活用ドリルの成績も同じ");

  // v1（music・history 無し）の統合: 曲のデータと学習ログは端末側を残す
  const v1 = { version: 1, cards: { "words:0005": card({ last: addDays(TD, -3) }) }, streak: 1, bestStreak: 1, lastStudyDate: addDays(TD, -3), totalReviews: 1 };
  const r4 = importAll(JSON.stringify(v1), "merge");
  eq(r4.ok && r4.diff, { added: 1, updated: 0, removed: 0 }, "v1 を統合 → 語を足す");
  eq(Object.keys(P().cards).sort(), ["words:0001", "words:0002", "words:0003", "words:0004", "words:0005"], "v1 を統合 → 端末の語は消えない");
  eq(JSON.stringify([M().songs, M().addedWords, M().userWords]), JSON.stringify(JSON.parse(s1).slice(8)), "v1 を統合 → 曲のデータは端末側のまま");
  eq(P().history, JSON.parse(s1)[1], "v1 を統合 → 学習ログは端末側のまま");
  eq([P().streak, P().lastStudyDate, P().totalReviews], [5, TD, 55], "v1 を統合 → 連続記録・評価回数は大きい方");
  eq(D().stats, DRILL_MERGED, "v1 を統合 → 活用ドリルの成績は端末側のまま");

  // 置き換えを選んだとき: 端末だけの記録は消え、設定はファイルの内容になる
  const r5 = importAll(JSON.stringify(remote), "replace");
  ok(r5.ok, "importAll 置き換え → ok");
  eq(Object.keys(P().cards).sort(), ["words:0001", "words:0002", "words:0003", "words:0004"], "置き換え: ファイルの語＋曲の単語のカード");
  eq(P().cards["words:0001"].last, addDays(TD, -1), "置き換え: 端末の方が新しくてもファイル側");
  eq(P().history, remote.history, "置き換え: 学習ログもファイル側");
  eq([useSettings.getState().rate, useSettings.getState().dailyNewLimit], [1.2, 30], "置き換え: 設定もファイルの内容");
  eq(M().songs.vidA?.offsetMs, 999, "置き換え: 曲のデータもファイル側");
  eq(M().songs.vidA?.selfTranslated, { k2: true }, "置き換え: 自分で訳した行の印もファイル側");
  eq(useSettings.getState().replayAfterLookup, false, "置き換え: replayAfterLookup もファイルの内容");
  eq(D().stats, remote.drill.stats, "置き換え: 活用ドリルの成績もファイル側");

  // ごく古いファイル（和訳のキーが行の本文）: 統合の前にハッシュにそろえ、手で直した端末の訳を残す
  const KEY_TEXT = "Linha inventada para o teste";
  useMusic.setState({ songs: { vidZ: { offsetMs: 0, translations: { [lineHash(KEY_TEXT)]: tr("端末で直した訳", true) } } } });
  const oldFile = { ...remote, music: { songs: { vidZ: { offsetMs: 5, translations: { [KEY_TEXT]: tr("古い機械翻訳", false) } } }, addedWords: [], userWords: [] } };
  ok(importAll(JSON.stringify(oldFile), "merge").ok, "importAll 統合 古い形式の和訳キー → ok");
  eq(M().songs.vidZ, { offsetMs: 0, translations: { [lineHash(KEY_TEXT)]: tr("端末で直した訳", true) } }, "古い形式のキーはハッシュにそろえてから統合（手で直した端末の訳を残す）");
  ok(!JSON.stringify(M().songs).includes(KEY_TEXT), "行の本文をキーとして残さない");

  // 読めないファイルは、統合でも何も変えない
  const before = snapshot();
  ok(!importAll("{ broken", "merge").ok, "importAll 統合 壊れた JSON → ok:false");
  eq(snapshot(), before, "統合に失敗したときは何も変えない");

  P().resetAll();
  M().clearAddedWords();
  useMusic.setState({ songs: {}, userWords: [] });
  D().reset();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
