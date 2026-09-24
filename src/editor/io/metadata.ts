/** EXIF → PhotoMeta (exifr), with header-based fallbacks for dimensions. */
import exifr from 'exifr';
import type { PhotoMeta } from '../types';
import { readHead } from './binary';
import { normalizeCameraName } from './camera-names';
import { headerInfo } from './dimensions';
import { detectFormat } from './formats';

type Tags = Record<string, unknown>;

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v) && typeof v[0] === 'number') return v[0];
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};
const str = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\0/g, '').trim();
  return s || undefined;
};

function isoDate(v: unknown): string | undefined {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v === 'string') {
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(v);
    if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toISOString();
  }
  return undefined;
}

/** Fill a PhotoMeta from parsed tags (shared with the RAW path). */
export function metaFromTags(base: PhotoMeta, t: Tags): PhotoMeta {
  const m: PhotoMeta = { ...base };
  m.make = str(t.Make) ?? m.make;
  m.model = str(t.Model) ?? m.model;
  m.camera = normalizeCameraName(m.make, m.model) ?? m.camera;
  m.lensMake = str(t.LensMake) ?? m.lensMake;
  m.lens = str(t.LensModel) ?? str(t.Lens) ?? m.lens;
  m.focalLength = num(t.FocalLength) ?? m.focalLength;
  m.focalLength35 = num(t.FocalLengthIn35mmFormat) ?? m.focalLength35;
  m.aperture = num(t.FNumber) ?? num(t.ApertureValue) ?? m.aperture;
  m.shutter = num(t.ExposureTime) ?? m.shutter;
  m.iso = num(t.ISO) ?? num(t.ISOSpeedRatings) ?? num(t.PhotographicSensitivity) ?? m.iso;
  m.exposureCompensation = num(t.ExposureCompensation) ?? num(t.ExposureBiasValue) ?? m.exposureCompensation;
  const flash = num(t.Flash);
  if (flash !== undefined) m.flash = (flash & 1) === 1;
  m.dateTaken = isoDate(t.DateTimeOriginal) ?? isoDate(t.CreateDate) ?? isoDate(t.ModifyDate) ?? m.dateTaken;
  const lat = num(t.latitude);
  const lon = num(t.longitude);
  if (lat !== undefined && lon !== undefined) m.gps = { lat, lon, alt: num(t.GPSAltitude) };
  m.artist = str(t.Artist) ?? m.artist;
  m.copyright = str(t.Copyright) ?? m.copyright;
  m.software = str(t.Software) ?? m.software;
  const cs = num(t.ColorSpace);
  if (cs !== undefined) m.colorSpace = cs === 1 ? 'sRGB' : cs === 2 ? 'Adobe RGB' : 'Uncalibrated';
  const o = num(t.Orientation);
  if (o && o >= 1 && o <= 8) m.orientation = o;
  if (!m.lens && m.focalLength) {
    m.lens = `${Math.round(m.focalLength)} mm${m.aperture ? ` f/${m.aperture}` : ''}`;
  }
  const exif: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t)) {
    if (v instanceof Uint8Array || (Array.isArray(v) && v.length > 32)) continue;
    exif[k] = v instanceof Date ? v.toISOString() : v;
  }
  m.exif = { ...(m.exif ?? {}), ...exif };
  return m;
}

export async function readMetadata(file: Blob, name: string): Promise<PhotoMeta> {
  const head = await readHead(file, 128 * 1024);
  const fmt = detectFormat(head, name, file.type);
  let meta: PhotoMeta = {
    fileName: name,
    fileSize: file.size,
    mimeType: fmt.mimeType,
    format: fmt.format,
    rawFormat: fmt.rawFormat,
    width: 0,
    height: 0,
    orientation: 1,
    bitDepth: 8,
  };
  let tags: Tags = {};
  try {
    tags =
      ((await exifr.parse(file, {
        tiff: true,
        exif: true,
        gps: true,
        ifd1: false,
        interop: false,
        makerNote: false,
        userComment: false,
        xmp: false,
        icc: false,
        translateValues: false,
        reviveValues: true,
        mergeOutput: true,
      })) as Tags | undefined) ?? {};
  } catch {
    tags = {};
  }
  meta = metaFromTags(meta, tags);
  const hi = headerInfo(head);
  let w = num(tags.ExifImageWidth) ?? num(tags.ImageWidth) ?? hi?.width ?? 0;
  let h = num(tags.ExifImageHeight) ?? num(tags.ImageHeight) ?? hi?.height ?? 0;
  if (hi?.orientation && !tags.Orientation) meta.orientation = hi.orientation;
  if (meta.orientation >= 5) [w, h] = [h, w];
  meta.width = w;
  meta.height = h;
  const bps = num(tags.BitsPerSample);
  if (bps) meta.bitDepth = bps;
  if (fmt.format === 'raw') meta.bitDepth = Math.max(meta.bitDepth, 12);
  return meta;
}
