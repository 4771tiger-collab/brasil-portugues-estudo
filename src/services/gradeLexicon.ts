// ============================================================================
// 採点用の辞書（grade.ts に注入する。初めて使うときに組み立てる）
// - isKnownForm(s): s が実在する語形か。アクセント違い・つづり違いの入力が「別の実在語」なら
//   惜しい（accent/typo）ではなく不正解にするために使う（avó/avô、esta/está、e/é …）
// - acceptedPtForJa(word): 和→葡の入力式で、同じ意味の別見出しも正解にする
// - quizAnswers(word, byJa): クイズの入力式モードで gradeWord に渡す正解の集合
// 組み立て方は純関数（buildKnownForms / buildJaMatcher）にして、scripts/check-grade から固定データで検証する。
// ============================================================================

import { ALL_WORDS, DICT_RAW } from "../data/loadWords";
import type { Word } from "../data/types";
import { headKeys } from "../data/headKey";
import { expandAlternatives, normalizeAnswer } from "./grade";
import { isProperNoun } from "./quizChoices";

const DELETED_POS = "_deleted";

/**
 * 組み込みの最小対（アクセント記号だけで別の語になる組）。辞書に見出しが無い活用形も入れておく。
 * 「só」だけは相手の「so」が語として存在しないので入れない（so と打ったら「ó が必要」の accent になる）。
 */
export const BUILTIN_KNOWN_FORMS: readonly string[] = [
  "é", "e",
  "está", "esta",
  "avó", "avô",
  "pôr", "por",
  "pôde", "pode",
  "nós", "nos",
  "têm", "tem",
  "vêm", "vem",
  "país", "pais",
  "dá", "da",
  "dê", "de",
  "à", "a",
  "às", "as",
  "só",
];

/**
 * 見出し（"meu/minha"・"fim de semana" など）から実在する語形の集合を作る（純関数）。
 * headKeys で表記ゆれを分け、normalizeAnswer した見出し全体と、その各語（空白区切り）を入れる。
 */
export function buildKnownForms(pts: Iterable<string>, builtin: readonly string[] = BUILTIN_KNOWN_FORMS): Set<string> {
  const out = new Set<string>();
  const add = (s: string) => {
    const n = normalizeAnswer(s);
    if (!n) return;
    out.add(n);
    for (const part of n.split(" ")) if (part) out.add(part);
  };
  for (const pt of pts) for (const k of headKeys(pt)) add(k);
  for (const b of builtin) add(b);
  return out;
}

type JaEntry = Pick<Word, "id" | "pt" | "ja" | "pos" | "source">;

/** カタカナどうしをつなぐ「・」（カポエイラの人名・用語。quizChoices.quizPieces と同じ扱い） */
const KANA_JOIN_RE = /(?<=[\p{Script=Katakana}ー])・(?=\p{Script=Katakana})/gu;
const JOIN_MARK = "\u0000";

/**
 * 和訳の「意味の片」: 括弧の外にある・、／/ で分けた各部分。括弧の注記は片に残す
 * （"〜である（本質的・恒久的）" は1片。ser と estar、ouvir と escutar のように注記で区別する語を混同しない）。
 * 比較用に NFKC・空白除去・先頭の〜・末尾の句読点を除く。カポエイラ語のカタカナ間の「・」では分けない。
 */
export function meaningPieces(w: Pick<Word, "ja" | "source">): string[] {
  const s = w.source === "capoeira" ? w.ja.normalize("NFC").replace(KANA_JOIN_RE, JOIN_MARK) : w.ja.normalize("NFC");
  const out: string[] = [];
  const push = (raw: string) => {
    const t = raw
      .split(JOIN_MARK)
      .join("・")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .replace(/^[〜~]+|[?!。.]+$/g, "");
    if (t && !out.includes(t)) out.push(t);
  };
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "（" || ch === "(") depth++;
    else if ((ch === "）" || ch === ")") && depth > 0) depth--;
    if (depth === 0 && /[・、／/]/.test(ch)) {
      push(cur);
      cur = "";
    } else cur += ch;
  }
  push(cur);
  return out;
}

/**
 * 「和訳が同じ別見出し」を引く関数を作る（純関数）。
 * 問いの語の意味の片（meaningPieces）を「すべて」含む別の語を、同じ意味の答えとして認める
 * （例: 月 → lua と mês、〜だけ → só）。固有名詞と削除済みの語は使わない。
 * 表記ゆれ "a/b" の数と訳の片の数が同じ語は、表記と片を順に対応させ、問いの片に当たる表記だけを認める。
 * 返すのは展開済みの表記（expandAlternatives）で、問いの語自身の表記と同じものは除く。
 */
export function buildJaMatcher(words: readonly JaEntry[]): (w: JaEntry) => string[] {
  const entries = words.filter((w) => w.pos !== DELETED_POS && !isProperNoun(w));
  const byPiece = new Map<string, number[]>();
  entries.forEach((w, i) => {
    for (const p of meaningPieces(w)) {
      const list = byPiece.get(p);
      if (list) list.push(i);
      else byPiece.set(p, [i]);
    }
  });
  return (w) => {
    const pieces = meaningPieces(w);
    if (!pieces.length) return [];
    // 片ごとの候補の積集合（いちばん少ない片から絞る）
    const lists = pieces.map((p) => byPiece.get(p) ?? []);
    lists.sort((a, b) => a.length - b.length);
    let cand = new Set(lists[0]);
    for (const l of lists.slice(1)) {
      const s = new Set(l);
      cand = new Set([...cand].filter((i) => s.has(i)));
    }
    const own = new Set(expandAlternatives(w.pt).map(normalizeAnswer));
    const out: string[] = [];
    const seen = new Set<string>();
    for (const i of [...cand].sort((a, b) => a - b)) {
      const e = entries[i];
      if (e.id === w.id) continue;
      const alts = expandAlternatives(e.pt);
      const ep = meaningPieces(e);
      // "a/b" の訳が "x・y" と1対1（namorado/namorada = 彼氏・彼女、filho/filha = 息子・娘）なら、
      // 問いの意味の片に当たる表記だけ（彼女 → namorada。namorado は彼氏なので正解にしない）
      const use = alts.length > 1 && alts.length === ep.length ? alts.filter((_, k) => pieces.includes(ep[k])) : alts;
      for (const alt of use) {
        const k = normalizeAnswer(alt);
        if (!k || own.has(k) || seen.has(k)) continue;
        seen.add(k);
        out.push(alt);
      }
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// 実データ（ALL_WORDS と dict-words.json）で遅延構築
// ---------------------------------------------------------------------------

let knownForms: Set<string> | null = null;
let jaMatcher: ((w: JaEntry) => string[]) | null = null;

function knownSet(): Set<string> {
  if (!knownForms) {
    const pts: string[] = ALL_WORDS.map((w) => w.pt);
    for (const r of DICT_RAW) if (r.品詞 !== DELETED_POS) pts.push(r.ポルトガル語);
    knownForms = buildKnownForms(pts);
  }
  return knownForms;
}

/** s（normalizeAnswer で比べる）が単語帳・辞書の見出しの語形、または組み込みの最小対か */
export function isKnownForm(s: string): boolean {
  return knownSet().has(normalizeAnswer(s));
}

/** 和→葡の入力式で、問いの語と同じ意味の別見出しの表記（単語帳 ALL_WORDS から） */
export function acceptedPtForJa(word: JaEntry): string[] {
  if (!jaMatcher) jaMatcher = buildJaMatcher(ALL_WORDS);
  return jaMatcher(word);
}

/** 見出し自身の表記: "a/b" の各表記と、読み上げの形（"Obrigado, Obrigada" と続けて打っても正解） */
export function ownAnswers(word: Pick<Word, "pt" | "ptForSpeech">): string[] {
  return [...expandAlternatives(word.pt), word.ptForSpeech];
}

/**
 * 入力式クイズの正解の集合（gradeWord に渡す）。
 * byJa（和訳を見て答える問題）のときは、和訳が同じ別見出しも正解にする。
 * 聴き取り（聞こえた語を書く問題）は見出し自身の表記だけ。
 */
export function quizAnswers(word: JaEntry & Pick<Word, "ptForSpeech">, byJa: boolean): string[] {
  return byJa ? [...ownAnswers(word), ...acceptedPtForJa(word)] : ownAnswers(word);
}

/** s が見出し自身の表記か（同じ意味の別見出しで採点したときの注記に使う） */
export function isOwnAnswer(word: Pick<Word, "pt" | "ptForSpeech">, s: string): boolean {
  const k = normalizeAnswer(s);
  return ownAnswers(word).some((a) => normalizeAnswer(a) === k);
}
