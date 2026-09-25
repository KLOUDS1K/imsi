import { expect, test } from '@playwright/test';

for (const orientation of [1, 6]) {
  test(`RAW JPEG preview reloads the largest embedded image (orientation ${orientation})`, async ({ page }) => {
    await page.goto('/tests/e2e/io/probe.html');
    const result = await page.evaluate(async (orientation) => {
      const ioPath = '/src/editor/io/index.ts';
      const fixturePath = '/tests/e2e/io/fixtures.ts';
      const { decodeFile } = await import(ioPath);
      const { writeTiff, T } = await import(fixturePath);
      const jpeg = async (w: number, h: number) => {
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d')!; g.fillStyle = '#72849c'; g.fillRect(0, 0, w, h);
        return new Uint8Array(await (await new Promise<Blob>((resolve) => c.toBlob((b) => resolve(b!), 'image/jpeg'))).arrayBuffer());
      };
      const small = await jpeg(160, 100);
      const large = await jpeg(900, 600);
      const container = writeTiff([{ tag: 274, type: T.SHORT, values: [orientation] }], new Uint8Array([...small, ...large]));
      const decoded = await decodeFile(new Blob([container]), 'preview.arw', { maxSize: 90, preferEmbeddedPreview: true });
      const full = await decoded.loadFull();
      return { proxy: [decoded.source.width, decoded.source.height], size: [decoded.source.fullWidth, decoded.source.fullHeight],
        full: [full.width, full.height], isRaw: decoded.source.isRaw, bitDepth: full.bitDepth, fallback: decoded.meta.exif?.__kloudFallback };
    }, orientation);
    expect(Math.max(...result.proxy)).toBe(90);
    const full = orientation === 6 ? [600, 900] : [900, 600];
    expect(result.size).toEqual(full);
    expect(result.full).toEqual(full);
    expect(result.isRaw).toBe(true);
    expect(result.bitDepth).toBe(8);
    expect(result.fallback).toBe('embedded-preview');
  });
}
