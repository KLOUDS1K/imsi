/**
 * Transfer curves of the RGB spaces a file may be tagged with. SourceImage
 * only distinguishes 'srgb' and 'linear' transfer, so data encoded with
 * Adobe RGB (γ 563/256) or ProPhoto/ROMM (γ 1.8 + linear toe) curves is
 * decoded to LINEAR Uint16 here, keeping its primaries for the engine.
 */
import { ADOBE_RGB_GAMMA } from '../color/math';
import type { ColorPrimaries, PixelBuffer } from '../types';
import { fullScale } from './pixels';

/** ROMM RGB (ProPhoto) decode: linear toe below 16·Et, Et = 1/512. */
function rommToLinear(v: number): number {
  return v < 16 / 512 ? v / 16 : Math.pow(v, 1.8);
}

/**
 * Normalize pixels decoded from a file tagged with `prim` so that the
 * (transfer, primaries) pair is expressible by SourceImage.
 */
export function normalizeTransfer(px: PixelBuffer, prim: ColorPrimaries): { px: PixelBuffer; primaries: ColorPrimaries } {
  if (px.transfer === 'linear' || prim === 'srgb' || prim === 'display-p3') return { px, primaries: prim };
  const decode = prim === 'adobe-rgb' ? (v: number) => Math.pow(v, ADOBE_RGB_GAMMA) : rommToLinear;
  const { data } = px;
  const max = fullScale(data);
  if (data instanceof Float32Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i += 4) {
      out[i] = decode(Math.max(0, data[i]));
      out[i + 1] = decode(Math.max(0, data[i + 1]));
      out[i + 2] = decode(Math.max(0, data[i + 2]));
      out[i + 3] = data[i + 3];
    }
    return { px: { ...px, data: out, transfer: 'linear' }, primaries: prim };
  }
  const lut = new Uint16Array(max + 1);
  for (let v = 0; v <= max; v++) lut[v] = Math.round(decode(v / max) * 65535);
  const out = new Uint16Array(data.length);
  const aScale = 65535 / max;
  for (let i = 0; i < data.length; i += 4) {
    out[i] = lut[data[i]];
    out[i + 1] = lut[data[i + 1]];
    out[i + 2] = lut[data[i + 2]];
    out[i + 3] = Math.round(data[i + 3] * aScale);
  }
  return { px: { ...px, data: out, transfer: 'linear' }, primaries: prim };
}
