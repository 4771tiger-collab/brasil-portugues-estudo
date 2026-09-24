// ============================================================================
// 曲の単語タブ（VocabTab）と単語シート（WordSheet）の学習状況（純関数。React・ストアに依存しない）
// - 歌詞の語ごとに、原形推定の第1候補から「行」を作る。
//     ids    = 先頭の見出しと和訳・品詞が同じ見出し（同じ意味。表示と追加の第一候補）
//     allIds = その候補の見出しすべて（単語帳・カポエイラ単語帳・辞書の同じ綴り）
// - 学習状況・「追加済み」・一括追加の除外は allIds で見る。追加するときは、学習中のカードがあればそれを使う。
//   例: berimbau は辞書とカポエイラ単語帳の両方にある。カポエイラ単語帳で学習中なら行に「学習中」と出し、
//       追加してもカポエイラ単語帳のカードを使う（辞書の見出しで2枚目のカードを作らない。バグ#15）
// loadWords（発音生成）を読み込まないので、scripts/check-srs からそのまま使える。
// ============================================================================

import type { SrsCard } from "../data/types";
import { ALIAS_KEEP } from "../data/siblings";
import { displayLevel, LEVEL_JA } from "../srs/scheduler";
import { isCovered, isGrammarWord, type Lemmatizer, type Token } from "./lemmatize";

/** id → カード（無ければ undefined）。useProgress の cards をそのまま渡せる */
export type CardLookup = Readonly<Record<string, SrsCard | undefined>>;

/** 単語タブの1行 */
export interface VocabItem {
  /** 行のキー（先頭の見出し ID。自分の単語は user:… の ID） */
  key: string;
  /** 同じ意味の見出し ID（先頭の見出しと和訳・品詞が同じもの。先頭が ids[0]） */
  ids: string[];
  /** 同じ綴りの見出しすべて（ids を含む）。学習状況・追加済み・一括追加の除外はこちらで判定する */
  allIds: string[];
  lemma: string;
  ja: string;
  pos: string;
  /** 曲の中での出現回数 */
  count: number;
  /** 最初に出てきた形（追加の記録に残す） */
  surface: string;
}

/** 辞書に無く、自分でも登録していない語 */
export interface UnknownVocab {
  token: Token;
  count: number;
}

/** 自分で意味を登録した語（useMusic の UserWord と同じ形） */
export interface UserVocab {
  id: string;
  pt: string;
  ja: string;
  pos: string;
}

/**
 * 歌詞（行ごとのトークン）から単語タブの行を作る。出現回数の多い順（同数は出てきた順）。
 * userOf: トークンのキー → 自分で登録した語（辞書で引けない語だけに使う）
 */
export function buildVocabItems(
  lem: Pick<Lemmatizer, "lookup">,
  analyzed: readonly (readonly Token[])[],
  userOf: (key: string) => UserVocab | undefined
): { items: VocabItem[]; unknown: UnknownVocab[] } {
  const m = new Map<string, VocabItem>();
  const unk = new Map<string, UnknownVocab>();
  const bump = (key: string, make: () => VocabItem) => {
    const e = m.get(key);
    if (!e) {
      m.set(key, make());
      return;
    }
    e.count++;
    // 別の形（複数形など）から来た同じ行は、見出しの一覧だけ足す（学習状況の判定がもれないように）
    const add = make().allIds.filter((id) => !e.allIds.includes(id));
    if (add.length) e.allIds = [...e.allIds, ...add];
  };
  analyzed.forEach((toks) =>
    toks.forEach((t, ti) => {
      const c = lem.lookup(t.text, { lineStart: ti === 0 }).candidates[0];
      if (!c || !isCovered(c)) {
        // 自分で意味を登録した語
        const u = userOf(t.key);
        if (u) {
          bump(u.id, () => ({ key: u.id, ids: [u.id], allIds: [u.id], lemma: u.pt, ja: u.ja, pos: u.pos, count: 1, surface: t.text }));
          return;
        }
        const x = unk.get(t.key);
        if (x) x.count++;
        else unk.set(t.key, { token: t, count: 1 });
        return;
      }
      const parts = c.parts ? c.parts.map((p) => p.top).filter((x): x is NonNullable<typeof x> => !!x) : [c];
      for (const it of parts) {
        const ref = it.refs[0];
        if (!ref || it.kind === "interjection") continue;
        bump(ref.id, () => ({
          key: ref.id,
          ids: it.refs.filter((r) => r.ja === ref.ja && r.pos === ref.pos).map((r) => r.id),
          allIds: [...new Set(it.refs.map((r) => r.id))],
          lemma: it.lemma,
          ja: ref.ja,
          pos: ref.pos,
          count: 1,
          surface: t.text,
        }));
      }
    })
  );
  return {
    items: [...m.values()].sort((a, b) => b.count - a.count),
    unknown: [...unk.values()].sort((a, b) => b.count - a.count),
  };
}

/** ids のうち最初にカードがある ID */
export function studiedId(ids: readonly string[], cards: CardLookup): string | undefined {
  return ids.find((id) => !!cards[id]);
}

/**
 * 行の学習状況を表すカードの ID。同じ意味の見出し（ids）を先に、無ければ同じ綴りの見出し（allIds）から。
 * undefined なら未学習（どの見出しにもカードが無い）。
 */
export function statusId(item: Pick<VocabItem, "ids" | "allIds">, cards: CardLookup): string | undefined {
  return studiedId(item.ids, cards) ?? studiedId(item.allIds, cards);
}

/**
 * 「＋ 追加」で使う ID。学習中のカード（statusId）があればそれ。
 * 無ければ先頭の見出し。ただし先頭が別名（word-aliases.json の alias 側）で、keep 側が同じ候補にあれば keep 側
 * （学ぶのは keep 側に揃える。alias 側にカードを作ると、keep 側はコア語でも新しい語として導入されなくなる
 *   ＝ queue.orderNew は keep/alias のどれかにカードがあれば同じ語を2枚目として導入しない）。
 */
export function addTargetId(item: Pick<VocabItem, "ids" | "allIds">, cards: CardLookup): string {
  const sid = statusId(item, cards);
  if (sid) return sid;
  const head = item.ids[0] ?? item.allIds[0];
  const keep = ALIAS_KEEP.get(head);
  return keep && item.allIds.includes(keep) ? keep : head;
}

/**
 * 「よく出る未学習語をまとめて追加」の対象（出現回数の多い順に最大 limit 語）。
 * 除くもの: どれかの見出しにカードがある語、この曲で追加済みの語（allIds のどれか）、
 * 冠詞・前置詞・接続詞・目的格/再帰の代名詞（isGrammarWord）、先に選んだ行と見出しが重なる行。
 */
export function bulkAddCandidates(
  items: readonly VocabItem[],
  cards: CardLookup,
  songIds: ReadonlySet<string>,
  limit = 10
): VocabItem[] {
  const out: VocabItem[] = [];
  const taken = new Set<string>();
  for (const w of items) {
    if (out.length >= limit) break;
    if (statusId(w, cards) || w.allIds.some((id) => songIds.has(id)) || isGrammarWord(w.pos, w.ja)) continue;
    const target = addTargetId(w, cards);
    if (taken.has(target) || w.allIds.some((id) => taken.has(id))) continue;
    out.push(w);
    taken.add(target);
    for (const id of w.allIds) taken.add(id);
  }
  return out;
}

/** カードの ID から、そのカードが入っている単語帳の呼び名 */
export function deckLabel(id: string): string {
  if (id.startsWith("capoeira:")) return "カポエイラ単語帳";
  if (id.startsWith("user:")) return "自分の単語";
  return "単語帳";
}

/** 習熟度の表示名（未評価のカードは「未学習」） */
export function levelLabel(card: SrsCard): string {
  return LEVEL_JA[displayLevel(card)];
}

/**
 * WordSheet の意味ごとのまとまり（group）に対して、同じ候補の別の見出しにあるカード。
 * group 自身の見出しにカードがあれば undefined（自分の状況は AddButton が出す）。
 */
export function siblingCard<R extends { id: string }>(
  groupIds: readonly string[],
  refs: readonly R[],
  cards: CardLookup
): { ref: R; card: SrsCard } | undefined {
  if (studiedId(groupIds, cards)) return undefined;
  // group の見出しにはカードが無いので、refs を先頭から見れば別の見出しのカードだけが当たる
  for (const r of refs) {
    const card = cards[r.id];
    if (card) return { ref: r, card };
  }
  return undefined;
}

/** 別の見出しのカードの注記（例: 「カポエイラ単語帳で学習中」） */
export function siblingNote(id: string, card: SrsCard): string {
  return `${deckLabel(id)}で${levelLabel(card)}`;
}
