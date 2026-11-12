import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Flashcards from "./pages/Flashcards";
import Quiz from "./pages/Quiz";
import Library from "./pages/Library";
import CourseHome from "./pages/course/CourseHome";
import LessonPage from "./pages/course/LessonPage";
import SpeakReview from "./pages/speak/SpeakReview";
import Phrases from "./pages/speak/Phrases";
import SpeakHandsfree from "./pages/speak/SpeakHandsfree";
import TalkHome from "./pages/talk/TalkHome";
import TalkSession from "./pages/talk/TalkSession";
import PatternPractice from "./pages/PatternPractice";
import ConjugationDrill from "./pages/ConjugationDrill";
import ChunkReading, { ChunkReadingDetail } from "./pages/ChunkReading";
import Shadowing, { ShadowingDetail } from "./pages/Shadowing";
import Dictation, { DictationDetail } from "./pages/Dictation";
import AddMaterial from "./pages/AddMaterial";
import Settings from "./pages/Settings";
import MusicShell from "./pages/music/MusicShell";
import PlaylistView from "./pages/music/PlaylistView";
import SongView from "./pages/music/SongView";
import PwaRegistrar from "./pwa/PwaRegistrar";

export default function App() {
  return (
    <>
      {/* Service Worker の登録と更新の検知（1回だけ置く） */}
      <PwaRegistrar />
      <Layout>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/flashcards" element={<Flashcards />} />
          <Route path="/flashcards/:deckId" element={<Flashcards />} />
          <Route path="/quiz" element={<Quiz />} />
          <Route path="/quiz/:deckId" element={<Quiz />} />
          {/* 話す練習（毎日のメニューの中心）: レッスン・口慣らし・AI との会話・フレーズ帳 */}
          <Route path="/course" element={<CourseHome />} />
          <Route path="/course/:id" element={<LessonPage />} />
          <Route path="/speak/review" element={<SpeakReview />} />
          <Route path="/speak/handsfree" element={<SpeakHandsfree />} />
          <Route path="/phrases" element={<Phrases />} />
          <Route path="/talk" element={<TalkHome />} />
          <Route path="/talk/:id" element={<TalkSession />} />
          {/* ライブラリ（単語帳・クイズ・目的別の練習・設定の入口）。/practice は以前の URL */}
          <Route path="/library" element={<Library />} />
          <Route path="/practice" element={<Library />} />
          <Route path="/practice/pattern" element={<PatternPractice />} />
          <Route path="/practice/conjugation" element={<ConjugationDrill />} />
          {/* 練習の詳細は URL で開く（Android の戻る操作で一覧に戻れるように） */}
          <Route path="/practice/chunk" element={<ChunkReading />} />
          <Route path="/practice/chunk/:id" element={<ChunkReadingDetail />} />
          <Route path="/practice/shadowing" element={<Shadowing />} />
          <Route path="/practice/shadowing/:id" element={<ShadowingDetail />} />
          <Route path="/practice/dictation" element={<Dictation />} />
          <Route path="/practice/dictation/:id" element={<DictationDetail />} />
          <Route path="/practice/add" element={<AddMaterial />} />
          <Route path="/music" element={<MusicShell />}>
            <Route index element={<PlaylistView />} />
            <Route path=":videoId" element={<SongView />} />
          </Route>
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </Layout>
    </>
  );
}
