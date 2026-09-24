/**
 * Export file naming: template tokens + cross-platform sanitizing.
 *
 * Tokens (case-insensitive): {name} {seq} {date} {camera} {lens} {iso} {rating}
 * {width} {height} {preset}. Unknown tokens are kept literally.
 *
 * {seq} is zero-padded to `seqWidth` digits (exportPhoto passes the width of the
 * largest number in the batch; without it the number is not padded).
 * {date} is YYYYMMDD from meta.dateTaken (wall-clock digits, no timezone shift),
 * or today's local date.
 */
import type { ExportSettings, PhotoMeta } from '@/editor/types';

export interface FileNameContext {
  name: string;
  seq: number;
  meta: PhotoMeta;
  width: number;
  height: number;
  preset?: string;
  /** Extension (optional): zero-pad {seq} to this many digits. */
  seqWidth?: number;
  /** Extension (optional): library rating 0..5 (else meta.exif.Rating). */
  rating?: number;
}

const EXT: Record<ExportSettings['format'], string> = { jpeg: 'jpg', png: 'png', webp: 'webp', tiff: 'tif', dng: 'dng' };

export function fileExtension(format: ExportSettings['format']): string {
  return EXT[format] ?? 'bin';
}

/** Characters illegal on Windows / macOS / Linux file systems, plus control chars. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f\u007f]+/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const MAX_STEM = 180;

/** Sanitize a file-name stem (no extension) for every common OS. */
export function sanitizeFileStem(s: string): string {
  let out = s.normalize('NFC').replace(ILLEGAL, '_').replace(/\s+/g, ' ').trim();
  out = out.replace(/[. ]+$/g, ''); // Windows drops trailing dots/spaces
  out = out.replace(/^\.+/, ''); // no hidden / dot-only names
  if (!out) out = 'untitled';
  if (RESERVED.test(out)) out = `_${out}`;
  if (out.length > MAX_STEM) out = Array.from(out).slice(0, MAX_STEM).join('').replace(/[. ]+$/g, '') || 'untitled';
  return out;
}

export function dateToken(dateTaken: string | undefined, now: Date = new Date()): string {
  const m = dateTaken ? /^(\d{4})[-:]?(\d{2})[-:]?(\d{2})/.exec(dateTaken.trim()) : null;
  if (m) return `${m[1]}${m[2]}${m[3]}`;
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

function ratingOf(ctx: FileNameContext): number {
  if (typeof ctx.rating === 'number' && Number.isFinite(ctx.rating)) return Math.max(0, Math.min(5, Math.round(ctx.rating)));
  const r = ctx.meta.exif?.['Rating'];
  return typeof r === 'number' && Number.isFinite(r) ? Math.max(0, Math.min(5, Math.round(r))) : 0;
}

const stripExt = (name: string) => name.replace(/\.[A-Za-z0-9]{1,5}$/, '');

export function buildFileName(template: string, ctx: FileNameContext, ext: string): string {
  const meta = ctx.meta;
  const seqStr = String(Math.max(0, Math.round(ctx.seq)));
  const values: Record<string, () => string> = {
    name: () => ctx.name || stripExt(meta.fileName || '') || 'untitled',
    seq: () => (ctx.seqWidth ? seqStr.padStart(ctx.seqWidth, '0') : seqStr),
    date: () => dateToken(meta.dateTaken),
    camera: () => meta.camera || [meta.make, meta.model].filter(Boolean).join(' '),
    lens: () => meta.lens ?? '',
    iso: () => (meta.iso ? String(Math.round(meta.iso)) : ''),
    rating: () => String(ratingOf(ctx)),
    width: () => String(ctx.width),
    height: () => String(ctx.height),
    preset: () => ctx.preset ?? '',
  };
  const tpl = template && template.trim() ? template : '{name}';
  let stem = tpl.replace(/\{(\w+)\}/g, (all, key: string) => {
    const f = values[key.toLowerCase()];
    return f ? f() : all;
  });
  // Tokens that resolved to empty leave doubled separators behind ("a__b") — tidy them.
  stem = stem.replace(/([_\- ])\1+/g, '$1').replace(/^[_\- ]+|[_\- ]+$/g, '');
  const e = ext.replace(/^\.+/, '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  const safe = sanitizeFileStem(stem);
  return e ? `${safe}.${e}` : safe;
}
