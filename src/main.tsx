// 端末まわり（beforeinstallprompt の受け取り）は描画より前に始める → 必ず先頭で読み込む
import { requestPersistOnce } from "./services/platform";
import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { useProgress } from "./store/useProgress";
import "./index.css";

// 最初の評価（totalReviews の増加）の後に、保存領域の保護を1回だけ要求する
useProgress.subscribe((s, prev) => {
  if (s.totalReviews > prev.totalReviews) void requestPersistOnce();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
