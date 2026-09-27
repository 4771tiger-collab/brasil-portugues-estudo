import { useLocation } from "react-router-dom";
import { SONG_BY_ID } from "../data/music";
import { screenNameFor } from "../services/ai/teacherContext";

/** 今の画面の名前（AI 先生の「いま開いている画面」。曲の画面は曲名つき） */
export function useScreenName(): string {
  const { pathname } = useLocation();
  const m = /^\/music\/([^/]+)/.exec(pathname);
  let title: string | null = null;
  if (m) {
    try {
      title = SONG_BY_ID.get(decodeURIComponent(m[1]))?.title ?? null;
    } catch {
      title = null;
    }
  }
  return screenNameFor(pathname, title);
}
