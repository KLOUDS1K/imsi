/**
 * Import plumbing: file / folder pickers, drag-and-drop traversal (files and
 * whole folders via webkitGetAsEntry) and the import run with progress in
 * ctx.busy and a summary toast.
 *
 * Folder structure: files picked with the folder input carry
 * `webkitRelativePath`, which the library turns into virtual folders itself.
 * Dropped folders don't, so dropped files are grouped by their directory path
 * and each group is imported with an explicit `folder`.
 */
import type { ImportProgress } from '@/editor/contracts';
import type { AppContext } from './context';
import type { BusyTracker } from './busy';

export interface FileGroup {
  /** Virtual folder ('' = let the library decide). */
  folder: string;
  files: File[];
}

/* ---------------- pickers ---------------- */

/**
 * Open the native picker. Resolves with the chosen files ([] when cancelled —
 * browsers that support the `cancel` event resolve immediately, others on the
 * next focus return).
 */
export function pickFiles(kind: 'files' | 'folder', accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (kind === 'folder') {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    } else if (accept) input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const done = (files: File[]): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}

/* ---------------- drag & drop ---------------- */

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FsFileEntry extends FsEntry {
  file(ok: (f: File) => void, fail: (e: unknown) => void): void;
}
interface FsDirEntry extends FsEntry {
  createReader(): { readEntries(ok: (entries: FsEntry[]) => void, fail: (e: unknown) => void): void };
}

const MAX_DROP_FILES = 5000;

async function readDir(dir: FsDirEntry): Promise<FsEntry[]> {
  const reader = dir.createReader();
  const out: FsEntry[] = [];
  // readEntries returns batches (≤ 100 in Chromium) until an empty batch.
  for (;;) {
    const batch = await new Promise<FsEntry[]>((ok, fail) => reader.readEntries(ok, fail));
    if (!batch.length) break;
    out.push(...batch);
    if (out.length > MAX_DROP_FILES) throw new Error(`A dropped folder contains more than ${MAX_DROP_FILES} files.`);
  }
  return out;
}

async function walk(entry: FsEntry, parent: string, groups: Map<string, File[]>, count: { n: number }): Promise<void> {
  if (count.n >= MAX_DROP_FILES) throw new Error(`A drop may contain at most ${MAX_DROP_FILES} files.`);
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => (entry as FsFileEntry).file(ok, fail));
    count.n++;
    const list = groups.get(parent) ?? [];
    list.push(file);
    groups.set(parent, list);
  } else if (entry.isDirectory) {
    if (entry.name.startsWith('.')) return; // .git, .DS_Store folders, etc.
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    for (const child of await readDir(entry as FsDirEntry)) await walk(child, path, groups, count);
  }
}

/** Collect dropped files, descending into dropped folders. */
export async function collectDropped(dt: DataTransfer): Promise<FileGroup[]> {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === 'file');
  if (!items.length) return [{ folder: '', files: Array.from(dt.files ?? []) }];
  // DataTransferItem file handles expire as soon as the drop handler returns.
  // Claim *every* entry/file before the first await, then traverse the handles.
  const claimed = items.map((item) => {
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() as FsEntry | null : null;
    return { entry, file: entry ? null : item.getAsFile() };
  });
  if (claimed.some(({ entry, file }) => !entry && !file)) {
    throw new Error('A dropped file could not be read. Try the file picker instead.');
  }
  const groups = new Map<string, File[]>();
  const count = { n: 0 };
  for (const { entry, file } of claimed) {
    if (entry) await walk(entry, '', groups, count);
    else {
      if (!file) continue; // checked before traversal
      if (count.n >= MAX_DROP_FILES) throw new Error(`A drop may contain at most ${MAX_DROP_FILES} files.`);
      count.n++;
      const loose = groups.get('') ?? [];
      loose.push(file);
      groups.set('', loose);
    }
  }
  return [...groups.entries()].map(([folder, files]) => ({ folder, files }));
}

/** Whether a drag carries files (not text or in-page elements). */
export function isFileDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  return !!types && Array.from(types).includes('Files');
}

/* ---------------- import run ---------------- */

export interface ImportRunOptions {
  isSupported?: (f: File) => boolean;
  /** Open the first imported photo afterwards? (default: select them) */
  onImported?: (ids: string[]) => void;
}

function sampleNames(names: string[]): string {
  const shown = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${shown} +${names.length - 3} more` : shown;
}

/**
 * Import groups sequentially with one progress line. Never throws: errors are
 * reported in a toast. Returns the ids of the imported photos.
 */
export async function runImport(ctx: AppContext, busy: BusyTracker, groups: FileGroup[], opts: ImportRunOptions = {}): Promise<string[]> {
  const all = groups.flatMap((g) => g.files);
  if (!all.length) return [];
  const supportedCount = opts.isSupported ? all.filter(opts.isSupported).length : all.length;
  if (supportedCount === 0) {
    ctx.toast('None of those files are supported images (JPEG, PNG, WebP, TIFF, HEIC or RAW).', 'error');
    return [];
  }
  const total = all.length;
  let before = 0;
  const task = busy.begin(`Importing ${total} ${total === 1 ? 'file' : 'files'}…`, 0);
  const ids: string[] = [];
  const failed: { name: string; message: string }[] = [];
  const warnings: string[] = [];
  let duplicates = 0;
  let unsupported = 0;
  let fatalError = false;
  try {
    for (const g of groups) {
      if (!g.files.length) continue;
      const onProgress = (p: ImportProgress): void => {
        const done = before + p.done;
        task.update(done / total, `Importing ${done}/${total}${p.current ? ` · ${p.current}` : ''}`);
      };
      const report = await ctx.library.importFilesDetailed(g.files, g.folder ? { folder: g.folder, onProgress } : { onProgress });
      ids.push(...report.imported.map((r) => r.id));
      failed.push(...report.failed);
      warnings.push(...report.warnings.map((issue) => issue.name));
      duplicates += report.duplicates.length;
      unsupported += report.unsupported.length;
      before += g.files.length;
    }
  } catch (err) {
    fatalError = true;
    ctx.toast(`Import failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 6000);
  } finally {
    task.end();
  }
  if (ids.length) {
    const skipped = [duplicates && `${duplicates} duplicate${duplicates === 1 ? '' : 's'}`, unsupported && `${unsupported} unsupported`].filter(Boolean);
    ctx.toast(
      `Imported ${ids.length} ${ids.length === 1 ? 'photo' : 'photos'}${skipped.length ? ` · ${skipped.join(' · ')}` : ''}`,
      'success',
    );
    ctx.selection.set(ids);
    opts.onImported?.(ids);
  } else if (!failed.length && !fatalError) {
    ctx.toast(`Nothing new to import · ${duplicates} duplicate${duplicates === 1 ? '' : 's'} · ${unsupported} unsupported`, 'info');
  }
  if (failed.length) {
    ctx.toast(`${failed.length} import ${failed.length === 1 ? 'failed' : 'failures'}: ${sampleNames(failed.map((issue) => `${issue.name} (${issue.message})`))}`, 'error', 8000);
  }
  if (warnings.length) {
    ctx.toast(`${warnings.length} imported without a thumbnail: ${sampleNames(warnings)}`, 'error', 8000);
  }
  return ids;
}
