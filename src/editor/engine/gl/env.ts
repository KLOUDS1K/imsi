/**
 * The per-context GPU environment shared by every engine part. Rebuilt from
 * scratch after a context loss (all handles die with the context).
 */
import type { GlFeatures } from './context';
import { ProgramCache, Runner, type Program } from './programs';
import { TexturePool } from './textures';
import {
  BLUR_FRAGMENT,
  CLIP_FRAGMENT,
  DOWNSAMPLE_FRAGMENT,
  ENCODE_FRAGMENT,
  FILL_FRAGMENT,
  PRESENT_FRAGMENT,
  RESAMPLE_FRAGMENT,
  RESAMPLE_UINT_FRAGMENT,
} from '../shaders';

const INTERNAL = {
  resample: RESAMPLE_FRAGMENT,
  resampleUint: RESAMPLE_UINT_FRAGMENT,
  downsample: DOWNSAMPLE_FRAGMENT,
  blur: BLUR_FRAGMENT,
  clip: CLIP_FRAGMENT,
  present: PRESENT_FRAGMENT,
  fill: FILL_FRAGMENT,
  encode: ENCODE_FRAGMENT,
} as const;

export type InternalProgram = keyof typeof INTERNAL;

export interface SamplerSet {
  nearest: WebGLSampler;
  linear: WebGLSampler;
  trilinear: WebGLSampler;
}

export class GpuEnv {
  readonly pool: TexturePool;
  readonly programs: ProgramCache;
  readonly runner: Runner;
  readonly samplers: SamplerSet;

  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly features: GlFeatures,
    freeBudget: number,
  ) {
    this.pool = new TexturePool(gl, features, freeBudget);
    this.programs = new ProgramCache(gl);
    this.runner = new Runner(gl, this.pool);
    const mk = (min: number, mag: number): WebGLSampler => {
      const s = gl.createSampler();
      if (!s) throw new Error('KLOUD engine: createSampler failed');
      gl.samplerParameteri(s, gl.TEXTURE_MIN_FILTER, min);
      gl.samplerParameteri(s, gl.TEXTURE_MAG_FILTER, mag);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.samplerParameteri(s, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return s;
    };
    this.samplers = {
      nearest: mk(gl.NEAREST, gl.NEAREST),
      linear: mk(gl.LINEAR, gl.LINEAR),
      trilinear: mk(gl.LINEAR_MIPMAP_LINEAR, gl.LINEAR),
    };
    for (const [name, src] of Object.entries(INTERNAL)) this.programs.prewarm(`engine.${name}`, src);
  }

  internal(name: InternalProgram): Program {
    return this.programs.get(`engine.${name}`, INTERNAL[name]);
  }

  dispose(): void {
    const gl = this.gl;
    this.pool.dispose();
    this.programs.dispose();
    this.runner.dispose();
    gl.deleteSampler(this.samplers.nearest);
    gl.deleteSampler(this.samplers.linear);
    gl.deleteSampler(this.samplers.trilinear);
  }

  /** Context lost: drop every handle without touching GL. */
  forget(): void {
    this.pool.forget();
    this.programs.forget();
  }
}
