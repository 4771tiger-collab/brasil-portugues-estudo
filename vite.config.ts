import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// 静的ホスティング/ファイル配布でも動くよう相対パス基準にする
export default defineConfig({
  base: "./",
  // 大きなJSON(words.json 等)を巨大なオブジェクトリテラルとしてではなく
  // JSON.parse(文字列) としてバンドルし、rollupのAST深い再帰(スタックオーバーフロー)を回避
  json: { stringify: true, namedExports: false },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "ブラジルポルトガル語 学習帳",
        short_name: "ポル語学習帳",
        description: "単語帳・クイズ・SRS・シャドーイングで学ぶブラジルポルトガル語",
        lang: "ja",
        theme_color: "#1b9e57",
        background_color: "#f3f5f9",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
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
