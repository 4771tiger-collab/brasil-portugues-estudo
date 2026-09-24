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
  readMusic,
  type BackupData,
  type ParseResult,
} from "../src/store/backupFormat";

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
    settings: { ...V3.settings, capoeiraShare: 0.33 },
  };
  const r = parseBackup(JSON.stringify(future));
  const d = data(r, "v4");
  if (d) {
    eq(d.version, 4, "version 4 のまま返す");
    eq(Object.keys(d.progress.cards).length, 2, "知っている項目（cards）は読む");
    eq(d.music, MUSIC, "music も読む");
    ok(!!d.settings && !("capoeiraShare" in d.settings), "知らない設定は読まない");
    eq(Object.keys(d).sort(), ["app", "exportedAt", "music", "progress", "settings", "version"], "知らない最上位の項目は持ち込まない");
  }
  eq(r.ok && r.warnings.length, 1, "警告が1件");
  ok(r.ok && /新しいバージョン/.test(r.warnings[0]) && r.warnings[0].includes("v0.9.0"), "警告に「新しいバージョン」と版");
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
}

console.log("=== pickSettings ===");
{
  eq(
    pickSettings({ rate: 0, dailyNewLimit: -1, dailyGoal: 30, showKana: "yes", studyView: "grid", studyDirection: "ja2pt", voiceURI: "v", set: () => 0, extra: 1 }),
    { dailyGoal: 30, studyDirection: "ja2pt" },
    "型・範囲・選択肢の合わない値、voiceURI、関数、未知の項目を落とす"
  );
  eq(pickSettings(null), {}, "object でない → {}");
  eq(pickSettings({ dailyNewLimit: Infinity, rate: NaN }), {}, "Infinity・NaN を落とす");
}

console.log("=== composeBackup（v3 の書き出し） ===");
{
  const out = composeBackup({
    progress: { version: 1, ...PROGRESS, pinnedNew: ["words:0100"] },
    music: {
      ...MUSIC,
      // ストアに紛れ込んだ未知の項目も書き出さない
      songs: { vidA: { ...MUSIC.songs.vidA, plainLyrics: "linha inventada" } as (typeof MUSIC.songs)["vidA"] },
    },
    settings: { ...V3.settings, set: () => undefined, reset: () => undefined },
    app: { version: "0.1.0", build: "abc1234" },
  });
  eq(out.version, 3, "version は 3 に上書き");
  for (const k of ["cards", "streak", "bestStreak", "lastStudyDate", "totalReviews", "customPassages", "exportedAt", "pinnedNew"]) {
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
    eq(d.music, MUSIC, "往復: music");
    eq(d.settings, pickSettings(V3.settings), "往復: settings");
    ok(describeBackup(d).includes("学習した単語 2語") && describeBackup(d).includes("評価 321回"), "describeBackup: 語数と評価回数");
    ok(describeBackup(d).includes("曲の単語 1語") && describeBackup(d).includes("設定を含む"), "describeBackup: 曲の単語と設定");
  }
  eq(r.ok && r.warnings, [], "往復: 警告なし");
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
  const P = () => useProgress.getState();
  const M = () => useMusic.getState();
  ok(getCachedLyrics("vidA")?.plainLyrics === MARK, "前提: 歌詞キャッシュに目印がある");

  P().resetAll();
  P().rate("words:0010", "good");
  P().rate("words:0011", "again");
  P().pinNew(["words:0300"]);
  useMusic.setState({
    songs: {
      vidA: { offsetMs: 120, translations: { abc123: { text: "訳の例", edited: true } }, plainLyrics: MARK } as never,
    },
    addedWords: [{ id: "words:0020", videoId: "vidA", surface: "x", createdCard: true, addedAt: "2026-09-24T00:00:00.000Z" }],
    userWords: [],
  });
  P().addCard("words:0020");
  useSettings.getState().set({ rate: 0.8, dailyNewLimit: 9, voiceURI: "voz-do-aparelho" });

  const json = exportAll();
  const out = JSON.parse(json) as Record<string, unknown>;
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
  eq((out.music as { songs: unknown }).songs, { vidA: { offsetMs: 120, translations: { abc123: { text: "訳の例", edited: true } } } }, "music.songs");

  // 置き換えで戻る。voiceURI は端末側のまま
  P().resetAll();
  M().clearAddedWords();
  useMusic.setState({ songs: {} });
  useSettings.getState().set({ rate: 1.2, dailyNewLimit: 20, voiceURI: "outra-voz" });
  const r = importAll(json);
  ok(r.ok, "importAll 書き出したもの → ok");
  eq(Object.keys(P().cards).sort(), ["words:0010", "words:0011", "words:0020"], "cards を復元");
  eq([P().totalReviews, P().pinnedNew], [2, ["words:0300"]], "totalReviews・pinnedNew を復元");
  eq(M().addedWords.map((w) => w.id), ["words:0020"], "曲の単語を復元");
  eq(M().songs.vidA?.offsetMs, 120, "曲の同期を復元");
  const st = useSettings.getState();
  eq([st.rate, st.dailyNewLimit, st.voiceURI], [0.8, 9, "outra-voz"], "設定を復元（voiceURI は端末側のまま）");

  // 読めないものは何も変えない
  const before = JSON.stringify(P().cards);
  const bad = importAll("{ broken");
  ok(!bad.ok, "importAll 壊れた JSON → ok:false");
  eq(JSON.stringify(P().cards), before, "失敗したときは進捗を変えない");

  // v1（music 無し）: 曲のデータは端末側のまま、追加済みの語のカードを作り直す（reconcile）
  const v1 = JSON.stringify({ version: 1, cards: { "words:0030": card() }, streak: 1, bestStreak: 1, lastStudyDate: "2026-09-24", totalReviews: 1 });
  ok(importAll(v1).ok, "importAll v1 → ok");
  eq(Object.keys(P().cards).sort(), ["words:0020", "words:0030"], "v1: cards を置き換え、曲の単語のカードを作り直す");
  eq(M().addedWords.map((w) => w.id), ["words:0020"], "v1: 曲の単語は端末側のまま");
  eq(P().cards["words:0020"]?.last, null, "v1: 作り直したカードは未評価");
  eq(useSettings.getState().rate, 0.8, "v1: 設定は変えない");

  P().resetAll();
  M().clearAddedWords();
  useMusic.setState({ songs: {} });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
