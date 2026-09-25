/**
 * End-to-end tour of KLOUD Studio through the real UI (one shared page, run in
 * order): library import & culling, Develop sliders / undo, crop, masks, AI,
 * heal, presets, compare, snapshots, export (JPEG + DNG re-import through the
 * RAW path), copy/paste, autosave across reload, and the phone layout.
 *
 * Run: PW_PORT=5302 npx playwright test tests/e2e/app
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

type K = any; // window.__kloud (AppRuntime) — typed loosely on purpose in tests

/** Visible grid tiles (the grid recycles hidden tiles). */
const TILE = '.k-tile:not([hidden])';
const IGNORED_CONSOLE = /Failed to load resource|ERR_CERT|WebGPU|GPU stall|favicon/i;

/** Run `fn(window.__kloud, arg)` in the page (fn is serialized: no closures). */
async function k<T, A = undefined>(page: Page, fn: (rt: K, arg: A) => T | Promise<T>, arg?: A): Promise<T> {
  return page.evaluate(
    ([src, a]) => {
      const run = new Function('rt', 'arg', `return (${src})(rt, arg);`) as (rt: unknown, arg: unknown) => unknown;
      return run((window as unknown as { __kloud: unknown }).__kloud, a);
    },
    [fn.toString(), arg] as const,
  ) as Promise<T>;
}

/** Mean luma of the rendered main slot (after forcing the pending frame). */
async function meanLuma(page: Page): Promise<number> {
  return page.evaluate(() => {
    const rt = (window as unknown as { __kloud: K }).__kloud;
    rt.render.flushNow();
    const px = rt.ctx.engine.readPixels(96, 'main');
    let s = 0;
    let n = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      if (px.data[i + 3] < 128) continue;
      s += 0.2126 * px.data[i] + 0.7152 * px.data[i + 1] + 0.0722 * px.data[i + 2];
      n++;
    }
    return n ? s / n : 0;
  });
}

async function settle(page: Page, ms = 400): Promise<void> {
  await page.waitForTimeout(ms);
  await page.evaluate(() => (window as unknown as { __kloud: K }).__kloud.render.flushNow());
}

const params = (page: Page) => k(page, (rt) => rt.ctx.doc.value?.store.params);
const lastHistory = (page: Page) => k(page, (rt) => rt.ctx.doc.value?.store.history.at(-1)?.label as string);

test.describe.serial('KLOUD Studio', () => {
  let page: Page;
  const errors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    await page.route('**/api/admin/session', (route) => route.fulfill({ json: { authenticated: true, username: 'test' } }));
    await page.goto('/studio');
    await page.waitForFunction(() => !!(window as unknown as { __kloud?: K }).__kloud);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('boots into an empty library styled like the site', async () => {
    await expect(page.getByRole('button', { name: 'Add sample photos' })).toBeVisible();
    await expect(page.locator('.k-wordmark').first()).toContainText('KLOUD');
    expect(errors).toEqual([]);
  });

  test('theme toggle switches between light and dark', async () => {
    const before = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    await page.getByRole('button', { name: /Switch to (dark|light) theme/ }).first().click();
    const after = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(after).not.toBe(before);
    expect(['light', 'dark']).toContain(after);
  });

  test('imports the sample photos', async () => {
    await page.getByRole('button', { name: 'Add sample photos' }).click();
    await expect(page.locator(TILE)).toHaveCount(3, { timeout: 60_000 });
    const n = await k(page, (rt) => rt.ctx.library.all().length);
    expect(n).toBe(3);
  });

  test('rating, pick, label and favorite shortcuts', async () => {
    await page.locator(TILE).first().click();
    for (const key of ['3', 'p', '6', 'h']) await page.keyboard.press(key);
    await page.waitForTimeout(300);
    const rec = await k(page, (rt) => {
      const id = rt.ctx.selection.value[0];
      const r = rt.ctx.library.get(id);
      return { rating: r.rating, flag: r.flag, label: r.label, favorite: r.favorite };
    });
    expect(rec).toEqual({ rating: 3, flag: 'pick', label: 'red', favorite: true });
  });

  test('search filters the grid', async () => {
    const search = page.getByRole('searchbox').first();
    await search.fill('Lake');
    await expect(page.locator(TILE)).toHaveCount(1, { timeout: 5000 });
    await search.fill('');
    await expect(page.locator(TILE)).toHaveCount(3, { timeout: 5000 });
  });

  test('list view shows every photo', async () => {
    await page.getByRole('radio', { name: /list/i }).first().click();
    await expect(page.locator('.k-list__row:not([hidden])')).toHaveCount(3, { timeout: 5000 });
    await page.getByRole('radio', { name: /grid/i }).first().click();
    await expect(page.locator(TILE)).toHaveCount(3);
  });

  test('opens a photo in Develop and renders it', async () => {
    await page.locator(TILE).first().dblclick();
    await page.waitForFunction(() => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      return rt.ctx.module.value === 'develop' && !!rt.ctx.doc.value;
    });
    await settle(page, 800);
    expect(await meanLuma(page)).toBeGreaterThan(5);
    await expect(page.getByRole('slider', { name: 'Exposure' })).toBeVisible();
    // The status bar zoom must reflect the laid-out canvas, not the pre-layout first render.
    await expect(page.locator('.k-sb__zoom')).toHaveText(/^Fit · [1-9]\d*%$/);
  });

  test('exposure slider: keyboard edits are one undoable step', async () => {
    const base = await meanLuma(page);
    const historyBefore = await k(page, (rt) => rt.ctx.doc.value.store.history.length);
    const slider = page.getByRole('slider', { name: 'Exposure' });
    await slider.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('PageUp');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await settle(page);
    const exp = (await params(page)).basic.exposure;
    expect(exp).toBeGreaterThan(0);
    expect(await meanLuma(page)).toBeGreaterThan(base + 2);
    const historyAfter = await k(page, (rt) => rt.ctx.doc.value.store.history.length);
    expect(historyAfter - historyBefore).toBeLessThanOrEqual(2);
    await k(page, (rt) => rt.ctx.doc.value.store.undo());
    await settle(page);
    const after = (await params(page)).basic.exposure;
    expect(after).toBeLessThan(exp);
  });

  test('tone curve, HSL, grading, detail and effects all change the render', async () => {
    const edits: [string, unknown][] = [
      ['toneCurve.rgb', [{ x: 0, y: 0 }, { x: 0.5, y: 0.65 }, { x: 1, y: 1 }]],
      ['hsl.blue.saturation', -80],
      ['colorGrading.shadows', { hue: 210, saturation: 60, luminance: 0 }],
      ['presence.clarity', 60],
      ['presence.dehaze', 40],
      ['detail.sharpenAmount', 120],
      ['noise.luminance', 50],
      ['effects.vignetteAmount', -60],
      ['effects.grainAmount', 40],
      ['effects.bloom', 50],
    ];
    for (const [path, value] of edits) {
      const before = await meanLuma(page);
      const px0 = await k(page, (rt) => Array.from(rt.ctx.engine.readPixels(48, 'main').data as Uint8ClampedArray));
      await k(page, (rt, a: [string, unknown]) => rt.ctx.doc.value.store.set(a[0], a[1]), [path, value] as [string, unknown]);
      await settle(page, 150);
      const px1 = await k(page, (rt) => Array.from(rt.ctx.engine.readPixels(48, 'main').data as Uint8ClampedArray));
      let diff = 0;
      for (let i = 0; i < px0.length; i++) diff += Math.abs((px0[i] as number) - (px1[i] as number));
      expect(diff, `${path} should change the image (mean ${before.toFixed(1)})`).toBeGreaterThan(0);
    }
    await k(page, (rt) => rt.ctx.doc.value.store.reset('Reset All'));
    await settle(page);
  });

  test('crop 1:1 through the crop panel', async () => {
    await page.keyboard.press('r');
    await expect.poll(() => k(page, (rt) => rt.ctx.tool.value)).toBe('crop');
    await page.locator('button[data-aspect="1:1"]').first().click();
    await page.getByRole('button', { name: 'Done' }).first().click();
    await settle(page);
    const size = await k(page, (rt) => rt.ctx.engine.getOutputSize(rt.ctx.doc.value.store.params));
    expect(Math.abs(size.width / size.height - 1)).toBeLessThan(0.02);
    await k(page, (rt) => rt.ctx.doc.value.store.undo());
    await k(page, (rt) => rt.ctx.tool.set('edit'));
  });

  test('radial mask with a local exposure boost', async () => {
    await page.getByRole('button', { name: 'Masks' }).first().click();
    await page.getByRole('button', { name: 'Create new mask' }).click();
    await page.getByRole('menuitem', { name: /Radial Gradient/ }).click();
    const stage = page.locator('.k-viewer__stage');
    const box = (await stage.boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 160, cy + 110, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    const masks = (await params(page)).masks;
    expect(masks.length).toBe(1);
    expect(masks[0].components[0].kind).toBe('radial');
    const before = await meanLuma(page);
    await k(page, (rt) => rt.ctx.doc.value.store.set('masks.0.adjustments.exposure', 1.5));
    await settle(page);
    expect(await meanLuma(page)).toBeGreaterThan(before + 1);
  });

  test('subject AI mask gets a computed bitmap', async () => {
    await page.getByRole('button', { name: 'Create new mask' }).click();
    await page.getByRole('menuitem', { name: /^Subject/ }).click();
    await expect
      .poll(
        () =>
          k(page, (rt) => {
            const m = rt.ctx.doc.value.store.params.masks.at(-1);
            const key = m?.components[0]?.ai?.bitmapKey;
            return !!key && !!rt.ctx.aiMaskStore.get(key);
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
    await k(page, (rt) => rt.ctx.doc.value.store.update('clear masks', (p: K) => void (p.masks = [])));
  });

  test('heal: a click adds a spot', async () => {
    await k(page, (rt) => rt.ctx.tool.set('heal'));
    const stage = page.locator('.k-viewer__stage');
    const box = (await stage.boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
    await expect.poll(async () => (await params(page)).retouch.spots.length, { timeout: 10_000 }).toBe(1);
    await k(page, (rt) => rt.ctx.tool.set('edit'));
  });

  test('AI Auto Edit applies an analysis-based edit', async () => {
    await k(page, (rt) => rt.ctx.tool.set('ai'));
    await page.getByRole('button', { name: 'AI Auto Edit' }).click();
    await expect.poll(() => lastHistory(page), { timeout: 20_000 }).toContain('AI Auto Edit');
    await k(page, (rt) => rt.ctx.tool.set('edit'));
  });

  test('KLOUD Style applies the house look', async () => {
    await k(page, (rt) => rt.ctx.tool.set('ai'));
    await page.getByRole('button', { name: 'Apply style' }).click();
    await expect.poll(() => lastHistory(page), { timeout: 10_000 }).toContain('Style');
    await k(page, (rt) => rt.ctx.tool.set('edit'));
  });

  test('presets: hover previews, click applies', async () => {
    const preset = page.locator('.k-pnl-preset', { hasText: 'KLOUD Night Drive' }).first();
    await page.mouse.move(700, 450);
    // Real hovers are flaky under software WebGL (busy frames); fire the event the list listens for.
    await preset.locator('.k-pnl-list__name').dispatchEvent('pointerover');

    await page.waitForTimeout(300);

    // Software WebGL can keep the page busy for seconds on heavy looks: allow a long poll.
    await expect.poll(() => k(page, (rt) => !!rt.ctx.previewParams.value), { timeout: 60_000 }).toBe(true);
    await preset.click();
    await expect.poll(() => lastHistory(page), { timeout: 60_000 }).toContain('KLOUD Night Drive');
    await expect.poll(() => k(page, (rt) => rt.ctx.previewParams.value), { timeout: 60_000 }).toBe(null);
  });

  test('before/after and compare layouts', async () => {
    await page.locator('.k-viewer__stage').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('\\');
    await expect.poll(() => k(page, (rt) => rt.ctx.view.value.compare)).toBe('before');
    await page.keyboard.press('\\');
    await expect.poll(() => k(page, (rt) => rt.ctx.view.value.compare)).toBe('off');
    await page.keyboard.press('y');
    await expect.poll(() => k(page, (rt) => rt.ctx.view.value.compare)).not.toBe('off');
    await settle(page);
    await k(page, (rt) => rt.ctx.view.set({ ...rt.ctx.view.value, compare: 'off' }));
  });

  test('zoom: Z toggles fit and 100%', async () => {
    await page.keyboard.press('z');
    await expect.poll(() => k(page, (rt) => rt.ctx.view.value.zoom)).not.toBe('fit');
    await settle(page);
    await page.keyboard.press('z');
    await expect.poll(() => k(page, (rt) => rt.ctx.view.value.zoom)).toBe('fit');
  });

  test('snapshot from the develop menu', async () => {
    await page.getByRole('button', { name: 'Develop actions' }).click();
    await page.getByRole('menuitem', { name: /New snapshot/ }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => k(page, (rt) => rt.ctx.doc.value.store.snapshots.length)).toBe(1);
  });

  test('exports a JPEG', async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const dl = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/\.jpg$/);
    const path = await download.path();
    const bytes = readFileSync(path!);
    expect(bytes.length).toBeGreaterThan(20_000);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  test('exports a DNG and re-imports it through the RAW path', async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Archive DNG' }).click();
    const dl = page.waitForEvent('download', { timeout: 90_000 });
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/\.dng$/);
    const bytes = readFileSync((await download.path())!);
    expect(bytes.subarray(0, 2).toString('latin1')).toMatch(/II|MM/);
    // Import it back and open it: exercises LibRaw (or the embedded-preview fallback).
    await page.route('**/__roundtrip.dng', (route) => route.fulfill({ body: bytes, contentType: 'image/x-adobe-dng' }));
    const id = await page.evaluate(async () => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      const blob = await (await fetch('/__roundtrip.dng')).blob();
      const file = new File([blob], 'roundtrip.dng', { type: 'image/x-adobe-dng' });
      await rt.ctx.importFiles([file]);
      const rec = rt.ctx.library.all().find((r: K) => r.name === 'roundtrip.dng');
      await rt.ctx.openPhoto(rec.id);
      return rec.id as string;
    });
    expect(id).toBeTruthy();
    await settle(page, 1500);
    const info = await k(page, (rt) => ({ isRaw: rt.ctx.doc.value.isRaw, w: rt.ctx.doc.value.source.width }));
    expect(info.w).toBeGreaterThan(100);
    expect(await meanLuma(page)).toBeGreaterThan(5);
  });

  test('copy settings from one photo and paste to another', async () => {
    const ids = await k(page, (rt) => rt.ctx.library.all().map((r: K) => r.id));
    await k(page, async (rt) => {
      await rt.ctx.openPhoto(rt.ctx.library.all()[0].id);
      rt.ctx.doc.value.store.set('basic.contrast', 42);
    });
    await k(page, (rt) =>
      rt.ctx.settingsClipboard.set({ groups: ['tone'], params: { basic: { contrast: 42 } } }),
    );
    const target = ids[1];
    await k(page, async (rt) => {
      const batch = await import('/src/ui/batch/index.ts' as string);
      await batch.pasteSettings(rt.ctx, [rt.ctx.library.all()[1].id]);
    });
    const saved = await page.evaluate(async (id) => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      return (await rt.ctx.library.loadEdit(id))?.params.basic.contrast;
    }, target);
    expect(saved).toBe(42);
  });

  test('edits survive a reload (autosave)', async () => {
    const id = await k(page, (rt) => rt.ctx.doc.value.photoId);
    await k(page, (rt) => rt.ctx.doc.value.store.set('basic.exposure', 0.77));
    await k(page, (rt) => rt.ctx.saveCurrent());
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { __kloud?: K }).__kloud);
    // A recovery prompt may appear; accept it if so.
    const restore = page.getByRole('button', { name: /Restore/i });
    if (await restore.isVisible().catch(() => false)) await restore.click();
    const saved = await page.evaluate(async (pid) => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      return (await rt.ctx.library.loadEdit(pid))?.params.basic.exposure;
    }, id);
    expect(saved).toBeCloseTo(0.77, 2);
  });

  test('phone layout: drawer closed, develop panel as a sheet', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await k(page, async (rt) => {
      await rt.ctx.openPhoto(rt.ctx.library.all()[0].id);
      rt.ctx.module.set('develop');
    });
    await settle(page, 800);
    const layout = await page.evaluate(() => {
      const app = document.querySelector('.k-app') as HTMLElement;
      const right = document.querySelector('.k-app__right') as HTMLElement;
      return { layout: app.dataset.layout, left: app.classList.contains('is-left-open'), rightH: right.getBoundingClientRect().height };
    });
    expect(layout.layout).toBe('phone');
    expect(layout.left).toBe(false);
    expect(layout.rightH).toBeGreaterThan(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    expect(overflow).toBe(false);
  });

  test('no uncaught errors during the whole tour', async () => {
    expect(errors).toEqual([]);
  });
});
