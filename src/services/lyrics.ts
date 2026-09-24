// ============================================================================
// 歌詞サービス（LRCLIB: https://lrclib.net ・無料・CORS可）
// 歌詞は著作物のためアプリには同梱せず、再生時に端末から取得して端末内にだけキャッシュする。
// ============================================================================

const API = "https://lrclib.net/api";
// LRCLIB はクライアント識別ヘッダを推奨（ヘッダ値は ASCII のみ可）
const HEADERS = { "Lrclib-Client": "brasil-portugues-estudo/0.1" };

export interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

/** 歌詞1行。t は秒（同期歌詞でない場合は null）。text が空なら前奏・間奏 */
export interface LyricLine {
  t: number | null;
  text: string;
}

export class LyricsNotFoundError extends Error {}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(url, { headers: HEADERS, signal });
  if (r.status === 404) throw new LyricsNotFoundError("歌詞が見つかりませんでした");
  if (!r.ok) throw new Error(`LRCLIB エラー (${r.status})`);
  return (await r.json()) as T;
}

export function getLyricsById(id: number, signal?: AbortSignal): Promise<LrclibRecord> {
  return getJson<LrclibRecord>(`${API}/get/${id}`, signal);
}

export async function searchLyrics(artist: string, track: string, signal?: AbortSignal): Promise<LrclibRecord[]> {
  const q = new URLSearchParams({ artist_name: artist, track_name: track });
  const exact = await getJson<LrclibRecord[]>(`${API}/search?${q}`, signal);
  if (exact.length) return exact;
  return getJson<LrclibRecord[]>(`${API}/search?${new URLSearchParams({ q: `${artist} ${track}` })}`, signal);
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** LRC を行配列に。1行に複数タイムスタンプ・[offset:]・メタタグ・空行（間奏）に対応 */
export function parseLrc(lrc: string): LyricLine[] {
  let offsetSec = 0;
  const out: LyricLine[] = [];
  for (const rawLine of lrc.replace(/\r\n?/g, "\n").split("\n")) {
    const off = rawLine.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) {
      // LRC仕様: 正の offset は歌詞を早める
      offsetSec = Number(off[1]) / 1000;
      continue;
    }
    const times: number[] = [];
    let m: RegExpExecArray | null;
    TIME_TAG.lastIndex = 0;
    let lastEnd = 0;
    while ((m = TIME_TAG.exec(rawLine)) && m.index === lastEnd) {
      const frac = m[3] ? Number(m[3]) / 10 ** m[3].length : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      lastEnd = TIME_TAG.lastIndex;
    }
    if (times.length === 0) continue; // [ar:] 等のメタタグ・タイムなし行
    const text = rawLine.slice(lastEnd).replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").trim();
    for (const t of times) out.push({ t: Math.max(0, t - offsetSec), text });
  }
  out.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  // 連続する空行は1つにまとめる
  return out.filter((l, i) => l.text !== "" || i === 0 || out[i - 1].text !== "");
}

export function parsePlain(text: string): LyricLine[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((s) => ({ t: null, text: s.trim() }))
    .filter((l, i, arr) => l.text !== "" || (i > 0 && arr[i - 1].text !== ""));
}

/** 行テキストの正規化（空白・Unicode 正規化の差を吸収） */
export function lineKey(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/**
 * 和訳の保存キー = 正規化した行テキストのハッシュ（cyrb53）。
 * 行番号ではなく内容基準なので、版が変わってもサビが繰り返されてもずれない。
 * 歌詞本文そのものを保存・バックアップに残さないためにハッシュにする。
 */
export function lineHash(text: string): string {
  const s = lineKey(text);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** lineHash の形（cyrb53 の base36・11文字以下）のキーか。空白や大文字・記号を含む行テキストは通らない */
export function isLineHash(k: string): boolean {
  return /^[0-9a-z]{1,11}$/.test(k);
}

function lastTimestamp(lrc: string): number {
  const lines = parseLrc(lrc);
  return lines.length ? lines[lines.length - 1].t ?? 0 : 0;
}

/**
 * 候補から動画に合う版を選ぶ。LRCLIB の duration は同一歌詞でもばらつくため信用しすぎない:
 * 同期歌詞あり → 本文で同一版をグループ化 → 最終行が動画長+2秒を超える版を除外
 * → 登録件数の多い版（合意）→ 動画長−最終行 が小さい版 → duration の近さ
 */
export function pickBest(cands: LrclibRecord[], videoDurationSec?: number): LrclibRecord | undefined {
  const synced = cands.filter((c) => c.syncedLyrics && !c.instrumental);
  if (synced.length === 0) return cands.find((c) => c.plainLyrics && !c.instrumental) ?? cands[0];

  const groups = new Map<string, LrclibRecord[]>();
  for (const c of synced) {
    const key = lineKey(c.syncedLyrics!);
    const g = groups.get(key);
    if (g) g.push(c);
    else groups.set(key, [c]);
  }
  const vd = videoDurationSec ?? 0;
  const ranked = [...groups.values()]
    .map((g) => ({ g, last: lastTimestamp(g[0].syncedLyrics!) }))
    .filter((x) => !vd || x.last <= vd + 2);
  const pool = ranked.length ? ranked : [...groups.values()].map((g) => ({ g, last: lastTimestamp(g[0].syncedLyrics!) }));
  pool.sort((a, b) => {
    if (b.g.length !== a.g.length) return b.g.length - a.g.length;
    if (vd) return vd - a.last - (vd - b.last);
    return 0;
  });
  const best = pool[0].g;
  if (!vd) return best[0];
  return [...best].sort((a, b) => Math.abs(a.duration - vd) - Math.abs(b.duration - vd))[0];
}

export interface LoadedLyrics {
  lrclibId: number;
  lines: LyricLine[];
  synced: boolean;
  instrumental: boolean;
}

export function toLoaded(rec: { id: number; syncedLyrics: string | null; plainLyrics: string | null; instrumental: boolean }): LoadedLyrics {
  if (rec.syncedLyrics) return { lrclibId: rec.id, lines: parseLrc(rec.syncedLyrics), synced: true, instrumental: false };
  if (rec.plainLyrics) return { lrclibId: rec.id, lines: parsePlain(rec.plainLyrics), synced: false, instrumental: false };
  return { lrclibId: rec.id, lines: [], synced: false, instrumental: rec.instrumental };
}
