// ============================================================================
// 原形推定(lemmatize)の回帰テスト
//   npm run check:lemma
// 小さな固定辞書(フィクスチャ)で検証するため、辞書データの増減に左右されない。
// 例は一般的な単語のみ（歌詞は使わない）。1件でも失敗したら終了コード1。
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createLemmatizer, isCovered, isGrammarWord, type LexRef } from "../src/services/lemmatize";
import type { IrregularTable } from "../src/services/conjugate";
import { getConjugator, irregularTable, irregularVerbs } from "../src/data/conjugator";
import { ALL_WORDS } from "../src/data/loadWords";
import {
  TABLE_PERSONS,
  TABLE_TENSES,
  buildConjugationTable,
  conjugationForm,
  formLabel,
  verbHead,
  withSubject,
  type TableTense,
} from "../src/services/verbTable";

const here = dirname(fileURLToPath(import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(resolve(here, "../data", name), "utf8"));

// [ポルトガル語, 品詞, source?]
const FIXTURE: [string, string, LexRef["source"]?][] = [
  ["ficar", "動詞"], ["chegar", "動詞"], ["começar", "動詞"], ["conhecer", "動詞"], ["proteger", "動詞"],
  ["cantar", "動詞"], ["falar", "動詞"], ["ser", "動詞"], ["estar", "動詞"], ["haver", "動詞"], ["odiar", "動詞"],
  ["construir", "動詞"], ["diminuir", "動詞"], ["cair", "動詞"], ["sair", "動詞"], ["doer", "動詞"], ["dormir", "動詞"],
  ["subir", "動詞"], ["sentir", "動詞"], ["conseguir", "動詞"], ["fazer", "動詞"], ["abrir", "動詞"], ["escrever", "動詞"],
  ["pôr", "動詞"], ["amar", "動詞"], ["encontrar", "動詞"], ["dar", "動詞"], ["ir", "動詞"], ["vender", "動詞"],
  ["ver", "動詞"], ["vestir", "動詞"], ["comer", "動詞"], ["casar", "動詞"], ["ter", "動詞"], ["ler", "動詞"],
  ["passear", "動詞"], ["seguir", "動詞"], ["pedir", "動詞"], ["querer", "動詞"], ["vir", "動詞"], ["manter", "動詞"],
  ["compor", "動詞"], ["viver", "動詞"], ["partir", "動詞"],
  ["coração", "名詞"], ["papel", "名詞"], ["animal", "名詞"], ["flor", "名詞"], ["vez", "名詞"], ["mês", "名詞"],
  ["homem", "名詞"], ["menina", "名詞"], ["menino", "名詞"], ["bonito", "形容詞"], ["pouco", "副詞"],
  ["amigo/amiga", "名詞"], ["café", "名詞"], ["rápido", "形容詞"], ["feliz", "形容詞"], ["para", "前置詞"],
  ["de", "前置詞"], ["o", "冠詞"], ["a", "冠詞"], ["a", "前置詞"], ["os", "冠詞"], ["as", "冠詞"], ["um", "冠詞"],
  ["você", "代名詞"], ["água", "名詞"], ["como", "副詞"], ["casa", "名詞"], ["nos", "代名詞"], ["em", "前置詞"],
  ["tão", "副詞"], ["e", "接続詞"], ["se", "接続詞"], ["sem", "前置詞"], ["seu/sua", "代名詞"], ["te", "代名詞"],
  ["teu", "代名詞"], ["lei", "名詞"], ["mesa", "名詞"], ["caso", "名詞"], ["pai", "名詞"], ["país", "名詞"],
  ["este/esta", "代名詞"], ["guarda-chuva", "名詞"], ["segunda-feira", "名詞"], ["bem", "副詞"],
  ["de repente", "フレーズ"], ["às vezes", "フレーズ"], ["por que", "疑問詞"], ["cansado", "形容詞"],
  ["só", "副詞"], ["ele", "代名詞"], ["um", "数詞"], ["idéia", "名詞"], ["Besouro", "固有名詞（人名）", "capoeira"],
  ["beija", "名詞"], ["flor", "名詞"],
  ["mãe", "名詞"], ["mão", "名詞"], ["produzir", "動詞"], ["agredir", "動詞"], ["prevenir", "動詞"], ["rico", "形容詞"],
  ["aceitar", "動詞"], ["mau", "形容詞"], ["bom/boa", "形容詞"], ["mas", "接続詞"], ["parar", "動詞"], ["pão", "名詞"],
];
const entries: LexRef[] = FIXTURE.map(([pt, pos, source], i) => ({
  id: `${source ?? "words"}:${i}`,
  pt,
  ja: "(fixture)",
  pos,
  source: source ?? "words",
}));

const lem = createLemmatizer({
  entries,
  irregular: load<IrregularTable>("verb-irregular.json"),
  colloquial: load("colloquial.json"),
});

let fail = 0;
let pass = 0;
const lemmas = (s: string, lineStart = false) => lem.lookup(s, { lineStart }).candidates.map((c) => c.lemma);
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  ✗ " + msg);
  }
}
function top(s: string, lemma: string) {
  const l = lemmas(s);
  ok(l[0] === lemma, `top(${s}) = ${lemma}  → 実際: [${l.join(", ")}]`);
}
function has(s: string, lemma: string) {
  const l = lemmas(s);
  ok(l.includes(lemma), `has(${s}, ${lemma})  → 実際: [${l.join(", ")}]`);
}
function not(s: string, lemma: string) {
  const l = lemmas(s);
  ok(!l.includes(lemma), `not(${s}, ${lemma})  → 実際: [${l.join(", ")}]`);
}

console.log("=== 動詞 ===");
for (const [s, l] of [
  ["fiquei", "ficar"], ["fique", "ficar"], ["cheguei", "chegar"], ["chegue", "chegar"], ["comecei", "começar"],
  ["comece", "começar"], ["conheço", "conhecer"], ["conheça", "conhecer"], ["protejo", "proteger"], ["cantando", "cantar"],
  ["falaríamos", "falar"], ["falara", "falar"], ["falarmos", "falar"], ["sou", "ser"], ["era", "ser"], ["é", "ser"],
  ["tô", "estar"], ["tava", "estar"], ["'tá", "estar"], ["’tá", "estar"], ["há", "haver"], ["odeio", "odiar"],
  ["diminui", "diminuir"], ["constrói", "construir"], ["caiu", "cair"], ["saímos", "sair"], ["dói", "doer"],
  ["durmo", "dormir"], ["sobe", "subir"], ["sinto", "sentir"], ["feito", "fazer"], ["aberto", "abrir"],
  ["escrito", "escrever"], ["posto", "pôr"], ["passeio", "passear"], ["sigo", "seguir"], ["peço", "pedir"],
  ["quiséramos", "querer"], ["fizesse", "fazer"], ["tivesse", "ter"], ["vieram", "vir"], ["mantém", "manter"],
  ["compôs", "compor"], ["vivêssemos", "viver"], ["lêssemos", "ler"], ["fôssemos", "ser"],
] as const) has(s, l);
has("consigo", "conseguir");

console.log("=== 名詞・形容詞 ===");
for (const [s, l] of [
  ["corações", "coração"], ["papéis", "papel"], ["animais", "animal"], ["flores", "flor"], ["vezes", "vez"],
  ["meses", "mês"], ["homens", "homem"], ["meninas", "menina"], ["bonitas", "bonito"], ["bonita", "bonito"],
  ["pouquinho", "pouco"], ["cafezinho", "café"], ["rapidamente", "rápido"], ["felizmente", "feliz"],
  ["sozinho", "só"], ["amigas", "amiga"],
] as const) top(s, l);
has("amiguinho", "amigo");

console.log("=== 接語・縮約・口語 ===");
for (const [s, l] of [
  ["amá-la", "amar"], ["fazê-lo", "fazer"], ["dá-me", "dar"], ["encontramo-nos", "encontrar"],
  ["amar-te-ei", "amar"], ["fá-lo", "fazer"], ["parti-la", "partir"], ["pô-lo", "pôr"], ["fazê", "fazer"],
] as const) has(s, l);
top("pra", "para");
top("do", "de + o");
top("’cê", "você");
top("cê", "você");
top("d'água", "de + água");
ok(isCovered(lem.lookup("d'água").candidates[0]), "d'água の構成要素がすべて辞書で引ける");
ok(isCovered(lem.lookup("do").candidates[0]), "do の構成要素がすべて辞書で引ける");

console.log("=== 曖昧（両方の候補） ===");
for (const [s, a, b] of [
  ["foi", "ser", "ir"], ["vendo", "vender", "ver"], ["como", "como", "comer"], ["casa", "casa", "casar"],
  ["nos", "nos", "em + os"], ["tão", "tão", "estar"], ["visto", "ver", "vestir"],
] as const) {
  has(s, a);
  has(s, b);
}
top("como", "como");
top("casa", "casa");

console.log("=== 誤判定しないこと ===");
for (const s of ["o", "a", "e", "em", "se", "sem", "seu", "de", "do", "da", "te", "teu", "lei"]) {
  for (const v of ["ir", "ser", "dar", "ter", "estar", "ler"]) not(s, v);
}
not("mesa", "meso");
top("casas", "casa");
top("pais", "pai");
top("da", "de + a");
top("dá", "dar");
top("esta", "esta");
top("está", "estar");
top("cansada", "cansado");

console.log("=== トークン化・成句・固有名詞 ===");
const t1 = lem.analyzeLine("Levei o guarda-chuva na segunda-feira.");
ok(t1.some((t) => t.key === "guarda-chuva"), "guarda-chuva は1トークン");
top("guarda-chuva", "guarda-chuva");
top("segunda-feira", "segunda-feira");
not("bem-te-vi", "ter");
ok(lemmas("bem-te-vi")[0] === "bem + te + vi", "bem-te-vi は接語分離しない（複合語）");
const t2 = lem.analyzeLine("De repente, às vezes, por que não?");
ok(t2.filter((t) => t.phrase?.key === "de repente").length === 2, "de repente を成句として検出");
ok(t2.filter((t) => t.phrase?.key === "às vezes").length === 2, "às vezes を成句として検出");
ok(t2.filter((t) => t.phrase?.key === "por que").length === 2, "por que を成句として検出");
top("coração", "coração"); // NFD 分解された入力
ok(lem.lookup("Casa", { lineStart: true }).candidates[0]?.lemma === "casa", "行頭の Casa は一般語");
ok(lem.lookup("Besouro").candidates[0]?.kind === "proper", "文中の Besouro は固有名詞");
ok(lem.lookup("besouro").candidates.length === 0, "小文字の besouro は人名にしない");
top("idéia", "idéia");
top("ideia", "idéia"); // アクセント表記揺れ（見出しの表記で返す）
has("beija-flor", "beija + flor");

console.log("=== レビュー指摘の回帰 ===");
top("mães", "mãe");
top("pães", "pão");
has("produz", "produzir");
not("produze", "produzir");
has("agride", "agredir");
has("agrido", "agredir");
has("previne", "prevenir");
top("pouquíssimo", "pouco");
top("riquíssimo", "rico");
ok(lem.lookup("vê-lo").candidates[0]?.note.includes("不定詞") === true, "vê-lo は ver の不定詞＋接語");
has("comes", "comer");
not("paras", "para");
ok(lem.lookup("aceito").candidates.some((c) => c.note.includes("直説法現在")), "aceito は現在1単も示す");
top("má", "mau");
has("más", "mau");
not("pra", "parar");
ok(lem.lookup("lá-lá-lá").candidates[0]?.kind === "interjection", "lá-lá-lá は間投詞");

console.log("=== isGrammarWord（曲の単語の一括追加から除く語） ===");
ok(isGrammarWord("冠詞", "その・あの（男性単数の定冠詞）"), "冠詞 o");
ok(isGrammarWord("前置詞", "〜の・〜から"), "前置詞 de");
ok(isGrammarWord("前置詞句", "〜の代わりに"), "前置詞句（前方一致）");
ok(isGrammarWord("接続詞", "そして"), "接続詞 e");
ok(isGrammarWord("代名詞", "私を・私に（目的格）"), "目的格の代名詞 me");
ok(isGrammarWord("代名詞", "あなたに・彼に・彼女に（間接目的格）"), "間接目的格 lhe");
ok(isGrammarWord("代名詞", "自分を・自分に（再帰代名詞）"), "再帰代名詞 se");
ok(!isGrammarWord("代名詞", "私"), "主格の代名詞 eu は残す");
ok(!isGrammarWord("代名詞", "私の"), "所有の代名詞 meu は残す");
ok(!isGrammarWord("名詞", "目的格"), "名詞は ja に目的格とあっても残す");
ok(!isGrammarWord("動詞", "〜と結婚する（再帰）"), "動詞は ja に再帰とあっても残す");
ok(!isGrammarWord("副詞", "とても"), "副詞は残す");
ok(!isGrammarWord("名詞・形容詞", "良い"), "名詞・形容詞は残す");
{
  // 縮約（do = de + o）は構成要素がどちらも機能語
  const parts = lem.lookup("do").candidates[0]?.parts ?? [];
  const posOf = (p: (typeof parts)[number]) => p.top?.refs[0]?.pos ?? "";
  ok(parts.length === 2 && parts.every((p) => isGrammarWord(posOf(p), "")), "縮約 do の構成要素（de・o）はどちらも除外");
}

console.log("=== 活用表（data/conjugator.getConjugator・services/verbTable） ===");
{
  const same = (a: unknown, e: unknown, msg: string) =>
    ok(JSON.stringify(a) === JSON.stringify(e), `${msg}  → 期待: ${JSON.stringify(e)} 実際: ${JSON.stringify(a)}`);
  const conj = getConjugator();
  const table = irregularTable();
  ok(getConjugator() === conj && irregularTable() === table, "getConjugator・irregularTable はメモ化（同じものを返す）");
  ok(!Object.keys(table).some((k) => k.startsWith("_")), "不規則動詞の表から _comment などを除く");
  same(irregularVerbs().length, Object.keys(load<Record<string, unknown>>("verb-irregular.json")).filter((k) => !k.startsWith("_")).length, "irregularVerbs: 表の動詞すべて");

  // verbHead: 活用表を出せる動詞か
  same(verbHead("falar", "動詞", table), { inf: "falar", reflexive: false }, "verbHead: falar");
  same(verbHead("ir", "動詞", table), { inf: "ir", reflexive: false }, "verbHead: ir（2文字の不定詞）");
  same(verbHead("pôr", "動詞", table), { inf: "pôr", reflexive: false }, "verbHead: pôr");
  same(verbHead("compor", "動詞", table), { inf: "compor", reflexive: false }, "verbHead: compor（表にある -or）");
  same(verbHead("chamar-se", "動詞", table), { inf: "chamar", reflexive: true }, "verbHead: chamar-se → chamar（再帰）");
  same(verbHead("lembrar(-se)", "動詞", table), { inf: "lembrar", reflexive: true }, "verbHead: lembrar(-se) → lembrar（再帰）");
  same(verbHead("Falar", "動詞", table), { inf: "falar", reflexive: false }, "verbHead: 大文字は小文字に");
  for (const [pt, pos, why] of [
    ["sobrepor", "動詞", "表に無い -or（正しく作れない）"],
    ["pulando", "動詞（現在分詞）", "不定詞でない"],
    ["ficar/estar", "動詞", "見出しが2つ"],
    ["ir embora", "動詞", "2語"],
    ["casa", "名詞", "動詞でない"],
    ["jantar", "名詞・動詞", "品詞が「動詞」で始まらない"],
    ["tchau", "動詞", "不定詞の語尾でない"],
  ] as const) ok(verbHead(pt, pos, table) === null, `verbHead: ${pt}（${pos}）→ null（${why}）`);

  // 規則動詞・不規則動詞の表（時制ごとに eu / você・ele / nós / vocês・eles）
  const rows = (inf: string) => Object.fromEntries(buildConjugationTable(conj, table, inf).rows.map((r) => [r.tense, r.forms]));
  const CASES: [string, Record<TableTense, string[]>][] = [
    ["falar", { pres: ["falo", "fala", "falamos", "falam"], pret: ["falei", "falou", "falamos", "falaram"], impf: ["falava", "falava", "falávamos", "falavam"], fut: ["falarei", "falará", "falaremos", "falarão"] }],
    ["comer", { pres: ["como", "come", "comemos", "comem"], pret: ["comi", "comeu", "comemos", "comeram"], impf: ["comia", "comia", "comíamos", "comiam"], fut: ["comerei", "comerá", "comeremos", "comerão"] }],
    ["partir", { pres: ["parto", "parte", "partimos", "partem"], pret: ["parti", "partiu", "partimos", "partiram"], impf: ["partia", "partia", "partíamos", "partiam"], fut: ["partirei", "partirá", "partiremos", "partirão"] }],
    ["ser", { pres: ["sou", "é", "somos", "são"], pret: ["fui", "foi", "fomos", "foram"], impf: ["era", "era", "éramos", "eram"], fut: ["serei", "será", "seremos", "serão"] }],
    ["ir", { pres: ["vou", "vai", "vamos", "vão"], pret: ["fui", "foi", "fomos", "foram"], impf: ["ia", "ia", "íamos", "iam"], fut: ["irei", "irá", "iremos", "irão"] }],
    ["ter", { pres: ["tenho", "tem", "temos", "têm"], pret: ["tive", "teve", "tivemos", "tiveram"], impf: ["tinha", "tinha", "tínhamos", "tinham"], fut: ["terei", "terá", "teremos", "terão"] }],
    ["fazer", { pres: ["faço", "faz", "fazemos", "fazem"], pret: ["fiz", "fez", "fizemos", "fizeram"], impf: ["fazia", "fazia", "fazíamos", "faziam"], fut: ["farei", "fará", "faremos", "farão"] }],
    ["pôr", { pres: ["ponho", "põe", "pomos", "põem"], pret: ["pus", "pôs", "pusemos", "puseram"], impf: ["punha", "punha", "púnhamos", "punham"], fut: ["porei", "porá", "poremos", "porão"] }],
    ["poder", { pres: ["posso", "pode", "podemos", "podem"], pret: ["pude", "pôde", "pudemos", "puderam"], impf: ["podia", "podia", "podíamos", "podiam"], fut: ["poderei", "poderá", "poderemos", "poderão"] }],
    ["manter", { pres: ["mantenho", "mantém", "mantemos", "mantêm"], pret: ["mantive", "manteve", "mantivemos", "mantiveram"], impf: ["mantinha", "mantinha", "mantínhamos", "mantinham"], fut: ["manterei", "manterá", "manteremos", "manterão"] }],
  ];
  for (const [inf, want] of CASES) same(rows(inf), want, `活用表: ${inf}`);
  // 正書法・語幹の変化（表に無い動詞でも正しく作る）
  for (const [inf, tense, person, form] of [
    ["ficar", "pret", 0, "fiquei"], ["chegar", "pret", 0, "cheguei"], ["começar", "pret", 0, "comecei"],
    ["conhecer", "pres", 0, "conheço"], ["proteger", "pres", 0, "protejo"], ["dormir", "pres", 0, "durmo"],
    ["sentir", "pres", 0, "sinto"], ["subir", "pres", 2, "sobe"], ["sair", "pres", 3, "saímos"], ["cair", "pret", 0, "caí"],
    ["doer", "pres", 2, "dói"], ["construir", "pres", 5, "constroem"], ["odiar", "pres", 0, "odeio"], ["passear", "pres", 5, "passeiam"],
    ["ouvir", "pres", 0, "ouço"], ["pedir", "pres", 0, "peço"], ["seguir", "pres", 0, "sigo"], ["traduzir", "pres", 2, "traduz"],
    // 母音の後の i/u に強勢（proíbo・reúno・saúdo）と e → i（insiro）
    ["proibir", "pres", 0, "proíbo"], ["proibir", "pres", 2, "proíbe"], ["proibir", "pres", 3, "proibimos"], ["proibir", "pres", 5, "proíbem"],
    ["reunir", "pres", 2, "reúne"], ["saudar", "pres", 0, "saúdo"], ["saudar", "pret", 0, "saudei"], ["inserir", "pres", 0, "insiro"],
  ] as const) same(conjugationForm(conj, inf, tense, person), form, `${inf} ${tense} ${person} = ${form}`);
  const falar = buildConjugationTable(conj, table, "falar");
  same([falar.ger, falar.pp, falar.irregular, falar.like], ["falando", ["falado"], false, null], "falar: 現在分詞・過去分詞・規則動詞");
  const fazer = buildConjugationTable(conj, table, "fazer");
  same([fazer.ger, fazer.pp, fazer.irregular], ["fazendo", ["feito"], true], "fazer: 過去分詞 feito・不規則");
  same(buildConjugationTable(conj, table, "manter").like, "ter", "manter: ter と同じ活用");
  same(buildConjugationTable(conj, table, "abrir").pp, ["aberto"], "abrir: 過去分詞 aberto だけ");
  same(buildConjugationTable(conj, table, "pagar").pp, ["pagado", "pago"], "pagar: 過去分詞は pagado / pago");
  same(buildConjugationTable(conj, table, "ver").pp, ["visto"], "ver: 過去分詞 visto");
  same(withSubject("falamos", 3), "nós falamos", "withSubject: nós falamos");
  same(withSubject("lembro", 0, true), "eu me lembro", "withSubject: 再帰動詞は代名詞も（eu me lembro）");
  same(formLabel(conj.conjugate("falar").get("falamos") ?? []), "現在・nós ／ 完了過去・nós", "formLabel: falamos は現在と完了過去の nós");
  same(formLabel(conj.conjugate("falar").get("fala") ?? []), "現在・ele・você", "formLabel: fala は表の形（現在・ele・você）だけ示す（命令は出さない）");
  same(formLabel(conj.conjugate("falar").get("falar") ?? []), "不定詞 ／ 接続法未来・1人称単数", "formLabel: falar は不定詞を先に");

  // 実データ: 単語帳の動詞と不規則動詞の表の動詞は、4時制 × 4人称と分詞がすべて空でない1語
  let n = 0;
  let bad = 0;
  const infs = new Set<string>(irregularVerbs());
  for (const w of ALL_WORDS) {
    const h = verbHead(w.pt, w.pos, table);
    if (h) infs.add(h.inf);
  }
  for (const inf of infs) {
    n++;
    const t = buildConjugationTable(conj, table, inf);
    const forms = [...t.rows.flatMap((r) => r.forms), t.ger, ...t.pp];
    if (t.rows.length !== TABLE_TENSES.length || t.rows.some((r) => r.forms.length !== TABLE_PERSONS.length)) bad++;
    else if (forms.some((f) => typeof f !== "string" || !/^\p{Ll}+$/u.test(f))) bad++;
  }
  ok(bad === 0 && n > 200, `単語帳と不規則動詞の表の動詞 ${n}語: 活用表の形がすべて空でない1語（崩れ ${bad}）`);
  console.log(`  活用表を出せる動詞: ${n}語（不規則動詞 ${irregularVerbs().length}語を含む）`);

  // 歌詞の原形推定にも同じ生成器を渡せる（music.ts は getConjugator() を共有する）
  const shared = createLemmatizer({
    entries: [{ id: "words:9000", pt: "proibir", ja: "(fixture)", pos: "動詞", source: "words" }],
    irregular: table,
    colloquial: {},
    conjugator: conj,
  });
  ok(shared.lookup("proíbe").candidates[0]?.lemma === "proibir", "共有の生成器で proíbe → proibir");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
