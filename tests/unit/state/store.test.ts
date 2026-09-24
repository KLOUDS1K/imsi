import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COALESCE_MS, EditorStore, SERIALIZED_HISTORY } from '@/editor/state';
import { SERIALIZED_POINT_BUDGET } from '@/editor/state/store';
import type { ChangeInfo } from '@/editor/contracts';
import { createDefaultParams, createMask } from '@/editor/defaults';
import type { BrushStroke, EditParams } from '@/editor/types';

function recorder(store: EditorStore) {
  const calls: { params: EditParams; info: ChangeInfo }[] = [];
  store.subscribe((params, info) => calls.push({ params, info }));
  return calls;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('EditorStore basics', () => {
  it('starts with a single Import entry', () => {
    const s = new EditorStore();
    expect(s.history).toHaveLength(1);
    expect(s.history[0].label).toBe('Import');
    expect(s.historyIndex).toBe(0);
    expect(s.canUndo()).toBe(false);
    expect(s.canRedo()).toBe(false);
    expect(s.params).toEqual(createDefaultParams());
  });

  it('uses RAW defaults when isRaw', () => {
    const s = new EditorStore(undefined, { isRaw: true });
    expect(s.params.detail.sharpenAmount).toBe(40);
    expect(s.params.noise.color).toBe(25);
  });

  it('set() writes copy-on-write with structural sharing and readable labels', () => {
    const s = new EditorStore();
    const before = s.params;
    const calls = recorder(s);
    s.set('basic.exposure', 0.35);
    expect(s.params.basic.exposure).toBe(0.35);
    expect(s.params).not.toBe(before);
    expect(s.params.basic).not.toBe(before.basic);
    expect(s.params.hsl).toBe(before.hsl);
    expect(s.params.toneCurve).toBe(before.toneCurve);
    expect(before.basic.exposure).toBe(0);
    expect(s.history.map((h) => h.label)).toEqual(['Import', 'Exposure +0.35']);
    expect(calls).toHaveLength(1);
    expect(calls[0].info).toEqual({ label: 'Exposure +0.35', paths: ['basic.exposure'], source: 'set', interactive: false });
    expect(s.get('basic.exposure')).toBe(0.35);
  });

  it('formats labels for different kinds of values', () => {
    const s = new EditorStore();
    s.set('basic.contrast', 12);
    s.set('basic.shadows', -5);
    s.set('crop.flipH', true);
    s.set('transform.upright', 'auto');
    s.set('crop.angle', 2.5);
    s.set('toneCurve.rgb', [{ x: 0, y: 0.1 }, { x: 1, y: 1 }]);
    expect(s.history.slice(1).map((h) => h.label)).toEqual([
      'Contrast +12',
      'Shadows -5',
      'Flip Horizontal On',
      'Upright Auto',
      'Straighten +2.5°',
      'Tone Curve',
    ]);
  });

  it('uses the mask name in labels of mask paths', () => {
    const p = createDefaultParams();
    p.masks.push(createMask('Sky', 'm1'));
    const s = new EditorStore(p);
    s.set('masks.0.adjustments.exposure', -0.5);
    expect(s.history[1].label).toBe('Sky: Exposure -0.50');
  });

  it('clamps numbers to their range, rejects invalid values and unknown containers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new EditorStore();
    s.set('basic.exposure', 12);
    expect(s.params.basic.exposure).toBe(5);
    s.set('hsl.red.hue', -500);
    expect(s.params.hsl.red.hue).toBe(-100);
    s.set('colorGrading.shadows.hue', 370);
    expect(s.params.colorGrading.shadows.hue).toBe(10);
    const len = s.history.length;
    s.set('basic.contrast', Number.NaN);
    s.set('basic.contrast', 'high');
    s.set('masks.3.name', 'x');
    expect(s.history.length).toBe(len);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it('ignores no-op sets', () => {
    const s = new EditorStore();
    const calls = recorder(s);
    s.set('basic.exposure', 0);
    s.set('toneCurve.rgb', [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    expect(calls).toHaveLength(0);
    expect(s.history).toHaveLength(1);
  });

  it('deep-freezes params in dev so listeners cannot mutate them', () => {
    const s = new EditorStore();
    let threw = false;
    s.subscribe((p) => {
      try {
        (p.basic as { exposure: number }).exposure = 3;
      } catch {
        threw = true;
      }
    });
    s.set('basic.contrast', 10);
    expect(threw).toBe(true);
    expect(s.params.basic.exposure).toBe(0);
    expect(Object.isFrozen(s.params.hsl.red)).toBe(true);
    expect(Object.isFrozen(s.history)).toBe(true);
  });

  it('copies object values so later caller mutations do not leak in', () => {
    const s = new EditorStore();
    const pts = [{ x: 0, y: 0.2 }, { x: 1, y: 0.9 }];
    s.set('toneCurve.rgb', pts);
    pts[0].y = 0.5;
    expect(s.params.toneCurve.rgb[0].y).toBe(0.2);
  });

  it('keeps notifying other listeners when one throws; unsubscribe works', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = new EditorStore();
    let a = 0;
    let b = 0;
    s.subscribe(() => {
      a++;
      throw new Error('boom');
    });
    const off = s.subscribe(() => b++);
    s.set('basic.exposure', 1);
    off();
    s.set('basic.exposure', 2);
    expect(a).toBe(2);
    expect(b).toBe(1);
    expect(err).toHaveBeenCalled();
  });
});

describe('coalescing', () => {
  it('merges repeated sets of one path within 1.2 s into one entry', () => {
    const s = new EditorStore();
    s.set('basic.exposure', 0.1);
    vi.advanceTimersByTime(300);
    s.set('basic.exposure', 0.2);
    vi.advanceTimersByTime(300);
    s.set('basic.exposure', 0.35);
    expect(s.history).toHaveLength(2);
    expect(s.history[1].label).toBe('Exposure +0.35');
    expect(s.history[1].params.basic.exposure).toBe(0.35);
  });

  it('measures the window from the last change (slow continuous drags stay one entry)', () => {
    const s = new EditorStore();
    for (let i = 1; i <= 10; i++) {
      s.set('basic.exposure', i / 10);
      vi.advanceTimersByTime(800);
    }
    expect(s.history).toHaveLength(2);
  });

  it('starts a new entry after the window or for a different path', () => {
    const s = new EditorStore();
    s.set('basic.exposure', 0.1);
    vi.advanceTimersByTime(COALESCE_MS + 1);
    s.set('basic.exposure', 0.2);
    s.set('basic.contrast', 5);
    s.set('basic.exposure', 0.3);
    expect(s.history.map((h) => h.label)).toEqual(['Import', 'Exposure +0.10', 'Exposure +0.20', 'Contrast +5', 'Exposure +0.30']);
  });

  it('honours explicit coalesce keys (shared key merges, null never merges)', () => {
    const s = new EditorStore();
    s.set('whiteBalance.temperature', 10, { coalesceKey: 'wb', label: 'White Balance' });
    s.set('whiteBalance.tint', 5, { coalesceKey: 'wb', label: 'White Balance' });
    expect(s.history).toHaveLength(2);
    s.set('basic.exposure', 1, { coalesceKey: null });
    s.set('basic.exposure', 1.1, { coalesceKey: null });
    expect(s.history).toHaveLength(4);
  });

  it('coalesces update() by label by default', () => {
    const s = new EditorStore();
    s.update('Tone Curve', (d) => {
      d.toneCurve.rgb = [{ x: 0, y: 0.05 }, { x: 1, y: 1 }];
    });
    s.update('Tone Curve', (d) => {
      d.toneCurve.rgb = [{ x: 0, y: 0.1 }, { x: 1, y: 1 }];
    });
    expect(s.history).toHaveLength(2);
    expect(s.history[1].label).toBe('Tone Curve');
  });

  it('does not coalesce into an entry reached by undo/redo', () => {
    const s = new EditorStore();
    s.set('basic.exposure', 0.1);
    s.undo();
    s.redo();
    s.set('basic.exposure', 0.2);
    expect(s.history).toHaveLength(3);
  });
});

describe('gestures', () => {
  it('groups a drag into one entry, interactive until endGesture', () => {
    const s = new EditorStore();
    const calls = recorder(s);
    s.beginGesture('Exposure');
    expect(s.gestureActive).toBe(true);
    for (let i = 1; i <= 5; i++) {
      s.set('basic.exposure', i / 10);
      vi.advanceTimersByTime(2000);
    }
    s.endGesture();
    expect(s.gestureActive).toBe(false);
    expect(s.history).toHaveLength(2);
    expect(s.history[1].label).toBe('Exposure +0.50');
    expect(calls.slice(0, 5).every((c) => c.info.interactive)).toBe(true);
    const last = calls[calls.length - 1].info;
    expect(last.interactive).toBe(false);
    expect(last.paths).toEqual(['basic.exposure']);
  });

  it('uses the gesture label for mixed changes and does not coalesce afterwards', () => {
    const s = new EditorStore();
    s.beginGesture('Color Grading');
    s.set('colorGrading.shadows.hue', 200);
    s.set('colorGrading.shadows.saturation', 20);
    s.update('ignored label', (d) => {
      d.colorGrading.balance = -10;
    });
    s.endGesture();
    s.set('colorGrading.shadows.hue', 210);
    expect(s.history.map((h) => h.label)).toEqual(['Import', 'Color Grading', 'Color Grade Shadows Hue 210°']);
  });

  it('nested beginGesture is a no-op and a gesture without changes adds nothing', () => {
    const s = new EditorStore();
    const calls = recorder(s);
    s.beginGesture('A');
    s.beginGesture('B');
    s.endGesture();
    s.endGesture();
    expect(s.history).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('undo during a gesture ends it first', () => {
    const s = new EditorStore();
    s.beginGesture('Exposure');
    s.set('basic.exposure', 1);
    expect(s.undo()).toBe(true);
    expect(s.gestureActive).toBe(false);
    expect(s.params.basic.exposure).toBe(0);
  });
});

describe('transient updates', () => {
  it('change params without history; undo reverts them first', () => {
    const s = new EditorStore();
    s.set('basic.contrast', 20);
    s.set('basic.exposure', 0.5, { transient: true });
    expect(s.params.basic.exposure).toBe(0.5);
    expect(s.history).toHaveLength(2);
    expect(s.dirty).toBe(true);
    expect(s.canUndo()).toBe(true);
    s.undo();
    expect(s.params.basic.exposure).toBe(0);
    expect(s.params.basic.contrast).toBe(20);
    expect(s.dirty).toBe(false);
  });

  it('are captured by the next committed entry', () => {
    const s = new EditorStore();
    s.set('basic.exposure', 0.5, { transient: true });
    s.set('basic.contrast', 10);
    expect(s.history[1].params.basic.exposure).toBe(0.5);
  });
});

describe('undo / redo / history navigation', () => {
  function threeSteps() {
    const s = new EditorStore();
    s.set('basic.exposure', 1);
    s.set('basic.contrast', 10);
    s.set('presence.clarity', 20);
    return s;
  }

  it('undo and redo walk the entries and report changed paths', () => {
    const s = threeSteps();
    const calls = recorder(s);
    expect(s.undo()).toBe(true);
    expect(s.params.presence.clarity).toBe(0);
    expect(calls[0].info).toMatchObject({ source: 'undo', paths: ['presence.clarity'], label: 'Clarity +20' });
    s.undo();
    s.undo();
    expect(s.undo()).toBe(false);
    expect(s.params).toEqual(createDefaultParams());
    expect(s.canRedo()).toBe(true);
    s.redo();
    s.redo();
    expect(s.params.basic.contrast).toBe(10);
    expect(calls[calls.length - 1].info.source).toBe('redo');
    s.redo();
    expect(s.redo()).toBe(false);
    expect(s.params.presence.clarity).toBe(20);
  });

  it('goToHistory moves the pointer; a new change truncates the redo branch', () => {
    const s = threeSteps();
    s.goToHistory(1);
    expect(s.historyIndex).toBe(1);
    expect(s.params.basic.exposure).toBe(1);
    expect(s.params.basic.contrast).toBe(0);
    expect(s.history).toHaveLength(4);
    s.set('effects.grainAmount', 30);
    expect(s.history.map((h) => h.label)).toEqual(['Import', 'Exposure +1.00', 'Grain 30']);
    expect(s.canRedo()).toBe(false);
    s.goToHistory(99);
    expect(s.historyIndex).toBe(2);
  });

  it('history snapshots share untouched subtrees', () => {
    const s = threeSteps();
    const h = s.history;
    expect(h[1].params.hsl).toBe(h[0].params.hsl);
    expect(h[3].params.basic).toBe(h[2].params.basic);
    expect(h[3].params.presence).not.toBe(h[2].params.presence);
  });

  it('drops the oldest entries beyond maxHistory', () => {
    const s = new EditorStore(undefined, { maxHistory: 5 });
    for (let i = 1; i <= 8; i++) s.set('basic.contrast', i, { coalesceKey: null });
    expect(s.history).toHaveLength(5);
    expect(s.history[0].label).toBe('Contrast +4');
    expect(s.historyIndex).toBe(4);
    while (s.undo());
    expect(s.params.basic.contrast).toBe(4);
  });

  it('clearHistory keeps the current state only', () => {
    const s = threeSteps();
    const calls = recorder(s);
    s.clearHistory();
    expect(s.history).toHaveLength(1);
    expect(s.historyIndex).toBe(0);
    expect(s.canUndo()).toBe(false);
    expect(s.params.presence.clarity).toBe(20);
    expect(calls[0].info).toMatchObject({ source: 'history', paths: [] });
  });
});

describe('update / replace / reset', () => {
  it('update clones, mutates, reconciles and reports exact paths', () => {
    const s = new EditorStore();
    const before = s.params;
    const calls = recorder(s);
    s.update('Add Mask', (d) => {
      d.masks.push(createMask('Mask 1', 'm1'));
      d.basic.whites = 10;
    });
    expect(s.params.masks).toHaveLength(1);
    expect(s.params.hsl).toBe(before.hsl);
    expect(calls[0].info.paths.sort()).toEqual(['basic.whites', 'masks']);
    expect(calls[0].info.source).toBe('update');
    // Draft mutation after the fact cannot touch the store.
    expect(Object.isFrozen(s.params.masks[0])).toBe(true);
  });

  it('update without effective change is a no-op', () => {
    const s = new EditorStore();
    const calls = recorder(s);
    s.update('Nothing', () => {});
    expect(calls).toHaveLength(0);
    expect(s.history).toHaveLength(1);
  });

  it('keeps existing brush strokes shared when a stroke is appended', () => {
    const p = createDefaultParams();
    const m = createMask('Mask 1', 'm1');
    const stroke: BrushStroke = { points: [{ x: 0.1, y: 0.1 }], size: 0.02, feather: 50, flow: 100, density: 100, erase: false };
    m.components.push({ id: 'c1', kind: 'brush', mode: 'add', invert: false, brush: { strokes: [stroke] } });
    p.masks.push(m);
    const s = new EditorStore(p);
    const first = s.params.masks[0].components[0].brush!.strokes[0];
    s.update('Mask 1: Brush', (d) => {
      d.masks[0].components[0].brush!.strokes.push({ ...stroke, points: [{ x: 0.5, y: 0.5 }] });
    });
    expect(s.params.masks[0].components[0].brush!.strokes).toHaveLength(2);
    expect(s.params.masks[0].components[0].brush!.strokes[0]).toBe(first);
  });

  it('replace commits a whole new params object', () => {
    const s = new EditorStore();
    const next = createDefaultParams();
    next.color.vibrance = 30;
    const calls = recorder(s);
    s.replace(next, 'Preset: KLOUD Punch');
    expect(s.params.color.vibrance).toBe(30);
    expect(s.history[1].label).toBe('Preset: KLOUD Punch');
    expect(calls[0].info).toMatchObject({ source: 'replace', paths: ['color.vibrance'] });
    next.color.vibrance = 50;
    expect(s.params.color.vibrance).toBe(30);
  });

  it('reset returns to defaults as a history step', () => {
    const s = new EditorStore(undefined, { isRaw: true });
    s.set('basic.exposure', 1);
    s.set('detail.sharpenAmount', 90);
    s.reset();
    expect(s.params).toEqual(createDefaultParams(true));
    expect(s.history[s.history.length - 1].label).toBe('Original Reset');
    s.undo();
    expect(s.params.detail.sharpenAmount).toBe(90);
  });
});

describe('snapshots', () => {
  it('create / apply / rename / delete', () => {
    const s = new EditorStore();
    s.set('basic.exposure', 1);
    const calls = recorder(s);
    const snap = s.createSnapshot('Bright');
    expect(calls[0].info).toMatchObject({ source: 'snapshot', paths: [] });
    s.set('basic.exposure', -1);
    s.applySnapshot(snap.id);
    expect(s.params.basic.exposure).toBe(1);
    expect(s.history[s.history.length - 1].label).toBe('Snapshot: Bright');
    s.renameSnapshot(snap.id, 'Bright v2');
    expect(s.snapshots[0].name).toBe('Bright v2');
    s.deleteSnapshot(snap.id);
    expect(s.snapshots).toHaveLength(0);
    s.undo();
    expect(s.params.basic.exposure).toBe(-1);
  });
});

describe('serialize / load', () => {
  it('round-trips params, history, index and snapshots', () => {
    const s = new EditorStore();
    s.set('basic.exposure', 0.5);
    s.set('presence.clarity', 15);
    s.createSnapshot('A');
    s.set('color.vibrance', 20);
    s.undo();
    const json = JSON.parse(JSON.stringify(s.serialize()));
    const t = new EditorStore();
    const calls = recorder(t);
    t.load(json);
    expect(t.params).toEqual(s.params);
    expect(t.history.map((h) => h.label)).toEqual(s.history.map((h) => h.label));
    expect(t.historyIndex).toBe(s.historyIndex);
    expect(t.snapshots.map((x) => x.name)).toEqual(['A']);
    expect(t.canRedo()).toBe(true);
    t.redo();
    expect(t.params.color.vibrance).toBe(20);
    expect(calls[0].info).toMatchObject({ source: 'load', paths: ['*'] });
    // Structural sharing is re-established between consecutive entries.
    expect(t.history[1].params.hsl).toBe(t.history[0].params.hsl);
  });

  it('keeps only the last 50 entries and remaps the index', () => {
    const s = new EditorStore();
    for (let i = 1; i <= 80; i++) s.set('basic.contrast', i, { coalesceKey: null });
    const st = s.serialize();
    expect(st.history).toHaveLength(SERIALIZED_HISTORY);
    expect(st.historyIndex).toBe(SERIALIZED_HISTORY - 1);
    expect(st.history[st.historyIndex].params.basic.contrast).toBe(80);
    s.goToHistory(5);
    const st2 = s.serialize();
    expect(st2.history[st2.historyIndex].params.basic.contrast).toBe(5);
  });

  it('bounds serialized brush data', () => {
    const s = new EditorStore();
    s.update('Add Mask', (d) => {
      const m = createMask('Mask 1', 'm1');
      m.components.push({ id: 'c1', kind: 'brush', mode: 'add', invert: false, brush: { strokes: [] } });
      d.masks.push(m);
    });
    const points = Array.from({ length: 5_000 }, (_, i) => ({ x: (i % 1000) / 1000, y: 0.5 }));
    for (let i = 0; i < 20; i++) {
      s.update(
        'Mask 1: Brush',
        (d) => {
          d.masks[0].components[0].brush!.strokes.push({ points, size: 0.02, feather: 50, flow: 100, density: 100, erase: false });
        },
        { coalesceKey: null },
      );
    }
    const st = s.serialize();
    const total = st.history.reduce((n, e) => n + e.params.masks.reduce((a, m) => a + m.components.reduce((b, c) => b + (c.brush?.strokes.reduce((x, k) => x + k.points.length, 0) ?? 0), 0), 0), 0);
    expect(total).toBeLessThanOrEqual(SERIALIZED_POINT_BUDGET);
    expect(total).toBeGreaterThan(SERIALIZED_POINT_BUDGET / 2);
    expect(st.history.length).toBeLessThan(s.history.length);
    expect(st.history[st.historyIndex].params).toBe(s.params);
  });

  it('load tolerates garbage', () => {
    const s = new EditorStore();
    s.load({ format: 'kloud-edit', version: 1, params: { basic: { exposure: 'x', contrast: 400 } } as unknown as EditParams, history: [null, 5] as never, historyIndex: 99, snapshots: [{}] as never, updated: 0 });
    expect(s.params.basic.contrast).toBe(100);
    expect(s.history).toHaveLength(1);
    expect(s.snapshots).toHaveLength(1);
  });
});

describe('set() on large arrays', () => {
  it('keeps unchanged elements shared with the previous snapshot', () => {
    const p = createDefaultParams();
    const m = createMask('Mask 1', 'm1');
    m.components.push({ id: 'c1', kind: 'brush', mode: 'add', invert: false, brush: { strokes: [] } });
    p.masks.push(m);
    const s = new EditorStore(p);
    const stroke = (x: number): BrushStroke => ({ points: [{ x, y: 0.5 }], size: 0.02, feather: 50, flow: 100, density: 100, erase: false });
    const path = 'masks.0.components.0.brush.strokes';
    s.set(path, [stroke(0.1)]);
    const first = s.params.masks[0].components[0].brush!.strokes[0];
    s.set(path, [...s.get<BrushStroke[]>(path), stroke(0.2)], { coalesceKey: null });
    expect(s.params.masks[0].components[0].brush!.strokes[0]).toBe(first);
    expect(s.history[1].params.masks[0].components[0].brush!.strokes[0]).toBe(first);
    expect(s.history.map((h) => h.label)).toEqual(['Import', 'Mask 1: Brush', 'Mask 1: Brush']);
  });
});
