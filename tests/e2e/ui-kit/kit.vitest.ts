/**
 * Pure-helper unit checks for the UI kit, run in node (no DOM): proves the kit
 * can be imported by other modules' node-based unit tests.
 *
 *   npx vitest run --config tests/e2e/ui-kit/vitest.config.ts
 *
 * (Named *.vitest.ts so Playwright, which owns tests/e2e, ignores it.)
 */
import { describe, expect, it } from 'vitest';
import * as kit from '@/ui/kit';

describe('kit in node', () => {
  it('imports without a DOM', () => {
    expect(typeof kit.createSlider).toBe('function');
    expect(kit.ICON_NAMES.length).toBeGreaterThanOrEqual(90);
  });
  it('number helpers', () => {
    expect(kit.decimalsOf(0.05)).toBe(2);
    expect(kit.decimalsOf(1)).toBe(0);
    expect(kit.decimalsOf(1e-3)).toBe(3);
    expect(kit.formatNumber(0.5, 2, true)).toBe('+0.50');
    expect(kit.formatNumber(-12, 0, true)).toBe('−12');
    expect(kit.formatNumber(-0.001, 2, true)).toBe('0.00');
    expect(kit.parseNumber('−1,5 EV')).toBe(-1.5);
    expect(kit.parseNumber('40 %')).toBe(40);
    expect(kit.parseNumber('abc')).toBeNull();
    expect(kit.snapTo(0.30000000000000004, 0.05)).toBe(0.3);
    expect(kit.snapTo(7, 5, 0)).toBe(5);
  });
  it('shortcuts (non-mac)', () => {
    expect(kit.shortcutParts('Shift+Mod+Z')).toEqual(['Ctrl', 'Shift', 'Z']);
    expect(kit.formatShortcut('Mod+\\')).toBe('Ctrl+\\');
    expect(kit.shortcutParts('ArrowRight')).toEqual(['→']);
    expect(kit.shortcutParts('Mod++')).toEqual(['Ctrl', '+']);
  });
  it('hex', () => {
    expect(kit.normalizeHex('#ABC')).toBe('#aabbcc');
    expect(kit.normalizeHex('f2c230')).toBe('#f2c230');
    expect(kit.normalizeHex('#12')).toBeNull();
  });
});
