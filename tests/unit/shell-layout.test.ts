import { describe, expect, it } from 'vitest';
import { layoutFor } from '@/ui/shell/state';

describe('responsive shell layout', () => {
  it('uses the phone editor in portrait without touch detection', () => {
    expect(layoutFor(390, 844, false)).toBe('phone');
  });

  it('keeps a rotated touch phone in the phone editor', () => {
    expect(layoutFor(844, 390, true)).toBe('phone');
  });

  it('does not turn a short desktop window into the phone editor', () => {
    expect(layoutFor(844, 390, false)).toBe('medium');
  });

  it('leaves desktop breakpoints unchanged', () => {
    expect(layoutFor(1440, 900, false)).toBe('wide');
    expect(layoutFor(1000, 900, false)).toBe('medium');
    expect(layoutFor(800, 900, false)).toBe('narrow');
  });
});
