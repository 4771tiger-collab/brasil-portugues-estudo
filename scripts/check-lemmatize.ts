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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
