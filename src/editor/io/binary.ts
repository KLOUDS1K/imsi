/**
 * Tiny binary helpers shared by the header parsers (JPEG, TIFF, PNG, ISOBMFF).
 * All readers are bounds-checked by the callers; these helpers never allocate.
 */

export const u16be = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];
export const u16le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);
export const u32be = (b: Uint8Array, o: number): number => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
export const u32le = (b: Uint8Array, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

export function ascii(b: Uint8Array, o: number, n: number): string {
  let s = '';
  const end = Math.min(b.length, o + n);
  for (let i = o; i < end; i++) s += String.fromCharCode(b[i]);
  return s;
}

/** Index of `needle` in `hay` at or after `from`, or -1. */
export function indexOfBytes(hay: Uint8Array, needle: ArrayLike<number>, from = 0, to = hay.length): number {
  const n = needle.length;
  if (n === 0) return from;
  const first = needle[0];
  let i = from;
  const last = Math.min(to, hay.length) - n;
  while (i <= last) {
    i = hay.indexOf(first, i);
    if (i < 0 || i > last) return -1;
    let k = 1;
    while (k < n && hay[i + k] === needle[k]) k++;
    if (k === n) return i;
    i++;
  }
  return -1;
}

/** Read the first `n` bytes of a blob (whole blob when smaller). */
export async function readHead(blob: Blob, n: number): Promise<Uint8Array> {
  const part = blob.size > n ? blob.slice(0, n) : blob;
  return new Uint8Array(await part.arrayBuffer());
}

export async function readAll(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Throw a DOMException('AbortError') when the signal is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new DOMException('Decode aborted', 'AbortError');
  }
}

export function isAbortError(e: unknown): boolean {
  return (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';
}

let idCounter = 0;
export function newSourceId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return 'src-' + c.randomUUID();
  idCounter++;
  return `src-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
