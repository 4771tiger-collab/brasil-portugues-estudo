// ============================================================================
// 辞書カバー率の計測（開発用）
//   npm run music:coverage
// 各曲の歌詞を実行時に LRCLIB から取得し、アプリと同じ原形推定で「辞書で意味が引けるトークン」の割合を出す。
// 出力は曲ごとの集計値だけ（歌詞の行・単語の一覧は出力も保存もしない）。
// ============================================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createLemmatizer, isCovered, type LexRef } from "../src/services/lemmatize";
import { getLyricsById, pickBest, searchLyrics, toLoaded } from "../src/services/lyrics";
import type { IrregularTable } from "../src/services/conjugate";
import type { RawWord } from "../src/data/types";
import type { Playlist } from "../src/data/music";

const here = dirname(fileURLToPath(import.meta.url));
const load = <T>(name: string): T => JSON.parse(readFileSync(resolve(here, "../data", name), "utf8"));

const entries: LexRef[] = [];
const addRaw = (list: RawWord[], source: LexRef["source"]) =>
  list.forEach((r, i) =>
    entries.push({ id: `${source}:${i}`, pt: r.ポルトガル語, ja: r.日本語, pos: r.品詞, source })
  );
addRaw(load<RawWord[]>("words.json"), "words");
addRaw(load<RawWord[]>("capoeira-words.json"), "capoeira");
const dict = load<RawWord[]>("dict-words.json");
addRaw(dict, "dict");

const lem = createLemmatizer({
  entries,
  irregular: load<IrregularTable>("verb-irregular.json"),
  colloquial: load("colloquial.json"),
});

const HEURISTIC = new Set(["nominal", "regular", "clitic", "derived", "rdrop", "fold"]);
const playlists = load<Playlist[]>("music-playlists.json");

console.log(`辞書: 単語帳 ${entries.length - dict.length} 語 + 一般辞書 ${dict.length} 語`);
console.log("曲".padEnd(24) + "トークン  カバー率  (完全/表  推定)  未知  固有名詞");

let T = 0;
let C = 0;
for (const pl of playlists) {
  for (const s of pl.songs) {
    try {
      const rec =
        s.lrclibId != null ? await getLyricsById(s.lrclibId) : pickBest(await searchLyrics(s.lrcArtist, s.lrcTrack), s.durationSec);
      if (!rec) {
        console.log(`${s.title.padEnd(24)}歌詞なし`);
        continue;
      }
      const lines = toLoaded(rec).lines;
      let total = 0;
      let covered = 0;
      let exact = 0;
      let heuristic = 0;
      let unknown = 0;
      let proper = 0;
      for (const l of lines) {
        lem.analyzeLine(l.text).forEach((t, i) => {
          const c = lem.lookup(t.text, { lineStart: i === 0 }).candidates[0];
          // 行頭以外の大文字語で辞書に無いものは固有名詞とみなして分母から外す
          if ((!c || !isCovered(c)) && i > 0 && /^\p{Lu}/u.test(t.text)) {
            proper++;
            return;
          }
          total++;
          if (c && isCovered(c)) {
            covered++;
            if (HEURISTIC.has(c.kind)) heuristic++;
            else exact++;
          } else unknown++;
        });
      }
      T += total;
      C += covered;
      const pct = total ? ((covered / total) * 100).toFixed(1) : "-";
      console.log(
        `${s.title.padEnd(24)}${String(total).padStart(6)}  ${pct.padStart(6)}%  (${String(exact).padStart(4)} ${String(heuristic).padStart(5)})  ${String(unknown).padStart(4)}  ${String(proper).padStart(4)}`
      );
    } catch (e) {
      console.log(`${s.title.padEnd(24)}取得失敗: ${e instanceof Error ? e.message : e}`);
    }
  }
}
console.log(`\n合計 ${T} トークン / カバー率 ${T ? ((C / T) * 100).toFixed(1) : "-"}%`);
