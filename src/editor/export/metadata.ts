/**
 * Export metadata per policy (ExportSettings.metadata):
 *
 *  - 'none'               no EXIF / XMP at all (structural TIFF tags only)
 *  - 'copyright'          Artist + Copyright (+ Software, Orientation = 1)
 *  - 'copyright-contact'  the above + an XMP rights block (dc:creator, dc:rights,
 *                          xmpRights:Marked, photoshop:Credit)
 *  - 'all'                camera, lens, exposure, dates, GPS (unless removeLocation),
 *                          pixel dimensions + everything above
 *
 * Orientation is always 1: exported pixels are already upright.
 */
import type { ExportColorSpace, ExportSettings, PhotoMeta } from '@/editor/types';
import {
  ascii,
  buildTiffStructure,
  bytes,
  long,
  rational,
  rationalRaw,
  short,
  srational,
  type IfdNode,
  type TiffTag,
} from './tiff-ifd';

export const SOFTWARE = 'KLOUD Studio';

export interface MetadataBlocks {
  /** Tags every TIFF-like IFD0 carries: Orientation, X/YResolution, ResolutionUnit. */
  structural: TiffTag[];
  /** Policy-dependent IFD0 tags (Make, Model, Software, DateTime, Artist, Copyright). */
  ifd0: TiffTag[];
  exif: TiffTag[] | null;
  gps: TiffTag[] | null;
  /** Serialized XMP packet (UTF-8 XML) or null. */
  xmp: string | null;
  /** False for policy 'none' (no EXIF/XMP block should be written). */
  hasMetadata: boolean;
}

interface ExifDate {
  exif: string;
  offset: string | null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "YYYY:MM:DD HH:MM:SS" in local time. */
export function exifDateTime(d: Date): string {
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * ISO-8601 or EXIF-style date → EXIF DateTime string. The wall-clock digits
 * are copied verbatim (no timezone conversion: EXIF dates are local time);
 * an explicit offset goes to OffsetTimeOriginal.
 */
export function parseDateTaken(s: string | undefined): ExifDate | null {
  if (!s) return null;
  const m = /^(\d{4})[-:](\d{2})[-:](\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?/.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h = '00', mi = '00', se = '00', tz] = m;
  let offset: string | null = null;
  if (tz === 'Z') offset = '+00:00';
  else if (tz) offset = tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz;
  return { exif: `${y}:${mo}:${d} ${h}:${mi}:${se}`, offset };
}

function dms(v: number): number[] {
  const a = Math.abs(v);
  const d = Math.floor(a);
  const mFloat = (a - d) * 60;
  const m = Math.floor(mFloat);
  const s = Math.round((mFloat - m) * 60 * 10000);
  return [d, 1, m, 1, s, 10000];
}

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function buildXmp(artist: string, copyright: string, extra: { credit?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`   <xmp:CreatorTool>${SOFTWARE}</xmp:CreatorTool>`);
  if (artist) {
    lines.push(`   <dc:creator><rdf:Seq><rdf:li>${xmlEscape(artist)}</rdf:li></rdf:Seq></dc:creator>`);
    if (extra.credit) lines.push(`   <photoshop:Credit>${xmlEscape(artist)}</photoshop:Credit>`);
  }
  if (copyright) {
    lines.push(`   <dc:rights><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(copyright)}</rdf:li></rdf:Alt></dc:rights>`);
    lines.push('   <xmpRights:Marked>True</xmpRights:Marked>');
  }
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="${SOFTWARE}">`,
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '  <rdf:Description rdf:about=""',
    '    xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    '    xmlns:dc="http://purl.org/dc/elements/1.1/"',
    '    xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/"',
    '    xmlns:xmpRights="http://ns.adobe.com/xap/1.0/rights/">',
    ...lines,
    '  </rdf:Description>',
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

export function buildMetadata(
  settings: Pick<ExportSettings, 'metadata' | 'removeLocation' | 'copyright' | 'artist' | 'dpi'>,
  meta: PhotoMeta,
  img: { width: number; height: number; colorSpace: ExportColorSpace },
  now: Date = new Date(),
): MetadataBlocks {
  const dpi = settings.dpi > 0 && Number.isFinite(settings.dpi) ? settings.dpi : 72;
  const structural: TiffTag[] = [short(274, 1), rational(282, dpi), rational(283, dpi), short(296, 2)];
  const policy = settings.metadata;
  if (policy === 'none') return { structural, ifd0: [], exif: null, gps: null, xmp: null, hasMetadata: false };

  const artist = (settings.artist || meta.artist || '').trim();
  const copyright = (settings.copyright || meta.copyright || '').trim();
  const ifd0: TiffTag[] = [ascii(305, SOFTWARE), ascii(306, exifDateTime(now))];
  if (artist) ifd0.push(ascii(315, artist));
  if (copyright) ifd0.push(ascii(33432, copyright));
  if (policy === 'copyright') return { structural, ifd0, exif: null, gps: null, xmp: null, hasMetadata: true };

  const xmp = buildXmp(artist, copyright, { credit: true });
  if (policy === 'copyright-contact') return { structural, ifd0, exif: null, gps: null, xmp, hasMetadata: true };

  // ---- 'all' ----
  if (meta.make) ifd0.push(ascii(271, meta.make));
  if (meta.model) ifd0.push(ascii(272, meta.model));

  const exif: TiffTag[] = [bytes(36864, [0x30, 0x32, 0x33, 0x32], 7), bytes(40960, [0x30, 0x31, 0x30, 0x30], 7)];
  if (meta.shutter && meta.shutter > 0) exif.push(rational(33434, meta.shutter));
  if (meta.aperture && meta.aperture > 0) exif.push(rational(33437, meta.aperture));
  if (meta.iso && meta.iso > 0) exif.push(short(34855, Math.min(65535, Math.round(meta.iso))));
  const taken = parseDateTaken(meta.dateTaken);
  if (taken) {
    exif.push(ascii(36867, taken.exif), ascii(36868, taken.exif));
    if (taken.offset) exif.push(ascii(36881, taken.offset));
  }
  if (meta.exposureCompensation !== undefined && Number.isFinite(meta.exposureCompensation))
    exif.push(srational(37380, meta.exposureCompensation));
  if (meta.flash !== undefined) exif.push(short(37385, meta.flash ? 1 : 0));
  if (meta.focalLength && meta.focalLength > 0) exif.push(rational(37386, meta.focalLength));
  exif.push(short(40961, img.colorSpace === 'srgb' ? 1 : 0xffff));
  exif.push(long(40962, img.width), long(40963, img.height));
  if (meta.focalLength35 && meta.focalLength35 > 0) exif.push(short(41989, Math.min(65535, Math.round(meta.focalLength35))));
  if (meta.lensMake) exif.push(ascii(42035, meta.lensMake));
  if (meta.lens) exif.push(ascii(42036, meta.lens));

  let gps: TiffTag[] | null = null;
  const g = meta.gps;
  if (!settings.removeLocation && g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) {
    gps = [
      bytes(0, [2, 3, 0, 0]),
      ascii(1, g.lat >= 0 ? 'N' : 'S'),
      rationalRaw(2, dms(g.lat)),
      ascii(3, g.lon >= 0 ? 'E' : 'W'),
      rationalRaw(4, dms(g.lon)),
    ];
    if (g.alt !== undefined && Number.isFinite(g.alt)) gps.push(bytes(5, [g.alt < 0 ? 1 : 0]), rational(6, Math.abs(g.alt)));
  }
  return { structural, ifd0, exif, gps, xmp, hasMetadata: true };
}

/** IFD0 node (structural + policy tags) with ExifIFD / GPS children. */
export function metadataIfd(b: MetadataBlocks, extraTags: TiffTag[] = []): IfdNode {
  const children: NonNullable<IfdNode['children']> = [];
  if (b.exif?.length) children.push({ tag: 34665, nodes: [{ tags: b.exif }] });
  if (b.gps?.length) children.push({ tag: 34853, nodes: [{ tags: b.gps }] });
  return { tags: [...b.structural, ...b.ifd0, ...extraTags], children };
}

/** Big-endian TIFF structure for EXIF blocks, or null when the policy writes no metadata. */
export function buildExifTiff(b: MetadataBlocks): Uint8Array | null {
  if (!b.hasMetadata) return null;
  return buildTiffStructure([metadataIfd(b)], false);
}
