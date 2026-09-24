// PWA アイコン（PNG / favicon.ico）の生成仕様（@vite-pwa/assets-generator 用）。
// 元画像は角丸なしで四隅まで塗った icon-full.svg。maskable は余白0で四隅まで緑にし、
// 菱形はマスクの安全円（半径40%）の内側に収まる。生成物は git に入れる。
//
// 注意: Windows では sharp が SVG の <text>（"BR"）を描くときにクラッシュし、
// `npx pwa-assets-generator` は何も書き出さずに終わる。そのため `npm run icons` は
// 同じ仕様を @resvg/resvg-js で描く scripts/make-icons.mjs を使う。ここを変えたら両方をそろえること。
import { defineConfig, minimal2023Preset } from "@vite-pwa/assets-generator/config";

export default defineConfig({
  preset: {
    ...minimal2023Preset,
    maskable: { sizes: [512], padding: 0, resizeOptions: { background: "#1b9e57" } },
    apple: { sizes: [180], padding: 0 },
  },
  images: ["public/icon-full.svg"],
});
