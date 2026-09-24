import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Flashcards from "./pages/Flashcards";
import Quiz from "./pages/Quiz";
import Practice from "./pages/Practice";
import PatternPractice from "./pages/PatternPractice";
import ChunkReading from "./pages/ChunkReading";
import Shadowing from "./pages/Shadowing";
import Dictation from "./pages/Dictation";
import AddMaterial from "./pages/AddMaterial";
import Settings from "./pages/Settings";
import MusicShell from "./pages/music/MusicShell";
import PlaylistView from "./pages/music/PlaylistView";
import SongView from "./pages/music/SongView";

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/flashcards" element={<Flashcards />} />
        <Route path="/flashcards/:deckId" element={<Flashcards />} />
        <Route path="/quiz" element={<Quiz />} />
        <Route path="/quiz/:deckId" element={<Quiz />} />
        <Route path="/practice" element={<Practice />} />
        <Route path="/practice/pattern" element={<PatternPractice />} />
        <Route path="/practice/chunk" element={<ChunkReading />} />
        <Route path="/practice/shadowing" element={<Shadowing />} />
        <Route path="/practice/dictation" element={<Dictation />} />
        <Route path="/practice/add" element={<AddMaterial />} />
        <Route path="/music" element={<MusicShell />}>
          <Route index element={<PlaylistView />} />
          <Route path=":videoId" element={<SongView />} />
        </Route>
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Home />} />
      </Routes>
    </Layout>
  );
}
