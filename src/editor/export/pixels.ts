/**
 * Bit-depth conversions for RenderedImage data.
 */

/**
 * 16-bit → 8-bit with light TPDF dither (±0.5 LSB peak): breaks up the banding
 * that plain truncation of smooth 16-bit gradients produces in 8-bit output.
 * Deterministic (xorshift32 seeded per call) so repeated exports are identical.
 * Alpha is rounded, not dithered.
 */
export function to8bit(src: Uint16Array, dither = true): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(src.length);
  const k = 255 / 65535;
  let s = 0x9e3779b9;
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let n = 0;
      if (dither) {
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        // two 16-bit uniforms → triangular noise in (−0.5, 0.5)
        n = (((s & 0xffff) + (s >>> 16)) / 65536 - 1) * 0.5;
      }
      out[i + c] = src[i + c] * k + n; // Uint8ClampedArray rounds and clamps
    }
    out[i + 3] = src[i + 3] * k;
  }
  return out;
}

/** 8-bit → 16-bit (v · 257 maps 255 → 65535 exactly). */
export function to16bit(src: Uint8ClampedArray | Uint8Array): Uint16Array<ArrayBuffer> {
  const out = new Uint16Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = src[i] * 257;
  return out;
}
