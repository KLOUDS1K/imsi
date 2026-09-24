/**
 * Photo import pipeline: filter → metadata → dedupe → thumbnail → store.
 *
 * - Runs `concurrency` files at a time (default 3): metadata parsing and
 *   thumbnailing are the slow parts and the io module moves them off the main
 *   thread where it can, so a small pool keeps the CPU busy without flooding
 *   memory with decoded images.
 * - Per-file failures never abort the batch. They are collected in the
 *   returned `ImportReport` (`failed`, `warnings`), streamed through
 *   `onProgress` (the object is an `ImportProgressDetail`, a superset of the
 *   contract's ImportProgress) and passed to `onError`.
 * - Cancellation (`signal`): no new file starts, files in flight are discarded
 *   before they are stored, and the call RESOLVES with what was imported so
 *   far (`report.aborted = true`).
 * - Duplicates: a file with the same name, size and capture date as a photo
 *   already in the library (or earlier in the same batch) is skipped.
 */
import type { ImportProgress } from '@/editor/contracts';
import type { ColorLabel, PhotoMeta, PhotoRecord, PickFlag } from '@/editor/types';
import { defaultImportFolder, folderFromRelativePath, normalizeFolder } from './folders';
import { isColorLabel } from './records';

/** The io functions the importer needs (injectable for tests). */
export interface ImportDeps {
  isSupportedFile(file: { name: string; type?: string }): boolean;
  readMetadata(file: Blob, name: string): Promise<PhotoMeta>;
  makeThumbnail(file: Blob, name: string, maxSize?: number): Promise<Blob>;
}

export interface ImportIssue {
  /** File name as given. */
  name: string;
  /** webkitRelativePath when present. */
  path?: string;
  message: string;
  error?: unknown;
}

export interface ImportProgressDetail extends ImportProgress {
  imported: number;
  duplicates: number;
  failed: number;
  /** Failures so far (same objects as ImportReport.failed). */
  errors: readonly ImportIssue[];
}

export interface ImportOptions {
  /** Target virtual folder for every file (overrides webkitRelativePath). */
  folder?: string;
  /** Called once with done = 0, then after every file (receives an ImportProgressDetail). */
  onProgress?: (p: ImportProgress) => void;
  signal?: AbortSignal;
  /** Called for each file that could not be imported. */
  onError?: (issue: ImportIssue) => void;
}

export interface ImportReport {
  /** Successfully imported records, in input order. */
  imported: PhotoRecord[];
  /** Names of files skipped as exact duplicates. */
  duplicates: string[];
  /** Names of files that are not supported image formats. */
  unsupported: string[];
  /** Files that could not be imported. */
  failed: ImportIssue[];
  /** Imported, but with a problem (e.g. no thumbnail could be generated). */
  warnings: ImportIssue[];
  aborted: boolean;
}

/** What the importer needs from the Library. */
export interface ImportHost {
  deps(): Promise<ImportDeps>;
  /** Dedupe keys of photos already in the library. */
  existingKeys(): Set<string>;
  /** Persist and index one photo (atomic: record + original + thumbnail). */
  commit(record: PhotoRecord, file: Blob, thumb: Blob | null): Promise<void>;
  newId(): string;
  now(): number;
  thumbnailSize: number;
  concurrency: number;
}

/** Dedupe identity: same (NFC) name, byte size and capture date. */
export function dedupeKey(name: string, size: number, dateTaken: string | undefined): string {
  return `${name.normalize('NFC')}\u0000${size}\u0000${dateTaken ?? ''}`;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === 'string' ? err : 'Unknown error';
}

const isQuotaError = (err: unknown) =>
  err instanceof DOMException ? err.name === 'QuotaExceededError' : err instanceof Error && err.name === 'QuotaExceededError';

/** Lightroom-style rating/label/reject flag carried in XMP (xmp:Rating, xmp:Label), when io exposes it. */
function xmpFlags(meta: PhotoMeta): { rating: number; flag: PickFlag; label: ColorLabel | null } {
  const exif = meta.exif ?? {};
  const rawRating = exif['Rating'];
  const rating = typeof rawRating === 'number' && Number.isFinite(rawRating) ? Math.round(rawRating) : 0;
  const rawLabel = exif['Label'];
  const label = typeof rawLabel === 'string' ? rawLabel.trim().toLowerCase() : '';
  return {
    rating: Math.max(0, Math.min(5, rating)),
    // Lightroom writes xmp:Rating = -1 for rejected photos.
    flag: rating < 0 ? 'reject' : 'none',
    label: isColorLabel(label) ? label : null,
  };
}

function relativePath(file: File): string {
  const p = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return typeof p === 'string' ? p : '';
}

/** Run a worker over items with at most `limit` in flight; stops picking new items once aborted. */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (!signal?.aborted) {
      const i = next++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  };
  const lanes = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
}

export async function importFiles(files: readonly File[], opts: ImportOptions, host: ImportHost): Promise<ImportReport> {
  const report: ImportReport = { imported: [], duplicates: [], unsupported: [], failed: [], warnings: [], aborted: false };
  const signal = opts.signal;
  const deps = await host.deps();

  const candidates: File[] = [];
  for (const f of files) {
    if (deps.isSupportedFile({ name: f.name, type: f.type })) candidates.push(f);
    else report.unsupported.push(f.name);
  }

  const startedAt = host.now();
  const fixedFolder = opts.folder !== undefined ? normalizeFolder(opts.folder) : '';
  const fallbackFolder = defaultImportFolder(startedAt);
  const known = host.existingKeys();
  // Results by input index so the returned list keeps the caller's order despite concurrency.
  const results: (PhotoRecord | undefined)[] = new Array(candidates.length);
  let done = 0;
  let importedCount = 0;
  let quotaError: unknown = null;

  const progress = (current?: string) => {
    if (!opts.onProgress) return;
    const p: ImportProgressDetail = {
      done,
      total: candidates.length,
      imported: importedCount,
      duplicates: report.duplicates.length,
      failed: report.failed.length,
      errors: report.failed,
    };
    if (current !== undefined) p.current = current;
    try {
      opts.onProgress(p);
    } catch (err) {
      console.error('[kloud/library] import onProgress callback threw', err);
    }
  };

  const fail = (file: File, message: string, error?: unknown) => {
    const issue: ImportIssue = { name: file.name, message };
    const path = relativePath(file);
    if (path) issue.path = path;
    if (error !== undefined) issue.error = error;
    report.failed.push(issue);
    try {
      opts.onError?.(issue);
    } catch (err) {
      console.error('[kloud/library] import onError callback threw', err);
    }
  };

  progress();

  await runPool(
    candidates,
    host.concurrency,
    async (file, index) => {
      let claimed: string | null = null;
      let abandoned = false;
      try {
        if (quotaError) {
          fail(file, 'Not enough storage space', quotaError);
          return;
        }
        const meta = await deps.readMetadata(file, file.name);
        if (signal?.aborted) {
          abandoned = true;
          return;
        }

        const key = dedupeKey(file.name, file.size, meta.dateTaken);
        if (known.has(key)) {
          report.duplicates.push(file.name);
          return;
        }
        // Claim synchronously (no await since the check) so identical files in flight cannot both pass.
        known.add(key);
        claimed = key;

        let thumb: Blob | null = null;
        try {
          thumb = await deps.makeThumbnail(file, file.name, host.thumbnailSize);
        } catch (err) {
          const issue: ImportIssue = { name: file.name, message: `No thumbnail: ${errorMessage(err)}`, error: err };
          report.warnings.push(issue);
        }
        if (signal?.aborted) {
          abandoned = true;
          return;
        }

        const flags = xmpFlags(meta);
        const name = file.name.normalize('NFC');
        const record: PhotoRecord = {
          id: host.newId(),
          name,
          folder: fixedFolder || folderFromRelativePath(relativePath(file)) || fallbackFolder,
          size: file.size,
          type: file.type || meta.mimeType || '',
          // Offset by input position so "date added" keeps the order the user picked the files in.
          added: startedAt + index,
          modified: Number.isFinite(file.lastModified) && file.lastModified > 0 ? file.lastModified : startedAt,
          meta: { ...meta, fileName: meta.fileName || name, fileSize: meta.fileSize || file.size },
          rating: flags.rating,
          flag: flags.flag,
          label: flags.label,
          favorite: false,
          albumIds: [],
          hasEdits: false,
        };
        await host.commit(record, file, thumb);
        claimed = null;
        results[index] = record;
        importedCount++;
      } catch (err) {
        if (isQuotaError(err)) quotaError = err;
        fail(file, isQuotaError(err) ? 'Not enough storage space' : errorMessage(err), err);
      } finally {
        // A file that was claimed but not stored (failure/abort) must not block a retry.
        if (claimed) known.delete(claimed);
        if (!abandoned) {
          done++;
          if (!signal?.aborted) progress(file.name);
        }
      }
    },
    signal,
  );

  report.imported = results.filter((r): r is PhotoRecord => r !== undefined);
  report.aborted = signal?.aborted === true;
  if (report.aborted) progress();
  return report;
}
