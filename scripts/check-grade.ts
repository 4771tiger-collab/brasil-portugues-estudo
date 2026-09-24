// ============================================================================
// 入力式の採点（src/services/grade.ts・gradeLexicon.ts）の回帰テスト
//   npm run check:grade
// 前半は固定データ（フィクスチャ）で検証する。後半は実データ（単語帳・辞書・ディクテーション）での性質を確かめる。
// 例は一般的な単語・短文のみ（歌詞は使わない）。1件でも失敗したら終了コード1。
// ============================================================================

import {
  HINT_MAX,
  accentHint,
  alignTokens,
  charDiff,
  defaultTypoBudget,
  expandAlternatives,
  gradeWord,
  hintText,
  levenshtein,
  maskWord,
  normalizeAnswer,
  ratingForGrade,
  ratingForOverride,
  SPEECH_VARIANTS_MAX,
  numberWords,
  scoreSpeechSentence,
  scoreSpeechWord,
  speechPercent,
  speechVariants,
  type Alignment,
  type DiffSeg,
  type Grade,
  type GradeOptions,
  wordSpans,
} from "../src/services/grade";
import {
  LISTEN_TIMEOUT_MS,
  SENTENCE_LEAD_MS,
  SENTENCE_MS_PER_WORD,
  START_GRACE_MS,
  STOP_GRACE_MS,
  SpeechInputError,
  classifySpeechError,
  createWebSpeechInput,
  sentenceListenTimeoutMs,
  speechErrorMessage,
  speechInput,
  type RecErrorEvent,
  type RecEvent,
  type RecognizerCtor,
  type RecognizerLike,
  type SpeechErrorKind,
} from "../src/services/speechInput";
import { patternItems } from "../src/services/patternDrill";
import { passageToScript } from "../src/services/sentenceGroups";
import {
  SENTENCE_SPLIT_RE,
  alignCounts,
  answerView,
  expGrades,
  learnerView,
  maskedText,
  splitSentences,
  stepHint,
} from "../src/services/dictation";
import {
  BUILTIN_KNOWN_FORMS,
  acceptedPtForJa,
  buildJaMatcher,
  buildKnownForms,
  isKnownForm,
  isOwnAnswer,
  meaningPieces,
  ownAnswers,
  quizAnswers,
} from "../src/services/gradeLexicon";
import { alternatives, fold } from "../src/services/lemmatize";
import { ALL_WORDS } from "../src/data/loadWords";
import { getConjugator, irregularTable, irregularVerbs } from "../src/data/conjugator";
import {
  DRILL_KEY_RE,
  answerEntry,
  drillCandidates,
  drillKey,
  drillWeight,
  gradeConjugation,
  newConjQueue,
  parseDrillKey,
  pickDrill,
  recordStat,
  spreadVerbs,
  stripSubject,
  summarizeConj,
  toQuestions,
  verdictOf,
  weakKeys,
  type DrillStats,
  type Rand,
} from "../src/services/conjugationDrill";
import { TABLE_PERSONS, TABLE_TENSES, conjugationForm, type TablePerson, type TableTense } from "../src/services/verbTable";
import { DICTATIONS, PASSAGES, PATTERNS, SCRIPTS } from "../src/data/content";
import type { Word } from "../src/data/types";

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

// 固定の「実在する語形」（組み込みの最小対も入る）
const FIXTURE_PTS = [
  "você", "avô", "avó", "este/esta", "e", "é mesmo?", "Obrigado/Obrigada", "café", "gosto", "casa", "cada",
  "mão", "mãe", "Socorro!", "fim de semana", "Bem-vindo", "guarda-chuva", "sim", "falar", "amanhã", "gato",
  "de", "eu", "muito", "Tudo bem?",
];
const KNOWN = buildKnownForms(FIXTURE_PTS);
const O: GradeOptions = { isKnownForm: (s) => KNOWN.has(normalizeAnswer(s)) };

function g(input: string, expected: string | string[], o: GradeOptions = O): Grade {
  return gradeWord(input, expected, o).grade;
}

// ---------------------------------------------------------------------------
console.log("=== normalizeAnswer ===");
eq(normalizeAnswer("Socorro!"), "socorro", "感嘆符と大文字");
eq(normalizeAnswer("  Tudo   bem? "), "tudo bem", "前後と連続の空白・疑問符");
eq(normalizeAnswer("Bem-vindo"), "bem vindo", "ハイフンは空白");
eq(normalizeAnswer("guarda–chuva"), "guarda chuva", "ダッシュも空白");
eq(normalizeAnswer("Obrigado/Obrigada"), "obrigado obrigada", "スラッシュは空白");
eq(normalizeAnswer("d’água"), "d'água", "’ → '（語中は残す）");
eq(normalizeAnswer("dʼágua"), "d'água", "ʼ → '");
eq(normalizeAnswer("'tá bom'"), "tá bom", "語頭・語末のアポストロフィは除く");
eq(normalizeAnswer("“Oi”, (tudo) bem…"), "oi tudo bem", "引用符・括弧・三点リーダー");
eq(normalizeAnswer("¿¡Qué!?;:"), "qué", "¿¡;: を除く");
eq(normalizeAnswer("ｏｂｒｉｇａｄｏ"), "obrigado", "全角英字（日本語キーボード）は半角に");
eq(normalizeAnswer("はい？"), "はい", "全角の疑問符");
eq(normalizeAnswer("você"), "você", "分解形（e + ◌̂）は NFC にまとめる");
eq(normalizeAnswer("ÁGUA"), "água", "アクセント付きの大文字");
eq(normalizeAnswer("   "), "", "空白だけ → 空");
eq(normalizeAnswer("?!"), "", "記号だけ → 空");
for (const s of ["Olá", "Bem-vindo", "d’água", "Tudo bem?", "ｏｂｒｉｇａｄｏ"]) {
  eq(normalizeAnswer(normalizeAnswer(s)), normalizeAnswer(s), `冪等: ${s}`);
}

// ---------------------------------------------------------------------------
console.log("=== expandAlternatives ===");
eq(expandAlternatives("Obrigado/Obrigada"), ["Obrigado", "Obrigada"], "スラッシュで分ける");
eq(expandAlternatives("meu / minha"), ["meu", "minha"], "空白つきのスラッシュ");
eq(expandAlternatives("Mestre Vermelho 27(vinte e sete)"), ["Mestre Vermelho 27"], "括弧の注記を除く");
eq(expandAlternatives("pé（足）"), ["pé"], "全角括弧の注記を除く");
eq(expandAlternatives("Tudo bem?"), ["Tudo bem?"], "記号はそのまま（採点時に正規化）");
eq(expandAlternatives("a/"), ["a/"], "片側が空なら分けない");
for (const s of ["Obrigado/Obrigada", "pé（足）", "x/y/z", "Tudo bem?"]) {
  eq(expandAlternatives(s), alternatives(s), `lemmatize.alternatives と同じ: ${s}`);
}

// ---------------------------------------------------------------------------
console.log("=== levenshtein（OSA） ===");
eq(levenshtein("", "abc"), 3, "空 → abc");
eq(levenshtein("abc", ""), 3, "abc → 空");
eq(levenshtein("abc", "abc"), 0, "同じ");
eq(levenshtein("kitten", "sitting"), 3, "kitten/sitting");
eq(levenshtein("ab", "ba"), 1, "隣り合う2文字の入れ替えは1");
eq(levenshtein("caas", "casa"), 1, "caas/casa（入れ替え）");
eq(levenshtein("ca", "abc"), 3, "OSA（制限つき）: ca/abc は3（完全な Damerau なら2）");
eq(levenshtein("obrigdo", "obrigado"), 1, "1文字抜け");
eq(levenshtein("você", "voce"), 1, "アクセント違いも1");
eq(levenshtein("você", "você"), 0, "同じ文字（合成済み）");
for (const [a, b] of [["obrigado", "obgdo"], ["ab", "ba"], ["casa", "cada"], ["", "x"]]) {
  eq(levenshtein(a, b), levenshtein(b, a), `対称: ${a}/${b}`);
}

// ---------------------------------------------------------------------------
console.log("=== charDiff ===");
eq(charDiff("obrigdo", "obrigado"), [
  { kind: "same", text: "obrig" },
  { kind: "ins", text: "a" },
  { kind: "same", text: "do" },
], "抜けた文字は ins");
eq(charDiff("avó", "avô"), [
  { kind: "same", text: "av" },
  { kind: "del", text: "ó" },
  { kind: "ins", text: "ô" },
], "違う文字は del → ins の順");
eq(charDiff("casaa", "casa"), [{ kind: "same", text: "casa" }, { kind: "del", text: "a" }], "余分な文字は del");
eq(charDiff("", "abc"), [{ kind: "ins", text: "abc" }], "空の入力");
eq(charDiff("abc", ""), [{ kind: "del", text: "abc" }], "空の正解");
eq(charDiff("abc", "abc"), [{ kind: "same", text: "abc" }], "同じ");
eq(charDiff("", ""), [], "両方空");
{
  // 性質: same+del を並べると入力、same+ins を並べると正解。隣り合う区間は種類が違う。LCS の長さは最大
  const words = ["obrigado", "obrigada", "você", "voce", "casa", "cada", "amanhã", "amanha", "guarda chuva", "", "a", "ba", "abc"];
  const lcs = (a: string, b: string) => {
    const x = Array.from(a);
    const y = Array.from(b);
    const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
    for (let i = 1; i <= x.length; i++)
      for (let j = 1; j <= y.length; j++)
        L[i][j] = x[i - 1] === y[j - 1] ? L[i - 1][j - 1] + 1 : Math.max(L[i - 1][j], L[i][j - 1]);
    return L[x.length][y.length];
  };
  let bad = 0;
  for (const a of words) {
    for (const b of words) {
      const d: DiffSeg[] = charDiff(a, b);
      const inp = d.filter((s) => s.kind !== "ins").map((s) => s.text).join("");
      const exp = d.filter((s) => s.kind !== "del").map((s) => s.text).join("");
      const same = d.filter((s) => s.kind === "same").map((s) => s.text).join("");
      const merged = d.every((s, i) => i === 0 || d[i - 1].kind !== s.kind);
      if (inp !== a || exp !== b || Array.from(same).length !== lcs(a, b) || !merged || d.some((s) => !s.text)) bad++;
    }
  }
  eq(bad, 0, `charDiff の性質（${words.length}×${words.length} 組）`);
}

// ---------------------------------------------------------------------------
console.log("=== accentHint ===");
eq(accentHint("voce", "você"), "ê が必要", "足りないアクセント");
eq(accentHint("é", "e"), "é は不要（e）", "余分なアクセント");
eq(accentHint("á", "â"), "á ではなく â", "違うアクセント");
eq(accentHint("voçe", "você"), "ç は不要（c）、ê が必要", "複数の違い");
eq(accentHint("cafe e cafe", "café e café"), "é が必要", "同じ指摘は1回");
eq(accentHint("ab", "abc"), "アクセント記号が違います", "文字数が違えば一般的な言い方");

// ---------------------------------------------------------------------------
console.log("=== typoBudget ===");
eq([1, 3, 4, 6, 7, 12, 13, 30].map(defaultTypoBudget), [0, 0, 1, 1, 2, 2, 3, 3], "長さ別の上限 3/6/12");

// ---------------------------------------------------------------------------
console.log("=== gradeWord（設計の例 §2d） ===");
eq(g("voce", "você"), "accent", '"voce" → você は accent');
eq(gradeWord("voce", "você", O).note, "ê が必要", "accent の note");
eq(g("avó", "avô"), "wrong", '"avó" → avô は wrong（最小対）');
eq(gradeWord("avó", "avô", O).note, "avó は別の語（ó ではなく ô）", "最小対の note");
eq(g("avo", "avô"), "accent", '"avo" → avô は accent（avo は実在しない）');
eq(g("obrigdo", "Obrigado/Obrigada"), "typo", '"obrigdo" → "Obrigado/Obrigada" は typo');
eq(gradeWord("obrigdo", "Obrigado/Obrigada", O).expected, "Obrigado", "typo の expected は近い方の表記");
eq(gradeWord("obrigdo", "Obrigado/Obrigada", O).note, "つづりが1文字違います", "typo の note");
eq(g("e", "é"), "wrong", '"e" → é は wrong');
eq(g("Socorro!", "socorro"), "exact", '"Socorro!" と "socorro" は exact');
eq(g("socorro", "Socorro!"), "exact", "逆向きも exact");

console.log("=== gradeWord（そのほか） ===");
eq(g("VOCÊ", "você"), "exact", "大文字でも exact");
eq(g("obrigada", "Obrigado/Obrigada"), "exact", "表記ゆれのもう一方");
eq(g("obrigado obrigada", ["Obrigado/Obrigada", "Obrigado, Obrigada"]), "exact", "読み上げの形（両方続けて）");
eq(g("obrigado/obrigada", ["Obrigado, Obrigada"]), "exact", "スラッシュ入りの入力");
eq(g("esta", "está"), "wrong", "esta → está は wrong（組み込みの最小対）");
eq(g("está", "este/esta"), "wrong", "está → esta は wrong");
eq(g("so", "só"), "accent", "so → só は accent（so は語として存在しない）");
eq(g("pais", "país"), "wrong", "pais → país は wrong");
eq(g("voçe", "você"), "accent", "セディーユの付け間違いも accent");
eq(gradeWord("voçe", "você", O).diff, [
  { kind: "same", text: "vo" },
  { kind: "del", text: "çe" },
  { kind: "ins", text: "cê" },
], "diff は正規化した入力 → 正解（続いた違いは del → ins にまとまる）");
eq(gradeWord("VOCE!", "você", O).diff, [
  { kind: "same", text: "voc" },
  { kind: "del", text: "e" },
  { kind: "ins", text: "ê" },
], "diff は大文字・記号を正規化した後で取る");
eq(g("mae", "mãe"), "accent", "mae → mãe は accent");
eq(g("mão", "mãe"), "wrong", "mão → mãe は wrong（3文字は typo なし）");
eq(g("cada", "casa"), "wrong", "cada → casa は wrong（cada は実在の別語）");
eq(gradeWord("cada", "casa", O).note, "cada は別の語", "つづり違いの実在語の note");
eq(g("caas", "casa"), "typo", "caas → casa は typo（入れ替え1）");
eq(g("cafe", "café"), "accent", "cafe → café は accent");
eq(g("sin", "sim"), "wrong", "3文字以下は1文字違いでも wrong");
eq(g("falr", "falar"), "typo", "5文字は1文字まで typo");
eq(g("fala", "falar"), "typo", "5文字の1文字抜け");
eq(g("fal", "falar"), "wrong", "5文字で2文字違いは wrong");
eq(g("amanha", "amanhã"), "accent", "amanha → amanhã");
eq(g("amanhá", "amanhã"), "accent", "違うアクセント");
eq(g("obrgdo", "obrigado"), "typo", "8文字は2文字まで typo");
eq(g("obgdo", "obrigado"), "wrong", "8文字で3文字違いは wrong");
eq(g("fin di semna", "fim de semana"), "typo", "13文字以上は3文字まで typo");
eq(g("fin di semn", "fim de semana"), "wrong", "13文字で4文字違いは wrong");
eq(g("obrigdó", "obrigado"), "typo", "typo の距離はアクセントを数えない");
eq(g("obrigdo", "obrigado", { ...O, typoBudget: () => 0 }), "wrong", "typoBudget を差し替えられる");
eq(g("avó", "avô", {}), "accent", "isKnownForm が無ければ最小対も accent");
eq(g("", "você"), "wrong", "空の入力は wrong");
eq(g("   ", "você"), "wrong", "空白だけの入力は wrong");
eq(gradeWord("oi", "?!", O), { grade: "wrong", expected: "", distance: 2, diff: [{ kind: "del", text: "oi" }] }, "正解が空なら wrong・expected は空");
eq(gradeWord("oi", [], O).grade, "wrong", "正解の候補が無い");
eq(g("bem vindo", "Bem-vindo"), "exact", "ハイフンは空白と同じ");
eq(g("guarda chuva", "guarda-chuva"), "exact", "guarda chuva = guarda-chuva");
eq(g("tudo bem", "Tudo bem?"), "exact", "疑問符は無視");
eq(g("d'agua", "d'água"), "accent", "アポストロフィつきの語のアクセント");
eq(g("d’água", "d'água"), "exact", "’ と ' は同じ");
eq(g("esta bem", "está bem"), "accent", "複数語の入力は全体で実在語か判定（esta bem は accent）");
eq(gradeWord("você", "você", O).note, undefined, "exact に note は無い");
eq(gradeWord("você", "você", O).distance, 0, "exact の distance は0");
eq(gradeWord("voce", "você", O).distance, 1, "accent の distance");

console.log("=== gradeWord（候補が複数） ===");
eq(gradeWord("obrigado", ["gato", "obrigado"], O).expected, "obrigado", "exact の候補を選ぶ");
{
  const r = gradeWord("obrgado", ["obrigada", "obrigado"], O);
  eq([r.grade, r.expected, r.distance], ["typo", "obrigado", 1], "同じ段なら距離の近い方");
}
{
  const r = gradeWord("voce", ["vocês", "você"], O);
  eq([r.grade, r.expected], ["accent", "você"], "typo より accent を優先（候補の順によらない）");
}
{
  const r = gradeWord("gatto", ["casa", "gato"], O);
  eq([r.grade, r.expected], ["typo", "gato"], "wrong より typo");
}
{
  const r = gradeWord("xyz", ["casa", "abc"], O);
  eq([r.grade, r.expected], ["wrong", "abc"], "wrong のときは距離の近い候補");
}
eq(gradeWord("mes", ["mês", "lua"], O).grade, "accent", "同じ意味の別見出しを含む候補");

// ---------------------------------------------------------------------------
console.log("=== ratingForGrade ===");
eq(
  (["exact", "accent", "typo", "wrong"] as Grade[]).map((x) => [ratingForGrade(x, false), ratingForGrade(x, true)]),
  [["good", "hard"], ["hard", "hard"], ["hard", "hard"], ["again", "again"]],
  "exact→good（ヒントありは hard）、accent/typo→hard、wrong→again"
);

eq(ratingForOverride(false), "good", "「正解にする」: ヒントなしは good");
eq(ratingForOverride(true), "hard", "「正解にする」: ヒントありは hard");
eq(
  (["exact", "accent", "typo", "wrong"] as Grade[]).map((x) => [false, true].map((h) => ratingForOverride(h) !== ratingForGrade(x, h))),
  [[false, false], [true, false], [true, false], [true, true]],
  "「正解にする」で評価が変わる組（クイズはこの間だけ反映を保留する）: 惜しい（ヒントなし）と不正解"
);

// ---------------------------------------------------------------------------
console.log("=== hintText ===");
eq(HINT_MAX, 2, "ヒントは2段階");
eq(hintText("você", 0), "", "0段目は空");
eq(hintText("você", 1), "v…", "1段目は頭文字");
eq(hintText("você", 2), "v___", "2段目は頭文字＋文字数");
eq(hintText("Obrigado/Obrigada", 1), "O… ／ O…", "表記ゆれは両方");
eq(hintText("Tudo bem?", 2), "T___ b__?", "語ごとにマスク");
eq(hintText("Prazer em conhecê-lo", 2), "P_____ e_ c______-__", "ハイフンは残し、後ろの文字も伏せる");
eq(hintText("¿Onde?", 1), "O…", "先頭の記号は飛ばして頭文字");
eq(hintText("pé（足）", 2), "p_", "括弧の注記は出さない");

// ---------------------------------------------------------------------------
console.log("=== alignTokens ===");
const view = (a: Alignment) => a.tokens.map((t) => `${t.exp ?? "-"}/${t.got ?? "-"}:${t.grade}`);
{
  const a = alignTokens("eu gosto de café", "eu gosto muito de café", O);
  eq(view(a), ["eu/eu:exact", "gosto/gosto:exact", "muito/-:missing", "de/de:exact", "café/café:exact"], "1語抜け → missing 1、他は exact");
  eq([a.correct, a.partial, a.total], [4, 0, 5], "correct/partial/total");
}
{
  const a = alignTokens("gosto de café", "eu gosto de café", O);
  eq([a.correct, a.total, a.tokens[0].grade], [3, 4, "missing"], "先頭の1語抜けでも後ろがずれない（旧採点は 0/4）");
}
{
  const a = alignTokens("eu gosto muito muito de café", "eu gosto muito de café", O);
  eq([a.correct, a.total, a.tokens.filter((t) => t.grade === "extra").length], [5, 5, 1], "余分な語は extra");
}
{
  const a = alignTokens("eu gosto de cafe", "eu gosto de café", O);
  eq([a.correct, a.partial, a.tokens[3].grade], [3, 1, "accent"], "アクセント違いは partial");
}
{
  const a = alignTokens("Eu gosta de café.", "eu gosto de café", O);
  eq([a.tokens[1].grade, a.partial], ["typo", 1], "gosta は（辞書に無ければ）typo");
  const b = alignTokens("eu gosta de café", "eu gosto de café", { isKnownForm: (s) => s === "gosta" });
  eq(b.tokens[1].grade, "wrong", "isKnownForm が gosta を知っていれば wrong");
}
{
  const a = alignTokens("Oi, tudo bem?", "oi tudo bem", O);
  eq([a.correct, a.total], [3, 3], "句読点と大文字は無視");
  eq(a.tokens.map((t) => t.got), ["Oi", "tudo", "bem"], "got は入力の元の表記");
}
{
  const a = alignTokens("guarda chuva", "guarda-chuva", O);
  eq([a.correct, a.total], [2, 2], "ハイフンの語は分けて数える");
}
{
  const a = alignTokens("", "eu gosto de café", O);
  eq([a.correct, a.total, a.tokens.every((t) => t.grade === "missing")], [0, 4, true], "空の入力は全部 missing");
  const b = alignTokens("eu gosto", "", O);
  eq([b.total, b.tokens.map((t) => t.grade)], [0, ["extra", "extra"]], "空の正解は全部 extra");
  eq(alignTokens("", "", O), { tokens: [], correct: 0, partial: 0, total: 0 }, "両方空");
}
{
  const a = alignTokens("eu gosto de pão", "eu gosto de café", O);
  eq(view(a).slice(3), ["café/pão:wrong"], "1語の入れ替えは wrong の置換（抜け＋余分より安い）");
}
{
  // 同じコストなら置換を優先して後ろからたどる（後ろの語どうしが組になる）。
  // aa ↔ (bb cc) は「bb 余分 + aa↔cc」「aa↔bb + cc 余分」のどちらも 2.2
  eq(view(alignTokens("bb cc", "aa", O)), ["-/bb:extra", "aa/cc:wrong"], "同点（余分と置換）は置換を優先");
  eq(view(alignTokens("cc", "aa bb", O)), ["aa/-:missing", "bb/cc:wrong"], "同点（抜けと置換）は置換を優先");
}
{
  // 性質: 並びが保たれる・total は正解の語数・同じ文は全部 exact（小さな語彙の変形で網羅的に）
  const vocab = ["eu", "gosto", "muito", "de", "café", "casa", "você", "mãe", "sim"];
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  let bad = 0;
  for (let k = 0; k < 400; k++) {
    const ans = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => vocab[Math.floor(rand() * vocab.length)]);
    const inp: string[] = [];
    for (const w of ans) {
      const r = rand();
      if (r < 0.15) continue; // 抜け
      if (r < 0.3) inp.push(vocab[Math.floor(rand() * vocab.length)]); // 置換
      else if (r < 0.4) inp.push(fold(w)); // アクセント落ち
      else inp.push(w);
      if (rand() < 0.1) inp.push(vocab[Math.floor(rand() * vocab.length)]); // 余分
    }
    const a = alignTokens(inp.join(" "), ans.join(" "), O);
    const exps = a.tokens.filter((t) => t.exp !== null).map((t) => t.exp);
    const gots = a.tokens.filter((t) => t.got !== null).map((t) => t.got);
    const same = alignTokens(ans.join(" "), ans.join(" "), O);
    const okOne =
      JSON.stringify(exps) === JSON.stringify(ans) &&
      JSON.stringify(gots) === JSON.stringify(inp) &&
      a.total === ans.length &&
      a.correct + a.partial <= a.total &&
      a.tokens.every((t) => (t.exp === null) === (t.grade === "extra") && (t.got === null) === (t.grade === "missing")) &&
      same.correct === ans.length &&
      same.tokens.length === ans.length;
    if (!okOne) bad++;
  }
  eq(bad, 0, "alignTokens の性質（400文）");
}

// ---------------------------------------------------------------------------
console.log("=== maskWord ===");
eq(maskWord("você"), "v___", "頭文字＋下線");
eq(maskWord("d'água"), "d'____", "記号は残す");
eq(maskWord("Olá!"), "O__!", "末尾の記号");
eq(maskWord(""), "", "空");
eq(maskWord("...a"), "...a", "最初の文字だけ見せる");
{
  // Dictation.tsx にあった元の実装と同じ結果
  const legacy = (w: string) => {
    let seen = false;
    let out = "";
    for (const ch of w) {
      if (/\p{L}/u.test(ch)) {
        if (!seen) {
          out += ch;
          seen = true;
        } else out += "_";
      } else out += ch;
    }
    return out;
  };
  const texts = DICTATIONS.flatMap((d) => d.text.split(" "));
  eq(texts.filter((w) => maskWord(w) !== legacy(w)).length, 0, `Dictation の元の maskWord と同じ（${texts.length}語）`);
}

// ---------------------------------------------------------------------------
console.log("=== wordSpans ===");
{
  const s = "— Oi, tudo bem? Guarda-chuva d'água!";
  const sp = wordSpans(s);
  eq(sp.map((w) => w.text), ["Oi", "tudo", "bem", "Guarda", "chuva", "d'água"], "語だけ（ダッシュ・句読点は除く。ハイフンの語は分ける）");
  ok(sp.every((w) => s.slice(w.start, w.end) === w.text), "位置は元の文の中の位置");
  const b = alignTokens(s, s, O);
  eq(b.tokens.map((t) => t.exp), sp.map((w) => w.text), "alignTokens の正解側の語と同じ並び");
  const nfd = "você".normalize("NFD");
  eq(wordSpans(nfd).map((w) => w.text), ["você"], "NFD の入力も NFC の語にする");
}

// ---------------------------------------------------------------------------
console.log("=== ディクテーションの表示（dictation.ts） ===");
{
  eq(splitSentences("Eu quero água, por favor."), ["Eu quero água, por favor."], "1文");
  eq(
    splitSentences("— Oi, tudo bem? — Tudo ótimo! E você? — Estou bem, obrigado. Vamos?"),
    ["— Oi, tudo bem?", "— Tudo ótimo!", "E você?", "— Estou bem, obrigado.", "Vamos?"],
    "? ! . の後ろの空白で分ける"
  );
  eq(splitSentences("São 3.5 km.  Tchau!  "), ["São 3.5 km.", "Tchau!"], "数字の中の . では分けない・末尾の空白は捨てる");
  eq(splitSentences(""), [], "空");
  eq(String(SENTENCE_SPLIT_RE), String(/(?<=[.!?])\s+/), "区切りは設計どおり");
}
{
  const ans = "Eu gosto muito de café.";
  const a = alignTokens("eu gosta de pão cafe hoje", ans, O);
  const v = learnerView(a);
  eq(
    v.map((t) => `${t.text}:${t.kind}`),
    ["eu:exact", "gosta:typo", "m____:missing", "de:exact", "pão:extra", "cafe:accent", "hoje:extra"],
    "STEP1: 入力の語だけを色分け、抜けた語は頭文字マスク"
  );
  ok(!v.some((t) => t.text === "muito" || t.text === "café" || t.text === "gosto"), "STEP1: 書けなかった語・違った語の正しい綴りを出さない");
  eq(alignCounts(a), { correct: 2, partial: 2, wrong: 0, missing: 1, extra: 2, total: 5 }, "件数");
  eq(expGrades(a), ["exact", "typo", "missing", "exact", "accent"], "本文の語ごとの採点");
  eq(stepHint(ans, a), "Eu g____ m____ de c___.", "STEP3: STEP1 で正しく書けた語だけそのまま、他は頭文字マスク");
  eq(stepHint(ans, null), "E_ g____ m____ d_ c___.", "STEP3: 採点していなければ全部マスク");
  eq(stepHint(ans, alignTokens(ans, ans, O)), ans, "全部正しければヒント＝本文");
  eq(maskedText("— Oi, tudo bem?", [true]), "— Oi, t___ b__?", "maskedText: 記号・ダッシュはそのまま、keep の語は見せる");
  eq(maskedText("guarda-chuva", [false, true]), "g_____-chuva", "maskedText: ハイフンの語は部分ごと");
  eq(
    answerView(a).map((t) => `${t.text}${t.got ? `<${t.got}` : ""}:${t.kind}`),
    ["Eu:exact", "gosto<gosta:typo", "muito:missing", "de:exact", "pão:extra", "café<cafe:accent", "hoje:extra"],
    "STEP4: 本文の語を色分けし、違った語には入力した形を添える"
  );
  const w = alignTokens("eu gosto demais de chá", ans, O);
  eq(
    learnerView(w).filter((t) => t.kind === "wrong").map((t) => t.text),
    w.tokens.filter((t) => t.grade === "wrong").map((t) => t.got),
    "wrong の語は入力した形だけ（正解の形は出さない）"
  );
}

// ---------------------------------------------------------------------------
console.log("=== gradeLexicon（固定データ） ===");
{
  const k = buildKnownForms(["meu/minha", "fim de semana", "Bem-vindo", "Tudo bem?", "Mestre Vermelho 27(vinte e sete)"], []);
  eq(
    ["meu", "minha", "fim de semana", "fim", "de", "semana", "bem vindo", "bem", "vindo", "tudo bem", "tudo", "mestre vermelho 27", "27"].every((x) => k.has(x)),
    true,
    "見出し全体と各語（表記ゆれ・ハイフン・記号を正規化）"
  );
  ok(!k.has("vinte") && !k.has("meu/minha") && !k.has("bem-vindo") && !k.has("tudo bem?"), "括弧の注記・未正規化の形は入れない");
  ok(!k.has("está"), "builtin を空にすれば組み込みの最小対は入らない");
}
{
  const pairs = ["é/e", "está/esta", "avó/avô", "pôr/por", "pôde/pode", "nós/nos", "têm/tem", "vêm/vem", "país/pais", "dá/da", "dê/de", "à/a", "às/as"];
  const b = new Set(BUILTIN_KNOWN_FORMS);
  eq(pairs.filter((p) => !p.split("/").every((x) => b.has(x))), [], "組み込みの最小対（両側）");
  ok(b.has("só") && !b.has("so"), "só は入れるが so は入れない（so は語として存在しない）");
  ok(KNOWN.has("está") && KNOWN.has("esta") && KNOWN.has("só"), "既定では組み込みの最小対も入る");
}
eq(meaningPieces({ ja: "〜である（本質的・恒久的）", source: "words" }), ["である(本質的・恒久的)"], "括弧の中の・では分けない");
eq(meaningPieces({ ja: "知っている・（やり方を）知っている", source: "words" }), ["知っている", "(やり方を)知っている"], "括弧の外で分ける");
eq(meaningPieces({ ja: "ステップ / 歩み", source: "words" }), ["ステップ", "歩み"], "／ と空白");
eq(meaningPieces({ ja: "ペースト・フォルダ", source: "words" }), ["ペースト", "フォルダ"], "words のカタカナ間の・は分ける");
eq(meaningPieces({ ja: "メストリ・ビンバの弟子", source: "capoeira" }), ["メストリ・ビンバの弟子"], "capoeira のカタカナ間の・は分けない");
eq(meaningPieces({ ja: "はい。", source: "words" }), ["はい"], "末尾の句点");
eq(meaningPieces({ ja: "", source: "words" }), [], "空");
{
  const W = (id: string, pt: string, ja: string, pos = "名詞", source: Word["source"] = "words") => ({ id, pt, ja, pos, source });
  const words = [
    W("t:1", "lua", "月"),
    W("t:2", "mês", "月"),
    W("t:3", "ser", "〜である（本質的・恒久的）", "動詞"),
    W("t:4", "estar", "〜である（一時的・状態）", "動詞"),
    W("t:5", "apenas", "〜だけ", "副詞"),
    W("t:6", "só", "〜だけ・たった", "副詞"),
    W("t:7", "Lua Nova", "月", "固有名詞（人名）"),
    W("t:8", "velho", "月", "_deleted"),
    W("t:9", "ela", "彼女", "代名詞"),
    W("t:10", "namorado/namorada", "恋人・彼氏・彼女"),
    W("t:11", "Obrigado/Obrigada", "ありがとう", "間投詞"),
    W("t:12", "obrigado", "ありがとう", "間投詞"),
    W("t:13", "lua", "月"),
  ];
  const m = buildJaMatcher(words);
  eq(m(words[0]), ["mês"], "月 → mês（固有名詞・削除済み・自分と同じ表記の語は除く）");
  eq(m(words[1]), ["lua"], "月 → lua（同じ表記は1回）");
  eq(m(words[2]), [], "ser と estar は注記で区別する");
  eq(m(words[4]), ["só"], "〜だけ → só（só は意味の片をすべて含む）");
  eq(m(words[5]), [], "só（〜だけ・たった）→ apenas は含まない（たったが無い）");
  eq(m(words[8]), ["namorado", "namorada"], "彼女 → namorado/namorada（表記ゆれは両方）");
  eq(m(words[10]), [], "自分の表記と同じ別見出しは返さない");
  eq(m({ id: "dict:0001", pt: "o mês", ja: "月", pos: "名詞", source: "dict" }), ["lua", "mês"], "単語帳に無い語（dict）でも引ける");
  eq(m({ id: "x", pt: "x", ja: "", pos: "名詞", source: "words" }), [], "和訳が空なら何も返さない");
  eq(m({ id: "x", pt: "x", ja: "存在しない意味", pos: "名詞", source: "words" }), [], "該当なし");
}
{
  // "a/b" の訳が "x・y" と1対1なら、問いの意味の片に当たる表記だけを正解にする
  const W = (id: string, pt: string, ja: string, pos = "名詞", source: Word["source"] = "words") => ({ id, pt, ja, pos, source });
  const words = [
    W("t:1", "ela", "彼女", "代名詞"),
    W("t:2", "namorado/namorada", "彼氏・彼女"),
    W("t:3", "filho/filha", "息子・娘"),
    W("t:4", "moça", "娘"),
  ];
  const m = buildJaMatcher(words);
  eq(m(words[0]), ["namorada"], "彼女 → namorada だけ（namorado は彼氏なので正解にしない）");
  eq(m(words[3]), ["filha"], "娘 → filha だけ");
  eq(m({ id: "x", pt: "casal", ja: "彼氏・彼女", pos: "名詞", source: "words" }), ["namorado", "namorada"], "問いが両方の片（彼氏・彼女）なら両方");
  eq(m(words[1]), [], "a/b の語自身が問い（ほかに両方の片を含む語は無い）→ なし");
}

// ---------------------------------------------------------------------------
console.log("=== 実データ（単語帳・辞書） ===");
{
  const yes = ["esta", "está", "avó", "avô", "e", "é", "pais", "país", "nos", "nós", "metro", "metrô", "só", "obrigado", "Obrigada", "casa"];
  const no = ["voce", "avo", "so", "nao", "obrigdo", "amanha"];
  eq(yes.filter((s) => !isKnownForm(s)), [], "実在する語形");
  eq(no.filter((s) => isKnownForm(s)), [], "実在しない語形");
}
{
  const R: GradeOptions = { isKnownForm };
  const cases: [string, string, Grade][] = [
    ["voce", "você", "accent"],
    ["avo", "avô", "accent"],
    ["avó", "avô", "wrong"],
    ["esta", "está", "wrong"],
    ["e", "é", "wrong"],
    ["nao", "não", "accent"],
    ["so", "só", "accent"],
    ["pais", "país", "wrong"],
    ["obrigdo", "Obrigado/Obrigada", "typo"],
    ["Socorro", "Socorro!", "exact"],
  ];
  for (const [inp, exp, want] of cases) eq(gradeWord(inp, exp, R).grade, want, `実データ: ${inp} → ${exp}`);
}
{
  const byPt = (pt: string, ja?: string) => ALL_WORDS.find((w) => w.pt === pt && (ja === undefined || w.ja === ja));
  const lua = byPt("lua", "月");
  const mes = byPt("mês");
  const ser = byPt("ser");
  ok(!!lua && acceptedPtForJa(lua).includes("mês"), "lua（月）は mês も正解");
  ok(!!mes && acceptedPtForJa(mes).includes("lua"), "mês（月）は lua も正解");
  ok(!!ser && !acceptedPtForJa(ser).some((p) => normalizeAnswer(p) === "estar"), "ser は estar を正解にしない");
  const ela = byPt("ela");
  ok(!!ela && !acceptedPtForJa(ela).some((p) => normalizeAnswer(p) === "namorado"), "ela（彼女）は namorado（彼氏）を正解にしない");
}
{
  // 全語: 見出しの各表記・読み上げの形・大文字は exact、fold しただけの入力は typo にならない。
  // 同じ意味の別見出しは自分の表記を含まず、重複しない
  let badExact = 0;
  let badFold = 0;
  let badAccepted = 0;
  let badMask = 0;
  for (const w of ALL_WORDS) {
    const answers = [...expandAlternatives(w.pt), w.ptForSpeech];
    for (const a of answers) {
      if (!normalizeAnswer(a)) continue;
      if (gradeWord(a, answers, { isKnownForm }).grade !== "exact") badExact++;
      if (gradeWord(a.toUpperCase(), answers, { isKnownForm }).grade !== "exact") badExact++;
      if (gradeWord(fold(a), answers, { isKnownForm }).grade === "typo") badFold++;
      if (Array.from(maskWord(a)).length !== Array.from(a).length) badMask++;
    }
    const acc = acceptedPtForJa(w).map(normalizeAnswer);
    const own = new Set(expandAlternatives(w.pt).map(normalizeAnswer));
    if (acc.some((k) => own.has(k)) || new Set(acc).size !== acc.length) badAccepted++;
  }
  eq(badExact, 0, `全 ${ALL_WORDS.length} 語: 見出しどおりの入力は exact`);
  eq(badFold, 0, "全語: アクセントを落としただけの入力は typo にならない（accent か wrong）");
  eq(badAccepted, 0, "全語: 同じ意味の別見出しに自分の表記・重複が無い");
  eq(badMask, 0, "全語: maskWord は文字数を変えない");
}

{
  const ob = ALL_WORDS.find((w) => w.pt === "Obrigado/Obrigada");
  ok(!!ob, "Obrigado/Obrigada がある");
  if (ob) {
    eq(ownAnswers(ob), ["Obrigado", "Obrigada", "Obrigado, Obrigada"], "見出し自身の表記＋読み上げの形");
    ok(isOwnAnswer(ob, "obrigada") && isOwnAnswer(ob, "OBRIGADO, obrigada") && !isOwnAnswer(ob, "valeu"), "isOwnAnswer");
    eq(gradeWord("obrigado obrigada", quizAnswers(ob, false), { isKnownForm }).grade, "exact", "続けて打っても exact");
  }
  const lua = ALL_WORDS.find((w) => w.pt === "lua" && w.ja === "月");
  if (lua) {
    ok(quizAnswers(lua, true).includes("mês"), "和→葡（byJa）は同じ意味の別見出しも正解");
    ok(!quizAnswers(lua, false).includes("mês"), "聴き取りは見出し自身の表記だけ");
    const r = gradeWord("mes", quizAnswers(lua, true), { isKnownForm });
    eq([r.grade, r.expected, isOwnAnswer(lua, r.expected)], ["accent", "mês", false], "別見出しでの採点は isOwnAnswer=false（注記を出す）");
  } else ok(false, "lua（月）がある");
}

console.log("=== 実データ（ディクテーション） ===");
{
  let bad = 0;
  for (const d of DICTATIONS) {
    const same = alignTokens(d.text, d.text, { isKnownForm });
    const empty = alignTokens("", d.text, { isKnownForm });
    if (same.correct !== same.total || same.total === 0 || empty.correct !== 0 || empty.tokens.some((t) => t.grade !== "missing")) bad++;
  }
  eq(bad, 0, `全 ${DICTATIONS.length} 問: 本文どおりは全部 exact、空は全部 missing`);

  // STEP1 の表示は正解の全文を出さない（入力の語か、抜けた語の頭文字マスクだけ）。400通りの崩した入力で確かめる
  let rnd = 777;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  let leak = 0;
  let hintBad = 0;
  let splitBad = 0;
  for (let k = 0; k < 400; k++) {
    const d = DICTATIONS[k % DICTATIONS.length];
    const ws = wordSpans(d.text).map((x) => x.text);
    const inp: string[] = [];
    for (const x of ws) {
      const r = rand();
      if (r < 0.2) continue;
      if (r < 0.35) inp.push("xyz");
      else if (r < 0.5) inp.push(fold(x));
      else inp.push(x);
    }
    const a = alignTokens(inp.join(" "), d.text, { isKnownForm });
    const v = learnerView(a);
    const gots = new Set(inp);
    for (let i = 0; i < v.length; i++) {
      const t = a.tokens[i];
      const good = t.got === null ? v[i].text === maskWord(t.exp ?? "") && v[i].kind === "missing" : v[i].text === t.got && gots.has(t.got);
      if (!good) leak++;
    }
    // ヒント: 正しく書けた語は見え、他の語は頭文字マスク（文字数は本文と同じ）
    const h = stepHint(d.text, a);
    if (Array.from(h).length !== Array.from(d.text.normalize("NFC")).length) hintBad++;
    const grades = expGrades(a);
    const hs = wordSpans(h);
    if (hs.length !== ws.length) hintBad++;
    else if (grades.some((g2, i) => (g2 === "exact") !== (hs[i].text === ws[i]) && ws[i].length > 1)) hintBad++;
  }
  eq(leak, 0, "STEP1: 表示するのは入力の語と、抜けた語の頭文字マスクだけ（400通り）");
  eq(hintBad, 0, "STEP3: ヒントは本文と同じ文字数、正しく書けた語だけ見せる（400通り）");
  const legacyHint = (t: string) => t.split(" ").map(maskWord).join(" ");
  for (const d of DICTATIONS) {
    if (stepHint(d.text, null) !== legacyHint(d.text)) splitBad++;
    if (splitSentences(d.text).join(" ") !== d.text.replace(/\s+/g, " ").trim()) splitBad++;
  }
  eq(splitBad, 0, `全 ${DICTATIONS.length} 問: 採点前のヒントは元の Dictation と同じ・文に分けて戻すと本文`);
}

// ---------------------------------------------------------------------------
console.log("=== 音声認識の採点: accentInsensitive ===");
{
  const AI: GradeOptions = { ...O, accentInsensitive: true };
  eq(g("voce", "você", AI), "exact", "アクセントだけの違いは exact");
  eq(g("avó", "avô", AI), "exact", "最小対もアクセントだけなら exact（認識結果の綴りは学習者のものではない）");
  eq(g("e", "é", AI), "exact", "e → é も exact");
  eq(g("voçe", "você", AI), "exact", "セディーユの違いも exact");
  eq(g("obrigdo", "obrigado", AI), "typo", "つづり違いは typo のまま");
  eq(g("cada", "casa", AI), "wrong", "別の実在語は wrong のまま（isKnownForm）");
  eq(g("gato", "casa", AI), "wrong", "違う語は wrong");
  eq(gradeWord("voce", "você", AI).note, undefined, "exact に note は無い");
  eq(g("voce", "você"), "accent", "既定（accentInsensitive なし）は今までどおり accent");
  eq(g("avó", "avô"), "wrong", "既定は今までどおり最小対を wrong");
  const a = alignTokens("Eu gosto de cafe", "eu gosto de café", { accentInsensitive: true });
  eq([a.correct, a.partial, a.total], [4, 0, 4], "alignTokens: アクセント違いも correct");
  eq(a.tokens[3].exp, "café", "alignTokens: exp は正解の表記のまま");
}

console.log("=== 音声認識の採点: 数の読み方 ===");
eq(numberWords(0), ["zero"], "0");
eq(numberWords(1), ["um", "uma"], "1 は男性形・女性形");
eq(numberWords(2), ["dois", "duas"], "2 は男性形・女性形");
eq(numberWords(3), ["três"], "3");
eq(numberWords(14), ["catorze", "quatorze"], "14 は2つの綴り");
eq(numberWords(16), ["dezesseis"], "16（ブラジルの綴り）");
eq(numberWords(20), ["vinte"], "20");
eq(numberWords(21), ["vinte e um", "vinte e uma"], "21");
eq(numberWords(22), ["vinte e dois", "vinte e duas"], "22");
eq(numberWords(30), ["trinta"], "30");
eq(numberWords(57), ["cinquenta e sete"], "57");
eq(numberWords(99), ["noventa e nove"], "99");
eq(numberWords(100), ["cem"], "100");
eq(numberWords(1000), ["mil"], "1000");
eq(numberWords(101), ["cento e um", "cento e uma"], "101");
eq(numberWords(200), ["duzentos", "duzentas"], "200 は男性形・女性形");
ok(numberWords(504).includes("quinhentos e quatro"), "504 → quinhentos e quatro");
eq(numberWords(504)[0], "quinhentos e quatro", "504: 先頭は男性形");
eq(numberWords(1001)[0], "mil e um", "1001 → mil e um");
eq(numberWords(1100), ["mil e cem"], "1100 → mil e cem");
eq(numberWords(1250), ["mil duzentos e cinquenta", "mil duzentas e cinquenta"], "1250 → mil duzentos e cinquenta");
eq(numberWords(2024)[0], "dois mil e vinte e quatro", "2024 → dois mil e vinte e quatro");
eq(numberWords(2000), ["dois mil", "duas mil"], "2000");
ok(numberWords(222222).length <= 8 && new Set(numberWords(222222)).size === numberWords(222222).length, "読み方は8通りまで・重複なし");
eq([numberWords(1_000_000), numberWords(-1), numberWords(1.5), numberWords(NaN)], [[], [], [], []], "対応しない数は []");
{
  let bad = 0;
  for (let n = 0; n <= 2100; n++) {
    const ws = numberWords(n);
    if (!ws.length || ws.some((w) => !/^[\p{L} ]+$/u.test(w)) || new Set(ws).size !== ws.length) bad++;
  }
  eq(bad, 0, "0〜2100 はすべて読める（文字と空白だけ・重複なし）");
}

console.log("=== 音声認識の採点: speechVariants ===");
eq(speechVariants("2 cafés"), ["dois cafés", "duas cafés"], "2 → dois/duas");
eq(speechVariants("Eu tenho 27 anos."), ["Eu tenho vinte e sete anos."], "2桁");
eq(speechVariants("às 3"), ["às três"], "3");
eq(speechVariants("1.000 reais"), ["mil reais"], "3桁区切りの点");
eq(speechVariants("２"), ["dois", "duas"], "全角数字");
eq(speechVariants("2cafés"), ["dois cafés", "duas cafés"], "数字と語がくっついていても分ける");
eq(speechVariants("1234567"), ["1234567"], "読めない数は数字のまま");
eq(speechVariants("10%"), ["dez por cento"], "% → por cento");
eq(speechVariants("R$ 60"), ["sessenta reais"], "R$ → reais");
eq(speechVariants("R$ 1"), ["um real"], "R$ 1 → um real");
eq(speechVariants("R$ 2,50")[0], "dois reais e cinquenta centavos", "センタボ");
eq(speechVariants("R$ 1.000,00"), ["mil reais"], "3桁区切り・センタボ 00");
eq(speechVariants("no 5º andar"), ["no quinto andar"], "º → 序数（男性形）");
eq(speechVariants("a 1ª vez"), ["a primeira vez"], "ª → 序数（女性形）");
eq(speechVariants("o 12º"), ["o doze"], "序数の表に無い数は記号だけ外す");
eq(speechVariants("38°"), ["trinta e oito graus"], "° → graus");
eq(speechVariants("5°")[0], "cinco graus", "° は graus を先に");
ok(speechVariants("5°").includes("quinto"), "1〜10 の ° は序数の形も");
eq(speechVariants("１０％"), ["dez por cento"], "全角の数字と ％");
eq(speechVariants("sem  número"), ["sem  número"], "数字が無ければそのまま");
eq(speechVariants(""), [""], "空");
eq(speechVariants("1 2"), ["um dois", "um duas", "uma dois", "uma duas"], "組み合わせ（先頭ほど男性形）");
eq(speechVariants("1 1 1 1").length, SPEECH_VARIANTS_MAX, "組み合わせは上限まで");
eq(speechVariants("1 2 1", 2), ["um dois um", "um dois uma"], "上限を渡せる");

console.log("=== 音声認識の採点: scoreSpeechWord ===");
{
  const sw = (t: string[], e: string | string[], o: GradeOptions = O) => {
    const s = scoreSpeechWord(t, e, o);
    return [s.grade, s.heard, s.suggestedRating];
  };
  eq(sw(["você"], "você"), ["exact", "você", "good"], "そのまま → exact・good");
  eq(sw(["Você."], "você"), ["exact", "Você.", "good"], "大文字・句読点は無視（heard は元の表記）");
  eq(sw(["voce"], "você"), ["exact", "voce", "good"], "アクセントの違いは正解");
  eq(sw(["avó"], "avô"), ["exact", "avó", "good"], "最小対もアクセントだけなら正解（isKnownForm があっても）");
  eq(sw(["2"], "dois"), ["exact", "2", "good"], "数字 → dois");
  eq(sw(["2"], "duas"), ["exact", "2", "good"], "数字 → duas");
  eq(sw(["27"], "vinte e sete"), ["exact", "27", "good"], "2桁の数字");
  eq(sw(["A casa"], "casa"), ["exact", "A casa", "good"], "先頭の冠詞を外しても比べる");
  eq(sw(["uma casa"], "casa"), ["exact", "uma casa", "good"], "不定冠詞も");
  eq(sw(["obrigdo"], "Obrigado/Obrigada"), ["typo", "obrigdo", "hard"], "つづりが近い → typo・hard");
  eq(sw(["caza"], "casa", {}), ["typo", "caza", "hard"], "4文字の1文字違い → typo");
  eq(sw(["cada"], "casa"), ["wrong", "cada", "again"], "別の実在語に聞こえたら wrong（isKnownForm。入力式と同じ）");
  eq(sw(["casa", "cara"], "cara", {}), ["exact", "cara", "good"], "認識の候補のうち合うものを使う");
  eq(sw(["pão", "mão"], "café"), ["wrong", "pão", "again"], "どれも合わなければ先頭の候補で見せる");
  eq(sw(["xyzxyzxyz", "cafeteria"], "café"), ["wrong", "xyzxyzxyz", "again"], "wrong のときは近さによらず先頭の候補（いちばん確からしい聞き取り）");
  eq(sw([], "você"), ["wrong", "", "again"], "候補なし → wrong");
  eq(sw(["  ", ""], "você"), ["wrong", "", "again"], "空の候補だけ → wrong");
  eq(sw(["mes"], ["lua", "mês"]), ["exact", "mes", "good"], "同じ意味の別見出し（quizAnswers と同じ集合）も正解");
  const s1 = scoreSpeechWord(["obrigdo", "obrigado"], "Obrigado/Obrigada", O);
  eq([s1.grade, s1.heard, s1.result.expected], ["exact", "obrigado", "Obrigado"], "exact の候補を typo の候補より優先");
  const s2 = scoreSpeechWord(["voce"], ["vocês", "você"], O);
  eq([s2.grade, s2.result.expected], ["exact", "você"], "正解の候補から合うもの");
  const s3 = scoreSpeechWord(["Mestre Vermelho 27"], "Mestre Vermelho 27(vinte e sete)", O);
  eq([s3.grade, s3.result.expected], ["exact", "Mestre Vermelho 27"], "数字入りの見出し: expected は元の表記（数字）のまま");
  eq(scoreSpeechWord(["mestre vermelho vinte e sete"], "Mestre Vermelho 27(vinte e sete)", O).grade, "exact", "読み方で言っても正解");
  const s4 = scoreSpeechWord(["obrgdo"], "obrigado", O);
  ok(s4.grade === "typo" && s4.result.diff.some((d) => d.kind !== "same"), "typo は差分つき（裏面に出す）");
  eq(sw(["200"], "duzentos"), ["exact", "200", "good"], "3桁の数字 → duzentos");
  eq(sw(["1ª"], "primeira"), ["exact", "1ª", "good"], "序数の記号");
  const s5 = scoreSpeechWord(["cachorro"], "gato", O);
  eq([s5.grade, s5.result.expected, s5.result.diff.length > 0], ["wrong", "gato", true], "wrong も expected と差分がある");
}

console.log("=== 音声認識の採点: scoreSpeechSentence ===");
{
  const ss = (t: string[], e: string | string[]) => scoreSpeechSentence(t, e);
  const s = ss(["eu gosto de cafe"], "Eu gosto de café.");
  eq([s.kind, s.percent, s.alignment.correct, s.alignment.total, s.heard], ["sentence", 100, 4, 4, "eu gosto de cafe"], "アクセントの違いは正解（100%）");
  eq(s.alignment.tokens.map((t) => t.exp), ["Eu", "gosto", "de", "café"], "exp は正解の表記");
  eq(ss(["eu gosto café"], "Eu gosto de café.").percent, 75, "1語抜け → 75%");
  eq(ss(["eu gosto muito de café"], "eu gosto de café").percent, 80, "余分な1語 → 4/5 = 80%");
  eq(ss(["eu gosta de café"], "eu gosto de café").percent, 88, "惜しい語は0.5（3.5/4 = 87.5 → 88）");
  eq(ss(["Eu quero 2 cafés"], "Eu quero dois cafés.").percent, 100, "数字 → dois");
  eq(ss(["eu quero 2 cervejas"], "Eu quero duas cervejas.").percent, 100, "数字 → duas");
  eq(ss(["tenho 27 anos"], "Tenho vinte e sete anos.").percent, 100, "2桁の数字");
  eq(ss(["Eu tenho vinte e sete anos"], "Eu tenho 27 anos.").percent, 100, "正解の側の数字も読み方にする");
  const b = ss(["onde fica banheiro", "onde fica o banheiro"], "Onde fica o banheiro?");
  eq([b.percent, b.heard], [100, "onde fica o banheiro"], "候補のうち点の高いもの");
  eq(ss(["onde fica o banheiro", "Onde fica o banheiro"], "Onde fica o banheiro?").heard, "onde fica o banheiro", "同点なら先の候補");
  // 認識エンジンが数字・記号で書いても、本文どおりに言えていれば 100%（data/scripts.json の文）
  eq(ss(["Aqui está a taxa de serviço de 10% é opcional"], "Aqui está. A taxa de serviço de dez por cento é opcional.").percent, 100, "10% → dez por cento");
  eq(ss(["Até o meio-dia o seu quarto é o 504, no 5º andar"], "Até o meio-dia. O seu quarto é o quinhentos e quatro, no quinto andar.").percent, 100, "504・5º");
  eq(ss(["R$ 60. No Pix tem 10% de desconto"], "Sessenta reais. No Pix, tem dez por cento de desconto.").percent, 100, "R$ 60・10%");
  eq(ss(["deu 38°"], "Deu trinta e oito graus.").percent, 100, "38° → trinta e oito graus");
  const e = ss([], "Oi, tudo bem?");
  eq([e.percent, e.heard, e.alignment.tokens.every((t) => t.grade === "missing")], [0, "", true], "候補なし → 0%・全部 missing");
  eq(ss(["oi"], "").percent, 0, "正解が空 → 0%");
  eq(ss(["tudo bem"], ["Oi, tudo bem?", "Tudo bem?"]).percent, 100, "正解が複数なら合う方");
  eq(speechPercent({ tokens: [], correct: 0, partial: 0, total: 0 }), 0, "speechPercent: 語が無ければ 0");
  const c = ss(["eu gosto de chá"], "Eu gosto de café.");
  eq(
    answerView(c.alignment).map((t) => [t.text, t.kind, t.got ?? null]),
    [["Eu", "exact", null], ["gosto", "exact", null], ["de", "exact", null], ["café", "wrong", "chá"]],
    "表示（answerView）: 違って聞こえた語には聞こえた形"
  );
}

console.log("=== 音声認識の採点（実データ） ===");
{
  // 全語: 見出しの各表記を言えば（アクセントを落としても・大文字と句点つきでも）exact
  let bad = 0;
  for (const w of ALL_WORDS) {
    const answers = quizAnswers(w, true);
    for (const a of expandAlternatives(w.pt)) {
      if (!normalizeAnswer(a)) continue;
      for (const t of [a, fold(a), `${a.toUpperCase()}.`]) {
        if (scoreSpeechWord([t], answers, { isKnownForm }).grade !== "exact") bad++;
      }
    }
  }
  eq(bad, 0, `全 ${ALL_WORDS.length} 語: 見出しどおり・アクセントなし・大文字で言えば exact`);
}
{
  // シャドーイング（スクリプト・読み物）とパターンプラクティスの全文: 本文どおりなら 100%、何も無ければ 0%
  const sentences = [
    ...SCRIPTS.flatMap((s) => s.lines.map((l) => l.pt)),
    ...PASSAGES.flatMap((p) => passageToScript(p).lines.map((l) => l.pt)),
    ...patternItems(PATTERNS).map((it) => it.pt),
  ].filter((t) => wordSpans(t).length > 0);
  let bad = 0;
  for (const t of sentences) {
    for (const v of [t, fold(t), t.toUpperCase()]) {
      if (scoreSpeechSentence([v], t).percent !== 100) bad++;
    }
    if (scoreSpeechSentence([], t).percent !== 0) bad++;
  }
  ok(sentences.length > 50, `文がある（${sentences.length}文）`);
  eq(bad, 0, `全 ${sentences.length} 文: 本文どおり・アクセントなし・大文字で言えば 100%、何も無ければ 0%`);
}

// ---------------------------------------------------------------------------
console.log("=== 活用ドリル（conjugationDrill.ts） ===");
{
  /** 種つきの乱数（mulberry32） */
  const seeded = (seed: number): Rand => {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const conj = getConjugator();
  const q = (inf: string, tense: TableTense, person: TablePerson) => ({ inf, answer: conjugationForm(conj, inf, tense, person) });
  const G = (inf: string, tense: TableTense, person: TablePerson, input: string) => gradeConjugation(conj, q(inf, tense, person), input);

  // キー
  eq(drillKey("falar", "pres", 3), "falar|pres|3", "drillKey");
  eq(parseDrillKey("pôr|fut|5"), { inf: "pôr", tense: "fut", person: 5 }, "parseDrillKey");
  for (const k of ["Falar|pres|3", "falar|pres|6", "falar|pres", "fa lar|pres|3", "|pres|0", "falar|p|0", "falar|pres|3|x"]) {
    ok(!DRILL_KEY_RE.test(k) && parseDrillKey(k) === null, `不正なキー: ${k}`);
  }

  // 採点: 完全一致 → 正解、アクセントだけ → 惜しい、同じ動詞の別の形 → 不正解（どの形か）
  eq(G("falar", "pres", 3, "falamos").verdict, "correct", "falamos → 正解");
  eq(G("falar", "pres", 3, "  Nós falamos. ").verdict, "correct", "主語つき・大文字・句読点 → 正解（主語を外して採点）");
  eq(stripSubject("Você fala"), "fala", "stripSubject: 先頭の主語を外す");
  eq(stripSubject("nós"), "nós", "stripSubject: 主語だけなら外さない");
  {
    const r = G("falar", "impf", 3, "falavamos");
    eq([r.verdict, r.result.grade, r.otherForm], ["close", "accent", null], "falavamos → 惜しい（アクセント）");
    ok(!!r.result.note?.includes("á が必要"), "惜しい: 足りないアクセントを示す");
  }
  eq(G("estar", "pres", 5, "estao").verdict, "close", "estao → 惜しい（ã が必要）");
  {
    const r = G("poder", "pret", 2, "pode");
    eq([r.verdict, r.otherForm], ["wrong", "現在・ele・você"], "pôde に pode → 不正解（現在の形）");
    ok(!!r.result.note?.includes("ô が必要"), "アクセントだけが違う別の形は、アクセントも示す");
  }
  {
    const r = G("falar", "pres", 0, "fala");
    eq(r.verdict, "wrong", "falo に fala → 1文字違いでも別の人称の形なので不正解");
    ok(!!r.otherForm?.startsWith("現在・ele・você") && !!r.result.note?.startsWith("fala は 現在・ele・você"), "fala は 現在・ele・você の形と示す");
  }
  eq(G("falar", "pret", 0, "falar").otherForm, "不定詞 ／ 接続法未来・1人称単数", "不定詞をそのまま入れた → 不定詞と示す");
  eq(G("ter", "pres", 5, "tem").verdict, "wrong", "têm に tem（3単の形）→ 不正解");
  eq(G("trabalhar", "pres", 3, "trabalhamso").verdict, "close", "trabalhamos のつづりの小さな誤り（別の形ではない）→ 惜しい");
  eq(G("fazer", "pret", 0, "fis").verdict, "wrong", "短い語（fiz）は1文字違いでも不正解");
  eq(G("ir", "pres", 0, "fui").otherForm, "完了過去・eu", "vou に fui → 完了過去・eu（ser と ir の共通の形）");
  eq(G("falar", "pres", 0, "").verdict, "wrong", "空の入力 → 不正解");
  eq([verdictOf("exact"), verdictOf("accent"), verdictOf("typo"), verdictOf("wrong")], ["correct", "close", "close", "wrong"], "verdictOf");

  // 実データ: 不規則動詞の表の全動詞 × 4時制 × 4人称で、正解の形をそのまま入れると正解・主語つきでも正解
  {
    const all = toQuestions(conj, drillCandidates(irregularVerbs(), TABLE_TENSES, TABLE_PERSONS));
    let bad = 0;
    for (const x of all) {
      if (!x.answer || gradeConjugation(conj, x, x.answer).verdict !== "correct") bad++;
      else if (gradeConjugation(conj, x, `eu ${x.answer}`).verdict !== "correct") bad++;
    }
    eq([all.length, bad], [irregularVerbs().length * 16, 0], `不規則動詞 ${irregularVerbs().length}語 × 16形: 正解の形は正解と採点`);
  }

  // 候補と出題の選び方
  const cands = drillCandidates(["falar", "ser", "falar"], ["pres", "pret"], [0, 3]);
  eq(cands.map((c) => c.key), ["falar|pres|0", "falar|pres|3", "falar|pret|0", "falar|pret|3", "ser|pres|0", "ser|pres|3", "ser|pret|0", "ser|pret|3"], "drillCandidates: 動詞の重複を除いた全組");
  eq([drillWeight(undefined), drillWeight({ seen: 4, correct: 4, last: "2026-09-24" }), drillWeight({ seen: 4, correct: 0, last: "2026-09-24" }), drillWeight({ seen: 4, correct: 2, last: "2026-09-24" })], [3, 1, 5, 3], "drillWeight: 未出題 3・全問正解 1・全問不正解 5");
  eq(spreadVerbs([{ inf: "a" }, { inf: "a" }, { inf: "b" }]).map((x) => x.inf), ["a", "b", "a"], "spreadVerbs: 同じ動詞を続けない");
  eq(spreadVerbs([{ inf: "a" }, { inf: "a" }]).map((x) => x.inf), ["a", "a"], "spreadVerbs: 残りが同じ動詞だけなら続く");
  // 末尾に同じ動詞が2問残る並び（貪欲に前から選ぶと続いてしまう）
  eq(
    spreadVerbs([{ inf: "falar" }, { inf: "ser" }, { inf: "ter" }, { inf: "ter" }]).map((x) => x.inf),
    ["falar", "ter", "ser", "ter"],
    "spreadVerbs: 末尾の同じ動詞2問も離す（元の順はできるだけ保つ）"
  );
  eq(spreadVerbs([{ inf: "b" }, { inf: "c" }, { inf: "d" }]).map((x) => x.inf), ["b", "c", "d"], "spreadVerbs: 続かない並びはそのまま");
  {
    // 小さな並びの総当たり: 続かない並べ方があるなら、spreadVerbs も続かない（無いときも続く回数は最少）
    const adj = (xs: readonly { inf: string }[]) => xs.reduce((n, x, i) => n + (i > 0 && xs[i - 1].inf === x.inf ? 1 : 0), 0);
    const perms = <T,>(xs: readonly T[]): T[][] =>
      xs.length <= 1 ? [[...xs]] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
    const rnd = seeded(7);
    let miss = 0;
    for (let t = 0; t < 300; t++) {
      const len = 2 + Math.floor(rnd() * 6);
      const xs = Array.from({ length: len }, () => ({ inf: "abc"[Math.floor(rnd() * 3)] }));
      const best = Math.min(...perms(xs).map(adj));
      if (adj(spreadVerbs(xs)) > best) miss++;
    }
    eq(miss, 0, "spreadVerbs（300通りの総当たり）: 続かない並べ方があるときは続かない・無いときも最少");
  }
  {
    const pool = drillCandidates(irregularVerbs(), ["pres", "pret"], [...TABLE_PERSONS]);
    let adjacent = 0;
    let dup = 0;
    let cap = 0;
    let size = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      const d = pickDrill(pool, {}, 10, seeded(seed));
      if (d.length !== 10) size++;
      if (new Set(d.map((x) => x.key)).size !== d.length) dup++;
      for (let i = 1; i < d.length; i++) if (d[i].inf === d[i - 1].inf) adjacent++;
      const per = new Map<string, number>();
      for (const x of d) per.set(x.inf, (per.get(x.inf) ?? 0) + 1);
      if ([...per.values()].some((n) => n > 2)) cap++;
    }
    eq([size, dup, adjacent, cap], [0, 0, 0, 0], "pickDrill（2000通り）: 10問・同じ形なし・同じ動詞が続かない・1つの動詞は2問まで");
    // 動詞が3つで6問なら、どの動詞もちょうど2問（1つの動詞に偏らない）
    const small = drillCandidates(["falar", "ser", "comer"], ["pres", "pret"], [...TABLE_PERSONS]);
    let uneven = 0;
    let smallAdj = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const per = new Map<string, number>();
      const d = pickDrill(small, {}, 6, seeded(seed));
      for (const x of d) per.set(x.inf, (per.get(x.inf) ?? 0) + 1);
      if (per.size !== 3 || [...per.values()].some((n) => n !== 2)) uneven++;
      for (let i = 1; i < d.length; i++) if (d[i].inf === d[i - 1].inf) smallAdj++;
    }
    eq([uneven, smallAdj], [0, 0], "pickDrill（600通り）: 動詞3つ・6問 → どの動詞も2問ずつ・同じ動詞が続かない");
    const few = pickDrill(drillCandidates(["falar"], ["pres", "pret"], [...TABLE_PERSONS]), {}, 5, seeded(3));
    eq([few.length, new Set(few.map((x) => x.key)).size], [5, 5], "pickDrill: 動詞が1つだけなら上限を外して埋める");
    eq(pickDrill(pool, {}, 0, seeded(1)).length, 0, "pickDrill: 0問");
    eq(pickDrill(cands, {}, 99, seeded(1)).length, cands.length, "pickDrill: 候補の数まで");
  }
  {
    // 成績の重み: 間違えている形 > まだ出していない形 > 正解している形 の順に選ばれやすい
    const three = drillCandidates(["falar"], ["pres"], [0, 2, 3]);
    const stats: DrillStats = {
      "falar|pres|0": { seen: 5, correct: 0, last: "2026-09-24" },
      "falar|pres|3": { seen: 5, correct: 5, last: "2026-09-24" },
    };
    const count: Record<string, number> = {};
    for (let seed = 1; seed <= 600; seed++) {
      const k = pickDrill(three, stats, 1, seeded(seed))[0].key;
      count[k] = (count[k] ?? 0) + 1;
    }
    const [weak, fresh, known] = [count["falar|pres|0"] ?? 0, count["falar|pres|2"] ?? 0, count["falar|pres|3"] ?? 0];
    ok(weak > fresh && fresh > known && known > 0, `pickDrill: 苦手 ${weak} > 未出題 ${fresh} > 正解済み ${known}（600通り。正解済みも出る）`);
  }

  // 1回のドリルの列（最初に正解できなかった問題は最後にもう一度だけ）
  const qs = toQuestions(conj, drillCandidates(["falar", "ser"], ["pres"], [0]));
  const q0 = newConjQueue(qs);
  const before = JSON.stringify(q0);
  const q1 = answerEntry(q0, 0, "wrong", "fala");
  eq([q1.length, q1[2]?.q.key, q1[2]?.retry, q1[0].verdict, q1[0].input], [3, "falar|pres|0", true, "wrong", "fala"], "不正解 → 最後にもう一度");
  eq(JSON.stringify(q0), before, "answerEntry: 元の列を書き換えない");
  const q2 = answerEntry(q1, 1, "close", "sóu");
  eq(q2.length, 4, "惜しい → 最後にもう一度");
  const q3 = answerEntry(q2, 2, "wrong", "");
  eq(q3.length, 4, "もう一度の出題でまた不正解でも足さない");
  eq(answerEntry(q3, 2, "correct", "falo"), q3, "答えた問題にもう一度結果を付けても変えない");
  const q4 = answerEntry(q3, 3, "correct", "sou");
  eq(summarizeConj(q4), { first: { correct: 0, close: 1, wrong: 1 }, retry: { correct: 1, close: 0, wrong: 1 }, planned: 2, answered: 2 }, "summarizeConj");
  eq(answerEntry(newConjQueue(qs), 0, "correct", "falo").length, 2, "正解 → 足さない");
  eq(summarizeConj(newConjQueue(qs)), { first: { correct: 0, close: 0, wrong: 0 }, retry: { correct: 0, close: 0, wrong: 0 }, planned: 2, answered: 0 }, "summarizeConj: まだ答えていない");

  // 成績
  eq(recordStat(undefined, true, "2026-09-24"), { seen: 1, correct: 1, last: "2026-09-24" }, "recordStat: 初めて・正解");
  eq(recordStat({ seen: 3, correct: 1, last: "2026-09-20" }, false, "2026-09-24"), { seen: 4, correct: 1, last: "2026-09-24" }, "recordStat: 不正解は seen だけ");
  eq(
    weakKeys(
      {
        a: { seen: 4, correct: 1, last: "2026-09-24" },
        b: { seen: 2, correct: 0, last: "2026-09-24" },
        c: { seen: 1, correct: 0, last: "2026-09-24" },
        d: { seen: 3, correct: 3, last: "2026-09-24" },
        e: { seen: 4, correct: 0, last: "2026-09-24" },
      },
      3
    ).map((x) => x.key),
    ["e", "b", "a"],
    "weakKeys: 2回以上出して間違えた形を、正答率の低い順（同じなら回数の多い順）"
  );
  ok(Object.keys(irregularTable()).length === irregularVerbs().length, "不規則動詞の一覧は表と同じ数");
}

// ---------------------------------------------------------------------------
// 音声認識（speechInput.ts）を偽の認識エンジンで動かす。どの終わり方でも認識エンジンを止めること
console.log("=== speechInput（偽の認識エンジン） ===");
{
  type Alt = [string, number?];
  class FakeRec implements RecognizerLike {
    static all: FakeRec[] = [];
    static startError: unknown = null;
    lang = "";
    interimResults = false;
    maxAlternatives = 1;
    continuous = true;
    onresult: ((e: RecEvent) => void) | null = null;
    onerror: ((e: RecErrorEvent) => void) | null = null;
    onend: (() => void) | null = null;
    onaudiostart: (() => void) | null = null;
    started = false;
    stops = 0;
    aborts = 0;
    constructor() {
      FakeRec.all.push(this);
    }
    start() {
      if (FakeRec.startError) throw FakeRec.startError;
      this.started = true;
    }
    stop() {
      this.stops++;
    }
    abort() {
      this.aborts++;
    }
    /** 結果を送る（結果ごとに候補の一覧と、確定したか） */
    say(...results: { alts: Alt[]; final: boolean }[]) {
      const list = results.map((r) => Object.assign(r.alts.map(([t, c]) => ({ transcript: t, confidence: c ?? 0 })), { isFinal: r.final }));
      this.onresult?.({ resultIndex: 0, results: list });
    }
    fail(code: string) {
      this.onerror?.({ error: code });
    }
    end() {
      this.onend?.();
    }
    /** マイクの音を取り始めた（権限の確認の後） */
    audioStart() {
      this.onaudiostart?.();
    }
  }
  const last = () => FakeRec.all[FakeRec.all.length - 1];
  const log: string[] = [];
  let online = true;
  const mk = (ctor: RecognizerCtor | null = FakeRec) =>
    createWebSpeechInput({ getCtor: () => ctor, isOnline: () => online, cancelAudio: () => log.push("cancelAudio") });
  const kindOf = async (p: Promise<unknown>): Promise<string> => {
    try {
      await p;
      return "resolved";
    } catch (e) {
      return e instanceof SpeechInputError ? e.kind : "other";
    }
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // 非対応
  const none = mk(null);
  ok(!none.isSupported(), "認識エンジンが無ければ isSupported=false");
  eq(await kindOf(none.listen()), "unsupported", "非対応 → unsupported");
  ok(!speechInput.isSupported(), "既定の speechInput: Node（window なし）では非対応");
  eq(await kindOf(speechInput.listen()), "unsupported", "既定の speechInput: 非対応 → unsupported");

  // オフライン: 認識エンジンを作らず、読み上げも止めない
  online = false;
  const before = FakeRec.all.length;
  eq(await kindOf(mk().listen()), "offline", "オフライン → offline（聞く前に）");
  eq([FakeRec.all.length, log.length], [before, 0], "オフライン: 認識エンジンを作らない・読み上げも止めない");
  online = true;

  // ふつうの流れ
  const P = mk();
  ok(P.isSupported() && !P.isListening(), "対応・聞いていない");
  const interims: string[] = [];
  const p1 = P.listen({ onInterim: (t) => interims.push(t) });
  const r1 = last();
  ok(r1.started, "start は listen の中で同期に呼ぶ（タップの処理の中）");
  eq([r1.lang, r1.interimResults, r1.maxAlternatives, r1.continuous], ["pt-BR", true, 5, false], "pt-BR・途中経過あり・候補5・1回だけ");
  eq(log, ["cancelAudio"], "聞く前に読み上げを止める（読み上げの声を拾わない）");
  ok(P.isListening(), "聞き取り中");
  r1.say({ alts: [["eu  gos"]], final: false });
  r1.say({ alts: [["Eu gosto", 0.9], ["eu gosto"], [" "], ["Eu gosto"]], final: true });
  eq(await p1, { transcripts: ["Eu gosto", "eu gosto"], confidence: 0.9 }, "確定: 候補（空・重複を除く）と確からしさ");
  eq(interims, ["eu gos"], "途中経過（空白を整える）");
  ok(r1.aborts >= 1 && !P.isListening(), "結果の後も認識エンジンを止める（マイクを閉じる）");
  ok(r1.onresult === null && r1.onerror === null && r1.onend === null, "終わったらハンドラを外す（後から来た知らせは無視）");
  const p1b = P.listen({ lang: "ja-JP", maxAlternatives: 2 });
  eq([last().lang, last().maxAlternatives], ["ja-JP", 2], "lang・maxAlternatives を渡せる");
  last().say({ alts: [["oi", 0]], final: true });
  eq(await p1b, { transcripts: ["oi"] }, "確からしさが 0 なら入れない");

  // 失敗の種類
  const codes: [string, SpeechErrorKind][] = [
    ["not-allowed", "not-allowed"],
    ["service-not-allowed", "not-allowed"],
    ["audio-capture", "audio-capture"],
    ["network", "network"],
    ["language-not-supported", "language"],
    ["bad-grammar", "unknown"],
    ["no-speech", "no-speech"],
    ["aborted", "aborted"],
  ];
  for (const [code, kind] of codes) {
    const p = P.listen();
    const r = last();
    r.fail(code);
    eq(await kindOf(p), kind, `error ${code} → ${kind}`);
    ok(r.aborts >= 1 && !P.isListening(), `error ${code}: 認識エンジンを止める`);
  }
  {
    const p = P.listen();
    online = false;
    last().fail("network");
    eq(await kindOf(p), "offline", "聞いている間にオフライン → network ではなく offline");
    online = true;
  }
  {
    const p = P.listen();
    const r = last();
    r.say({ alts: [["obrigado"]], final: false });
    r.fail("no-speech");
    eq(await p, { transcripts: ["obrigado"] }, "途中まで聞き取れていれば no-speech でもその分を結果に");
  }

  // 確定しないまま終わった
  {
    const p = P.listen();
    const r = last();
    r.say({ alts: [["tudo bem"]], final: false });
    r.end();
    eq(await p, { transcripts: ["tudo bem"] }, "確定せずに終わった → 途中経過を結果に");
    ok(r.aborts >= 1, "終わった後も abort（念のため）");
    const q = P.listen();
    last().end();
    eq(await kindOf(q), "no-speech", "何も聞き取れずに終わった → no-speech");
  }
  {
    // 確定していない結果が残っているうちは待つ
    const p = P.listen();
    const r = last();
    r.say({ alts: [["eu"]], final: true }, { alts: [["gos"]], final: false });
    ok(P.isListening(), "一部だけ確定 → まだ待つ");
    r.say({ alts: [["eu gosto"]], final: true }, { alts: [["de café"]], final: true });
    eq(await p, { transcripts: ["eu gosto de café"] }, "複数の結果が確定 → つないだ1件");
  }

  // 時間切れ（マイクの音を取り始めてから数える）
  {
    const p = P.listen({ timeoutMs: 20 });
    const r = last();
    r.audioStart();
    eq(await kindOf(p), "no-speech", "時間切れ（何も無い）→ no-speech");
    ok(r.aborts >= 1 && !P.isListening(), "時間切れでも認識エンジンを止める");
    ok(r.onaudiostart === null, "終わったら audiostart のハンドラも外す");
    const q = P.listen({ timeoutMs: 20 });
    last().audioStart();
    last().say({ alts: [["bom dia"]], final: false });
    eq(await q, { transcripts: ["bom dia"] }, "時間切れ（途中経過あり）→ 途中経過を結果に");
    // マイクの許可を待つ間（audiostart の前）は時間切れにしない
    const w = P.listen({ timeoutMs: 20 });
    const rw = last();
    await sleep(80);
    ok(P.isListening() && rw.aborts === 0, "audiostart の前は timeoutMs を過ぎても待つ（マイクの許可の表示）");
    rw.audioStart();
    const t0 = Date.now();
    eq(await kindOf(w), "no-speech", "audiostart から timeoutMs で時間切れ");
    ok(Date.now() - t0 < 1000, `audiostart で上限を timeoutMs に置き直す（${Date.now() - t0}ms）`);
    ok(START_GRACE_MS >= 10000, `許可を待つ猶予（${START_GRACE_MS}ms）`);
    ok(LISTEN_TIMEOUT_MS >= 5000 && LISTEN_TIMEOUT_MS <= 10000, `既定の上限は約8秒（${LISTEN_TIMEOUT_MS}ms）`);
  }

  // 文の聞き取りの上限: 長い文は語数に合わせて延ばす（短い文は既定のまま）
  {
    eq(sentenceListenTimeoutMs("Oi, tudo bem?"), LISTEN_TIMEOUT_MS, "短い文 → 既定の上限");
    eq(sentenceListenTimeoutMs(""), LISTEN_TIMEOUT_MS, "空 → 既定の上限");
    const long = "São, sim. O gunga é o mais grave, o médio fica no meio e a viola é a mais aguda.";
    eq(sentenceListenTimeoutMs(long), 20 * SENTENCE_MS_PER_WORD + SENTENCE_LEAD_MS, "20語の文 → 語数に合わせて延ばす");
    ok(sentenceListenTimeoutMs(long) >= 15000, `20語の文は15秒以上（${sentenceListenTimeoutMs(long)}ms）`);
    eq(sentenceListenTimeoutMs(["Oi", long]), sentenceListenTimeoutMs(long), "正解が複数なら、いちばん長い文に合わせる");
  }

  // 取りやめ（signal・cancel）
  {
    const ac = new AbortController();
    const p = P.listen({ signal: ac.signal });
    const r = last();
    ac.abort();
    eq(await kindOf(p), "aborted", "signal の abort → aborted");
    ok(r.aborts >= 1 && !P.isListening(), "signal の abort: 認識エンジンを止める");
    const n = FakeRec.all.length;
    eq(await kindOf(P.listen({ signal: ac.signal })), "aborted", "abort 済みの signal → aborted");
    eq(FakeRec.all.length, n, "abort 済みの signal: 認識エンジンを作らない");
    const q = P.listen();
    const rq = last();
    P.cancel();
    eq(await kindOf(q), "aborted", "cancel() → aborted");
    ok(rq.aborts >= 1, "cancel(): 認識エンジンを止める");
    P.cancel();
    P.stop();
    ok(!P.isListening(), "聞いていないときの cancel()・stop() は何もしない");
  }

  // 早めに終える（stop）
  {
    const p = P.listen();
    const r = last();
    r.say({ alts: [["tudo"]], final: false });
    P.stop();
    eq(r.stops, 1, "stop(): 認識エンジンの stop を呼ぶ（聞き取れた分で確定させる）");
    ok(P.isListening(), "stop() の後も、確定を待つ");
    r.say({ alts: [["tudo bem"]], final: true });
    eq(await p, { transcripts: ["tudo bem"] }, "stop() の後の確定で解決");
    const q = P.listen();
    const rq = last();
    rq.say({ alts: [["valeu"]], final: false });
    P.stop();
    const t0 = Date.now();
    eq(await q, { transcripts: ["valeu"] }, "stop() の後に何も来なければ、途中経過で終える");
    const waited = Date.now() - t0;
    ok(waited >= STOP_GRACE_MS - 50 && waited < STOP_GRACE_MS + 1000 && rq.aborts >= 1, `待つのは STOP_GRACE_MS（${STOP_GRACE_MS}ms）まで（${waited}ms）・認識エンジンを止める`);
  }

  // 同時に1つだけ
  {
    const pa = P.listen();
    const ra = last();
    log.length = 0;
    const pb = P.listen();
    const rb = last();
    eq(await kindOf(pa), "aborted", "次の listen で前の聞き取りは aborted");
    ok(ra.aborts >= 1 && rb.started && rb !== ra, "前の認識エンジンを止めてから、新しく始める");
    eq(log, ["cancelAudio"], "新しい聞き取りの前にも読み上げを止める");
    rb.say({ alts: [["sim"]], final: true });
    eq(await pb, { transcripts: ["sim"] }, "新しい聞き取りはふつうに終わる");
  }

  // 始められない
  {
    FakeRec.startError = Object.assign(new Error("x"), { name: "NotAllowedError" });
    const p = P.listen();
    const r = last();
    eq(await kindOf(p), "not-allowed", "start の NotAllowedError → not-allowed");
    ok(r.aborts >= 1 && !P.isListening(), "start に失敗しても abort して片付ける");
    FakeRec.startError = Object.assign(new Error("x"), { name: "InvalidStateError" });
    eq(await kindOf(P.listen()), "unknown", "start のほかの例外 → unknown");
    FakeRec.startError = null;
    class Broken {
      constructor() {
        throw new Error("no");
      }
    }
    eq(await kindOf(mk(Broken as unknown as RecognizerCtor).listen()), "unsupported", "認識エンジンを作れない → unsupported");
  }
  await sleep(0);

  // 失敗の種類と案内
  eq(classifySpeechError("network", false), "offline", "classifySpeechError: オフラインの network → offline");
  eq(classifySpeechError("network"), "network", "classifySpeechError: 既定はオンライン");
  const kinds: SpeechErrorKind[] = ["not-allowed", "no-speech", "network", "offline", "audio-capture", "aborted", "unsupported", "language", "unknown"];
  const msgs = kinds.map(speechErrorMessage);
  ok(msgs.every((m) => m.length > 10) && new Set(msgs).size === kinds.length, "speechErrorMessage: 種類ごとに違う案内");
  ok(/権限/.test(speechErrorMessage("not-allowed")) && /Android/.test(speechErrorMessage("not-allowed")), "not-allowed: Android の権限の案内");
  ok(/オフライン/.test(speechErrorMessage("offline")), "offline: オフラインの案内");
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
