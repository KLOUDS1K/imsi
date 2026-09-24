/**
 * Small byte-level helpers shared by the encoders (PNG chunks, JPEG segments,
 * RIFF chunks, TIFF/ICC structures). Everything works on plain Uint8Arrays so
 * the same code runs on the main thread, in the encode worker and in Node tests.
 */

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO-HDLC, the PNG/zip polynomial) over `data[start, end)`. */
export function crc32(data: Uint8Array, start = 0, end = data.length, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const encoder = new TextEncoder();
export const utf8 = (s: string): Uint8Array => encoder.encode(s);

/** Latin-1 / ASCII bytes (chars > 0xff become '?'). Used for 4CCs and ICC ASCII text. */
export function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c > 0xff ? 0x3f : c;
  }
  return out;
}

export function readAscii(data: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && off + i < data.length; i++) s += String.fromCharCode(data[off + i]);
  return s;
}

export const u16be = (d: Uint8Array, o: number) => (d[o] << 8) | d[o + 1];
export const u32be = (d: Uint8Array, o: number) => ((d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) >>> 0;
export const u32le = (d: Uint8Array, o: number) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;

export function putU16be(d: Uint8Array, o: number, v: number): void {
  d[o] = (v >>> 8) & 0xff;
  d[o + 1] = v & 0xff;
}
export function putU32be(d: Uint8Array, o: number, v: number): void {
  d[o] = (v >>> 24) & 0xff;
  d[o + 1] = (v >>> 16) & 0xff;
  d[o + 2] = (v >>> 8) & 0xff;
  d[o + 3] = v & 0xff;
}
export function putU32le(d: Uint8Array, o: number, v: number): void {
  d[o] = v & 0xff;
  d[o + 1] = (v >>> 8) & 0xff;
  d[o + 2] = (v >>> 16) & 0xff;
  d[o + 3] = (v >>> 24) & 0xff;
}

/** Growable big-endian byte writer (ICC profiles are big-endian throughout). */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
    return this;
  }
  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.length, v & 0xffff);
    this.length += 2;
    return this;
  }
  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.length, v >>> 0);
    this.length += 4;
    return this;
  }
  i32(v: number): this {
    this.ensure(4);
    this.view.setInt32(this.length, v | 0);
    this.length += 4;
    return this;
  }
  bytes(b: Uint8Array): this {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
    return this;
  }
  ascii(s: string): this {
    return this.bytes(latin1(s));
  }
  zeros(n: number): this {
    this.ensure(n);
    this.buf.fill(0, this.length, this.length + n);
    this.length += n;
    return this;
  }
  /** Pad with zeros to a multiple of `n`. */
  align(n: number): this {
    const r = this.length % n;
    return r ? this.zeros(n - r) : this;
  }
  setU32(at: number, v: number): void {
    this.view.setUint32(at, v >>> 0);
  }
  toBytes(): Uint8Array<ArrayBuffer> {
    return this.buf.slice(0, this.length);
  }
}

/** Yield to the event loop so long CPU loops on the main thread keep the UI responsive. */
export const yieldToEventLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
