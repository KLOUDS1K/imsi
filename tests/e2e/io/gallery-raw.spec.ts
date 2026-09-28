import { expect, test } from '@playwright/test';

test('gallery upload creates oriented preview derivatives from an ARW embedded JPEG', async ({ page }) => {
  await page.goto('/tests/e2e/io/probe.html');
  const result = await page.evaluate(async () => {
    const imagingPath = '/gallery/src/app/imaging.ts';
    const ioPath = '/src/editor/io/index.ts';
    const fixturePath = '/tests/e2e/io/fixtures.ts';
    const [{ generateDerivatives }, { readMetadata }, { writeTiff, T }] = await Promise.all([
      import(imagingPath),
      import(ioPath),
      import(fixturePath),
    ]);

    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    canvas.height = 800;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#6e7f94';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const jpeg = new Uint8Array(await (await new Promise<Blob>((resolve) =>
      canvas.toBlob((blob) => resolve(blob!), 'image/jpeg', 0.9))).arrayBuffer());
    const container = writeTiff([
      { tag: 256, type: T.LONG, values: [1200] },
      { tag: 257, type: T.LONG, values: [800] },
      { tag: 271, type: T.ASCII, values: 'SONY' },
      { tag: 272, type: T.ASCII, values: 'ZV-E10' },
      { tag: 274, type: T.SHORT, values: [6] },
    ], jpeg);
    const file = new File([container], 'DSC01890.ARW', { type: 'image/arw' });
    const [derived, meta] = await Promise.all([generateDerivatives(file), readMetadata(file, file.name)]);
    const dimensions = async (blob: Blob | null) => {
      if (!blob) return null;
      const bitmap = await createImageBitmap(blob);
      const size = [bitmap.width, bitmap.height];
      bitmap.close();
      return size;
    };
    return {
      width: derived.width,
      height: derived.height,
      preview: await dimensions(derived.preview),
      thumb: await dimensions(derived.thumb),
      placeholder: derived.placeholder?.startsWith('data:image/jpeg') ?? false,
      warning: derived.warning,
      meta: {
        format: meta.format,
        rawFormat: meta.rawFormat,
        make: meta.make,
        model: meta.model,
        orientation: meta.orientation,
        width: meta.width,
        height: meta.height,
      },
    };
  });

  expect(result).toEqual({
    width: 800,
    height: 1200,
    preview: [800, 1200],
    thumb: [600, 900],
    placeholder: true,
    warning: null,
    meta: {
      format: 'raw',
      rawFormat: 'ARW',
      make: 'SONY',
      model: 'ZV-E10',
      orientation: 6,
      width: 800,
      height: 1200,
    },
  });
});
