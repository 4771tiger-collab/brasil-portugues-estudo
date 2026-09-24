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
  type Alignment,
  type DiffSeg,
  type Grade,
  type GradeOptions,
  wordSpans,
} from "../src/services/grade";
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
import { DICTATIONS } from "../src/data/content";
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

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
