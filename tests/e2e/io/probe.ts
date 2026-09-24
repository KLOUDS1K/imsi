import LibRaw from 'libraw-wasm';
import { buildSyntheticDng } from './fixtures';
(window as any).probe = async (oc: number = 4, amt: number = 0, extra: any = {}) => {
  const log: any[] = [];
  log.push({ coi: (self as any).crossOriginIsolated, sab: typeof SharedArrayBuffer });
  const dng = buildSyntheticDng({ width: 64, height: 48 });
  const raw = new LibRaw();
  const t0 = performance.now();
  try {
    await Promise.race([
      raw.open(dng.slice(), { outputBps: 16, noAutoBright: true, useCameraWb: true, userQual: 3, outputColor: oc, adjustMaximumThr: amt, ...extra }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout open')), 20000)),
    ]);
    log.push({ open: performance.now() - t0 });
    const meta = await raw.metadata(true);
    log.push({ meta: JSON.parse(JSON.stringify(meta, (k, v) => (v instanceof Uint8Array ? 'u8:' + v.length : v))) });
    const t1 = performance.now();
    const img = await raw.imageData();
    log.push({ imageData: performance.now() - t1, w: img?.width, h: img?.height, colors: img?.colors, bits: img?.bits, ctor: img?.data?.constructor?.name, len: img?.data?.length });
    const d = img!.data as Uint16Array;
    const W = img!.width;
    const at = (x: number, y: number) => [d[(y * W + x) * 3], d[(y * W + x) * 3 + 1], d[(y * W + x) * 3 + 2]];
    log.push({ tl: at(8, 8), tr: at(W - 8, 8), bl: at(8, img!.height - 8), br: at(W - 8, img!.height - 8) });
    const rawd = await raw.rawImageData();
    log.push({ raw: { rw: rawd?.raw_width, rh: rawd?.raw_height, w: rawd?.width, h: rawd?.height, tm: rawd?.top_margin, lm: rawd?.left_margin, first: Array.from(rawd!.data.slice(0, 4)) } });
    const th = await raw.thumbnailData().catch((e) => 'err ' + e.message);
    log.push({ th: typeof th === 'string' ? th : { w: (th as any)?.width, f: (th as any)?.format } });
  } catch (e) {
    log.push({ error: String(e) });
  }
  return log;
};
(window as any).ready = true;
