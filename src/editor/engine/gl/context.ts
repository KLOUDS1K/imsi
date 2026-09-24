/**
 * WebGL2 context creation and capability detection.
 *
 * The engine always renders with WebGL2 ("WebGL fallback" is the main path);
 * WebGPU availability is only probed and reported in EngineCaps.webgpu.
 */
import type { EngineCaps } from '../../contracts';

export interface GlFeatures {
  /** RGBA16F is colour-renderable (EXT_color_buffer_float or EXT_color_buffer_half_float), verified with a test FBO. */
  halfFloatRender: boolean;
  /** RGBA32F is colour-renderable (EXT_color_buffer_float), verified with a test FBO. */
  floatRender: boolean;
  /** RGBA32F textures may use LINEAR filtering (OES_texture_float_linear). */
  floatLinear: boolean;
  /** Blending into RGBA32F targets (EXT_float_blend). */
  floatBlend: boolean;
  maxTextureSize: number;
  maxViewport: [number, number];
  renderer: string;
  /** KHR_parallel_shader_compile: programs can be compiled in the background. */
  parallelCompile: boolean;
}

export const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: true,
  depth: false,
  stencil: false,
  antialias: false,
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
};

export function getWebGl2(canvas: HTMLCanvasElement): WebGL2RenderingContext | null {
  try {
    return canvas.getContext('webgl2', CONTEXT_ATTRIBUTES) as WebGL2RenderingContext | null;
  } catch {
    return null;
  }
}

/** Some drivers advertise float render extensions but fail FBO completeness: test for real. */
function renderable(gl: WebGL2RenderingContext, internal: number, type: number): boolean {
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  if (!tex || !fb) return false;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, 4, 4, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.deleteFramebuffer(fb);
  gl.deleteTexture(tex);
  // Swallow any error the probe produced so debug checks start clean.
  while (gl.getError() !== gl.NO_ERROR) {
    /* drain */
  }
  return ok;
}

export function rendererString(gl: WebGL2RenderingContext): string {
  const generic = String(gl.getParameter(gl.RENDERER) ?? '');
  // Chrome reports "WebKit WebGL" here; the debug extension has the real name
  // (Firefox deprecates the extension and already returns a sanitized name).
  if (generic && !/^webkit webgl$/i.test(generic)) return generic;
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? generic);
  return generic || 'WebGL2';
}

export function detectFeatures(gl: WebGL2RenderingContext): GlFeatures {
  const cbf = !!gl.getExtension('EXT_color_buffer_float');
  const cbhf = !!gl.getExtension('EXT_color_buffer_half_float');
  const floatLinear = !!gl.getExtension('OES_texture_float_linear');
  const floatBlend = !!gl.getExtension('EXT_float_blend');
  const parallelCompile = !!gl.getExtension('KHR_parallel_shader_compile');
  const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
  return {
    halfFloatRender: (cbf || cbhf) && renderable(gl, gl.RGBA16F, gl.HALF_FLOAT),
    floatRender: cbf && renderable(gl, gl.RGBA32F, gl.FLOAT),
    floatLinear,
    floatBlend,
    maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    maxViewport: [vp[0], vp[1]],
    renderer: rendererString(gl),
    parallelCompile,
  };
}

export function capsFrom(features: GlFeatures | null, webgpu: boolean): EngineCaps {
  return {
    webgl2: !!features,
    webgpu,
    halfFloatRender: features?.halfFloatRender ?? false,
    floatLinearFilter: features?.floatLinear ?? false,
    maxTextureSize: features?.maxTextureSize ?? 0,
    renderer: features?.renderer ?? 'unavailable',
  };
}

interface GpuLike {
  requestAdapter(): Promise<unknown>;
}

/** Resolves true when navigator.gpu hands out an adapter (never rejects; 2 s timeout). */
export async function probeWebGpu(): Promise<boolean> {
  const gpu = (globalThis.navigator as (Navigator & { gpu?: GpuLike }) | undefined)?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  try {
    const adapter = await Promise.race([
      gpu.requestAdapter(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    return !!adapter;
  } catch {
    return false;
  }
}

/**
 * Default preview (proxy) long edge: 2560, less on small screens or devices
 * reporting little memory, never above the texture limit.
 */
export function defaultPreviewLimit(maxTextureSize: number): number {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const mem = nav?.deviceMemory ?? 8;
  const scr = globalThis.screen;
  const shortCss = scr ? Math.min(scr.width, scr.height) : 1080;
  let limit = 2560;
  if (mem <= 2) limit = 1600;
  else if (mem <= 4 || shortCss < 500) limit = 2048;
  return Math.max(256, Math.min(limit, maxTextureSize || limit));
}

/** Bytes of GPU memory we allow for cached work (sources, stage caches, free pool). */
export function memoryBudget(): number {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const mem = nav?.deviceMemory ?? 8;
  if (mem <= 2) return 192 * 2 ** 20;
  if (mem <= 4) return 384 * 2 ** 20;
  return 1024 * 2 ** 20;
}
