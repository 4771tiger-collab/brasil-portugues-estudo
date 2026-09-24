import patterns from "../../data/patterns.json";
import passages from "../../data/passages.json";
import scripts from "../../data/scripts.json";
import dictation from "../../data/dictation.json";
import type { DictationItem, Passage, Pattern, Script } from "./types";
import { normalizePassage, normalizeScript } from "../services/materials";

// 形は npm run check:content で確かめる。読み物の話題・設問、スクリプトの難易度・種類・話者は任意の項目なので、
// 読み込むときに整える（崩れた設問は落とし、知らない難易度・種類は置かない。画面を落とさないため）
export const PATTERNS = patterns as unknown as Pattern[];
export const PASSAGES: Passage[] = (passages as unknown as Passage[]).map(normalizePassage);
export const SCRIPTS: Script[] = (scripts as unknown as Script[]).map(normalizeScript);
export const DICTATIONS = dictation as unknown as DictationItem[];
