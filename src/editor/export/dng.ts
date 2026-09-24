/**
 * Rendered "linear DNG" writer.
 *
 * IMPORTANT: this is NOT the original sensor data. It stores the fully rendered
 * edit (after every adjustment, crop and watermark), linearized back to scene-
 * linear 16-bit RGB, as PhotometricInterpretation 34892 (LinearRaw) with three
 * samples per pixel — the same kind of file Adobe's DNG Converter writes for
 * demosaiced data. Raw converters can re-open it with a wide editing latitude,
 * but the camera's mosaic, noise profile and original white balance are gone.
 *
 * Layout (standard DNG): IFD0 = 8-bit RGB preview (NewSubFileType 1) carrying
 * all DNG/EXIF tags, SubIFD = the full-size 16-bit LinearRaw image.
 *
 * Colour: the "camera" space is the export space's linear RGB (linear sRGB by
 * default). ColorMatrix1 is therefore simply XYZ(D65) → linear RGB, with
 * CalibrationIlluminant1 = 21 (D65) and AsShotNeutral = 1 1 1 (the rendered
 * white is already neutral). BaselineExposure 0.
 */
import type { ExportColorSpace } from '@/editor/types';
import { invert3, linearizeLut, rgbToXyzMatrix } from './colorimetry';
import { metadataIfd, type MetadataBlocks } from './metadata';
import { assembleTiff, buildStrips, imageTags, type StripOptions } from './tiff';
import { ascii, bytes, long, rationalRaw, short, srationalRaw, type IfdNode, type TiffTag } from './tiff-ifd';

export const DNG_PREVIEW_MAX = 256;

export interface DngEncodeOptions {
  colorSpace: ExportColorSpace;
  metadata: MetadataBlocks;
  /** UniqueCameraModel; defaults to a KLOUD Studio identifier. */
  cameraModel?: string;
}

const PREVIEW_CS: Record<ExportColorSpace, number> = { srgb: 2, 'adobe-rgb': 3, 'display-p3': 0 };

/** Area-average downscale of RGBA (8- or 16-bit) to an opaque 8-bit RGBA preview. */
export function downscalePreview(
  src: Uint8ClampedArray | Uint16Array | Uint8Array,
  w: number,
  h: number,
  bits: 8 | 16,
  maxEdge = DNG_PREVIEW_MAX,
): { data: Uint8Array; width: number; height: number } {
  const s = Math.min(1, maxEdge / Math.max(w, h));
  const pw = Math.max(1, Math.round(w * s));
  const ph = Math.max(1, Math.round(h * s));
  const out = new Uint8Array(pw * ph * 4);
  const norm = bits === 16 ? 1 / 257 : 1;
  for (let py = 0; py < ph; py++) {
    const y0 = Math.floor((py * h) / ph);
    const y1 = Math.max(y0 + 1, Math.floor(((py + 1) * h) / ph));
    for (let px = 0; px < pw; px++) {
      const x0 = Math.floor((px * w) / pw);
      const x1 = Math.max(x0 + 1, Math.floor(((px + 1) * w) / pw));
      let r = 0, g = 0, b = 0;
      for (let y = y0; y < y1; y++) {
        let i = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, i += 4) {
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
        }
      }
      const k = norm / ((y1 - y0) * (x1 - x0));
      const o = (py * pw + px) * 4;
      out[o] = Math.round(r * k);
      out[o + 1] = Math.round(g * k);
      out[o + 2] = Math.round(b * k);
      out[o + 3] = 255;
    }
  }
  return { data: out, width: pw, height: ph };
}

/** Matrix → SRATIONAL pairs with a fixed 10000 denominator (the usual DNG convention). */
const matPairs = (m: number[]) => m.flatMap((v) => [Math.round(v * 10000), 10000]);

export function encodeDng(
  data: Uint8ClampedArray | Uint16Array | Uint8Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
  opts: DngEncodeOptions,
): Uint8Array {
  if (data.length !== width * height * 4) throw new Error('DNG: data length does not match RGBA size');

  // ---- main image: linearized 16-bit LinearRaw ----
  const mainOpts: StripOptions = { width, height, spp: 3, bits: 16, compression: 1, predictor: false, lut: linearizeLut(opts.colorSpace, bitDepth) };
  const mainStrips = buildStrips(data, mainOpts);
  const main: IfdNode = {
    tags: [
      ...imageTags(mainOpts, mainStrips, 34892, 0),
      long(50717, 65535, 65535, 65535), // WhiteLevel
      long(50719, 0, 0), // DefaultCropOrigin
      long(50720, width, height), // DefaultCropSize
    ],
  };

  // ---- IFD0: 8-bit preview + DNG tags ----
  const pv = downscalePreview(data, width, height, bitDepth);
  const pvOpts: StripOptions = { width: pv.width, height: pv.height, spp: 3, bits: 8, compression: 1, predictor: false };
  const pvStrips = buildStrips(pv.data, pvOpts);
  const colorMatrix = invert3(rgbToXyzMatrix(opts.colorSpace)); // XYZ(D65) → camera (= linear export RGB)
  const dngTags: TiffTag[] = [
    ...imageTags(pvOpts, pvStrips, 2, 1),
    bytes(50706, [1, 4, 0, 0]), // DNGVersion
    bytes(50707, [1, 1, 0, 0]), // DNGBackwardVersion
    ascii(50708, opts.cameraModel || `KLOUD Studio Rendered Linear ${opts.colorSpace}`), // UniqueCameraModel
    srationalRaw(50721, matPairs(colorMatrix)), // ColorMatrix1
    rationalRaw(50728, [1, 1, 1, 1, 1, 1]), // AsShotNeutral
    srationalRaw(50730, [0, 1]), // BaselineExposure
    short(50778, 21), // CalibrationIlluminant1 = D65
    long(50970, PREVIEW_CS[opts.colorSpace]), // PreviewColorSpace
  ];
  if (opts.metadata.xmp) dngTags.push(bytes(700, new TextEncoder().encode(opts.metadata.xmp)));
  const ifd0 = metadataIfd(opts.metadata, dngTags);
  ifd0.children = [...(ifd0.children ?? []), { tag: 330, nodes: [main] }];

  return assembleTiff([ifd0], [
    { node: ifd0, strips: pvStrips.strips },
    { node: main, strips: mainStrips.strips },
  ]);
}
