// 端末まわり（beforeinstallprompt の受け取り）は描画より前に始める → 必ず先頭で読み込む
import { requestPersistOnce } from "./services/platform";
import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { useProgress } from "./store/useProgress";
import { useSpeak } from "./store/useSpeak";
import "./index.css";

// 最初の評価（totalReviews の増加）の後に、保存領域の保護を1回だけ要求する
useProgress.subscribe((s, prev) => {
  if (s.totalReviews > prev.totalReviews) void requestPersistOnce();
});
// 話す練習だけをしている人（単語を評価していない人）の記録も守る: 文の評価・レッスン・自分の文が増えたら要求する
useSpeak.subscribe((s, prev) => {
  if (s.cards !== prev.cards || s.lessons !== prev.lessons || s.phrases !== prev.phrases) void requestPersistOnce();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
