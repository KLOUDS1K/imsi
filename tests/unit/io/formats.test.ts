import { describe, expect, it } from 'vitest';
import { detectFormat, isRawFile, isSupportedFile, rawFormatFromName } from '@/editor/io/formats';

const TIFF_HEADER = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0]);

describe('RAW format aliases', () => {
  it('treats a generic .raw extension as RAW without pretending it is Panasonic RW2', () => {
    expect(rawFormatFromName('capture.RAW')).toBe('OTHER');
    expect(detectFormat(TIFF_HEADER, 'capture.RAW')).toMatchObject({ format: 'raw', rawFormat: 'OTHER' });
  });

  it('accepts common browser MIME aliases for Sony and generic RAW files', () => {
    expect(isSupportedFile({ name: 'capture', type: 'image/arw' })).toBe(true);
    expect(isSupportedFile({ name: 'capture', type: 'image/x-raw' })).toBe(true);
    expect(isSupportedFile({ name: 'capture.ARW', type: '' })).toBe(true);
    expect(isRawFile({ name: 'capture', type: 'image/arw' })).toBe(true);
  });
});
