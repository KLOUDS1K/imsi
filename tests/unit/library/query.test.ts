import { describe, expect, it } from 'vitest';
import { Library, cameraName, effectiveDateMs } from '@/editor/library';
import { MemoryKloudDB } from '@/editor/storage';
import type { LibraryQuery, LibrarySort, PhotoRecord } from '@/editor/types';
import { DAY, NOW, fixture } from './fixtures';

const records = fixture();
const albums = [
  { id: 'alb-seoul', name: 'Seoul Nights', created: 1 },
  { id: 'alb-best', name: 'Best of Café', created: 2 },
];
const lib = new Library(new MemoryKloudDB(), { records, albums }, { now: () => NOW });

const ids = (rs: PhotoRecord[]) => rs.map((r) => r.id).sort();
const expectFilter = (q: LibraryQuery, pred: (r: PhotoRecord, i: number) => boolean) => {
  const expected = ids(records.filter((r, i) => pred(r, i)));
  expect(expected.length).toBeGreaterThan(0);
  expect(ids(lib.query(q))).toEqual(expected);
};
const idx = (r: PhotoRecord) => Number(r.id.slice(1));

describe('query: text search', () => {
  it('matches accent-insensitively in names and album names', () => {
    expect(ids(lib.query({ text: 'CAFE' }))).toEqual(['p07', 'p25', 'p26', 'p27', 'p28', 'p29']);
    expect(ids(lib.query({ text: 'café terrace' }))).toEqual(['p07']);
  });

  it('searches folders, cameras, lenses and capture dates; all terms must match', () => {
    expectFilter({ text: 'seoul' }, (r, i) => r.folder.includes('Seoul') || i < 5);
    expectFilter({ text: 'sony 35mm' }, (_r, i) => i % 3 === 0);
    expect(lib.query({ text: 'sony xf' })).toEqual([]);
    expectFilter({ text: 'kyoto' }, (_r, i) => i % 3 === 2);
    expectFilter({ text: '2026-04' }, (_r, i) => i >= 15);
    expectFilter({ text: '"x-t5" 2026-03' }, (r, i) => i % 3 === 1 && i < 15 && i !== 8);
    expect(lib.query({ text: '   ' })).toHaveLength(30);
  });
});

describe('query: filters', () => {
  it('rating, flag, labels, favorite', () => {
    expectFilter({ minRating: 4 }, (r) => r.rating >= 4);
    expectFilter({ flag: 'pick' }, (r) => r.flag === 'pick');
    expectFilter({ flag: 'reject' }, (r) => r.flag === 'reject');
    expect(lib.query({ flag: 'any' })).toHaveLength(30);
    expectFilter({ labels: ['red', 'blue'] }, (r) => r.label === 'red' || r.label === 'blue');
    expectFilter({ favorite: true }, (r) => r.favorite);
    expectFilter({ favorite: false }, (r) => !r.favorite);
  });

  it('camera and lens (case-insensitive), album, folder with subfolders', () => {
    expectFilter({ camera: 'sony α7 iv' }, (r) => r.meta.camera === 'Sony α7 IV');
    expectFilter({ lens: 'xf 23mm f1.4 r' }, (r) => r.meta.lens === 'XF 23mm F1.4 R');
    expectFilter({ albumId: 'alb-best' }, (_r, i) => i >= 25);
    expectFilter({ folder: '2026' }, (r) => r.folder.startsWith('2026/'));
    expectFilter({ folder: 'Travel/Japan' }, (r) => r.folder === 'Travel/Japan/Kyoto');
    expect(lib.query({ folder: '2026/Seo' })).toEqual([]);
  });

  it('numeric ranges are inclusive and exclude photos without the value', () => {
    expectFilter({ isoRange: [200, 800] }, (r) => r.meta.iso! >= 200 && r.meta.iso! <= 800);
    expectFilter({ apertureRange: [2, 2.8] }, (r) => r.meta.aperture === 2 || r.meta.aperture === 2.8);
    expectFilter({ shutterRange: [1 / 250, 1 / 60] }, (r) => r.meta.shutter === 1 / 250 || r.meta.shutter === 1 / 60);
    expectFilter({ focalRange: [35, 50] }, (r) => r.meta.focalLength! >= 35);
    // Reversed bounds are accepted.
    expect(ids(lib.query({ isoRange: [800, 200] }))).toEqual(ids(lib.query({ isoRange: [200, 800] })));
  });

  it('date ranges are inclusive at the precision of each bound', () => {
    expectFilter({ dateRange: ['2026-03-10', '2026-03-12'] }, (r) => {
      const d = r.meta.dateTaken?.slice(0, 10);
      return !!d && d >= '2026-03-10' && d <= '2026-03-12';
    });
    expectFilter({ dateRange: ['2026-04', '2026-04'] }, (r) => r.meta.dateTaken?.startsWith('2026-04') === true);
  });

  it('edited / unedited / recent (edited within 7 days)', () => {
    expectFilter({ edited: 'edited' }, (r) => r.hasEdits);
    expectFilter({ edited: 'unedited' }, (r) => !r.hasEdits);
    expectFilter({ edited: 'recent' }, (r) => r.hasEdits && r.editedAt! >= NOW - 7 * DAY);
    expect(lib.query({ edited: 'recent' }).length).toBeLessThan(lib.query({ edited: 'edited' }).length);
  });

  it('combines filters with AND', () => {
    expectFilter({ favorite: true, minRating: 3, folder: '2026' }, (r) => r.favorite && r.rating >= 3 && r.folder.startsWith('2026/'));
  });
});

describe('query: sorting', () => {
  const keyOf: Record<LibrarySort, (r: PhotoRecord) => number | string | undefined> = {
    'date-taken': (r) => effectiveDateMs(r),
    'date-added': (r) => r.added,
    edited: (r) => (r.hasEdits ? r.editedAt : undefined),
    name: (r) => r.name.toLowerCase(),
    rating: (r) => r.rating,
    size: (r) => r.size,
    camera: (r) => cameraName(r.meta),
    iso: (r) => r.meta.iso,
    'focal-length': (r) => r.meta.focalLength,
  };

  for (const sort of Object.keys(keyOf) as LibrarySort[]) {
    it(`sorts by ${sort} in both directions with stable tie-breaks`, () => {
      const asc = lib.query({ sort, order: 'asc' });
      const desc = lib.query({ sort, order: 'desc' });
      expect(asc).toHaveLength(30);
      const key = keyOf[sort];
      const present = (rs: PhotoRecord[]) => rs.filter((r) => key(r) !== undefined);
      const cmp = (a: number | string | undefined, b: number | string | undefined) =>
        typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, undefined, { numeric: true }) : (a as number) - (b as number);
      const pa = present(asc);
      for (let i = 1; i < pa.length; i++) expect(cmp(key(pa[i - 1]), key(pa[i]))).toBeLessThanOrEqual(0);
      // Items without a value go last in both directions; the rest reverse exactly.
      expect(asc.slice(pa.length).every((r) => key(r) === undefined)).toBe(true);
      expect(present(desc).map((r) => r.id)).toEqual(pa.map((r) => r.id).reverse());
      // Deterministic: the same query twice gives the same order.
      expect(lib.query({ sort, order: 'asc' }).map((r) => r.id)).toEqual(asc.map((r) => r.id));
    });
  }

  it('defaults to newest capture date first', () => {
    const rs = lib.query({});
    for (let i = 1; i < rs.length; i++) expect(effectiveDateMs(rs[i - 1])).toBeGreaterThanOrEqual(effectiveDateMs(rs[i]));
  });

  it('sorts names naturally', () => {
    const l = new Library(new MemoryKloudDB(), {
      records: ['IMG_10.jpg', 'img_2.jpg', 'IMG_1.jpg'].map((name, i) => ({ ...records[i], id: `n${i}`, name })),
    });
    expect(l.query({ sort: 'name', order: 'asc' }).map((r) => r.name)).toEqual(['IMG_1.jpg', 'img_2.jpg', 'IMG_10.jpg']);
  });
});

describe('facets and folders', () => {
  it('lists distinct values sorted, with parent folders and the date range', () => {
    const f = lib.facets();
    expect(f.cameras).toEqual(['Canon EOS R5', 'Fujifilm X-T5', 'Sony α7 IV']);
    expect(f.lenses).toEqual(['FE 35mm F1.4 GM', 'RF 50mm F1.2L', 'XF 23mm F1.4 R']);
    expect(f.isos).toEqual([100, 200, 400, 800, 1600, 3200]);
    expect(f.apertures).toEqual([1.4, 2, 2.8, 4, 5.6]);
    expect(f.shutters).toEqual([1 / 1000, 1 / 250, 1 / 60, 1 / 15, 0.5]);
    expect(f.focalLengths).toEqual([23, 35, 50]);
    expect(f.folders).toEqual(['2026', '2026/Busan', '2026/Seoul Night', 'Travel', 'Travel/Japan', 'Travel/Japan/Kyoto']);
    expect(lib.folders()).toEqual(f.folders);
    const dates = records.map((r) => r.meta.dateTaken).filter((d): d is string => !!d).sort();
    expect(f.dateMin).toBe(dates[0]);
    expect(f.dateMax).toBe(dates.at(-1));
  });

  it('builds camera names from make/model when meta.camera is missing', () => {
    expect(cameraName({ ...records[0].meta, camera: undefined, make: 'NIKON', model: 'NIKON Z 8' })).toBe('NIKON Z 8');
    expect(cameraName({ ...records[0].meta, camera: undefined, make: 'Leica', model: 'Q3' })).toBe('Leica Q3');
    expect(idx(records[3])).toBe(3);
  });
});
