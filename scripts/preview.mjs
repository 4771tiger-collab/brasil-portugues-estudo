// 本番ビルドを手元で確かめる（Service Worker・manifest・更新バナーなど）。`npm run preview:tmp`
//   1) 型チェックなしで vite build → OneDrive 外の一時フォルダ(bp-build-dist)
//   2) その出力を vite preview で配信（http://localhost:4173/、ポートが使用中なら失敗）
// `--no-build` を付けると、前回のビルドをそのまま配信する。
// プレビューのサーバーはこのプロセスの中で動かす（止めたときに子プロセスが残ってポートを塞がないように）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";
import { tmpOut, viteBuild } from "./lib/build-lib.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = tmpOut("bp-build-dist");
const PORT = 4173;

process.chdir(ROOT);

if (!process.argv.includes("--no-build") && !viteBuild(OUT)) {
  console.error("[preview] vite build に失敗しました。");
  process.exit(1);
}
if (!existsSync(join(OUT, "index.html"))) {
  console.error(`[preview] ${OUT} にビルドがありません（--no-build を外して実行してください）。`);
  process.exit(1);
}

const server = await preview({
  root: ROOT,
  build: { outDir: OUT },
  preview: { port: PORT, strictPort: true },
});
server.printUrls();
