import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const PHOTO_ID = '11111111-1111-4111-8111-111111111111';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('first paint shows the branded boot shell instead of raw controls', async ({ page }) => {
  const html = readFileSync('index.html', 'utf8').replace(/<script type="module"[\s\S]*?<\/script>/, '');
  await page.setContent(html);
  await expect(page.locator('.boot-splash__mark')).toHaveText('KLOUD.PHOTOGRAPHY');
  await expect(page.locator('.boot-splash')).toBeVisible();
  expect(await page.locator('.app').evaluate((node) => getComputedStyle(node).visibility)).toBe('hidden');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test('gallery opens a stored original directly in Studio', async ({ page }) => {
  const photo = {
    id: PHOTO_ID,
    folderId: '',
    title: 'Studio handoff',
    date: null,
    location: '',
    description: '',
    width: 1,
    height: 1,
    placeholder: null,
    filename: 'handoff.png',
    size: PNG.byteLength,
    type: 'image/png',
    createdAt: 1,
    thumbUrl: `/media/t/${PHOTO_ID}?sig=test`,
    previewUrl: `/media/p/${PHOTO_ID}?sig=test`,
    originalThumbUrl: `/media/t/${PHOTO_ID}?sig=test`,
    originalPreviewUrl: `/media/p/${PHOTO_ID}?sig=test`,
    originalUrl: `/media/o/${PHOTO_ID}?sig=test`,
    editedUrl: null,
    editedPreviewUrl: null,
    editedThumbUrl: null,
    editedFilename: null,
    editedSize: null,
    editedType: null,
    editedWidth: null,
    editedHeight: null,
    editedUpdatedAt: null,
  };

  await page.route('**/api/tree', (route) => route.fulfill({ json: { folders: [], admin: true, siteTitle: 'KLOUD.PHOTOGRAPHY' } }));
  await page.route('**/api/browse?**', (route) => route.fulfill({ json: { folder: null, path: [], folders: [], photos: [photo], admin: true, lock: null } }));
  await page.route('**/api/admin/session', (route) => route.fulfill({ json: { authenticated: true, username: 'test' } }));
  await page.route('**/api/hit', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/media/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Open KLOUD Studio' })).toBeVisible();
  await page.getByRole('link', { name: 'View Studio handoff' }).click();
  await page.getByRole('button', { name: 'Edit the original of Studio handoff in KLOUD Studio' }).click();

  await expect(page).toHaveURL(new RegExp(`/studio\\?photo=${PHOTO_ID}$`));
  await expect(page.locator('.k-app[data-module="develop"]')).toBeVisible({ timeout: 30_000 });
  const back = page.getByRole('button', { name: 'Back to photos' });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(new RegExp(`[?&]p=${PHOTO_ID}(?:&|$)`));
});

test('anonymous visitors cannot see or open Studio', async ({ page }) => {
  await page.route('**/api/tree', (route) => route.fulfill({ json: { folders: [], admin: false, siteTitle: 'KLOUD.PHOTOGRAPHY' } }));
  await page.route('**/api/browse?**', (route) => route.fulfill({ json: { folder: null, path: [], folders: [], photos: [], admin: false, lock: null } }));
  await page.route('**/api/hit', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/admin/session', (route) => route.fulfill({ json: { authenticated: false, username: null } }));
  await page.route('**/api/admin/setup', (route) => route.fulfill({ json: { needsSetup: false, requiresKey: false, setupAllowed: true } }));

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Open KLOUD Studio' })).toBeHidden();
  await page.goto('/studio');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('lightbox prefers edits, switches versions, exposes both downloads, and zooms at the pointer', async ({ page }) => {
  const photo = {
    id: PHOTO_ID,
    folderId: '',
    title: 'Edited handoff',
    date: null,
    location: '',
    description: '',
    width: 1,
    height: 1,
    placeholder: null,
    filename: 'original.png',
    size: PNG.byteLength,
    type: 'image/png',
    createdAt: 1,
    thumbUrl: `/media/et/${PHOTO_ID}?t=test`,
    previewUrl: `/media/ep/${PHOTO_ID}?t=test`,
    originalThumbUrl: `/media/t/${PHOTO_ID}?t=test`,
    originalPreviewUrl: `/media/p/${PHOTO_ID}?t=test`,
    originalUrl: `/media/o/${PHOTO_ID}?t=test`,
    editedUrl: `/media/e/${PHOTO_ID}?t=test`,
    editedPreviewUrl: `/media/ep/${PHOTO_ID}?t=test`,
    editedThumbUrl: `/media/et/${PHOTO_ID}?t=test`,
    editedFilename: 'original_edited.jpg',
    editedSize: PNG.byteLength,
    editedType: 'image/jpeg',
    editedWidth: 1,
    editedHeight: 1,
    editedUpdatedAt: 2,
  };
  await page.route('**/api/tree', (route) => route.fulfill({ json: { folders: [], admin: false, siteTitle: 'KLOUD.PHOTOGRAPHY' } }));
  await page.route('**/api/browse?**', (route) => route.fulfill({ json: { folder: null, path: [], folders: [], photos: [photo], admin: false, lock: null } }));
  await page.route('**/api/hit', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/media/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));

  await page.goto('/');
  await page.getByRole('link', { name: 'View Edited handoff' }).click();
  const lightbox = page.locator('[data-role="lightbox"]');
  await expect(lightbox.locator('.viewer__badge')).toHaveText('Edited');
  await expect(lightbox.getByRole('button', { name: 'Download the original of Edited handoff' })).toBeVisible();
  await expect(lightbox.getByRole('button', { name: 'Download the edited version of Edited handoff' })).toBeVisible();
  await expect(lightbox.getByRole('button', { name: /Edit the original/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Show original version of Edited handoff' }).click();
  await expect(lightbox.locator('.viewer__badge')).toHaveText('Original');
  await expect(page.getByRole('button', { name: 'Show edited version of Edited handoff' })).toBeVisible();

  const figure = page.locator('.viewer__figure');
  await figure.click({ position: { x: 0, y: 0 } });
  const stage = page.locator('.viewer__stage');
  await expect(stage).toHaveClass(/is-zoomed/);
  const beforeWheel = await figure.evaluate((node) => getComputedStyle(node).transform);
  // Once zoomed, the stage intentionally owns wheel/pan input and sits above
  // the transformed figure. Move over that real input surface.
  await stage.hover({ position: { x: 8, y: 8 } });
  await page.mouse.wheel(0, -200);
  const afterWheel = await figure.evaluate((node) => getComputedStyle(node).transform);
  expect(afterWheel).not.toBe(beforeWheel);
});
