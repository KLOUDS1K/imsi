/**
 * Font readiness for canvas text. Canvas draws with whatever face is loaded at
 * the moment of the call, so the requested family must be loaded first
 * (FontFaceSet.load). Families from the house style that the page may not have
 * loaded yet (Syncopate, Manrope, Inter) are fetched from Google Fonts on first
 * use; offline, the stack falls back to Inter → system-ui → sans-serif.
 */

const GOOGLE: Record<string, string> = {
  syncopate: 'Syncopate:wght@400;700',
  manrope: 'Manrope:wght@400;500;600;700;800',
  inter: 'Inter:wght@400;500;600;700;800',
};

const FALLBACK = ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Helvetica Neue', 'Arial', 'sans-serif'];
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', '-apple-system']);

/** Split a CSS font-family list into bare family names. */
export function parseFamilies(stack: string): string[] {
  return stack
    .split(',')
    .map((f) => f.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

const quote = (f: string) => (GENERIC.has(f.toLowerCase()) || /^[\w-]+$/.test(f) ? f : `"${f.replace(/"/g, '')}"`);

/** The requested stack followed by the house fallback stack (deduplicated), as a CSS list. */
export function fontStack(requested: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of [...parseFamilies(requested), ...FALLBACK]) {
    const k = f.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(quote(f));
  }
  return out.join(', ');
}

function fontSet(): FontFaceSet | null {
  const g = globalThis as { fonts?: FontFaceSet; document?: Document };
  return g.fonts ?? g.document?.fonts ?? null;
}

const injected = new Set<string>();

function injectGoogleFont(family: string): void {
  const spec = GOOGLE[family.toLowerCase()];
  if (!spec || injected.has(spec) || typeof document === 'undefined' || !document.head) return;
  injected.add(spec);
  const href = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

const timeout = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function hasFace(fonts: FontFaceSet, family: string): boolean {
  const want = family.toLowerCase();
  let found = false;
  fonts.forEach((f) => {
    if (!found && f.family.replace(/^["']|["']$/g, '').toLowerCase() === want) found = true;
  });
  return found;
}

/**
 * Wait (bounded) until the first family of `stack` at `weight` is loaded.
 * Families the document has no @font-face for are either fetched from Google
 * Fonts (house-style families) or assumed to be system fonts. Never throws;
 * resolves after at most `maxWait` ms (offline → fallback stack is used).
 */
const pending = new Map<string, Promise<void>>();

export function ensureFont(stack: string, weight: number, sample = 'KLOUD.PHOTOGRAPHY', maxWait = 3000): Promise<void> {
  // Memoized per request: a font that failed to load offline costs the wait only once.
  const key = `${stack}|${weight}|${sample}`;
  let p = pending.get(key);
  if (!p) {
    p = loadFont(stack, weight, sample, maxWait);
    pending.set(key, p);
  }
  return p;
}

async function loadFont(stack: string, weight: number, sample: string, maxWait: number): Promise<void> {
  const fonts = fontSet();
  if (!fonts) return;
  const first = parseFamilies(stack).find((f) => !GENERIC.has(f.toLowerCase()));
  if (!first) return;
  const desc = `${weight} 48px ${quote(first)}`;
  if (!hasFace(fonts, first)) {
    if (!GOOGLE[first.toLowerCase()]) return; // system / unknown font: nothing to wait for
    injectGoogleFont(first);
  }
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    try {
      if (hasFace(fonts, first)) {
        const left = Math.max(50, deadline - Date.now());
        const faces = await Promise.race([fonts.load(desc, sample), timeout(left).then((): FontFace[] => [])]);
        if (faces.length) return;
      }
    } catch {
      return; // invalid font string → draw with the fallback
    }
    await timeout(100);
  }
}
