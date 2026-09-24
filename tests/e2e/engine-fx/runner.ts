/**
 * Minimal PassDef runner for engine-fx browser tests. Implements the
 * orchestrator side of src/editor/engine/pass-types.ts just enough to run the
 * fx passes in isolation: full-screen triangle with vUv (top-left origin, no
 * flips), float FBOs, uniform introspection, BlurRequests (optional prepass +
 * separable Gaussian with sigma × ctx.scale).
 */
import type { EditParams } from '../../../src/editor/types';
import type { PassContext, PassDef, PassExtra, UniformMap, UniformValue } from '../../../src/editor/engine/pass-types';

export interface Tex {
  tex: WebGLTexture;
  width: number;
  height: number;
}

const VERTEX = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInput;
uniform vec2 uDir;
uniform float uSigma;
void main() {
  ivec2 size = textureSize(uInput, 0);
  ivec2 p = ivec2(floor(vUv * vec2(size)));
  int r = int(ceil(3.0 * uSigma));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -r; i <= r; i++) {
    float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
    ivec2 q = clamp(p + ivec2(uDir) * i, ivec2(0), size - 1);
    acc += w * texelFetch(uInput, q, 0);
    wsum += w;
  }
  outColor = acc / wsum;
}`;

export class MiniRunner {
  readonly gl: WebGL2RenderingContext;
  private programs = new Map<string, WebGLProgram>();
  private vao: WebGLVertexArrayObject;
  private fbo: WebGLFramebuffer;
  /** Render-target internal format (RGBA32F keeps identity checks exact). */
  targetFormat: number;
  passLog: string[] = [];

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas = document.createElement('canvas')) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL2 unavailable');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.targetFormat = gl.RGBA32F;
    this.vao = gl.createVertexArray()!;
    this.fbo = gl.createFramebuffer()!;
  }

  createTexture(width: number, height: number, data: Float32Array | null = null, internal: number = this.gl.RGBA32F): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, gl.RGBA, gl.FLOAT, data);
    this.params();
    return { tex, width, height };
  }

  createTextureU8(width: number, height: number, data: Uint8Array): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.params();
    return { tex, width, height };
  }

  private params() {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  read(t: Tex): Float32Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    const out = new Float32Array(t.width * t.height * 4);
    gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.FLOAT, out);
    return out;
  }

  private program(name: string, fragment: string): WebGLProgram {
    const cached = this.programs.get(name);
    if (cached) return cached;
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        throw new Error(`shader ${name}: ${log}\n${numbered}`);
      }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link ${name}: ${gl.getProgramInfoLog(p)}`);
    this.programs.set(name, p);
    return p;
  }

  /** Draw `fragment` into a new texture, binding samplers and setting uniforms by introspection. */
  draw(name: string, fragment: string, width: number, height: number, samplers: Record<string, Tex | undefined>, uniforms: UniformMap): Tex {
    const gl = this.gl;
    const prog = this.program(name, fragment);
    const out = this.createTexture(width, height, null, this.targetFormat);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.tex, 0);
    gl.viewport(0, 0, width, height);
    gl.useProgram(prog);
    let unit = 0;
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i)!;
      const base = info.name.replace(/\[0\]$/, '');
      const loc = gl.getUniformLocation(prog, info.name);
      if (!loc) continue;
      if (info.type === gl.SAMPLER_2D) {
        const t = samplers[base];
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t ? t.tex : null);
        gl.uniform1i(loc, unit++);
        continue;
      }
      const v = uniforms[base];
      if (v === undefined) continue;
      this.setUniform(info.type, loc, v);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return out;
  }

  private setUniform(type: number, loc: WebGLUniformLocation, v: UniformValue) {
    const gl = this.gl;
    const arr = typeof v === 'number' || typeof v === 'boolean' ? [Number(v)] : Array.from(v as ArrayLike<number>);
    switch (type) {
      case gl.FLOAT: gl.uniform1fv(loc, arr); break;
      case gl.FLOAT_VEC2: gl.uniform2fv(loc, arr); break;
      case gl.FLOAT_VEC3: gl.uniform3fv(loc, arr); break;
      case gl.FLOAT_VEC4: gl.uniform4fv(loc, arr); break;
      case gl.INT: case gl.BOOL: gl.uniform1iv(loc, arr.map(Math.round)); break;
      case gl.UNSIGNED_INT: gl.uniform1uiv(loc, arr.map(Math.round)); break;
      case gl.FLOAT_MAT3: gl.uniformMatrix3fv(loc, false, arr); break;
      default: throw new Error(`unsupported uniform type ${type}`);
    }
  }

  gaussian(src: Tex, sigmaPx: number): Tex {
    if (!(sigmaPx > 0.2)) return src;
    const h = this.draw('blur', BLUR_FRAG, src.width, src.height, { uInput: src }, { uDir: [1, 0], uSigma: sigmaPx });
    return this.draw('blur', BLUR_FRAG, src.width, src.height, { uInput: h }, { uDir: [0, 1], uSigma: sigmaPx });
  }

  /** Run one pass. `force` ignores isIdentity/skipInDraft (to check shader-level identity). */
  run(pass: PassDef, inputs: Record<string, Tex>, params: EditParams, ctx: PassContext, extra?: PassExtra, force = false): Tex {
    const input = inputs.uInput;
    if (!force) {
      if (pass.skipInDraft && ctx.quality === 'draft') return input;
      if (pass.isIdentity?.(params, ctx, extra)) return input;
    }
    this.passLog.push(pass.name);
    const samplers: Record<string, Tex | undefined> = {};
    for (const name of pass.inputs) samplers[name] = inputs[name];
    for (const b of pass.blurs ?? []) {
      let src = inputs[b.source];
      if (b.prepass) src = this.run(b.prepass, { uInput: src }, params, { ...ctx, width: src.width, height: src.height }, extra, true);
      const sigma = typeof b.sigma === 'function' ? b.sigma(params, ctx) : b.sigma;
      samplers[b.uniform] = this.gaussian(src, sigma * ctx.scale);
    }
    const uniforms: UniformMap = {
      uResolution: [ctx.width, ctx.height],
      uTexel: [1 / ctx.width, 1 / ctx.height],
      uInputTexel: input ? [1 / input.width, 1 / input.height] : [0, 0],
      uScale: ctx.scale,
      ...pass.uniforms(params, ctx, extra),
    };
    return this.draw(pass.name, pass.fragment, ctx.width, ctx.height, samplers, uniforms);
  }

  runStage(stage: PassDef[], input: Tex, params: EditParams, ctx: PassContext, force = false): Tex {
    let cur = input;
    for (const p of stage) cur = this.run(p, { uInput: cur }, params, { ...ctx, width: cur.width, height: cur.height }, undefined, force);
    return cur;
  }
}
