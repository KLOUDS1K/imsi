import { describe, expect, it } from 'vitest';
import { bestPreviewFor } from '@/editor/io/jpeg';

// Structurally valid JPEG streams are enough to exercise preview selection.
function jpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 1, 0xff, 0xd9]);
}

describe('RAW embedded JPEG selection', () => {
  const bytes = new Uint8Array([...jpeg(160, 100), ...jpeg(1600, 1000), ...jpeg(6000, 4000)]);
  it('selects the largest image for full resolution', () => {
    expect(bestPreviewFor(bytes, 0)).toMatchObject({ width: 6000, height: 4000 });
  });
  it('keeps the cheaper preview for thumbnails and falls back to the largest if needed', () => {
    expect(bestPreviewFor(bytes, 320)).toMatchObject({ width: 1600, height: 1000 });
    expect(bestPreviewFor(bytes, 8000)).toMatchObject({ width: 6000, height: 4000 });
    expect(bestPreviewFor(new Uint8Array(), 0)).toBeNull();
  });
});
