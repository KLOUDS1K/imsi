/** Device heuristics used at startup. */

/** Small screens / coarse pointers / low memory get a lighter preview proxy. */
export function isConstrainedDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const shortSide = Math.min(window.screen?.width ?? window.innerWidth, window.screen?.height ?? window.innerHeight);
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return (coarse && shortSide < 820) || (typeof mem === 'number' && mem <= 4);
}

/** Long edge of the Develop preview proxy: 2560 on desktop, 1600 on phones/tablets/low memory. */
export function previewMaxSize(): number {
  return isConstrainedDevice() ? 1600 : 2560;
}

/** Monotonic, session-unique id factory ("mask-l3k2f0-1a"). */
export function createIdFactory(): (prefix?: string) => string {
  let n = 0;
  const session = Math.random().toString(36).slice(2, 6);
  return (prefix = 'id') => `${prefix}-${Date.now().toString(36)}${session}-${(n++).toString(36)}`;
}
