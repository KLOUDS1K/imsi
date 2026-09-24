/**
 * Program cache, uniform introspection and the draw call used by every pass.
 *
 * - One program per PassDef.name (compiled once; with KHR_parallel_shader_compile
 *   `prewarm` starts compiles in the background and `get` only blocks if the
 *   driver has not finished yet).
 * - Uniforms are discovered with getActiveUniform and set by their GLSL type,
 *   so passes return plain numbers / arrays (see pass-types.ts). Matrices are
 *   uploaded column-major (GL convention, transpose = false).
 * - The shared vertex shader draws one full-screen triangle and provides vUv
 *   with (0,0) = texture row 0 = image TOP (no flip; only present flips).
 */
import type { UniformMap, UniformValue } from '../pass-types';
import type { Tex, TexturePool } from './textures';
import { touch } from './textures';

export const VERTEX_SHADER = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  // Triangle (0,0) (2,0) (0,2) in uv covers the whole viewport. Framebuffer
  // row 0 (window y = 0) gets vUv.y = 0, i.e. the top row of the image.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export interface UniformSlot {
  name: string;
  loc: WebGLUniformLocation;
  type: number;
  size: number;
  /** Scratch buffer (components × size) reused every frame. */
  buf: Float32Array | Int32Array | Uint32Array | null;
}

export interface SamplerSlot {
  name: string;
  loc: WebGLUniformLocation;
  unit: number;
  type: number;
}

export interface Program {
  name: string;
  program: WebGLProgram;
  uniforms: Map<string, UniformSlot>;
  samplers: SamplerSlot[];
}

interface Pending {
  name: string;
  program: WebGLProgram;
  vs: WebGLShader;
  fs: WebGLShader;
  fragment: string;
}

export class ShaderError extends Error {}

function numbered(src: string): string {
  return src
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4)}: ${l}`)
    .join('\n');
}

export class ProgramCache {
  private ready = new Map<string, Program>();
  private pending = new Map<string, Pending>();

  constructor(private gl: WebGL2RenderingContext) {}

  private compile(type: number, src: string): WebGLShader {
    const gl = this.gl;
    const s = gl.createShader(type);
    if (!s) throw new ShaderError('KLOUD engine: createShader failed (context lost?)');
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  /** Start compiling (non-blocking with KHR_parallel_shader_compile). */
  prewarm(name: string, fragment: string): void {
    if (this.ready.has(name) || this.pending.has(name)) return;
    const gl = this.gl;
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = this.compile(gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram();
    if (!program) throw new ShaderError('KLOUD engine: createProgram failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    this.pending.set(name, { name, program, vs, fs, fragment });
  }

  get(name: string, fragment: string): Program {
    const hit = this.ready.get(name);
    if (hit) return hit;
    if (!this.pending.has(name)) this.prewarm(name, fragment);
    const p = this.pending.get(name)!;
    this.pending.delete(name);
    const gl = this.gl;
    if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) {
      const fsLog = gl.getShaderInfoLog(p.fs) ?? '';
      const vsLog = gl.getShaderInfoLog(p.vs) ?? '';
      const linkLog = gl.getProgramInfoLog(p.program) ?? '';
      gl.deleteProgram(p.program);
      gl.deleteShader(p.vs);
      gl.deleteShader(p.fs);
      throw new ShaderError(`KLOUD engine: program "${name}" failed\n${fsLog}${vsLog}${linkLog}\n${numbered(p.fragment)}`);
    }
    gl.detachShader(p.program, p.vs);
    gl.detachShader(p.program, p.fs);
    gl.deleteShader(p.vs);
    gl.deleteShader(p.fs);
    const prog = this.introspect(name, p.program);
    this.ready.set(name, prog);
    return prog;
  }

  private introspect(name: string, program: WebGLProgram): Program {
    const gl = this.gl;
    const uniforms = new Map<string, UniformSlot>();
    const samplers: SamplerSlot[] = [];
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const loc = gl.getUniformLocation(program, info.name);
      if (!loc) continue; // uniform-block members
      const base = info.name.replace(/\[0\]$/, '');
      if (isSamplerType(gl, info.type)) {
        samplers.push({ name: base, loc, unit: samplers.length, type: info.type });
        continue;
      }
      uniforms.set(base, { name: base, loc, type: info.type, size: info.size, buf: scratchFor(gl, info.type, info.size) });
    }
    // Sampler units never change for a program: assign them once.
    gl.useProgram(program);
    for (const s of samplers) gl.uniform1i(s.loc, s.unit);
    return { name, program, uniforms, samplers };
  }

  dispose(): void {
    const gl = this.gl;
    for (const p of this.ready.values()) gl.deleteProgram(p.program);
    for (const p of this.pending.values()) {
      gl.deleteProgram(p.program);
      gl.deleteShader(p.vs);
      gl.deleteShader(p.fs);
    }
    this.ready.clear();
    this.pending.clear();
  }

  /** Context lost: forget handles without GL calls. */
  forget(): void {
    this.ready.clear();
    this.pending.clear();
  }
}

function isSamplerType(gl: WebGL2RenderingContext, t: number): boolean {
  return (
    t === gl.SAMPLER_2D ||
    t === gl.INT_SAMPLER_2D ||
    t === gl.UNSIGNED_INT_SAMPLER_2D ||
    t === gl.SAMPLER_3D ||
    t === gl.SAMPLER_2D_ARRAY ||
    t === gl.SAMPLER_CUBE ||
    t === gl.SAMPLER_2D_SHADOW
  );
}

/** Component count and scalar kind of a GLSL uniform type. */
function typeShape(gl: WebGL2RenderingContext, t: number): { n: number; kind: 'f' | 'i' | 'u' } | null {
  switch (t) {
    case gl.FLOAT:
      return { n: 1, kind: 'f' };
    case gl.FLOAT_VEC2:
      return { n: 2, kind: 'f' };
    case gl.FLOAT_VEC3:
      return { n: 3, kind: 'f' };
    case gl.FLOAT_VEC4:
    case gl.FLOAT_MAT2:
      return { n: 4, kind: 'f' };
    case gl.FLOAT_MAT3:
      return { n: 9, kind: 'f' };
    case gl.FLOAT_MAT4:
      return { n: 16, kind: 'f' };
    case gl.FLOAT_MAT2x3:
    case gl.FLOAT_MAT3x2:
      return { n: 6, kind: 'f' };
    case gl.FLOAT_MAT2x4:
    case gl.FLOAT_MAT4x2:
      return { n: 8, kind: 'f' };
    case gl.FLOAT_MAT3x4:
    case gl.FLOAT_MAT4x3:
      return { n: 12, kind: 'f' };
    case gl.INT:
    case gl.BOOL:
      return { n: 1, kind: 'i' };
    case gl.INT_VEC2:
    case gl.BOOL_VEC2:
      return { n: 2, kind: 'i' };
    case gl.INT_VEC3:
    case gl.BOOL_VEC3:
      return { n: 3, kind: 'i' };
    case gl.INT_VEC4:
    case gl.BOOL_VEC4:
      return { n: 4, kind: 'i' };
    case gl.UNSIGNED_INT:
      return { n: 1, kind: 'u' };
    case gl.UNSIGNED_INT_VEC2:
      return { n: 2, kind: 'u' };
    case gl.UNSIGNED_INT_VEC3:
      return { n: 3, kind: 'u' };
    case gl.UNSIGNED_INT_VEC4:
      return { n: 4, kind: 'u' };
    default:
      return null;
  }
}

function scratchFor(gl: WebGL2RenderingContext, type: number, size: number): UniformSlot['buf'] {
  const s = typeShape(gl, type);
  if (!s) return null;
  const len = s.n * Math.max(1, size);
  return s.kind === 'f' ? new Float32Array(len) : s.kind === 'i' ? new Int32Array(len) : new Uint32Array(len);
}

/** Set one uniform from a plain value, converting by the declared GLSL type. */
export function applyUniform(gl: WebGL2RenderingContext, u: UniformSlot, v: UniformValue): void {
  const buf = u.buf;
  if (!buf) return;
  const shape = typeShape(gl, u.type)!;
  // Fill the scratch buffer (booleans → 0/1, ints rounded) without allocating.
  let count: number;
  if (typeof v === 'number' || typeof v === 'boolean') {
    buf[0] = shape.kind === 'f' ? Number(v) : Math.round(Number(v));
    count = 1;
  } else {
    count = Math.min(v.length, buf.length);
    if (shape.kind === 'f') for (let i = 0; i < count; i++) buf[i] = v[i];
    else for (let i = 0; i < count; i++) buf[i] = Math.round(v[i]);
  }
  // Whole elements only (WebGL rejects partial vectors).
  const elems = Math.max(1, Math.floor(count / shape.n));
  const data = buf.subarray(0, elems * shape.n);
  if (count < shape.n) data.fill(0, count);
  const loc = u.loc;
  switch (u.type) {
    case gl.FLOAT:
      return gl.uniform1fv(loc, data as Float32Array);
    case gl.FLOAT_VEC2:
      return gl.uniform2fv(loc, data as Float32Array);
    case gl.FLOAT_VEC3:
      return gl.uniform3fv(loc, data as Float32Array);
    case gl.FLOAT_VEC4:
      return gl.uniform4fv(loc, data as Float32Array);
    case gl.FLOAT_MAT2:
      return gl.uniformMatrix2fv(loc, false, data as Float32Array);
    case gl.FLOAT_MAT3:
      return gl.uniformMatrix3fv(loc, false, data as Float32Array);
    case gl.FLOAT_MAT4:
      return gl.uniformMatrix4fv(loc, false, data as Float32Array);
    case gl.FLOAT_MAT2x3:
      return gl.uniformMatrix2x3fv(loc, false, data as Float32Array);
    case gl.FLOAT_MAT3x2:
      return gl.uniformMatrix3x2fv(loc, false, data as Float32Array);
    case gl.FLOAT_MAT2x4:
      return gl.uniformMatrix2x4fv(loc, false, data as Float32Array);
    case gl.FLOAT_MAT4x2:
      return gl.uniformMatrix4x2fv(loc, false, data as Float32Array);
    case gl.FLOAT_MAT3x4:
      return gl.uniformMatrix3x4fv(loc, false, data as Float32Array);
    case gl.FLOAT_MAT4x3:
      return gl.uniformMatrix4x3fv(loc, false, data as Float32Array);
    case gl.INT:
    case gl.BOOL:
      return gl.uniform1iv(loc, data as Int32Array);
    case gl.INT_VEC2:
    case gl.BOOL_VEC2:
      return gl.uniform2iv(loc, data as Int32Array);
    case gl.INT_VEC3:
    case gl.BOOL_VEC3:
      return gl.uniform3iv(loc, data as Int32Array);
    case gl.INT_VEC4:
    case gl.BOOL_VEC4:
      return gl.uniform4iv(loc, data as Int32Array);
    case gl.UNSIGNED_INT:
      return gl.uniform1uiv(loc, data as Uint32Array);
    case gl.UNSIGNED_INT_VEC2:
      return gl.uniform2uiv(loc, data as Uint32Array);
    case gl.UNSIGNED_INT_VEC3:
      return gl.uniform3uiv(loc, data as Uint32Array);
    case gl.UNSIGNED_INT_VEC4:
      return gl.uniform4uiv(loc, data as Uint32Array);
  }
}

/** A texture binding, optionally with a sampler object that overrides the texture's own filtering. */
export type SamplerBinding = Tex | { tex: Tex; sampler: WebGLSampler | null };

export interface DrawOptions {
  /** Viewport in target pixels (x, y from the target's row 0 = image top). Default: whole target. */
  viewport?: [number, number, number, number];
  /** Scissor rectangle in target pixels (same convention as viewport). */
  scissor?: [number, number, number, number];
  /** Additive blending (ONE, ONE) for accumulation. */
  blendAdd?: boolean;
  /** Canvas height when drawing to the default framebuffer (flips viewport/scissor rows). */
  canvasHeight?: number;
}

/**
 * Issues full-screen-triangle draws. Unbound samplers get a 1×1 dummy of the
 * right kind (float / int / uint), so a pass may leave optional inputs unset.
 */
export class Runner {
  private vao: WebGLVertexArrayObject;
  private dummies = new Map<number, WebGLTexture>();
  private boundSamplerUnits = new Set<number>();
  /** Pass name → error list, filled in debug mode. */
  debug = false;
  errors: string[] = [];

  constructor(
    private gl: WebGL2RenderingContext,
    private pool: TexturePool,
  ) {
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('KLOUD engine: createVertexArray failed');
    this.vao = vao;
  }

  private dummy(type: number): WebGLTexture {
    const gl = this.gl;
    const hit = this.dummies.get(type);
    if (hit) return hit;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (type === gl.UNSIGNED_INT_SAMPLER_2D) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, 1, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(4));
    } else if (type === gl.INT_SAMPLER_2D) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16I, 1, 1, 0, gl.RGBA_INTEGER, gl.SHORT, new Int16Array(4));
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.dummies.set(type, tex);
    return tex;
  }

  /**
   * Draw `prog` into `target` (null = the canvas). Built-in uniforms are the
   * caller's job (they differ per pass); `uniforms` may contain names the
   * program does not declare (ignored).
   */
  draw(prog: Program, target: Tex | null, samplers: Record<string, SamplerBinding | undefined>, uniforms: UniformMap, opts: DrawOptions = {}): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? this.pool.fbo(target) : null);
    const vp = opts.viewport ?? [0, 0, target ? target.width : gl.drawingBufferWidth, target ? target.height : gl.drawingBufferHeight];
    const flip = (r: [number, number, number, number]): [number, number, number, number] =>
      target || opts.canvasHeight === undefined ? r : [r[0], opts.canvasHeight - r[1] - r[3], r[2], r[3]];
    const v = flip(vp);
    gl.viewport(v[0], v[1], v[2], v[3]);
    if (opts.scissor) {
      const s = flip(opts.scissor);
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(s[0], s[1], Math.max(0, s[2]), Math.max(0, s[3]));
    } else gl.disable(gl.SCISSOR_TEST);
    if (opts.blendAdd) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else gl.disable(gl.BLEND);

    gl.useProgram(prog.program);
    for (const s of prog.samplers) {
      const b = samplers[s.name];
      gl.activeTexture(gl.TEXTURE0 + s.unit);
      let sampler: WebGLSampler | null = null;
      if (!b) gl.bindTexture(gl.TEXTURE_2D, this.dummy(s.type));
      else if ('sampler' in b) {
        gl.bindTexture(gl.TEXTURE_2D, b.tex.tex);
        sampler = b.sampler;
        if (this.debug && target && b.tex === target) this.errors.push(`${prog.name}: feedback loop on ${s.name}`);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, b.tex);
        if (this.debug && target && b === target) this.errors.push(`${prog.name}: feedback loop on ${s.name}`);
      }
      if (sampler || this.boundSamplerUnits.has(s.unit)) {
        gl.bindSampler(s.unit, sampler);
        if (sampler) this.boundSamplerUnits.add(s.unit);
        else this.boundSamplerUnits.delete(s.unit);
      }
    }
    for (const [name, value] of Object.entries(uniforms)) {
      const u = prog.uniforms.get(name);
      if (u && value !== undefined) applyUniform(gl, u, value);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    if (target) touch(target);
    if (this.debug) this.check(prog.name, target);
  }

  check(label: string, target?: Tex | null): void {
    const gl = this.gl;
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.pool.fbo(target));
      const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (st !== gl.FRAMEBUFFER_COMPLETE) this.errors.push(`${label}: framebuffer incomplete 0x${st.toString(16)} (${target.format})`);
    }
    let e = gl.getError();
    while (e !== gl.NO_ERROR && e !== gl.CONTEXT_LOST_WEBGL) {
      this.errors.push(`${label}: GL error 0x${e.toString(16)}`);
      e = gl.getError();
    }
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    for (const t of this.dummies.values()) gl.deleteTexture(t);
    this.dummies.clear();
  }
}
