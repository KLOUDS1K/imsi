/**
 * Batch packaging and download.
 */
import { zip, zipSync, type AsyncZippable, type Zippable } from 'fflate';
import type { ExportResult } from '@/editor/contracts';
import { bytesToBlob } from './encode';

/** Formats that are already entropy-coded: store them (level 0) instead of re-deflating. */
const STORED = /\.(jpe?g|png|webp|tiff?)$/i;

/** "a.jpg", "a.jpg" → "a.jpg", "a (2).jpg". */
export function uniqueNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    let name = n;
    const dot = n.lastIndexOf('.');
    const stem = dot > 0 ? n.slice(0, dot) : n;
    const ext = dot > 0 ? n.slice(dot) : '';
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${stem} (${i})${ext}`;
    used.add(name.toLowerCase());
    return name;
  });
}

export async function zipResults(results: ExportResult[]): Promise<Blob> {
  const names = uniqueNames(results.map((r) => r.fileName));
  const files: AsyncZippable = {};
  const mtime = new Date();
  await Promise.all(
    results.map(async (r, i) => {
      const data = new Uint8Array(await r.blob.arrayBuffer());
      // Our TIFFs are deflate-compressed already; DNGs are stored uncompressed → deflate those.
      files[names[i]] = [data, { level: STORED.test(names[i]) ? 0 : 6, mtime }];
    }),
  );
  const bytes = await new Promise<Uint8Array>((resolve) => {
    try {
      zip(files, { level: 0 }, (err, out) => {
        // fflate's async zip uses blob-URL workers; if those are blocked, zip inline.
        resolve(err ? zipSync(files as Zippable, { level: 0 }) : out);
      });
    } catch {
      resolve(zipSync(files as Zippable, { level: 0 }));
    }
  });
  return bytesToBlob(bytes, 'application/zip');
}

/** Save a blob via a temporary <a download>; the object URL is revoked once the download has started. */
export function downloadBlob(blob: Blob, fileName: string): void {
  if (typeof document === 'undefined') throw new Error('downloadBlob needs a document');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in some browsers (Safari, Firefox).
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
