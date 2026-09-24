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

  // --- lh / ch / x ---
  ["filho", "フィリュ", "fiʎu"],
  ["trabalho", "トラバリュ", "tɾabaʎu"],
  ["olho", "オリュ", "oʎu"],
  ["chuva", "シュヴァ", "ʃuva"],
  ["xícara", "シカラ", "ʃikaɾa"],

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

  // --- 母音+m/n の鼻音コーダ ---
  ["bom", "ボン", "bõ"],
  ["um", "ウン", "ũ"],
  ["mundo", "ムンドゥ", "mũdu"],
  ["sempre", "センプリ", "sẽpɾi"],

  // --- 複数語・記号 ---
  ["Bom dia", "ボン ジア", "bõ dʒia"],
  ["Bom dia!", "ボン ジア!", "bõ dʒia"],
];

// B2-15 で修正予定: 未修正の規則(tch / 語頭 ex+母音 / 語末 -em・-ens・-am / 鼻音記号の二重化)に
// かかる語。いまの出力をそのまま固定している。規則を直したら正しい値に書き換えて RULES へ移す。
const PENDING_B2_15: Row[] = [
  ["tchau", "トシャウ", "tʃau"], // B2-15 で修正予定（正: チャウ）
  ["exemplo", "エシェンプル", "eʃẽplu"], // B2-15 で修正予定（正: エゼンプル /ezẽplu/）
  ["bem", "ベン", "bẽ"], // B2-15 で修正予定（正: ベイン /bẽj/。アプリでは上書き辞書で補正済み）
  ["ontem", "オンテン", "õtẽ"], // B2-15 で修正予定（正: オンテイン /õtẽj/）
  ["ninguém", "ニンゲン", "nĩɡɛ̃"], // B2-15 で修正予定（正: ニンゲイン /nĩɡẽj/）
  ["homens", "オメンス", "omẽs"], // B2-15 で修正予定（正: オメインス /omẽjs/）
  ["falam", "ファラン", "falã"], // B2-15 で修正予定（正: ファラウン /falɐ̃w/）
  ["manhã", "マニャン", "maɲɐ̃̃"], // B2-15 で修正予定（IPA の鼻音記号が二重。正: /maɲɐ̃/）
  ["mãe", "マイン", "mɐ̃j̃"], // B2-15 で修正予定（IPA の鼻音記号の付け方）
  ["pão", "パウン", "pɐ̃w̃"], // B2-15 で修正予定（IPA の鼻音記号の付け方）
  ["coração", "コラサウン", "koɾasɐ̃w̃"], // B2-15 で修正予定（IPA の鼻音記号の付け方）
];

let fail = 0;
let pass = 0;
// エンジンは鼻音を「母音+結合文字 U+0303」で出すため、NFC にそろえて比べる（õ と o+̃ を同一視）。
// 二重の鼻音記号(ɐ̃̃)は NFC でも一つにならないので、B2-15 の不具合は見逃さない。
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

console.log("=== B2-15 で修正予定の語（現状の出力を固定） ===");
checkRows(PENDING_B2_15);

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
