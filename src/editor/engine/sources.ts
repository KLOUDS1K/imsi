/**
 * Source upload ("Proxy Preview") and the GPU source cache ("GPU Texture Cache").
 *
 * Upload decodes any SourceImage into a LINEAR-light, linear-sRGB-primaries
 * working texture (RGBA16F; SRGB8_ALPHA8 when float targets are unavailable):
 *   Uint8  → RGBA8 texture, sRGB decode in the shader
 *   Uint16 → RGBA16UI texture, normalized by 1/65535 (full 16-bit precision
 *            reaches the shader; no CPU conversion)
 *   Float32→ RGBA32F texture
 * then MATRIX_TO_SRGB[primaries]. Downscaling to the preview limit happens in
 * the same pass with an exact area-average filter in linear light. Sources
 * larger than MAX_TEXTURE_SIZE (or very large float data) are streamed in
 * tiles straight out of the CPU array (UNPACK_ROW_LENGTH/SKIP_*), each tile's
 * contribution summed into the target with additive blending.
 */
import { MATRIX_TO_SRGB } from '../color/math';
import type { PhotoMeta, PixelData, SourceImage } from '../types';
import type { GpuEnv } from './gl/env';
import type { Tex, TexFormat } from './gl/textures';

export interface WorkingImage {
  /** Unique key of this GPU image (stage caches key on it). */
  key: string;
  id: string;
  tex: Tex;
  /** Processing resolution. */
  width: number;
  height: number;
  /** Original full-size dimensions (SourceImage.fullWidth/fullHeight). */
  fullWidth: number;
  fullHeight: number;
  meta: PhotoMeta;
  isRaw: boolean;
  /** tex is smaller than the SourceImage data it came from. */
  reduced: boolean;
  source: SourceImage | null;
}

let uploadSeq = 0;
const dataIds = new WeakMap<object, number>();
let nextDataId = 1;

/** Stable identity of a pixel array (so a re-decoded photo with the same id is re-uploaded). */
export function dataId(data: PixelData): number {
  let id = dataIds.get(data);
  if (!id) {
    id = nextDataId++;
    dataIds.set(data, id);
  }
  return id;
}

/** Size that fits `maxEdge` on the long side (never enlarges). */
export function fitSize(w: number, h: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h };
  const s = maxEdge / long;
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

export interface Tile {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Split w×h into tiles of at most `max` px per side. */
export function tileGrid(w: number, h: number, max: number): Tile[] {
  const out: Tile[] = [];
  for (let y = 0; y < h; y += max) for (let x = 0; x < w; x += max) out.push({ x, y, w: Math.min(max, w - x), h: Math.min(max, h - y) });
  return out;
}

function rows(m: number[]): { uM0: number[]; uM1: number[]; uM2: number[] } {
  return { uM0: m.slice(0, 3), uM1: m.slice(3, 6), uM2: m.slice(6, 9) };
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

interface RawKind {
  format: TexFormat;
  glFormat: number;
  glType: number;
  view: ArrayBufferView;
  scale: number;
  bytesPerPx: number;
  uint: boolean;
}

function rawKind(gl: WebGL2RenderingContext, data: PixelData): RawKind {
  if (data instanceof Float32Array) return { format: 'rgba32f', glFormat: gl.RGBA, glType: gl.FLOAT, view: data, scale: 1, bytesPerPx: 16, uint: false };
  if (data instanceof Uint16Array)
    return { format: 'rgba16ui', glFormat: gl.RGBA_INTEGER, glType: gl.UNSIGNED_SHORT, view: data, scale: 1 / 65535, bytesPerPx: 8, uint: true };
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.length);
  return { format: 'rgba8', glFormat: gl.RGBA, glType: gl.UNSIGNED_BYTE, view: u8, scale: 1, bytesPerPx: 4, uint: false };
}

/**
 * Decode `src` into a new working texture whose long edge is ≤ maxEdge
 * (and ≤ MAX_TEXTURE_SIZE). The texture comes from the pool; the caller owns it.
 */
export function uploadSource(env: GpuEnv, src: SourceImage, maxEdge: number): WorkingImage {
  const gl = env.gl;
  const W = src.width;
  const H = src.height;
  if (!(W > 0 && H > 0)) throw new Error('KLOUD engine: empty source image');
  if (src.data.length < W * H * 4) throw new Error(`KLOUD engine: source data too short for ${W}×${H} RGBA`);
  const limit = Math.max(1, Math.min(maxEdge, env.features.maxTextureSize));
  const size = fitSize(W, H, limit);
  const out = env.pool.acquire(size.width, size.height, env.pool.renderFormat('rgba16f'));
  const kind = rawKind(gl, src.data);
  const rx = W / size.width;
  const ry = H / size.height;
  // Raw tiles ≤ ~64 MB each and within the texture limit.
  const tileMax = Math.min(env.features.maxTextureSize, Math.max(256, Math.floor(Math.sqrt((64 * 2 ** 20) / kind.bytesPerPx))));
  const tiles = tileGrid(W, H, tileMax);
  const multi = tiles.length > 1;
  if (multi) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, env.pool.fbo(out));
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, out.width, out.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  const prog = env.internal(kind.uint ? 'resampleUint' : 'resample');
  const matrix = MATRIX_TO_SRGB[src.primaries] ?? IDENTITY;
  const common = {
    uRatio: [rx, ry],
    uScaleIn: kind.scale,
    uTransferIn: src.transfer === 'srgb' ? 1 : 0,
    ...rows(matrix),
    uOpaque: true,
    uUnpremultiply: false,
    uTransferOut: 0,
  };
  for (const t of tiles) {
    const raw = env.pool.create(t.w, t.h, kind.format, null, { filter: 'nearest' });
    gl.bindTexture(gl.TEXTURE_2D, raw.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, W);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, t.x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, t.y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.w, t.h, kind.glFormat, kind.glType, kind.view);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    // Output pixels whose footprint touches this tile.
    const ox0 = Math.floor(t.x / rx);
    const oy0 = Math.floor(t.y / ry);
    const ox1 = Math.min(size.width, Math.ceil((t.x + t.w) / rx));
    const oy1 = Math.min(size.height, Math.ceil((t.y + t.h) / ry));
    env.runner.draw(prog, out, { uSrc: raw }, { ...common, uTile: [t.x, t.y, t.w, t.h] }, { viewport: [ox0, oy0, ox1 - ox0, oy1 - oy0], blendAdd: multi });
    env.pool.destroy(raw);
  }
  return {
    key: `${src.id}#${++uploadSeq}`,
    id: src.id,
    tex: out,
    width: size.width,
    height: size.height,
    fullWidth: Math.max(src.fullWidth || W, W),
    fullHeight: Math.max(src.fullHeight || H, H),
    meta: src.meta,
    isRaw: src.isRaw,
    reduced: size.width !== W || size.height !== H,
    source: src,
  };
}

export interface ResampleOptions {
  /** Input values are sRGB-encoded: decode, average in linear light, re-encode. */
  encoded?: boolean;
  /** Ignore input alpha (treat as opaque). */
  opaque?: boolean;
  format?: TexFormat;
}

/** Area-average `src` to dstW×dstH into a new pooled texture (GPU → GPU). */
export function resampleTexture(env: GpuEnv, src: Tex, dstW: number, dstH: number, opts: ResampleOptions = {}): Tex {
  const out = env.pool.acquire(dstW, dstH, opts.format ?? src.format);
  env.runner.draw(
    env.internal('resample'),
    out,
    { uSrc: src },
    {
      uRatio: [src.width / out.width, src.height / out.height],
      uTile: [0, 0, src.width, src.height],
      uScaleIn: 1,
      uTransferIn: opts.encoded ? 1 : 0,
      ...rows(IDENTITY),
      uOpaque: !!opts.opaque,
      uUnpremultiply: !opts.opaque,
      uTransferOut: opts.encoded ? 1 : 0,
    },
  );
  return out;
}

/** A reduced copy of a working image (draft proxy, export/thumbnail processing resolution). */
export function reduceImage(env: GpuEnv, img: WorkingImage, maxEdge: number): WorkingImage {
  const size = fitSize(img.width, img.height, maxEdge);
  if (size.width === img.width && size.height === img.height) return img;
  const tex = resampleTexture(env, img.tex, size.width, size.height, { opaque: true });
  return { ...img, key: `${img.key}>${size.width}x${size.height}`, tex, width: size.width, height: size.height, reduced: true };
}

interface CacheEntry {
  key: string;
  image: WorkingImage;
  drafts: Map<number, WorkingImage>;
}

/**
 * LRU of uploaded sources (current photo + the last few), bounded by count
 * and bytes, so flipping between recently viewed photos skips the upload.
 */
export class SourceCache {
  private entries: CacheEntry[] = [];

  constructor(
    private env: GpuEnv,
    public budgetBytes: number,
    public maxEntries = 3,
  ) {}

  private keyOf(src: SourceImage, maxEdge: number): string {
    return `${src.id}|${src.width}x${src.height}|${dataId(src.data)}|${maxEdge}`;
  }

  get(src: SourceImage, maxEdge: number): WorkingImage {
    const key = this.keyOf(src, maxEdge);
    const i = this.entries.findIndex((e) => e.key === key);
    if (i >= 0) {
      const [e] = this.entries.splice(i, 1);
      this.entries.push(e);
      return e.image;
    }
    const image = uploadSource(this.env, src, maxEdge);
    this.entries.push({ key, image, drafts: new Map() });
    this.evict(image);
    return image;
  }

  /** Lower-resolution copy of a cached image (created once, freed with the entry). */
  reduced(image: WorkingImage, maxEdge: number): WorkingImage {
    const e = this.entries.find((x) => x.image === image);
    if (!e) return image;
    const hit = e.drafts.get(maxEdge);
    if (hit) return hit;
    const r = reduceImage(this.env, image, maxEdge);
    if (r !== image) e.drafts.set(maxEdge, r);
    return r;
  }

  has(image: WorkingImage): boolean {
    return this.entries.some((e) => e.image === image || [...e.drafts.values()].includes(image));
  }

  private bytes(e: CacheEntry): number {
    let b = e.image.tex.bytes;
    for (const d of e.drafts.values()) b += d.tex.bytes;
    return b;
  }

  private evict(keep: WorkingImage): void {
    let total = this.entries.reduce((s, e) => s + this.bytes(e), 0);
    while (this.entries.length > 1 && (this.entries.length > this.maxEntries || total > this.budgetBytes)) {
      const idx = this.entries.findIndex((e) => e.image !== keep);
      if (idx < 0) break;
      const [e] = this.entries.splice(idx, 1);
      total -= this.bytes(e);
      this.free(e);
    }
  }

  private free(e: CacheEntry): void {
    this.env.pool.destroy(e.image.tex);
    for (const d of e.drafts.values()) this.env.pool.destroy(d.tex);
  }

  /** Drop one image (e.g. a temporary export source). */
  remove(image: WorkingImage): void {
    const i = this.entries.findIndex((e) => e.image === image);
    if (i >= 0) this.free(this.entries.splice(i, 1)[0]);
  }

  clear(): void {
    for (const e of this.entries) this.free(e);
    this.entries = [];
  }

  forget(): void {
    this.entries = [];
  }
}
