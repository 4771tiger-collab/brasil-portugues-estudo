import { useEffect, useState } from "react";

/**
 * ネットにつながっているか（navigator.onLine と online / offline イベント）。
 * true でも実際に通信できるとは限らない（失敗は呼び出し側のエラー表示で扱う）。オフラインと分かるときだけ false
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}
