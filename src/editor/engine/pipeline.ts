/**
 * Runs the pass modules in pipeline order (ARCHITECTURE.md "Render pipeline"):
 *   retouch (patches, heal) → PRE → DEVELOP → DETAIL → LOCAL (per mask)
 *   → GEOMETRY → EFFECTS
 * Source-space stages run at the working image's resolution; GEOMETRY and
 * EFFECTS run at the output size for that resolution.
 */
import { resolveLensCorrection } from '../lens';
import type { MaskProvider, PatchProvider } from '../contracts';
import type { EditParams, Mask } from '../types';
import { BlurCache } from './blur';
import { CURVE_LUT_SIZE, curveLutKey, buildDevelopCurveLut, DEVELOP_PASS, LOCAL_PASS, PRE_PASS } from './color';
import { DETAIL_STAGE, EFFECTS_STAGE, GEOMETRY_OVERLAY_PASS, GEOMETRY_PASS, HEAL_PASS, PATCH_COMPOSITE_PASS } from './fx';
import { frameSize, outputSize } from './geometry';
import type { GpuEnv } from './gl/env';
import type { SamplerBinding } from './gl/programs';
import type { Tex } from './gl/textures';
import { MAX_SPOTS_PER_PASS, type PassContext, type PassDef, type PassExtra, type UniformMap } from './pass-types';
import type { WorkingImage } from './sources';

export interface PipelineOptions {
  quality: 'draft' | 'full';
  ignoreCrop: boolean;
  maskProvider: MaskProvider | null;
  patchProvider: PatchProvider | null;
  /** Mask whose coverage should be warped into output space for the overlay. */
  overlayMask: Mask | null;
}

export interface PipelineResult {
  /** Display-referred output (sRGB-encoded float), alpha = image coverage. */
  out: Tex;
  /** Mask overlay coverage in output space (R), or null. */
  overlay: Tex | null;
}

/** Reference long edge for resolution-independent radii (pass-types.ts). */
const REFERENCE_EDGE = 2560;

export class Pipeline {
  readonly blur: BlurCache;
  private lut: { key: string; tex: Tex } | null = null;
  private maskTex = new Map<string, Tex>();
  private patchTex = new Map<string, { data: unknown; tex: Tex }>();
  /** Textures created during the current run (released at the end, except the results). */
  private scratch: Tex[] = [];

  constructor(private env: GpuEnv) {
    this.blur = new BlurCache(env);
  }

  /** Drop per-photo GPU caches (masks, patches). */
  clearPhotoCaches(): void {
    for (const t of this.maskTex.values()) this.env.pool.destroy(t);
    this.maskTex.clear();
    for (const p of this.patchTex.values()) this.env.pool.destroy(p.tex);
    this.patchTex.clear();
  }

  forget(): void {
    this.lut = null;
    this.maskTex.clear();
    this.patchTex.clear();
    this.scratch = [];
    this.blur.forget();
  }

  private baseContext(img: WorkingImage, params: EditParams, opts: PipelineOptions): PassContext {
    const size = opts.ignoreCrop ? frameSize(params, img.width, img.height) : outputSize(params, img.width, img.height);
    return {
      width: img.width,
      height: img.height,
      srcWidth: img.width,
      srcHeight: img.height,
      fullWidth: img.fullWidth,
      fullHeight: img.fullHeight,
      scale: Math.max(img.width, img.height) / REFERENCE_EDGE,
      quality: opts.quality,
      isRaw: img.isRaw,
      meta: img.meta,
      lens: resolveLensCorrection(params.lens, img.meta),
      ignoreCrop: opts.ignoreCrop,
      outRect: { x: 0, y: 0, w: 1, h: 1 },
      outWidth: Math.max(1, Math.round(size.width)),
      outHeight: Math.max(1, Math.round(size.height)),
    };
  }

  /** Run one pass. Returns its output, or uInput when the pass is skipped. */
  private runPass(
    pass: PassDef,
    params: EditParams,
    ctx: PassContext,
    inputs: Record<string, Tex | undefined>,
    extra?: PassExtra,
  ): Tex {
    const input = inputs.uInput;
    if (!input) throw new Error(`KLOUD engine: ${pass.name} has no input`);
    if (pass.skipInDraft && ctx.quality === 'draft') return input;
    if (pass.isIdentity?.(params, ctx, extra)) return input;
    const env = this.env;
    const samplers: Record<string, SamplerBinding | undefined> = { ...inputs };
    for (const b of pass.blurs ?? []) {
      const src = inputs[b.source];
      if (!src) continue;
      const sigma = typeof b.sigma === 'function' ? b.sigma(params, ctx) : b.sigma;
      samplers[b.uniform] = this.blur.blur(src, b.prepass, sigma * ctx.scale, params, ctx, extra);
    }
    const builtins: UniformMap = {
      uResolution: [ctx.width, ctx.height],
      uTexel: [1 / ctx.width, 1 / ctx.height],
      uInputTexel: [1 / input.width, 1 / input.height],
      uScale: ctx.scale,
    };
    const uniforms = { ...builtins, ...pass.uniforms(params, ctx, extra) };
    const out = env.pool.acquire(ctx.width, ctx.height, env.pool.renderFormat(pass.output ?? 'rgba16f'));
    this.scratch.push(out);
    env.runner.draw(env.programs.get(pass.name, pass.fragment), out, samplers, uniforms);
    return out;
  }

  private curveLut(params: EditParams): Tex {
    const key = curveLutKey(params);
    if (this.lut?.key === key) return this.lut.tex;
    if (this.lut) this.env.pool.destroy(this.lut.tex);
    const tex = this.env.pool.create(CURVE_LUT_SIZE, 1, 'rgba32f', buildDevelopCurveLut(params), { filter: 'nearest' });
    this.lut = { key, tex };
    return tex;
  }

  private maskTexture(provider: MaskProvider, mask: Mask, w: number, h: number): Tex | null {
    const bmp = provider.getMask(mask, w, h);
    if (!bmp) return null;
    const key = `${bmp.key}|${bmp.width}x${bmp.height}`;
    let tex = this.maskTex.get(key);
    if (!tex) {
      tex = this.env.pool.create(bmp.width, bmp.height, 'r8', bmp.data);
      this.maskTex.set(key, tex);
      if (this.maskTex.size > 24) {
        const [oldKey, old] = this.maskTex.entries().next().value as [string, Tex];
        this.maskTex.delete(oldKey);
        this.env.pool.destroy(old);
      }
    }
    return tex;
  }

  private patchTexture(provider: PatchProvider, key: string): Tex | null {
    const px = provider.getPatch(key);
    if (!px) return null;
    const hit = this.patchTex.get(key);
    if (hit && hit.data === px.data) return hit.tex;
    if (hit) this.env.pool.destroy(hit.tex);
    const d = px.data;
    const tex =
      d instanceof Float32Array
        ? this.env.pool.create(px.width, px.height, 'rgba32f', d)
        : this.env.pool.create(px.width, px.height, 'rgba8', d instanceof Uint16Array ? to8(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength));
    this.patchTex.set(key, { data: px.data, tex });
    return tex;
  }

  run(img: WorkingImage, params: EditParams, opts: PipelineOptions): PipelineResult {
    const env = this.env;
    this.blur.beginFrame();
    this.scratch = [];
    const ctx = this.baseContext(img, params, opts);
    let cur: Tex = img.tex;

    // 1. Retouch (linear, source space).
    if (opts.patchProvider) {
      params.retouch.removals.forEach((r, i) => {
        const patch = this.patchTexture(opts.patchProvider!, r.patchKey);
        if (!patch) return;
        cur = this.runPass(PATCH_COMPOSITE_PASS, params, ctx, { uInput: cur, uPatch: patch }, { iteration: i });
      });
    }
    const spots = params.retouch.spots;
    for (let i = 0; i < spots.length; i += MAX_SPOTS_PER_PASS) {
      cur = this.runPass(HEAL_PASS, params, ctx, { uInput: cur }, { spots: spots.slice(i, i + MAX_SPOTS_PER_PASS) });
    }

    // 2. PRE (calibration, WB, exposure, lens vignetting) → 3. DEVELOP.
    const pre = this.runPass(PRE_PASS, params, ctx, { uInput: cur });
    cur = this.runPass(DEVELOP_PASS, params, ctx, { uInput: pre, uPre: pre, uCurveLut: this.curveLut(params) });

    // 4. DETAIL (display-referred).
    for (const pass of DETAIL_STAGE) cur = this.runPass(pass, params, ctx, { uInput: cur, uPre: pre });

    // 5. LOCAL adjustments, one pass per visible mask.
    if (opts.maskProvider) {
      for (const mask of params.masks) {
        if (!mask.visible || mask.components.length === 0) continue;
        const m = this.maskTexture(opts.maskProvider, mask, img.width, img.height);
        if (!m) continue;
        cur = this.runPass(LOCAL_PASS, params, ctx, { uInput: cur, uMask: m, uPre: pre }, { mask });
      }
    }

    // 6. GEOMETRY → output space.
    const octx: PassContext = { ...ctx, width: ctx.outWidth, height: ctx.outHeight };
    let out = this.runPass(GEOMETRY_PASS, params, octx, { uInput: cur });
    if (out === cur && (octx.width !== cur.width || octx.height !== cur.height)) {
      // Identity was reported but sizes differ: force the warp.
      out = this.forceGeometry(params, octx, cur);
    }

    let overlay: Tex | null = null;
    if (opts.overlayMask && opts.maskProvider) {
      const m = this.maskTexture(opts.maskProvider, opts.overlayMask, img.width, img.height);
      if (m) {
        overlay = env.pool.acquire(octx.width, octx.height, env.pool.renderFormat('rgba8'));
        const u = { uResolution: [octx.width, octx.height], uTexel: [1 / octx.width, 1 / octx.height], uScale: octx.scale };
        env.runner.draw(env.programs.get(GEOMETRY_OVERLAY_PASS.name, GEOMETRY_OVERLAY_PASS.fragment), overlay, { uInput: cur, uOverlay: m }, {
          ...u,
          ...GEOMETRY_OVERLAY_PASS.uniforms(params, octx),
        });
      }
    }

    // 7. EFFECTS (output space).
    for (const pass of EFFECTS_STAGE) out = this.runPass(pass, params, octx, { uInput: out });

    // Make sure the result is a texture we own (not the working image itself).
    if (out === img.tex) out = this.copy(out);

    for (const t of this.scratch) if (t !== out) env.pool.release(t);
    this.scratch = [];
    this.blur.endFrame();
    return { out, overlay };
  }

  private forceGeometry(params: EditParams, octx: PassContext, src: Tex): Tex {
    const env = this.env;
    const out = env.pool.acquire(octx.width, octx.height, env.pool.renderFormat('rgba16f'));
    this.scratch.push(out);
    env.runner.draw(env.programs.get(GEOMETRY_PASS.name, GEOMETRY_PASS.fragment), out, { uInput: src }, {
      uResolution: [octx.width, octx.height],
      uTexel: [1 / octx.width, 1 / octx.height],
      uInputTexel: [1 / src.width, 1 / src.height],
      uScale: octx.scale,
      ...GEOMETRY_PASS.uniforms(params, octx),
    });
    return out;
  }

  private copy(src: Tex): Tex {
    const env = this.env;
    const out = env.pool.acquire(src.width, src.height, env.pool.renderFormat('rgba16f'));
    env.runner.draw(env.internal('resample'), out, { uSrc: src }, {
      uRatio: [1, 1],
      uTile: [0, 0, src.width, src.height],
      uScaleIn: 1,
      uTransferIn: 0,
      uM0: [1, 0, 0],
      uM1: [0, 1, 0],
      uM2: [0, 0, 1],
      uOpaque: false,
      uUnpremultiply: false,
      uTransferOut: 0,
    });
    return out;
  }
}

function to8(d: Uint16Array): Uint8Array {
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i++) out[i] = d[i] >> 8;
  return out;
}
