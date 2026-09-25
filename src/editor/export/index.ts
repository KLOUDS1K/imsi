/**
 * Export module: sizing, naming, output sharpening, encoders (JPEG / PNG /
 * WebP / TIFF / rendered linear DNG) with ICC + EXIF/XMP + DPI, zip & download.
 */
import type { ExportJob, ExportModule, ExportResult } from '@/editor/contracts';
import { applyWatermark } from '@/editor/watermark';
import { encodeImage } from './encode';
import { buildFileName, fileExtension } from './filename';
import { buildIccProfile } from './icc';
import { applyOutputSharpening } from './sharpen';
import { computeExportSize } from './size';
import { downloadBlob, zipResults } from './zip';

export { computeExportSize, exportScale } from './size';
export { buildFileName, fileExtension, sanitizeFileStem, type FileNameContext } from './filename';
export { applyOutputSharpening, sharpenParams } from './sharpen';
export { encodeImage, MIME } from './encode';
export { buildIccProfile, validateIccProfile } from './icc';
export { zipResults, downloadBlob } from './zip';
export { loadExportPresets, saveExportPreset, deleteExportPreset, type ExportPreset } from './presets';

/**
 * Optional extensions an ExportJob may carry (see docs/CONTRACT_CHANGES.md):
 * `batchSize` zero-pads {seq} to the largest number in the batch, `rating`
 * feeds {rating}, `signal` aborts between steps.
 */
export interface ExportJobExtras {
  batchSize?: number;
  rating?: number;
  signal?: AbortSignal;
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Export aborted', 'AbortError');
}

/** Full job: size → render → sharpen → watermark → encode → name. */
export async function exportPhoto(job: ExportJob & ExportJobExtras): Promise<ExportResult> {
  const s = job.settings;
  const { width, height } = computeExportSize(job.fullOutputSize.width, job.fullOutputSize.height, s.resize);
  // JPEG/WebP are 8-bit containers; DNG is always rendered at 16 bits.
  const bitDepth: 8 | 16 = s.format === 'dng' ? 16 : s.format === 'jpeg' || s.format === 'webp' ? 8 : s.bitDepth === 16 ? 16 : 8;
  checkAbort(job.signal);
  const img = await job.render(width, height, bitDepth, s.colorSpace);
  checkAbort(job.signal);
  if (s.outputSharpening?.enabled && s.format !== 'dng') applyOutputSharpening(img, s.outputSharpening);
  if (s.watermark?.enabled) await applyWatermark(img, s.watermark);
  checkAbort(job.signal);
  const blob = await encodeImage(img, s, job.meta);
  checkAbort(job.signal);
  const start = Number.isFinite(s.sequenceStart) ? Math.round(s.sequenceStart) : 1;
  const seq = start + job.index;
  const seqWidth = job.batchSize && job.batchSize > 0 ? String(start + job.batchSize - 1).length : undefined;
  const fileName = buildFileName(
    s.fileNameTemplate,
    { name: job.baseName, seq, meta: job.meta, width: img.width, height: img.height, preset: job.presetName, seqWidth, rating: job.rating },
    fileExtension(s.format),
  );
  return { blob, fileName, width: img.width, height: img.height };
}

export const exportModule = {
  computeExportSize,
  buildFileName,
  fileExtension,
  applyOutputSharpening,
  encodeImage,
  exportPhoto,
  zipResults,
  downloadBlob,
  buildIccProfile,
} satisfies ExportModule;
