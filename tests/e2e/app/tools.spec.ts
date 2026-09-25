/**
 * Second tour: on-image tools and workflows not covered by app.spec.ts —
 * brush / linear / range masks, WB picker, crop handles & straighten,
 * AI remove, undo/redo keys, photo navigation, help overlay, albums, batch
 * sync + AI batch, export formats, XMP round trip, snapshot compare and the
 * full-resolution detail render when zoomed in.
 *
 * Run: PW_PORT=5302 npx playwright test tests/e2e/app/tools.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

type K = any;
const IGNORED_CONSOLE = /Failed to load resource|ERR_CERT|WebGPU|GPU stall|favicon/i;

async function k<T, A = undefined>(page: Page, fn: (rt: K, arg: A) => T | Promise<T>, arg?: A): Promise<T> {
  return page.evaluate(
    ([src, a]) => {
      const run = new Function('rt', 'arg', `return (${src})(rt, arg);`) as (rt: unknown, arg: unknown) => unknown;
      return run((window as unknown as { __kloud: unknown }).__kloud, a);
    },
    [fn.toString(), arg] as const,
  ) as Promise<T>;
}

const params = (page: Page) => k(page, (rt) => rt.ctx.doc.value?.store.params);
const flush = (page: Page) => k(page, (rt) => rt.render.flushNow());

async function stageBox(page: Page) {
  const box = await page.locator('.k-viewer__stage').boundingBox();
  if (!box) throw new Error('no stage');
  return box;
}

/** Image rectangle (CSS px, page coords) from the engine's display transform. */
async function imageRect(page: Page) {
  const box = await stageBox(page);
  const t = await k(page, (rt) => rt.ctx.engine.getDisplayTransform(rt.ctx.view.value));
  return { x: box.x + t.offsetX, y: box.y + t.offsetY, w: t.outWidth * t.scale, h: t.outHeight * t.scale };
}

async function drag(page: Page, x0: number, y0: number, x1: number, y1: number) {
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 10 });
  await page.mouse.up();
}

async function newMask(page: Page, item: RegExp, submenu?: string) {
  await page.getByRole('button', { name: 'Create new mask' }).click();
  if (submenu) await page.getByRole('menuitem', { name: new RegExp(`^${submenu}`) }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

test.describe.serial('KLOUD Studio tools', () => {
  let page: Page;
  const errors: string[] = [];

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) errors.push(`console: ${m.text()}`);
    });
    await page.goto('/studio');
    await page.waitForFunction(() => !!(window as unknown as { __kloud?: K }).__kloud);
    await page.evaluate(async () => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      const samples = await import('/src/ui/library/samples.ts' as string);
      await rt.ctx.importFiles(await samples.createSamplePhotos());
      const first = rt.ctx.library.all().find((r: K) => r.name.includes('Seoul'));
      await rt.ctx.openPhoto(first.id);
      rt.ctx.module.set('develop');
    });
    await page.waitForSelector('.k-viewer__stage');
    await page.waitForTimeout(1500);
    await flush(page);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('brush mask: a painted stroke lands in source space', async () => {
    await k(page, (rt) => rt.ctx.tool.set('masks'));
    await newMask(page, /^Brush/);
    const r = await imageRect(page);
    await drag(page, r.x + r.w * 0.3, r.y + r.h * 0.5, r.x + r.w * 0.6, r.y + r.h * 0.55);
    await expect.poll(async () => (await params(page)).masks.at(-1)?.components[0]?.brush?.strokes.length ?? 0).toBeGreaterThan(0);
    const pts = (await params(page)).masks.at(-1).components[0].brush.strokes[0].points;
    expect(pts.length).toBeGreaterThan(3);
    for (const p of pts) {
      expect(p.x).toBeGreaterThan(0.2);
      expect(p.x).toBeLessThan(0.7);
      expect(p.y).toBeGreaterThan(0.4);
      expect(p.y).toBeLessThan(0.65);
    }
  });

  test('linear gradient mask from a drag', async () => {
    await newMask(page, /Linear Gradient/);
    const r = await imageRect(page);
    await drag(page, r.x + r.w * 0.5, r.y + r.h * 0.1, r.x + r.w * 0.5, r.y + r.h * 0.5);
    await expect
      .poll(async () => {
        const lg = (await params(page)).masks.at(-1)?.components[0]?.linear;
        return lg ? Math.abs(lg.y1 - lg.y0) : 0;
      })
      .toBeGreaterThan(0.2);
  });

  test('color range and luminance range sample the photo', async () => {
    await newMask(page, /^Color/, 'Range');
    const r = await imageRect(page);
    await page.mouse.click(r.x + r.w * 0.2, r.y + r.h * 0.15);
    await expect.poll(async () => (await params(page)).masks.at(-1)?.components[0]?.colorRange?.samples.length ?? 0).toBeGreaterThan(0);
    await newMask(page, /^Luminance/, 'Range');
    await page.mouse.click(r.x + r.w * 0.2, r.y + r.h * 0.15);
    await expect
      .poll(async () => {
        const lr = (await params(page)).masks.at(-1)?.components[0]?.luminanceRange;
        return lr ? lr.max - lr.min : 0;
      })
      .toBeGreaterThan(0);
    await k(page, (rt) => rt.ctx.doc.value.store.update('clear', (p: K) => void (p.masks = [])));
    await k(page, (rt) => rt.ctx.tool.set('edit'));
  });

  test('white balance picker neutralises the clicked colour', async () => {
    await page.locator('.k-viewer__stage').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('w');
    await expect.poll(() => k(page, (rt) => rt.ctx.wbPickerActive.value)).toBe(true);
    const r = await imageRect(page);
    await page.mouse.click(r.x + r.w * 0.5, r.y + r.h * 0.2);
    await expect.poll(async () => (await params(page)).whiteBalance.mode).toBe('custom');
    const wb = (await params(page)).whiteBalance;
    expect(Math.abs(wb.temperature) + Math.abs(wb.tint)).toBeGreaterThan(0);
    await k(page, (rt) => {
      rt.ctx.wbPickerActive.set(false);
      rt.ctx.doc.value.store.reset('Reset All');
    });
  });

  test('crop: dragging a corner handle crops, straighten keeps the crop valid', async () => {
    await k(page, (rt) => rt.ctx.tool.set('crop'));
    await page.waitForTimeout(300);
    await flush(page);
    const r = await imageRect(page);
    await drag(page, r.x + 1, r.y + 1, r.x + r.w * 0.2, r.y + r.h * 0.2);
    await expect.poll(async () => (await params(page)).crop.x).toBeGreaterThan(0.05);
    const c = (await params(page)).crop;
    expect(c.y).toBeGreaterThan(0.05);
    await k(page, (rt) => rt.ctx.doc.value.store.set('crop.angle', 8));
    const valid = await page.evaluate(async () => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      const geo = await import('/src/editor/engine/geometry.ts' as string);
      const p = rt.ctx.doc.value.store.params;
      const s = rt.ctx.doc.value.source;
      const rect = { x: p.crop.x, y: p.crop.y, w: p.crop.w, h: p.crop.h };
      return { valid: geo.isCropValid(p, s.width, s.height, rect), rect };
    });
    expect(valid.valid, JSON.stringify(valid.rect)).toBe(true);
    await page.keyboard.press('Enter');
    await k(page, (rt) => {
      rt.ctx.doc.value.store.reset('Reset All');
      rt.ctx.tool.set('edit');
    });
  });

  test('AI remove fills a brushed area', async () => {
    await k(page, (rt) => {
      rt.ctx.tool.set('heal');
      rt.ctx.retouchTool.set('ai-remove');
    });
    await page.waitForTimeout(300);
    const r = await imageRect(page);
    const before = await k(page, (rt) => Array.from(rt.ctx.engine.readPixels(64, 'main').data as Uint8ClampedArray));
    await drag(page, r.x + r.w * 0.55, r.y + r.h * 0.72, r.x + r.w * 0.62, r.y + r.h * 0.75);
    await expect.poll(async () => (await params(page)).retouch.removals.length, { timeout: 60_000 }).toBe(1);
    const key = (await params(page)).retouch.removals[0].patchKey;
    await expect.poll(() => k(page, (rt, pk: string) => !!rt.ctx.patchStore.getPatch(pk), key), { timeout: 60_000 }).toBe(true);
    await page.waitForTimeout(300);
    await flush(page);
    const after = await k(page, (rt) => Array.from(rt.ctx.engine.readPixels(64, 'main').data as Uint8ClampedArray));
    let diff = 0;
    for (let i = 0; i < before.length; i++) diff += Math.abs((before[i] as number) - (after[i] as number));
    expect(diff).toBeGreaterThan(0);
    await k(page, (rt) => {
      rt.ctx.tool.set('edit');
      rt.ctx.retouchTool.set('content-aware');
    });
  });

  test('undo / redo keys', async () => {
    await page.locator('.k-viewer__stage').click({ position: { x: 4, y: 4 } });
    await k(page, (rt) => rt.ctx.doc.value.store.set('basic.contrast', 33, { coalesceKey: null }));
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await params(page)).basic.contrast).not.toBe(33);
    await page.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await params(page)).basic.contrast).toBe(33);
  });

  test('arrow keys move to the next / previous photo', async () => {
    const first = await k(page, (rt) => rt.ctx.doc.value.photoId);
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => k(page, (rt) => rt.ctx.doc.value?.photoId), { timeout: 20_000 }).not.toBe(first);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => k(page, (rt) => rt.ctx.doc.value?.photoId), { timeout: 20_000 }).toBe(first);
  });

  test('help overlay lists shortcuts', async () => {
    await page.keyboard.press('Shift+/');
    await expect(page.getByRole('dialog', { name: /Keyboard shortcuts/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('snapshot comparison sets split view with the snapshot', async () => {
    await k(page, (rt) => {
      const s = rt.ctx.doc.value.store;
      s.createSnapshot('Before contrast');
      s.set('basic.exposure', 0.8, { coalesceKey: null });
    });
    await page.locator('.k-pnl-list__item', { hasText: 'Before contrast' }).getByRole('button', { name: 'Snapshot options' }).click();
    await page.getByRole('menuitem', { name: 'Compare with current' }).click();
    await expect.poll(() => k(page, (rt) => rt.ctx.view.value.compare)).toBe('split-vertical');
    expect(await k(page, (rt) => rt.ctx.compareParams.value?.basic.exposure)).toBe(0);
    await k(page, (rt) => {
      rt.ctx.compareParams.set(null);
      rt.ctx.view.set({ ...rt.ctx.view.value, compare: 'off' });
    });
  });

  test('XMP sidecar exports and loads back', async () => {
    await k(page, (rt) => rt.ctx.doc.value.store.set('basic.contrast', 27, { coalesceKey: null }));
    await page.getByRole('button', { name: 'Develop actions' }).click();
    const dl = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: /Export XMP sidecar/ }).click();
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/\.xmp$/);
    const xmp = readFileSync((await download.path())!, 'utf8');
    expect(xmp).toContain('crs:Contrast2012="+27"');
    await k(page, (rt) => rt.ctx.doc.value.store.set('basic.contrast', 0, { coalesceKey: null }));
    await page.getByRole('button', { name: 'Develop actions' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: /Load edit or XMP/ }).click();
    await (await chooser).setFiles({ name: 'look.xmp', mimeType: 'application/rdf+xml', buffer: Buffer.from(xmp) });
    await expect.poll(async () => (await params(page)).basic.contrast).toBe(27);
  });

  test('albums: create, add photos, filter by album', async () => {
    await page.keyboard.press('g');
    await expect.poll(() => k(page, (rt) => rt.ctx.module.value)).toBe('library');
    const albumId = await k(page, async (rt) => {
      const a = await rt.ctx.library.createAlbum('Seoul nights');
      const ids = rt.ctx.library.all().slice(0, 2).map((r: K) => r.id);
      await rt.ctx.library.addToAlbum(ids, a.id);
      return a.id;
    });
    const row = page.locator('[data-album]', { hasText: 'Seoul nights' });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('.k-tile:not([hidden])')).toHaveCount(2);
    expect(albumId).toBeTruthy();
    await page.getByRole('button', { name: /^All Photos/ }).first().click();
    await expect(page.locator('.k-tile:not([hidden])')).toHaveCount(3);
  });

  test('batch: sync settings to other photos and AI auto batch', async () => {
    // The open photo's live settings win over saved edits: close it so the saved source is used.
    await k(page, (rt) => rt.ctx.closePhoto());
    const ids: string[] = await k(page, (rt) => rt.ctx.library.all().map((r: K) => r.id));
    await page.evaluate(async (all) => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      const batch = await import('/src/ui/batch/index.ts' as string);
      const { createDefaultParams } = await import('/src/editor/defaults.ts' as string);
      const src = createDefaultParams(false);
      src.basic.exposure = 0.6;
      src.color.vibrance = 30;
      await rt.ctx.library.saveEdit(all[0], { format: 'kloud-edit', version: 1, params: src, history: [], historyIndex: -1, snapshots: [], updated: Date.now() });
      await batch.runSync(rt.ctx, all[0], [all[1], all[2]], ['exposure', 'color']);
    }, ids);
    const synced = await page.evaluate(async (all) => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      return Promise.all([all[1], all[2]].map(async (id: string) => (await rt.ctx.library.loadEdit(id))?.params));
    }, ids);
    for (const p of synced) {
      expect(p.basic.exposure).toBeCloseTo(0.6, 3);
      expect(p.color.vibrance).toBe(30);
    }
    const result = await page.evaluate(async (all) => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      const batch = await import('/src/ui/batch/index.ts' as string);
      return batch.runAiAutoBatch(rt.ctx, [all[1]]);
    }, ids);
    expect(JSON.stringify(result)).toBeTruthy();
    const auto = await page.evaluate(async (id) => (await (window as unknown as { __kloud: K }).__kloud.ctx.library.loadEdit(id))?.params, ids[1]);
    expect(auto).toBeTruthy();
  });

  test('export formats: PNG 16-bit, TIFF, WebP encode with valid headers', async () => {
    const out = await page.evaluate(async () => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      const ex = await import('/src/editor/export/index.ts' as string);
      const { createDefaultExportSettings } = await import('/src/editor/defaults.ts' as string);
      const id = rt.ctx.library.all()[0].id;
      await rt.ctx.openPhoto(id);
      rt.ctx.module.set('develop');
      const doc = rt.ctx.doc.value;
      const res: Record<string, number[]> = {};
      for (const [format, bitDepth] of [['png', 16], ['tiff', 16], ['webp', 8]] as const) {
        const settings = { ...createDefaultExportSettings(), format, bitDepth, resize: { mode: 'long-edge', value: 640, width: 640, height: 640, dontEnlarge: true } };
        const r = await ex.exportPhoto({
          params: doc.store.params,
          meta: doc.meta,
          settings,
          baseName: 'x',
          index: 0,
          fullOutputSize: { width: doc.source.width, height: doc.source.height },
          render: (w: number, h: number, bd: 8 | 16, cs: string) => rt.ctx.engine.renderFull(doc.store.params, { width: w, height: h, bitDepth: bd, colorSpace: cs }),
        });
        res[format] = [...new Uint8Array(await r.blob.slice(0, 16).arrayBuffer())].concat([r.width, r.height, r.blob.size]);
      }
      return res;
    });
    expect(out.png.slice(0, 4)).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect([0x49, 0x4d]).toContain(out.tiff[0]);
    expect(String.fromCharCode(...out.webp.slice(0, 4))).toBe('RIFF');
    for (const f of ['png', 'tiff', 'webp']) expect(Math.max(out[f][16], out[f][17])).toBe(640);
  });

  test('zooming to 100% on a large photo renders full-resolution detail', async () => {
    await page.evaluate(async () => {
      const rt = (window as unknown as { __kloud: K }).__kloud;
      const c = document.createElement('canvas');
      c.width = 4200;
      c.height = 2800;
      const g = c.getContext('2d')!;
      for (let i = 0; i < 400; i++) {
        g.fillStyle = `hsl(${(i * 37) % 360} 60% ${30 + (i % 5) * 10}%)`;
        g.fillRect((i * 97) % 4200, (i * 53) % 2800, 120, 80);
      }
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
      await rt.ctx.importFiles([new File([blob], 'big.jpg', { type: 'image/jpeg' })]);
      const rec = rt.ctx.library.all().find((x: K) => x.name === 'big.jpg');
      await rt.ctx.openPhoto(rec.id);
      rt.ctx.module.set('develop');
    });
    await page.waitForTimeout(1500);
    await flush(page);
    const proxyW = await k(page, (rt) => rt.ctx.doc.value.source.width);
    expect(proxyW).toBeLessThan(4200);
    await k(page, (rt) => rt.ctx.view.set({ ...rt.ctx.view.value, zoom: 1, center: { x: 0.5, y: 0.5 } }));
    await expect
      .poll(
        async () => {
          await flush(page);
          return k(page, (rt) => rt.ctx.engine.readPixels(8192, 'main').width);
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBeGreaterThan(proxyW);
    await k(page, (rt) => rt.ctx.view.set({ ...rt.ctx.view.value, zoom: 'fit' }));
  });

  test('batch export: several photos with the KLOUD watermark as a zip', async () => {
    const ids: string[] = await k(page, (rt) => rt.ctx.library.all().slice(0, 2).map((r: K) => r.id));
    await k(page, (rt) => {
      const s = structuredClone(rt.ctx.exportSettings.value);
      s.format = 'jpeg';
      s.resize = { ...s.resize, mode: 'long-edge', value: 800 };
      s.watermark = { ...s.watermark, enabled: true, kind: 'kloud-photography' };
      rt.ctx.exportSettings.set(s);
    });
    await k(page, (rt, list: string[]) => rt.ctx.openExportDialog(list), ids);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Export 2 photos');
    const dl = page.waitForEvent('download', { timeout: 120_000 });
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await dl;
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const bytes = readFileSync((await download.path())!);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    // Both JPEGs are in the archive.
    expect(bytes.toString('latin1').match(/\.jpg/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('no uncaught errors', async () => {
    expect(errors).toEqual([]);
  });
});
