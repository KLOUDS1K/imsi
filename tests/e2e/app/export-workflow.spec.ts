import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

test.setTimeout(40_000);

async function openPhoto(page: Page): Promise<void> {
  await page.route('**/api/admin/session', (route) => route.fulfill({ json: { authenticated: true, username: 'test' } }));
  await page.goto('/studio');
  await page.waitForFunction(() => !!(window as any).__kloud);
  await page.evaluate(async () => {
    const rt = (window as any).__kloud;
    const canvas = document.createElement('canvas');
    canvas.width = 600; canvas.height = 400;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#607c98'; g.fillRect(0, 0, 600, 400);
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'));
    const [rec] = await rt.ctx.library.importFiles([new File([blob], 'fixture.png', { type: 'image/png' })]);
    await rt.ctx.openPhoto(rec.id);
    rt.ctx.module.set('develop');
    rt.render.flushNow();
  });
}

async function openExport(page: Page) {
  await page.evaluate(() => {
    const rt = (window as any).__kloud;
    rt.ctx.openExportDialog([rt.ctx.doc.value.photoId]);
  });
  const dialog = page.getByRole('dialog', { name: 'Export photo', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.beforeEach(async ({ page }) => openPhoto(page));

test('width / height inputs control the actual file and live filename preview', async ({ page }) => {
  const dialog = await openExport(page);
  await dialog.getByRole('combobox', { name: 'Format', exact: true }).selectOption('png');
  await dialog.getByRole('combobox', { name: 'Resize', exact: true }).selectOption('width');
  await dialog.getByRole('spinbutton', { name: 'Export width' }).fill('300');
  await expect(dialog.getByTestId('export-size')).toContainText('300 × 200 px');
  await dialog.getByRole('combobox', { name: 'Resize', exact: true }).selectOption('height');
  await dialog.getByRole('spinbutton', { name: 'Export height' }).fill('100');
  await dialog.getByRole('textbox', { name: 'Template', exact: true }).fill('{name}_{width}x{height}_{seq}');
  await dialog.getByRole('spinbutton', { name: 'Sequence start' }).fill('7');
  await expect(dialog.getByTestId('export-size')).toContainText('150 × 100 px');
  await expect(dialog.locator('.k-exp__example')).toHaveText('fixture_150x100_7.png');
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('fixture_150x100_7.png');
  const bytes = readFileSync((await download.path())!);
  expect(bytes.readUInt32BE(16)).toBe(150);
  expect(bytes.readUInt32BE(20)).toBe(100);
});

test('size summary accounts for rotation and crop; JPEG preset resets print color space', async ({ page }) => {
  await page.evaluate(() => {
    const rt = (window as any).__kloud;
    rt.ctx.doc.value.store.update('Crop', (p: any) => {
      p.crop.orientation = 90;
      p.crop.aspect = 'free';
      p.crop.w = 0.5;
    });
  });
  const dialog = await openExport(page);
  await dialog.getByRole('button', { name: 'Print TIFF 16-bit' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Colour space' })).toHaveValue('adobe-rgb');
  await dialog.getByRole('button', { name: 'Full JPEG' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Colour space' })).toHaveValue('srgb');
  await expect(dialog.getByTestId('export-size')).toContainText('200 × 600 px');
});

test('saved output recipes survive reload and restore watermark and dimensions', async ({ page }) => {
  let dialog = await openExport(page);
  await dialog.getByRole('combobox', { name: 'Resize', exact: true }).selectOption('width');
  await dialog.getByRole('spinbutton', { name: 'Export width' }).fill('240');
  await dialog.getByRole('switch', { name: 'Add watermark' }).check();
  await dialog.getByRole('button', { name: 'Save preset…' }).click();
  const save = page.getByRole('dialog', { name: 'Save export preset', exact: true });
  await save.getByRole('textbox', { name: 'Preset name' }).fill('KLOUD Social');
  await save.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Apply export preset KLOUD Social' })).toBeVisible();
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__kloud);
  await page.evaluate(async () => {
    const rt = (window as any).__kloud;
    await rt.ctx.openPhoto(rt.ctx.library.all()[0].id);
    rt.ctx.module.set('develop');
  });
  dialog = await openExport(page);
  await dialog.getByRole('button', { name: 'Apply export preset KLOUD Social' }).click();
  await expect(dialog.getByRole('spinbutton', { name: 'Export width' })).toHaveValue('240');
  await expect(dialog.getByRole('switch', { name: 'Add watermark' })).toBeChecked();
  await expect(dialog.getByTestId('export-size')).toContainText('240 × 160 px');
});

test('stopping an in-flight render produces no download and keeps settings available', async ({ page }) => {
  const dialog = await openExport(page);
  await page.evaluate(() => {
    const rt = (window as any).__kloud;
    const render = rt.ctx.engine.renderFull.bind(rt.ctx.engine);
    rt.ctx.engine.renderFull = async (...args: any[]) => {
      await new Promise<void>((resolve) => { (window as any).releaseExport = resolve; });
      return render(...args);
    };
  });
  const downloads: string[] = [];
  page.on('download', (d) => downloads.push(d.suggestedFilename()));
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).releaseExport);
  await expect(dialog.locator('.k-exp')).toHaveAttribute('inert', '');
  await dialog.getByRole('button', { name: 'Stop export' }).click();
  await page.evaluate(() => (window as any).releaseExport());
  await expect(dialog.getByRole('button', { name: 'Stop export' })).toBeHidden();
  await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  expect(downloads).toEqual([]);
});
