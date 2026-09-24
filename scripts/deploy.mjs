// GitHub Pages への配信。`npm run deploy`（作業ツリーに未コミットの変更があるときは `npm run deploy -- --allow-dirty`）
//
// 1) 型チェック → OneDrive 外の一時フォルダ(OUT)へ vite build
// 2) .nojekyll を置き、必要なファイルと noindex がそろっているか確かめる
// 3) OUT を新しい git リポジトリにして gh-pages ブランチへ1コミットだけ作り、
//    メインのリポジトリの origin へ force push（gh-pages には成果物だけが残る。履歴は持たない）
//
// 初回の準備（リポジトリ作成・gh auth setup-git・Pages の有効化）は、origin が無いときに表示する手順のとおり。
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capture, pagesUrlFromRemote, sh, tmpOut, typecheck, viteBuild } from "./lib/build-lib.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT = tmpOut("bp-deploy-dist");
const BRANCH = "gh-pages";
const allowDirty = process.argv.includes("--allow-dirty");

// git は実行ファイルなのでシェルを通さない（空白や日本語を含む引数をそのまま渡す）
const git = (args, opts = {}) => sh("git", args, { shell: false, ...opts });
const gitOut = (args) => capture("git", args, { shell: false });

function fail(msg) {
  console.error(`\n[deploy] ${msg}`);
  process.exit(1);
}

process.chdir(ROOT);

// 1) 公開先（origin）
const remoteUrl = gitOut(["-C", ROOT, "remote", "get-url", "origin"]);
if (!remoteUrl) {
  console.error(
    [
      "",
      "[deploy] origin リモートがありません。初回だけ次の手順で GitHub のリポジトリを用意してください。",
      "",
      "  1. リポジトリを作って push（公開リポジトリになります）",
      "       gh repo create <owner>/<repo> --public --source . --remote origin --push",
      "  2. 一時フォルダからの push にも gh の資格情報を使う",
      "       gh auth setup-git",
      "  3. 配信（gh-pages ブランチを作る）",
      "       npm run deploy",
      "  4. GitHub Pages を gh-pages ブランチで有効にする",
      '       gh api -X POST repos/<owner>/<repo>/pages -f "source[branch]=gh-pages" -f "source[path]=/"',
      "       gh api repos/<owner>/<repo>/pages --jq \".status,.html_url\"   # built になるまで待つ",
      "",
    ].join("\n")
  );
  process.exit(1);
}

// 2) 未コミットの変更（公開物とコミットがずれる）
const status = gitOut(["-C", ROOT, "status", "--porcelain"]);
if (status === null) fail("git status に失敗しました。");
const dirty = status !== "";
if (dirty) {
  console.warn("[deploy] ⚠ 未コミットの変更があります:");
  console.warn(
    status
      .split("\n")
      .slice(0, 15)
      .map((l) => `    ${l}`)
      .join("\n") + (status.split("\n").length > 15 ? "\n    …" : "")
  );
  if (!allowDirty) fail("コミットしてから配信してください（このまま配信するなら `npm run deploy -- --allow-dirty`）。");
  console.warn("[deploy] --allow-dirty のため続行します。");
}

// 3) コミットの SHA とコミットする人（メインのリポジトリの設定を使う）
const sha = gitOut(["-C", ROOT, "rev-parse", "--short", "HEAD"]);
if (!sha) fail("HEAD のコミットがありません。先にコミットしてください。");
const userName = gitOut(["-C", ROOT, "config", "user.name"]);
const userEmail = gitOut(["-C", ROOT, "config", "user.email"]);
if (!userName || !userEmail) fail("git の user.name / user.email が設定されていません（git config user.name ... で設定してください）。");

// 4) 型チェック → ビルド（OneDrive の外）
if (!typecheck()) fail("型エラーがあります。");
if (!viteBuild(OUT)) fail("vite build に失敗しました。");

// 5) Jekyll の処理を止める（_ で始まるファイルも配信されるように）
writeFileSync(join(OUT, ".nojekyll"), "");

// 6) 健全性チェック
const REQUIRED = ["index.html", "manifest.webmanifest", "sw.js", "pwa-192x192.png", "maskable-icon-512x512.png"];
const missing = REQUIRED.filter((f) => !existsSync(join(OUT, f)));
if (missing.length) fail(`ビルドに次のファイルがありません: ${missing.join(", ")}`);
const indexHtml = readFileSync(join(OUT, "index.html"), "utf8");
if (!/<meta\s+name="robots"\s+content="[^"]*noindex/i.test(indexHtml)) fail("index.html に noindex の meta がありません。");
if (!indexHtml.includes("manifest.webmanifest")) fail("index.html に manifest へのリンクがありません。");
console.log(`[deploy] 確認 OK: ${REQUIRED.join(", ")}, noindex`);

// 7) 成果物だけの1コミットを作って force push
rmSync(join(OUT, ".git"), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const message = `deploy ${sha}${dirty ? " (dirty)" : ""} ${new Date().toISOString()}`;
// 改行コードを変換しない（ビルドの中身をそのまま公開する）
const raw = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"];
if (git(["-C", OUT, "init", "-q", "-b", BRANCH]) !== 0) fail("一時フォルダで git init に失敗しました。");
if (git(["-C", OUT, ...raw, "add", "-A"]) !== 0) fail("git add に失敗しました。");
if (git(["-C", OUT, ...raw, "-c", `user.name=${userName}`, "-c", `user.email=${userEmail}`, "commit", "-q", "-m", message]) !== 0)
  fail("git commit に失敗しました。");

console.log(`[deploy] push → origin ${BRANCH} (${message})`);
if (git(["-C", OUT, "push", "-f", remoteUrl, `${BRANCH}:${BRANCH}`]) !== 0)
  fail("push に失敗しました。`gh auth setup-git` を実行したか、リポジトリへの権限があるかを確かめてください。");

const pagesUrl = pagesUrlFromRemote(remoteUrl);
console.log("\n[deploy] 完了 ✅");
if (pagesUrl) {
  console.log(`[deploy] 公開 URL: ${pagesUrl}`);
  console.log("[deploy] 反映まで1〜2分かかります。Android では開き直すと更新バナーが出ます。");
} else {
  console.log("[deploy] origin が GitHub ではないため、公開 URL を導けませんでした。");
}
