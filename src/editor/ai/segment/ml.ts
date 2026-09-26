/** Browser client for the MediaPipe MagicTouch worker. */
import type { MaskBitmap, PixelBuffer, Point } from '../../types';

export interface MlStroke {
  /** MediaPipe BrushMode: 1 positive, 2 negative, 3 lasso. */
  brushMode: 1 | 2 | 3;
  point: Point[];
  isCompleted: boolean;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkerReply = {
  id: number;
  ok: boolean;
  ready?: boolean;
  width?: number;
  height?: number;
  data?: Uint8Array;
  error?: string;
};

export type MlState = 'unavailable' | 'loading' | 'ready' | 'failed';

let worker: Worker | null = null;
let nextId = 0;
let state: MlState = 'unavailable';
let detail = 'MediaPipe loads automatically for subject and object masks.';
const pending = new Map<number, Pending>();

export function mlStatus(): { state: MlState; message: string } {
  return { state, message: detail };
}

function supported(): boolean {
  return typeof Worker !== 'undefined' && typeof ImageData !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

function resetWorker(error: Error): void {
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(error);
  }
  pending.clear();
}

function getWorker(): Worker {
  if (!supported()) throw new Error('This browser cannot run the on-device segmentation model');
  if (worker) return worker;
  worker = new Worker(new URL('./ml.worker.ts', import.meta.url), { type: 'module', name: 'kloud-mask-ml' });
  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data;
    const p = pending.get(reply.id);
    if (!p) return;
    pending.delete(reply.id);
    clearTimeout(p.timer);
    if (reply.ok) p.resolve(reply);
    else p.reject(new Error(reply.error || 'MediaPipe segmentation failed'));
  };
  worker.onerror = (event) => {
    state = 'failed';
    detail = event.message || 'The on-device model worker failed.';
    resetWorker(new Error(detail));
  };
  return worker;
}

function request(payload: Record<string, unknown>, transfer: Transferable[] = [], timeout = 25_000): Promise<WorkerReply> {
  const id = ++nextId;
  const w = getWorker();
  return new Promise<WorkerReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const error = new Error('On-device mask model timed out');
      state = 'failed';
      detail = error.message;
      resetWorker(error);
      reject(error);
    }, timeout);
    pending.set(id, { resolve: (v) => resolve(v as WorkerReply), reject, timer });
    w.postMessage({ id, ...payload }, transfer);
  });
}

export async function enableMl(): Promise<boolean> {
  if (state === 'ready') return true;
  if (!supported()) {
    state = 'unavailable';
    detail = 'This browser cannot run MediaPipe; enhanced local detection is active.';
    return false;
  }
  state = 'loading';
  detail = 'Loading the on-device MediaPipe model…';
  try {
    await request({ type: 'init' });
    state = 'ready';
    detail = 'MediaPipe MagicTouch v2 is ready. Photos stay on this device.';
    return true;
  } catch (error) {
    state = 'failed';
    detail = `${error instanceof Error ? error.message : String(error)} Enhanced local detection remains active.`;
    return false;
  }
}

function rgba8(px: PixelBuffer): Uint8ClampedArray {
  if (px.data instanceof Uint8ClampedArray) return px.data.slice();
  const out = new Uint8ClampedArray(px.width * px.height * 4);
  const scale = px.data instanceof Uint16Array ? 255 / 65535 : 255;
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, px.data[i]! * scale + 0.5));
  return out;
}

export async function segmentMl(px: PixelBuffer, strokes: MlStroke[], signal?: AbortSignal): Promise<MaskBitmap | null> {
  if (signal?.aborted) throw new DOMException('Segmentation cancelled', 'AbortError');
  if (!(await enableMl())) return null;
  const rgba = rgba8(px);
  const job = request({ type: 'segment', width: px.width, height: px.height, rgba, strokes }, [rgba.buffer]);
  let onAbort: (() => void) | undefined;
  const reply = await (signal
    ? Promise.race([
        job,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new DOMException('Segmentation cancelled', 'AbortError'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]).finally(() => onAbort && signal.removeEventListener('abort', onAbort))
    : job);
  if (!reply.data || !reply.width || !reply.height) return null;
  return { width: reply.width, height: reply.height, data: reply.data, key: 'mediapipe-magic-touch-v2' };
}
