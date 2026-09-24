import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json";

// 設定画面に出すバージョン情報（ビルド時に埋め込む。型は src/vite-env.d.ts）
function gitShortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
}

// 静的ホスティング/ファイル配布でも動くよう相対パス基準にする
export default defineConfig({
  base: "./",
  // 大きなJSON(words.json 等)を巨大なオブジェクトリテラルとしてではなく
  // JSON.parse(文字列) としてバンドルし、rollupのAST深い再帰(スタックオーバーフロー)を回避
  json: { stringify: true, namedExports: false },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_ID__: JSON.stringify(gitShortSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  plugins: [
    react(),
    VitePWA({
      // 更新は利用者が選ぶ（学習の途中で勝手に再読み込みしない）。登録は PwaRegistrar で行う
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icon.svg", "favicon.ico", "apple-touch-icon-180x180.png", "robots.txt"],
      manifest: {
        // GitHub Pages のサブパス（/<repo>/）でも動くよう start_url と scope は相対指定（manifest の URL 基準）。
        // id は書かない: id は manifest ではなくオリジン基準で解決されるため "./" だと
        // https://<owner>.github.io/（同じオリジンの別アプリと同一扱い）になる。省略すれば start_url
        // （https://<owner>.github.io/<repo>/）が id になる。id はインストールの識別子なので後から変えない
        start_url: "./",
        scope: "./",
        name: "ブラジルポルトガル語 学習帳",
        short_name: "ポル語学習帳",
        description: "単語帳・クイズ・SRS・シャドーイングで学ぶブラジルポルトガル語",
        lang: "ja",
        theme_color: "#1b9e57",
        background_color: "#f3f5f9",
        display: "standalone",
        orientation: "portrait",
        // PNG は public/icon-full.svg から `npm run icons` で生成（maskable は四隅まで緑）
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "maskable-icon-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
        // ホーム画面のアイコン長押しで出るメニュー（HashRouter なので #/ 付き）
        shortcuts: [
          {
            name: "今日の学習",
            url: "./#/flashcards/today",
            icons: [{ src: "pwa-192x192.png", sizes: "192x192", type: "image/png" }],
          },
          { name: "クイズ", url: "./#/quiz", icons: [{ src: "pwa-192x192.png", sizes: "192x192", type: "image/png" }] },
          { name: "音楽", url: "./#/music", icons: [{ src: "pwa-192x192.png", sizes: "192x192", type: "image/png" }] },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        // 古いバージョンのプリキャッシュを残さない
        cleanupOutdatedCaches: true,
        // 歌詞引き用の辞書で JS が大きくなるため上限を明示（超えると黙ってプリキャッシュから外れる）
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  build: {
    // OneDrive 同期フォルダ上では dist のファイルがロックされ、vite の
    // emptyOutDir(出力前の dist 削除) がネイティブクラッシュを誘発しうる。
    // 削除は scripts/build.mjs(リトライ付き)で行うため無効化。
    emptyOutDir: false,
    rollupOptions: {
      output: {
        // 歌詞引き用の一般辞書は別チャンクに（本体の更新時に再ダウンロードしない）
        manualChunks: (id) => (id.includes("dict-words.json") ? "dict" : undefined),
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
