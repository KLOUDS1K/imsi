/**
 * Small formatting helpers shared by the library grid, list, filmstrip,
 * batch dialogs and the export dialog.
 */
import type { PhotoMeta, PhotoRecord } from '@/editor/types';

const intFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** "1/250 s", "0.5 s", "2 s", "30 s". */
export function formatShutter(s: number | undefined): string {
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) return '';
  if (s >= 0.3) {
    const v = s >= 10 ? Math.round(s) : Math.round(s * 10) / 10;
    return `${v} s`;
  }
  return `1/${Math.round(1 / s)} s`;
}

/** "f/1.8", "f/8", "f/11". */
export function formatAperture(f: number | undefined): string {
  if (typeof f !== 'number' || !Number.isFinite(f) || f <= 0) return '';
  const v = f >= 10 ? Math.round(f) : Math.round(f * 10) / 10;
  return `f/${v}`;
}

export function formatFocal(mm: number | undefined): string {
  if (typeof mm !== 'number' || !Number.isFinite(mm) || mm <= 0) return '';
  return `${Math.round(mm)} mm`;
}

export function formatIso(iso: number | undefined): string {
  if (typeof iso !== 'number' || !Number.isFinite(iso) || iso <= 0) return '';
  return `ISO ${Math.round(iso)}`;
}

/** Muted tile sub-line: "ISO 800 · f/1.8 · 1/250 s" (falls back to size/format). */
export function exifLine(meta: PhotoMeta | undefined, fallback = ''): string {
  if (!meta) return fallback;
  const parts = [formatIso(meta.iso), formatAperture(meta.aperture), formatShutter(meta.shutter)].filter(Boolean);
  if (parts.length > 0) return parts.join(' · ');
  if (meta.width > 0 && meta.height > 0) return `${meta.width} × ${meta.height}`;
  return fallback;
}

/** "4.2 MB", "820 KB". */
export function formatBytes(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Date taken (or added) as a short local string. */
export function formatDate(iso: string | number | undefined, withTime = true): string {
  if (iso === undefined || iso === '') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (withTime ? dateFmt : dayFmt).format(d);
}

export function recordDate(r: PhotoRecord): string | number {
  return r.meta?.dateTaken || r.added;
}

/** "1 photo", "1,284 photos". */
export function countLabel(n: number, one = 'photo', many = `${one}s`): string {
  return `${intFmt.format(n)} ${n === 1 ? one : many}`;
}

export function formatCount(n: number): string {
  return intFmt.format(n);
}

/** File name without its extension. */
export function baseName(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function isRawRecord(r: Pick<PhotoRecord, 'meta'>): boolean {
  return r.meta?.format === 'raw';
}

export function cameraOf(meta: PhotoMeta | undefined): string {
  if (!meta) return '';
  return meta.camera || [meta.make, meta.model].filter(Boolean).join(' ');
}
