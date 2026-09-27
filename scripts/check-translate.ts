// ============================================================================
// 歌詞の和訳の改善（無料の機械翻訳）の回帰テスト
//   npm run check:translate
// - lyricSentences.ts: 歌詞の行を文にまとめる（groupLyricLines）・文のキー（lineGroupKey）・訳す単位・表示の優先順位
// - mtNormalize.ts: 機械翻訳に送る前の口語形の正規化（normalizeForMT）
// - translate.ts: translateUnits（正規化して送り、元の単位に対応した順で返す）。偽の翻訳関数・偽の fetch で動かし、
//   実際には通信しない
// - aiTranslate.ts: AI 翻訳（Claude）のプロンプト・応答の検査・料金・呼び出し（偽のクライアントを渡す。
//   その間は fetch を「呼ばれたら失敗」に差し替えて、実際に通信しないことも確かめる）
// 例はすべてこの検証のために作った短いポルトガル語の文（歌詞は使わない）。1件でも失敗したら終了コード1。
// ============================================================================

import {
  CONNECTOR_WORDS,
  GROUP_MAX_GAP_SEC,
  GROUP_MAX_LINES,
  GROUP_MAX_WORDS,
  continuesInto,
  groupIndexByLine,
  groupLyricLines,
  lineGroupKey,
  pendingUnits,
  resolveLineTranslation,
  toJaMode,
  translationUnits,
  type LyricGroup,
  type LyricGroupInput,
  type StoredTranslation,
} from "../src/services/lyricSentences";
import { normalizeForMT } from "../src/services/mtNormalize";
import { translateUnits } from "../src/services/translate";
import { isLineHash, lineHash } from "../src/services/lyrics";
import Anthropic from "@anthropic-ai/sdk";
import {
  AI_MODELS,
  AI_MODEL_INFO,
  AI_NOTE_MAX,
  AI_TRANSLATION_SCHEMA,
  AiTranslateError,
  buildAiTranslatePrompt,
  clampNote,
  costFromUsage,
  estimateAiCost,
  formatUsd,
  formatYen,
  isUntranslatableLine,
  parseAiTranslation,
  parseJsonText,
  scrubLineFromNote,
  songLinesForAi,
  testClaudeConnection,
  toAiModel,
  translateSongWithClaude,
  type MessagesClient,
} from "../src/services/aiTranslate";

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
async function throws(fn: () => Promise<unknown>, label: string) {
  try {
    await fn();
    fail++;
    console.error(`  ✗ ${label}: 例外にならなかった`);
  } catch {
    pass++;
  }
}

const L = (text: string, time?: number | null): LyricGroupInput => ({ text, time });
/** 文のまとまりを [start, end] の組で（読みやすさのため） */
const spans = (gs: LyricGroup[]) => gs.map((g) => [g.start, g.end]);
const grp = (texts: (string | [string, number | null])[]) =>
  spans(groupLyricLines(texts.map((t) => (typeof t === "string" ? L(t) : L(t[0], t[1])))));

// ---------------------------------------------------------------------------
console.log("=== continuesInto（行が次の行に文としてつながるか） ===");
{
  ok(continuesInto("Eu vou andar pela rua", "sem pensar em nada"), "次の行が小文字で始まる → つなげる");
  ok(continuesInto("Quando a chuva cair,", "Eu vou ficar aqui"), "行末が , → つなげる（次が大文字でも）");
  ok(continuesInto("Ele respondeu assim;", "Nada mais"), "行末が ; → つなげる");
  ok(continuesInto("Ela me disse:", "Volte amanhã"), "行末が : → つなげる");
  ok(!continuesInto("Eu quero", "Ver o mar azul"), "最後の語が quero（動詞）で次が大文字 → つなげない（動詞は文の終わりにも来る）");
  ok(!continuesInto("Você sabe como é", "A gente se vê amanhã"), "最後の語が é で次が大文字の新しい文 → つなげない");
  ok(!continuesInto("Com você eu vou", "O meu corpo balança"), "最後の語が vou で次が大文字の新しい文 → つなげない");
  ok(!continuesInto("Eu sei", "Amanhã vai chover"), "最後の語が sei で次が大文字の新しい文 → つなげない");
  ok(continuesInto("Eu quero", "ver o mar azul"), "動詞で終わっても、次の行が小文字で始まればつなげる");
  ok(continuesInto("Ela disse que", "Nada mudou"), "最後の語が que → つなげる");
  ok(continuesInto("O barco da", "Vila chegou"), "最後の語が da → つなげる");
  ok(continuesInto("O barco DA", "Vila chegou"), "最後の語の大文字小文字は問わない（DA）");
  ok(continuesInto("Ela falou", "“vem cá” e sorriu"), "行頭の引用符は飛ばして小文字か見る");
  ok(!continuesInto("O sol brilha forte", "A praia está cheia"), "大文字で始まり、つなぎの語・読点も無い → つなげない");
  ok(!continuesInto("Eu cheguei.", "agora vou embora"), "文末の . → つなげない（次が小文字でも）");
  ok(!continuesInto("Vem comigo!", "que a noite é nossa"), "文末の ! → つなげない");
  ok(!continuesInto("E agora?", "ninguém responde"), "文末の ? → つなげない");
  ok(!continuesInto("E eu fiquei…", "sozinho aqui"), "文末の … → つなげない");
  ok(!continuesInto("Ela disse: “Adeus.”", "depois saiu"), "文末の記号の後ろの閉じ引用符は文末のまま");
  ok(!continuesInto("Eu vou pra lá", "(pra lá)"), "次の行が括弧だけ（合いの手）→ つなげない");
  ok(!continuesInto("(uma voz ao fundo)", "e depois o silêncio"), "括弧だけの行からもつなげない");
  ok(!continuesInto("", "sem nada"), "空の行 → つなげない");
  ok(!continuesInto("Eu vou de", "   "), "次が空の行 → つなげない");
  for (const w of ["que", "de", "do", "da", "e", "o", "a", "os", "as", "um", "uma", "pra", "pro", "com", "em", "no", "na", "se", "quando", "porque", "mas", "sem", "por", "pelo", "pela", "meu", "minha", "teu", "seu", "sua", "nosso"]) {
    ok(CONNECTOR_WORDS.has(w), `つなぎの語: ${w}`);
  }
  for (const w of ["é", "vai", "vou", "quero", "sei"]) {
    ok(!CONNECTOR_WORDS.has(w), `文の終わりにも来る動詞はつなぎの語にしない: ${w}`);
  }
}

console.log("=== groupLyricLines（文にまとめる） ===");
{
  eq(groupLyricLines([]), [], "空の歌詞 → 文なし");
  eq(grp(["Eu vou andar pela rua", "sem pensar em nada", "", "A noite chegou."]), [[0, 2], [3, 4]], "小文字で続く2行 → 1文。空行をまたがない");
  eq(grp(["O sol brilha forte", "A praia está cheia", "O vento sopra"]), [[0, 1], [1, 2], [2, 3]], "つながらない行はそれぞれ1文");
  eq(grp(["Eu quero", "Ver o mar azul", "E voltar"]), [[0, 1], [1, 2], [2, 3]], "動詞（quero）で終わる行は、次が大文字ならつなげない");
  eq(grp(["Você sabe como é", "A gente se vê amanhã"]), [[0, 1], [1, 2]], "「… como é」＋次の文 → 別々の文");
  eq(grp(["O barco da", "Vila chegou", "E voltar"]), [[0, 2], [2, 3]], "つなぎの語（da）で2行を1文に");
  eq(grp(["Eu vou de", "", "barco pro mar"]), [[0, 1], [2, 3]], "つなぎの語で終わっても空行（間奏）はまたがない");
  eq(grp(["Um,", "Dois,", "Três,", "Quatro"]), [[0, 3], [3, 4]], `${GROUP_MAX_LINES}行を超えない`);
  const ten = "uma palavra duas palavras três palavras quatro palavras cinco pa";
  eq(ten.split(" ").length, 10, "前提: 10語の行");
  eq(grp([`${ten},`, `${ten},`, `${ten}.`]), [[0, 2], [2, 3]], `${GROUP_MAX_WORDS}語を超えない（10+10 は可、+10 は不可）`);
  const long = Array.from({ length: 30 }, (_, i) => `p${i}`).join(" ");
  eq(grp([long, "e mais uma coisa"]), [[0, 1], [1, 2]], `1行で${GROUP_MAX_WORDS}語を超える行は1行の文（次もつなげない）`);
  // 時刻: 次の行まで GROUP_MAX_GAP_SEC を超えたら切る（ちょうどは可）。時刻が分からなければ切らない
  eq(grp([["Quando a chuva cair,", 10], ["eu vou ficar aqui", 10 + GROUP_MAX_GAP_SEC + 0.5]]), [[0, 1], [1, 2]], "時刻の間が 7 秒を超える → つなげない");
  eq(grp([["Quando a chuva cair,", 10], ["eu vou ficar aqui", 10 + GROUP_MAX_GAP_SEC]]), [[0, 2]], "時刻の間がちょうど 7 秒 → つなげる");
  eq(grp([["Quando a chuva cair,", null], ["eu vou ficar aqui", 30]]), [[0, 2]], "時刻の片方が分からない → 時刻では切らない");
  eq(grp([["Quando a chuva cair,", 10], ["eu vou ficar aqui", 12], ["", 13], ["e depois", 14]]), [[0, 2], [3, 4]], "空行（時刻つき）もまたがない");
  eq(grp(["Eu vou pra lá", "(pra lá)", "e volto amanhã"]), [[0, 1], [1, 2], [2, 3]], "括弧だけの行（合いの手）は前後とつなげない");
  eq(grp(["   ", "Eu vou andar", "sem destino", "  "]), [[1, 3]], "空白だけの行は空行として飛ばす");

  // どの空でない行もちょうど1つの文に入る・順番どおり・空行は入らない
  const sample = [
    "Eu vou andar pela rua",
    "sem pensar em nada,",
    "Com você",
    "",
    "Quero dizer que",
    "Tudo vai mudar.",
    "(tudo)",
    "O céu é azul",
    "A lua é branca",
    "",
    "",
    "E eu fico aqui",
  ];
  const gs = groupLyricLines(sample.map((t) => L(t)));
  const covered: number[] = [];
  gs.forEach((g, gi) => {
    ok(g.end > g.start && g.end - g.start <= GROUP_MAX_LINES, `文 ${gi}: 1〜${GROUP_MAX_LINES}行`);
    for (let i = g.start; i < g.end; i++) covered.push(i);
    eq(g.text, sample.slice(g.start, g.end).join(" "), `文 ${gi}: 本文は行を空白1つでつないだもの`);
  });
  eq(covered, sample.map((t, i) => (t.trim() ? i : -1)).filter((i) => i >= 0), "空でない行をちょうど1回ずつ、順番どおりに覆う");
  eq(spans(gs), [[0, 3], [4, 6], [6, 7], [7, 8], [8, 9], [11, 12]], "例: まとまり");
  eq(groupIndexByLine(gs, sample.length), [0, 0, 0, -1, 1, 1, 2, 3, 4, -1, -1, 5], "groupIndexByLine: 行 → 文の番号（空行は -1）");
  eq(groupLyricLines([L("Eu   vou  andar"), L("sem\tdestino")])[0].text, "Eu vou andar sem destino", "文の本文は空白を1つにそろえる");
}

console.log("=== lineGroupKey（文の保存キー） ===");
{
  const [g] = groupLyricLines([L("Eu vou andar"), L("sem destino")]);
  const k = lineGroupKey(g);
  ok(isLineHash(k), "ハッシュの形（歌詞本文を保存しない）");
  eq(k, lineHash("Eu vou andar sem destino"), "つないだ本文の lineHash");
  eq(lineGroupKey(groupLyricLines([L(" Eu vou  andar "), L("sem   destino")])[0]), k, "空白の違いでは変わらない");
  eq(lineGroupKey(groupLyricLines([L("Eu vou andar"), L("sem destino")])[0]), k, "同じ行からは毎回同じキー");
  eq(lineGroupKey({ text: "Eu vou andar sem destino".normalize("NFD") }), k, "Unicode の正規化の違いでは変わらない");
  const [single] = groupLyricLines([L("A noite chegou.")]);
  eq(lineGroupKey(single), lineHash("A noite chegou."), "1行だけの文のキーはその行のキーと同じ");
  ok(lineGroupKey({ text: "sem destino Eu vou andar" }) !== k, "行の順番が違えば別のキー");
}

console.log("=== normalizeForMT（口語形の正規化） ===");
{
  const cases: [string, string, string][] = [
    ["Eu tô aqui", "Eu estou aqui", "tô → estou"],
    ["Tá bom", "Está bom", "Tá → Está（先頭の大文字を保つ）"],
    ["TÔ CHEGANDO", "ESTOU CHEGANDO", "全部大文字を保つ"],
    ["Ela tava cansada", "Ela estava cansada", "tava → estava"],
    ["Eles tavam lá", "Eles estavam lá", "tavam → estavam"],
    ["Tamo junto", "Estamos junto", "tamo → estamos"],
    ["Nós tamos aqui", "Nós estamos aqui", "tamos → estamos"],
    ["Vou pra casa", "Vou para casa", "pra → para"],
    ["Levei flores pras amigas", "Levei flores para as amigas", "pras → para as"],
    ["Vamos pro mar", "Vamos para o mar", "pro → para o"],
    ["Dei doce pros meninos", "Dei doce para os meninos", "pros → para os"],
    ["Cê sabe", "Você sabe", "cê → você"],
    ["Ocê vem?", "Você vem?", "ocê → você"],
    ["Cês vêm?", "Vocês vêm?", "cês → vocês"],
    ["Bonito, né?", "Bonito, não é?", "né → não é"],
    ["Cadê você?", "Onde está você?", "cadê → onde está"],
    ["Vamo embora", "Vamos embora", "vamo → vamos"],
    ["Bora dançar", "Vamos dançar", "bora → vamos（embora は足さない）"],
    ["Bora ser feliz", "Vamos ser feliz", "bora + 不定詞 → vamos"],
    ["'Tá tudo bem", "Está tudo bem", "'Tá（頭のアポストロフィ）→ Está"],
    ["Agora ’tô aqui", "Agora estou aqui", "’tô（曲がったアポストロフィ）→ estou"],
    ["Um copo d'água", "Um copo de água", "d'água → de água（省略したのは前置詞 de）"],
    ["D’água fresca", "De água fresca", "D’água → De água（曲がったアポストロフィ・大文字）"],
    ["(pra você)", "(para você)", "括弧の中でも直す"],
    ["tô, tá, né.", "estou, está, não é.", "読点・句点の直前でも直す"],
    ["“Cê voltou”", "“Você voltou”", "引用符の直後でも直す"],
    ["Ele disse 'pra lá'", "Ele disse 'para lá'", "一重引用符で囲まれていても直す"],
    ["Vem pra cá!", "Vem para cá!", "感嘆符の前"],
    ["Tô\ttranquilo", "Estou\ttranquilo", "タブの前"],
    ["Eu tô bem", "Eu estou bem", "分解された文字（NFD）の tô も直す"],
  ];
  for (const [src, want, label] of cases) eq(normalizeForMT(src), want, `normalizeForMT: ${label}`);

  // 意味が1つに決まらない形・語の一部は触らない
  const untouched = [
    "Estou tão feliz",
    "Eles tão aqui",
    "Num sei",
    "Eu moro num prédio",
    "Até té logo",
    "Um prato de arroz",
    "Os pratos limpos",
    "Um protesto na rua",
    "O tomate vermelho",
    "Qual o tamanho",
    "Tatá chegou",
    "Nós vamos agora",
    "Uma cadeira velha",
    "Eu estou aqui",
    "Vamos pra-lá-e-pra-cá",
    "Tá-tá-tá na porta",
    "Ele to be",
    "Ta certo",
    "Meu vô chegou",
    "Se ele tiver tempo",
    "Pró e contra",
    "Um boracéa",
    "prazer",
    "d'agua sem acento",
    "",
  ];
  for (const src of untouched) eq(normalizeForMT(src), src, `normalizeForMT: 触らない「${src}」`);

  // 何度かけても同じ（直した結果に直す形は残らない）
  for (const [src] of cases) {
    const once = normalizeForMT(src);
    eq(normalizeForMT(once), once, `normalizeForMT: 2回かけても同じ「${src}」`);
  }
}

console.log("=== translateUnits（偽の翻訳関数） ===");
{
  const calls: string[][] = [];
  let seenSignal: AbortSignal | undefined;
  const fake = async (lines: string[], signal?: AbortSignal) => {
    calls.push([...lines]);
    seenSignal = signal;
    return lines.map((l) => ` 訳(${l}) `);
  };
  const ctrl = new AbortController();
  const out = await translateUnits(["Eu tô aqui", "", "Vou pra casa", "Eu tô aqui", "  ", "Eu  vou\nandar"], ctrl.signal, fake);
  eq(calls, [["Eu estou aqui", "Vou para casa", "Eu vou andar"]], "正規化して送る・同じ文は1回・空の単位は送らない・改行や連続空白は1つの空白に");
  eq(out, ["訳(Eu estou aqui)", "", "訳(Vou para casa)", "訳(Eu estou aqui)", "", "訳(Eu vou andar)"], "戻り値は元の単位と同じ長さ・同じ順序（前後の空白は除く）");
  ok(seenSignal === ctrl.signal, "中断の signal を渡す");

  calls.length = 0;
  eq(await translateUnits(["", "   "], undefined, fake), ["", ""], "空の単位だけ → 送らずに空の訳");
  eq(calls.length, 0, "空の単位だけなら翻訳関数を呼ばない");
  eq(await translateUnits([], undefined, fake), [], "単位なし → []");
  await throws(() => translateUnits(["Um", "Dois"], undefined, async () => ["só um"]), "翻訳の数が合わない → 例外（保存しない）");
  await throws(
    () =>
      translateUnits(["Um"], undefined, async () => {
        throw new Error("falhou");
      }),
    "翻訳関数の失敗 → 例外"
  );
}

console.log("=== translateUnits（偽の fetch。Google → MyMemory の順に試す） ===");
{
  const realFetch = globalThis.fetch;
  const hosts: string[] = [];
  const queries: string[] = [];
  let googleFails = false;
  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    hosts.push(url.host);
    const q = url.searchParams.get("q") ?? "";
    queries.push(q);
    if (url.host === "translate.googleapis.com") {
      if (googleFails) return new Response("err", { status: 500 });
      // gtx の応答の形: [[["訳\n", "原文\n", …], …], …]
      const parts = q.split("\n");
      const segs = parts.map((p, i) => [`JA[${p}]${i < parts.length - 1 ? "\n" : ""}`, p]);
      return new Response(JSON.stringify([segs, null, "pt"]), { status: 200 });
    }
    if (url.host === "api.mymemory.translated.net") {
      return new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: q.split("\n").map((p) => `MM[${p}]`).join("\n") } }), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  };
  globalThis.fetch = fakeFetch as typeof fetch;
  try {
    const units = ["Cê tá bem?", "Vou pro mar", "Cê tá bem?"];
    const out = await translateUnits(units);
    eq(out, ["JA[Você está bem?]", "JA[Vou para o mar]", "JA[Você está bem?]"], "Google: 元の単位に対応した順で返る");
    eq(hosts, ["translate.googleapis.com"], "Google に1回だけ送る（まとめて送る）");
    eq(queries, ["Você está bem?\nVou para o mar"], "送る本文は正規化済み（cê・tá・pro を直す）・同じ文は1回");

    hosts.length = 0;
    googleFails = true;
    const out2 = await translateUnits(["Tô aqui", "Vou pra lá"]);
    eq(out2, ["MM[Estou aqui]", "MM[Vou para lá]"], "Google が失敗 → MyMemory で訳す（順番はそのまま）");
    eq(hosts, ["translate.googleapis.com", "api.mymemory.translated.net"], "Google → MyMemory の順に試す");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("=== translationUnits / pendingUnits（訳す単位・まだ訳の無い単位） ===");
{
  const lines = [
    { text: "Eu vou andar pela rua" },
    { text: "sem pensar em nada" },
    { text: "" },
    { text: "A noite chegou." },
    { text: "Eu vou andar pela rua" },
    { text: "sem pensar em nada" },
  ];
  const gs = groupLyricLines(lines);
  const A = lineHash(lines[0].text);
  const B = lineHash(lines[1].text);
  const C = lineHash(lines[3].text);
  const G = lineHash("Eu vou andar pela rua sem pensar em nada");
  eq(
    translationUnits(lines, gs, "line"),
    [
      { key: A, text: lines[0].text, lineKeys: [A] },
      { key: B, text: lines[1].text, lineKeys: [B] },
      { key: C, text: lines[3].text, lineKeys: [C] },
    ],
    "行ごと: 空でない行を1回ずつ"
  );
  const su = translationUnits(lines, gs, "sentence");
  eq(
    su,
    [
      { key: G, text: "Eu vou andar pela rua sem pensar em nada", lineKeys: [A, B] },
      { key: C, text: lines[3].text, lineKeys: [C] },
    ],
    "文ごと: 同じ文（繰り返し）は1回。1行の文は行と同じキー"
  );

  const T = (text: string, edited = false, source?: StoredTranslation["source"]): StoredTranslation => ({ text, edited, ...(source ? { source } : {}) });
  eq(pendingUnits(su, {}, false).map((u) => u.key), [G, C], "訳が無い → すべて");
  eq(pendingUnits(su, { [A]: T("行の訳A"), [B]: T("行の訳B"), [C]: T("行の訳C") }, false).map((u) => u.key), [G], "行ごとの訳だけある → 文の訳を作る（1行の文は行の訳で足りる）");
  eq(pendingUnits(su, { [G]: T(" "), [C]: T("訳") }, false).map((u) => u.key), [G], "空の訳は訳なし扱い");
  eq(pendingUnits(su, { [A]: T("自分A", true), [B]: T("AI B", false, "ai") }, false).map((u) => u.key), [C], "文のどの行にも自分の訳・AI の訳がある → 文の訳は作らない");
  eq(pendingUnits(su, { [G]: T("文の訳", false, "mt"), [C]: T("自分C", true, "user") }, true).map((u) => u.key), [G], "作り直し: 自分で直した訳は作り直さない");
  eq(pendingUnits(su, { [G]: T("AI の文の訳", false, "ai"), [C]: T("古い訳") }, true).map((u) => u.key), [C], "作り直し: AI の訳は作り直さない・出どころの無い古い訳は作り直す");
  eq(pendingUnits(translationUnits(lines, gs, "line"), { [A]: T("自分A", true) }, true).map((u) => u.key), [B, C], "行ごとの作り直し: 自分で直した行を除く");
  eq([toJaMode("line"), toJaMode("sentence"), toJaMode(undefined), toJaMode("x")], ["line", "sentence", "sentence", "sentence"], "toJaMode: 無い・知らない値は文ごと");
}

console.log("=== resolveLineTranslation（行ごとの表示の優先順位） ===");
{
  // 3行の文（行 0〜2）
  const K = [lineHash("Linha um de teste"), lineHash("linha dois de teste"), lineHash("linha três de teste")];
  const GK = lineHash("Linha um de teste linha dois de teste linha três de teste");
  const g = { key: GK, start: 0, end: 3 };
  const T = (text: string, edited = false, source?: StoredTranslation["source"]): StoredTranslation => ({ text, edited, ...(source ? { source } : {}) });
  const R = (translations: Record<string, StoredTranslation>, index: number, mode: "sentence" | "line" = "sentence", group: typeof g | null = g) =>
    resolveLineTranslation({ translations, lineKey: K[index], mode, group, index });

  const onlyGroup = { [GK]: T("文の訳", false, "mt") };
  eq([R(onlyGroup, 0), R(onlyGroup, 1), R(onlyGroup, 2)], [
    { kind: "covered", bracket: "first" },
    { kind: "covered", bracket: "middle" },
    { text: "文の訳", kind: "group", bracket: "last" },
  ], "文ごと: 文の訳は最後の行に出し、途中の行は covered。3行に線（first / middle / last）");

  const withLineMt = { ...onlyGroup, [K[0]]: T("行の機械翻訳0", false, "mt"), [K[2]]: T("行の機械翻訳2") };
  eq([R(withLineMt, 0).kind, R(withLineMt, 2).text], ["covered", "文の訳"], "文の訳 > 行の機械翻訳（出どころの無い古い訳も）");

  const withUser = { ...onlyGroup, [K[1]]: T("自分の訳1", true, "user") };
  eq(R(withUser, 1), { text: "自分の訳1", kind: "user", bracket: "middle" }, "自分で直した行の訳 > 文の訳（線はそのまま）");
  eq(R(withUser, 2), { text: "文の訳", kind: "group", bracket: "last" }, "他の行の自分の訳があっても、文の訳は最後の行に出る");

  const lastAi = { ...onlyGroup, [K[2]]: T("AI の訳2", false, "ai") };
  eq(R(lastAi, 2), { text: "AI の訳2", kind: "ai", bracket: "last", groupText: "文の訳" }, "AI の行の訳 > 文の訳（最後の行なら文の訳もあわせて出す）");
  const lastUser = { ...lastAi, [K[2]]: T("自分の訳2", true) };
  eq(R(lastUser, 2), { text: "自分の訳2", kind: "user", bracket: "last", groupText: "文の訳" }, "自分の訳（source の無い古い記録）> AI の訳 > 文の訳");
  const aiAndUserOld = { [K[0]]: T("自分の訳0", true, "user") };
  eq(R(aiAndUserOld, 0), { text: "自分の訳0", kind: "user", bracket: null }, "文の訳が無い → 線なし");

  const noGroupTr = { [K[0]]: T("行の機械翻訳0", false, "mt"), [K[1]]: T("  ") };
  eq([R(noGroupTr, 0), R(noGroupTr, 1), R(noGroupTr, 2)], [
    { text: "行の機械翻訳0", kind: "mt", bracket: null },
    { kind: "none", bracket: null },
    { kind: "none", bracket: null },
  ], "文の訳がまだ無い → 行の機械翻訳（無ければ訳なし。空の訳も訳なし）");

  eq([R(withLineMt, 0, "line"), R(withLineMt, 1, "line"), R(withLineMt, 2, "line")], [
    { text: "行の機械翻訳0", kind: "mt", bracket: null },
    { kind: "none", bracket: null },
    { text: "行の機械翻訳2", kind: "mt", bracket: null },
  ], "行ごと: 文の訳は使わない");
  eq(R(withUser, 1, "line"), { text: "自分の訳1", kind: "user", bracket: null }, "行ごと: 自分の訳");

  // 1行だけの文: 文のキー = 行のキー → 行の訳として出す（線なし）
  const single = { key: K[0], start: 0, end: 1 };
  eq(R({ [K[0]]: T("1行の文の訳", false, "mt") }, 0, "sentence", single), { text: "1行の文の訳", kind: "mt", bracket: null }, "1行の文 → 行の訳（線なし）");
  eq(resolveLineTranslation({ translations: onlyGroup, lineKey: "", mode: "sentence", group: null, index: 5 }), { kind: "none", bracket: null }, "空行 → 訳なし");
  eq(R({ [GK]: T("   ") }, 2), { kind: "none", bracket: null }, "文の訳が空 → 訳なし扱い");

  // groupLineKeys: 文のどの行にも行自身の訳（AI・自分の訳）があれば、文の機械翻訳は使わない（線も「文の訳:」も出さない）
  const RG = (translations: Record<string, StoredTranslation>, index: number) =>
    resolveLineTranslation({ translations, lineKey: K[index], mode: "sentence", group: g, index, groupLineKeys: K });
  const allAi = { ...onlyGroup, [K[0]]: T("AI0", false, "ai"), [K[1]]: T("AI1", false, "ai"), [K[2]]: T("自分2", true, "user") };
  eq([RG(allAi, 0), RG(allAi, 1), RG(allAi, 2)], [
    { text: "AI0", kind: "ai", bracket: null },
    { text: "AI1", kind: "ai", bracket: null },
    { text: "自分2", kind: "user", bracket: null },
  ], "groupLineKeys: 全行に AI・自分の訳 → 文の機械翻訳を出さない（線なし・文の訳なし）");
  const someAi = { ...onlyGroup, [K[0]]: T("AI0", false, "ai"), [K[2]]: T("AI2", false, "ai") };
  eq([RG(someAi, 0), RG(someAi, 1), RG(someAi, 2)], [
    { text: "AI0", kind: "ai", bracket: "first" },
    { kind: "covered", bracket: "middle" },
    { text: "AI2", kind: "ai", bracket: "last", groupText: "文の訳" },
  ], "groupLineKeys: AI の訳が無い行が残っていれば従来どおり（文の訳も出す）");
  const aiAndMt = { ...onlyGroup, [K[0]]: T("AI0", false, "ai"), [K[1]]: T("行の機械翻訳1", false, "mt"), [K[2]]: T("AI2", false, "ai") };
  eq(RG(aiAndMt, 1), { kind: "covered", bracket: "middle" }, "groupLineKeys: 行の機械翻訳は行自身の訳として数えない");
  eq(RG({ [K[0]]: T("AI0", false, "ai"), [K[1]]: T("AI1", false, "ai"), [K[2]]: T("AI2", false, "ai") }, 2), { text: "AI2", kind: "ai", bracket: null }, "groupLineKeys: 文の訳が無くても同じ（AI の訳を出す）");
}

// ---------------------------------------------------------------------------
// AI 翻訳（Claude）。ここから先は fetch を「呼ばれたら失敗」に差し替え、実際に通信しないことを確かめる
// ---------------------------------------------------------------------------
const savedFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls++;
  throw new Error("検証中は通信しない");
}) as typeof fetch;

/** 偽の応答（Anthropic.Message の形。使う項目だけ埋める） */
function fakeMessage(text: string | null, stop: string = "end_turn", usage: Partial<Anthropic.Usage> = {}): Anthropic.Message {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-haiku-4-5",
    content: text === null ? [] : [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: null, cache_read_input_tokens: null, ...usage },
  } as unknown as Anthropic.Message;
}

type Call = { body: Anthropic.MessageCreateParamsNonStreaming; signal: AbortSignal | null | undefined; timeout?: number; maxRetries?: number };
/** 偽のクライアント。responses を順に返す（Error なら投げる） */
function fakeClient(responses: (Anthropic.Message | Error)[]): { client: MessagesClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: MessagesClient = {
    messages: {
      create: async (body, opts) => {
        calls.push({ body: JSON.parse(JSON.stringify(body)), signal: opts?.signal, timeout: opts?.timeout, maxRetries: opts?.maxRetries });
        const r = responses.shift();
        if (!r) throw new Error("偽のクライアント: 応答がもうありません");
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
  return { client, calls };
}

const H = () => new Headers();
const apiBody = (type: string, message: string) => ({ type: "error", error: { type, message } });
const FAKE_KEY = "sk-ant-test-FAKE-KEY-for-checks-0000";

async function aiError(fn: () => Promise<unknown>): Promise<AiTranslateError | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof AiTranslateError ? e : null;
  }
}

console.log("=== songLinesForAi（送る行: 同じ行は1回・空行は連の区切り） ===");
{
  const song = [
    { text: "" },
    { text: "O barco azul chegou cedo" },
    { text: "Tô  cansado do trabalho hoje" },
    { text: "" },
    { text: "" },
    { text: "A roda da escola começou" },
    { text: "O barco azul chegou cedo" },
    { text: "" },
    { text: "A roda da escola começou" },
    { text: "" },
    { text: "A lua saiu atrás do prédio" },
    { text: "" },
  ];
  const inp = songLinesForAi(song);
  eq(
    inp.lines,
    ["O barco azul chegou cedo", "Tô cansado do trabalho hoje", "", "A roda da escola começou", "", "A lua saiu atrás do prédio"],
    "同じ行は最初の1回だけ・空行は区切り1つ（続く空行・繰り返しで空になった連はまとめる）・先頭と末尾の空行は除く・空白を1つに"
  );
  eq(inp.keys, [lineHash("O barco azul chegou cedo"), lineHash("Tô cansado do trabalho hoje"), null, lineHash("A roda da escola começou"), null, lineHash("A lua saiu atrás do prédio")], "キーは行のハッシュ（区切りは null）");
  eq(songLinesForAi([]), { lines: [], keys: [] }, "歌詞なし → 空");
  eq(songLinesForAi([{ text: "  " }, { text: "" }]), { lines: [], keys: [] }, "空行だけ → 空");
  // 訳すものが無い行（文字が無い行・繰り返しの印だけの行）は送らない。区切りにもしない
  const marks = songLinesForAi([
    { text: "O barco azul chegou cedo" },
    { text: "(2x)" },
    { text: "---" },
    { text: "..." },
    { text: "A lua saiu atrás do prédio" },
    { text: "x2" },
    { text: "" },
    { text: "♪ ♪" },
    { text: "" },
    { text: "Ê, a roda vai começar" },
    { text: "12:30" },
    { text: "(Bis)" },
  ]);
  eq(marks.lines, ["O barco azul chegou cedo", "A lua saiu atrás do prédio", "", "Ê, a roda vai começar"], "訳すものが無い行は送らない（連の区切りにもしない。区切りは続けて入れない）");
  eq(marks.keys.filter((k) => k !== null).length, 3, "訳すものが無い行はキーにも行数にも入らない");
  eq(songLinesForAi([{ text: "(2x)" }, { text: "..." }]), { lines: [], keys: [] }, "訳すものが無い行だけ → 空");
  for (const t of ["(2x)", "2x", "x2", "X3", "[3x]", "( 2 x )", "(×2)", "(Bis)", "[bis]", "---", "...", "♪ ♪", "12:30", "  "]) {
    ok(isUntranslatableLine(t), `isUntranslatableLine: 訳すものが無い「${t}」`);
  }
  for (const t of ["Ê", "Oi", "Xote da lua", "Bis de novo", "x é o valor", "2 amores", "Tô aqui (2x)"]) {
    ok(!isUntranslatableLine(t), `isUntranslatableLine: 訳す「${t}」`);
  }
}

console.log("=== buildAiTranslatePrompt（プロンプト） ===");
{
  const lines = ["O barco azul chegou cedo", "", "Tô  cansado do trabalho hoje", "   ", "", "A roda da escola começou"];
  const p = buildAiTranslatePrompt({ title: "Canção  Inventada", artist: "Grupo de Teste", lines });
  eq(p.indices, [0, 2, 5], "送る行の番号は入力の添字（空の行は入らない）");
  ok(p.content.includes("Title: Canção Inventada") && p.content.includes("Artist: Grupo de Teste"), "曲名・アーティスト名を入れる");
  const body = p.content.split("\n").slice(p.content.split("\n").indexOf("Lyrics (index: line). Repeated lines appear only once; a blank line separates stanzas.") + 2);
  eq(body, ["0: O barco azul chegou cedo", "", "2: Tô cansado do trabalho hoje", "", "5: A roda da escola começou"], "「番号: 本文」で1行ずつ・空の行は送らず区切りの空行1つ");
  ok(!/^\d+:\s*$/m.test(p.content), "空の本文の行を送らない");
  for (const w of ["WHOLE song", "JSON only", `at most ${AI_NOTE_MAX} characters`, "same index", "capoeira", "tô", "Never invent", "Japanese", "never copy the whole original line", "この行", "not the original Portuguese"]) {
    ok(p.system.includes(w), `システムプロンプトに「${w}」`);
  }
  ok(!p.system.includes("Canção Inventada") && !p.system.includes("barco"), "システムプロンプトは曲によらず同じ（歌詞・曲名を入れない）");
  eq(buildAiTranslatePrompt({ title: " ", artist: "", lines: ["", " "] }).indices, [], "空の行だけ → 送る行なし");
  ok(buildAiTranslatePrompt({ title: "", artist: "", lines: ["Oi"] }).content.includes("Title: (unknown)"), "曲名が空 → (unknown)");
  eq(AI_TRANSLATION_SCHEMA.required, ["lines"], "スキーマ: lines が必須");
  eq(AI_TRANSLATION_SCHEMA.properties.lines.items.required, ["i", "ja"], "スキーマ: 各行は i・ja が必須（note は任意）");
  eq([AI_TRANSLATION_SCHEMA.additionalProperties, AI_TRANSLATION_SCHEMA.properties.lines.items.additionalProperties], [false, false], "スキーマ: 余分な項目を認めない");
}

console.log("=== parseAiTranslation（応答の検査） ===");
{
  const good = { lines: [{ i: 0, ja: "青い船が朝早く着いた" }, { i: 2, ja: " 今日は仕事で疲れた ", note: "tô は estou の口語形" }, { i: 5, ja: "学校のホーダが始まった", note: "" }] };
  const r = parseAiTranslation(good, [0, 2, 5]);
  ok(r.ok, "正しい応答 → ok");
  if (r.ok) {
    eq([...r.results.entries()], [[0, { ja: "青い船が朝早く着いた" }], [2, { ja: "今日は仕事で疲れた", note: "tô は estou の口語形" }], [5, { ja: "学校のホーダが始まった" }]], "行番号 → 訳（前後の空白を除く・空の補足は付けない）");
    eq(r.skipped, [], "全行そろっている → skipped なし");
  }
  const errOf = (json: unknown, idx = [0, 2, 5]) => {
    const x = parseAiTranslation(json, idx);
    return x.ok ? null : x.error;
  };
  // 訳が返らなかった行・空の訳の行だけ飛ばす（ほかの行の訳は使う。有料の結果を捨てない）
  const partial = parseAiTranslation({ lines: [{ i: 0, ja: "a" }, { i: 5, ja: "c" }] }, [0, 2, 5]);
  eq(partial.ok ? [[...partial.results.keys()], partial.skipped] : partial.error, [[0, 5], [2]], "行が足りない → その行だけ skipped（ほかの行は使う）");
  const emptyJa = parseAiTranslation({ lines: [{ i: 0, ja: "a" }, { i: 2, ja: "   " }, { i: 5, ja: "c", note: "補足" }] }, [0, 2, 5]);
  eq(emptyJa.ok ? [[...emptyJa.results.keys()], emptyJa.skipped] : emptyJa.error, [[0, 5], [2]], "空の訳 → その行だけ skipped");
  ok(errOf({ lines: [{ i: 0, ja: "" }, { i: 2, ja: " " }] })?.includes("3行分の訳がありません") ?? false, "使える訳が1行も無い → エラー（保存しない）");
  // 行番号のずれを示すものは、全体をエラーにする（どの行の訳か信用できない）
  ok(errOf({ lines: [{ i: 0, ja: "a" }, { i: 2, ja: "b" }, { i: 2, ja: "b2" }, { i: 5, ja: "c" }] })?.includes("行 2 の訳が重複") ?? false, "同じ行番号が2回 → エラー");
  ok(errOf({ lines: [{ i: 0, ja: "a" }, { i: 2, ja: "" }, { i: 2, ja: "b2" }, { i: 5, ja: "c" }] })?.includes("行 2 の訳が重複") ?? false, "空の訳の行番号が2回目に出ても重複 → エラー");
  ok(errOf({ lines: [{ i: 0, ja: "a" }, { i: 2, ja: "b" }, { i: 5, ja: "c" }, { i: 7, ja: "d" }] })?.includes("送っていない行番号 7") ?? false, "送っていない行番号 → エラー");
  ok(errOf({ lines: [{ i: "0", ja: "a" }] })?.includes("1番目の項目") ?? false, "行番号が数でない → エラー");
  ok(errOf({ lines: [{ i: 1.5, ja: "a" }] }, [1])?.includes("1番目の項目") ?? false, "行番号が整数でない → エラー");
  ok(errOf({ lines: [{ i: 0 }] }, [0])?.includes("1番目の項目") ?? false, "ja が無い → エラー");
  ok(errOf({ result: [] })?.includes("lines がありません") ?? false, "lines が無い → エラー");
  ok(errOf(null) !== null && errOf([]) !== null && errOf("x") !== null, "object でない → エラー");
  const missingMany = errOf({ lines: [] }, [0, 1, 2, 3, 4, 5, 6]);
  ok(missingMany?.includes("7行分") === true && missingMany.includes("0, 1, 2, 3, 4 ほか"), "足りない行が多いときは5つまで挙げて「ほか」");
  // 補足の長さ: AI_NOTE_MAX 文字まで（超えたら最後を … に）
  const long = "あ".repeat(AI_NOTE_MAX + 20);
  const rl = parseAiTranslation({ lines: [{ i: 0, ja: "訳", note: long }] }, [0]);
  eq(rl.ok ? [...(rl.results.get(0)?.note ?? "")].length : -1, AI_NOTE_MAX, `長い補足は ${AI_NOTE_MAX} 文字に切る`);
  eq(rl.ok ? rl.results.get(0)?.note?.endsWith("…") : false, true, "切った補足は … で終わる");
  eq(clampNote("あ".repeat(AI_NOTE_MAX)), "あ".repeat(AI_NOTE_MAX), `ちょうど ${AI_NOTE_MAX} 文字は切らない`);
  eq(clampNote(" 改行\nを含む 補足 "), "改行 を含む 補足", "補足の空白・改行を1つにそろえる");
  const rn = parseAiTranslation({ lines: [{ i: 0, ja: "一行目\n二行目" }] }, [0]);
  eq(rn.ok ? rn.results.get(0)?.ja : null, "一行目 二行目", "訳の中の改行は空白1つに");
}

console.log("=== scrubLineFromNote（補足に元の行をまるごと残さない） ===");
{
  const line = "O barco azul chegou cedo";
  eq(scrubLineFromNote("「O barco azul chegou cedo」は旅立ちの比喩", line), "「この行」は旅立ちの比喩", "「」で囲んだ行 → 「この行」");
  eq(scrubLineFromNote("O barco azul chegou cedo は旅立ちの比喩", line), "「この行」 は旅立ちの比喩", "囲みなしの行 → 「この行」");
  eq(scrubLineFromNote("“o  BARCO azul chegou cedo.” は比喩", line), "「この行」 は比喩", "大文字小文字・空白・行末の記号・“” の違いは無視");
  eq(scrubLineFromNote("「O barco azul chegou cedo」", `${line}!`), "「この行」", "送った行の末尾の ! が補足に無くても一致");
  const accented = "A lua saiu atrás do prédio";
  eq(scrubLineFromNote(`「${accented}」は…`, accented.normalize("NFD")), "「この行」は…", "Unicode の正規化の違いは無視（送った行が NFD）");
  eq(scrubLineFromNote(`「${accented.normalize("NFD")}」は…`, accented), "「この行」は…", "Unicode の正規化の違いは無視（補足が NFD）");
  eq(scrubLineFromNote("「azul」は青。ここでは若さの象徴", line), "「azul」は青。ここでは若さの象徴", "行の一部の語だけの引用は残す");
  eq(scrubLineFromNote("カポエイラの合図", line), "カポエイラの合図", "行を含まない補足はそのまま");
  eq(scrubLineFromNote("「Ê」は掛け声（você とは無関係）", "Ê"), "「この行」は掛け声（você とは無関係）", "短い行でも語の途中（você の ê）には一致させない");
  eq(scrubLineFromNote("「Tô d’água」は口語", "Tô d'água"), "「この行」は口語", "アポストロフィの ' と ’ は同じとみなす");
  eq(scrubLineFromNote("補足", "..."), "補足", "文字の無い行では何もしない");
  // parseAiTranslation に送った行を渡すと、補足から元の行を除く（切る前に除くので、長い行でも残らない）
  const longLine = "Eu vou andar pela rua comprida da cidade velha sem pensar em nada nem ninguém até amanhecer";
  const scrubbed = parseAiTranslation(
    { lines: [{ i: 0, ja: "青い船が朝早く着いた", note: `「${line}」は旅立ちの比喩` }, { i: 1, ja: "長い道を歩く", note: `「${longLine}」は夜明けまで歩き続けるという意味の、とても長い比喩の説明` }] },
    [0, 1],
    [line, longLine]
  );
  eq(scrubbed.ok ? [scrubbed.results.get(0)?.note, scrubbed.results.get(1)?.note] : null, ["「この行」は旅立ちの比喩", "「この行」は夜明けまで歩き続けるという意味の、とても長い比喩の説明"], "parseAiTranslation: 補足の元の行を「この行」に（長い行も）");
  ok(scrubbed.ok && ![...scrubbed.results.values()].some((x) => x.note?.includes("barco") || x.note?.includes("andar")), "保存する補足に元の行の本文が残らない");
}

console.log("=== parseJsonText（構造化出力なしで頼んだときの本文） ===");
{
  eq(parseJsonText('{"lines":[]}'), { lines: [] }, "JSON だけ");
  eq(parseJsonText('```json\n{"lines":[{"i":0,"ja":"a"}]}\n```'), { lines: [{ i: 0, ja: "a" }] }, "```json の囲み");
  eq(parseJsonText('Aqui está:\n{"lines":[]}\nFim'), { lines: [] }, "前後に文がある");
  let threw = false;
  try {
    parseJsonText("não é json");
  } catch {
    threw = true;
  }
  ok(threw, "JSON が無い → 例外");
}

console.log("=== estimateAiCost / costFromUsage / 表示 ===");
{
  const ten = Array.from({ length: 10 }, (_, i) => `Linha inventada número ${i}`);
  const twenty = [...ten, ...ten.map((l) => l + " de novo")];
  for (const m of AI_MODELS) {
    const a = estimateAiCost(ten, m);
    const b = estimateAiCost(twenty, m);
    ok(b.usd > a.usd && b.inputTokens > a.inputTokens && b.outputTokens > a.outputTokens, `${m}: 行が増えると見積もりも増える`);
    ok(estimateAiCost([...ten.slice(0, 9), ten[9] + " com mais palavras aqui"], m).inputTokens >= a.inputTokens, `${m}: 文字が増えると入力も増える（減らない）`);
    eq(estimateAiCost([...ten, "", "  "], m), a, `${m}: 空の行は数えない`);
    ok(Math.abs(a.yen - a.usd * 150) < 1e-9, `${m}: 円 = ドル × 150`);
  }
  const hk = estimateAiCost(twenty, "claude-haiku-4-5");
  const sn = estimateAiCost(twenty, "claude-sonnet-5");
  const op = estimateAiCost(twenty, "claude-opus-5");
  ok(hk.usd < sn.usd && sn.usd < op.usd, "モデルの順: Haiku 4.5 < Sonnet 5 < Opus 5");
  const chars = twenty.reduce((n, l) => n + l.length, 0);
  eq(hk, { inputTokens: Math.ceil(700 + chars / 2.5), outputTokens: 45 * 20 + 600, usd: hk.usd, yen: hk.yen }, "Haiku 4.5: 入力 ≈ 700 + 文字数/2.5・出力 ≈ 45×行数 + 600");
  eq(sn.outputTokens, Math.ceil((45 * 20 + 600) * 2.5), "Sonnet 5: 出力 × 2.5（思考・トークナイザーの分。安く見せない）");
  eq(op.outputTokens, sn.outputTokens, "Opus 5: 出力 × 2.5");
  eq(AI_MODELS.map((m) => AI_MODEL_INFO[m].outputFactor), [1, 2.5, 2.5], "出力の係数: Haiku 4.5 は 1、Sonnet 5 / Opus 5 は 2.5");
  ok(Math.abs(hk.usd - (hk.inputTokens * 1 + hk.outputTokens * 5) / 1e6) < 1e-12, "Haiku 4.5: 入力 $1・出力 $5 / 100万トークン");

  const u = { input_tokens: 2000, output_tokens: 3000 };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-12;
  const ch = costFromUsage(u, "claude-haiku-4-5");
  ok(near(ch.usd, 0.002 + 0.015) && near(ch.yen, 0.017 * 150), "costFromUsage Haiku 4.5: 2000入力・3000出力 = $0.017");
  eq([ch.inputTokens, ch.outputTokens], [2000, 3000], "costFromUsage: トークン数");
  ok(near(costFromUsage(u, "claude-sonnet-5").usd, 0.004 + 0.03), "costFromUsage Sonnet 5: $2 / $10");
  ok(near(costFromUsage(u, "claude-opus-5").usd, 0.01 + 0.075), "costFromUsage Opus 5: $5 / $25");
  const cached = costFromUsage({ input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 1000, cache_read_input_tokens: 1000 }, "claude-haiku-4-5");
  ok(near(cached.usd, (1000 + 1250 + 100) / 1e6) && cached.inputTokens === 3000, "costFromUsage: キャッシュの書き込み 1.25 倍・読み込み 0.1 倍");
  ok(near(costFromUsage({ input_tokens: -5, output_tokens: NaN, cache_read_input_tokens: null }, "claude-haiku-4-5").usd, 0), "costFromUsage: 負・NaN・null は 0");
  eq([formatYen(0), formatYen(0.04), formatYen(0.05), formatYen(1.96), formatYen(2.34), formatYen(13.5)], ["0.1円未満", "0.1円未満", "約0.1円", "約2円", "約2.3円", "約14円"], "formatYen");
  eq([formatUsd(0.0042), formatUsd(0.0132), formatUsd(0.09)], ["$0.0042", "$0.013", "$0.090"], "formatUsd（1セント未満は4桁）");
  eq([toAiModel("claude-opus-5"), toAiModel("claude-opus-5-20260101"), toAiModel(undefined)], ["claude-opus-5", "claude-haiku-4-5", "claude-haiku-4-5"], "toAiModel: 知らない値は Haiku 4.5");
  eq(AI_MODELS, ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"], "モデル ID は日付の付かない形");
  eq(AI_MODELS.map((m) => [AI_MODEL_INFO[m].usdPerMTokIn, AI_MODEL_INFO[m].usdPerMTokOut]), [[1, 5], [2, 10], [5, 25]], "料金表（入力 / 出力 USD・100万トークン）");
}

console.log("=== translateSongWithClaude（偽のクライアント・通信しない） ===");
{
  const lines = ["O barco azul chegou cedo", "Tô cansado do trabalho hoje", "", "A roda da escola começou"];
  const okJson = JSON.stringify({
    lines: [
      { i: 0, ja: "青い船が朝早く着いた" },
      { i: 1, ja: "今日は仕事で疲れた", note: "tô は estou の口語形" },
      { i: 3, ja: "学校のホーダが始まった", note: "roda はカポエイラの輪" },
    ],
  });
  const ctrl = new AbortController();

  // 成功
  {
    const { client, calls } = fakeClient([fakeMessage(okJson, "end_turn", { input_tokens: 900, output_tokens: 300 })]);
    const r = await translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "Canção Inventada", artist: "Grupo de Teste", lines, signal: ctrl.signal, client });
    eq(r.results, [{ ja: "青い船が朝早く着いた" }, { ja: "今日は仕事で疲れた", note: "tô は estou の口語形" }, null, { ja: "学校のホーダが始まった", note: "roda はカポエイラの輪" }], "成功: 入力の行と同じ順・区切りは null");
    ok(Math.abs(r.cost.usd - (900 * 1 + 300 * 5) / 1e6) < 1e-12, "成功: 料金は応答の usage から");
    eq([r.model, r.usedFallback, calls.length, r.skipped], ["claude-haiku-4-5", false, 1, 0], "成功: 1回だけ呼ぶ（構造化出力のまま）・飛ばした行なし");
    const b = calls[0].body;
    eq([b.model, b.max_tokens], ["claude-haiku-4-5", 16000], "送る: モデル（日付なし）・max_tokens 16000");
    eq(b.output_config, { format: { type: "json_schema", schema: JSON.parse(JSON.stringify(AI_TRANSLATION_SCHEMA)) } }, "送る: output_config.format に JSON スキーマ（Haiku 4.5 には effort を送らない）");
    eq(calls[0].maxRetries, 0, "SDK の自動の再試行をしない（maxRetries 0。有料のリクエストを黙って送り直さない）");
    ok(!("thinking" in b) && !("temperature" in b), "送る: thinking・temperature を送らない");
    eq(b.messages.length, 1, "送る: user のメッセージ1つ");
    const content = String(b.messages[0].content);
    ok(content.includes("0: O barco azul chegou cedo") && content.includes("3: A roda da escola começou") && content.includes("Title: Canção Inventada"), "送る: 番号付きの行・曲名");
    ok(typeof b.system === "string" && b.system.includes("JSON only"), "送る: システムプロンプト");
    ok(calls[0].signal === ctrl.signal, "中断の signal を渡す");
    ok(!JSON.stringify(b).includes(FAKE_KEY), "リクエストの本文に API キーは入らない");
  }
  // Sonnet 5 / Opus 5 もモデル ID をそのまま送る。考える量は effort medium で抑える
  for (const m of ["claude-sonnet-5", "claude-opus-5"] as const) {
    const { client, calls } = fakeClient([fakeMessage(okJson)]);
    await translateSongWithClaude({ apiKey: FAKE_KEY, model: m, title: "T", artist: "A", lines, client });
    eq([calls[0].body.model, "thinking" in calls[0].body], [m, false], `${m}: モデル ID をそのまま送り、thinking は送らない`);
    eq(
      calls[0].body.output_config,
      { effort: "medium", format: { type: "json_schema", schema: JSON.parse(JSON.stringify(AI_TRANSLATION_SCHEMA)) } },
      `${m}: output_config に effort medium と JSON スキーマ`
    );
    eq(calls[0].maxRetries, 0, `${m}: SDK の自動の再試行をしない`);
  }
  // Sonnet 5 で構造化出力を断られた → 頼み直しは format だけ外し、effort は残す
  {
    const { client, calls } = fakeClient([
      new Anthropic.BadRequestError(400, apiBody("invalid_request_error", "output_config.format: not supported"), "400 output_config", H()),
      fakeMessage(okJson),
    ]);
    const r = await translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-sonnet-5", title: "T", artist: "A", lines, client });
    eq([r.usedFallback, calls[1].body.output_config, calls[1].maxRetries], [true, { effort: "medium" }, 0], "Sonnet 5 の頼み直し: output_config は effort だけ（format を外す）");
  }
  // 補足に元の行がまるごと入っていたら「この行」にして返す（保存するのは lineHash のキーと、この訳・補足だけ）
  {
    const quoting = JSON.stringify({
      lines: [
        { i: 0, ja: "青い船が朝早く着いた", note: "「O barco azul chegou cedo」は新しい始まりの比喩" },
        { i: 1, ja: "今日は仕事で疲れた" },
        { i: 3, ja: "学校のホーダが始まった", note: "roda はカポエイラの輪" },
      ],
    });
    const { client } = fakeClient([fakeMessage(quoting)]);
    const r = await translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client });
    eq([r.results[0]?.note, r.results[3]?.note], ["「この行」は新しい始まりの比喩", "roda はカポエイラの輪"], "補足の元の行 → 「この行」（語の説明はそのまま）");
    ok(!r.results.some((x) => x?.note?.includes("barco")), "返す補足に元の行の本文が残らない");
  }
  // 断られた（refusal）
  {
    const { client } = fakeClient([fakeMessage(null, "refusal", { input_tokens: 800, output_tokens: 0 })]);
    const e = await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client }));
    eq(e?.kind, "refusal", "stop_reason refusal → refusal");
    ok(!!e?.message.includes("別のモデル") && !!e?.message.includes("機械翻訳"), "refusal: 別のモデルか機械翻訳をすすめる");
    ok(e?.cost?.inputTokens === 800, "refusal: その回の料金を持つ");
  }
  // 途中で切れた（max_tokens）
  {
    const { client } = fakeClient([fakeMessage('{"lines":[{"i":0,"ja":"青い', "max_tokens")]);
    const e = await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-opus-5", title: "T", artist: "A", lines, client }));
    eq(e?.kind, "max_tokens", "stop_reason max_tokens → max_tokens（途中で切れたと伝える）");
    ok(!!e?.message.includes("途中で切れ") && !!e?.cost, "max_tokens: 保存せず、料金を持つ");
  }
  // キーが正しくない（AuthenticationError）
  {
    const { client, calls } = fakeClient([new Anthropic.AuthenticationError(401, apiBody("authentication_error", "invalid x-api-key"), "401 invalid x-api-key", H())]);
    const e = await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client }));
    eq(e?.kind, "auth", "AuthenticationError → auth");
    ok(!!e?.message.includes("キーが正しくありません"), "auth: 「キーが正しくありません」");
    ok(!e?.message.includes(FAKE_KEY), "エラーの文にキーを出さない");
    eq(calls.length, 1, "auth: 頼み直さない");
  }
  // 構造化出力を受け付けない → 1回だけ output_config なしで頼み直す
  {
    const fenced = "```json\n" + okJson + "\n```";
    const { client, calls } = fakeClient([
      new Anthropic.BadRequestError(400, apiBody("invalid_request_error", "output_config.format: not supported for this model"), "400 output_config", H()),
      fakeMessage(fenced, "end_turn", { input_tokens: 700, output_tokens: 250 }),
    ]);
    const r = await translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client });
    eq([calls.length, "output_config" in calls[0].body, "output_config" in calls[1].body], [2, true, false], "output_config を断られたら、output_config なしで1回だけ頼み直す");
    eq([r.usedFallback, r.results[3]?.ja], [true, "学校のホーダが始まった"], "頼み直し: 本文の JSON（```json の囲み）を読む");
    eq(calls[1].body.system, calls[0].body.system, "頼み直し: 同じプロンプト（JSON だけを求める）");
  }
  {
    const { client, calls } = fakeClient([
      new Anthropic.BadRequestError(400, apiBody("invalid_request_error", "output_config: schema is invalid"), "400", H()),
      new Anthropic.BadRequestError(400, apiBody("invalid_request_error", "Your credit balance is too low"), "400", H()),
    ]);
    const e = await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client }));
    eq([calls.length, e?.kind], [2, "bad_request"], "頼み直しも失敗 → そのエラー（3回目はない）");
    ok(!!e?.message.includes("credit balance") && !!e?.message.includes("支払い"), "bad_request: API の説明と、支払い設定の案内");
  }
  {
    const { client, calls } = fakeClient([new Anthropic.BadRequestError(400, apiBody("invalid_request_error", "messages: too long"), "400", H())]);
    const e = await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client }));
    eq([calls.length, e?.kind], [1, "bad_request"], "output_config と関係ない 400 → 頼み直さない");
  }
  // そのほかのエラー（具体的なクラスから順に）
  const cases: [string, Error, string][] = [
    ["PermissionDeniedError", new Anthropic.PermissionDeniedError(403, apiBody("permission_error", "no"), "403", H()), "permission"],
    ["NotFoundError", new Anthropic.NotFoundError(404, apiBody("not_found_error", "model: x"), "404", H()), "not_found"],
    ["RateLimitError", new Anthropic.RateLimitError(429, apiBody("rate_limit_error", "slow down"), "429", H()), "rate_limit"],
    ["InternalServerError(529)", new Anthropic.InternalServerError(529, apiBody("overloaded_error", "busy"), "529", H()), "server"],
    ["APIConnectionError", new Anthropic.APIConnectionError({ message: "Connection error." }), "connection"],
    ["APIConnectionTimeoutError", new Anthropic.APIConnectionTimeoutError(), "connection"],
    ["APIUserAbortError", new Anthropic.APIUserAbortError(), "aborted"],
    ["APIError(402)", new Anthropic.APIError(402, apiBody("billing_error", "pay"), "402", H()), "billing"],
    ["APIError(418)", new Anthropic.APIError(418, apiBody("x", "y"), "418", H()), "api"],
    ["TypeError", new TypeError("boom"), "unknown"],
  ];
  for (const [name, err, kind] of cases) {
    const { client } = fakeClient([err]);
    const e = await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client }));
    eq(e?.kind, kind, `${name} → ${kind}`);
  }
  {
    const { client } = fakeClient([new Anthropic.RateLimitError(429, apiBody("rate_limit_error", "x"), "429", H())]);
    const e = await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client }));
    ok(!!e?.message.includes("混み合って") && !!e?.message.includes("上限"), "rate_limit: 「混み合っています・上限」");
  }
  {
    const { client } = fakeClient([new Anthropic.APIConnectionError({ message: "x" })]);
    const e = await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client }));
    ok(!!e?.message.includes("通信エラー") && !!e?.message.includes("オフライン"), "connection: 「通信エラー・オフライン」");
  }
  // 訳が返らなかった行だけ飛ばす（ほかの行の訳は返す。有料の結果を捨てない）
  {
    const partial = JSON.stringify({ lines: [{ i: 0, ja: "a" }, { i: 1, ja: "b" }] });
    const { client } = fakeClient([fakeMessage(partial)]);
    const r = await translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client });
    eq([r.results, r.skipped], [[{ ja: "a" }, { ja: "b" }, null, null], 1], "行が足りない応答 → 返った行だけ使い、足りない行は null・skipped 1");
  }
  // 応答の中身が合わない → 保存しない（料金は持つ）
  {
    const none = JSON.stringify({ lines: [{ i: 0, ja: " " }] });
    const { client } = fakeClient([fakeMessage(none)]);
    const e = await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client }));
    eq(e?.kind, "parse", "使える訳が1行も無い応答 → parse");
    ok(!!e?.message.includes("行 0, 1, 3") && !!e?.message.includes("保存していません") && !!e?.cost, "parse: どの行か・保存しない・料金を持つ");
    const shifted = JSON.stringify({ lines: [{ i: 0, ja: "a" }, { i: 1, ja: "b" }, { i: 2, ja: "c" }] });
    const { client: c1 } = fakeClient([fakeMessage(shifted)]);
    const e1 = await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client: c1 }));
    ok(e1?.kind === "parse" && e1.message.includes("送っていない行番号 2"), "行番号がずれた応答（送っていない番号）→ parse（何も保存しない）");
    const { client: c2 } = fakeClient([fakeMessage("não é json")]);
    eq((await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client: c2 })))?.kind, "parse", "JSON でない本文 → parse");
    const { client: c3 } = fakeClient([fakeMessage(null)]);
    eq((await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, client: c3 })))?.kind, "parse", "text のブロックが無い → parse");
  }
  // 呼ぶ前に止まるもの（クライアントを呼ばない）
  {
    const { client, calls } = fakeClient([]);
    eq((await aiError(() => translateSongWithClaude({ apiKey: "  ", model: "claude-haiku-4-5", title: "T", artist: "A", lines, client })))?.kind, "no_key", "キーが空 → no_key");
    eq((await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines: ["", " "], client })))?.kind, "empty", "送る行が無い → empty");
    const done = new AbortController();
    done.abort();
    eq((await aiError(() => translateSongWithClaude({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", title: "T", artist: "A", lines, signal: done.signal, client })))?.kind, "aborted", "中止済みの signal → aborted");
    eq(calls.length, 0, "どれもクライアントを呼ばない");
  }
}

console.log("=== testClaudeConnection（接続テスト・偽のクライアント） ===");
{
  const { client, calls } = fakeClient([fakeMessage("OK", "end_turn", { input_tokens: 12, output_tokens: 3 })]);
  const r = await testClaudeConnection({ apiKey: FAKE_KEY, model: "claude-sonnet-5", client });
  eq([calls[0].body.model, calls[0].body.max_tokens, "thinking" in calls[0].body, "output_config" in calls[0].body], ["claude-sonnet-5", 16, false, false], "小さなリクエスト（max_tokens 16）");
  eq(calls[0].timeout, 30_000, "接続テストは 30 秒で打ち切る");
  ok(Math.abs(r.cost.usd - (12 * 2 + 3 * 10) / 1e6) < 1e-12 && r.model === "claude-sonnet-5", "料金はごくわずか（usage から）");
  const { client: c2 } = fakeClient([fakeMessage(null, "max_tokens")]);
  ok((await testClaudeConnection({ apiKey: FAKE_KEY, model: "claude-opus-5", client: c2 })).model === "claude-opus-5", "途中で切れても応答があれば接続できている");
  const { client: c3 } = fakeClient([new Anthropic.AuthenticationError(401, apiBody("authentication_error", "invalid x-api-key"), "401", H())]);
  const e = await aiError(() => testClaudeConnection({ apiKey: FAKE_KEY, model: "claude-haiku-4-5", client: c3 }));
  ok(e?.kind === "auth" && e.message.includes("キーが正しくありません"), "キーが正しくない → auth のメッセージ");
  eq((await aiError(() => testClaudeConnection({ apiKey: "", model: "claude-haiku-4-5", client: c3 })))?.kind, "no_key", "キーが空 → no_key");
}

eq(fetchCalls, 0, "AI 翻訳の検証の間、fetch は一度も呼ばれない（実際に通信しない）");
globalThis.fetch = savedFetch;

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
