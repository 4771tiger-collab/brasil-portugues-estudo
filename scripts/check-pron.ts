// ============================================================================
// 発音(カタカナ / IPA)変換の回帰テスト
//   npm run check:pron
// - 前半: 上書き辞書を登録する前の「規則だけ」の出力を検証（[ポルトガル語, カナ, IPA]）
// - 後半: pronunciation-overrides.json を登録し、上書きが効くことを確認
//   （registerOverrides は取り消せないため、必ず規則の検証の後に行う）
// 例は一般的な単語のみ（歌詞は使わない）。1件でも失敗したら終了コード1。
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { registerOverrides, toIpa, toKana, transliterate } from "../src/services/pronunciation";

const here = dirname(fileURLToPath(import.meta.url));

type Row = [pt: string, kana: string, ipa: string];

// 規則どおりの正解表。IPA は強勢記号なし・長音なしの簡略表記（エンジンの仕様）。
const RULES: Row[] = [
  // --- nh（直前の母音+n を鼻音コーダにしない。バグ#4） ---
  ["minha", "ミニャ", "miɲa"],
  ["senhor", "セニョ", "seɲo"], // 語末 r は脱落
  ["conhecer", "コニェセ", "koɲese"],
  ["vinho", "ヴィニュ", "viɲu"],
  ["banheiro", "バニェイル", "baɲeiɾu"],
  ["dinheiro", "ジニェイル", "dʒiɲeiɾu"],
  ["nenhum", "ネニュン", "neɲũ"],
  ["companhia", "コンパニア", "kõpaɲia"],
  ["sonho", "ソニュ", "soɲu"],

  // --- c/g の軟音化、qu/gu の u 黙字（ê を含む） ---
  ["conhecê", "コニェセ", "koɲese"],
  ["você", "ヴォセ", "vose"],
  ["francês", "フランセス", "fɾãses"],
  ["gênero", "ジェネル", "ʒeneɾu"],
  ["agência", "アジェンシア", "aʒẽsia"],
  ["gente", "ジェンチ", "ʒẽtʃi"],
  ["cinema", "シネマ", "sinema"],
  ["quê", "ケ", "ke"],
  ["porquê", "ポルケ", "poɾke"],
  ["português", "ポルトゥゲス", "poɾtuɡes"],
  ["queijo", "ケイジュ", "keiʒu"],
  ["guitarra", "ギタハ", "ɡitaha"],
  ["quatro", "クアトル", "kwatɾu"], // qu+a は u を読む
  ["frequência", "フレクエンシア", "fɾekwẽsia"], // -quência は u を読む

  // --- t/d の口蓋化と語末の弱化(o→u, e→i) ---
  ["cidade", "シダジ", "sidadʒi"],
  ["leite", "レイチ", "leitʃi"],
  ["noite", "ノイチ", "noitʃi"],
  ["tarde", "タルジ", "taɾdʒi"],
  ["tia", "チア", "tʃia"],
  ["dia", "ジア", "dʒia"],
  ["obrigado", "オブリガドゥ", "obɾiɡadu"],
  ["menino", "メニヌ", "meninu"],
  ["tudo", "トゥドゥ", "tudu"],
  ["café", "カフェ", "kafɛ"], // アクセント付きは弱化しない
  ["avô", "アヴォ", "avo"],

  // --- lh / ch / tch / x ---
  ["filho", "フィリュ", "fiʎu"],
  ["trabalho", "トラバリュ", "tɾabaʎu"],
  ["olho", "オリュ", "oʎu"],
  ["chuva", "シュヴァ", "ʃuva"],
  ["xícara", "シカラ", "ʃikaɾa"],
  ["tchau", "チャウ", "tʃau"], // tch→tʃ（「ト+シャ」にしない）
  ["tchê", "チェ", "tʃe"],
  ["peixe", "ペイシ", "peiʃi"], // 語中の x は ʃ のまま
  ["lixo", "リシュ", "liʃu"],

  // --- 語頭の ex+母音 → z ---
  ["exemplo", "エゼンプル", "ezẽplu"],
  ["exame", "エザミ", "ezami"],
  ["existir", "エジスチ", "ezistʃi"],
  ["êxito", "エジトゥ", "ezitu"], // アクセント付きの ê も語頭の e と同じ
  ["exu", "エシュ", "eʃu"], // 例外（固有名 Exu）

  // --- r（語頭・rr・n の後→ハ行 / 母音間→ラ行 / 語末→脱落） ---
  ["carro", "カフ", "kahu"],
  ["rio", "ヒウ", "hiu"],
  ["rua", "フア", "hua"],
  ["honra", "オンハ", "õha"],
  ["amor", "アモ", "amo"],

  // --- l の母音化、s の有声化、ç ---
  ["Brasil", "ブラジウ", "bɾaziw"],
  ["sal", "サウ", "saw"],
  ["azul", "アズウ", "azuw"],
  ["casa", "カザ", "kaza"],
  ["mesmo", "メズム", "mezmu"],
  ["praça", "プラサ", "pɾasa"],

  // --- 母音+m/n の鼻音コーダ（語中の em/am はそのまま ẽ/ã） ---
  ["bom", "ボン", "bõ"],
  ["um", "ウン", "ũ"],
  ["mundo", "ムンドゥ", "mũdu"],
  ["sempre", "センプリ", "sẽpɾi"],
  ["tempo", "テンプ", "tẽpu"],
  ["campo", "カンプ", "kãpu"],

  // --- 語末の -em/-ens（-ém/-êm/-éns）→ ẽj ---
  ["bem", "ベイン", "bẽj"], // アプリでは上書き辞書（強勢記号付き）が優先される
  ["em", "エイン", "ẽj"],
  ["ontem", "オンテイン", "õtẽj"],
  ["ninguém", "ニンゲイン", "nĩɡẽj"], // é でも ɛ̃ にしない（pt-BR に無い音）
  ["também", "タンベイン", "tãbẽj"],
  ["têm", "テイン", "tẽj"],
  ["viagem", "ヴィアジェイン", "viaʒẽj"],
  ["homens", "オメインス", "omẽjs"],
  ["parabéns", "パラベインス", "paɾabẽjs"],

  // --- 語末の -am → ɐ̃w（-ão と同じ音） ---
  ["falam", "ファラウン", "falɐ̃w"],
  ["cantam", "カンタウン", "kãtɐ̃w"],
  ["estavam", "エスタヴァウン", "estavɐ̃w"],

  // --- ã/õ と鼻二重母音（IPA の鼻音記号は母音に1つだけ。ɐ̃̃・w̃・j̃ にしない） ---
  ["manhã", "マニャン", "maɲɐ̃"],
  ["irmã", "イルマン", "iɾmɐ̃"],
  ["mãe", "マイン", "mɐ̃j"],
  ["mães", "マインス", "mɐ̃js"],
  ["pão", "パウン", "pɐ̃w"],
  ["não", "ナウン", "nɐ̃w"],
  ["coração", "コラサウン", "koɾasɐ̃w"],
  ["põe", "ポイン", "põj"], // 語末が e でも õ は弱化しない（プインにしない）
  ["corações", "コラソインス", "koɾasõjs"],
  ["milhões", "ミリョインス", "miʎõjs"],

  // --- 複数語・記号 ---
  ["Bom dia", "ボン ジア", "bõ dʒia"],
  ["Bom dia!", "ボン ジア!", "bõ dʒia"],
  ["Tudo bem", "トゥドゥ ベイン", "tudu bẽj"],
  ["por exemplo", "ポ エゼンプル", "po ezẽplu"],
  ["Eles falam bem", "エリス ファラウン ベイン", "elis falɐ̃w bẽj"],
];

let fail = 0;
let pass = 0;
// エンジンは鼻音を「母音+結合文字 U+0303」で出すため、NFC にそろえて比べる（õ と o+̃ を同一視）。
// 二重の鼻音記号(ɐ̃̃)やグライドの鼻音記号(w̃)は NFC でも消えないので、再発すれば検出できる。
function eq(actual: string, expected: string, msg: string) {
  if (actual.normalize("NFC") === expected.normalize("NFC")) pass++;
  else {
    fail++;
    console.error(`  ✗ ${msg}: 期待 ${expected}  → 実際: ${actual}`);
  }
}
function checkRows(rows: Row[]) {
  for (const [pt, kana, ipa] of rows) {
    const r = transliterate(pt);
    eq(r.kana, kana, `kana(${pt})`);
    eq(r.ipa, ipa, `ipa(${pt})`);
  }
}

console.log("=== 規則（上書き辞書なし） ===");
checkRows(RULES);

// IPA に二重の鼻音記号・グライドの鼻音記号が出ないこと（表の全行の出力で確認）
for (const [pt] of RULES) {
  const ipa = transliterate(pt).ipa.normalize("NFD");
  if (/\u0303\u0303|[wj]\u0303/u.test(ipa)) {
    fail++;
    console.error(`  ✗ 鼻音記号の重複(${pt}): ${ipa.normalize("NFC")}`);
  } else pass++;
}

console.log("=== 上書き辞書 ===");
// loadWords.ts / enrich.ts と同じ登録方法（"_" で始まるメタキーは除外）
const overridesRaw = JSON.parse(
  readFileSync(resolve(here, "../data/pronunciation-overrides.json"), "utf8"),
) as Record<string, unknown>;
const overrideMap: Record<string, { kana: string; ipa: string }> = {};
for (const [k, v] of Object.entries(overridesRaw)) {
  if (k.startsWith("_")) continue;
  if (v && typeof v === "object" && "kana" in v && "ipa" in v) {
    overrideMap[k] = v as { kana: string; ipa: string };
  }
}
registerOverrides(overrideMap);
eq(toKana("Tudo bem?"), "トゥドゥ ベイン?", "toKana(Tudo bem?)");
eq(toIpa("Tudo bem?"), "/tudu ˈbẽj/", "toIpa(Tudo bem?)");
eq(toKana("Muito obrigado"), "ムイント オブリガード", "toKana(Muito obrigado)");
eq(toKana("Você"), "ヴォセ", "toKana(Você)（大文字でも上書きが効く）");
eq(toKana("bom"), "ボン", "toKana(bom)（上書きの無い語は規則のまま）");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
