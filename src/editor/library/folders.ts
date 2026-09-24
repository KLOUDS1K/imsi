/**
 * Virtual folder paths ("2026/Seoul Night"): '/'-separated, no leading or
 * trailing slash, NFC-normalized (macOS hands out NFD file paths, which would
 * otherwise produce two different "서울" folders).
 */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Canonical form of a user/OS supplied folder path; '' for none. */
export function normalizeFolder(path: string | null | undefined): string {
  if (!path) return '';
  return path
    .normalize('NFC')
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== '.' && s !== '..')
    .join('/');
}

/** Directory part of `File.webkitRelativePath` ("Trip/Day 1/IMG_1.jpg" → "Trip/Day 1"). */
export function folderFromRelativePath(relativePath: string | null | undefined): string {
  const norm = normalizeFolder(relativePath);
  const cut = norm.lastIndexOf('/');
  return cut > 0 ? norm.slice(0, cut) : '';
}

/** "Imported/YYYY-MM-DD" in local time. */
export function defaultImportFolder(time: number): string {
  const d = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Imported/${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** True when `folder` is `parent` or lies below it. */
export function isInFolder(folder: string, parent: string, includeSubfolders = true): boolean {
  if (folder === parent) return true;
  return includeSubfolders && parent !== '' && folder.startsWith(`${parent}/`);
}

/** Last path segment ("2026/Seoul Night" → "Seoul Night"). */
export function folderName(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/** Parent path ('' for a top-level folder). */
export function parentFolder(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut >= 0 ? path.slice(0, cut) : '';
}

/**
 * Segment-wise natural order: a parent sorts immediately before its children
 * ("2026" < "2026/Day 2" < "2026/Day 10" < "2027").
 */
export function compareFolders(a: string, b: string): number {
  const as = a.split('/');
  const bs = b.split('/');
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const c = collator.compare(as[i], bs[i]) || (as[i] < bs[i] ? -1 : as[i] > bs[i] ? 1 : 0);
    if (c !== 0) return c;
  }
  return as.length - bs.length;
}

/** Sorted unique folder paths including every ancestor of each path. */
export function expandFolders(paths: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    let cut = p.length;
    // Walk up the ancestors; stop early once an ancestor is already known (its parents are too).
    while (cut > 0) {
      const sub = p.slice(0, cut);
      if (out.has(sub)) break;
      out.add(sub);
      cut = sub.lastIndexOf('/');
    }
  }
  return [...out].sort(compareFolders);
}

/** Rewrite `path` when it is `from` or below it ("A/B/C", from "A/B", to "X" → "X/C"); null when unaffected. */
export function renameFolderPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  if (from !== '' && path.startsWith(`${from}/`)) return normalizeFolder(`${to}/${path.slice(from.length + 1)}`);
  return null;
}
