// 決定論的なプロダクションビルド。
// このプロジェクトは OneDrive 同期フォルダ上にあり、出力先(dist)へファイルを
// 書き込むと OneDrive のロックで vite/Node がネイティブクラッシュ(0xC0000409)する。
// 対策:
//   1) OneDrive 同期外の一時フォルダ(TMP)へビルド（ここは安定して成功する）
//   2) TMP→dist の複製は「別の子プロセス」で行い、万一クラッシュしても本体は
//      落とさない（成果物は TMP に残るので実害なし）。
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const isWin = process.platform === "win32";
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", shell: isWin, ...opts }).status ?? 1;

const TMP = join(tmpdir(), "bp-build-dist");
const DIST = resolve("dist");

// 1) 型チェック
console.log("[build] 型チェック中...");
if (sh("npx", ["tsc", "--noEmit"]) !== 0) {
  console.error("[build] 型エラーがあります。");
  process.exit(1);
}

// 2) OneDrive 同期外へビルド
console.log(`[build] vite build → ${TMP}`);
if (sh("npx", ["vite", "build", "--outDir", TMP, "--emptyOutDir"]) !== 0) {
  console.error("[build] vite build に失敗しました。");
  process.exit(1);
}

// 3) dist/ へ複製（子プロセスで隔離。OneDriveロックは数回リトライ）
const copyCode =
  "const{rmSync,cpSync,mkdirSync}=require('fs');" +
  "const s=process.env.BP_TMP,d=process.env.BP_DIST;" +
  "rmSync(d,{recursive:true,force:true,maxRetries:12,retryDelay:250});" +
  "mkdirSync(d,{recursive:true});" +
  "cpSync(s,d,{recursive:true,force:true});";

let mirrored = false;
for (let i = 1; i <= 5 && !mirrored; i++) {
  const status = sh(process.execPath, ["-e", copyCode], {
    shell: false,
    env: { ...process.env, BP_TMP: TMP, BP_DIST: DIST },
  });
  if (status === 0) mirrored = true;
  else console.warn(`[build] dist/ 複製リトライ ${i}/5 ...`);
}

if (mirrored) {
  console.log("\n[build] 成功 ✅  → dist/");
} else {
  console.warn(
    `\n[build] vite build は成功しました（成果物: ${TMP}）。\n` +
      `ただし OneDrive のロックで dist/ への複製に失敗しました。\n` +
      `dist/ が必要なら OneDrive を一時停止して \`npm run build\` を再実行してください。`
  );
}
// vite build 自体は成功しているのでビルドは成功扱い
process.exit(0);
