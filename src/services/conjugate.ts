// ============================================================================
// 動詞の活用生成（前方生成）
// - 規則動詞 -ar/-er/-ir（正書法変化 c→qu, g→gu, ç→c / c→ç, g→j, gu→g を含む）
// - 語幹母音交替・-ear/-iar・-uir/-air/-oer などのクラス
// - 不規則動詞は data/verb-irregular.json のスロット上書き（大過去・接続法過去/未来は完了過去3複から派生）
// 歌詞の単語から原形を推定するとき、候補の不定詞をここで活用して一致を検証する。
// ============================================================================

export type Tense =
  | "pres"
  | "pret"
  | "impf"
  | "mqp"
  | "fut"
  | "cond"
  | "sbjPres"
  | "sbjImpf"
  | "sbjFut"
  | "imp"
  | "infPers";
export type FormKind = Tense | "ger" | "pp" | "inf";

/** p: 人称 0-5（1単〜3複）。過去分詞では 0=男単,1=女単,2=男複,3=女複 */
export interface VerbTag {
  t: FormKind;
  p?: number;
}

type Slots = (string | null)[];

export interface IrregularEntry {
  /** 派生元の動詞（manter → ter など、接頭辞付きの派生） */
  like?: string;
  /** 語尾から活用類が分からない場合（pôr → er） */
  cls?: "ar" | "er" | "ir";
  pres?: Slots;
  pret?: Slots;
  impf?: Slots;
  /** 未来・過去未来の語幹（far → farei / faria） */
  fut?: string;
  sbjPres?: Slots;
  mqp?: Slots;
  sbjImpf?: Slots;
  sbjFut?: Slots;
  imp?: Slots;
  infPers?: Slots;
  ger?: string;
  pp?: string | string[];
}
export type IrregularTable = Record<string, IrregularEntry>;

type Six = string[];
/** 1つの動詞の全活用（各時制は人称 0-5 の6つ。命令の1単など存在しない形は null。活用表・活用ドリルでも使う） */
export interface Paradigm {
  pres: Six;
  pret: Six;
  impf: Six;
  mqp: Six;
  fut: Six;
  cond: Six;
  sbjPres: Six;
  sbjImpf: Six;
  sbjFut: Six;
  imp: (string | null)[];
  infPers: Six;
  ger: string;
  pp: string[];
  inf: string;
}

const TENSES: Tense[] = ["pres", "pret", "impf", "mqp", "fut", "cond", "sbjPres", "sbjImpf", "sbjFut", "imp", "infPers"];

const END = {
  ar: {
    pres: ["o", "as", "a", "amos", "ais", "am"],
    pret: ["ei", "aste", "ou", "amos", "astes", "aram"],
    impf: ["ava", "avas", "ava", "ávamos", "áveis", "avam"],
    sbjPres: ["e", "es", "e", "emos", "eis", "em"],
    vos: "ai",
    ger: "ando",
    pp: "ado",
    accent: "á",
  },
  er: {
    pres: ["o", "es", "e", "emos", "eis", "em"],
    pret: ["i", "este", "eu", "emos", "estes", "eram"],
    impf: ["ia", "ias", "ia", "íamos", "íeis", "iam"],
    sbjPres: ["a", "as", "a", "amos", "ais", "am"],
    vos: "ei",
    ger: "endo",
    pp: "ido",
    accent: "ê",
  },
  ir: {
    pres: ["o", "es", "e", "imos", "is", "em"],
    pret: ["i", "iste", "iu", "imos", "istes", "iram"],
    impf: ["ia", "ias", "ia", "íamos", "íeis", "iam"],
    sbjPres: ["a", "as", "a", "amos", "ais", "am"],
    vos: "i",
    ger: "indo",
    pp: "ido",
    accent: "í",
  },
} as const;

/** -uir / -air / -oer は母音接続でアクセントが付くため語尾表を丸ごと持つ（語幹 = 不定詞 - 3文字） */
const CLASS_END: Record<"uir" | "air" | "oer", Omit<Paradigm, "imp" | "inf" | "pp" | "ger"> & { ger: string; pp: string }> = {
  uir: {
    pres: ["uo", "uis", "ui", "uímos", "uís", "uem"],
    pret: ["uí", "uíste", "uiu", "uímos", "uístes", "uíram"],
    impf: ["uía", "uías", "uía", "uíamos", "uíeis", "uíam"],
    mqp: ["uíra", "uíras", "uíra", "uíramos", "uíreis", "uíram"],
    fut: ["uirei", "uirás", "uirá", "uiremos", "uireis", "uirão"],
    cond: ["uiria", "uirias", "uiria", "uiríamos", "uiríeis", "uiriam"],
    sbjPres: ["ua", "uas", "ua", "uamos", "uais", "uam"],
    sbjImpf: ["uísse", "uísses", "uísse", "uíssemos", "uísseis", "uíssem"],
    sbjFut: ["uir", "uíres", "uir", "uirmos", "uirdes", "uírem"],
    infPers: ["uir", "uíres", "uir", "uirmos", "uirdes", "uírem"],
    ger: "uindo",
    pp: "uído",
  },
  air: {
    pres: ["aio", "ais", "ai", "aímos", "aís", "aem"],
    pret: ["aí", "aíste", "aiu", "aímos", "aístes", "aíram"],
    impf: ["aía", "aías", "aía", "aíamos", "aíeis", "aíam"],
    mqp: ["aíra", "aíras", "aíra", "aíramos", "aíreis", "aíram"],
    fut: ["airei", "airás", "airá", "airemos", "aireis", "airão"],
    cond: ["airia", "airias", "airia", "airíamos", "airíeis", "airiam"],
    sbjPres: ["aia", "aias", "aia", "aiamos", "aiais", "aiam"],
    sbjImpf: ["aísse", "aísses", "aísse", "aíssemos", "aísseis", "aíssem"],
    sbjFut: ["air", "aíres", "air", "airmos", "airdes", "aírem"],
    infPers: ["air", "aíres", "air", "airmos", "airdes", "aírem"],
    ger: "aindo",
    pp: "aído",
  },
  oer: {
    pres: ["oo", "óis", "ói", "oemos", "oeis", "oem"],
    pret: ["oí", "oeste", "oeu", "oemos", "oestes", "oeram"],
    impf: ["oía", "oías", "oía", "oíamos", "oíeis", "oíam"],
    mqp: ["oera", "oeras", "oera", "oêramos", "oêreis", "oeram"],
    fut: ["oerei", "oerás", "oerá", "oeremos", "oereis", "oerão"],
    cond: ["oeria", "oerias", "oeria", "oeríamos", "oeríeis", "oeriam"],
    sbjPres: ["oa", "oas", "oa", "oamos", "oais", "oam"],
    sbjImpf: ["oesse", "oesses", "oesse", "oêssemos", "oêsseis", "oessem"],
    sbjFut: ["oer", "oeres", "oer", "oermos", "oerdes", "oerem"],
    infPers: ["oer", "oeres", "oer", "oermos", "oerdes", "oerem"],
    ger: "oendo",
    pp: "oído",
  },
};

/** 1単現在・接続法現在で語幹の e→i（sentir → sinto / sinta） */
const E_I = new Set([
  "sentir", "consentir", "pressentir", "ressentir", "mentir", "desmentir", "servir", "vestir", "despir", "repetir",
  "competir", "preferir", "referir", "transferir", "conferir", "inferir", "interferir", "ferir", "sugerir", "digerir",
  "divertir", "advertir", "converter", "investir", "seguir", "conseguir", "perseguir", "prosseguir", "refletir",
  "aderir", "convergir", "divergir", "inserir", "ingerir", "gerir",
]);
/** 1単現在・接続法現在で語幹の o→u（dormir → durmo） */
const O_U = new Set(["dormir", "cobrir", "descobrir", "encobrir", "recobrir", "tossir", "engolir"]);
/** 2単/3単/3複現在で語幹の u→o（subir → sobe） */
const U_O = new Set(["subir", "fugir", "sacudir", "consumir", "cuspir", "acudir", "sumir", "bulir", "entupir"]);
/** -iar で ei が入る動詞（odiar → odeio） */
const IAR_EI = new Set(["odiar", "ansiar", "mediar", "remediar", "incendiar", "intermediar"]);
/**
 * 母音の後の i/u に強勢が来る形（現在・接続法現在の1単/2単/3単/3複）で鋭アクセント
 * （proibir → proíbo / proíbe、reunir → reúno、saudar → saúdo）
 */
const HIATUS = new Set(["proibir", "coibir", "reunir", "saudar", "enraizar", "ajuizar", "faiscar", "amiudar", "esmiuçar"]);
/** 強勢のある形すべてで e→i（agredir → agrido / agride / agrida、prevenir → previno） */
const E_I_ALL = new Set(["agredir", "progredir", "transgredir", "prevenir", "denegrir"]);
// E_I に紛れた -er 動詞は対象外にする
E_I.delete("converter");

/** 不規則な過去分詞（replace=規則形は存在しない / それ以外は規則形と併存） */
const IRREG_PP: Record<string, { forms: string[]; replace?: boolean }> = {
  abrir: { forms: ["aberto"], replace: true },
  reabrir: { forms: ["reaberto"], replace: true },
  cobrir: { forms: ["coberto"], replace: true },
  descobrir: { forms: ["descoberto"], replace: true },
  escrever: { forms: ["escrito"], replace: true },
  descrever: { forms: ["descrito"], replace: true },
  inscrever: { forms: ["inscrito"], replace: true },
  pagar: { forms: ["pago"] },
  gastar: { forms: ["gasto"] },
  ganhar: { forms: ["ganho"] },
  aceitar: { forms: ["aceito"] },
  salvar: { forms: ["salvo"] },
  entregar: { forms: ["entregue"] },
  morrer: { forms: ["morto"] },
  matar: { forms: ["morto"] },
  acender: { forms: ["aceso"] },
  prender: { forms: ["preso"] },
  soltar: { forms: ["solto"] },
  limpar: { forms: ["limpo"] },
  eleger: { forms: ["eleito"] },
  imprimir: { forms: ["impresso"] },
  suspender: { forms: ["suspenso"] },
  expulsar: { forms: ["expulso"] },
  benzer: { forms: ["bento"] },
};

export function irregularParticipleVerbs(): string[] {
  return Object.keys(IRREG_PP);
}

const STRONG_ACC: Record<string, string> = { a: "á", e: "é", i: "í", o: "ô", u: "ú" };

/** 完了過去3複（fizeram）から 大過去・接続法過去・接続法未来 を作る */
function fromPret3pl(p3pl: string, acc: Record<string, string>) {
  const st = p3pl.endsWith("ram") ? p3pl.slice(0, -3) : p3pl;
  const last = st.slice(-1);
  const a = st.slice(0, -1) + (acc[last] ?? last);
  return {
    mqp: [st + "ra", st + "ras", st + "ra", a + "ramos", a + "reis", st + "ram"],
    sbjImpf: [st + "sse", st + "sses", st + "sse", a + "ssemos", a + "sseis", st + "ssem"],
    sbjFut: [st + "r", st + "res", st + "r", st + "rmos", st + "rdes", st + "rem"],
  };
}

function futFrom(stem: string) {
  return {
    fut: [stem + "ei", stem + "ás", stem + "á", stem + "emos", stem + "eis", stem + "ão"],
    cond: [stem + "ia", stem + "ias", stem + "ia", stem + "íamos", stem + "íeis", stem + "iam"],
  };
}

/** -ar: e の前で c→qu, g→gu, ç→c */
function frontSoft(stem: string): string {
  if (stem.endsWith("ç")) return stem.slice(0, -1) + "c";
  if (stem.endsWith("c")) return stem.slice(0, -1) + "qu";
  if (stem.endsWith("g")) return stem + "u";
  return stem;
}
/** -er/-ir: a/o の前で c→ç, g→j, gu→g, qu→c */
function backSoft(stem: string): string {
  if (stem.endsWith("gu")) return stem.slice(0, -1);
  if (stem.endsWith("qu")) return stem.slice(0, -2) + "c";
  if (stem.endsWith("c")) return stem.slice(0, -1) + "ç";
  if (stem.endsWith("g")) return stem.slice(0, -1) + "j";
  return stem;
}
/** 語幹の中で、母音の直後にある最後の i/u に鋭アクセントを付ける（proib → proíb、saud → saúd） */
function accentHiatus(stem: string): string {
  for (let i = stem.length - 1; i > 0; i--) {
    const ch = stem[i];
    if ((ch === "i" || ch === "u") && /[aeiou]/.test(stem[i - 1])) {
      return stem.slice(0, i) + (ch === "i" ? "í" : "ú") + stem.slice(i + 1);
    }
  }
  return stem;
}
/** 語幹の最後の母音 from を to に */
function swapLastVowel(stem: string, from: string, to: string): string {
  const i = stem.lastIndexOf(from);
  return i < 0 ? stem : stem.slice(0, i) + to + stem.slice(i + 1);
}

type VerbClass = "ar" | "er" | "ir" | "uir" | "air" | "oer";

export function verbClassOf(inf: string): VerbClass | null {
  if (/[^gq]uir$/.test(inf)) return "uir";
  if (inf.endsWith("air")) return "air";
  if (inf.endsWith("oer")) return "oer";
  if (inf.endsWith("ar")) return "ar";
  if (inf.endsWith("er")) return "er";
  if (inf.endsWith("ir")) return "ir";
  return null;
}

/** 規則変化の逆解析では扱わず、前方生成の索引で扱う動詞か */
export function isSpecialVerb(inf: string, table: IrregularTable): boolean {
  if (table[inf]) return true;
  const c = verbClassOf(inf);
  if (c === "uir" || c === "air" || c === "oer") return true;
  if (c === "ar" && (inf.endsWith("ear") || IAR_EI.has(inf))) return true;
  if (/uzir$/.test(inf)) return true; // produzir → produz
  return E_I.has(inf) || O_U.has(inf) || U_O.has(inf) || E_I_ALL.has(inf) || HIATUS.has(inf);
}

function inflectPp(pp: string): string[] {
  if (pp.endsWith("o")) return [pp, pp.slice(0, -1) + "a", pp + "s", pp.slice(0, -1) + "as"];
  return [pp, pp, pp + "s", pp + "s"];
}

function regularParadigm(inf: string): Paradigm {
  const vc = verbClassOf(inf) ?? "er";
  if (vc === "uir" || vc === "air" || vc === "oer") {
    const stem = inf.slice(0, -3);
    const e = CLASS_END[vc];
    const map = (a: readonly string[]) => a.map((x) => stem + x);
    const pres = map(e.pres);
    const sbjPres = map(e.sbjPres);
    return {
      pres,
      pret: map(e.pret),
      impf: map(e.impf),
      mqp: map(e.mqp),
      fut: map(e.fut),
      cond: map(e.cond),
      sbjPres,
      sbjImpf: map(e.sbjImpf),
      sbjFut: map(e.sbjFut),
      infPers: map(e.infPers),
      imp: [null, pres[2], sbjPres[2], sbjPres[3], null, sbjPres[5]],
      ger: stem + e.ger,
      pp: [stem + e.pp],
      inf,
    };
  }

  const cls = vc;
  const stem = inf.slice(0, -2);
  const E = END[cls];
  const pres = E.pres.map((x) => stem + x);
  const pret = E.pret.map((x) => stem + x);
  let sbjStem = stem;

  if (cls === "ar") {
    const f = frontSoft(stem);
    pret[0] = f + "ei";
    sbjStem = f;
  } else {
    let s1 = stem;
    if (E_I.has(inf)) s1 = swapLastVowel(stem, "e", "i");
    if (O_U.has(inf)) s1 = swapLastVowel(stem, "o", "u");
    s1 = backSoft(s1);
    pres[0] = s1 + "o";
    sbjStem = s1;
  }
  const sbjPres = E.sbjPres.map((x) => sbjStem + x);

  if (E_I_ALL.has(inf)) {
    const s2 = swapLastVowel(stem, "e", "i");
    ([0, 1, 2, 5] as const).forEach((i) => (pres[i] = s2 + E.pres[i]));
    for (let i = 0; i < 6; i++) sbjPres[i] = s2 + E.sbjPres[i];
  }
  // -uzir: 3単現在は語尾なし（produzir → produz）
  if (cls === "ir" && inf.endsWith("uzir")) pres[2] = stem;

  if (U_O.has(inf)) {
    const s2 = swapLastVowel(stem, "u", "o");
    pres[1] = s2 + "es";
    pres[2] = s2 + "e";
    pres[5] = s2 + "em";
  }
  // 母音の後の i/u に強勢（proibir → proíbo / proíba、saudar → saúdo / saúde）
  if (HIATUS.has(inf)) {
    const s2 = accentHiatus(stem);
    const sb = accentHiatus(sbjStem);
    ([0, 1, 2, 5] as const).forEach((i) => {
      pres[i] = s2 + E.pres[i];
      sbjPres[i] = sb + E.sbjPres[i];
    });
  }
  // -ear（passear → passeio）/ -iar の一部（odiar → odeio）: 強勢のある形で ei
  const eiStem = cls === "ar" && stem.endsWith("e") ? stem + "i" : IAR_EI.has(inf) ? stem.slice(0, -1) + "ei" : null;
  if (eiStem) {
    ([0, 1, 2, 5] as const).forEach((i) => {
      pres[i] = eiStem + E.pres[i];
      sbjPres[i] = eiStem + E.sbjPres[i];
    });
  }

  const { fut, cond } = futFrom(inf);
  const derived = fromPret3pl(pret[5], { ...STRONG_ACC, e: E.accent === "ê" ? "ê" : "é" });
  const irregPp = IRREG_PP[inf];
  const regPp = stem + E.pp;
  const pp = irregPp ? (irregPp.replace ? irregPp.forms : [regPp, ...irregPp.forms]) : [regPp];

  return {
    pres,
    pret,
    impf: E.impf.map((x) => stem + x),
    mqp: derived.mqp,
    fut,
    cond,
    sbjPres,
    sbjImpf: derived.sbjImpf,
    sbjFut: derived.sbjFut,
    infPers: [inf, inf + "es", inf, inf + "mos", inf + "des", inf + "em"],
    imp: [null, pres[2], sbjPres[2], sbjPres[3], stem + E.vos, sbjPres[5]],
    ger: stem + E.ger,
    pp,
    inf,
  };
}

function applySlots(base: string[], slots?: Slots): string[] {
  if (!slots) return base;
  return base.map((f, i) => slots[i] ?? f);
}

function irregularParadigm(inf: string, e: IrregularEntry): Paradigm {
  const cls = e.cls ?? (verbClassOf(inf) as VerbClass);
  const base = regularParadigm(e.cls ? inf.slice(0, -2) + e.cls : inf);
  const p: Paradigm = { ...base, inf };
  p.pres = applySlots(base.pres, e.pres);
  p.pret = applySlots(base.pret, e.pret);
  p.impf = applySlots(base.impf, e.impf);
  if (e.fut) Object.assign(p, futFrom(e.fut));

  if (e.sbjPres) p.sbjPres = applySlots(base.sbjPres, e.sbjPres);
  else if (e.pres?.[0] && e.pres[0].endsWith("o")) {
    const st = e.pres[0].slice(0, -1);
    const ends = cls === "ar" ? END.ar.sbjPres : END.er.sbjPres;
    p.sbjPres = ends.map((x) => st + x);
  }
  if (e.pret) {
    const d = fromPret3pl(p.pret[5], STRONG_ACC);
    p.mqp = d.mqp;
    p.sbjImpf = d.sbjImpf;
    p.sbjFut = d.sbjFut;
  }
  if (e.mqp) p.mqp = applySlots(p.mqp, e.mqp);
  if (e.sbjImpf) p.sbjImpf = applySlots(p.sbjImpf, e.sbjImpf);
  if (e.sbjFut) p.sbjFut = applySlots(p.sbjFut, e.sbjFut);
  if (e.infPers) p.infPers = applySlots(p.infPers, e.infPers);
  const imp: (string | null)[] = [null, p.pres[2], p.sbjPres[2], p.sbjPres[3], base.imp[4], p.sbjPres[5]];
  p.imp = e.imp ? imp.map((f, i) => e.imp![i] ?? f) : imp;
  if (e.ger) p.ger = e.ger;
  if (e.pp) p.pp = Array.isArray(e.pp) ? e.pp : [e.pp];
  return p;
}

/** 接頭辞派生（manter ← ter）。ter/vir 由来の tem/tens/vem/vens は mantém のように鋭アクセント、pôr → compor */
function derivedParadigm(inf: string, baseInf: string, baseP: Paradigm): Paradigm {
  const prefix = inf.slice(0, inf.length - baseInf.normalize("NFC").length);
  const fix = (f: string | null): string | null => {
    if (f == null) return f;
    if (f === "pôr") return prefix + "por";
    if ((baseInf === "ter" || baseInf === "vir") && /^(tem|tens|vem|vens)$/.test(f)) {
      return prefix + f.replace("e", "é");
    }
    return prefix + f;
  };
  const out = { inf } as Paradigm;
  for (const t of TENSES) (out as unknown as Record<string, (string | null)[]>)[t] = baseP[t].map(fix);
  out.ger = fix(baseP.ger)!;
  out.pp = baseP.pp.map((f) => fix(f)!);
  return out;
}

export class Conjugator {
  private cache = new Map<string, Map<string, VerbTag[]>>();
  constructor(private table: IrregularTable) {}

  paradigm(inf: string, depth = 0): Paradigm {
    const e = this.table[inf];
    if (e?.like && depth < 3) {
      const baseInf = e.like;
      const baseKey = baseInf === "pôr" ? "por" : baseInf; // compor ← pôr（派生語は無アクセント）
      if (inf.endsWith(baseKey)) return derivedParadigm(inf, baseKey, this.paradigm(baseInf, depth + 1));
    }
    if (e && !e.like) return irregularParadigm(inf, e);
    return regularParadigm(inf);
  }

  /** 活用形 → タグ一覧（メモ化） */
  conjugate(inf: string): Map<string, VerbTag[]> {
    const hit = this.cache.get(inf);
    if (hit) return hit;
    const p = this.paradigm(inf);
    const m = new Map<string, VerbTag[]>();
    const add = (form: string | null | undefined, tag: VerbTag) => {
      if (!form) return;
      const list = m.get(form);
      if (list) list.push(tag);
      else m.set(form, [tag]);
    };
    add(inf, { t: "inf" });
    for (const t of TENSES) p[t].forEach((f, i) => add(f, { t, p: i }));
    add(p.ger, { t: "ger" });
    for (const pp of p.pp) inflectPp(pp).forEach((f, i) => add(f, { t: "pp", p: i }));
    this.cache.set(inf, m);
    return m;
  }
}

// ---------------------------------------------------------------------------
// 規則動詞の逆解析用: 語尾（タグ付き）一覧。ダミー語幹で活用させて語尾を取り出す
// ---------------------------------------------------------------------------
const DUMMY = "\u0001\u0001";
let suffixCache: { cls: "ar" | "er" | "ir"; suffix: string }[] | null = null;

export function regularSuffixes(): { cls: "ar" | "er" | "ir"; suffix: string }[] {
  if (suffixCache) return suffixCache;
  const seen = new Set<string>();
  const out: { cls: "ar" | "er" | "ir"; suffix: string }[] = [];
  const conj = new Conjugator({});
  for (const cls of ["ar", "er", "ir"] as const) {
    for (const form of conj.conjugate(DUMMY + cls).keys()) {
      if (!form.startsWith(DUMMY)) continue;
      const suffix = form.slice(DUMMY.length);
      const k = cls + "|" + suffix;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ cls, suffix });
    }
  }
  out.sort((a, b) => b.suffix.length - a.suffix.length);
  suffixCache = out;
  return out;
}

// ---------------------------------------------------------------------------
// 活用の説明文
// ---------------------------------------------------------------------------
/** 時制・形の日本語名（活用表・活用ドリルでも使う） */
export const TENSE_JA: Record<FormKind, string> = {
  inf: "不定詞",
  pres: "直説法現在",
  pret: "完了過去",
  impf: "不完了過去",
  mqp: "大過去",
  fut: "未来",
  cond: "過去未来",
  sbjPres: "接続法現在",
  sbjImpf: "接続法過去",
  sbjFut: "接続法未来",
  imp: "命令",
  infPers: "人称不定詞",
  ger: "現在分詞",
  pp: "過去分詞",
};
const TENSE_ORDER: FormKind[] = ["inf", "pres", "pret", "impf", "fut", "cond", "sbjPres", "sbjImpf", "sbjFut", "imp", "ger", "pp", "mqp", "infPers"];
const PP_JA = ["", "女性形", "男性複数形", "女性複数形"];

function personLabel(ps: number[]): string {
  const sg = [...new Set(ps.filter((p) => p < 3))].sort().map((p) => p + 1);
  const pl = [...new Set(ps.filter((p) => p >= 3))].sort().map((p) => p - 2);
  const parts: string[] = [];
  if (sg.length) parts.push(`${sg.join("・")}人称単数`);
  if (pl.length) parts.push(`${pl.join("・")}人称複数`);
  return parts.join("/");
}

export function describeVerbTags(lemma: string, tags: VerbTag[]): string {
  const byT = new Map<FormKind, number[]>();
  for (const tag of tags) {
    const l = byT.get(tag.t) ?? [];
    if (tag.p != null) l.push(tag.p);
    byT.set(tag.t, l);
  }
  const groups = TENSE_ORDER.filter((t) => byT.has(t)).slice(0, 2);
  const labels = groups.map((t) => {
    const ps = byT.get(t)!;
    if (t === "pp") {
      const g = PP_JA[Math.min(...ps)] ?? "";
      return g ? `${TENSE_JA[t]}（${g}）` : TENSE_JA[t];
    }
    return ps.length ? `${TENSE_JA[t]}・${personLabel(ps)}` : TENSE_JA[t];
  });
  return `${lemma} の${labels.join(" ／ ")}`;
}
