import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { PLAYLISTS, formatDuration } from "../../data/music";
import { thumbnailUrl, YT_STATE } from "../../services/youtube";
import { useMusic } from "../../store/useMusic";
import { useMusicPlayer } from "./MusicShell";

export default function PlaylistView() {
  const navigate = useNavigate();
  const player = useMusicPlayer();
  const songsState = useMusic((s) => s.songs);
  const addedWords = useMusic((s) => s.addedWords);

  const addedByVideo = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const w of addedWords) {
      if (!m.has(w.videoId)) m.set(w.videoId, new Set());
      m.get(w.videoId)!.add(w.id);
    }
    return m;
  }, [addedWords]);

  function open(videoId: string) {
    // 再生中（一時停止中）の曲はそのまま歌詞画面へ。それ以外はタップの中で再生を要求（モバイルの自動再生制限対策）
    const alreadyLoaded =
      player.currentVideoId === videoId && !player.error && player.playerState !== YT_STATE.ENDED;
    if (!alreadyLoaded) player.playSong(videoId);
    navigate(`/music/${videoId}`);
  }

  return (
    <div className="animate-fade-in space-y-4">
      <div>
        <h1 className="text-xl font-bold text-brand-ink">音楽</h1>
        <p className="text-sm text-slate-500">
          ブラジルの歌を聴きながら、同期歌詞・和訳・歌詞の単語でインプット。
        </p>
      </div>

      {PLAYLISTS.map((pl) => (
        <section key={pl.id} className="space-y-2">
          <div className="flex items-baseline justify-between px-1">
            <h2 className="text-sm font-bold text-slate-500">
              🎵 {pl.title} <span className="font-normal text-slate-400">{pl.songs.length}曲</span>
            </h2>
            <a href={pl.url} target="_blank" rel="noreferrer" className="text-xs text-brand-blue">
              YouTube ›
            </a>
          </div>
          <div className="space-y-2">
            {pl.songs.map((s, i) => {
              const translated = Object.keys(songsState[s.videoId]?.translations ?? {}).length > 0;
              const added = addedByVideo.get(s.videoId)?.size ?? 0;
              const playing = player.currentVideoId === s.videoId;
              return (
                <button
                  key={s.videoId}
                  onClick={() => open(s.videoId)}
                  className={`card flex w-full items-center gap-3 p-2 pr-3 text-left transition hover:ring-brand-green/40 ${
                    playing ? "ring-2 ring-brand-green" : ""
                  }`}
                >
                  <div className="relative h-14 w-24 shrink-0 overflow-hidden rounded-lg bg-slate-200">
                    <img src={thumbnailUrl(s.videoId)} alt="" loading="lazy" className="h-full w-full object-cover" />
                    <span className="absolute bottom-0.5 right-0.5 rounded bg-black/70 px-1 text-[10px] text-white">
                      {formatDuration(s.durationSec)}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-brand-ink">
                      <span className="mr-1 text-xs text-slate-400">{i + 1}.</span>
                      {s.title}
                    </div>
                    <div className="truncate text-xs text-slate-500">{s.artist}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {playing && <span className="chip bg-brand-green/10 text-brand-green">♪ 再生中</span>}
                      {translated && <span className="chip bg-blue-50 text-blue-600">和訳あり</span>}
                      {added > 0 && <span className="chip bg-amber-50 text-amber-600">単語 {added}</span>}
                    </div>
                  </div>
                  <span className="text-slate-300">›</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <p className="px-1 text-xs leading-relaxed text-slate-400">
        ※ 歌詞は再生時に LRCLIB から取得し、この端末にだけ保存します（アプリには同梱していません）。
        和訳は端末から無料の機械翻訳を呼び出して作成し、自分で修正できます。
        音楽タブを離れる・画面をロックすると再生は止まります。
      </p>
    </div>
  );
}
