/**
 * Lightroom Classic / Camera Raw compatibility (crs: namespace, PV 2012 = "11.0").
 *
 * paramsToXmp writes an XMP sidecar or develop preset; xmpToParams reads
 * sidecars and presets written by Lightroom (attribute form, element form,
 * rdf:Seq tone curves, rdf:Alt names) and by us.
 */
import { createDefaultParams } from '@/editor/defaults';
import { isIdentityCurve } from '@/editor/color/curves';
import type { CurvePoint, EditParams, PartialParams, PhotoMeta, PresetConditions, SettingsGroup } from '@/editor/types';
import { HSL_CHANNELS, SETTINGS_GROUPS } from '@/editor/types';
import { getPath, setPath, type PlainObject } from './paths';
import { toNum } from './normalize';
import { applyPartial, sanitizePartial } from './groups';
import { FIELDS, LR_CHANNELS, NAMED_CURVES, UPRIGHT_CODES, UPRIGHT_FROM_CODE, WB_PRESET_KELVIN, type Field } from './xmp-map';
import { childrenByName, escapeXml, findAll, NS, parseXml, type XmlElement } from './xml';

export const PROCESS_VERSION = '11.0';
export const CRS_VERSION = '15.4';

/* ------------------------------------------------------------------ */
/* White balance: relative ±100 ↔ Kelvin                               */
/* ------------------------------------------------------------------ */

/**
 * Our temperature is relative to "as shot"; Lightroom RAW settings store an
 * absolute Kelvin value. We assume an as-shot of 5500 K and map linearly in
 * mireds (colour shifts are close to linear in 1/T): 0.6 slider units per
 * mired, positive = warmer (a higher Kelvin setting warms the image).
 */
const REF_KELVIN = 5500;
const UNITS_PER_MIRED = 0.6;
const REF_MIRED = 1e6 / REF_KELVIN;
/** Lightroom RAW tint spans ±150; ours ±100. */
const TINT_SCALE = 1.5;

export function kelvinToRelative(kelvin: number): number {
  const k = Math.max(1000, Math.min(60000, kelvin));
  return Math.max(-100, Math.min(100, (REF_MIRED - 1e6 / k) * UNITS_PER_MIRED));
}

export function relativeToKelvin(t: number): number {
  const mired = REF_MIRED - t / UNITS_PER_MIRED;
  return mired <= 20 ? 50000 : Math.max(2000, Math.min(50000, 1e6 / mired));
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export interface XmpWriteOptions {
  /** Writes a develop preset (crs:PresetType, crs:Name…) instead of a sidecar. */
  name?: string;
  group?: string;
  /** Restrict the written settings to these groups (partial preset). */
  groups?: SettingsGroup[];
  uuid?: string;
  conditions?: PresetConditions;
  /** Write kloud: settings that Lightroom does not know (default true). */
  kloudExtensions?: boolean;
}

function fmt(v: number, dec: number, signed: boolean): string {
  const r = Number(v.toFixed(dec));
  const s = (Object.is(r, -0) ? 0 : r).toFixed(dec);
  return signed && r > 0 ? `+${s}` : s;
}

const isRawMeta = (meta?: Partial<PhotoMeta>) => !!meta && (meta.format === 'raw' || !!meta.rawFormat);

function curveSeq(points: CurvePoint[]): string[] {
  const out: string[] = [];
  let lastX = -1;
  for (const p of points) {
    const x = Math.round(Math.max(0, Math.min(1, p.x)) * 255);
    const y = Math.round(Math.max(0, Math.min(1, p.y)) * 255);
    if (x <= lastX) continue;
    out.push(`${x}, ${y}`);
    lastX = x;
  }
  return out;
}

function randomUuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '').toUpperCase();
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s.toUpperCase();
}

export function paramsToXmp(params: EditParams, meta?: Partial<PhotoMeta>, opts: XmpWriteOptions = {}): string {
  const groups = new Set<SettingsGroup>(opts.groups ?? SETTINGS_GROUPS);
  const ext = opts.kloudExtensions !== false;
  const isPreset = opts.name !== undefined;
  const attrs: [string, string][] = [];
  const elements: string[] = [];
  const crs = (k: string, v: string) => attrs.push([`crs:${k}`, v]);

  if (isPreset) {
    crs('PresetType', 'Normal');
    crs('Cluster', '');
    crs('UUID', opts.uuid ?? randomUuid());
    for (const k of ['SupportsAmount', 'SupportsColor', 'SupportsMonochrome', 'SupportsHighDynamicRange', 'SupportsNormalDynamicRange', 'SupportsSceneReferred', 'SupportsOutputReferred'])
      crs(k, 'True');
    crs('RequiresRGBTables', 'False');
    crs('CameraModelRestriction', opts.conditions?.camera ?? '');
    crs('Copyright', '');
    crs('ContactInfo', '');
  }
  crs('Version', CRS_VERSION);
  crs('ProcessVersion', PROCESS_VERSION);

  // White balance
  if (groups.has('whiteBalance')) {
    const wb = params.whiteBalance;
    const neutral = wb.temperature === 0 && wb.tint === 0;
    if (wb.mode === 'as-shot' && neutral) crs('WhiteBalance', 'As Shot');
    else {
      crs('WhiteBalance', wb.mode === 'auto' ? 'Auto' : 'Custom');
      const raw = isRawMeta(meta);
      if (raw || !meta) {
        crs('Temperature', String(Math.round(relativeToKelvin(wb.temperature))));
        crs('Tint', fmt(Math.max(-150, Math.min(150, wb.tint * TINT_SCALE)), 0, true));
      }
      if (!raw) {
        crs('IncrementalTemperature', fmt(wb.temperature, 0, true));
        crs('IncrementalTint', fmt(wb.tint, 0, true));
      }
    }
  }

  // Table-driven fields
  for (const f of FIELDS) {
    if (!groups.has(f.group) || (f.ns === 'kloud' && !ext)) continue;
    const v = getPath(params, f.path);
    const q = `${f.ns}:${f.key}`;
    if (f.t === 'num' && typeof v === 'number') {
      let x = f.to ? f.to(v) : v;
      if (f.range) x = Math.max(f.range[0], Math.min(f.range[1], x));
      attrs.push([q, fmt(x, f.dec, f.signed)]);
    } else if (f.t === 'bool' && typeof v === 'boolean') {
      attrs.push([q, f.style === 'word' ? (v ? 'True' : 'False') : v ? '1' : '0']);
    } else if (f.t === 'str' && typeof v === 'string') {
      attrs.push([q, v]);
    }
  }

  if (groups.has('colorGrading')) {
    // Legacy split toning mirrors (older Lightroom versions read these).
    const g = params.colorGrading;
    crs('SplitToningShadowHue', String(Math.round(g.shadows.hue) % 360));
    crs('SplitToningShadowSaturation', String(Math.round(g.shadows.saturation)));
    crs('SplitToningHighlightHue', String(Math.round(g.highlights.hue) % 360));
    crs('SplitToningHighlightSaturation', String(Math.round(g.highlights.saturation)));
    crs('SplitToningBalance', fmt(g.balance, 0, true));
  }

  if (groups.has('transform')) {
    crs('PerspectiveUpright', UPRIGHT_CODES[params.transform.upright] ?? '0');
    crs('UprightVersion', '151388160');
  }

  if (groups.has('crop')) {
    const c = params.crop;
    const hasCrop = c.x > 1e-6 || c.y > 1e-6 || c.w < 1 - 1e-6 || c.h < 1 - 1e-6 || Math.abs(c.angle) > 1e-6;
    crs('CropTop', fmt(c.y, 6, false));
    crs('CropLeft', fmt(c.x, 6, false));
    crs('CropBottom', fmt(c.y + c.h, 6, false));
    crs('CropRight', fmt(c.x + c.w, 6, false));
    crs('CropAngle', fmt(c.angle, 2, true));
    crs('HasCrop', hasCrop ? 'True' : 'False');
    if (ext) attrs.push(['kloud:CropCustomAspect', `${c.customAspect[0]}:${c.customAspect[1]}`]);
  }

  if (groups.has('effects')) crs('PostCropVignetteStyle', '1');

  if (groups.has('toneCurve')) {
    const tc = params.toneCurve;
    const identity = isIdentityCurve(tc.rgb) && isIdentityCurve(tc.red) && isIdentityCurve(tc.green) && isIdentityCurve(tc.blue);
    crs('ToneCurveName2012', identity ? 'Linear' : 'Custom');
    const seq = (name: string, pts: CurvePoint[]) =>
      elements.push(
        `   <crs:${name}>\n    <rdf:Seq>\n${curveSeq(pts)
          .map((li) => `     <rdf:li>${li}</rdf:li>`)
          .join('\n')}\n    </rdf:Seq>\n   </crs:${name}>`,
      );
    seq('ToneCurvePV2012', tc.rgb);
    seq('ToneCurvePV2012Red', tc.red);
    seq('ToneCurvePV2012Green', tc.green);
    seq('ToneCurvePV2012Blue', tc.blue);
  }

  if (!isPreset) crs('HasSettings', 'True');
  if (meta?.fileName && !isPreset) crs('RawFileName', meta.fileName);

  const alt = (name: string, value: string) =>
    elements.unshift(
      `   <crs:${name}>\n    <rdf:Alt>\n     <rdf:li xml:lang="x-default">${escapeXml(value)}</rdf:li>\n    </rdf:Alt>\n   </crs:${name}>`,
    );
  if (isPreset) {
    if (opts.group) alt('Group', opts.group);
    alt('Name', opts.name ?? '');
  }

  const nsDecl = [
    'xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"',
    ext ? `xmlns:kloud="${NS.kloud}"` : '',
    meta && !isPreset ? `xmlns:tiff="${NS.tiff}"` : '',
    meta && !isPreset ? `xmlns:aux="${NS.aux}"` : '',
    `xmlns:xmp="${NS.xmp}"`,
  ].filter(Boolean);
  const metaAttrs: [string, string][] = [['xmp:CreatorTool', 'KLOUD Studio']];
  if (meta && !isPreset) {
    if (meta.make) metaAttrs.push(['tiff:Make', meta.make]);
    if (meta.model) metaAttrs.push(['tiff:Model', meta.model]);
    if (meta.lens) metaAttrs.push(['aux:Lens', meta.lens]);
  }
  const allAttrs = [...metaAttrs, ...attrs].map(([k, v]) => `   ${k}="${escapeXml(v)}"`);
  const body = elements.length ? `>\n${elements.join('\n')}\n  </rdf:Description>` : '/>';
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="KLOUD Studio">',
    ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    `  <rdf:Description rdf:about=""\n    ${nsDecl.join('\n    ')}\n${allAttrs.join('\n')}${body}`,
    ' </rdf:RDF>',
    '</x:xmpmeta>',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export type XmpValue = string | string[];

/** Raw settings keyed by local name, per namespace (also produced by the .lrtemplate reader). */
export interface CrsValues {
  crs: Map<string, XmpValue>;
  kloud: Map<string, XmpValue>;
}

export interface XmpReadResult {
  params: PartialParams;
  groups: SettingsGroup[];
  name?: string;
  /** crs:Group of a preset. */
  group?: string;
  /** From crs:CameraModelRestriction. */
  conditions?: PresetConditions;
}

function valueOf(el: XmlElement): XmpValue {
  const container = el.children.find((c) => c.ns === NS.rdf && (c.local === 'Seq' || c.local === 'Bag' || c.local === 'Alt'));
  if (container) {
    const lis = childrenByName(container, NS.rdf, 'li');
    if (container.local === 'Alt') {
      const def = lis.find((li) => li.attrs.some((a) => a.local === 'lang' && a.value === 'x-default')) ?? lis[0];
      return def ? def.text.trim() : '';
    }
    return lis.map((li) => li.text.trim());
  }
  return el.text.trim();
}

/** Collect crs:/kloud: settings from every top-level rdf:Description (nested ones belong to Looks/masks). */
export function readCrsValues(xml: string): CrsValues {
  const root = parseXml(xml);
  const out: CrsValues = { crs: new Map(), kloud: new Map() };
  const descs = findAll(root, NS.rdf, 'Description').filter((d) => {
    for (let p = d.parent; p; p = p.parent) if (p.ns === NS.rdf && p.local === 'Description') return false;
    return true;
  });
  for (const d of descs) {
    for (const a of d.attrs) {
      if (a.ns === NS.crs) out.crs.set(a.local, a.value);
      else if (a.ns === NS.kloud) out.kloud.set(a.local, a.value);
    }
    for (const c of d.children) {
      if (c.ns !== NS.crs && c.ns !== NS.kloud) continue;
      // Structured values we do not model (Looks, mask groups) have nested Descriptions.
      if (findAll(c, NS.rdf, 'Description').length > 0) continue;
      (c.ns === NS.crs ? out.crs : out.kloud).set(c.local, valueOf(c));
    }
  }
  return out;
}

export function xmpToParams(xml: string): XmpReadResult {
  return crsValuesToParams(readCrsValues(xml));
}

const scalar = (v: XmpValue | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const parseBool = (v: string | undefined): boolean | undefined => {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
};

function parseCurve(v: XmpValue | undefined): CurvePoint[] | undefined {
  if (v === undefined) return undefined;
  const nums = (Array.isArray(v) ? v.join(',') : v)
    .split(/[\s,;]+/)
    .map((s) => toNum(s))
    .filter((n): n is number => n !== undefined);
  if (nums.length < 4) return undefined;
  const pts: CurvePoint[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i] / 255, y: nums[i + 1] / 255 });
  return pts;
}

/** Convert raw crs:/kloud: values into a sparse, sanitized partial + the groups present. */
export function crsValuesToParams(values: CrsValues): XmpReadResult {
  const { crs, kloud } = values;
  const out: PlainObject = {};
  const groups = new Set<SettingsGroup>();
  const put = (path: string, v: unknown, g: SettingsGroup) => {
    setPath(out, path, v);
    groups.add(g);
  };
  const n = (key: string) => toNum(scalar(crs.get(key)));

  for (const f of FIELDS as Field[]) {
    const raw = scalar((f.ns === 'crs' ? crs : kloud).get(f.key));
    if (raw === undefined) continue;
    if (f.t === 'num') {
      const v = toNum(raw);
      if (v !== undefined) put(f.path, f.from ? f.from(v) : v, f.group);
    } else if (f.t === 'bool') {
      const b = parseBool(raw);
      if (b !== undefined) put(f.path, b, f.group);
    } else if (raw !== '') put(f.path, raw, f.group);
  }

  // White balance
  const wbName = scalar(crs.get('WhiteBalance'));
  const incT = n('IncrementalTemperature');
  const incTint = n('IncrementalTint');
  let kelvin = n('Temperature');
  const lrTint = n('Tint');
  if (wbName !== undefined || incT !== undefined || kelvin !== undefined) {
    if (wbName === 'As Shot') {
      put('whiteBalance', { mode: 'as-shot', temperature: 0, tint: 0 }, 'whiteBalance');
    } else {
      if (kelvin === undefined && wbName && WB_PRESET_KELVIN[wbName]) kelvin = WB_PRESET_KELVIN[wbName];
      const mode = wbName === 'Auto' ? 'auto' : 'custom';
      put('whiteBalance.mode', mode, 'whiteBalance');
      // Incremental values are exact (JPEG-style); prefer them over the Kelvin approximation.
      if (incT !== undefined) put('whiteBalance.temperature', incT, 'whiteBalance');
      else if (kelvin !== undefined) put('whiteBalance.temperature', kelvinToRelative(kelvin), 'whiteBalance');
      if (incTint !== undefined) put('whiteBalance.tint', incTint, 'whiteBalance');
      else if (lrTint !== undefined) put('whiteBalance.tint', lrTint / TINT_SCALE, 'whiteBalance');
    }
  }

  // Tone curves (rdf:Seq of "x, y" in 0..255), or a named PV2012 curve.
  const curveKeys: [string, string][] = [
    ['ToneCurvePV2012', 'rgb'],
    ['ToneCurvePV2012Red', 'red'],
    ['ToneCurvePV2012Green', 'green'],
    ['ToneCurvePV2012Blue', 'blue'],
  ];
  for (const [key, ch] of curveKeys) {
    const pts = parseCurve(crs.get(key));
    if (pts) put(`toneCurve.${ch}`, pts, 'toneCurve');
  }
  const curveName = scalar(crs.get('ToneCurveName2012'));
  if (!crs.has('ToneCurvePV2012') && curveName && NAMED_CURVES[curveName]) {
    put('toneCurve.rgb', NAMED_CURVES[curveName].map(([x, y]) => ({ x: x / 255, y: y / 255 })), 'toneCurve');
  }

  // Legacy split toning (only where Color Grading keys are absent).
  const legacy: [string, string][] = [
    ['SplitToningShadowHue', 'colorGrading.shadows.hue'],
    ['SplitToningShadowSaturation', 'colorGrading.shadows.saturation'],
    ['SplitToningHighlightHue', 'colorGrading.highlights.hue'],
    ['SplitToningHighlightSaturation', 'colorGrading.highlights.saturation'],
    ['SplitToningBalance', 'colorGrading.balance'],
  ];
  for (const [key, path] of legacy) {
    const v = n(key);
    if (v !== undefined && getPath(out, path) === undefined) put(path, v, 'colorGrading');
  }

  // Black & white: Lightroom's grayscale mixer ≈ saturation -100 + HSL luminance per band.
  if (parseBool(scalar(crs.get('ConvertToGrayscale'))) === true) {
    put('color.saturation', -100, 'color');
    HSL_CHANNELS.forEach((ch, i) => {
      const v = n(`GrayMixer${LR_CHANNELS[i]}`);
      if (v !== undefined) put(`hsl.${ch}.luminance`, v, 'hsl');
    });
  }

  // Upright
  const upright = scalar(crs.get('PerspectiveUpright')) ?? scalar(crs.get('UprightTransformMode'));
  if (upright !== undefined && UPRIGHT_FROM_CODE[upright.trim()]) put('transform.upright', UPRIGHT_FROM_CODE[upright.trim()], 'transform');

  // Crop rectangle (edges) + straighten angle
  const hasCrop = parseBool(scalar(crs.get('HasCrop')));
  const top = n('CropTop');
  const left = n('CropLeft');
  const bottom = n('CropBottom');
  const right = n('CropRight');
  const angle = n('CropAngle');
  if (hasCrop === false) {
    put('crop.x', 0, 'crop');
    put('crop.y', 0, 'crop');
    put('crop.w', 1, 'crop');
    put('crop.h', 1, 'crop');
    put('crop.angle', 0, 'crop');
  } else if (top !== undefined || left !== undefined || bottom !== undefined || right !== undefined || angle !== undefined) {
    const l = left ?? 0;
    const t = top ?? 0;
    const r = right ?? 1;
    const b = bottom ?? 1;
    if (r > l && b > t) {
      put('crop.x', l, 'crop');
      put('crop.y', t, 'crop');
      put('crop.w', r - l, 'crop');
      put('crop.h', b - t, 'crop');
    }
    if (angle !== undefined) put('crop.angle', angle, 'crop');
  }
  const custom = scalar(kloud.get('CropCustomAspect'));
  if (custom) {
    const m = /^\s*([\d.]+)\s*[:x/]\s*([\d.]+)\s*$/.exec(custom);
    if (m) put('crop.customAspect', [Number(m[1]), Number(m[2])], 'crop');
  }

  const params = sanitizePartial(out);
  const result: XmpReadResult = { params, groups: SETTINGS_GROUPS.filter((g) => groups.has(g)) };
  const name = scalar(crs.get('Name'));
  if (name) result.name = name;
  const group = scalar(crs.get('Group'));
  if (group) result.group = group;
  const camera = scalar(crs.get('CameraModelRestriction'));
  if (camera) result.conditions = { camera };
  return result;
}

/** Full EditParams from an XMP sidecar (defaults for everything it does not set). */
export function xmpToEditParams(xml: string, isRaw = false): EditParams {
  return applyPartial(createDefaultParams(isRaw), xmpToParams(xml).params);
}
