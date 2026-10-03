import { describe, expect, it, vi } from 'vitest';
import { createBusyTracker, type BusyState } from '@/app/busy';
import type { AppContext } from '@/app/context';
import { collectDropped, runImport } from '@/app/importer';
import { openLibrary } from '@/editor/library';
import { MemoryKloudDB } from '@/editor/storage';
import { Signal } from '@/ui/signal';
import { makeFile, stubDeps } from './library/fixtures';

describe('editor import feedback', () => {
  it('rejects an unreadable item instead of silently importing part of a drop', async () => {
    const good = makeFile('good.jpg');
    const dropped = {
      items: [
        { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => good },
        { kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => null },
      ],
      files: [good],
    } as unknown as DataTransfer;
    await expect(collectDropped(dropped)).rejects.toThrow('A dropped file could not be read');
  });

  it('does not mistake a folder read error for the end of its entries', async () => {
    const dropped = {
      items: [{
        kind: 'file',
        webkitGetAsEntry: () => ({
          isFile: false,
          isDirectory: true,
          name: 'Photos',
          createReader: () => ({ readEntries: (_ok: unknown, fail: (error: Error) => void) => fail(new Error('disk error')) }),
        }),
      }],
      files: [],
    } as unknown as DataTransfer;
    await expect(collectDropped(dropped)).rejects.toThrow('disk error');
  });

  it('names a failed photo instead of classifying it as a duplicate', async () => {
    const library = await openLibrary(new MemoryKloudDB(), stubDeps({ failMeta: ['broken.arw'] }));
    const toast = vi.fn();
    const selection = new Signal<string[]>([]);
    const ctx = { library, toast, selection } as unknown as AppContext;
    const busy = createBusyTracker(new Signal<BusyState>({ active: false }));

    const ids = await runImport(ctx, busy, [{ folder: '', files: [
      makeFile('good.jpg'), makeFile('broken.arw'), makeFile('notes.txt'),
    ] }], { isSupported: (f) => /\.(jpe?g|arw)$/i.test(f.name) });

    expect(ids).toHaveLength(1);
    expect(selection.value).toEqual(ids);
    expect(toast).toHaveBeenCalledWith('Imported 1 photo · 1 unsupported', 'success');
    expect(toast).toHaveBeenCalledWith('1 import failed: broken.arw (corrupt broken.arw)', 'error', 8000);
    expect(toast.mock.calls.some(([message]) => String(message).includes('duplicate'))).toBe(false);
    library.dispose();
  });

  it('shows per-file failures even when nothing was imported', async () => {
    const library = await openLibrary(new MemoryKloudDB(), stubDeps({ failMeta: ['broken.arw'] }));
    const toast = vi.fn();
    const ctx = { library, toast, selection: new Signal<string[]>([]) } as unknown as AppContext;
    const busy = createBusyTracker(new Signal<BusyState>({ active: false }));

    expect(await runImport(ctx, busy, [{ folder: '', files: [makeFile('broken.arw')] }])).toEqual([]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('1 import failed: broken.arw (corrupt broken.arw)', 'error', 8000);
    library.dispose();
  });
});
