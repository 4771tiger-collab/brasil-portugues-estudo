// PWA アイコン（PNG / favicon.ico）を public/icon-full.svg から作る。`npm run icons`
//
// 本来は @vite-pwa/assets-generator（pwa-assets.config.ts）で作る想定だが、Windows では
// sharp（librsvg + fontconfig）が SVG の <text> を描くときにネイティブクラッシュする
// （終了コード 127、何も書き出さない）。そこで描画は @resvg/resvg-js で行い、
// 出力の仕様（ファイル名・サイズ・余白・背景）は pwa-assets.config.ts と同じにそろえる:
//   minimal2023Preset
//     transparent: 64/192/512（余白 5%、透明）＋ favicon.ico 48
//     maskable:    512（余白 0、背景 #1b9e57）
//     apple:       180（余白 0）
// 生成物は git に入れる（ビルドのたびには作らない）。
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";

const SRC = resolve("public/icon-full.svg");
const OUT_DIR = resolve("public");

/** @type {{ file: string, size: number, padding: number, background?: string, ico?: boolean }[]} */
const ASSETS = [
  { file: "pwa-64x64.png", size: 64, padding: 0.05 },
  { file: "pwa-192x192.png", size: 192, padding: 0.05 },
  { file: "pwa-512x512.png", size: 512, padding: 0.05 },
  { file: "maskable-icon-512x512.png", size: 512, padding: 0, background: "#1b9e57" },
  { file: "apple-touch-icon-180x180.png", size: 180, padding: 0, background: "#ffffff" },
  { file: "favicon.ico", size: 48, padding: 0.05, ico: true },
];

const source = readFileSync(SRC, "utf8").replace(/<\?xml[^>]*\?>/, "").trim();
const rootTag = source.match(/<svg\b[^>]*>/);
if (!rootTag) throw new Error(`${SRC} に <svg> がありません`);
const viewBox = rootTag[0].match(/viewBox="([^"]+)"/)?.[1];
if (!viewBox) throw new Error(`${SRC} の <svg> に viewBox がありません`);

/** 元の SVG を size×size の中央に（余白を取って）入れ子にした SVG を作る */
function framed(size, padding, background) {
  const inner = Math.round(size * (1 - padding));
  const off = (size - inner) / 2;
  // ルートの位置・大きさの属性を外し、入れ子用に付け直す（viewBox はそのまま）
  const attrs = rootTag[0]
    .replace(/^<svg\b/, "")
    .replace(/>$/, "")
    .replace(/\s(?:x|y|width|height)="[^"]*"/g, "");
  const nested = source.replace(rootTag[0], `<svg${attrs} x="${off}" y="${off}" width="${inner}" height="${inner}">`);
  const bg = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${bg}${nested}</svg>`;
}

function renderPng(size, padding, background) {
  const resvg = new Resvg(framed(size, padding, background), {
    fitTo: { mode: "width", value: size },
    // "BR" の文字は端末のフォントで描く（Windows なら Segoe UI Bold）
    font: { loadSystemFonts: true, defaultFontFamily: "Arial" },
  });
  const png = resvg.render().asPng();
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w !== size || h !== size) throw new Error(`描画サイズが違います: ${w}x${h}（期待 ${size}x${size}）`);
  return png;
}

/** PNG を1枚だけ格納した ICO（Windows Vista 以降・全ブラウザが読める形式） */
function pngToIco(png, size) {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // 画像の数
  header.writeUInt8(size >= 256 ? 0 : size, 6); // 幅（256 は 0）
  header.writeUInt8(size >= 256 ? 0 : size, 7); // 高さ
  header.writeUInt8(0, 8); // パレット数
  header.writeUInt8(0, 9); // reserved
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bpp
  header.writeUInt32LE(png.length, 14); // データ長
  header.writeUInt32LE(6 + 16, 18); // データ位置
  return Buffer.concat([header, png]);
}

for (const a of ASSETS) {
  const png = renderPng(a.size, a.padding, a.background);
  const out = resolve(OUT_DIR, a.file);
  writeFileSync(out, a.ico ? pngToIco(png, a.size) : png);
  console.log(`[icons] ${a.file.padEnd(30)} ${a.size}x${a.size}  ${statSync(out).size} bytes`);
}
console.log("[icons] 完了 → public/");
