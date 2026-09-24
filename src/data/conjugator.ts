// ============================================================================
// 動詞の活用の生成器（アプリで1つだけ作って共有する）
// - 不規則動詞の表（data/verb-irregular.json。"_comment" など "_" で始まる項目は除く）
// - getConjugator(): Conjugator（メモ化）。活用表（ConjugationTable）・活用ドリル・歌詞の原形推定（music.ts）で共通
// 生成した活用は規則からの自動生成（不規則動詞は表の上書き）。画面では「自動生成」と明記する。
// ============================================================================

import irregularRaw from "../../data/verb-irregular.json";
import { Conjugator, type IrregularTable } from "../services/conjugate";

let table: IrregularTable | null = null;
let conjugator: Conjugator | null = null;

/** 不規則動詞の表（メモ化） */
export function irregularTable(): IrregularTable {
  if (!table) {
    table = Object.fromEntries(
      Object.entries(irregularRaw as unknown as Record<string, unknown>).filter(([k]) => !k.startsWith("_"))
    ) as IrregularTable;
  }
  return table;
}

/** 活用の生成器（メモ化。活用形の索引もこの中にたまる） */
export function getConjugator(): Conjugator {
  if (!conjugator) conjugator = new Conjugator(irregularTable());
  return conjugator;
}

/** 不規則動詞の表にある動詞（表の順） */
export function irregularVerbs(): string[] {
  return Object.keys(irregularTable());
}
