import { getExtra } from "../../data/loadWords";
import type { Word } from "../../data/types";
import { wordContext, type TeacherContext } from "../../services/ai/teacherContext";

/** 🧑‍🏫 単語の文脈（綴り・意味・品詞・カテゴリ・例文1件・解説）。chosen = クイズで間違えて選んだ語 */
export function wordTeacherContext(word: Word, chosen?: Word | null): TeacherContext {
  const ex = getExtra(word)?.examples?.[0];
  return wordContext({
    pt: word.pt,
    ja: word.ja,
    pos: word.pos,
    category: word.category,
    example: ex ? { pt: ex.pt, ja: ex.ja } : null,
    note: word.note,
    chosen: chosen && chosen.id !== word.id ? { pt: chosen.pt, ja: chosen.ja } : null,
  });
}
