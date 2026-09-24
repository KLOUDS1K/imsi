/**
 * Synthetic LINEAR sRGB test images (RGBA float, row 0 = top).
 */
import { srgbToLinear } from '../../../src/editor/color/math';

export type Rgb = [number, number, number];

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function flat(w: number, h: number, rgb: Rgb): Float32Array {
  const d = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) d.set([rgb[0], rgb[1], rgb[2], 1], i * 4);
  return d;
}

/** Each row is a ramp 0..1 in x; rows cycle through grey, r, g, b, and mixed colour ramps. */
export function ramps(w: number, h: number): Float32Array {
  const d = new Float32Array(w * h * 4);
  const tints: Rgb[] = [
    [1, 1, 1],
    [1, 0.2, 0.1],
    [0.1, 1, 0.3],
    [0.2, 0.3, 1],
    [1, 0.8, 0.5],
    [0.5, 0.9, 1],
  ];
  for (let y = 0; y < h; y++) {
    const t = tints[y % tints.length];
    for (let x = 0; x < w; x++) {
      const v = x / (w - 1);
      d.set([v * t[0], v * t[1], v * t[2], 1], (y * w + x) * 4);
    }
  }
  return d;
}

const CHECKER_SRGB8: Rgb[] = [
  [115, 82, 68], [194, 150, 130], [98, 122, 157], [87, 108, 67], [133, 128, 177], [103, 189, 170],
  [214, 126, 44], [80, 91, 166], [193, 90, 99], [94, 60, 108], [157, 188, 64], [224, 163, 46],
  [56, 61, 150], [70, 148, 73], [175, 54, 60], [231, 199, 31], [187, 86, 149], [8, 133, 161],
  [243, 243, 242], [200, 200, 200], [160, 160, 160], [122, 122, 121], [85, 85, 85], [52, 52, 52],
];
export const CHECKER_LINEAR: Rgb[] = CHECKER_SRGB8.map((c) => c.map((v) => srgbToLinear(v / 255)) as Rgb);

/** Smooth value noise in [0,1]. */
function valueNoise(seed: number, cell: number) {
  const rnd = mulberry32(seed);
  const n = 64;
  const grid = new Float32Array(n * n).map(() => rnd());
  const at = (i: number, j: number) => grid[(((j % n) + n) % n) * n + (((i % n) + n) % n)];
  return (x: number, y: number) => {
    const fx = x / cell;
    const fy = y / cell;
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const u = fx - i;
    const v = fy - j;
    const su = u * u * (3 - 2 * u);
    const sv = v * v * (3 - 2 * v);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * su;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * su;
    return a + (b - a) * sv;
  };
}

/**
 * A small "landscape" exercising every develop control: deep blue → hazy
 * sky with clouds and a sun above 1.0, three hazy ridges, textured grass,
 * a dark building with lit windows against the sky (halo test), a skin-tone
 * patch with fine texture, a grey card, a 24-patch colour checker, a thin
 * bright branch with purple/green fringes, and sensor-like noise.
 */
export function photo(w: number, h: number, seed = 7): Float32Array {
  const d = new Float32Array(w * h * 4);
  const rnd = mulberry32(seed);
  const cloud = valueNoise(seed + 1, w / 10);
  const cloud2 = valueNoise(seed + 2, w / 30);
  const grass = valueNoise(seed + 3, 3);
  const grass2 = valueNoise(seed + 4, w / 40);
  const skinN = valueNoise(seed + 5, 1.6);
  const horizon = 0.5 * h;
  const air: Rgb = [0.62, 0.66, 0.72];
  const ridge = (x: number, k: number) =>
    horizon - h * (0.06 + 0.05 * k) + Math.sin((x / w) * (5 + k * 3) + k) * h * 0.04 + Math.sin((x / w) * (17 + 5 * k)) * h * 0.012;
  const sunX = 0.3 * w;
  const sunY = 0.22 * h;
  const gauss = () => {
    const u = Math.max(rnd(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const put = (x: number, y: number, c: Rgb) => d.set([c[0], c[1], c[2], 1], (y * w + x) * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c: Rgb;
      const ty = y / horizon;
      // Sky: deep blue at top, pale & hazy at the horizon.
      c = [0.08 + 0.5 * ty * ty, 0.16 + 0.48 * ty * ty, 0.45 + 0.25 * ty];
      const cl = Math.max(0, cloud(x, y * 2.2) * 0.8 + cloud2(x, y * 2) * 0.35 - 0.62) * 2.2;
      c = c.map((v) => v + (0.85 - v) * Math.min(cl, 1)) as Rgb;
      const sd = Math.hypot(x - sunX, y - sunY) / (0.05 * w);
      const sun = 3.5 * Math.exp(-sd * sd) + 0.35 * Math.exp(-sd * 0.25);
      c = [c[0] + sun * 1.0, c[1] + sun * 0.92, c[2] + sun * 0.75];
      // Ridges (far → near), each hazier with distance.
      for (let k = 0; k < 3; k++) {
        if (y > ridge(x, 2 - k)) {
          const haze = [0.75, 0.5, 0.25][k];
          const base: Rgb = k === 2 ? [0.05, 0.07, 0.04] : [0.06, 0.09, 0.07];
          const tex = 0.7 + 0.6 * grass2(x + k * 100, y);
          c = base.map((v, i) => v * tex * (1 - haze) + air[i] * haze) as Rgb;
        }
      }
      // Ground.
      if (y > h * 0.62) {
        const g = 0.6 + 0.5 * grass(x, y) + 0.4 * grass2(x, y);
        c = [0.035 * g, 0.075 * g, 0.02 * g];
      }
      // Building with windows against the sky (hard, high-contrast edges).
      if (x > 0.78 * w && x < 0.92 * w && y > 0.18 * h && y < h * 0.62) {
        c = [0.012, 0.012, 0.015];
        const wx = (x - 0.78 * w) % 14;
        const wy = (y - 0.18 * h) % 18;
        if (wx > 4 && wx < 10 && wy > 5 && wy < 12) c = [1.2, 0.95, 0.6];
      }
      put(x, y, c);
    }
  }
  // Colour checker (6×4) + grey card, bottom left.
  const ps = Math.max(8, Math.round(w / 28));
  const x0 = Math.round(w * 0.03);
  const y0 = h - ps * 4 - Math.round(h * 0.04);
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 6; i++) {
      const col = CHECKER_LINEAR[j * 6 + i];
      for (let y = y0 + j * ps + 1; y < y0 + (j + 1) * ps - 1; y++)
        for (let x = x0 + i * ps + 1; x < x0 + (i + 1) * ps - 1; x++) put(x, y, col);
    }
  const gx = x0 + ps * 6 + ps / 2;
  for (let y = y0; y < y0 + ps * 4; y++) for (let x = gx; x < gx + ps * 2; x++) put(Math.round(x), y, [0.18, 0.18, 0.18]);
  // Skin patch (oval) with fine pore-like texture.
  const sx = w * 0.55;
  const sy = h * 0.8;
  for (let y = Math.round(sy - h * 0.12); y < sy + h * 0.12; y++)
    for (let x = Math.round(sx - w * 0.07); x < sx + w * 0.07; x++) {
      const e = ((x - sx) / (w * 0.07)) ** 2 + ((y - sy) / (h * 0.12)) ** 2;
      if (e > 1) continue;
      const shade = 0.75 + 0.35 * (1 - e) + 0.06 * (skinN(x, y) - 0.5);
      put(x, y, [0.42 * shade, 0.24 * shade, 0.17 * shade]);
    }
  // Thin bright branch across the upper sky with purple fringe above and green below.
  for (let x = Math.round(w * 0.45); x < w * 0.7; x++) {
    const yc = Math.round(h * 0.08 + (x - w * 0.45) * 0.25);
    put(x, yc, [2.5, 2.5, 2.4]);
    put(x, yc + 1, [2.2, 2.2, 2.1]);
    put(x, yc - 1, [0.55, 0.12, 0.75]);
    put(x, yc - 2, [0.3, 0.08, 0.45]);
    put(x, yc + 2, [0.12, 0.45, 0.1]);
  }
  // Sensor-like noise: read noise + shot noise.
  for (let i = 0; i < w * h; i++) {
    for (let k = 0; k < 3; k++) {
      const v = d[i * 4 + k];
      d[i * 4 + k] = Math.max(0, v + gauss() * (0.0015 + 0.012 * Math.sqrt(Math.max(v, 0))));
    }
  }
  return d;
}
