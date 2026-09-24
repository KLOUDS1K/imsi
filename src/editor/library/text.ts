/**
 * Search text folding: case- and diacritic-insensitive ("Café" ≈ "cafe",
 * "ÅLESUND" ≈ "alesund"). NFKD also makes full-width characters match their
 * ASCII forms and decomposes Hangul syllables consistently on both sides.
 */

const MARKS = /\p{M}+/gu;

export function foldText(s: string): string {
  return s.normalize('NFKD').replace(MARKS, '').toLowerCase();
}

/**
 * Split a query into folded terms. Double-quoted phrases stay together
 * (`"seoul night" 2026` → ['seoul night', '2026']). All terms must match (AND).
 */
export function parseSearchTerms(text: string | undefined): string[] {
  if (!text) return [];
  const terms: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    if (raw) terms.push(foldText(raw));
  }
  return terms;
}
