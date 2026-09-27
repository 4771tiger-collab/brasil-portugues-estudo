// ============================================================================
// アプリのマーク（ヘッダーなど画面の中で使う）。
// - ホーム画面のアイコンと同じ public/icon.svg（A「会話 × ブラジル」: 緑の角丸に金の吹き出し + 青い天球と白い帯）を
//   画像として表示する。インラインにしないのは、SVG 内のグラデーション等の id が1ページで重複しないようにするため。
// - 形を変えるときは public/icon.svg（角丸）と icon-full.svg（全面塗り・maskable 用）を同じに直し、
//   `npm run icons` で PNG / favicon を作り直す。
// ============================================================================

interface Props {
  /** 1辺の大きさ（px） */
  size?: number;
  className?: string;
  /** 読み上げる名前。無ければ飾り（横にアプリ名がある前提） */
  title?: string;
}

// base は "./"（GitHub Pages のサブパスでも HashRouter なので常にページと同じ階層）
const SRC = `${import.meta.env.BASE_URL}icon.svg`;

export default function AppLogo({ size = 28, className = "", title }: Props) {
  return (
    <img
      src={SRC}
      width={size}
      height={size}
      className={`shrink-0 ${className}`}
      alt={title ?? ""}
      {...(title ? {} : { "aria-hidden": true })}
      draggable={false}
      decoding="async"
    />
  );
}
