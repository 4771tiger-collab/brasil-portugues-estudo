// ============================================================================
// 各曲に合う LRCLIB の版を選び、music-playlists.json の lrclibId に固定する（開発用）
//   npm run music:pin            … 未固定の曲だけ
//   npm run music:pin -- --all   … すべて選び直す
// 出力・保存するのは数値（ID・件数・タイムスタンプ）だけ。歌詞本文は出力も保存もしない。
// ============================================================================

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseLrc, pickBest, searchLyrics } from "../src/services/lyrics";
import type { Playlist } from "../src/data/music";

const here = dirname(fileURLToPath(import.meta.url));
const file = resolve(here, "../data/music-playlists.json");
const all = process.argv.includes("--all");

const playlists = JSON.parse(readFileSync(file, "utf8")) as Playlist[];
let changed = 0;

for (const pl of playlists) {
  for (const s of pl.songs) {
    if (s.lrclibId != null && !all) continue;
    try {
      const cands = await searchLyrics(s.lrcArtist, s.lrcTrack);
      const best = pickBest(cands, s.durationSec);
      if (!best) {
        console.log(`✗ ${s.title}: 候補なし`);
        continue;
      }
      const lines = best.syncedLyrics ? parseLrc(best.syncedLyrics) : [];
      const first = lines.find((l) => l.text)?.t ?? 0;
      const last = lines.length ? lines[lines.length - 1].t ?? 0 : 0;
      console.log(
        `✓ ${s.title.padEnd(22)} id=${best.id}  候補${cands.length}件  同期=${best.syncedLyrics ? "あり" : "なし"}` +
          `  行数=${lines.length}  最初の行=${first.toFixed(1)}s  最終行=${last.toFixed(1)}s / 動画=${s.durationSec}s`
      );
      if (s.lrclibId !== best.id) {
        s.lrclibId = best.id;
        changed++;
      }
    } catch (e) {
      console.log(`✗ ${s.title}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

writeFileSync(file, JSON.stringify(playlists, null, 2) + "\n", "utf8");
console.log(`\n${changed} 曲の lrclibId を更新しました`);
