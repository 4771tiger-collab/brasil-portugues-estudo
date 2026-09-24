// ビルド系スクリプト(build.mjs / deploy.mjs / preview.mjs)の共通処理。
// OneDrive 同期フォルダ上での vite 出力はロックでクラッシュしうるため、
// 出力先は常に OneDrive 外の一時フォルダにする。
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";

/** 子プロセスを実行し終了コードを返す（出力はそのまま表示） */
export const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: "inherit", shell: isWin, ...opts }).status ?? 1;

/** 子プロセスを実行し標準出力(trim)を返す。失敗時は null */
export function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: isWin, ...opts });
  return r.status === 0 ? String(r.stdout).trim() : null;
}

/** 一時ビルドフォルダ（OneDrive 外） */
export const tmpOut = (name) => join(tmpdir(), name);

/** 型チェック（src 用と scripts 用の2構成）。成功で true */
export function typecheck() {
  console.log("[build] 型チェック中...");
  return sh("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"]) === 0 && sh("npx", ["tsc", "--noEmit", "-p", "tsconfig.node.json"]) === 0;
}

/** vite build を outDir へ。成功で true */
export function viteBuild(outDir) {
  console.log(`[build] vite build → ${outDir}`);
  return sh("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"]) === 0;
}

/**
 * GitHub のリモート URL から GitHub Pages の公開 URL を導く。GitHub 以外は null
 *   https://github.com/<owner>/<repo>(.git)  /  git@github.com:<owner>/<repo>(.git)
 *   ssh://git@github.com/<owner>/<repo>(.git)
 * <owner>.github.io という名前のリポジトリはサブパス無しで公開される。
 */
export function pagesUrlFromRemote(remoteUrl) {
  const m = String(remoteUrl)
    .trim()
    .match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  const owner = m[1].toLowerCase();
  const repo = m[2];
  if (repo.toLowerCase() === `${owner}.github.io`) return `https://${owner}.github.io/`;
  return `https://${owner}.github.io/${repo}/`;
}
