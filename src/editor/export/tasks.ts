/**
 * Pixel-heavy encode jobs (PNG filter+deflate, TIFF strips+deflate, DNG
 * linearization). Pure and synchronous; executed by encode.worker.ts or inline
 * when workers are unavailable (Node tests, restrictive CSP).
 */
import { encodeDng, type DngEncodeOptions } from './dng';
import { encodePng, type PngMetadata } from './png';
import { encodeTiff, type TiffEncodeOptions } from './tiff';

interface TaskBase {
  data: Uint8ClampedArray | Uint16Array;
  width: number;
  height: number;
  bitDepth: 8 | 16;
}

export type EncodeTask =
  | (TaskBase & { kind: 'png'; meta: PngMetadata })
  | (TaskBase & { kind: 'tiff'; opts: TiffEncodeOptions })
  | (TaskBase & { kind: 'dng'; opts: DngEncodeOptions });

export function runEncodeTaskSync(t: EncodeTask): Uint8Array {
  switch (t.kind) {
    case 'png':
      return encodePng(t.data, t.width, t.height, t.bitDepth, t.meta);
    case 'tiff':
      return encodeTiff(t.data, t.width, t.height, t.bitDepth, t.opts);
    case 'dng':
      return encodeDng(t.data, t.width, t.height, t.bitDepth, t.opts);
  }
}
