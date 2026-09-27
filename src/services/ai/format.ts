// ============================================================================
// AI 先生の返事を画面の部品に分ける（純関数。HTML は解釈しない）
//   検証: scripts/check-ai.ts（npm run check:ai）
// - parseTeacherText(text): 段落・見出し（# …）・箇条書き（- / * / ・ / •）・番号付き（1. / 1)）・
//   例文（「🇧🇷 」の行と、次の「🇯🇵 」の行の組 → 例文カード）に分ける。
// - parseInline(text): **太字**・*斜体*・`コード` だけを印にする（閉じていない印は文字のまま）。
// - HTML のタグ・実体参照は解釈せず、ただの文字として返す（画面は React の文字として出し、
//   HTML として差し込むことはしない）。返事の途中（受信中）の文でもそのまま分けられる。
// ============================================================================

/** 文の一部（b = 太字、i = 斜体、code = コード） */
export interface Span {
  text: string;
  b?: true;
  i?: true;
  code?: true;
}

export type TeacherBlock =
  /** 段落（行ごとの配列。画面では改行で区切る） */
  | { kind: "p"; lines: Span[][] }
  | { kind: "h"; spans: Span[] }
  | { kind: "ul"; items: Span[][] }
  | { kind: "ol"; start: number; items: Span[][] }
  /** 例文（ja は次の行の 🇯🇵。無ければ null） */
  | { kind: "example"; pt: string; ja: string | null };

const BR = "🇧🇷";
const JP = "🇯🇵";
/** 行頭の箇条書きの印・番号（例文の行の前に付いていても外す） */
const LEAD = String.raw`^\s*(?:(?:[-*•・]|\d{1,2}[.)])\s*)?`;
const BR_LINE = new RegExp(`${LEAD}${BR}\\s*[:：]?\\s*`, "u");
const JP_LINE = new RegExp(`${LEAD}${JP}\\s*[:：]?\\s*`, "u");
const BULLET = /^\s*(?:[-*•]\s+|・\s*)(.*)$/u;
const ORDERED = /^\s*(\d{1,3})[.)]\s+(.*)$/u;
const HEADING = /^\s*#{1,6}\s+(.*)$/u;
const INLINE = /\*\*([^*\n]+?)\*\*|`([^`\n]+)`|\*(?![\s*])([^*\n]+?)(?<!\s)\*/gu;

/** **太字**・*斜体*・`コード` を印にする（閉じていない印・HTML は文字のまま） */
export function parseInline(text: string): Span[] {
  const out: Span[] = [];
  let pos = 0;
  const push = (s: Span) => {
    if (!s.text) return;
    const last = out[out.length - 1];
    if (last && !!last.b === !!s.b && !!last.i === !!s.i && !!last.code === !!s.code) last.text += s.text;
    else out.push(s);
  };
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > pos) push({ text: text.slice(pos, at) });
    if (m[1] !== undefined) push({ text: m[1], b: true });
    else if (m[2] !== undefined) push({ text: m[2], code: true });
    else push({ text: m[3], i: true });
    pos = at + m[0].length;
  }
  if (pos < text.length) push({ text: text.slice(pos) });
  return out;
}

/** 印を外した文字だけ（例文の読み上げ・カナに使う） */
export function plainText(text: string): string {
  return parseInline(text)
    .map((s) => s.text)
    .join("")
    .replace(/\*\*/g, "")
    .trim();
}

/** 返事を部品に分ける */
export function parseTeacherText(text: string): TeacherBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: TeacherBlock[] = [];
  let para: Span[][] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "p", lines: para });
    para = [];
  };
  /** 直前の部品が同じ種類のリストなら、そこに足す */
  const pushItem = (kind: "ul" | "ol", spans: Span[], start = 1) => {
    flush();
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) last.items.push(spans);
    else blocks.push(kind === "ul" ? { kind, items: [spans] } : { kind, start, items: [spans] });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) {
      flush();
      continue;
    }
    // 例文: 🇧🇷 の行（同じ行に 🇯🇵 があれば、そこから後ろが意味）。次の行（空行を1つまで飛ばす）の 🇯🇵 が意味
    const br = BR_LINE.exec(line);
    if (br) {
      flush();
      let rest = line.slice(br[0].length);
      let ja: string | null = null;
      const same = rest.indexOf(JP);
      if (same >= 0) {
        ja = rest.slice(same + JP.length).replace(/^\s*[:：]?\s*/u, "");
        rest = rest.slice(0, same);
      } else {
        let j = i + 1;
        if (j < lines.length && !lines[j].trim() && j + 1 < lines.length && JP_LINE.test(lines[j + 1])) j++;
        const jp = j < lines.length ? JP_LINE.exec(lines[j]) : null;
        if (jp) {
          ja = lines[j].slice(jp[0].length);
          i = j;
        }
      }
      const pt = plainText(rest);
      const jaText = ja === null ? null : plainText(ja);
      if (pt) blocks.push({ kind: "example", pt, ja: jaText || null });
      else if (jaText) para.push(parseInline(jaText));
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "h", spans: parseInline(h[1].replace(/^\*\*(.*)\*\*$/u, "$1")) });
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      pushItem("ul", parseInline(b[1]));
      continue;
    }
    const o = ORDERED.exec(line);
    if (o) {
      pushItem("ol", parseInline(o[2]), Number(o[1]));
      continue;
    }
    // 🇯🇵 だけの行（前に 🇧🇷 が無い）は、印を外した普通の文として出す
    const jp = JP_LINE.exec(line);
    para.push(parseInline(jp ? `${JP} ${line.slice(jp[0].length)}` : line.trim()));
  }
  flush();
  return blocks;
}
