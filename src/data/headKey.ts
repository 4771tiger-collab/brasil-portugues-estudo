// ============================================================================
// 見出しの比較用キー（純関数。ブラウザ・Node の両方から使う）
//   もとは scripts/dict-common.ts にあった。scripts 側は再 export している。
// ============================================================================

/** 見出しの比較用キー（NFC・小文字・括弧注記除去・前後の記号除去） */
export function headKey(pt: string): string {
  return pt
    .normalize("NFC")
    .toLowerCase()
    .replace(/[’ʼ‘]/g, "'")
    .replace(/\s*[（(][^）)]*[）)]\s*/g, " ")
    .replace(/^[¿¡?!.,;:…\s]+|[¿¡?!.,;:…\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "meu/minha" → ["meu","minha"] */
export function headKeys(pt: string): string[] {
  const k = headKey(pt);
  const parts = k.split("/").map((x) => x.trim());
  return parts.length > 1 && parts.every(Boolean) ? parts : [k];
}
