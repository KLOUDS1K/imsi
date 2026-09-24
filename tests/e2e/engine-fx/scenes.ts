/** Deterministic synthetic images (RGBA float, top row first) for engine-fx tests. */

export interface Img {
  width: number;
  height: number;
  data: Float32Array;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussianRng(seed: number): () => number {
  const u = mulberry32(seed);
  return () => {
    const a = Math.max(1e-12, u());
    const b = u();
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
  };
}

export function blank(width: number, height: number, rgb: [number, number, number] = [0, 0, 0]): Img {
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 1;
  }
  return { width, height, data };
}

export function set(img: Img, x: number, y: number, rgb: [number, number, number]) {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgb[0];
  img.data[i + 1] = rgb[1];
  img.data[i + 2] = rgb[2];
  img.data[i + 3] = 1;
}

export function get(img: Img, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** Uniform random colours (texture for clone/crop tests). */
export function randomImage(width: number, height: number, seed = 1): Img {
  const r = mulberry32(seed);
  const img = blank(width, height);
  for (let i = 0; i < width * height; i++) {
    img.data[i * 4] = r();
    img.data[i * 4 + 1] = r();
    img.data[i * 4 + 2] = r();
  }
  return img;
}

/** Flat grey plus Gaussian luma noise and chroma noise. */
export function noisyFlat(width: number, height: number, level: number, lumaSigma: number, chromaSigma: number, seed = 7): Img {
  const g = gaussianRng(seed);
  const img = blank(width, height);
  for (let i = 0; i < width * height; i++) {
    const n = g() * lumaSigma;
    const cr = g() * chromaSigma;
    const cb = g() * chromaSigma;
    img.data[i * 4] = level + n + cr;
    img.data[i * 4 + 1] = level + n - 0.5 * (cr + cb);
    img.data[i * 4 + 2] = level + n + cb;
  }
  return img;
}

/** A small "photograph": sky, sun, building with lit windows, checker, noise. */
export function makeScene(width: number, height: number, seed = 3): Img {
  const g = gaussianRng(seed);
  const img = blank(width, height);
  const horizon = 0.62;
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      let c: [number, number, number];
      if (v < horizon) {
        const t = v / horizon;
        c = [0.3 + 0.55 * t, 0.5 + 0.3 * t, 0.85 - 0.15 * t];
        // Sun with a soft corona.
        const d = Math.hypot((u - 0.22) * width, (v - 0.22) * height) / height;
        if (d < 0.045) c = [1, 0.97, 0.9];
        else c = c.map((k) => k + 0.35 * Math.exp(-(((d - 0.045) / 0.05) ** 2)) * (1 - k)) as typeof c;
      } else {
        const t = (v - horizon) / (1 - horizon);
        const stripe = 0.04 * Math.sin(u * 90 + v * 30);
        c = [0.25 - 0.12 * t + stripe, 0.32 - 0.1 * t + stripe, 0.12 + stripe * 0.5];
      }
      // Building with windows.
      if (u > 0.55 && u < 0.8 && v > 0.22 && v < horizon + 0.02) {
        c = [0.36, 0.37, 0.4];
        const wx = ((u - 0.57) * 40) % 1.6;
        const wy = ((v - 0.26) * 40) % 2.2;
        if (u > 0.57 && u < 0.78 && v > 0.26 && v < horizon - 0.02 && wx < 0.8 && wy < 1.1) c = [0.98, 0.85, 0.55];
      }
      // Checker patch (fine texture + hard edges).
      if (u > 0.06 && u < 0.3 && v > 0.7 && v < 0.94) {
        const k = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0;
        c = k ? [0.92, 0.92, 0.92] : [0.08, 0.1, 0.12];
      }
      // Red and blue test patches.
      if (u > 0.36 && u < 0.46 && v > 0.72 && v < 0.9) c = [0.85, 0.12, 0.1];
      if (u > 0.47 && u < 0.53 && v > 0.72 && v < 0.9) c = [0.1, 0.2, 0.85];
      // A thin dark line across the sky (straighten reference).
      if (Math.abs(v - 0.45 - (u - 0.5) * 0.02) * height < 0.8 && u < 0.5) c = [0.05, 0.05, 0.06];
      const n = g() * 0.012;
      set(img, x, y, [c[0] + n, c[1] + n, c[2] + n]);
    }
  }
  return img;
}

export function stats(data: Float32Array, channel: number, filter?: (i: number) => boolean) {
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let i = 0; i < data.length / 4; i++) {
    if (filter && !filter(i)) continue;
    const v = data[i * 4 + channel];
    s += v;
    s2 += v * v;
    n++;
  }
  const mean = s / Math.max(1, n);
  return { mean, std: Math.sqrt(Math.max(0, s2 / Math.max(1, n) - mean * mean)), n };
}

export function maxAbsDiff(a: Float32Array, b: Float32Array, channels = 4): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    if (i % 4 >= channels) continue;
    m = Math.max(m, Math.abs(a[i] - b[i]));
  }
  return m;
}

/** 8-bit sRGB canvas image of a display-referred float image composited over a checkerboard. */
export function toImageData(img: Img): ImageData {
  const out = new ImageData(img.width, img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const a = Math.min(1, Math.max(0, img.data[i + 3]));
      const bg = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 0.35 : 0.45;
      for (let c = 0; c < 3; c++) {
        const v = img.data[i + c] * a + bg * (1 - a);
        out.data[i + c] = Math.round(Math.min(1, Math.max(0, v)) * 255);
      }
      out.data[i + 3] = 255;
    }
  }
  return out;
}
