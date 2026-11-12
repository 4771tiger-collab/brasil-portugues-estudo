// ============================================================================
// 話す練習の採点（言ってみた文 → 点数とおすすめの評価）
//   検証: scripts/check-speak.ts（npm run check:speak）
// 採点そのものは services/grade.ts の scoreSpeechSentence（語ごとの対応・アクセントの違いは数えない）。
// ここでは、話し言葉の短縮形（tô・tá・pra・cê など）で言ったときに減点しないよう、聞き取った文を
// 標準形に直したものも合わせて採点する（教材の文は読み上げのために estou・está・para と書いてあるが、
// 実際の会話では短縮形で言うのがふつう）。
// ============================================================================

import { scoreSpeechSentence, type SpeechSentenceScore } from "../services/grade";
import { normalizeForMT } from "../services/mtNormalize";

/**
 * 言ってみた文の採点。認識の候補そのままと、短縮形を標準形に直したもの（tô → estou、pra → para …）の
 * うち、いちばん合うもので採点する。「聞こえた文」は学習者が言った形のまま返す。
 */
export function scoreSaid(transcripts: readonly string[], answers: string | readonly string[]): SpeechSentenceScore {
  const original = new Map<string, string>();
  const all: string[] = [];
  for (const t of transcripts) {
    all.push(t);
    const n = normalizeForMT(t);
    if (n !== t && !original.has(n)) {
      original.set(n, t);
      all.push(n);
    }
  }
  const s = scoreSpeechSentence(all, answers);
  const said = original.get(s.heard);
  return said && !transcripts.includes(s.heard) ? { ...s, heard: said } : s;
}

/** 採点の中に「別の語に聞こえた語」があるか（vou と fui のように、語数は合っているが形が違うとき） */
export function hasWrongWord(s: SpeechSentenceScore): boolean {
  return s.alignment.tokens.some((t) => t.grade === "wrong");
}
