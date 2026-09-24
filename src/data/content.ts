import patterns from "../../data/patterns.json";
import passages from "../../data/passages.json";
import scripts from "../../data/scripts.json";
import dictation from "../../data/dictation.json";
import type { DictationItem, Passage, Pattern, Script } from "./types";

export const PATTERNS = patterns as Pattern[];
export const PASSAGES = passages as Passage[];
export const SCRIPTS = scripts as Script[];
export const DICTATIONS = dictation as DictationItem[];
