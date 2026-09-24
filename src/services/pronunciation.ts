// ============================================================================
// ブラジルポルトガル語(pt-BR) → カタカナ / IPA 近似変換エンジン（学習補助用）
//
// 「読みの手がかり」を目的としたルールベース実装（厳密な音声学的正確性は目的外）。
// 主要規則:
//   - 語末の弱化(無強勢): o→u(ウ), e→i(イ)  ※アクセント付きは除外(café, avô)
//   - 口蓋化(BR): ti→チ(tʃi), di→ジ(dʒi)（語末弱化でiになった場合も）
//   - 鼻母音: ã/õ, 母音+m/n(コーダ)→ン。鼻二重音 ão→アウン, ãe→アイン, õe→オイン
//   - 語末/音節末の l → 母音化 w(ウ)  (Brasil→ブラジウ, sal→サウ)
//   - r: 語頭・rr・n/l/s後→強いr(/h/ハ行) / 母音間→弾き音(/ɾ/ラ行) / 語末→脱落
//   - s: 母音間→有声化 z(ザ行)
//   - ch→ʃ, lh→ʎ, nh→ɲ(直前の母音は鼻音コーダにしない), qu/gu(+e,i,ê)→k/g(u黙字。-quência は kw), ç→s
//   - c/g(+e,i,ê)→s/ʒ（você→ヴォセ, gênero→ジェネル）
// 不規則・借用語は overrides(pronunciation-overrides.json)で個別補正可能。
// ============================================================================

type Cons =
  | "k" | "g" | "s" | "z" | "t" | "d" | "tʃ" | "dʒ" | "n" | "h"
  | "b" | "p" | "m" | "ɾ" | "l" | "v" | "f" | "ʃ" | "ʒ" | "ʎ" | "ɲ";

type BaseVowel = "a" | "e" | "i" | "o" | "u";

const KANA: Record<Cons, Record<BaseVowel, string>> = {
  k: { a: "カ", e: "ケ", i: "キ", o: "コ", u: "ク" },
  g: { a: "ガ", e: "ゲ", i: "ギ", o: "ゴ", u: "グ" },
  s: { a: "サ", e: "セ", i: "シ", o: "ソ", u: "ス" },
  z: { a: "ザ", e: "ゼ", i: "ジ", o: "ゾ", u: "ズ" },
  t: { a: "タ", e: "テ", i: "チ", o: "ト", u: "トゥ" },
  d: { a: "ダ", e: "デ", i: "ジ", o: "ド", u: "ドゥ" },
  tʃ: { a: "チャ", e: "チェ", i: "チ", o: "チョ", u: "チュ" },
  dʒ: { a: "ジャ", e: "ジェ", i: "ジ", o: "ジョ", u: "ジュ" },
  n: { a: "ナ", e: "ネ", i: "ニ", o: "ノ", u: "ヌ" },
  h: { a: "ハ", e: "ヘ", i: "ヒ", o: "ホ", u: "フ" },
  b: { a: "バ", e: "ベ", i: "ビ", o: "ボ", u: "ブ" },
  p: { a: "パ", e: "ペ", i: "ピ", o: "ポ", u: "プ" },
  m: { a: "マ", e: "メ", i: "ミ", o: "モ", u: "ム" },
  ɾ: { a: "ラ", e: "レ", i: "リ", o: "ロ", u: "ル" },
  l: { a: "ラ", e: "レ", i: "リ", o: "ロ", u: "ル" },
  v: { a: "ヴァ", e: "ヴェ", i: "ヴィ", o: "ヴォ", u: "ヴ" },
  f: { a: "ファ", e: "フェ", i: "フィ", o: "フォ", u: "フ" },
  ʃ: { a: "シャ", e: "シェ", i: "シ", o: "ショ", u: "シュ" },
  ʒ: { a: "ジャ", e: "ジェ", i: "ジ", o: "ジョ", u: "ジュ" },
  ʎ: { a: "リャ", e: "リェ", i: "リ", o: "リョ", u: "リュ" },
  ɲ: { a: "ニャ", e: "ニェ", i: "ニ", o: "ニョ", u: "ニュ" },
};

const EPENTHESIS: Record<Cons, BaseVowel> = {
  k: "u", g: "u", s: "u", z: "u", t: "o", d: "o", tʃ: "i", dʒ: "i",
  n: "u", h: "u", b: "u", p: "u", m: "u", ɾ: "u", l: "u", v: "u",
  f: "u", ʃ: "u", ʒ: "u", ʎ: "u", ɲ: "u",
};

const CONS_IPA: Record<Cons, string> = {
  k: "k", g: "ɡ", s: "s", z: "z", t: "t", d: "d", tʃ: "tʃ", dʒ: "dʒ",
  n: "n", h: "h", b: "b", p: "p", m: "m", ɾ: "ɾ", l: "l", v: "v",
  f: "f", ʃ: "ʃ", ʒ: "ʒ", ʎ: "ʎ", ɲ: "ɲ",
};

const VOWEL_KANA: Record<BaseVowel, string> = { a: "ア", e: "エ", i: "イ", o: "オ", u: "ウ" };

type Phon =
  | { t: "c"; v: Cons }
  | { t: "v"; base: BaseVowel; ipa: string; accented?: boolean }
  | { t: "g"; g: "j" | "w" }
  | { t: "n" }; // 鼻音コーダ

const VOWEL_CHARS = "aeiouáàâãéêíóôõúüy";
const isVowelChar = (c: string) => c.length === 1 && VOWEL_CHARS.includes(c);
const VOICED = "bdgmnlrvz";
// 前舌母音(e/i 系)。c/g の軟音化(ce→セ, ge→ジェ)と qu/gu の u 黙字判定に使う。
// ê・î も含める（você→ヴォセ, conhecê→コニェセ）。
const isFront = (c: string) => c.length === 1 && "eiéíêî".includes(c);
// i 系母音。t/d の口蓋化(ti→チ, di→ジ)に使う。
const isI = (c: string) => c.length === 1 && "iíî".includes(c);
// qu/gu の u が黙字か（s[i] が q/g）。前舌母音の前では読まない(queijo→ケイジュ, quê→ケ)。
// ただし -quência 系(frequência, sequência)は u を読む（旧綴り qüência。ラテン語 -quentia 由来）。
const isSilentU = (s: string, i: number) => isFront(s[i + 2] ?? "") && !s.startsWith("ênci", i + 2);

function vowelToken(c: string): Phon {
  switch (c) {
    case "a": return { t: "v", base: "a", ipa: "a" };
    case "á": case "à": case "â": return { t: "v", base: "a", ipa: "a", accented: true };
    case "e": return { t: "v", base: "e", ipa: "e" };
    case "ê": return { t: "v", base: "e", ipa: "e", accented: true };
    case "é": return { t: "v", base: "e", ipa: "ɛ", accented: true };
    case "i": return { t: "v", base: "i", ipa: "i" };
    case "í": return { t: "v", base: "i", ipa: "i", accented: true };
    case "y": return { t: "v", base: "i", ipa: "i" };
    case "o": return { t: "v", base: "o", ipa: "o" };
    case "ô": return { t: "v", base: "o", ipa: "o", accented: true };
    case "ó": return { t: "v", base: "o", ipa: "ɔ", accented: true };
    case "u": return { t: "v", base: "u", ipa: "u" };
    case "ú": case "ü": return { t: "v", base: "u", ipa: "u", accented: true };
    default: return { t: "v", base: "a", ipa: "a" };
  }
}

function phonemize(word: string): Phon[] {
  const s = word.toLowerCase().normalize("NFC");
  const out: Phon[] = [];
  const n = s.length;
  let i = 0;

  const lastIsVowel = () => {
    for (let k = out.length - 1; k >= 0; k--) {
      if (out[k].t === "v") return true;
      if (out[k].t === "c") return false;
    }
    return false;
  };

  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1] ?? "";
    const next = c2;
    const atStart = out.length === 0;

    // --- 鼻二重音(チルダ母音) ---
    if (c === "ã") {
      if (c2 === "o") { out.push({ t: "v", base: "a", ipa: "ɐ̃" }, { t: "g", g: "w" }, { t: "n" }); i += 2; continue; }
      if (c2 === "e") { out.push({ t: "v", base: "a", ipa: "ɐ̃" }, { t: "g", g: "j" }, { t: "n" }); i += 2; continue; }
      out.push({ t: "v", base: "a", ipa: "ɐ̃", accented: true }, { t: "n" }); i++; continue;
    }
    if (c === "õ") {
      if (c2 === "e") { out.push({ t: "v", base: "o", ipa: "õ" }, { t: "g", g: "j" }, { t: "n" }); i += 2; continue; }
      out.push({ t: "v", base: "o", ipa: "õ", accented: true }, { t: "n" }); i++; continue;
    }

    // --- 二重字(子音) ---
    if (c === "c" && c2 === "h") { out.push({ t: "c", v: "ʃ" }); i += 2; continue; }
    if (c === "l" && c2 === "h") { out.push({ t: "c", v: "ʎ" }); i += 2; continue; }
    if (c === "n" && c2 === "h") { out.push({ t: "c", v: "ɲ" }); i += 2; continue; }
    if (c === "r" && c2 === "r") { out.push({ t: "c", v: "h" }); i += 2; continue; }
    if (c === "s" && c2 === "s") { out.push({ t: "c", v: "s" }); i += 2; continue; }
    if (c === "q" && c2 === "u") {
      out.push({ t: "c", v: "k" });
      if (!isSilentU(s, i)) out.push({ t: "g", g: "w" });
      i += 2; continue;
    }
    if (c === "g" && c2 === "u" && isSilentU(s, i)) {
      out.push({ t: "c", v: "g" }); i += 2; continue;
    }

    // --- 母音 ---
    if (isVowelChar(c)) {
      const after2 = s[i + 2] ?? "";
      if (
        (c2 === "m" || c2 === "n") &&
        (after2 === "" || !isVowelChar(after2)) &&
        !(c2 === "n" && after2 === "h") // nh は次の子音(ɲ)。ここで n を消費しない（minha→ミニャ）
      ) {
        // 母音 + 鼻子音コーダ
        out.push(vowelToken(c), { t: "n" });
        i += 2;
        continue;
      }
      out.push(vowelToken(c));
      i++;
      continue;
    }

    // --- 子音 ---
    let cons: Cons | null = null;
    switch (c) {
      case "b": cons = "b"; break;
      case "c": cons = isFront(next) ? "s" : "k"; break;
      case "ç": cons = "s"; break;
      case "d": cons = isI(next) ? "dʒ" : "d"; break;
      case "f": cons = "f"; break;
      case "g": cons = isFront(next) ? "ʒ" : "g"; break;
      case "h": i++; continue;
      case "j": cons = "ʒ"; break;
      case "k": cons = "k"; break;
      case "l":
        if (!isVowelChar(next)) { out.push({ t: "g", g: "w" }); i++; continue; } // 音節末l→母音化
        cons = "l"; break;
      case "m": cons = "m"; break;
      case "n": cons = "n"; break;
      case "p": cons = "p"; break;
      case "q": cons = "k"; break;
      case "r": {
        const prev = s[i - 1] ?? "";
        if (atStart || prev === "l" || prev === "n" || prev === "s") cons = "h";
        else if (!isVowelChar(next)) {
          if (i === n - 1) { i++; continue; } // 語末r→脱落
          cons = "ɾ";
        } else cons = "ɾ";
        break;
      }
      case "s": {
        if (lastIsVowel() && isVowelChar(next)) cons = "z";
        else if (next !== "" && !isVowelChar(next) && VOICED.includes(next)) cons = "z";
        else cons = "s";
        break;
      }
      case "t": cons = isI(next) ? "tʃ" : "t"; break;
      case "v": cons = "v"; break;
      case "w": out.push({ t: "g", g: "w" }); i++; continue;
      case "x": cons = "ʃ"; break;
      case "z": cons = isVowelChar(next) ? "z" : "s"; break;
      default: i++; continue;
    }
    out.push({ t: "c", v: cons });
    i++;
  }

  reduceFinal(out, s);
  return out;
}

/**
 * 語末無強勢母音の弱化(o→u, e→i) と t/d 口蓋化を後処理で適用。
 * ポルトガル語の強勢規則: 母音(a/e/o)終わりは penult 強勢→語末母音は無強勢で弱化。
 * 子音終わり(r/l/z/m...)はオキシトン(語末強勢)なので弱化しない。
 * → 元の綴りが e/o (+s) で終わる時のみ弱化を適用する。
 */
function reduceFinal(phons: Phon[], word: string): void {
  if (!/[eo]s?$/.test(word)) return;
  let vi = -1;
  for (let k = phons.length - 1; k >= 0; k--) {
    if (phons[k].t === "v") { vi = k; break; }
  }
  if (vi === -1) return;
  const after = phons[vi + 1];
  if (after && after.t === "n") return; // 鼻母音は弱化しない
  const v = phons[vi] as Extract<Phon, { t: "v" }>;
  if (v.accented) return;
  if (v.base === "o") { v.base = "u"; v.ipa = "u"; }
  else if (v.base === "e") {
    v.base = "i"; v.ipa = "i";
    const prev = phons[vi - 1];
    if (prev && prev.t === "c") {
      if (prev.v === "t") prev.v = "tʃ";
      else if (prev.v === "d") prev.v = "dʒ";
    }
  }
}

function render(phons: Phon[]): { kana: string; ipa: string } {
  let kana = "";
  let ipa = "";
  for (let i = 0; i < phons.length; i++) {
    const p = phons[i];
    if (p.t === "v") {
      kana += VOWEL_KANA[p.base];
      ipa += p.ipa;
    } else if (p.t === "n") {
      kana += "ン";
      ipa += "̃";
    } else if (p.t === "g") {
      const prev = phons[i - 1];
      const nx = phons[i + 1];
      const betweenConsAndVowel = prev && prev.t === "c" && nx && nx.t === "v";
      if (!betweenConsAndVowel) kana += p.g === "j" ? "イ" : "ウ";
      ipa += p.g === "j" ? "j" : "w";
    } else {
      const nx = phons[i + 1];
      if (nx && nx.t === "v") {
        kana += KANA[p.v][nx.base];
        ipa += CONS_IPA[p.v] + nx.ipa;
        i++; // 母音を消費
      } else {
        kana += KANA[p.v][EPENTHESIS[p.v]];
        ipa += CONS_IPA[p.v];
      }
    }
  }
  return { kana, ipa };
}

const overrides: Record<string, { kana: string; ipa: string }> = {};

export function registerOverrides(map: Record<string, { kana: string; ipa: string }>) {
  Object.assign(overrides, map);
}

function convertWord(w: string): { kana: string; ipa: string } {
  const key = w.toLowerCase().normalize("NFC");
  if (overrides[key]) return overrides[key];
  if (!/[a-záàâãéêíóôõúüçy]/i.test(w)) return { kana: w, ipa: w };
  return render(phonemize(w));
}

/** テキスト（複数語・記号含む）をカタカナ/IPAへ変換 */
export function transliterate(text: string): { kana: string; ipa: string } {
  const parts = text.split(/(\s+|[-–—/]+)/u);
  let kana = "";
  let ipa = "";
  for (const part of parts) {
    if (part === "") continue;
    if (/^\s+$/u.test(part)) { kana += " "; ipa += " "; continue; }
    if (/^[-–—/]+$/u.test(part)) { kana += "・"; ipa += " "; continue; }
    if (/[a-záàâãéêíóôõúüçyA-ZÁÀÂÃÉÊÍÓÔÕÚÜÇ]/u.test(part)) {
      const m = part.match(/^([^a-záàâãéêíóôõúüçy]*)(.*?)([^a-záàâãéêíóôõúüçy]*)$/iu);
      if (m && m[2]) {
        const r = convertWord(m[2]);
        kana += m[1] + r.kana + m[3];
        ipa += r.ipa;
      } else {
        const r = convertWord(part);
        kana += r.kana;
        ipa += r.ipa;
      }
    } else {
      kana += part;
    }
  }
  return { kana: kana.trim(), ipa: ipa.trim() };
}

export function toKana(text: string): string {
  return transliterate(text).kana;
}
export function toIpa(text: string): string {
  return "/" + transliterate(text).ipa + "/";
}
