/** Shared fixtures for the library unit tests (not a test file itself). */
import { createEmptyMeta } from '@/editor/defaults';
import type { ColorLabel, PhotoMeta, PhotoRecord, PickFlag } from '@/editor/types';
import type { LibraryDeps } from '@/editor/library';

export const DAY = 24 * 60 * 60 * 1000;
/** Fixed "now" for query tests: 2026-09-24T12:00:00Z. */
export const NOW = Date.UTC(2026, 8, 24, 12);

export function meta(fileName: string, extra: Partial<PhotoMeta> = {}): PhotoMeta {
  return { ...createEmptyMeta(fileName), mimeType: 'image/jpeg', format: 'jpeg', width: 6000, height: 4000, ...extra };
}

/** File with an optional webkitRelativePath (Node's File has none). */
export function makeFile(name: string, content = name, relativePath?: string, type = 'image/jpeg'): File {
  const f = new File([content], name, { type, lastModified: 1_700_000_000_000 });
  if (relativePath !== undefined) Object.defineProperty(f, 'webkitRelativePath', { value: relativePath });
  return f;
}

export interface StubDeps extends LibraryDeps {
  metaCalls: string[];
  thumbCalls: { name: string; maxSize?: number }[];
}

/**
 * io stubs: supported = jpg/jpeg/png/arw/dng; metadata from `metas` by name
 * (default: plain JPEG meta); names in `failMeta` throw, names in `failThumb`
 * have no thumbnail.
 */
export function stubDeps(opts: {
  metas?: Record<string, Partial<PhotoMeta>>;
  failMeta?: string[];
  failThumb?: string[];
  delayMs?: number;
  ids?: boolean;
  now?: () => number;
} = {}): StubDeps {
  const metaCalls: string[] = [];
  const thumbCalls: { name: string; maxSize?: number }[] = [];
  let seq = 0;
  const wait = () => (opts.delayMs ? new Promise((r) => setTimeout(r, opts.delayMs)) : Promise.resolve());
  const deps: StubDeps = {
    metaCalls,
    thumbCalls,
    isSupportedFile: (f) => /\.(jpe?g|png|arw|dng)$/i.test(f.name),
    readMetadata: async (file, name) => {
      metaCalls.push(name);
      await wait();
      if (opts.failMeta?.includes(name)) throw new Error(`corrupt ${name}`);
      const raw = /\.(arw|dng)$/i.test(name);
      return meta(name, { fileSize: file.size, ...(raw ? { format: 'raw', mimeType: 'image/x-raw' } : {}), ...(opts.metas?.[name] ?? {}) });
    },
    makeThumbnail: async (_file, name, maxSize) => {
      thumbCalls.push({ name, maxSize });
      await wait();
      if (opts.failThumb?.includes(name)) throw new Error('no preview');
      return new Blob([`thumb:${name}`], { type: 'image/jpeg' });
    },
  };
  if (opts.ids) deps.newId = (kind) => `${kind}${++seq}`;
  if (opts.now) deps.now = opts.now;
  return deps;
}

let recSeq = 0;

export function record(partial: Partial<PhotoRecord> & { name: string }, m: Partial<PhotoMeta> = {}): PhotoRecord {
  recSeq++;
  return {
    id: partial.id ?? `r${String(recSeq).padStart(3, '0')}`,
    name: partial.name,
    folder: partial.folder ?? '',
    size: partial.size ?? 1000,
    type: 'image/jpeg',
    added: partial.added ?? NOW - 100 * DAY + recSeq,
    modified: partial.modified ?? NOW - 200 * DAY,
    meta: meta(partial.name, m),
    rating: partial.rating ?? 0,
    flag: (partial.flag ?? 'none') as PickFlag,
    label: (partial.label ?? null) as ColorLabel | null,
    favorite: partial.favorite ?? false,
    albumIds: partial.albumIds ?? [],
    hasEdits: partial.hasEdits ?? false,
    ...(partial.editedAt !== undefined ? { editedAt: partial.editedAt } : {}),
  };
}

/**
 * ~30 records with varied metadata. Albums: 'alb-seoul' ("Seoul Nights"),
 * 'alb-best' ("Best of Café").
 */
export function fixture(): PhotoRecord[] {
  const cams = ['Sony α7 IV', 'Fujifilm X-T5', 'Canon EOS R5'];
  const lenses = ['FE 35mm F1.4 GM', 'XF 23mm F1.4 R', 'RF 50mm F1.2L'];
  const folders = ['2026/Seoul Night', '2026/Busan', 'Travel/Japan/Kyoto'];
  const recs: PhotoRecord[] = [];
  for (let i = 0; i < 30; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = i < 15 ? '03' : '04';
    recs.push(
      record(
        {
          id: `p${String(i).padStart(2, '0')}`,
          name: `IMG_${String(1000 + i)}.jpg`,
          folder: folders[i % 3],
          size: 1_000_000 + ((i * 7919) % 30) * 1000,
          added: NOW - 30 * DAY + i * 1000,
          rating: i % 6,
          flag: i % 5 === 0 ? 'pick' : i % 7 === 0 ? 'reject' : 'none',
          label: i % 4 === 0 ? 'red' : i % 4 === 1 ? 'blue' : null,
          favorite: i % 3 === 0,
          albumIds: i < 5 ? ['alb-seoul'] : i >= 25 ? ['alb-best'] : [],
          hasEdits: i % 2 === 0,
          ...(i % 2 === 0 ? { editedAt: NOW - (i % 10) * DAY } : {}),
        },
        {
          camera: cams[i % 3],
          make: cams[i % 3].split(' ')[0],
          lens: lenses[i % 3],
          iso: [100, 200, 400, 800, 1600, 3200][i % 6],
          aperture: [1.4, 2, 2.8, 4, 5.6][i % 5],
          shutter: [1 / 1000, 1 / 250, 1 / 60, 1 / 15, 0.5][i % 5],
          focalLength: [23, 35, 50][i % 3],
          dateTaken: `2026-${month}-${day}T${String(10 + (i % 10)).padStart(2, '0')}:00:00`,
        },
      ),
    );
  }
  // Special cases for text search.
  recs[7] = { ...recs[7], name: 'Café_Terrace.jpg' };
  recs[8] = { ...recs[8], meta: { ...recs[8].meta, dateTaken: undefined } };
  return recs;
}
