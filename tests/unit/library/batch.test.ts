import { describe, expect, it, vi } from 'vitest';
import {
  BatchError,
  applyPrevious,
  appendHistoryStep,
  batchApplyPreset,
  batchModule,
  copySettings,
  openLibrary,
  pasteSettings,
  refitCropRect,
  syncSettings,
  type Library,
} from '@/editor/library';
import { MemoryKloudDB } from '@/editor/storage';
import { createDefaultParams, createMask } from '@/editor/defaults';
import type { EditParams, Preset, SerializedEditState } from '@/editor/types';
import { makeFile, stubDeps } from './fixtures';

function withAssets(p: EditParams, patchKey: string, bitmapKey: string): EditParams {
  p.retouch.removals = [{ id: 'rm', kind: 'generative', bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, strokes: [], patchKey }];
  p.retouch.spots = [{ id: 's1', kind: 'heal', x: 0.5, y: 0.5, sx: 0.4, sy: 0.4, radius: 0.02, feather: 50, opacity: 100 } as EditParams['retouch']['spots'][number]];
  const m = createMask('Sky', 'm1');
  m.components.push({ id: 'c1', kind: 'ai', mode: 'add', invert: false, ai: { target: 'sky', bitmapKey } });
  m.adjustments.exposure = 0.7;
  p.masks = [m];
  return p;
}

/** Library with a landscape JPEG, a portrait JPEG and a RAW. */
async function setup(): Promise<{ lib: Library; land: string; port: string; raw: string }> {
  const deps = stubDeps({
    metas: {
      'land.jpg': { width: 6000, height: 4000 },
      'port.jpg': { width: 4000, height: 6000 },
      'raw.dng': { width: 6000, height: 4000 },
    },
  });
  const lib = await openLibrary(new MemoryKloudDB(), deps);
  const [land, port, raw] = await lib.importFiles([makeFile('land.jpg'), makeFile('port.jpg'), makeFile('raw.dng')]);
  return { lib, land: land.id, port: port.id, raw: raw.id };
}

describe('copy / paste', () => {
  it('copies only the chosen groups and pastes them without touching the rest', () => {
    const src = createDefaultParams();
    src.basic.exposure = 1.2;
    src.basic.contrast = 30;
    src.color.vibrance = 25;
    const clip = copySettings(src, ['color', 'exposure', 'exposure', 'bogus' as never]);
    expect(clip.groups).toEqual(['exposure', 'color']);
    src.color.vibrance = 99; // later edits of the source do not leak into the clip
    const target = createDefaultParams();
    target.basic.contrast = -10;
    target.detail.sharpenAmount = 60;
    const out = pasteSettings(target, clip);
    expect(out.basic.exposure).toBe(1.2);
    expect(out.color.vibrance).toBe(25);
    expect(out.basic.contrast).toBe(-10);
    expect(out.detail.sharpenAmount).toBe(60);
    expect(target.basic.exposure).toBe(0);
    expect(batchModule.copySettings).toBe(copySettings);
  });

  it('never transfers AI bitmap keys or removal patches', () => {
    const src = withAssets(createDefaultParams(), 'pk-src', 'bk-src');
    const target = withAssets(createDefaultParams(), 'pk-target', 'bk-target');
    const out = pasteSettings(target, copySettings(src, ['masks', 'retouch']));
    expect(out.masks[0].components[0].ai?.bitmapKey).toBeUndefined();
    expect(out.masks[0].adjustments.exposure).toBe(0.7);
    expect(out.retouch.removals.map((r) => r.patchKey)).toEqual(['pk-target']);
    expect(out.retouch.spots).toHaveLength(1);
  });

  it('re-fits an aspect-locked crop when the target meta is given', () => {
    const src = createDefaultParams();
    Object.assign(src.crop, { x: 1 / 6, y: 0, w: 2 / 3, h: 1, aspect: '1:1' });
    const out = pasteSettings(createDefaultParams(), copySettings(src, ['crop']), { meta: { width: 4000, height: 6000 } });
    // Largest 1:1 on a 2:3 portrait frame is w = 1, h = 2/3, centred.
    expect(out.crop.w).toBeCloseTo(1);
    expect(out.crop.h).toBeCloseTo(2 / 3);
    expect(out.crop.y).toBeCloseTo(1 / 6);
  });
});

describe('refitCropRect', () => {
  it('keeps free crops and is idempotent on the same frame', () => {
    const crop = { ...createDefaultParams().crop, aspect: 'free' as const, x: 0.1, y: 0.2, w: 0.5, h: 0.4 };
    expect(refitCropRect(crop, 6000, 4000)).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
    const locked = { ...crop, aspect: '3:2' as const, x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    const r = refitCropRect(locked, 6000, 4000);
    expect(r.w).toBeCloseTo(0.5);
    expect(r.h).toBeCloseTo(0.5);
    // 'original' is frame-relative and copies verbatim.
    expect(refitCropRect({ ...crop, aspect: 'original' }, 4000, 6000)).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 });
    // On a portrait frame the 3:2 crop keeps its pixel aspect.
    const p = refitCropRect(locked, 4000, 6000);
    expect((p.w * 4000) / (p.h * 6000)).toBeCloseTo(1.5);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y + p.h).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('syncSettings', () => {
  it('applies the groups to every target, appends one history step and keeps hasEdits in sync', async () => {
    const { lib, land, port, raw } = await setup();
    const existing = createDefaultParams();
    existing.detail.sharpenAmount = 70;
    const prevState: SerializedEditState = appendHistoryStep(undefined, createDefaultParams(), existing, 'Sharpening', 100);
    await lib.saveEdit(port, prevState);

    const src = withAssets(createDefaultParams(), 'pk-src', 'bk-src');
    src.basic.exposure = 0.8;
    src.whiteBalance.temperature = 12;
    Object.assign(src.crop, { x: 1 / 6, y: 0, w: 2 / 3, h: 1, aspect: '1:1', angle: 2 });
    const progress: [number, number][] = [];
    await syncSettings(lib, src, [port, raw, 'missing', port], ['exposure', 'whiteBalance', 'crop', 'masks'], (d, t) => progress.push([d, t]), {
      cropValidator: null,
    });
    expect(progress[0]).toEqual([0, 3]);
    expect(progress.at(-1)).toEqual([3, 3]);

    const p = (await lib.loadEdit(port))!;
    expect(p.params.basic.exposure).toBe(0.8);
    expect(p.params.whiteBalance.temperature).toBe(12);
    expect(p.params.detail.sharpenAmount).toBe(70); // untouched group survives
    expect(p.params.masks[0].components[0].ai?.bitmapKey).toBeUndefined();
    expect(p.params.crop.angle).toBe(2);
    expect(p.params.crop.w).toBeCloseTo(1);
    expect(p.params.crop.h).toBeCloseTo(2 / 3);
    expect(p.history.map((h) => h.label)).toEqual(['Import', 'Sharpening', 'Sync Settings']);
    expect(p.historyIndex).toBe(2);

    const r = (await lib.loadEdit(raw))!;
    expect(r.params.basic.exposure).toBe(0.8);
    // RAW defaults (e.g. sharpening) come from normalizeParams(…, isRaw = true).
    expect(r.params.detail.sharpenAmount).toBe(createDefaultParams(true).detail.sharpenAmount);
    expect(r.history.map((h) => h.label)).toEqual(['Import', 'Sync Settings']);
    expect(lib.get(raw)?.hasEdits).toBe(true);
    expect(await lib.loadEdit(land)).toBeUndefined();
  });

  it('does not add a step when nothing changes and drops a redo branch otherwise', async () => {
    const { lib, land } = await setup();
    const a = createDefaultParams();
    a.basic.exposure = 1;
    const b = createDefaultParams();
    b.basic.exposure = 2;
    let state = appendHistoryStep(undefined, createDefaultParams(), a, 'A', 1);
    state = appendHistoryStep(state, createDefaultParams(), b, 'B', 2);
    state = { ...state, params: a, historyIndex: 1 }; // user undid B
    await lib.saveEdit(land, state);
    await syncSettings(lib, a, [land], ['exposure']);
    expect((await lib.loadEdit(land))?.history).toHaveLength(3);
    const c = createDefaultParams();
    c.basic.exposure = 3;
    await syncSettings(lib, c, [land], ['exposure']);
    expect((await lib.loadEdit(land))?.history.map((h) => h.label)).toEqual(['Import', 'A', 'Sync Settings']);
  });

  it('keeps going when a target fails and reports failures in a BatchError', async () => {
    const { lib, land, port } = await setup();
    const orig = lib.saveEdit.bind(lib);
    vi.spyOn(lib, 'saveEdit').mockImplementation(async (id, s) => {
      if (id === land) throw new Error('quota');
      return orig(id, s);
    });
    const src = createDefaultParams();
    src.basic.exposure = 0.3;
    const err = await syncSettings(lib, src, [land, port], ['exposure']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BatchError);
    expect((err as BatchError).failures.map((f) => f.id)).toEqual([land]);
    expect((err as BatchError).succeeded).toBe(1);
    expect((await lib.loadEdit(port))?.params.basic.exposure).toBe(0.3);
  });

  it('constrains a synced crop with the provided validator', async () => {
    const { lib, land } = await setup();
    const src = createDefaultParams();
    Object.assign(src.crop, { angle: 10, constrainToImage: true });
    const validator = vi.fn(() => (_p: EditParams, rect: { w: number }) => rect.w <= 0.8);
    await syncSettings(lib, src, [land], ['crop'], undefined, { cropValidator: validator });
    const crop = (await lib.loadEdit(land))!.params.crop;
    expect(crop.angle).toBe(10);
    expect(crop.w).toBeLessThanOrEqual(0.8);
    expect(crop.w).toBeGreaterThan(0.75);
    expect(crop.x + crop.w / 2).toBeCloseTo(0.5);
  });
});

describe('batchApplyPreset / applyPrevious', () => {
  const preset: Preset = {
    id: 'p-test',
    name: 'Warm',
    group: 'Test',
    builtin: false,
    groups: ['whiteBalance', 'color'],
    params: { whiteBalance: { temperature: 40 }, color: { vibrance: 20 } },
    created: 0,
    updated: 0,
  };

  it('applies a preset with amount to many photos', async () => {
    const { lib, land, port } = await setup();
    const done: number[] = [];
    await batchApplyPreset(lib, preset, [land, port], 50, (d) => done.push(d));
    for (const id of [land, port]) {
      const s = (await lib.loadEdit(id))!;
      expect(s.params.whiteBalance.temperature).toBeCloseTo(20);
      expect(s.params.color.vibrance).toBeCloseTo(10);
      expect(s.history.at(-1)?.label).toBe('Preset: Warm (50%)');
    }
    expect(done.at(-1)).toBe(2);
    await batchApplyPreset(lib, preset, [land]);
    expect((await lib.loadEdit(land))?.params.whiteBalance.temperature).toBe(40);
  });

  it('applyPrevious copies all settings of the previous photo (skipping itself)', async () => {
    const { lib, land, port, raw } = await setup();
    const prev = createDefaultParams();
    prev.basic.exposure = -0.5;
    prev.effects.grainAmount = 30;
    await lib.saveEdit(land, appendHistoryStep(undefined, createDefaultParams(), prev, 'Edit', 1));
    await applyPrevious(lib, land, [land, port]);
    const s = (await lib.loadEdit(port))!;
    expect(s.params.basic.exposure).toBe(-0.5);
    expect(s.params.effects.grainAmount).toBe(30);
    expect(s.history.at(-1)?.label).toBe('Previous');
    expect((await lib.loadEdit(land))?.history).toHaveLength(2);

    await applyPrevious(lib, land, [raw], ['exposure']);
    const r = (await lib.loadEdit(raw))!;
    expect(r.params.basic.exposure).toBe(-0.5);
    expect(r.params.effects.grainAmount).toBe(0);
    await expect(applyPrevious(lib, 'nope', [raw])).rejects.toThrow();
  });
});
