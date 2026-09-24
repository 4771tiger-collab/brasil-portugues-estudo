interface Props {
  visible: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  className?: string;
}

/** タップで個別に隠す/表示する暗記シート風テキスト */
export default function Maskable({ visible, onToggle, children, className = "" }: Props) {
  return (
    <span
      className={`maskable inline-block rounded px-0.5 ${className}`}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      title={visible ? "タップで隠す" : "タップで表示"}
    >
      {visible ? (
        children
      ) : (
        <span className="select-none rounded bg-slate-200 text-transparent">{children}</span>
      )}
    </span>
  );
}
