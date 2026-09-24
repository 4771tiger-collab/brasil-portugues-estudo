// ============================================================================
// SRS 学習キューの構築（復習対象・新規語の抽出、習熟度集計）
// - orderNew: 新規語の導入順（pinned → コア語 → カテゴリの巡回。カポエイラ語を割合で混ぜる）
// - buildSession: 今日の学習（復習の上限・延滞の大きい順・復習4枚ごとに新規1枚・同じ綴りは1日1枚）
// - pickForQuiz / weakWords: クイズの出題（期限到来 → 延滞比 → ease の低い順 → 最近 again）と「苦手」の範囲
// 検証: scripts/check-srs.ts（npm run check:srs）
// ============================================================================

import type { SrsCard, SrsLevel, Word } from "../data/types";
import { ALIAS_IDS, aliasPeerCarded, siblingKey } from "../data/siblings";
import { addDays, diffDays, displayLevel, todayStr } from "./scheduler";

export type CardMap = Record<string, SrsCard>;

/** 復習期限が来ているカード（id）の単語を返す（due昇順） */
export function dueWords(words: Word[], cards: CardMap, today: string = todayStr()): Word[] {
  return words
    .filter((w) => {
      const c = cards[w.id];
      return c && c.due <= today;
    })
    .sort((a, b) => cards[a.id].due.localeCompare(cards[b.id].due)); // 同じ日は元の順（安定ソート）
}

export function countDue(words: Word[], cards: CardMap, today: string = todayStr()): number {
  let n = 0;
  for (const w of words) {
    const c = cards[w.id];
    if (c && c.due <= today) n++;
  }
  return n;
}

/** 未学習(カード未生成)の語を出題順に返す */
export function newWords(words: Word[], cards: CardMap): Word[] {
  return words.filter((w) => !cards[w.id]);
}

/** 一度でも評価したことがあり、期限が来た語（＝本来の「復習」） */
export function reviewDueWords(words: Word[], cards: CardMap, today: string = todayStr()): Word[] {
  return dueWords(words, cards, today).filter((w) => cards[w.id].last !== null);
}

export function countReview(words: Word[], cards: CardMap, today: string = todayStr()): number {
  let n = 0;
  for (const w of words) {
    const c = cards[w.id];
    if (c && c.last !== null && c.due <= today) n++;
  }
  return n;
}

/** 曲から追加しただけで、まだ一度も評価していない語（addCard で作られたカード） */
export function addedNewWords(words: Word[], cards: CardMap, today: string = todayStr()): Word[] {
  return dueWords(words, cards, today).filter((w) => cards[w.id].last === null);
}

export function countAddedNew(words: Word[], cards: CardMap, today: string = todayStr()): number {
  let n = 0;
  for (const w of words) {
    const c = cards[w.id];
    if (c && c.last === null && c.due <= today) n++;
  }
  return n;
}

/** その日までに期限が来る復習の数（評価済みのカードだけ。同じ語は1回）。予報や「明日の復習」に使う */
export function countDueOn(words: Word[], cards: CardMap, date: string): number {
  const seen = new Set<string>();
  let n = 0;
  for (const w of words) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const c = cards[w.id];
    if (c && c.last !== null && c.due <= date) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 並びの道具（純関数）
// ---------------------------------------------------------------------------

/** 文字列の 53bit ハッシュ（cyrb53）。シャッフルの種に使う */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** 種から [0,1) の擬似乱数列を作る（mulberry32。種は下位 32bit を使う） */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 種つきのシャッフル（Fisher–Yates。同じ種なら同じ並び。入力は変更しない） */
export function seededShuffle<T>(a: readonly T[], seed: string): T[] {
  const out = [...a];
  const rand = mulberry32(cyrb53(seed));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 並びを散らすときのカテゴリ（ソースが違えば別のカテゴリ） */
const catKey = (w: Word) => `${w.source}:${w.category}`;

/**
 * 同じカテゴリの語を隣に置かない並べ替え（貪欲法。入力は変更しない）。
 * 基本は元の並び（シャッフル済み）のまま、直前と違うカテゴリの最初の語を取る。
 * - 今置かないと隣接が避けられなくなるカテゴリ（残りの過半）は先に置く
 * - 1つのカテゴリが多すぎて隣接が避けられないときは、同じカテゴリの連続を2語までに抑える
 */
export function spreadCategories(ws: readonly Word[]): Word[] {
  const rest = [...ws];
  const out: Word[] = [];
  const counts = new Map<string, number>();
  for (const w of rest) counts.set(catKey(w), (counts.get(catKey(w)) ?? 0) + 1);
  const firstOf = (c: string) => rest.findIndex((w) => catKey(w) === c);
  let last: string | null = null;
  let run = 0;
  while (rest.length) {
    const n = rest.length;
    let pick = -1;
    // (a) 直前のカテゴリが多すぎる（残りのほかの語で挟みきれない）→ 連続2語までなら続けて置く
    if (last !== null && run < 2) {
      const k = counts.get(last) ?? 0;
      if (k > 0 && k > 2 * (n - k)) pick = firstOf(last);
    }
    // (b) 残りの過半を占めるカテゴリ（後回しにすると隣接が避けられない）
    if (pick < 0) {
      for (const [c, k] of counts) {
        if (c !== last && k > 0 && k * 2 >= n + 1) {
          pick = firstOf(c);
          break;
        }
      }
    }
    // (c) 直前と違うカテゴリのうち、元の並びで最初の語
    if (pick < 0) pick = rest.findIndex((w) => catKey(w) !== last);
    // (d) 同じカテゴリしか残っていない
    if (pick < 0) pick = 0;
    const [w] = rest.splice(pick, 1);
    const c = catKey(w);
    counts.set(c, (counts.get(c) ?? 0) - 1);
    run = c === last ? run + 1 : 1;
    last = c;
    out.push(w);
  }
  return out;
}

/** a を every 枚ごとに b を1枚はさむ（a が尽きたら b の残りを後ろへ）。例: 復習4枚ごとに新規1枚 */
export function interleave<T>(a: readonly T[], b: readonly T[], every: number): T[] {
  const n = Math.max(1, Math.floor(every) || 1);
  const out: T[] = [];
  let j = 0;
  a.forEach((x, i) => {
    out.push(x);
    if ((i + 1) % n === 0 && j < b.length) out.push(b[j++]);
  });
  while (j < b.length) out.push(b[j++]);
  return out;
}

// ---------------------------------------------------------------------------
// 新規語の導入順（§2e）
// ---------------------------------------------------------------------------

/** 固有名詞（人名・地名・年号など）は新規語として導入しない */
const PROPER_NOUN = /固有名詞/;

export interface OrderNewOptions {
  /** 取り出す語数 */
  limit: number;
  /** カポエイラ語の割合（0〜1。設定 capoeiraShare） */
  capoeiraShare: number;
  /** コア語の ID（学ぶ順。loadWords.CORE_ORDER） */
  coreOrder: readonly string[];
  /** 「今日の学習に追加」で指定された語。最優先で、固有名詞・別名・コア外の dict でも入れる */
  pinned?: readonly string[];
  /** 候補から外す語（buildSession が同じ綴りの語を外すのに使う） */
  isExcluded?: (w: Word) => boolean;
  /** カテゴリの巡回で同時に回すカテゴリの数（既定 4） */
  width?: number;
  /** 1回の選出で同じカテゴリから取る上限（既定 4。pinned とコア語は数えない） */
  perCategoryCap?: number;
  /** セッション内の並びのシャッフルの種（既定は今日の日付。同じ日は同じ並び） */
  seed?: string;
}

/** 取り出し口: accept が通った語を1つ返す（尽きたら undefined） */
type Take = (accept: (w: Word) => boolean) => Word | undefined;

/** リストの先頭から順に取る */
function listTaker(list: readonly Word[]): Take {
  let i = 0;
  return (accept) => {
    while (i < list.length) {
      const w = list[i++];
      if (accept(w)) return w;
    }
    return undefined;
  };
}

/**
 * カテゴリの巡回。カテゴリ（ファイルでの出現順）ごとのキューを作り、未完了のカテゴリの先頭 width 個を
 * 順に回って1語ずつ取る。同じカテゴリからは1回の選出で cap 語まで（達したら次のカテゴリが窓に入る）。
 */
function roundRobinTaker(words: readonly Word[], width: number, cap: number): Take {
  const cats: { items: Word[]; pos: number; taken: number }[] = [];
  const index = new Map<string, number>();
  for (const w of words) {
    let i = index.get(w.category);
    if (i === undefined) {
      i = cats.length;
      index.set(w.category, i);
      cats.push({ items: [], pos: 0, taken: 0 });
    }
    cats[i].items.push(w);
  }
  let lastCat = -1;
  return (accept) => {
    for (;;) {
      const win: number[] = [];
      for (let i = 0; i < cats.length && win.length < width; i++) {
        const c = cats[i];
        if (c.pos < c.items.length && c.taken < cap) win.push(i);
      }
      if (!win.length) return undefined;
      // 前回のカテゴリの次から（窓の中で一巡したら先頭へ）
      const ci = win.find((i) => i > lastCat) ?? win[0];
      lastCat = ci;
      const c = cats[ci];
      while (c.pos < c.items.length) {
        const w = c.items[c.pos++];
        if (accept(w)) {
          c.taken++;
          return w;
        }
      }
      // このカテゴリは尽きた → 窓を作り直して次へ
    }
  };
}

/** 前の取り出し口が尽きたら次へ */
function chainTaker(...takers: Take[]): Take {
  return (accept) => {
    for (const t of takers) {
      const w = t(accept);
      if (w) return w;
    }
    return undefined;
  };
}

/**
 * 新規に導入する語を limit 語まで選び、セッション内の並びにして返す（純関数）。
 * 1. 候補: カード無し・固有名詞でない・別名（ALIAS_IDS）でない・words か capoeira の語
 *    （dict はコア語に入っているものだけ）。pinned は固有名詞・別名・dict でも候補にする。
 *    別名の登録でつながる語（ALIAS_PEERS）にカードがある語は、pinned でも候補にしない。
 * 2. 優先: pinned（指定順）→ コア語（coreOrder の順）→ ソースごとのカテゴリの巡回
 * 3. カポエイラ語（source=capoeira）とそれ以外を別々に取り出し、i 番目は
 *    floor((i+1)×share) がそれまでのカポエイラ語の数を超えたらカポエイラ語から取る（片方が尽きたらもう片方）
 * 4. 同じ綴りの語（兄弟グループ）は1回の選出で1語まで
 * 5. 並びは spreadCategories(seededShuffle(選んだ語, seed))
 */
export function orderNew(pool: readonly Word[], cards: CardMap, o: OrderNewOptions): Word[] {
  const limit = Math.max(0, Math.floor(o.limit) || 0);
  if (!limit) return [];
  const rawShare = Number.isFinite(o.capoeiraShare) ? Math.min(1, Math.max(0, o.capoeiraShare)) : 0;
  // 設定の 0.33 は「3語に1語」。1/3 として扱う（0.33 のままだと 3語目で floor(0.99)=0 になり、15語中4語に減る）
  const share = Math.abs(rawShare - 1 / 3) < 0.005 ? 1 / 3 : rawShare;
  const width = Math.max(1, Math.floor(o.width ?? 4) || 1);
  const cap = Math.max(1, Math.floor(o.perCategoryCap ?? 4) || 1);
  const pinned = o.pinned ?? [];
  const pinnedSet = new Set(pinned);
  const coreSet = new Set(o.coreOrder);

  // 1. 候補（同じ id は最初の1つ）
  const cand = new Map<string, Word>();
  for (const w of pool) {
    if (cand.has(w.id) || cards[w.id]) continue;
    // 別名の登録でつながる語（keep/alias）にカードがあれば、同じ語なので出さない（pinned でも）
    if (aliasPeerCarded(w.id, (x) => !!cards[x])) continue;
    if (!pinnedSet.has(w.id)) {
      if (PROPER_NOUN.test(w.pos) || ALIAS_IDS.has(w.id)) continue;
      if (w.source !== "words" && w.source !== "capoeira" && !coreSet.has(w.id)) continue;
    }
    if (o.isExcluded?.(w)) continue;
    cand.set(w.id, w);
  }

  // 同じ語・同じ綴りの語は1回だけ
  const pickedIds = new Set<string>();
  const groups = new Set<string>();
  const accept = (w: Word): boolean => {
    if (pickedIds.has(w.id)) return false;
    const g = siblingKey(w);
    if (groups.has(g)) return false;
    pickedIds.add(w.id);
    groups.add(g);
    return true;
  };

  const out: Word[] = [];
  // 2. pinned（割合に関係なく先に入れる）
  for (const id of pinned) {
    if (out.length >= limit) break;
    const w = cand.get(id);
    if (w && accept(w)) out.push(w);
  }

  // 3. コア語 → カテゴリの巡回（カポエイラ語とそれ以外で別の取り出し口）
  const isCap = (w: Word) => w.source === "capoeira";
  const core = o.coreOrder.map((id) => cand.get(id)).filter((w): w is Word => !!w);
  const rest = [...cand.values()].filter((w) => !coreSet.has(w.id) && !pinnedSet.has(w.id));
  const capQ = chainTaker(listTaker(core.filter(isCap)), roundRobinTaker(rest.filter(isCap), width, cap));
  const genQ = chainTaker(
    listTaker(core.filter((w) => !isCap(w))),
    roundRobinTaker(rest.filter((w) => !isCap(w)), width, cap)
  );

  // 4. 割合 share でカポエイラ語を差し込む（pinned の分も位置と数に含める）
  let capTaken = out.filter(isCap).length;
  for (let i = out.length; i < limit; i++) {
    const wantCap = Math.floor((i + 1) * share + 1e-9) > capTaken;
    const w = wantCap ? (capQ(accept) ?? genQ(accept)) : (genQ(accept) ?? capQ(accept));
    if (!w) break;
    if (isCap(w)) capTaken++;
    out.push(w);
  }

  // 5. セッション内の並び: 日付を種にシャッフルし、同じカテゴリが隣り合わないように散らす
  return spreadCategories(seededShuffle(out, o.seed ?? todayStr()));
}

// ---------------------------------------------------------------------------
// 今日の学習（§2e・B2-04）
// ---------------------------------------------------------------------------

/** 通常の日は、復習この枚数ごとに新しい語を1枚はさむ */
export const REVIEWS_PER_NEW = 4;

/** 相対延滞度 (延滞日数+1)÷間隔。大きいほど忘れかけている（復習を出す順） */
export function relativeOverdue(card: SrsCard, today: string = todayStr()): number {
  return (diffDays(today, card.due) + 1) / Math.max(1, card.intervalDays);
}

export interface SessionOptions {
  /** 今日の新規語の上限（設定 dailyNewLimit。「あと5語」のときは広げた値） */
  newLimit: number;
  /** 今日すでに導入した新規語の数（daily.newIntroduced） */
  introducedToday: number;
  /** 曲から追加した語の1日の上限と、今日の導入数（一般語彙の新規枠とは別） */
  addedLimit?: number;
  addedToday?: number;
  /** 「今日の学習に追加」で指定された未学習語の id（新規枠の中で最優先） */
  pinned?: readonly string[];
  today?: string;
  /** コア語の ID（loadWords.CORE_ORDER） */
  coreOrder: readonly string[];
  /** 新しい語に混ぜるカポエイラ語の割合（設定 capoeiraShare） */
  capoeiraShare: number;
  /** 1日の復習の上限（設定 dailyReviewLimit。省略時は無制限） */
  reviewLimit?: number;
  /** 今日すでに評価した期限到来の復習の数（daily.dueReviewed） */
  reviewedToday?: number;
}

export interface SessionPlan {
  /** 復習（相対延滞度の降順・今日の残りの上限まで）＋今日の再学習 */
  review: Word[];
  /** 新しい語（orderNew の並び） */
  fresh: Word[];
  /** 曲から追加した語（未評価） */
  added: Word[];
  /** 出題順: 復習4枚ごとに新規1枚、その後ろに曲の語 */
  all: Word[];
  /** 新しい語を止めた理由。backlog = 期限の来た復習が今日の残りの上限を超えている */
  reason?: "backlog";
  /** 期限の来た復習の数（上限で削る前。今日の再学習と、同じ綴りで明日に回した語は除く） */
  dueTotal: number;
}

/**
 * 本日の学習セッションを構築（純関数）。
 * - 復習: 評価済みで期限の来た語を相対延滞度の降順に並べ、今日の残りの上限（reviewLimit − reviewedToday）まで。
 *   今日 again にした語（last=今日の再学習）は上限の外で必ず出す。
 * - 期限の来た復習が残りの上限を超えている日は、新しい語を出さない（reason="backlog"）。
 * - 新しい語: orderNew（pinned → コア語 → カテゴリの巡回、カポエイラ語を割合で混ぜる）で残りの新規枠まで。
 * - 曲から追加した語: 別枠（musicIntroduced で管理。一般語彙の新規枠は消費しない）。
 * - 同じ綴りの語（兄弟グループ）は1日1枚まで。今日すでに評価した語のグループも埋まっているとみなす。
 *   優先は 復習（延滞の大きい順）→ 新しい語 → 曲の語。
 */
export function buildSession(words: Word[], cards: CardMap, opts: SessionOptions): SessionPlan {
  const today = opts.today ?? todayStr();

  // 今日すでに評価した語の兄弟グループは埋まっている
  const used = new Set<string>();
  for (const w of words) if (cards[w.id]?.last === today) used.add(siblingKey(w));

  // 復習
  const seen = new Set<string>();
  const relearn: Word[] = [];
  const overdue: Word[] = [];
  for (const w of reviewDueWords(words, cards, today)) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    (cards[w.id].last === today ? relearn : overdue).push(w);
  }
  const score = new Map(overdue.map((w) => [w.id, relativeOverdue(cards[w.id], today)]));
  overdue.sort((a, b) => score.get(b.id)! - score.get(a.id)!); // 同じ値は due の古い順（安定ソート）
  const eligible: Word[] = [];
  const eligibleGroups = new Set<string>();
  for (const w of overdue) {
    const g = siblingKey(w);
    if (used.has(g) || eligibleGroups.has(g)) continue; // 同じ綴りの語は明日へ
    eligibleGroups.add(g);
    eligible.push(w);
  }
  const limit = typeof opts.reviewLimit === "number" && opts.reviewLimit >= 0 ? Math.floor(opts.reviewLimit) : Infinity;
  const budget = Math.max(0, limit - Math.max(0, opts.reviewedToday ?? 0));
  const backlog = eligible.length > budget;
  const review = [...eligible.slice(0, budget), ...relearn];
  for (const w of review) used.add(siblingKey(w));

  // 新しい語（復習が溜まっている日は出さない）
  const remainingNew = backlog ? 0 : Math.max(0, opts.newLimit - opts.introducedToday);
  const fresh = orderNew(words, cards, {
    limit: remainingNew,
    capoeiraShare: opts.capoeiraShare,
    coreOrder: opts.coreOrder,
    pinned: opts.pinned,
    isExcluded: (w) => used.has(siblingKey(w)),
    seed: today,
  });
  for (const w of fresh) used.add(siblingKey(w));

  // 曲から追加した語
  const remainingAdded = Math.max(0, (opts.addedLimit ?? 0) - (opts.addedToday ?? 0));
  const added: Word[] = [];
  for (const w of addedNewWords(words, cards, today)) {
    if (added.length >= remainingAdded) break;
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const g = siblingKey(w);
    if (used.has(g)) continue;
    used.add(g);
    added.push(w);
  }

  return {
    review,
    fresh,
    added,
    all: [...interleave(review, fresh, REVIEWS_PER_NEW), ...added],
    ...(backlog ? { reason: "backlog" as const } : {}),
    dueTotal: eligible.length,
  };
}

/**
 * 復習の予報（完了画面の「明日の復習」と7日分の棒）。
 * 1日目（明日）は、評価済みで due が明日以前のカード（今日やり残した分も明日に回る）。
 * 2日目以降は due がその日ちょうどのカード。未評価（曲から追加しただけ）のカードは数えない。
 */
export function forecast(words: Word[], cards: CardMap, today: string = todayStr(), days = 7): number[] {
  const out = new Array<number>(Math.max(0, days)).fill(0);
  if (!out.length) return out;
  const dates = out.map((_, i) => addDays(today, i + 1));
  const index = new Map(dates.map((d, i) => [d, i]));
  const tomorrow = dates[0];
  const seen = new Set<string>();
  for (const w of words) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const c = cards[w.id];
    if (!c || !c.last) continue;
    if (c.due <= tomorrow) out[0]++;
    else {
      const i = index.get(c.due);
      if (i !== undefined) out[i]++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// クイズの出題（B2-12）
// ---------------------------------------------------------------------------

/** 苦手とみなす ease（これ未満） */
export const WEAK_EASE = 2.1;
/** 苦手の語がこの数より少なければ、条件を lapses ≥ 1 に広げる */
export const WEAK_MIN = 10;

/**
 * 苦手な語（クイズの出題範囲「苦手」）: 評価済みで lapses ≥ 2 か ease < 2.1。
 * 該当が min 語（既定 10）より少なければ lapses ≥ 1 か ease < 2.1 に広げる。同じ id は1回、並びは元の順。
 */
export function weakWords(words: readonly Word[], cards: CardMap, min: number = WEAK_MIN): Word[] {
  const seen = new Set<string>();
  const studied: Word[] = [];
  for (const w of words) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    if (cards[w.id]?.last) studied.push(w);
  }
  const pick = (minLapses: number) =>
    studied.filter((w) => {
      const c = cards[w.id];
      return c.lapses >= minLapses || c.ease < WEAK_EASE;
    });
  const strict = pick(2);
  return strict.length >= min ? strict : pick(1);
}

/** 浮動小数点の誤差を同じ値とみなす比較（a が先なら負） */
function cmpNum(a: number, b: number): number {
  return Math.abs(a - b) < 1e-9 ? 0 : a - b;
}

/**
 * クイズに出す語を n 語選ぶ（純関数。戻り値は優先の高い順）。優先順:
 *  1. 期限の来た復習（評価済みで due ≤ today）が先
 *  2. 延滞比（relativeOverdue）の大きい順（期限前の語は期限に近い順）
 *  3. ease の低い順
 *  4. 最近 again にした語（again の後まだ合格していない = reps 0）が先。その中は last の新しい順
 * 未評価の語（カード無し・曲から追加しただけ）は評価済みの語の後ろ。
 * 同じ順位は random で混ぜる（毎回同じ語ばかりにならないように）。同じ id は1回だけ。
 */
export function pickForQuiz(
  pool: readonly Word[],
  cards: CardMap,
  n: number,
  today: string = todayStr(),
  random: () => number = Math.random
): Word[] {
  if (!(n > 0)) return [];
  const seen = new Set<string>();
  const list: Word[] = [];
  for (const w of pool) {
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    list.push(w);
  }
  // 同じ順位の並びを混ぜる（Fisher–Yates。この後の sort は安定なので、同順位はこの並びのまま）
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  type Key = { due: boolean; ratio: number; ease: number; again: boolean; last: string };
  const keys = new Map<string, Key | null>();
  for (const w of list) {
    const c = cards[w.id];
    keys.set(
      w.id,
      c && c.last
        ? { due: c.due <= today, ratio: relativeOverdue(c, today), ease: c.ease, again: c.reps === 0, last: c.last }
        : null
    );
  }
  list.sort((a, b) => {
    const ka = keys.get(a.id)!;
    const kb = keys.get(b.id)!;
    if (!ka || !kb) return (ka ? 0 : 1) - (kb ? 0 : 1);
    // 期限到来の延滞比は正、期限前は 0 以下なので延滞比の順でも期限到来が先になるが、意図として明示する
    if (ka.due !== kb.due) return ka.due ? -1 : 1;
    const r = cmpNum(kb.ratio, ka.ratio);
    if (r) return r;
    const e = cmpNum(ka.ease, kb.ease);
    if (e) return e;
    if (ka.again !== kb.again) return ka.again ? -1 : 1;
    if (ka.again) return kb.last.localeCompare(ka.last);
    return 0;
  });
  return list.slice(0, Math.floor(n));
}

export interface Mastery {
  /** カード無し */
  notIntroduced: number;
  /** カードはあるが一度も評価していない（曲から追加しただけ） */
  new: number;
  /** 未学習の合計（notIntroduced + new）。ホームの「未学習」マス */
  unstudied: number;
  learning: number;
  young: number;
  mature: number;
  total: number;
  /** 学習に着手した（一度でも評価した）割合(0-1) */
  startedRatio: number;
  /** 定着(young+mature ＝ 間隔7日以上)割合(0-1) */
  retainedRatio: number;
}

/** 習熟度の集計。保存済みの level ではなく displayLevel（現行しきい値）で数える */
export function masteryBreakdown(words: Word[], cards: CardMap): Mastery {
  const counts: Record<SrsLevel, number> = { new: 0, learning: 0, young: 0, mature: 0 };
  let introduced = 0;
  for (const w of words) {
    const c = cards[w.id];
    if (!c) continue;
    introduced++;
    counts[displayLevel(c)]++;
  }
  const total = words.length;
  const notIntroduced = total - introduced;
  const unstudied = notIntroduced + counts.new;
  const retained = counts.young + counts.mature;
  return {
    notIntroduced,
    new: counts.new,
    unstudied,
    learning: counts.learning,
    young: counts.young,
    mature: counts.mature,
    total,
    startedRatio: total ? (total - unstudied) / total : 0,
    retainedRatio: total ? retained / total : 0,
  };
}
