// ============================================================================
// コース（場面別レッスン）の教材: data/course/u1.json 〜 u6.json
// 各レッスンは「会話を聞く → まねる → 日本語を見て言う → 役になって言う → AI と自由に話す」で進む。
// phrases は「口慣らし」（文の間隔反復。src/speak/）に入る文。フレーズの id は記録のキーなので変えない。
//   検証: scripts/check-course.ts（npm run check:course）
// ============================================================================

import u1 from "../../data/course/u1.json";
import u2 from "../../data/course/u2.json";
import u3 from "../../data/course/u3.json";
import u4 from "../../data/course/u4.json";
import u5 from "../../data/course/u5.json";
import u6 from "../../data/course/u6.json";

/** 会話の1行（you = 学習者 / partner = 相手） */
export interface LessonLine {
  who: "you" | "partner";
  pt: string;
  ja: string;
}

/** 「日本語を見て → ポルトガル語を言う」文 */
export interface LessonPhrase {
  id: string;
  ja: string;
  pt: string;
  /** 同じ意味で言ってよい別の言い方（性別の違い・言い換え） */
  alt?: string[];
  note?: string;
}

export interface LessonTip {
  title: string;
  body: string;
}

/** 同じ場面で AI と話すときの設定 */
export interface LessonTalk {
  role: string;
  setting: string;
  /** 相手（AI）の最初のひとこと */
  opener: string;
  missions: string[];
}

export interface Lesson {
  id: string;
  unitId: string;
  /** コース全体での番号（1 始まり） */
  no: number;
  title: string;
  goal: string;
  scene: string;
  partner: string;
  lines: LessonLine[];
  phrases: LessonPhrase[];
  tips: LessonTip[];
  talk: LessonTalk;
}

export interface Unit {
  id: string;
  /** ユニットの番号（1 始まり） */
  no: number;
  title: string;
  goal: string;
  lessons: Lesson[];
}

type RawLesson = Omit<Lesson, "unitId" | "no" | "tips"> & { tips?: LessonTip[] };
interface RawUnit {
  id: string;
  title: string;
  goal: string;
  lessons: RawLesson[];
}

/** JSON のユニットに、番号と所属を付ける */
export function buildUnits(raw: readonly RawUnit[]): Unit[] {
  let no = 0;
  return raw.map((u, ui) => ({
    id: u.id,
    no: ui + 1,
    title: u.title,
    goal: u.goal,
    lessons: u.lessons.map((l) => ({ ...l, tips: l.tips ?? [], unitId: u.id, no: ++no })),
  }));
}

export const UNITS: Unit[] = buildUnits([u1, u2, u3, u4, u5, u6] as unknown as RawUnit[]);
export const LESSONS: Lesson[] = UNITS.flatMap((u) => u.lessons);
export const LESSON_BY_ID: ReadonlyMap<string, Lesson> = new Map(LESSONS.map((l) => [l.id, l]));
export const UNIT_BY_ID: ReadonlyMap<string, Unit> = new Map(UNITS.map((u) => [u.id, u]));

/** 次のレッスン（最後なら null） */
export function nextLesson(id: string): Lesson | null {
  const l = LESSON_BY_ID.get(id);
  return l ? LESSONS[l.no] ?? null : null;
}
