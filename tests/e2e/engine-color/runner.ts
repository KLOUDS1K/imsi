/**
 * Minimal, self-contained WebGL2 runner for the engine-color PassDefs
 * (test-only; engine-core owns the real orchestrator).
 *
 * Implements the pass-types.ts contract: full-screen triangle with vUv
 * (0,0 = top-left, no flips), uniform introspection, built-in uniforms,
 * sampler binding in `inputs` order, blur requests (optional prepass +
 * separable Gaussian with sigma × ctx.scale, shared by (source, prepass, sigma)).
 */
import type { BlurRequest, PassContext, PassDef, PassExtra, UniformValue } from '../../../src/editor/engine/pass-types';
import type { EditParams } from '../../../src/editor/types';

export type Precision = '16f' | '32f';

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

const BLUR_FRAGMENT = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uInput;
uniform vec2 uDir;      // texel step along the blur axis
uniform float uSigma;   // pixels
void main() {
  if (uSigma < 0.2) { outColor = texture(uInput, vUv); return; }
  int radius = int(ceil(uSigma * 3.0));
  float inv = 1.0 / (2.0 * uSigma * uSigma);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j <= 2 * radius; j++) {
    int i = j - radius;
    float w = exp(-float(i * i) * inv);
    acc += texture(uInput, vUv + uDir * float(i)) * w;
    wsum += w;
  }
  outColor = acc / wsum;
}`;

export class MiniRunner {
  readonly gl: WebGL2RenderingContext;
  private readonly programs = new Map<string, WebGLProgram>();
  private readonly vao: WebGLVertexArrayObject;
  private readonly fbo: WebGLFramebuffer;
  private readonly internalFormat: number;
  private readonly filter: number;
  private readonly temps: Tex[] = [];

  constructor(canvas: HTMLCanvasElement, readonly precision: Precision = '16f') {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 unavailable');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
    const floatLinear = !!gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.internalFormat = precision === '16f' ? gl.RGBA16F : gl.RGBA32F;
    this.filter = precision === '16f' || floatLinear ? gl.LINEAR : gl.NEAREST;
    this.vao = gl.createVertexArray()!;
    this.fbo = gl.createFramebuffer()!;
  }

  /** Upload RGBA float data (row 0 = top) as a float texture. */
  upload(data: Float32Array, width: number, height: number, opts: { nearest?: boolean; fullFloat?: boolean } = {}): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const fmt = opts.fullFloat ? gl.RGBA32F : this.internalFormat;
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, width, height, 0, gl.RGBA, gl.FLOAT, data);
    const filter = opts.nearest || (fmt === gl.RGBA32F && this.filter === gl.NEAREST) ? gl.NEAREST : this.filter;
    this.params(filter);
    return { tex, width, height };
  }

  private params(filter: number) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  target(width: number, height: number): Tex {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.internalFormat, width, height);
    this.params(this.filter);
    const t = { tex, width, height };
    this.temps.push(t);
    return t;
  }

  program(name: string, fragment: string): WebGLProgram {
    const cached = this.programs.get(name);
    if (cached) return cached;
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        const numbered = src
          .split('\n')
          .map((l, i) => `${i + 1}: ${l}`)
          .join('\n');
        throw new Error(`${name}: shader compile failed: ${log}\n${numbered}`);
      }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name}: link failed: ${gl.getProgramInfoLog(p)}`);
    this.programs.set(name, p);
    return p;
  }

  private setUniform(p: WebGLProgram, info: WebGLActiveInfo, value: UniformValue) {
    const gl = this.gl;
    const loc = gl.getUniformLocation(p, info.name);
    if (!loc) return;
    const arr = typeof value === 'number' || typeof value === 'boolean' ? null : Array.from(value as ArrayLike<number>);
    const num = typeof value === 'boolean' ? (value ? 1 : 0) : typeof value === 'number' ? value : 0;
    switch (info.type) {
      case gl.FLOAT:
        if (arr) gl.uniform1fv(loc, arr);
        else gl.uniform1f(loc, num);
        break;
      case gl.FLOAT_VEC2:
        gl.uniform2fv(loc, arr!);
        break;
      case gl.FLOAT_VEC3:
        gl.uniform3fv(loc, arr!);
        break;
      case gl.FLOAT_VEC4:
        gl.uniform4fv(loc, arr!);
        break;
      case gl.FLOAT_MAT3:
        gl.uniformMatrix3fv(loc, false, arr!);
        break;
      case gl.BOOL:
      case gl.INT:
        gl.uniform1i(loc, arr ? arr[0] : num);
        break;
      default:
        throw new Error(`unsupported uniform type for ${info.name}`);
    }
  }

  /** Draw `fragment` into `out` with samplers bound by name. */
  draw(
    name: string,
    fragment: string,
    samplers: [string, Tex][],
    values: Record<string, UniformValue>,
    out: Tex,
    scale: number,
  ) {
    const gl = this.gl;
    const p = this.program(name, fragment);
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.tex, 0);
    gl.viewport(0, 0, out.width, out.height);
    const input = samplers.find(([n]) => n === 'uInput')?.[1] ?? samplers[0]?.[1];
    const builtins: Record<string, UniformValue> = {
      uResolution: [out.width, out.height],
      uTexel: [1 / out.width, 1 / out.height],
      uInputTexel: input ? [1 / input.width, 1 / input.height] : [1 / out.width, 1 / out.height],
      uScale: scale,
    };
    const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    const declared = new Set<string>();
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(p, i)!;
      const base = info.name.replace(/\[0\]$/, '');
      declared.add(base);
      if (info.type === gl.SAMPLER_2D) continue;
      const v = values[base] ?? builtins[base];
      if (v === undefined) throw new Error(`${name}: uniform ${base} not provided`);
      this.setUniform(p, info, v);
    }
    samplers.forEach(([uname, t], unit) => {
      const loc = gl.getUniformLocation(p, uname);
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      if (loc) gl.uniform1i(loc, unit);
    });
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error(`${name}: GL error ${err}`);
  }

  private blur(src: Tex, sigmaPx: number, scale: number): Tex {
    const tmp = this.target(src.width, src.height);
    const out = this.target(src.width, src.height);
    this.draw('blur', BLUR_FRAGMENT, [['uInput', src]], { uDir: [1 / src.width, 0], uSigma: sigmaPx }, tmp, scale);
    this.draw('blur', BLUR_FRAGMENT, [['uInput', tmp]], { uDir: [0, 1 / src.height], uSigma: sigmaPx }, out, scale);
    return out;
  }

  /** Run one PassDef. `textures` maps its input names (uInput, uCurveLut, uMask, …). */
  runPass(pass: PassDef, textures: Record<string, Tex>, params: EditParams, ctx: PassContext, extra?: PassExtra): Tex {
    const out = this.target(ctx.width, ctx.height);
    const samplers: [string, Tex][] = pass.inputs.map((n) => {
      const t = textures[n];
      if (!t) throw new Error(`${pass.name}: missing input ${n}`);
      return [n, t];
    });
    const shared = new Map<string, Tex>();
    for (const req of pass.blurs ?? []) samplers.push([req.uniform, this.resolveBlur(req, textures, params, ctx, shared)]);
    this.draw(pass.name, pass.fragment, samplers, pass.uniforms(params, ctx, extra), out, ctx.scale);
    return out;
  }

  private resolveBlur(req: BlurRequest, textures: Record<string, Tex>, params: EditParams, ctx: PassContext, shared: Map<string, Tex>): Tex {
    const sigma = typeof req.sigma === 'function' ? req.sigma(params, ctx) : req.sigma;
    const key = `${req.source}|${req.prepass?.name ?? ''}|${sigma}`;
    const hit = shared.get(key);
    if (hit) return hit;
    let src = textures[req.source];
    if (!src) throw new Error(`blur source ${req.source} missing`);
    if (req.prepass) {
      const preKey = `${req.source}|${req.prepass.name}|pre`;
      let pre = shared.get(preKey);
      if (!pre) {
        pre = this.target(src.width, src.height);
        this.draw(req.prepass.name, req.prepass.fragment, [['uInput', src]], req.prepass.uniforms(params, ctx), pre, ctx.scale);
        shared.set(preKey, pre);
      }
      src = pre;
    }
    const out = this.blur(src, sigma * ctx.scale, ctx.scale);
    shared.set(key, out);
    return out;
  }

  read(t: Tex): Float32Array {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    const out = new Float32Array(t.width * t.height * 4);
    gl.readPixels(0, 0, t.width, t.height, gl.RGBA, gl.FLOAT, out);
    return out;
  }

  /** Free intermediate targets from previous runs. */
  releaseTemps() {
    for (const t of this.temps.splice(0)) this.gl.deleteTexture(t.tex);
  }
}
