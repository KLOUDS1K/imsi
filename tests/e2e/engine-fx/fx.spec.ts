/**
 * engine-fx browser checks: the real PassDefs run through a minimal WebGL2
 * orchestrator (runner.ts) on SwiftShader. Run with
 *   PW_PORT=5202 npx playwright test tests/e2e/engine-fx
 * Rendered PNGs for visual inspection land in test-results/engine-fx/.
 */
import { expect, test, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

type Fx = Record<string, () => unknown>;

async function call<T>(page: Page, name: string): Promise<T> {
  return (await page.evaluate((n) => (window as unknown as { fx: Fx }).fx[n](), name)) as T;
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/tests/e2e/engine-fx/harness.html');
  await page.waitForFunction(() => (window as unknown as { fxReady?: boolean }).fxReady === true, null, { timeout: 60_000 });
  expect(errors).toEqual([]);
});

test('default JPEG params: every DETAIL/EFFECTS/HEAL/GEOMETRY pass is an identity', async ({ page }) => {
  const r = await call<{ result: Record<string, { identity: boolean; forcedDiff: number | null }>; rawActive: string[] }>(page, 'identityDefaults');
  for (const [name, v] of Object.entries(r.result)) {
    expect(v.identity, name).toBe(true);
    if (v.forcedDiff !== null) expect(v.forcedDiff, `${name} shader output`).toBeLessThan(1e-6);
  }
  expect(r.rawActive.sort()).toEqual(['fx-detail-color-nr', 'fx-detail-sharpen']);
});

test('GEOMETRY with defaults is an exact copy (bicubic and bilinear)', async ({ page }) => {
  const r = await call<{ diffFull: number; diffDraft: number; minAlpha: number }>(page, 'geometryIdentity');
  expect(r.diffFull).toBeLessThan(1e-6);
  expect(r.diffDraft).toBeLessThan(1e-6);
  expect(r.minAlpha).toBe(1);
});

test('orientation/flip move a marker pixel exactly where geometry says', async ({ page }) => {
  const r = await call<{ cases: Record<string, { found: number[]; predicted: number[]; value: number }> }>(page, 'orientationMarker');
  for (const [name, c] of Object.entries(r.cases)) {
    expect(c.found, name).toEqual(c.predicted);
    expect(c.value, name).toBeCloseTo(1, 5);
  }
});

test('rotated + keystoned + lens-corrected crop matches the CPU mapping', async ({ page }) => {
  const r = await call<{ found: number[]; predicted: number[] }>(page, 'warpedMarker');
  expect(Math.abs(r.found[0] - r.predicted[0])).toBeLessThanOrEqual(1);
  expect(Math.abs(r.found[1] - r.predicted[1])).toBeLessThanOrEqual(1);
});

test('crop sub-rect, outRect tiles and the overlay mode', async ({ page }) => {
  const r = await call<{ maxDiff: number; tileDiff: number; overlayDiff: number }>(page, 'cropSubRect');
  expect(r.maxDiff).toBeLessThan(1e-6);
  expect(r.tileDiff).toBeLessThan(1e-6);
  expect(r.overlayDiff).toBeLessThan(1e-6);
});

test('vignette darkens (or lightens) the corners only', async ({ page }) => {
  const r = await call<Record<string, number & number[]>>(page, 'vignette');
  expect(Math.abs(r.centerDark - 0.5)).toBeLessThan(1e-4);
  expect(r.cornerDark).toBeLessThan(0.35);
  expect(r.edgeMidDark).toBeGreaterThan(r.cornerDark);
  expect(r.edgeMidDark).toBeLessThan(0.45);
  for (let i = 1; i < r.diag.length; i++) expect(r.diag[i]).toBeLessThanOrEqual(r.diag[i - 1] + 1e-6);
  expect(Math.abs(r.centerLight - 0.5)).toBeLessThan(1e-4);
  expect(r.cornerLight).toBeGreaterThan(0.6);
  expect(r.cornerProtect).toBeGreaterThan(r.cornerNoProtect + 0.2);
});

test('grain changes pixels, keeps the mean, is deterministic and tile-consistent', async ({ page }) => {
  const r = await call<Record<string, number | boolean>>(page, 'grain');
  expect(Math.abs((r.mean as number) - 0.5)).toBeLessThan(0.002);
  expect(r.std as number).toBeGreaterThan(0.004);
  expect(r.changedFraction as number).toBeGreaterThan(0.9);
  expect(r.deterministic).toBe(true);
  expect(r.tileDiff as number).toBeLessThan(1e-6);
  expect(Math.abs((r.zoomStd as number) - 0.1)).toBeLessThan(0.012);
  expect(Math.abs((r.zoomMean as number) - 0.5)).toBeLessThan(0.01);
});

test('clone copies source texture; heal keeps texture but matches destination tone', async ({ page }) => {
  const r = await call<Record<string, number>>(page, 'spots');
  expect(r.coreDiff).toBeLessThan(1e-6);
  expect(r.outsideDiff).toBeLessThan(1e-6);
  expect(Math.abs(r.cloneMean - 0.6)).toBeLessThan(0.02);
  expect(Math.abs(r.healMean - 0.2)).toBeLessThan(0.02);
  expect(r.healStd / r.texStd).toBeGreaterThan(0.8);
  expect(r.healStd / r.texStd).toBeLessThan(1.2);
  expect(r.healCorr).toBeGreaterThan(0.95);
});

test('removal patch composites (sRGB-decoded) inside its bbox only', async ({ page }) => {
  const r = await call<{ inside: number[]; expected: number[]; outside: number[]; identityWithout: boolean }>(page, 'patch');
  for (let c = 0; c < 3; c++) {
    expect(r.inside[c]).toBeCloseTo(r.expected[c], 4);
    expect(r.outside[c]).toBeCloseTo(0.1, 6);
  }
  expect(r.identityWithout).toBe(true);
});

test('detail: NR reduces noise, sharpening halos follow the Detail slider, masking protects flat areas', async ({ page }) => {
  type N = { luma: number; chroma: number; mean: number };
  const r = await call<{
    before: N; lumaNr: N; colorNr: N; ai: N; maskedNoise: N; unmaskedNoise: N;
    sharpHalo: number[]; sharpSuppressed: number[]; sineAmp: { none: number; nr: number; nrContrast: number };
  }>(page, 'detail');
  expect(r.lumaNr.luma).toBeLessThan(0.3 * r.before.luma);
  expect(Math.abs(r.lumaNr.chroma / r.before.chroma - 1)).toBeLessThan(0.05);
  expect(r.colorNr.chroma).toBeLessThan(0.3 * r.before.chroma);
  expect(Math.abs(r.colorNr.luma / r.before.luma - 1)).toBeLessThan(0.02);
  expect(r.ai.luma).toBeLessThan(0.5 * r.before.luma);
  expect(r.ai.chroma).toBeLessThan(0.5 * r.before.chroma);
  for (const v of [r.lumaNr, r.colorNr, r.ai]) expect(Math.abs(v.mean - r.before.mean)).toBeLessThan(0.005);
  expect(Math.min(...r.sharpHalo)).toBeLessThan(0.28);
  expect(Math.max(...r.sharpHalo)).toBeGreaterThan(0.72);
  expect(Math.min(...r.sharpSuppressed)).toBeGreaterThanOrEqual(0.3 - 0.0101);
  expect(Math.max(...r.sharpSuppressed)).toBeLessThanOrEqual(0.7 + 0.0101);
  expect(Math.abs(r.maskedNoise.luma / r.before.luma - 1)).toBeLessThan(0.03);
  expect(r.unmaskedNoise.luma).toBeGreaterThan(1.3 * r.before.luma);
  expect(r.sineAmp.nr).toBeLessThan(0.8 * r.sineAmp.none);
  expect(r.sineAmp.nrContrast).toBeGreaterThan(r.sineAmp.nr + 0.003);
});

test('bloom / glow / halation light up around highlights only', async ({ page }) => {
  type Px = number[];
  const r = await call<{
    base: { near: Px; far: Px };
    bloom: { near: Px; far: Px; core: Px };
    halation: { ring: Px; far: Px; core: Px };
    glow: { near: Px; far: Px };
  }>(page, 'glowEffects');
  expect(r.bloom.near[1]).toBeGreaterThan(r.base.near[1] + 0.05);
  expect(r.bloom.far[1]).toBeLessThan(r.base.far[1] + 0.03);
  expect(r.halation.ring[0]).toBeGreaterThan(r.halation.ring[1]);
  expect(r.halation.ring[1]).toBeGreaterThan(r.halation.ring[2]);
  expect(r.halation.ring[0]).toBeGreaterThan(r.base.near[0] + 0.1);
  expect(Math.abs(r.halation.far[0] - r.base.far[0])).toBeLessThan(0.005);
  expect(r.glow.near[1]).toBeGreaterThan(r.base.near[1] + 0.02);
});

test('bloom, glow, vignette and grain keep neutral areas neutral; halation tints only slightly', async ({ page }) => {
  const r = await call<Record<string, number[]>>(page, 'neutralTint');
  const cast = (v: number[]) => v[0] - v[2];
  // The patch has a slight blue cast (bluish blacks); brightening towards white may shrink it, never grow it.
  for (const k of ['bloom', 'glow', 'vignette', 'grain']) expect(Math.abs(cast(r[k])), k).toBeLessThanOrEqual(Math.abs(cast(r.none)) + 0.003);
  expect(r.bloom[1]).toBeGreaterThan(r.none[1]);
  expect(r.vignette[1]).toBeLessThan(r.none[1]);
  expect(Math.abs(r.grain[1] - r.none[1])).toBeLessThan(0.002);
  expect(cast(r.halation) - cast(r.none)).toBeLessThan(0.03);
});

test('render the synthetic scene through the whole fx chain', async ({ page }) => {
  const dir = path.join('test-results', 'engine-fx');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['renderScene', 'renderDetail', 'renderDetailParts']) {
    const url = await call<string>(page, name);
    expect(url.startsWith('data:image/png;base64,')).toBe(true);
    const buf = Buffer.from(url.split(',')[1], 'base64');
    expect(buf.length).toBeGreaterThan(10_000);
    fs.writeFileSync(path.join(dir, `${name}.png`), buf);
  }
});
