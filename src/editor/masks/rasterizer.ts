/**
 * MaskRasterizer: turns a Mask into a coverage plane, caching every component
 * by a content key (component params + size + versions of the source / depth /
 * AI bitmap it reads) and recombining only what changed. Brush components are
 * rasterized incrementally, so live painting only stamps new dabs and
 * recombines the dirty rectangle.
 */
import type { MaskRasterContext } from '@/editor/contracts';
import type { Mask, MaskComponent } from '@/editor/types';
import { BrushRaster, unionRect, type IRect } from './brush';
import { fillAi, fillColorRange, fillDepthRange, fillLinear, fillLuminanceRange, fillRadial } from './components';
import { Hasher, IdentityVersions } from './hash';
import { getSourceFeatures } from './source';

interface CompCache {
  key: string;
  cov: Uint8Array;
  brush?: BrushRaster;
  lastUsed: number;
}

interface MaskCache {
  w: number;
  h: number;
  comps: Map<string, CompCache>;
  combineSig: string;
  out: Uint8Array;
  key: string;
  empty: boolean;
  lastUsed: number;
}

export interface RasterResult {
  /** Internal buffer — copy before handing out or mutating. */
  data: Uint8Array;
  key: string;
  empty: boolean;
  /** Changed pixels since the previous call for this mask (null = unchanged). */
  dirty: IRect | null;
}

/* ---------------- integer blend math (0..255) ---------------- */

/** Exact round(a·b / 255) for a, b ∈ 0..255. */
const mul255 = (a: number, b: number) => {
  const t = a * b + 128;
  return (t + (t >> 8)) >> 8;
};

function combineRect(mask: Mask, covs: Uint8Array[], out: Uint8Array, w: number, r: IRect): void {
  const comps = mask.components;
  for (let y = r.y0; y < r.y1; y++) {
    const s = y * w + r.x0;
    const e = y * w + r.x1;
    const c0 = covs[0]!;
    if (comps[0]!.invert) for (let i = s; i < e; i++) out[i] = 255 - c0[i]!;
    else out.set(c0.subarray(s, e), s);
    for (let k = 1; k < comps.length; k++) {
      const c = covs[k]!;
      const inv = comps[k]!.invert;
      const mode = comps[k]!.mode;
      for (let i = s; i < e; i++) {
        const a = out[i]!;
        const b = inv ? 255 - c[i]! : c[i]!;
        const ab = mul255(a, b);
        out[i] = mode === 'intersect' ? ab : mode === 'subtract' ? a - ab : a + b - ab;
      }
    }
    if (mask.invert) for (let i = s; i < e; i++) out[i] = 255 - out[i]!;
  }
}

function hasCoverage(a: Uint8Array): boolean {
  // Word-wise scan: 4× fewer iterations for the common all-zero tail.
  const n4 = a.length >> 2;
  if (a.byteOffset % 4 === 0) {
    const u = new Uint32Array(a.buffer, a.byteOffset, n4);
    for (let i = 0; i < n4; i++) if (u[i] !== 0) return true;
  } else {
    for (let i = 0; i < n4 * 4; i++) if (a[i] !== 0) return true;
  }
  for (let i = n4 * 4; i < a.length; i++) if (a[i] !== 0) return true;
  return false;
}

export interface MaskRasterizerOptions {
  /** Approximate memory budget for cached planes (bytes). */
  budget?: number;
  /** Max number of retained incremental brush states. */
  maxBrushStates?: number;
}

export class MaskRasterizer {
  private masks = new Map<string, MaskCache>();
  private versions = new IdentityVersions();
  private clock = 0;
  /** componentId|bitmapKey pairs already requested from ctx.requestAi. */
  private requested = new Set<string>();
  /** bitmapKeys read by the most recent rasterizations (for onChange filtering). */
  readonly usedAiKeys = new Set<string>();
  usesDepth = false;
  usesSource = false;
  private budget: number;
  private maxBrushStates: number;

  constructor(opts: MaskRasterizerOptions = {}) {
    this.budget = opts.budget ?? 160 * 1024 * 1024;
    this.maxBrushStates = opts.maxBrushStates ?? 2;
  }

  /** Forget that an AI bitmap was requested (it arrived or was deleted). */
  resetRequested(bitmapKey?: string): void {
    if (bitmapKey === undefined) this.requested.clear();
    else for (const k of [...this.requested]) if (k.endsWith('|' + bitmapKey)) this.requested.delete(k);
  }

  clear(): void {
    this.masks.clear();
  }

  private componentKey(c: MaskComponent, ctx: MaskRasterContext, w: number, h: number): string {
    const hs = new Hasher().str(c.kind).num(w).num(h);
    switch (c.kind) {
      case 'brush':
        hs.value(c.brush?.strokes ?? []);
        break;
      case 'linear':
        hs.value(c.linear ?? null);
        break;
      case 'radial':
        hs.value(c.radial ?? null);
        break;
      case 'color-range':
        hs.value(c.colorRange ?? null).num(this.versions.of(ctx.source?.data));
        break;
      case 'luminance-range':
        hs.value(c.luminanceRange ?? null).num(this.versions.of(ctx.source?.data));
        break;
      case 'depth-range':
        hs.value(c.depthRange ?? null).num(this.versions.of(ctx.depth ?? null)).str(ctx.depth?.key ?? '');
        break;
      case 'ai': {
        const key = c.ai?.bitmapKey;
        const bmp = key ? ctx.aiStore.get(key) : undefined;
        hs.value(c.ai ?? null).num(this.versions.of(bmp ?? null)).str(bmp?.key ?? '-');
        break;
      }
    }
    return hs.digest();
  }

  private fillComponent(c: MaskComponent, ctx: MaskRasterContext, w: number, h: number, out: Uint8Array): void {
    switch (c.kind) {
      case 'linear':
        if (c.linear) fillLinear(c.linear, w, h, out);
        else out.fill(0);
        return;
      case 'radial':
        if (c.radial) fillRadial(c.radial, w, h, out);
        else out.fill(0);
        return;
      case 'color-range':
        if (c.colorRange && ctx.source) fillColorRange(c.colorRange, getSourceFeatures(ctx.source), w, h, out);
        else out.fill(0);
        return;
      case 'luminance-range':
        if (c.luminanceRange && ctx.source) fillLuminanceRange(c.luminanceRange, getSourceFeatures(ctx.source), w, h, out);
        else out.fill(0);
        return;
      case 'depth-range':
        if (c.depthRange) fillDepthRange(c.depthRange, ctx.depth, w, h, out);
        else out.fill(0);
        return;
      case 'ai': {
        const ai = c.ai;
        const bmp = ai?.bitmapKey ? ctx.aiStore.get(ai.bitmapKey) : undefined;
        if (bmp) {
          fillAi(bmp, w, h, out, ai);
          return;
        }
        out.fill(0);
        if (ai && ctx.requestAi) {
          const rk = c.id + '|' + (ai.bitmapKey ?? '');
          if (!this.requested.has(rk)) {
            this.requested.add(rk);
            ctx.requestAi(c.id, ai.target);
          }
        }
        return;
      }
      case 'brush':
        return; // handled by BrushRaster
    }
  }

  rasterize(mask: Mask, ctx: MaskRasterContext, width: number, height: number): RasterResult {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const t = ++this.clock;
    let mc = this.masks.get(mask.id);
    if (!mc || mc.w !== w || mc.h !== h) {
      mc = { w, h, comps: new Map(), combineSig: '', out: new Uint8Array(w * h), key: '', empty: true, lastUsed: t };
      this.masks.set(mask.id, mc);
    }
    mc.lastUsed = t;
    const full: IRect = { x0: 0, y0: 0, x1: w, y1: h };
    let dirty: IRect | null = null;
    const covs: Uint8Array[] = [];
    const keyHash = new Hasher().num(w).num(h).bool(mask.invert);
    const seen = new Set<string>();
    for (const c of mask.components) {
      seen.add(c.id);
      if (c.kind === 'ai' && c.ai?.bitmapKey) this.usedAiKeys.add(c.ai.bitmapKey);
      if (c.kind === 'depth-range') this.usesDepth = true;
      if (c.kind === 'color-range' || c.kind === 'luminance-range') this.usesSource = true;
      const key = this.componentKey(c, ctx, w, h);
      keyHash.str(key).str(c.mode).bool(c.invert);
      let cc = mc.comps.get(c.id);
      if (cc && cc.key === key) {
        cc.lastUsed = t;
        covs.push(cc.cov);
        continue;
      }
      if (c.kind === 'brush') {
        const brush = cc?.brush ?? new BrushRaster(w, h);
        const d = brush.update(c.brush?.strokes ?? []);
        cc = { key, cov: brush.out, brush, lastUsed: t };
        dirty = unionRect(dirty, d);
      } else {
        const cov = cc && !cc.brush ? cc.cov : new Uint8Array(w * h);
        this.fillComponent(c, ctx, w, h, cov);
        cc = { key, cov, lastUsed: t };
        dirty = full;
      }
      mc.comps.set(c.id, cc);
      covs.push(cc.cov);
    }
    for (const id of [...mc.comps.keys()]) if (!seen.has(id)) mc.comps.delete(id);
    const combineSig = mask.components.map((c) => `${c.id}:${c.mode}:${c.invert ? 1 : 0}`).join(',') + (mask.invert ? '!' : '');
    if (combineSig !== mc.combineSig) dirty = full;
    mc.combineSig = combineSig;
    const key = 'm' + keyHash.digest();
    if (mc.key === key) return { data: mc.out, key, empty: mc.empty, dirty: null };
    if (mask.components.length === 0) {
      mc.out.fill(0);
      dirty = full;
    } else if (dirty) combineRect(mask, covs, mc.out, w, dirty);
    mc.key = key;
    mc.empty = !hasCoverage(mc.out);
    this.evict(mc);
    return { data: mc.out, key, empty: mc.empty, dirty };
  }

  /** Keep memory bounded: drop old brush states, then least-recently used masks. */
  private evict(current: MaskCache): void {
    const brushes: CompCache[] = [];
    let bytes = 0;
    for (const mc of this.masks.values()) {
      bytes += mc.out.byteLength;
      for (const cc of mc.comps.values()) {
        if (cc.brush) {
          brushes.push(cc);
          bytes += cc.brush.bytes;
        } else bytes += cc.cov.byteLength;
      }
    }
    brushes.sort((a, b) => b.lastUsed - a.lastUsed);
    for (let i = this.maxBrushStates; i < brushes.length; i++) {
      const cc = brushes[i]!;
      // Keep the coverage (still valid for its key); only the incremental state goes.
      bytes -= cc.brush!.bytes - cc.cov.byteLength;
      cc.brush = undefined;
    }
    if (bytes <= this.budget) return;
    const order = [...this.masks.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id, mc] of order) {
      if (bytes <= this.budget || mc === current) break;
      let b = mc.out.byteLength;
      for (const cc of mc.comps.values()) b += cc.brush ? cc.brush.bytes : cc.cov.byteLength;
      bytes -= b;
      this.masks.delete(id);
    }
  }
}
