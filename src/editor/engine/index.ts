/**
 * createEngine(canvas): the WebGL2 renderer behind KLOUD Studio.
 * See contracts.Engine for the public API and ARCHITECTURE.md for the pipeline.
 */
import { MATRIX_SRGB_TO, ADOBE_RGB_GAMMA } from '../color/math';
import type {
  DisplayTransform,
  Engine,
  EngineCaps,
  FullRenderOptions,
  MaskProvider,
  PatchProvider,
  RenderOptions,
  ViewState,
} from '../contracts';
import type { EditParams, PixelBufferU8, RenderedImage, RGB, SourceImage } from '../types';
import { frameSize, outputSize, outputToSource, setGeometryMeta } from './geometry';
import { capsFrom, defaultPreviewLimit, detectFeatures, getWebGl2, memoryBudget, probeWebGpu } from './gl/context';
import { GpuEnv } from './gl/env';
import type { Tex } from './gl/textures';
import { Pipeline } from './pipeline';
import { resampleTexture, SourceCache, uploadSource, type WorkingImage } from './sources';

export * from './geometry';

type Target = 'main' | 'compare';

interface Slot {
  tex: Tex;
  overlay: Tex | null;
  clip: Tex | null;
  /** Output size at FULL resolution (display transforms use it so 1.0 zoom = 100%). */
  outW: number;
  outH: number;
  ignoreCrop: boolean;
  params: EditParams;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const colorCache = new Map<string, [number, number, number, number]>();
function parseColor(css: string): [number, number, number, number] {
  const hit = colorCache.get(css);
  if (hit) return hit;
  let value = css;
  const m = /var\((--[\w-]+)\)/.exec(css);
  if (m && typeof document !== 'undefined') value = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || '#101012';
  let out: [number, number, number, number] = [0.06, 0.06, 0.07, 1];
  try {
    const c = document.createElement('canvas').getContext('2d');
    if (c) {
      c.fillStyle = '#000';
      c.fillStyle = value;
      const s = String(c.fillStyle);
      if (s.startsWith('#')) {
        const n = parseInt(s.slice(1, 7), 16);
        out = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
      } else {
        const p = s.match(/[\d.]+/g)?.map(Number) ?? [];
        if (p.length >= 3) out = [p[0] / 255, p[1] / 255, p[2] / 255, p[3] ?? 1];
      }
    }
  } catch {
    /* keep default */
  }
  if (!m) colorCache.set(css, out);
  return out;
}

export function createEngine(canvas: HTMLCanvasElement): Engine {
  const maybeGl = getWebGl2(canvas);
  if (!maybeGl) throw new Error('WebGL2 is not available in this browser.');
  const gl: WebGL2RenderingContext = maybeGl;
  let features = detectFeatures(gl);
  let env = new GpuEnv(gl, features, memoryBudget());
  let pipeline = new Pipeline(env);
  let sources = new SourceCache(env, memoryBudget());
  const caps: EngineCaps = capsFrom(features, false);
  void probeWebGpu().then((ok) => {
    caps.webgpu = ok;
  });

  const previewLimit = defaultPreviewLimit(features.maxTextureSize);
  let source: SourceImage | null = null;
  let image: WorkingImage | null = null;
  let maskProvider: MaskProvider | null = null;
  let patchProvider: PatchProvider | null = null;
  const slots = new Map<Target, Slot>();
  const renderCbs = new Set<(ms: number, t: Target) => void>();
  let cssW = canvas.clientWidth || 1;
  let cssH = canvas.clientHeight || 1;
  let dpr = globalThis.devicePixelRatio || 1;
  let lost = false;
  let reference: { src: object; tex: Tex } | null = null;

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    lost = true;
  });
  canvas.addEventListener('webglcontextrestored', () => {
    features = detectFeatures(gl);
    env.forget();
    pipeline.forget();
    sources.forget();
    env = new GpuEnv(gl, features, memoryBudget());
    pipeline = new Pipeline(env);
    sources = new SourceCache(env, memoryBudget());
    slots.clear();
    reference = null;
    image = null;
    lost = false;
    for (const cb of renderCbs) cb(-1, 'main');
  });

  const workingImage = (): WorkingImage | null => {
    if (!source) return null;
    if (!image) image = sources.get(source, previewLimit);
    return image;
  };

  const releaseSlot = (s: Slot | undefined) => {
    if (!s) return;
    env.pool.release(s.tex);
    if (s.overlay) env.pool.release(s.overlay);
    if (s.clip) env.pool.release(s.clip);
  };

  /* ---------------------------- layout ---------------------------- */

  function panes(view: ViewState): { main: Rect; other: Rect | null } {
    const full = { x: 0, y: 0, w: cssW, h: cssH };
    if (view.compare !== 'side-by-side' && view.compare !== 'reference') return { main: full, other: null };
    if (cssW >= cssH) {
      const hw = cssW / 2;
      return { other: { x: 0, y: 0, w: hw, h: cssH }, main: { x: hw, y: 0, w: cssW - hw, h: cssH } };
    }
    const hh = cssH / 2;
    return { other: { x: 0, y: 0, w: cssW, h: hh }, main: { x: 0, y: hh, w: cssW, h: cssH - hh } };
  }

  function transformIn(pane: Rect, outW: number, outH: number, view: ViewState): { scale: number; offsetX: number; offsetY: number } {
    const pad = pane.w > 480 && pane.h > 320 ? 16 : 0;
    const fit = Math.max(1e-4, Math.min((pane.w - pad * 2) / outW, (pane.h - pad * 2) / outH));
    const scale = view.zoom === 'fit' ? fit : Math.max(1e-4, view.zoom);
    const iw = outW * scale;
    const ih = outH * scale;
    const place = (p0: number, size: number, img: number, c: number) => {
      if (img <= size) return p0 + (size - img) / 2;
      const o = p0 + size / 2 - c * img;
      return Math.min(p0, Math.max(p0 + size - img, o));
    };
    return { scale, offsetX: place(pane.x, pane.w, iw, view.center.x), offsetY: place(pane.y, pane.h, ih, view.center.y) };
  }

  const mainSize = (): { w: number; h: number } => {
    const s = slots.get('main');
    if (s) return { w: s.outW, h: s.outH };
    return { w: source?.fullWidth || 1, h: source?.fullHeight || 1 };
  };

  /* ---------------------------- drawing --------------------------- */

  function drawImage(tex: Tex, pane: Rect, t: { scale: number; offsetX: number; offsetY: number }, outW: number, outH: number, view: ViewState, slot: Slot | null, scissor?: Rect) {
    const devScale = t.scale * dpr * (tex.width / outW);
    let sampler = env.samplers.linear;
    if (devScale < 0.95) {
      env.pool.mipmap(tex);
      sampler = env.samplers.trilinear;
    } else if (t.scale * dpr > 2) sampler = env.samplers.nearest;
    const clipOn = !!slot && (view.clipping.highlights || view.clipping.shadows);
    if (clipOn && slot && !slot.clip) {
      slot.clip = env.pool.acquire(slot.tex.width, slot.tex.height, 'rgba8');
      env.runner.draw(env.internal('clip'), slot.clip, { uSrc: slot.tex }, {});
      env.pool.mipmap(slot.clip);
    }
    const overlayOn = !!slot?.overlay && !!view.maskOverlay;
    const r = scissor ?? pane;
    env.runner.draw(
      env.internal('present'),
      null,
      {
        uImage: { tex, sampler },
        uClip: clipOn && slot?.clip ? { tex: slot.clip, sampler: env.samplers.trilinear } : undefined,
        uOverlay: overlayOn && slot?.overlay ? { tex: slot.overlay, sampler: env.samplers.linear } : undefined,
      },
      {
        uCanvasH: canvas.height,
        uDpr: dpr,
        uOffset: [t.offsetX, t.offsetY],
        uScale: t.scale,
        uOutSize: [outW, outH],
        uImgRect: [0, 0, 1, 1],
        uBg: parseColor(view.background),
        uClipOn: [clipOn && view.clipping.highlights ? 1 : 0, clipOn && view.clipping.shadows ? 1 : 0],
        uClipHigh: [1, 0.23, 0.19],
        uClipLow: [0.18, 0.49, 1],
        uOverlayOn: overlayOn,
        uOverlayColor: view.maskOverlay?.color ?? [1, 0.25, 0.25, 0.45],
        uUseImageAlpha: true,
      },
      {
        viewport: [0, 0, canvas.width, canvas.height],
        scissor: [Math.round(r.x * dpr), Math.round(r.y * dpr), Math.round(r.w * dpr), Math.round(r.h * dpr)],
        canvasHeight: canvas.height,
      },
    );
  }

  function fill(r: Rect, color: [number, number, number, number]) {
    env.runner.draw(env.internal('fill'), null, {}, { uColor: color }, {
      viewport: [0, 0, canvas.width, canvas.height],
      scissor: [Math.round(r.x * dpr), Math.round(r.y * dpr), Math.max(1, Math.round(r.w * dpr)), Math.max(1, Math.round(r.h * dpr))],
      canvasHeight: canvas.height,
    });
  }

  function referenceTex(src: ImageBitmap | HTMLCanvasElement): Tex {
    if (reference?.src === src) return reference.tex;
    if (reference) env.pool.destroy(reference.tex);
    const tex = env.pool.create(src.width, src.height, 'rgba8');
    gl.bindTexture(gl.TEXTURE_2D, tex.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.bindTexture(gl.TEXTURE_2D, null);
    reference = { src, tex };
    return tex;
  }

  /* ---------------------------- readback -------------------------- */

  function readRgba8(tex: Tex): Uint8ClampedArray<ArrayBuffer> {
    const out = new Uint8ClampedArray(tex.width * tex.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, env.pool.fbo(tex));
    gl.readPixels(0, 0, tex.width, tex.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  function readFloat(tex: Tex, x: number, y: number, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, env.pool.fbo(tex));
    if (tex.format === 'rgba8' || tex.format === 'srgb8a8') {
      const u8 = new Uint8Array(w * h * 4);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, u8);
      for (let i = 0; i < u8.length; i++) out[i] = u8[i] / 255;
    } else {
      gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  const fitInside = (w: number, h: number, max: number) => {
    const s = Math.min(1, max / Math.max(w, h));
    return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
  };

  /* ---------------------------- engine ---------------------------- */

  const engine: Engine = {
    canvas,
    caps,

    async setSource(src) {
      if (source && source.id !== src.id) pipeline.clearPhotoCaches();
      source = src;
      image = null;
      setGeometryMeta(src.meta);
      for (const s of slots.values()) releaseSlot(s);
      slots.clear();
      workingImage();
    },

    getSource: () => source,
    setMaskProvider(p) {
      maskProvider = p;
    },
    setPatchProvider(p) {
      patchProvider = p;
    },

    getOutputSize(params, ignoreCrop = false) {
      const img = workingImage();
      const w = img?.width ?? source?.width ?? 1;
      const h = img?.height ?? source?.height ?? 1;
      return ignoreCrop ? frameSize(params, w, h) : outputSize(params, w, h);
    },

    render(params, opts: RenderOptions = {}) {
      if (lost) return;
      const full = workingImage();
      if (!full || !source) return;
      const t0 = performance.now();
      const target: Target = opts.target ?? 'main';
      const quality = opts.quality ?? 'full';
      const img = quality === 'draft' ? sources.reduced(full, Math.max(512, Math.round(previewLimit / 2))) : full;
      const ignoreCrop = !!opts.ignoreCrop;
      const overlayMask = target === 'main' && overlayMaskId ? params.masks.find((m) => m.id === overlayMaskId) ?? null : null;
      const res = pipeline.run(img, params, { quality, ignoreCrop, maskProvider, patchProvider, overlayMask });
      const fullOut = ignoreCrop ? frameSize(params, source.fullWidth, source.fullHeight) : outputSize(params, source.fullWidth, source.fullHeight);
      releaseSlot(slots.get(target));
      slots.set(target, { tex: res.out, overlay: res.overlay, clip: null, outW: fullOut.width, outH: fullOut.height, ignoreCrop, params });
      const ms = performance.now() - t0;
      for (const cb of renderCbs) cb(ms, target);
    },

    present(view) {
      if (lost) return;
      overlayMaskId = view.maskOverlay?.maskId ?? null;
      const bg = parseColor(view.background);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const main = slots.get('main');
      if (!main) return;
      const cmp = slots.get('compare') ?? null;
      const { main: pane, other } = panes(view);
      const t = transformIn(pane, main.outW, main.outH, view);
      const showBefore = view.compare === 'before' && cmp;
      const primary = showBefore ? cmp : main;
      drawImage(primary.tex, pane, t, main.outW, main.outH, view, showBefore ? null : main);

      if ((view.compare === 'split-vertical' || view.compare === 'split-horizontal') && cmp) {
        const sp = Math.min(1, Math.max(0, view.splitPosition));
        const vertical = view.compare === 'split-vertical';
        const clip: Rect = vertical ? { x: 0, y: 0, w: cssW * sp, h: cssH } : { x: 0, y: 0, w: cssW, h: cssH * sp };
        if (clip.w > 0 && clip.h > 0) drawImage(cmp.tex, pane, t, main.outW, main.outH, view, null, clip);
        fill(vertical ? { x: cssW * sp - 0.5, y: 0, w: 1, h: cssH } : { x: 0, y: cssH * sp - 0.5, w: cssW, h: 1 }, [1, 1, 1, 0.85]);
      } else if (view.compare === 'side-by-side' && other) {
        const src = cmp ?? main;
        drawImage(src.tex, other, transformIn(other, src.outW, src.outH, view), src.outW, src.outH, view, null);
        fill(cssW >= cssH ? { x: other.w - 0.5, y: 0, w: 1, h: cssH } : { x: 0, y: other.h - 0.5, w: cssW, h: 1 }, [bg[0] * 0.5, bg[1] * 0.5, bg[2] * 0.5, 1]);
      } else if (view.compare === 'reference' && other && view.reference) {
        const rt = referenceTex(view.reference);
        const fitView: ViewState = { ...view, zoom: 'fit', center: { x: 0.5, y: 0.5 } };
        drawImage(rt, other, transformIn(other, rt.width, rt.height, fitView), rt.width, rt.height, fitView, null);
      }
    },

    resize(w, h, ratio) {
      cssW = Math.max(1, w);
      cssH = Math.max(1, h);
      dpr = Math.max(0.5, Math.min(ratio || 1, 3));
      const pw = Math.max(1, Math.round(cssW * dpr));
      const ph = Math.max(1, Math.round(cssH * dpr));
      if (canvas.width !== pw) canvas.width = pw;
      if (canvas.height !== ph) canvas.height = ph;
    },

    getDisplayTransform(view): DisplayTransform {
      const { w, h } = mainSize();
      const { main } = panes(view);
      const t = transformIn(main, w, h, view);
      return { scale: t.scale, offsetX: t.offsetX, offsetY: t.offsetY, outWidth: w, outHeight: h, viewportWidth: cssW, viewportHeight: cssH };
    },

    readPixels(maxSize, target = 'main'): PixelBufferU8 {
      const slot = slots.get(target) ?? slots.get('main');
      if (!slot || lost) return { width: 1, height: 1, data: new Uint8ClampedArray(4), transfer: 'srgb' };
      const { w, h } = fitInside(slot.tex.width, slot.tex.height, maxSize);
      const small = resampleTexture(env, slot.tex, w, h, { encoded: true, format: 'rgba8' });
      const data = readRgba8(small);
      env.pool.release(small);
      return { width: w, height: h, data, transfer: 'srgb' };
    },

    samplePixel(u, v): RGB {
      const slot = slots.get('main');
      if (!slot || lost) return [0, 0, 0];
      const x = Math.min(slot.tex.width - 1, Math.max(0, Math.floor(u * slot.tex.width)));
      const y = Math.min(slot.tex.height - 1, Math.max(0, Math.floor(v * slot.tex.height)));
      const p = readFloat(slot.tex, x, y, 1, 1);
      return [Math.min(1, Math.max(0, p[0])), Math.min(1, Math.max(0, p[1])), Math.min(1, Math.max(0, p[2]))];
    },

    sampleSourceLinear(u, v, params, radiusPx = 2): RGB {
      const img = workingImage();
      if (!img || lost) return [0.18, 0.18, 0.18];
      const ignoreCrop = slots.get('main')?.ignoreCrop ?? false;
      const s = outputToSource(u, v, params, img.width, img.height, ignoreCrop);
      const r = Math.max(0, Math.round(radiusPx));
      const x0 = Math.max(0, Math.min(img.width - 1, Math.round(s.x * img.width) - r));
      const y0 = Math.max(0, Math.min(img.height - 1, Math.round(s.y * img.height) - r));
      const w = Math.min(img.width - x0, r * 2 + 1);
      const h = Math.min(img.height - y0, r * 2 + 1);
      const d = readFloat(img.tex, x0, y0, w, h);
      const acc = [0, 0, 0];
      const n = w * h;
      for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) acc[c] += d[i * 4 + c];
      return [acc[0] / n, acc[1] / n, acc[2] / n];
    },

    async renderFull(params, opts: FullRenderOptions): Promise<RenderedImage> {
      const src = opts.source ?? source;
      if (!src) throw new Error('No photo to render.');
      const own = uploadSource(env, src, features.maxTextureSize);
      opts.onProgress?.(0.1);
      try {
        const res = pipeline.run(own, params, { quality: 'full', ignoreCrop: false, maskProvider, patchProvider, overlayMask: null });
        if (res.overlay) env.pool.release(res.overlay);
        opts.onProgress?.(0.6);
        const W = Math.max(1, Math.round(opts.width));
        const H = Math.max(1, Math.round(opts.height));
        const hiPrec = opts.bitDepth === 16;
        let finalTex = res.out;
        if (res.out.width !== W || res.out.height !== H) {
          finalTex = resampleTexture(env, res.out, W, H, { encoded: true, format: env.pool.renderFormat(hiPrec ? 'rgba32f' : 'rgba16f') });
          env.pool.release(res.out);
        }
        const space = opts.colorSpace === 'display-p3' ? 1 : opts.colorSpace === 'adobe-rgb' ? 2 : 0;
        const m = MATRIX_SRGB_TO[opts.colorSpace === 'srgb' ? 'srgb' : opts.colorSpace];
        const stripH = Math.max(1, Math.min(H, Math.floor((16 * 1024 * 1024) / (W * 16))));
        const strip = env.pool.acquire(W, stripH, hiPrec ? env.pool.renderFormat('rgba32f') : 'rgba8');
        const data = hiPrec ? new Uint16Array(W * H * 4) : new Uint8ClampedArray(W * H * 4);
        for (let y0 = 0; y0 < H; y0 += stripH) {
          if (opts.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
          const h = Math.min(stripH, H - y0);
          env.runner.draw(
            env.internal('encode'),
            strip,
            { uSrc: finalTex },
            { uOffset: [0, y0], uSpace: space, uM0: m.slice(0, 3), uM1: m.slice(3, 6), uM2: m.slice(6, 9), uGamma: ADOBE_RGB_GAMMA, uQuant: hiPrec ? 0 : 255 },
            { viewport: [0, 0, W, h] },
          );
          if (hiPrec) {
            const f = readFloat(strip, 0, 0, W, h);
            const off = y0 * W * 4;
            for (let i = 0; i < f.length; i++) data[off + i] = Math.round(Math.min(1, Math.max(0, f[i])) * 65535);
          } else {
            const u8 = new Uint8Array(W * h * 4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, env.pool.fbo(strip));
            gl.readPixels(0, 0, W, h, gl.RGBA, gl.UNSIGNED_BYTE, u8);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            (data as Uint8ClampedArray).set(u8, y0 * W * 4);
          }
          opts.onProgress?.(0.6 + 0.4 * ((y0 + h) / H));
          await new Promise((r) => setTimeout(r, 0));
        }
        env.pool.release(strip);
        env.pool.release(finalTex);
        return { width: W, height: H, data, bitDepth: hiPrec ? 16 : 8, colorSpace: opts.colorSpace };
      } finally {
        env.pool.destroy(own.tex);
      }
    },

    async renderThumbnail(params, maxSize) {
      const full = workingImage();
      if (!full) throw new Error('No photo loaded.');
      const img = sources.reduced(full, Math.max(256, Math.min(previewLimit, maxSize * 2)));
      const res = pipeline.run(img, params, { quality: 'full', ignoreCrop: false, maskProvider, patchProvider, overlayMask: null });
      if (res.overlay) env.pool.release(res.overlay);
      const { w, h } = fitInside(res.out.width, res.out.height, maxSize);
      const small = resampleTexture(env, res.out, w, h, { encoded: true, format: 'rgba8', opaque: true });
      env.pool.release(res.out);
      const data = readRgba8(small);
      env.pool.release(small);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const g = c.getContext('2d');
      if (!g) throw new Error('2D canvas unavailable');
      g.putImageData(new ImageData(data, w, h), 0, 0);
      return new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.86));
    },

    onRendered(cb) {
      renderCbs.add(cb);
      return () => renderCbs.delete(cb);
    },

    dispose() {
      for (const s of slots.values()) releaseSlot(s);
      slots.clear();
      pipeline.clearPhotoCaches();
      sources.clear();
      env.dispose();
      renderCbs.clear();
    },
  };
  let overlayMaskId: string | null = null;
  return engine;
}
