/**
 * MediaPipe MagicTouch v2 worker.
 *
 * The encoder/model load is intentionally kept off the UI thread. The model
 * itself is fetched by MediaPipe from Google's official model bucket; no
 * photo pixels leave this worker.
 */
import { InteractiveSegmenter, type Stroke } from '@mediapipe/tasks-vision';
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.js?url';
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_module_internal.wasm?url';

const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/interactive_segmenter_v2/magic_touch/int8/1/interactive_segmentation.task';

type InitRequest = { type: 'init'; id: number };
type SegmentRequest = {
  type: 'segment';
  id: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  strokes: Stroke[];
};
type Request = InitRequest | SegmentRequest;

let taskPromise: Promise<InteractiveSegmenter> | null = null;
let taskCanvas: OffscreenCanvas | null = null;
let inputCanvas: OffscreenCanvas | null = null;

async function createTask(): Promise<InteractiveSegmenter> {
  if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas is unavailable');
  // Keep the WebGL task surface separate from the 2D upload surface: a canvas
  // cannot switch context type after the GPU delegate claims it.
  taskCanvas = new OffscreenCanvas(1, 1);
  inputCanvas = new OffscreenCanvas(1, 1);
  const fileset = { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl };
  try {
    return await InteractiveSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      canvas: taskCanvas,
    });
  } catch (gpuError) {
    // Integrated/older GPUs occasionally reject the delegate. CPU inference is
    // slower, but still considerably more accurate than the heuristic fallback.
    console.warn('[kloud] MediaPipe GPU delegate unavailable; using CPU', gpuError);
    return InteractiveSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
      canvas: taskCanvas,
    });
  }
}

const task = (): Promise<InteractiveSegmenter> => (taskPromise ??= createTask());
const message = (id: number, payload: Record<string, unknown>, transfer: Transferable[] = []) =>
  self.postMessage({ id, ...payload }, { transfer });

self.onmessage = (event: MessageEvent<Request>) => {
  const req = event.data;
  void (async () => {
    try {
      const segmenter = await task();
      if (req.type === 'init') {
        message(req.id, { ok: true, ready: true });
        return;
      }
      if (!inputCanvas) throw new Error('MediaPipe input canvas was not initialized');
      inputCanvas.width = req.width;
      inputCanvas.height = req.height;
      const context = inputCanvas.getContext('2d', { willReadFrequently: false });
      if (!context) throw new Error('Could not create the segmentation canvas');
      // Re-wrap so TypeScript and older engines see an ArrayBuffer-backed view,
      // rather than the wider ArrayBufferLike type accepted by postMessage.
      context.putImageData(new ImageData(new Uint8ClampedArray(req.rgba), req.width, req.height), 0, 0);
      segmenter.setImage(inputCanvas);
      const mask = segmenter.segment(req.strokes);
      const confidence = mask.getAsFloat32Array();
      const data = new Uint8Array(confidence.length);
      for (let i = 0; i < confidence.length; i++) data[i] = Math.max(0, Math.min(255, confidence[i]! * 255 + 0.5)) | 0;
      const width = mask.width;
      const height = mask.height;
      mask.close();
      message(req.id, { ok: true, width, height, data }, [data.buffer]);
    } catch (error) {
      message(req.id, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
};
