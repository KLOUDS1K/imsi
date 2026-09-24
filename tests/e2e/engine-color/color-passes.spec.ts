/**
 * engine-color GPU tests: PRE → DEVELOP (→ LOCAL) run by the self-contained
 * WebGL2 runner in harness.ts (SwiftShader in CI).
 *
 *   PW_PORT=5201 npx playwright test tests/e2e/engine-color
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import type { RunResult, RunSpec } from './harness';

const HARNESS = '/tests/e2e/engine-color/harness.html';

const srgbToLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const linearToSrgb = (v: number) => (v <= 0 ? 0 : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-9) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

let page: Page;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e));
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__kc && (window.__kc.ready || window.__kc.error), null, { timeout: 60_000 });
  const err = await page.evaluate(() => window.__kc.error ?? null);
  expect(err, 'WebGL2 + EXT_color_buffer_float available').toBeNull();
});

test.afterAll(async () => {
  await page?.close();
});

const run = (spec: RunSpec): Promise<RunResult> => page.evaluate((s) => window.__kc.run(s), spec);
const px = (r: RunResult, x: number, y: number) => {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2]] as [number, number, number];
};
const flat = (rgb: [number, number, number], params?: RunSpec['params'], extra: Partial<RunSpec> = {}): RunSpec => ({
  width: 16,
  height: 16,
  image: { kind: 'flat', rgb },
  params,
  ...extra,
});
const centre = async (spec: RunSpec) => px(await run(spec), 8, 8);

test('all colour passes compile', async () => {
  const names = await page.evaluate(() => window.__kc.compileAll());
  expect(names).toEqual(
    expect.arrayContaining(['color.pre', 'color.develop', 'color.local', 'color.guide.linear', 'color.guide.display', 'color.fringe.source', 'color.detail.source']),
  );
});

test('REQ 1: default PRE → DEVELOP is linearToSrgb (16f and 32f targets)', async () => {
  for (const precision of ['16f', '32f'] as const) {
    const spec: RunSpec = { width: 256, height: 6, image: { kind: 'ramps' }, precision };
    const r = await run(spec);
    expect(r.skipped).toContain('pre');
    const input = await page.evaluate(() => {
      const d: number[] = [];
      const tints = [[1, 1, 1], [1, 0.2, 0.1], [0.1, 1, 0.3], [0.2, 0.3, 1], [1, 0.8, 0.5], [0.5, 0.9, 1]];
      for (let y = 0; y < 6; y++) for (let x = 0; x < 256; x++) for (let k = 0; k < 3; k++) d.push((x / 255) * tints[y][k]);
      return d;
    });
    let maxErr = 0;
    for (let i = 0; i < 256 * 6; i++)
      for (let k = 0; k < 3; k++) maxErr = Math.max(maxErr, Math.abs(r.data[i * 4 + k] - linearToSrgb(input[i * 3 + k])));
    expect(maxErr, `max error (${precision})`).toBeLessThan(1e-3);
  }
});

test('REQ 1: LOCAL with a default mask is skipped and, if run anyway, exact', async () => {
  const base: RunSpec = { width: 64, height: 32, image: { kind: 'photo' }, scale: 1 };
  const dev = await run(base);
  const skipped = await run({ ...base, stages: ['pre', 'develop', 'local'], mask: {} });
  expect(skipped.skipped).toContain('local');
  const forced = await run({ ...base, stages: ['pre', 'develop', 'local'], mask: {}, forceLocal: true });
  expect(forced.skipped).not.toContain('local');
  let maxErr = 0;
  for (let i = 0; i < dev.data.length; i++) maxErr = Math.max(maxErr, Math.abs(dev.data[i] - forced.data[i]));
  expect(maxErr).toBe(0);
  // Adjustments present but zero coverage: bit-exact passthrough.
  const uncovered = await run({ ...base, stages: ['pre', 'develop', 'local'], mask: { coverage: 'none', adjustments: { exposure: 1, clarity: 50 } } });
  expect(uncovered.skipped).not.toContain('local');
  for (let i = 0; i < dev.data.length; i++) if (dev.data[i] !== uncovered.data[i]) throw new Error(`uncovered pixel changed at ${i}`);
  // Full coverage but zero amount is an identity too.
  const zeroAmt = await run({ ...base, stages: ['pre', 'develop', 'local'], mask: { amount: 0, adjustments: { exposure: 2 } } });
  expect(zeroAmt.skipped).toContain('local');
});

test('REQ 2: exposure +1 EV doubles linear mid-grey', async () => {
  const [r, g, b] = await centre(flat([0.18, 0.18, 0.18], { basic: { exposure: 1 } }));
  for (const v of [r, g, b]) expect(Math.abs(v - linearToSrgb(0.36))).toBeLessThan(1e-3);
  const [r2] = await centre(flat([0.18, 0.18, 0.18], { basic: { exposure: -1 } }));
  expect(Math.abs(r2 - linearToSrgb(0.09))).toBeLessThan(1e-3);
});

test('REQ 3: WB from tempTintFromNeutral renders the sample neutral', async () => {
  for (const sample of [
    [0.3, 0.25, 0.18],
    [0.12, 0.2, 0.3],
    [0.05, 0.045, 0.06],
  ] as [number, number, number][]) {
    const wb = await page.evaluate((s) => window.__kc.tempTintFromNeutral(s), sample);
    const [r, g, b] = await centre(flat(sample, { whiteBalance: { mode: 'custom', temperature: wb.temperature, tint: wb.tint } }));
    expect(Math.abs(r - g), `R≈G for ${sample}`).toBeLessThan(2e-3);
    expect(Math.abs(b - g), `B≈G for ${sample}`).toBeLessThan(2e-3);
    // wbGains is normalized so a neutral grey keeps its luminance.
    const grey = await centre(flat([0.18, 0.18, 0.18], { whiteBalance: { mode: 'custom', temperature: wb.temperature, tint: wb.tint } }));
    expect(Math.abs(luma(...grey.map(srgbToLinear) as [number, number, number]) - 0.18)).toBeLessThan(1e-3);
  }
});

test('REQ 4: HSL red hue +100 turns pure red towards orange', async () => {
  const [r, g, b] = await centre(flat([1, 0, 0], { hsl: { red: { hue: 100, saturation: 0, luminance: 0 } } }));
  const h = hueOf(r, g, b);
  expect(h).toBeGreaterThan(20);
  expect(h).toBeLessThan(40);
  expect(r).toBeGreaterThan(0.95);
  // −100 goes the other way (towards magenta).
  const m = await centre(flat([1, 0, 0], { hsl: { red: { hue: -100, saturation: 0, luminance: 0 } } }));
  const hm = hueOf(...m);
  expect(hm).toBeGreaterThan(320);
  expect(hm).toBeLessThan(345);
});

test('REQ 4: HSL blue saturation −100 turns a blue patch grey, luminance kept', async () => {
  for (const blue of [
    [0.02, 0.02, 0.8],
    [0.05, 0.12, 0.7],
  ] as [number, number, number][]) {
    const [r, g, b] = await centre(flat(blue, { hsl: { blue: { hue: 0, saturation: -100, luminance: 0 } } }));
    expect(Math.max(r, g, b) - Math.min(r, g, b), `grey for ${blue}`).toBeLessThan(0.02);
    expect(Math.abs(luma(srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)) - luma(...blue))).toBeLessThan(0.01);
  }
  // A red patch is untouched by the blue slider.
  const red = await centre(flat([0.7, 0.05, 0.05], { hsl: { blue: { hue: 0, saturation: -100, luminance: 0 } } }));
  expect(Math.abs(red[0] - linearToSrgb(0.7))).toBeLessThan(2e-3);
});

test('REQ 4: HSL luminance leaves a neutral grey untouched', async () => {
  const lum = (v: number) => ({ hue: 0, saturation: 0, luminance: v });
  for (const v of [100, -100]) {
    const hsl = { red: lum(v), orange: lum(v), yellow: lum(v), green: lum(v), aqua: lum(v), blue: lum(v), purple: lum(v), magenta: lum(v) };
    const [r, g, b] = await centre(flat([0.18, 0.18, 0.18], { hsl }));
    for (const c of [r, g, b]) expect(Math.abs(c - linearToSrgb(0.18))).toBeLessThan(1e-3);
    // …but it does change a coloured patch.
    const [cr] = await centre(flat([0.5, 0.12, 0.05], { hsl }));
    expect(Math.abs(cr - linearToSrgb(0.5))).toBeGreaterThan(0.02);
  }
});

test('extreme settings stay finite and in range', async () => {
  const extremes: RunSpec['params'][] = [
    { basic: { exposure: 3, contrast: 100, highlights: -100, shadows: 100, whites: 100, blacks: -100 }, presence: { texture: 100, clarity: 100, dehaze: 100, structure: 100, localContrast: 100 } },
    { basic: { exposure: -3, contrast: -100, highlights: 100, shadows: -100, whites: -100, blacks: 100 }, presence: { texture: -100, clarity: -100, dehaze: -100, structure: -100, localContrast: -100 } },
    { color: { vibrance: 100, saturation: 100 }, calibration: { shadowsTint: 100, redHue: 100, redSaturation: 100, greenHue: -100, greenSaturation: 100, blueHue: 100, blueSaturation: -100 } },
    { lens: { vignetting: 100, vignettingMidpoint: 0, defringe: { purpleAmount: 20, purpleHueMin: 270, purpleHueMax: 330, greenAmount: 20, greenHueMin: 80, greenHueMax: 160 } } },
  ];
  for (const params of extremes) {
    const r = await run({ width: 96, height: 64, image: { kind: 'photo' }, params, scale: 0.5, stages: ['pre', 'develop', 'local'], mask: { adjustments: { exposure: 2, clarity: 100, dehaze: -100, noise: 100, sharpness: 100, temperature: -100, highlights: -100 } } });
    let lo = Infinity;
    let hi = -Infinity;
    let finite = true;
    for (let i = 0; i < r.data.length; i++) {
      if (i % 4 === 3) continue;
      const v = r.data[i];
      finite &&= Number.isFinite(v);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    expect(finite, JSON.stringify(params)).toBe(true);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1.0005);
  }
});

test('global tone curves are monotone on a grey ramp', async () => {
  const cases: RunSpec['params'][] = [
    { basic: { contrast: 100 } },
    { basic: { contrast: -100 } },
    { basic: { whites: 100, blacks: -100 } },
    { basic: { whites: -100, blacks: 100 } },
    { basic: { highlights: -100, shadows: 100 } },
    { basic: { highlights: 100, shadows: -100 } },
    { toneCurve: { parametric: { highlights: 50, lights: -40, darks: 30, shadows: -60, split1: 25, split2: 50, split3: 75 } } },
  ];
  for (const params of cases) {
    const r = await run({ width: 256, height: 6, image: { kind: 'ramps' }, params });
    let worst = 0;
    for (let x = 1; x < 256; x++) worst = Math.min(worst, px(r, x, 0)[1] - px(r, x - 1, 0)[1]);
    expect(worst, JSON.stringify(params)).toBeGreaterThanOrEqual(-1e-3);
  }
});

test('highlights −100 darkens bright areas, shadows +100 lifts dark areas', async () => {
  const base: RunSpec = { width: 128, height: 86, image: { kind: 'scene' }, scale: 0.25 };
  const d = await run(base);
  const hl = await run({ ...base, params: { basic: { highlights: -100 } } });
  const sh = await run({ ...base, params: { basic: { shadows: 100 } } });
  const sun = [38, 13] as const; // bright patch in the sky (u≈0.3, v≈0.15)
  const ground = [20, 75] as const;
  expect(hl.data[(sun[1] * 128 + sun[0]) * 4]).toBeLessThan(d.data[(sun[1] * 128 + sun[0]) * 4] - 0.02);
  expect(sh.data[(ground[1] * 128 + ground[0]) * 4 + 1]).toBeGreaterThan(d.data[(ground[1] * 128 + ground[0]) * 4 + 1] + 0.05);
  // Shadows barely touch the sky, highlights barely touch the ground.
  const sky = [100, 5] as const;
  expect(Math.abs(sh.data[(sky[1] * 128 + sky[0]) * 4 + 2] - d.data[(sky[1] * 128 + sky[0]) * 4 + 2])).toBeLessThan(0.03);
  expect(Math.abs(hl.data[(ground[1] * 128 + ground[0]) * 4 + 1] - d.data[(ground[1] * 128 + ground[0]) * 4 + 1])).toBeLessThan(0.02);
});

test('dehaze adds contrast to a hazy region, negative dehaze removes it', async () => {
  // Low-contrast, bright stripes (hazy): 0.45 / 0.55 linear, slightly blue.
  const w = 64;
  const h = 64;
  const data: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.floor(x / 8) % 2 ? 0.55 : 0.45;
    data.push(v * 0.95, v, v * 1.05, 1);
  }
  const spec = (dehaze: number): RunSpec => ({ width: w, height: h, image: { kind: 'data', data }, scale: 1, params: { presence: { dehaze } } });
  const contrast = (r: RunResult) => {
    const a = px(r, 12, 32)[1];
    const b = px(r, 4, 32)[1];
    return Math.abs(srgbToLinear(a) - srgbToLinear(b)) / (srgbToLinear(a) + srgbToLinear(b));
  };
  const c0 = contrast(await run(spec(0)));
  const cPos = contrast(await run(spec(70)));
  const cNeg = contrast(await run(spec(-70)));
  expect(cPos).toBeGreaterThan(c0 * 1.5);
  expect(cNeg).toBeLessThan(c0 * 0.8);
});

test('defringe desaturates purple/green fringes next to a hard edge only', async () => {
  const w = 48;
  const h = 32;
  const data: number[] = [];
  const sky = [0.2, 0.35, 0.8];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let c = sky;
    if (y === 16) c = [2.5, 2.5, 2.4];
    if (y === 15) c = [0.55, 0.12, 0.75];
    if (y === 17) c = [0.12, 0.45, 0.1];
    data.push(c[0], c[1], c[2], 1);
  }
  const base: RunSpec = { width: w, height: h, image: { kind: 'data', data }, scale: 1 };
  const off = await run(base);
  const on = await run({ ...base, params: { lens: { defringe: { purpleAmount: 20, purpleHueMin: 270, purpleHueMax: 330, greenAmount: 20, greenHueMin: 80, greenHueMax: 160 } } } });
  const chroma = (c: number[]) => Math.max(...c) - Math.min(...c);
  // A fringe pixel either becomes (near) neutral or takes the neighbourhood's (sky) hue.
  const cleaned = (c: [number, number, number], lo: number, hi: number) => {
    const h = hueOf(...c);
    return chroma(c) < 0.06 || h < lo - 10 || h > hi + 10;
  };
  for (const [y, lo, hi] of [
    [15, 270, 330],
    [17, 80, 160],
  ] as const) {
    const before = px(off, 24, y);
    const after = px(on, 24, y);
    expect(cleaned(before, lo, hi), `row ${y} is a fringe before`).toBe(false);
    expect(cleaned(after, lo, hi), `row ${y} cleaned: ${after.map((v) => v.toFixed(3))}`).toBe(true);
    // Luminance is kept.
    const lum = (c: number[]) => luma(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]));
    expect(Math.abs(lum(after) - lum(before))).toBeLessThan(0.02 * lum(before) + 0.002);
  }
  // Sky far from the edge is untouched.
  const a = px(off, 5, 28);
  const b = px(on, 5, 28);
  for (let k = 0; k < 3; k++) expect(Math.abs(a[k] - b[k])).toBeLessThan(1e-3);
});

test('calibration keeps neutrals neutral; shadows tint only tints shadows', async () => {
  const cal = { redHue: 60, redSaturation: -40, greenHue: -30, greenSaturation: 50, blueHue: 40, blueSaturation: 30, shadowsTint: 0 };
  const [r, g, b] = await centre(flat([0.2, 0.2, 0.2], { calibration: cal }));
  expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(2e-3);
  const dark = await centre(flat([0.01, 0.01, 0.01], { calibration: { ...cal, shadowsTint: 100 } }));
  expect(dark[1]).toBeLessThan(dark[0] - 0.005); // magenta: less green
  const bright = await centre(flat([0.8, 0.8, 0.8], { calibration: { ...cal, shadowsTint: 100 } }));
  expect(Math.abs(bright[1] - bright[0])).toBeLessThan(2e-3);
});

test('lens vignetting: profile polynomial and manual slider brighten corners only', async () => {
  const spec = (p: Partial<RunSpec>): RunSpec => ({ width: 60, height: 40, image: { kind: 'flat', rgb: [0.18, 0.18, 0.18] }, ...p });
  const prof = await run(spec({ lens: { v1: -0.3, v2: 0, v3: 0 } }));
  const c = px(prof, 30, 20)[0];
  const corner = px(prof, 0, 0)[0];
  expect(Math.abs(c - linearToSrgb(0.18))).toBeLessThan(2e-3);
  // Corner r ≈ 1 → divided by (1 − 0.3) = 0.7.
  expect(Math.abs(corner - linearToSrgb(0.18 / (1 - 0.3 * 0.94)))).toBeLessThan(0.02);
  const man = await run(spec({ params: { lens: { vignetting: 100, vignettingMidpoint: 50 } } }));
  expect(Math.abs(px(man, 30, 20)[0] - linearToSrgb(0.18))).toBeLessThan(2e-3);
  expect(px(man, 0, 0)[0]).toBeGreaterThan(linearToSrgb(0.18) + 0.1);
});

test('local exposure +1 EV applies only where the mask covers', async () => {
  const r = await run({ width: 32, height: 16, image: { kind: 'flat', rgb: [0.18, 0.18, 0.18] }, stages: ['pre', 'develop', 'local'], mask: { coverage: 'left', adjustments: { exposure: 1 } } });
  expect(Math.abs(px(r, 4, 8)[0] - linearToSrgb(0.36))).toBeLessThan(1e-3);
  expect(Math.abs(px(r, 28, 8)[0] - linearToSrgb(0.18))).toBeLessThan(1e-3);
  const half = await run({ width: 32, height: 16, image: { kind: 'flat', rgb: [0.18, 0.18, 0.18] }, stages: ['pre', 'develop', 'local'], mask: { coverage: 'full', amount: 50, adjustments: { exposure: 1 } } });
  expect(Math.abs(px(half, 16, 8)[0] - linearToSrgb(0.18 * Math.SQRT2))).toBeLessThan(1e-3);
});

test('radii scale with ctx.scale: 2× resolution looks the same', async () => {
  const params: RunSpec['params'] = {
    basic: { highlights: -80, shadows: 70 },
    presence: { clarity: 60, localContrast: 50, dehaze: 30, texture: 40 },
  };
  const lo = await run({ width: 256, height: 170, image: { kind: 'scene' }, params, scale: 0.5 });
  const hi = await run({ width: 512, height: 340, image: { kind: 'scene' }, params, scale: 1, downsample: 2 });
  const loBase = await run({ width: 256, height: 170, image: { kind: 'scene' }, scale: 0.5 });
  const hiBase = await run({ width: 512, height: 340, image: { kind: 'scene' }, scale: 1, downsample: 2 });
  let diff = 0;
  let effect = 0;
  let n = 0;
  for (let i = 0; i < lo.data.length; i++) {
    if (i % 4 === 3) continue;
    // Compare the EFFECT of the edit at both resolutions (sampling differences cancel).
    const dLo = lo.data[i] - loBase.data[i];
    const dHi = hi.data[i] - hiBase.data[i];
    diff += Math.abs(dLo - dHi);
    effect += Math.abs(dLo);
    n++;
  }
  expect(effect / n).toBeGreaterThan(0.02);
  expect(diff / n).toBeLessThan(0.2 * (effect / n));
});

test('renders the synthetic photo with a few looks (PNG artefacts for review)', async ({}, testInfo) => {
  const looks: Record<string, RunSpec['params']> = {
    default: {},
    punchy: { basic: { exposure: 0.3, contrast: 25, highlights: -60, shadows: 40, whites: 15, blacks: -15 }, color: { vibrance: 30 }, presence: { clarity: 20, dehaze: 15 } },
    tealOrange: { colorGrading: { shadows: { hue: 200, saturation: 40, luminance: 0 }, highlights: { hue: 40, saturation: 35, luminance: 0 }, midtones: { hue: 0, saturation: 0, luminance: 0 }, blending: 60 }, hsl: { orange: { hue: -10, saturation: 10, luminance: 15 } } },
    soft: { presence: { texture: -60, clarity: -40, dehaze: -30 }, basic: { contrast: -20 } },
  };
  for (const [name, params] of Object.entries(looks)) {
    const url = await page.evaluate((s) => window.__kc.png(s), { width: 768, height: 512, image: { kind: 'photo' }, params } as RunSpec);
    const file = testInfo.outputPath(`photo-${name}.png`);
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    expect(fs.statSync(file).size).toBeGreaterThan(10_000);
  }
});
