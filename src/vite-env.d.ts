/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/react" />

/** package.json の version（vite.config.ts の define で埋め込み） */
declare const __APP_VERSION__: string;
/** git の短い SHA（取得できない時は "dev"） */
declare const __BUILD_ID__: string;
/** ビルド時刻 ISO 文字列 */
declare const __BUILD_TIME__: string;
