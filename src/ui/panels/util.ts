/**
 * Small helpers shared by the develop panels (formatting, downloads, canvas).
 */
import type { PhotoMeta } from '@/editor/types';

/** "ISO 800 · 35 mm · f/1.8 · 1/250 s" (only the parts that are known). */
export function formatCameraLine(meta: PhotoMeta | null | undefined): string {
  if (!meta) return '';
  const parts: string[] = [];
  if (meta.iso) parts.push(`ISO ${Math.round(meta.iso)}`);
  if (meta.focalLength) parts.push(`${Math.round(meta.focalLength)} mm`);
  if (meta.aperture) parts.push(`f/${trimZero(meta.aperture.toFixed(1))}`);
  if (meta.shutter) parts.push(formatShutter(meta.shutter));
  return parts.join(' · ');
}

export function formatShutter(s: number): string {
  if (!(s > 0)) return '';
  if (s >= 0.3) return `${trimZero(s >= 10 ? s.toFixed(0) : s.toFixed(1))} s`;
  return `1/${Math.round(1 / s)} s`;
}

function trimZero(t: string): string {
  return t.replace(/\.0$/, '');
}

/** "just now", "2 min ago", "3 h ago", "Sep 12". */
export function relativeTime(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 6) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Trigger a browser download for a blob (no dependency on the export module). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Open a native file picker; resolves [] when cancelled. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    let settled = false;
    const done = (files: File[]): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(input.files ? [...input.files] : []));
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Size a canvas backing store to its CSS box × devicePixelRatio. Returns true
 * when the size changed (callers redraw). Reads layout once; call from a
 * ResizeObserver callback, not from pointer handlers.
 */
export function fitCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number): boolean {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

/** Resolve a CSS custom property to a concrete color string for canvas drawing. */
export function tokenColor(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

/** Wraps async actions so errors become toasts instead of unhandled rejections. */
export async function guarded<T>(toast: (m: string, k?: 'info' | 'success' | 'error') => void, what: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[panels] ${what} failed`, e);
    toast(`${what} failed${e instanceof Error && e.message ? `: ${e.message}` : ''}`, 'error');
    return undefined;
  }
}

/** Percent readout for 0..1 sRGB values (pixel readout). */
export function pct(v: number): string {
  return (Math.round(v * 1000) / 10).toFixed(1);
}
