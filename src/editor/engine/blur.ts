/**
 * The generic blur mechanism behind PassDef.blurs (BlurRequest).
 *
 * blur(src, prepass, σ):
 *   1. optional prepass on src (its sampler is 'uInput'),
 *   2. for σ > ~2.5 px a chain of 2× bilinear reductions (each an exact 2×2
 *      box for even sizes; normalized coordinates are preserved for odd ones),
 *   3. a separable Gaussian at the reduced resolution whose σ is corrected for
 *      the variance the reductions and the consumer's bilinear upsampling
 *      already contribute, so the effective radius matches σ.
 * The result stays at the reduced size: consumers read it with texture(…, vUv).
 *
 * Results are cached by the exact content of the source (uid:gen, see
 * gl/textures.ts), the prepass (name + its uniforms) and σ. Entries survive
 * across frames while they keep being used, so e.g. dragging Contrast reuses
 * the guide blurs of an unchanged PRE output; everything not used in a frame
 * is released at endFrame().
 */
import type { EditParams } from '../types';
import type { PassContext, PassDef, PassExtra, UniformMap } from './pass-types';
import type { GpuEnv } from './gl/env';
import { contentKey, type Tex } from './gl/textures';

/** Reduced-resolution sigma above which the image is halved again. */
const MAX_LOW_SIGMA = 2.5;
/** Do not reduce below this many pixels on the short side. */
const MIN_REDUCED = 8;

export interface BlurPlan {
  /** Number of 2× reductions. */
  levels: number;
  /** Gaussian sigma to apply at the reduced resolution (in reduced px). */
  sigma: number;
  radius: number;
}

/**
 * Pick the reduction level and residual sigma for a Gaussian of `sigma` px
 * on a w×h image. Variance bookkeeping (in full-res px²):
 *   each 2× box reduction k (k = 0..L-1) adds 0.25·4^k,
 *   the consumer's bilinear upsample adds ≈ 4^L / 6 (tent of one reduced px),
 * and the residual Gaussian supplies the rest.
 */
export function planBlur(sigma: number, w: number, h: number): BlurPlan {
  let levels = 0;
  while (sigma / 2 ** levels > MAX_LOW_SIGMA && Math.min(w, h) / 2 ** (levels + 1) >= MIN_REDUCED) levels++;
  const f = 2 ** levels;
  const boxVar = levels > 0 ? (0.25 * (f * f - 1)) / 3 : 0;
  const upVar = levels > 0 ? (f * f) / 6 : 0;
  const rest = Math.max(sigma * sigma - boxVar - upVar, 0.25 * f * f);
  const low = Math.sqrt(rest) / f;
  return { levels, sigma: low, radius: Math.max(1, Math.ceil(3 * low)) };
}

interface Entry {
  tex: Tex;
  used: number;
  /** Owned by this cache (false when the entry aliases its source). */
  owned: boolean;
}

export class BlurCache {
  private entries = new Map<string, Entry>();
  private frame = 0;
  /** Blurs computed (not served from cache) in the current frame. */
  computed = 0;

  constructor(private env: GpuEnv) {}

  beginFrame(): void {
    this.frame++;
    this.computed = 0;
  }

  /** Release everything not used during the current frame. */
  endFrame(): void {
    for (const [k, e] of this.entries) {
      if (e.used === this.frame) continue;
      if (e.owned) this.env.pool.release(e.tex);
      this.entries.delete(k);
    }
  }

  clear(): void {
    for (const e of this.entries.values()) if (e.owned) this.env.pool.release(e.tex);
    this.entries.clear();
  }

  forget(): void {
    this.entries.clear();
  }

  private hit(key: string): Tex | null {
    const e = this.entries.get(key);
    if (!e) return null;
    e.used = this.frame;
    return e.tex;
  }

  private put(key: string, tex: Tex, owned = true): Tex {
    this.entries.set(key, { tex, used: this.frame, owned });
    return tex;
  }

  /** Output of `prepass` applied to `src` (or src itself), cached by content. */
  prepassed(src: Tex, prepass: PassDef | undefined, params: EditParams, ctx: PassContext, extra: PassExtra | undefined): { tex: Tex; key: string } {
    if (!prepass) return { tex: src, key: contentKey(src) };
    const uniforms = prepass.uniforms(params, { ...ctx, width: src.width, height: src.height }, extra);
    const key = `p|${contentKey(src)}|${prepass.name}|${uniformKey(uniforms)}`;
    const cached = this.hit(key);
    if (cached) return { tex: cached, key };
    const env = this.env;
    const out = env.pool.acquire(src.width, src.height, env.pool.renderFormat(prepass.output ?? 'rgba16f'));
    const prog = env.programs.get(prepass.name, prepass.fragment);
    const builtins: UniformMap = {
      uResolution: [src.width, src.height],
      uTexel: [1 / src.width, 1 / src.height],
      uInputTexel: [1 / src.width, 1 / src.height],
      uScale: ctx.scale,
    };
    env.runner.draw(prog, out, { uInput: src }, { ...builtins, ...uniforms });
    return { tex: this.put(key, out), key };
  }

  /** Gaussian blur (σ in actual px of `src`) of the prepassed source. */
  blur(src: Tex, prepass: PassDef | undefined, sigmaPx: number, params: EditParams, ctx: PassContext, extra?: PassExtra): Tex {
    const base = this.prepassed(src, prepass, params, ctx, extra);
    if (!(sigmaPx >= 0.2)) return base.tex;
    const key = `b|${base.key}|${sigmaPx.toFixed(3)}`;
    const cached = this.hit(key);
    if (cached) return cached;
    const plan = planBlur(sigmaPx, base.tex.width, base.tex.height);
    let cur = base.tex;
    for (let l = 1; l <= plan.levels; l++) cur = this.reduce(base.key, cur, l);
    this.computed++;
    return this.put(key, this.gauss(cur, plan.sigma, plan.radius));
  }

  private reduce(baseKey: string, src: Tex, level: number): Tex {
    const key = `d|${baseKey}|${level}`;
    const cached = this.hit(key);
    if (cached) return cached;
    const env = this.env;
    const out = env.pool.acquire(Math.max(1, Math.ceil(src.width / 2)), Math.max(1, Math.ceil(src.height / 2)), src.format);
    env.runner.draw(env.internal('downsample'), out, { uSrc: { tex: src, sampler: env.samplers.linear } }, {});
    return this.put(key, out);
  }

  private gauss(src: Tex, sigma: number, radius: number): Tex {
    const env = this.env;
    const prog = env.internal('blur');
    const tmp = env.pool.acquire(src.width, src.height, src.format);
    env.runner.draw(prog, tmp, { uSrc: src }, { uDir: [1, 0], uSigma: sigma, uRadius: radius });
    const out = env.pool.acquire(src.width, src.height, src.format);
    env.runner.draw(prog, out, { uSrc: tmp }, { uDir: [0, 1], uSigma: sigma, uRadius: radius });
    env.pool.release(tmp);
    return out;
  }
}

/** Compact, deterministic serialization of a uniform map (cache keys). */
export function uniformKey(u: UniformMap): string {
  let s = '';
  for (const k of Object.keys(u)) {
    const v = u[k];
    s += k + '=' + (typeof v === 'object' && v !== null ? Array.prototype.join.call(v, ',') : String(v)) + ';';
  }
  return s;
}
