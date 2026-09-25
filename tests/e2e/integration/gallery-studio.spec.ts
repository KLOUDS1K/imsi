import { expect, test } from '@playwright/test';

const PHOTO_ID = '11111111-1111-4111-8111-111111111111';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

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
    originalUrl: `/media/o/${PHOTO_ID}?sig=test`,
  };

  await page.route('**/api/tree', (route) => route.fulfill({ json: { folders: [], admin: false, siteTitle: 'KLOUD.PHOTOGRAPHY' } }));
  await page.route('**/api/browse?**', (route) => route.fulfill({ json: { folder: null, path: [], folders: [], photos: [photo], admin: false, lock: null } }));
  await page.route('**/api/hit', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/media/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));

  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Open KLOUD Studio' })).toBeVisible();
  await page.getByRole('link', { name: 'View Studio handoff' }).click();
  await page.getByRole('button', { name: 'Edit Studio handoff in KLOUD Studio' }).click();

  await expect(page).toHaveURL(/\/studio$/);
  await expect(page.locator('.k-app[data-module="develop"]')).toBeVisible({ timeout: 30_000 });
  const back = page.getByRole('button', { name: 'Back to photos' });
  await expect(back).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(/\/$/);
});
