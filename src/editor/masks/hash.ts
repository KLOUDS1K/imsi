/**
 * Fast structural hashing for cache keys. Walks JSON-like values (numbers,
 * strings, booleans, arrays, plain objects) and mixes them into two 32-bit
 * lanes (murmur3-style finalizer), which is far cheaper than
 * JSON.stringify + string hashing for large brush strokes.
 */

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

export class Hasher {
  private a = 0x811c9dc5 | 0;
  private b = 0x27d4eb2f | 0;

  private mix(v: number): void {
    let k = Math.imul(v | 0, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    this.a ^= k;
    this.a = (this.a << 13) | (this.a >>> 19);
    this.a = (Math.imul(this.a, 5) + 0xe6546b64) | 0;
    this.b = Math.imul(this.b ^ (v | 0), 0x85ebca6b) + 0x9e3779b9;
    this.b = (this.b << 11) | (this.b >>> 21);
  }

  num(v: number): this {
    if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff) {
      this.mix(0x49);
      this.mix(v);
    } else {
      f64[0] = v;
      this.mix(u32[0]!);
      this.mix(u32[1]!);
    }
    return this;
  }

  str(s: string): this {
    this.mix(0x53 ^ s.length);
    for (let i = 0; i < s.length; i++) this.mix(s.charCodeAt(i));
    return this;
  }

  bool(v: boolean): this {
    this.mix(v ? 0x7401 : 0x6602);
    return this;
  }

  value(v: unknown): this {
    if (v === null || v === undefined) {
      this.mix(v === null ? 0x4e55 : 0x5544);
    } else if (typeof v === 'number') {
      this.num(v);
    } else if (typeof v === 'string') {
      this.str(v);
    } else if (typeof v === 'boolean') {
      this.bool(v);
    } else if (Array.isArray(v)) {
      this.mix(0x5b ^ (v.length << 8));
      for (const item of v) this.value(item);
    } else if (typeof v === 'object') {
      const o = v as Record<string, unknown>;
      // Key order is significant only through the sorted key list, so objects
      // with the same content hash equally regardless of creation order.
      const keys = Object.keys(o).sort();
      this.mix(0x7b ^ (keys.length << 8));
      for (const k of keys) {
        if (o[k] === undefined) continue;
        this.str(k);
        this.value(o[k]);
      }
    }
    return this;
  }

  digest(): string {
    let a = this.a ^ (this.a >>> 16);
    a = Math.imul(a, 0x85ebca6b);
    a ^= a >>> 13;
    let b = this.b ^ (this.b >>> 15);
    b = Math.imul(b, 0xc2b2ae35);
    b ^= b >>> 16;
    return (a >>> 0).toString(36) + (b >>> 0).toString(36);
  }
}

export function hashValue(v: unknown): string {
  return new Hasher().value(v).digest();
}

/**
 * Identity → small integer version. Lets cache keys change when a new source
 * buffer / depth map / AI bitmap object arrives even if its `key` is reused.
 */
export class IdentityVersions {
  private map = new WeakMap<object, number>();
  private next = 1;
  of(o: object | null | undefined): number {
    if (!o) return 0;
    let v = this.map.get(o);
    if (v === undefined) {
      v = this.next++;
      this.map.set(o, v);
    }
    return v;
  }
}
