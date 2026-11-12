// ============================================================================
// コース（場面別レッスン）の教材の検査: data/course/u*.json
//   npm run check:course            … すべてのユニット
//   npx tsx scripts/check-course.ts data/course/u3.json … 指定したファイルだけ
// 形（ID・行数・役・フレーズ数）と、話す練習で困る書き方（数字の表記・長すぎる文・和文の重複）を確かめる。
// レッスンのフレーズ ID は SRS（口慣らし）の記録のキーになるので、公開後は変えない・並べ替えない。
// ============================================================================

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "data", "course");

let failed = 0;
let warned = 0;
const err = (where: string, msg: string) => {
  failed++;
  console.error(`✗ ${where}: ${msg}`);
};
const warn = (where: string, msg: string) => {
  warned++;
  console.warn(`△ ${where}: ${msg}`);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const JA_RE = /[぀-ヿ一-鿿]/;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** ポルトガル語の文として使える書き方か（日本語が混ざらない・数字は語で書く・長すぎない） */
function checkPt(where: string, pt: unknown, maxWords: number): void {
  if (!isStr(pt)) return err(where, "pt が空です");
  if (JA_RE.test(pt)) err(where, `pt に日本語が入っています: ${pt}`);
  if (/\d/.test(pt)) err(where, `pt に数字があります（語で書く。例: vinte reais）: ${pt}`);
  if (/[{}\[\]<>/]/.test(pt)) err(where, `pt に記号（{} [] <> /）があります: ${pt}`);
  if (pt !== pt.trim()) err(where, "pt の前後に空白があります");
  if (words(pt) > maxWords) err(where, `pt が長すぎます（${words(pt)}語 > ${maxWords}語）: ${pt}`);
}

function checkJa(where: string, ja: unknown): void {
  if (!isStr(ja)) return err(where, "ja が空です");
  if (!JA_RE.test(ja)) err(where, `ja に日本語がありません: ${ja}`);
  if (ja !== ja.trim()) err(where, "ja の前後に空白があります");
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2).map((f) => resolve(f))
  : readdirSync(DIR)
      .filter((f) => /^u\d+\.json$/.test(f))
      .sort()
      .map((f) => join(DIR, f));

if (!files.length) err("data/course", "ユニットのファイル（u1.json …）がありません");

const seenLesson = new Set<string>();
const seenPhrase = new Set<string>();
const jaToId = new Map<string, string>();
const ptToId = new Map<string, string>();
let lessons = 0;
let phrases = 0;
let lines = 0;

for (const file of files) {
  const name = file.replace(ROOT + "/", "");
  let unit: unknown;
  try {
    unit = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    err(name, `JSON として読めません: ${(e as Error).message}`);
    continue;
  }
  if (!isObj(unit)) {
    err(name, "ユニットは object で書きます");
    continue;
  }
  const uid = unit.id;
  if (!isStr(uid) || !/^u\d+$/.test(uid)) err(name, `id は u1 のように書きます: ${String(uid)}`);
  else if (!name.endsWith(`${uid}.json`)) err(name, `ファイル名と id が合いません: ${uid}`);
  if (!isStr(unit.title)) err(name, "title が空です");
  if (!isStr(unit.goal)) err(name, "goal が空です");
  const ls = Array.isArray(unit.lessons) ? unit.lessons : [];
  if (ls.length !== 6) err(name, `レッスンは6つ（今 ${ls.length}）`);

  ls.forEach((l, li) => {
    const lid = `${String(uid)}l${li + 1}`;
    const where = `${name} ${lid}`;
    if (!isObj(l)) return err(where, "レッスンは object で書きます");
    lessons++;
    if (l.id !== lid) err(where, `id は ${lid}（今 ${String(l.id)}）`);
    if (seenLesson.has(lid)) err(where, "レッスンの id が重複しています");
    seenLesson.add(lid);
    for (const k of ["title", "goal", "scene", "partner"] as const) if (!isStr(l[k])) err(where, `${k} が空です`);
    if (isStr(l.title) && l.title.length > 16) err(where, `title は16文字まで: ${l.title}`);

    // 会話
    const dl = Array.isArray(l.lines) ? l.lines : [];
    if (dl.length < 6 || dl.length > 10) err(where, `lines は6〜10行（今 ${dl.length}）`);
    let you = 0;
    dl.forEach((x, i) => {
      const w = `${where} lines[${i}]`;
      if (!isObj(x)) return err(w, "行は object で書きます");
      lines++;
      if (x.who !== "you" && x.who !== "partner") err(w, `who は "you" か "partner"（今 ${String(x.who)}）`);
      if (x.who === "you") you++;
      checkPt(w, x.pt, 16);
      checkJa(w, x.ja);
    });
    if (you < 3) err(where, `自分（you）のセリフは3行以上（今 ${you}）`);
    if (isObj(dl[0]) && isObj(dl[1]) && dl.every((x) => isObj(x) && x.who === (dl[0] as Record<string, unknown>).who)) {
      err(where, "話者が1人しかいません");
    }

    // フレーズ（口慣らしに入る文）
    const ps = Array.isArray(l.phrases) ? l.phrases : [];
    if (ps.length < 6 || ps.length > 8) err(where, `phrases は6〜8個（今 ${ps.length}）`);
    ps.forEach((p, i) => {
      const pid = `${lid}p${i + 1}`;
      const w = `${where} ${pid}`;
      if (!isObj(p)) return err(w, "フレーズは object で書きます");
      phrases++;
      if (p.id !== pid) err(w, `id は ${pid}（今 ${String(p.id)}）`);
      if (seenPhrase.has(pid)) err(w, "フレーズの id が重複しています");
      seenPhrase.add(pid);
      checkPt(w, p.pt, 14);
      checkJa(w, p.ja);
      if (p.alt !== undefined) {
        if (!Array.isArray(p.alt) || !p.alt.length) err(w, "alt は1つ以上の文字列の配列（無ければ項目ごと省く）");
        else p.alt.forEach((a, ai) => checkPt(`${w} alt[${ai}]`, a, 14));
      }
      if (p.note !== undefined && !isStr(p.note)) err(w, "note は空でない文字列（無ければ項目ごと省く）");
      if (isStr(p.note) && p.note.length > 90) err(w, `note は90文字まで（今 ${p.note.length}）`);
      for (const k of Object.keys(p)) if (!["id", "ja", "pt", "alt", "note"].includes(k)) err(w, `知らない項目: ${k}`);
      // 同じ和文から別の文を言わせない（どちらを言えばよいか分からない）
      if (isStr(p.ja)) {
        const prev = jaToId.get(p.ja);
        if (prev) err(w, `和文が ${prev} と同じです（場面や相手を括弧で添えて区別する）: ${p.ja}`);
        else jaToId.set(p.ja, pid);
      }
      if (isStr(p.pt)) {
        const key = p.pt.toLowerCase();
        const prev = ptToId.get(key);
        if (prev) warn(w, `ポルトガル語が ${prev} と同じです: ${p.pt}`);
        else ptToId.set(key, pid);
      }
    });

    // ポイント
    const tips = Array.isArray(l.tips) ? l.tips : [];
    if (tips.length < 1 || tips.length > 2) err(where, `tips は1〜2個（今 ${tips.length}）`);
    tips.forEach((t, i) => {
      const w = `${where} tips[${i}]`;
      if (!isObj(t) || !isStr(t.title) || !isStr(t.body)) return err(w, "title と body を書きます");
      if (t.title.length > 30) err(w, `title は30文字まで（今 ${t.title.length}）`);
      if (t.body.length > 220) err(w, `body は220文字まで（今 ${t.body.length}）`);
    });

    // AI との会話の場面
    const talk = l.talk;
    if (!isObj(talk)) return err(where, "talk がありません");
    if (!isStr(talk.role)) err(where, "talk.role が空です");
    if (!isStr(talk.setting)) err(where, "talk.setting が空です");
    checkPt(`${where} talk.opener`, talk.opener, 16);
    const ms = Array.isArray(talk.missions) ? talk.missions : [];
    if (ms.length !== 3) err(where, `talk.missions は3つ（今 ${ms.length}）`);
    ms.forEach((m, i) => {
      if (!isStr(m)) err(`${where} talk.missions[${i}]`, "空です");
      else if (m.length > 24) err(`${where} talk.missions[${i}]`, `24文字まで: ${m}`);
    });
    for (const k of Object.keys(l)) {
      if (!["id", "title", "goal", "scene", "partner", "lines", "phrases", "tips", "talk"].includes(k)) err(where, `知らない項目: ${k}`);
    }
  });
}

console.log(`\nユニット ${files.length}・レッスン ${lessons}・会話 ${lines}行・フレーズ ${phrases}文`);
if (warned) console.log(`注意 ${warned}件`);
if (failed) {
  console.error(`${failed} 件の誤りがあります`);
  process.exit(1);
}
console.log("OK");
