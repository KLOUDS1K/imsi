/**
 * GPU textures and the render-target pool.
 *
 * Every texture the engine allocates goes through `TexturePool`, which keeps
 * byte accounting and reuses released render targets by (width, height,
 * format). A `Tex` carries a content generation number (`gen`) bumped on every
 * render into it, so caches can key on "this exact content" (`uid:gen`)
 * without hashing pixels.
 */
import type { GlFeatures } from './context';

export type TexFormat = 'rgba16f' | 'rgba32f' | 'rgba8' | 'srgb8a8' | 'r8' | 'rgba16ui';

export interface Tex {
  /** Unique id of the GL texture object. */
  readonly uid: number;
  /** Content generation (bumped on every render into the texture). */
  gen: number;
  readonly tex: WebGLTexture;
  readonly width: number;
  readonly height: number;
  readonly format: TexFormat;
  /** Level-0 size in bytes. */
  readonly bytes: number;
  fbo: WebGLFramebuffer | null;
  /** Mip levels are allocated (generateMipmap was called). */
  mips: boolean;
  /** Generation whose mips are current. */
  mipsGen: number;
}

interface FormatInfo {
  internal: number;
  format: number;
  type: number;
  bpp: number;
  integer: boolean;
}

let nextUid = 1;
let nextGen = 1;

/** Mark a texture as rewritten (invalidates caches keyed on uid:gen). */
export function touch(t: Tex): void {
  t.gen = nextGen++;
}

export function contentKey(t: Tex): string {
  return `${t.uid}:${t.gen}`;
}

export interface CreateOptions {
  filter?: 'linear' | 'nearest';
  wrap?: 'clamp' | 'repeat';
}

export class TexturePool {
  private free = new Map<string, Tex[]>();
  private freeOrder: Tex[] = [];
  private live = new Set<Tex>();
  liveBytes = 0;
  freeBytes = 0;

  constructor(
    private gl: WebGL2RenderingContext,
    private features: GlFeatures,
    /** Released targets kept for reuse, in bytes. */
    public freeBudget = 256 * 2 ** 20,
  ) {}

  info(format: TexFormat): FormatInfo {
    const gl = this.gl;
    switch (format) {
      case 'rgba16f':
        return { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, bpp: 8, integer: false };
      case 'rgba32f':
        return { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, bpp: 16, integer: false };
      case 'rgba8':
        return { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, bpp: 4, integer: false };
      case 'srgb8a8':
        return { internal: gl.SRGB8_ALPHA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, bpp: 4, integer: false };
      case 'r8':
        return { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, bpp: 1, integer: false };
      case 'rgba16ui':
        return { internal: gl.RGBA16UI, format: gl.RGBA_INTEGER, type: gl.UNSIGNED_SHORT, bpp: 8, integer: true };
    }
  }

  filterable(format: TexFormat): boolean {
    if (format === 'rgba16ui') return false;
    if (format === 'rgba32f') return this.features.floatLinear;
    return true;
  }

  /**
   * Render-target format for a pass's requested output. Without float render
   * targets, linear-light data goes to SRGB8_ALPHA8 (the hardware encodes on
   * write and decodes on read, so 8 bits are spent perceptually) and
   * display-referred data to RGBA8.
   */
  renderFormat(requested: 'rgba16f' | 'rgba32f' | 'rgba8' = 'rgba16f'): TexFormat {
    if (requested === 'rgba8') return 'rgba8';
    if (requested === 'rgba32f' && this.features.floatRender) return 'rgba32f';
    if (this.features.halfFloatRender) return 'rgba16f';
    if (this.features.floatRender) return 'rgba32f';
    return 'srgb8a8';
  }

  /** Creates an un-pooled texture (optionally with data); destroy() it when done. */
  create(width: number, height: number, format: TexFormat, data: ArrayBufferView | null = null, opts: CreateOptions = {}): Tex {
    const gl = this.gl;
    const f = this.info(format);
    const tex = gl.createTexture();
    if (!tex) throw new Error('KLOUD engine: texture allocation failed (context lost?)');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, f.internal, width, height, 0, f.format, f.type, data);
    const linear = (opts.filter ?? 'linear') === 'linear' && this.filterable(format);
    const filter = linear ? gl.LINEAR : gl.NEAREST;
    const wrap = opts.wrap === 'repeat' ? gl.REPEAT : gl.CLAMP_TO_EDGE;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const t: Tex = {
      uid: nextUid++,
      gen: nextGen++,
      tex,
      width,
      height,
      format,
      bytes: width * height * f.bpp,
      fbo: null,
      mips: false,
      mipsGen: 0,
    };
    this.live.add(t);
    this.liveBytes += t.bytes;
    return t;
  }

  /** A render target of exactly width×height×format (reused when possible). */
  acquire(width: number, height: number, format: TexFormat): Tex {
    const w = Math.max(1, Math.round(width));
    const h = Math.max(1, Math.round(height));
    const key = `${w}x${h}:${format}`;
    const list = this.free.get(key);
    const t = list?.pop();
    if (t) {
      this.freeBytes -= t.bytes;
      const i = this.freeOrder.indexOf(t);
      if (i >= 0) this.freeOrder.splice(i, 1);
      return t;
    }
    return this.create(w, h, format);
  }

  release(t: Tex | null | undefined): void {
    if (!t || !this.live.has(t)) return;
    const key = `${t.width}x${t.height}:${t.format}`;
    const list = this.free.get(key) ?? [];
    if (list.includes(t)) return;
    list.push(t);
    this.free.set(key, list);
    this.freeOrder.push(t);
    this.freeBytes += t.bytes;
    touch(t);
    this.trim(this.freeBudget);
  }

  /** Destroy the oldest free targets until the free list fits in `budget` bytes. */
  trim(budget: number): void {
    while (this.freeBytes > budget && this.freeOrder.length) {
      const t = this.freeOrder.shift()!;
      const key = `${t.width}x${t.height}:${t.format}`;
      const list = this.free.get(key);
      if (list) {
        const i = list.indexOf(t);
        if (i >= 0) list.splice(i, 1);
        if (!list.length) this.free.delete(key);
      }
      this.freeBytes -= t.bytes;
      this.destroy(t);
    }
  }

  destroy(t: Tex | null | undefined): void {
    if (!t || !this.live.has(t)) return;
    const gl = this.gl;
    if (t.fbo) gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
    this.live.delete(t);
    this.liveBytes -= t.bytes;
  }

  /** Framebuffer with `t` as colour attachment 0 (created once per texture). */
  fbo(t: Tex): WebGLFramebuffer {
    if (t.fbo) return t.fbo;
    const gl = this.gl;
    const fb = gl.createFramebuffer();
    if (!fb) throw new Error('KLOUD engine: framebuffer allocation failed');
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    t.fbo = fb;
    return fb;
  }

  /** Allocate/refresh the mip chain (needed for minified display sampling). */
  mipmap(t: Tex): void {
    if (t.mips && t.mipsGen === t.gen) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.bindTexture(gl.TEXTURE_2D, null);
    t.mips = true;
    t.mipsGen = t.gen;
  }

  stats(): { liveBytes: number; freeBytes: number; textures: number } {
    return { liveBytes: this.liveBytes, freeBytes: this.freeBytes, textures: this.live.size };
  }

  dispose(): void {
    for (const t of [...this.live]) this.destroy(t);
    this.free.clear();
    this.freeOrder = [];
    this.freeBytes = 0;
  }

  /** Context lost: every handle is dead; forget them without GL calls. */
  forget(): void {
    this.live.clear();
    this.free.clear();
    this.freeOrder = [];
    this.liveBytes = 0;
    this.freeBytes = 0;
  }
}
