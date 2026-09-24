/**
 * Supported file types and format detection (extension + magic bytes).
 */
import type { PhotoFormat, RawFormat } from '../types';
import { ascii, u16be, u16le, u32be } from './binary';

const RAW_EXTENSIONS: Record<string, RawFormat> = {
  arw: 'ARW',
  srf: 'ARW',
  sr2: 'ARW',
  cr2: 'CR2',
  cr3: 'CR3',
  crw: 'OTHER',
  nef: 'NEF',
  nrw: 'NEF',
  dng: 'DNG',
  raf: 'RAF',
  orf: 'ORF',
  rw2: 'RW2',
  raw: 'RW2',
  pef: 'PEF',
  srw: 'SRW',
  '3fr': 'OTHER',
  iiq: 'OTHER',
  x3f: 'OTHER',
  erf: 'OTHER',
  mrw: 'OTHER',
  kdc: 'OTHER',
  rwl: 'OTHER',
};

const RASTER_EXTENSIONS: Record<string, PhotoFormat> = {
  jpg: 'jpeg',
  jpeg: 'jpeg',
  jpe: 'jpeg',
  jfif: 'jpeg',
  png: 'png',
  webp: 'webp',
  avif: 'avif',
  gif: 'gif',
  bmp: 'bmp',
  tif: 'tiff',
  tiff: 'tiff',
  heic: 'heic',
  heif: 'heic',
};

/** Lower-case extensions with a leading dot. */
export const SUPPORTED_EXTENSIONS: string[] = [...Object.keys(RASTER_EXTENSIONS), ...Object.keys(RAW_EXTENSIONS)].map(
  (e) => '.' + e,
);

const MIME_BY_FORMAT: Record<PhotoFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
  raw: 'image/x-raw',
  heic: 'image/heic',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  unknown: 'application/octet-stream',
};

const SUPPORTED_MIME = new Set([
  'image/jpeg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/heic',
  'image/heif',
  'image/x-adobe-dng',
  'image/dng',
  'image/x-sony-arw',
  'image/x-canon-cr2',
  'image/x-canon-cr3',
  'image/x-nikon-nef',
  'image/x-fuji-raf',
  'image/x-olympus-orf',
  'image/x-panasonic-rw2',
  'image/x-pentax-pef',
  'image/x-samsung-srw',
]);

/** For `<input accept>`: every extension plus the image MIME wildcard. */
export const ACCEPT_ATTRIBUTE: string = ['image/*', ...SUPPORTED_EXTENSIONS].join(',');

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i + 1).toLowerCase();
}

export function isRawFileName(name: string): boolean {
  return extensionOf(name) in RAW_EXTENSIONS;
}

export function rawFormatFromName(name: string): RawFormat | undefined {
  return RAW_EXTENSIONS[extensionOf(name)];
}

export function isSupportedFile(file: { name: string; type?: string }): boolean {
  const ext = extensionOf(file.name);
  if (ext in RAW_EXTENSIONS || ext in RASTER_EXTENSIONS) return true;
  const t = (file.type ?? '').toLowerCase();
  return t !== '' && SUPPORTED_MIME.has(t);
}

export function mimeForFormat(format: PhotoFormat, raw?: RawFormat): string {
  if (format === 'raw' && raw === 'DNG') return 'image/x-adobe-dng';
  return MIME_BY_FORMAT[format];
}

export interface FormatInfo {
  format: PhotoFormat;
  rawFormat?: RawFormat;
  mimeType: string;
}

/**
 * Detect the container format from the first bytes, falling back to the
 * extension and the blob MIME type. Magic bytes win over the extension
 * (e.g. a PNG saved as .jpg), except that TIFF-based RAW files are identified
 * by their extension (they all share the TIFF header).
 */
export function detectFormat(head: Uint8Array, name: string, mime = ''): FormatInfo {
  const ext = extensionOf(name);
  const extRaw = RAW_EXTENSIONS[ext];
  const magic = sniff(head);
  if (magic.rawFormat) return { format: 'raw', rawFormat: magic.rawFormat, mimeType: mimeForFormat('raw', magic.rawFormat) };
  if (magic.format === 'tiff') {
    if (extRaw) return { format: 'raw', rawFormat: extRaw, mimeType: mime || mimeForFormat('raw', extRaw) };
    if (magic.isDng) return { format: 'raw', rawFormat: 'DNG', mimeType: mimeForFormat('raw', 'DNG') };
    return { format: 'tiff', mimeType: 'image/tiff' };
  }
  if (magic.format !== 'unknown') return { format: magic.format, mimeType: MIME_BY_FORMAT[magic.format] };
  if (extRaw) return { format: 'raw', rawFormat: extRaw, mimeType: mime || mimeForFormat('raw', extRaw) };
  const extFmt = RASTER_EXTENSIONS[ext];
  if (extFmt) return { format: extFmt, mimeType: MIME_BY_FORMAT[extFmt] };
  const m = mime.toLowerCase();
  for (const [f, mt] of Object.entries(MIME_BY_FORMAT) as [PhotoFormat, string][]) {
    if (m === mt) return { format: f, mimeType: mt };
  }
  return { format: 'unknown', mimeType: mime || MIME_BY_FORMAT.unknown };
}

interface Sniffed {
  format: PhotoFormat;
  rawFormat?: RawFormat;
  isDng?: boolean;
}

function sniff(b: Uint8Array): Sniffed {
  if (b.length < 12) return { format: 'unknown' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { format: 'jpeg' };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { format: 'png' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { format: 'webp' };
  if (ascii(b, 0, 3) === 'GIF') return { format: 'gif' };
  if (b[0] === 0x42 && b[1] === 0x4d) return { format: 'bmp' };
  if (ascii(b, 0, 15) === 'FUJIFILMCCD-RAW') return { format: 'raw', rawFormat: 'RAF' };
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'crx ') return { format: 'raw', rawFormat: 'CR3' };
    if (brand === 'avif' || brand === 'avis') return { format: 'avif' };
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return { format: 'heic' };
  }
  const bo = ascii(b, 0, 2);
  if (bo === 'II' || bo === 'MM') {
    const le = bo === 'II';
    const magic = le ? u16le(b, 2) : u16be(b, 2);
    if (le && ascii(b, 2, 2) === 'RO') return { format: 'raw', rawFormat: 'ORF' };
    if (le && ascii(b, 2, 2) === 'RS') return { format: 'raw', rawFormat: 'ORF' };
    if (!le && ascii(b, 2, 2) === 'OR') return { format: 'raw', rawFormat: 'ORF' };
    if (le && magic === 0x55) return { format: 'raw', rawFormat: 'RW2' };
    if (magic === 42) {
      if (le && b[8] === 0x43 && b[9] === 0x52 && b[10] === 2) return { format: 'raw', rawFormat: 'CR2' };
      return { format: 'tiff', isDng: hasDngVersionTag(b, le) };
    }
  }
  return { format: 'unknown' };
}

/** DNGVersion (50706) in IFD0 → it is a DNG even when the extension says .tif. */
function hasDngVersionTag(b: Uint8Array, le: boolean): boolean {
  const r16 = le ? u16le : u16be;
  const off = le ? (b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24)) >>> 0 : u32be(b, 4);
  if (off + 2 > b.length) return false;
  const n = r16(b, off);
  for (let i = 0; i < n; i++) {
    const p = off + 2 + i * 12;
    if (p + 2 > b.length) return false;
    if (r16(b, p) === 50706) return true;
  }
  return false;
}
