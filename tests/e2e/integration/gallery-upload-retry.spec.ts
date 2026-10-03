import { expect, test, type Page } from '@playwright/test';

async function uploadTestPhoto(page: Page) {
  return page.evaluate(async () => {
    const uploadPath = '/gallery/src/app/upload.ts';
    const { uploadPhoto } = await import(uploadPath);
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 24;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#6e7f94';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((value) => resolve(value!), 'image/jpeg', 0.9),
    );
    const file = new File([blob], 'batch-photo.jpg', { type: 'image/jpeg' });
    const progress: Array<{ stage: string; detail?: string }> = [];

    try {
      const result = await uploadPhoto(file, '', (value: { stage: string; detail?: string }) => progress.push(value));
      return { result, error: null, progress };
    } catch (error) {
      return {
        result: null,
        error: error instanceof Error ? error.message : String(error),
        progress,
      };
    }
  });
}

test('retries interrupted upload stages without deleting a committed photo', async ({ page }) => {
  let originalAttempts = 0;
  let commitAttempts = 0;
  let cleanupAttempts = 0;

  await page.route('**/api/admin/photos/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;

    if (request.method() === 'PUT' && pathname.endsWith('/original')) {
      originalAttempts += 1;
      if (originalAttempts === 1) {
        await route.fulfill({ status: 503, json: { error: 'temporary upload failure' } });
      } else {
        await route.fulfill({ status: 200 });
      }
      return;
    }
    if (request.method() === 'PUT') {
      await route.fulfill({ status: 200 });
      return;
    }
    if (request.method() === 'POST') {
      commitAttempts += 1;
      if (commitAttempts === 1) {
        await route.abort('connectionreset');
      } else {
        await route.fulfill({ status: 200, json: { ok: true, id: 'committed', alreadyCommitted: true } });
      }
      return;
    }
    if (request.method() === 'DELETE') {
      cleanupAttempts += 1;
      await route.fulfill({ status: 200, json: { ok: true } });
      return;
    }
    await route.fallback();
  });

  await page.goto('/tests/e2e/io/probe.html');
  const result = await uploadTestPhoto(page);

  expect(result.error).toBeNull();
  expect(result.result?.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(originalAttempts).toBe(2);
  expect(commitAttempts).toBe(2);
  expect(cleanupAttempts).toBe(0);
  expect(result.progress.map((value) => value.detail).filter(Boolean)).toEqual([
    'Retrying original · 2/3',
    'Confirming upload · 2/3',
  ]);
});

test('keeps staging objects when all commit responses fail and the server outcome is unknown', async ({ page }) => {
  let commitAttempts = 0;
  let cleanupAttempts = 0;

  await page.route('**/api/admin/photos/**', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      await route.fulfill({ status: 200 });
      return;
    }
    if (request.method() === 'POST') {
      commitAttempts += 1;
      await route.fulfill({ status: 503, json: { error: 'temporary commit failure' } });
      return;
    }
    if (request.method() === 'DELETE') {
      cleanupAttempts += 1;
      await route.fulfill({ status: 200, json: { ok: true } });
      return;
    }
    await route.fallback();
  });

  await page.goto('/tests/e2e/io/probe.html');
  const result = await uploadTestPhoto(page);

  expect(result.result).toBeNull();
  expect(result.error).toBe('Could not confirm the upload. Refresh the gallery before retrying this photo.');
  expect(commitAttempts).toBe(3);
  expect(cleanupAttempts).toBe(0);
  expect(result.progress.map((value) => value.detail).filter(Boolean)).toEqual([
    'Confirming upload · 2/3',
    'Confirming upload · 3/3',
  ]);
});

test('cleans up only uploads that never reached the commit stage', async ({ page }) => {
  let originalAttempts = 0;
  let commitAttempts = 0;
  let cleanupHeader: string | undefined;

  await page.route('**/api/admin/photos/**', async (route) => {
    const request = route.request();
    if (request.method() === 'PUT') {
      originalAttempts += 1;
      await route.fulfill({ status: 503, json: { error: 'temporary original failure' } });
    } else if (request.method() === 'POST') {
      commitAttempts += 1;
      await route.fulfill({ status: 200, json: { ok: true } });
    } else if (request.method() === 'DELETE') {
      cleanupHeader = request.headers()['x-upload-cleanup'];
      await route.fulfill({ status: 200, json: { ok: true } });
    } else {
      await route.fallback();
    }
  });

  await page.goto('/tests/e2e/io/probe.html');
  const result = await uploadTestPhoto(page);

  expect(result.error).toBe('temporary original failure');
  expect(originalAttempts).toBe(3);
  expect(commitAttempts).toBe(0);
  expect(cleanupHeader).toBe('1');
});
