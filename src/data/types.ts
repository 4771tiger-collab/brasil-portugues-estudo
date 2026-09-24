// ===== 学習データの型定義 =====

/** 元データ(words.json / capoeira-words.json)の生スキーマ */
export interface RawWord {
  カテゴリ: string;
  ポルトガル語: string;
  日本語: string;
  品詞: string;
}

/** words/capoeira = 同梱の単語帳、dict = 歌詞引き用の一般辞書、user = ユーザーが意味を入力して追加した語 */
export type WordSource = "words" | "capoeira" | "dict" | "user";

/** アプリ内で扱う正規化済みの単語 */
export interface Word {
  /** 安定ID（例: "words:0042"）。ソース内インデックス基準。SRS進捗の紐付けに使用 */
  id: string;
  source: WordSource;
  index: number;
  category: string;
  /** ポルトガル語（表示用。スラッシュ表記をそのまま保持） */
  pt: string;
  /** 日本語訳 */
  ja: string;
  /**
   * 解説（任意）。カポエイラ語の訳が「カタカナの読み（意味）」の形なら、実行時に ja を括弧の中身にし、
   * 元の訳をここに回す（和→葡で読み＝答えが見えないように。データは書き換えない）
   */
  note?: string;
  /** 品詞 */
  pos: string;
  /** 音声合成用に整形したポルトガル語（"/" 除去など） */
  ptForSpeech: string;
  /** カタカナ発音ガイド（自動生成 or 例外辞書） */
  kana: string;
  /** IPA 発音記号（近似・自動生成 or 例外辞書） */
  ipa: string;
}

/** 単語に紐づく例文 */
export interface Example {
  pt: string;
  ja: string;
  kana?: string;
}

/** examples.json の値（単語ID -> 付加情報） */
export interface WordExtra {
  examples?: Example[];
  collocations?: string[];
}

// ===== SRS（間隔反復） =====

/** 学習評価（4段階） */
export type Rating = "again" | "hard" | "good" | "easy";

/** 習熟度レベル */
export type SrsLevel = "new" | "learning" | "young" | "mature";

/** 単語ごとのSRS状態 */
export interface SrsCard {
  ease: number; // 易しさ係数（SM-2）
  intervalDays: number; // 次回までの間隔（日）
  due: string; // 次回復習日（YYYY-MM-DD）
  reps: number; // 連続正解回数
  lapses: number; // 失敗回数
  level: SrsLevel;
  last: string | null; // 最終学習日（YYYY-MM-DD）
}

// ===== 文章系コンテンツ =====

/** パターンプラクティス */
export interface PatternSlotOption {
  pt: string;
  /** 型（Pattern.ja）の {X} に入れる訳 */
  ja: string;
  /**
   * この選択肢を入れた文の自然な和訳（任意）。型に差し込むと崩れる選択肢に書く
   * （「手伝うしてもらえますか？」→「手伝ってもらえますか？」など）。表示は jaFull ?? 型への差し込み
   */
  jaFull?: string;
}
export interface Pattern {
  id: string;
  category: string;
  /** 例: "Eu quero {X}." */
  frame: string;
  /** 例: "私は{X}が欲しい。"（崩れる選択肢には PatternSlotOption.jaFull を書く） */
  ja: string;
  /** スロット名 -> 選択肢 */
  slots: Record<string, PatternSlotOption[]>;
  note?: string;
}

/** チャンクリーディングの1チャンク */
export interface Chunk {
  pt: string;
  ja: string;
}
export interface Passage {
  id: string;
  title: string;
  level: "short" | "medium" | "long";
  source: "original" | "news" | "custom";
  chunks: Chunk[];
  /** 取り込み元メモ（任意） */
  origin?: string;
}

/** シャドーイング用スクリプトの1行（kana省略時は自動生成） */
export interface ScriptLine {
  pt: string;
  kana?: string;
  ja: string;
}
export interface Script {
  id: string;
  title: string;
  description?: string;
  lines: ScriptLine[];
}

/** ディクテーション項目 */
export interface DictationItem {
  id: string;
  level: "short" | "medium" | "long";
  /** 読み上げ・採点対象の本文 */
  text: string;
  ja: string;
  /** 予習用の重要語彙（自由記述。意味付き） */
  keyVocab: { pt: string; ja: string }[];
  /** 会話例か */
  isDialogue?: boolean;
}

/** 単語帳「今日の学習」の表示（1枚ずつのセッション / 一覧） */
export type StudyViewMode = "session" | "list";

/** 1枚ずつ学習の出題方向（表面に出す言語）。mixed は語と日付で決まる */
export type StudyDirection = "pt2ja" | "ja2pt" | "mixed";

/** 耳だけ復習の向き（pt2ja: 葡を聴いて和を思い出す / ja2pt: 和を聴いて葡を言う） */
export type HandsfreeDirection = "pt2ja" | "ja2pt";

/** 設定 */
export interface Settings {
  rate: number; // 既定の再生速度
  dailyNewLimit: number; // 1日の新規語数
  dailyGoal: number; // 1日の学習目標（枚）
  voiceURI: string | null; // 選択中の音声
  showKana: boolean;
  showIpa: boolean;
  /** 曲から追加した単語を「今日の学習」で1日に出す上限 */
  musicNewLimit: number;
  /** 歌詞の単語をタップした時に動画を一時停止する */
  pauseOnWordTap: boolean;
  /** 単語を調べて一時停止した後、シートを閉じたら調べた行の頭から聴き直す（時間同期のある歌詞のみ） */
  replayAfterLookup: boolean;
  /** 「今日の学習」を開いたときの表示（他のデッキは一覧が既定） */
  studyView: StudyViewMode;
  /** 1枚ずつ学習の出題方向 */
  studyDirection: StudyDirection;
  /** 1枚ずつ学習で答えを開いたとき・新しい語の紹介時に発音を自動で再生する */
  autoPlayOnReveal: boolean;
  /** 今日の学習の新しい語に混ぜるカポエイラ語の割合（0〜1。画面の選択肢は 0 / 0.25 / 0.33 / 0.5） */
  capoeiraShare: number;
  /** 1日の復習の上限（枚）。期限の来た復習がこれを超える日は新しい語を出さない */
  dailyReviewLimit: number;
  /** 耳だけ復習の考える間（秒。画面の選択肢は 2 / 3 / 5） */
  handsfreeGapSec: number;
  /** 耳だけ復習の向き */
  handsfreeDirection: HandsfreeDirection;
}
