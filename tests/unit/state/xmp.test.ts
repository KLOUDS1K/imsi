import { describe, expect, it } from 'vitest';
import {
  applyPartial,
  EditorStore,
  kelvinToRelative,
  paramsToXmp,
  parseEditFile,
  readCrsValues,
  relativeToKelvin,
  serializeEditFile,
  xmpToParams,
} from '@/editor/state';
import { parseXml, NS, findAll } from '@/editor/state/xml';
import { createDefaultParams, createMask } from '@/editor/defaults';
import { HSL_CHANNELS, SETTINGS_GROUPS, type EditParams } from '@/editor/types';

const c255 = (...pts: [number, number][]) => pts.map(([x, y]) => ({ x: x / 255, y: y / 255 }));

/** A non-default value in every field that has an XMP mapping. */
function fullyEdited(): EditParams {
  const p = createDefaultParams();
  p.basic = { exposure: 0.35, contrast: 15, highlights: -42, shadows: 33, whites: 7, blacks: -11 };
  p.whiteBalance = { mode: 'custom', temperature: 15, tint: -8 };
  p.color = { vibrance: 18, saturation: -6 };
  HSL_CHANNELS.forEach((ch, i) => (p.hsl[ch] = { hue: i * 3 - 10, saturation: 20 - i * 4, luminance: i * 2 - 7 }));
  p.toneCurve = {
    rgb: c255([0, 18], [64, 60], [192, 200], [255, 245]),
    red: c255([0, 0], [128, 140], [255, 255]),
    green: c255([0, 5], [255, 250]),
    blue: c255([0, 12], [100, 96], [255, 240]),
    parametric: { highlights: -20, lights: 12, darks: 5, shadows: -10, split1: 20, split2: 45, split3: 80 },
  };
  p.colorGrading = {
    shadows: { hue: 195, saturation: 30, luminance: -4 },
    midtones: { hue: 20, saturation: 6, luminance: 3 },
    highlights: { hue: 38, saturation: 28, luminance: 4 },
    global: { hue: 300, saturation: 5, luminance: -2 },
    blending: 40,
    balance: -15,
  };
  p.calibration = { shadowsTint: 4, redHue: -6, redSaturation: 10, greenHue: 3, greenSaturation: -5, blueHue: -12, blueSaturation: 25 };
  p.presence = { texture: 12, clarity: 18, dehaze: 9, structure: 6, localContrast: -4 };
  p.detail = { sharpenAmount: 55, sharpenRadius: 1.3, sharpenDetail: 30, sharpenMasking: 20 };
  p.noise = { luminance: 22, luminanceDetail: 45, luminanceContrast: 12, color: 30, colorDetail: 55, colorSmoothness: 60, aiDenoise: true, aiDenoiseStrength: 70, detailPreservation: 40 };
  p.lens = {
    profileEnabled: true,
    profileId: 'sony-fe-35-f18',
    profileDistortionScale: 80,
    profileVignettingScale: 120,
    distortion: -12,
    vignetting: 20,
    vignettingMidpoint: 40,
    removeCA: true,
    defringe: { purpleAmount: 5, purpleHueMin: 255, purpleHueMax: 345, greenAmount: 3, greenHueMin: 60, greenHueMax: 200 },
  };
  p.transform = { upright: 'vertical', vertical: 15, horizontal: -8, rotate: 1.5, aspect: 10, scale: 95, offsetX: 4.5, offsetY: -3.5 };
  p.crop = { x: 0.05, y: 0.1, w: 0.85, h: 0.8, angle: -2.25, aspect: 'custom', customAspect: [7, 5], orientation: 270, flipH: true, flipV: false, constrainToImage: false, overlay: 'grid' };
  p.effects = {
    vignetteAmount: -18,
    vignetteMidpoint: 40,
    vignetteRoundness: 10,
    vignetteFeather: 65,
    vignetteHighlights: 30,
    grainAmount: 12,
    grainSize: 20,
    grainRoughness: 45,
    bloom: 14,
    bloomThreshold: 63,
    bloomRadius: 72,
    glow: 6,
    halation: 38,
  };
  return p;
}

/** Recursive comparison with numeric tolerance; returns mismatching paths. */
function mismatches(a: unknown, b: unknown, tol: number, path = ''): string[] {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tol ? [] : [`${path}: ${a} != ${b}`];
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return [`${path}: length ${a.length} != ${b.length}`];
    return a.flatMap((v, i) => mismatches(v, b[i], tol, `${path}.${i}`));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((k) => mismatches((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tol, path ? `${path}.${k}` : k));
  }
  return Object.is(a, b) ? [] : [`${path}: ${String(a)} != ${String(b)}`];
}

describe('paramsToXmp → xmpToParams round trip', () => {
  it('restores every mapped field', () => {
    const src = fullyEdited();
    const xml = paramsToXmp(src);
    const read = xmpToParams(xml);
    expect(read.groups).toEqual(SETTINGS_GROUPS.filter((g) => g !== 'masks' && g !== 'retouch'));
    const back = applyPartial(createDefaultParams(), read.params);
    expect(mismatches(back, src, 1e-6)).toEqual([]);
  });

  it('writes a well-formed x:xmpmeta > rdf:RDF > rdf:Description document', () => {
    const xml = paramsToXmp(fullyEdited(), { fileName: 'DSC0001.jpg', format: 'jpeg', make: 'SONY', model: 'ILCE-7M4' });
    const root = parseXml(xml);
    expect(root.children).toHaveLength(1);
    const meta = root.children[0];
    expect([meta.ns, meta.local]).toEqual([NS.x, 'xmpmeta']);
    const rdf = meta.children[0];
    expect([rdf.ns, rdf.local]).toEqual([NS.rdf, 'RDF']);
    const desc = rdf.children[0];
    expect([desc.ns, desc.local]).toEqual([NS.rdf, 'Description']);
    const attr = (k: string) => desc.attrs.find((a) => a.ns === NS.crs && a.local === k)?.value;
    expect(attr('ProcessVersion')).toBe('11.0');
    expect(attr('Exposure2012')).toBe('+0.35');
    expect(attr('Highlights2012')).toBe('-42');
    expect(attr('SharpenRadius')).toBe('+1.3');
    expect(attr('HasSettings')).toBe('True');
    expect(attr('RawFileName')).toBe('DSC0001.jpg');
    expect(attr('IncrementalTemperature')).toBe('+15');
    expect(attr('Temperature')).toBeUndefined();
    expect(attr('PerspectiveVertical')).toBe('-15');
    expect(attr('PerspectiveUpright')).toBe('3');
    const seq = findAll(desc, NS.rdf, 'Seq');
    expect(seq).toHaveLength(4);
    expect(seq[0].children.map((li) => li.text)).toEqual(['0, 18', '64, 60', '192, 200', '255, 245']);
  });

  it('round-trips white balance through Kelvin for RAW files', () => {
    const src = fullyEdited();
    const xml = paramsToXmp(src, { format: 'raw', rawFormat: 'ARW' });
    const v = readCrsValues(xml).crs;
    expect(v.has('IncrementalTemperature')).toBe(false);
    expect(Number(v.get('Temperature'))).toBeGreaterThan(5500);
    const read = xmpToParams(xml).params;
    expect(read.whiteBalance?.temperature).toBeCloseTo(15, 1);
    expect(read.whiteBalance?.tint).toBeCloseTo(-8, 5);
  });

  it('writes As Shot for neutral white balance and restricts groups for partial presets', () => {
    const xml = paramsToXmp(createDefaultParams(), undefined, { name: 'Tone only', groups: ['tone', 'whiteBalance'] });
    const v = readCrsValues(xml).crs;
    expect(v.get('WhiteBalance')).toBe('As Shot');
    expect(v.has('Contrast2012')).toBe(true);
    expect(v.has('Exposure2012')).toBe(false);
    expect(v.has('Vibrance')).toBe(false);
    expect(v.get('PresetType')).toBe('Normal');
    const read = xmpToParams(xml);
    expect(read.name).toBe('Tone only');
    expect(read.groups).toEqual(['tone', 'whiteBalance']);
  });

  it('escapes names and reads them back', () => {
    const xml = paramsToXmp(createDefaultParams(), undefined, { name: 'Rock & "Roll" <1>', group: 'KLOUD', groups: ['color'] });
    const read = xmpToParams(xml);
    expect(read.name).toBe('Rock & "Roll" <1>');
    expect(read.group).toBe('KLOUD');
  });
});

describe('Kelvin conversion', () => {
  it('is monotone and centred on 5500 K', () => {
    expect(kelvinToRelative(5500)).toBeCloseTo(0);
    expect(kelvinToRelative(3200)).toBeLessThan(-50);
    expect(kelvinToRelative(7500)).toBeGreaterThan(10);
    for (const t of [-90, -40, 0, 25, 60]) expect(kelvinToRelative(relativeToKelvin(t))).toBeCloseTo(t, 6);
  });
});

/** Modelled on a Lightroom Classic 13 develop preset export. */
const LR_PRESET = `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0-c000 1.000000, 0000/00/00-00:00:00        ">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   crs:PresetType="Normal"
   crs:Cluster=""
   crs:UUID="4F0A7C3B1E2D4A55B8C9D0E1F2A3B4C5"
   crs:SupportsAmount="True"
   crs:SupportsColor="True"
   crs:SupportsMonochrome="True"
   crs:SupportsHighDynamicRange="True"
   crs:SupportsNormalDynamicRange="True"
   crs:SupportsSceneReferred="True"
   crs:SupportsOutputReferred="True"
   crs:RequiresRGBTables="False"
   crs:CameraModelRestriction=""
   crs:Copyright=""
   crs:ContactInfo=""
   crs:Version="16.0"
   crs:ProcessVersion="11.0"
   crs:WhiteBalance="Custom"
   crs:Temperature="4300"
   crs:Tint="+12"
   crs:Exposure2012="-0.25"
   crs:Contrast2012="+18"
   crs:Highlights2012="-64"
   crs:Shadows2012="+41"
   crs:Whites2012="+9"
   crs:Blacks2012="-14"
   crs:Texture="+10"
   crs:Clarity2012="+22"
   crs:Dehaze="+6"
   crs:Vibrance="+15"
   crs:Saturation="-8"
   crs:ParametricShadows="0"
   crs:ParametricDarks="-6"
   crs:ParametricLights="+4"
   crs:ParametricHighlights="-12"
   crs:ParametricShadowSplit="25"
   crs:ParametricMidtoneSplit="50"
   crs:ParametricHighlightSplit="75"
   crs:Sharpness="40"
   crs:SharpenRadius="+1.0"
   crs:SharpenDetail="25"
   crs:SharpenEdgeMasking="35"
   crs:LuminanceSmoothing="18"
   crs:LuminanceNoiseReductionDetail="50"
   crs:LuminanceNoiseReductionContrast="0"
   crs:ColorNoiseReduction="25"
   crs:ColorNoiseReductionDetail="50"
   crs:ColorNoiseReductionSmoothness="50"
   crs:HueAdjustmentRed="0"
   crs:HueAdjustmentOrange="-5"
   crs:HueAdjustmentYellow="-18"
   crs:HueAdjustmentGreen="+35"
   crs:HueAdjustmentAqua="-10"
   crs:HueAdjustmentBlue="-20"
   crs:HueAdjustmentPurple="0"
   crs:HueAdjustmentMagenta="0"
   crs:SaturationAdjustmentRed="+5"
   crs:SaturationAdjustmentOrange="+12"
   crs:SaturationAdjustmentYellow="-20"
   crs:SaturationAdjustmentGreen="-45"
   crs:SaturationAdjustmentAqua="+10"
   crs:SaturationAdjustmentBlue="+8"
   crs:SaturationAdjustmentPurple="-30"
   crs:SaturationAdjustmentMagenta="-25"
   crs:LuminanceAdjustmentRed="0"
   crs:LuminanceAdjustmentOrange="+6"
   crs:LuminanceAdjustmentYellow="0"
   crs:LuminanceAdjustmentGreen="-12"
   crs:LuminanceAdjustmentAqua="-6"
   crs:LuminanceAdjustmentBlue="-15"
   crs:LuminanceAdjustmentPurple="0"
   crs:LuminanceAdjustmentMagenta="0"
   crs:SplitToningShadowHue="200"
   crs:SplitToningShadowSaturation="25"
   crs:SplitToningHighlightHue="40"
   crs:SplitToningHighlightSaturation="20"
   crs:SplitToningBalance="-10"
   crs:ColorGradeMidtoneHue="30"
   crs:ColorGradeMidtoneSat="5"
   crs:ColorGradeShadowLum="-5"
   crs:ColorGradeMidtoneLum="0"
   crs:ColorGradeHighlightLum="+3"
   crs:ColorGradeBlending="60"
   crs:ColorGradeGlobalHue="0"
   crs:ColorGradeGlobalSat="0"
   crs:ColorGradeGlobalLum="0"
   crs:AutoLateralCA="1"
   crs:LensProfileEnable="1"
   crs:LensManualDistortionAmount="0"
   crs:VignetteAmount="0"
   crs:DefringePurpleAmount="2"
   crs:DefringePurpleHueLo="30"
   crs:DefringePurpleHueHi="70"
   crs:DefringeGreenAmount="0"
   crs:DefringeGreenHueLo="40"
   crs:DefringeGreenHueHi="60"
   crs:PerspectiveUpright="1"
   crs:PostCropVignetteAmount="-15"
   crs:PostCropVignetteMidpoint="45"
   crs:PostCropVignetteFeather="70"
   crs:PostCropVignetteRoundness="0"
   crs:PostCropVignetteStyle="1"
   crs:PostCropVignetteHighlightContrast="20"
   crs:GrainAmount="18"
   crs:GrainSize="25"
   crs:GrainFrequency="50"
   crs:ShadowTint="+3"
   crs:RedHue="+4"
   crs:RedSaturation="+6"
   crs:GreenHue="0"
   crs:GreenSaturation="0"
   crs:BlueHue="-8"
   crs:BlueSaturation="+15"
   crs:ToneCurveName2012="Custom"
   crs:HasSettings="True">
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">KLOUD Night Film</rdf:li>
     <rdf:li xml:lang="ko-KR">클라우드 나이트 필름</rdf:li>
    </rdf:Alt>
   </crs:Name>
   <crs:ShortName>
    <rdf:Alt>
     <rdf:li xml:lang="x-default"/>
    </rdf:Alt>
   </crs:ShortName>
   <crs:Group>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">Film Looks</rdf:li>
    </rdf:Alt>
   </crs:Group>
   <crs:Description>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">Teal shadows &amp; amber highlights</rdf:li>
    </rdf:Alt>
   </crs:Description>
   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 20</rdf:li>
     <rdf:li>64, 58</rdf:li>
     <rdf:li>128, 128</rdf:li>
     <rdf:li>192, 204</rdf:li>
     <rdf:li>255, 245</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>
   <crs:ToneCurvePV2012Red>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012Red>
   <crs:ToneCurvePV2012Green>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012Green>
   <crs:ToneCurvePV2012Blue>
    <rdf:Seq>
     <rdf:li>0, 12</rdf:li>
     <rdf:li>255, 250</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012Blue>
   <crs:Look>
    <rdf:Description
     crs:Name="Adobe Color"
     crs:Amount="1">
     <crs:Parameters>
      <rdf:Description
       crs:Version="16.0"
       crs:ProcessVersion="11.0"
       crs:ConvertToGrayscale="False"
       crs:Exposure2012="+3.00"/>
     </crs:Parameters>
    </rdf:Description>
   </crs:Look>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;

describe('Lightroom Classic preset parsing', () => {
  const r = xmpToParams(LR_PRESET);

  it('reads name, group and the groups present', () => {
    expect(r.name).toBe('KLOUD Night Film');
    expect(r.group).toBe('Film Looks');
    expect(r.conditions).toBeUndefined();
    expect(r.groups).toEqual(['exposure', 'tone', 'whiteBalance', 'color', 'hsl', 'toneCurve', 'colorGrading', 'calibration', 'presence', 'detail', 'noise', 'lens', 'transform', 'effects']);
  });

  it('maps sliders, ignoring nested Look descriptions', () => {
    const p = r.params;
    expect(p.basic).toEqual({ exposure: -0.25, contrast: 18, highlights: -64, shadows: 41, whites: 9, blacks: -14 });
    expect(p.presence).toEqual({ texture: 10, clarity: 22, dehaze: 6 });
    expect(p.color).toEqual({ vibrance: 15, saturation: -8 });
    expect(p.hsl?.green).toEqual({ hue: 35, saturation: -45, luminance: -12 });
    expect(p.hsl?.blue).toEqual({ hue: -20, saturation: 8, luminance: -15 });
    expect(p.detail).toEqual({ sharpenAmount: 40, sharpenRadius: 1, sharpenDetail: 25, sharpenMasking: 35 });
    expect(p.noise?.luminance).toBe(18);
    expect(p.lens).toMatchObject({ profileEnabled: true, removeCA: true, defringe: { purpleAmount: 2, purpleHueMin: 270, purpleHueMax: 330, greenHueMin: 80, greenHueMax: 160 } });
    expect(p.transform?.upright).toBe('auto');
    expect(p.effects).toMatchObject({ vignetteAmount: -15, vignetteMidpoint: 45, vignetteFeather: 70, vignetteHighlights: 20, grainAmount: 18, grainSize: 25, grainRoughness: 50 });
    expect(p.calibration).toEqual({ shadowsTint: 3, redHue: 4, redSaturation: 6, greenHue: 0, greenSaturation: 0, blueHue: -8, blueSaturation: 15 });
    expect(p.toneCurve?.parametric).toEqual({ shadows: 0, darks: -6, lights: 4, highlights: -12, split1: 25, split2: 50, split3: 75 });
  });

  it('reads rdf:Seq tone curves', () => {
    expect(r.params.toneCurve?.rgb).toEqual(c255([0, 20], [64, 58], [128, 128], [192, 204], [255, 245]));
    expect(r.params.toneCurve?.blue).toEqual(c255([0, 12], [255, 250]));
    expect(r.params.toneCurve?.red).toEqual(c255([0, 0], [255, 255]));
  });

  it('merges ColorGrade keys with legacy split toning', () => {
    const g = r.params.colorGrading!;
    expect(g.shadows).toEqual({ hue: 200, saturation: 25, luminance: -5 });
    expect(g.highlights).toEqual({ hue: 40, saturation: 20, luminance: 3 });
    expect(g.midtones).toEqual({ hue: 30, saturation: 5, luminance: 0 });
    expect(g.balance).toBe(-10);
    expect(g.blending).toBe(60);
  });

  it('converts Kelvin white balance approximately', () => {
    const wb = r.params.whiteBalance!;
    expect(wb.mode).toBe('custom');
    expect(wb.temperature).toBeLessThan(-20);
    expect(wb.temperature).toBeGreaterThan(-45);
    expect(wb.tint).toBeCloseTo(8);
  });

  it('applied on top of an edit gives valid params', () => {
    const out = applyPartial(createDefaultParams(true), r.params, r.groups);
    expect(out.basic.exposure).toBe(-0.25);
    expect(out.masks).toEqual([]);
  });
});

describe('XMP variants', () => {
  it('reads element-form values, undeclared prefixes and legacy/grayscale keys', () => {
    const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<!-- comment -->
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/">
  <crs:Exposure2012>+1.10</crs:Exposure2012>
  <crs:Clarity2012>+20</crs:Clarity2012>
  <crs:WhiteBalance>As Shot</crs:WhiteBalance>
  <crs:ConvertToGrayscale>True</crs:ConvertToGrayscale>
  <crs:GrayMixerBlue>-30</crs:GrayMixerBlue>
  <crs:SplitToningHighlightHue>45</crs:SplitToningHighlightHue>
  <crs:ToneCurveName2012>Medium Contrast</crs:ToneCurveName2012>
  <crs:HasCrop>False</crs:HasCrop>
  <crs:Name><rdf:Alt><rdf:li xml:lang="en-US">Mono</rdf:li></rdf:Alt></crs:Name>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const r = xmpToParams(xml);
    expect(r.name).toBe('Mono');
    expect(r.params.basic?.exposure).toBeCloseTo(1.1);
    expect(r.params.presence?.clarity).toBe(20);
    expect(r.params.whiteBalance).toEqual({ mode: 'as-shot', temperature: 0, tint: 0 });
    expect(r.params.color?.saturation).toBe(-100);
    expect(r.params.hsl?.blue?.luminance).toBe(-30);
    expect(r.params.colorGrading?.highlights?.hue).toBe(45);
    expect(r.params.toneCurve?.rgb).toHaveLength(6);
    expect(r.params.crop).toEqual({ x: 0, y: 0, w: 1, h: 1, angle: 0 });
  });

  it('survives garbage', () => {
    for (const s of ['', 'not xml', '<a><b></a>', '<x:xmpmeta><rdf:RDF><rdf:Description crs:Exposure2012="abc"/></rdf:RDF></x:xmpmeta>']) {
      const r = xmpToParams(s);
      expect(r.groups).toEqual([]);
    }
    const r = xmpToParams('<rdf:Description crs:Contrast2012="+500" crs:CameraModelRestriction="ILCE-7M4"/>');
    expect(r.params.basic?.contrast).toBe(100);
    expect(r.conditions).toEqual({ camera: 'ILCE-7M4' });
  });
});

describe('edit sidecar files', () => {
  it('serializeEditFile / parseEditFile round trip', async () => {
    const s = new EditorStore();
    s.set('basic.exposure', 0.5);
    s.update('Add Mask', (d) => d.masks.push(createMask('Mask 1', 'm1')));
    s.createSnapshot('A');
    const blob = serializeEditFile(s.serialize());
    expect(blob.type).toBe('application/json');
    const state = parseEditFile(await blob.text());
    expect(state.params).toEqual(s.params);
    expect(state.history.map((h) => h.label)).toEqual(['Import', 'Exposure +0.50', 'Add Mask']);
    expect(state.historyIndex).toBe(2);
    expect(state.snapshots[0].name).toBe('A');
    const t = new EditorStore();
    t.load(state);
    expect(t.params).toEqual(s.params);
  });

  it('accepts bare params and XMP, rejects garbage', () => {
    const bare = parseEditFile(JSON.stringify({ version: 1, basic: { exposure: 2 } }));
    expect(bare.params.basic.exposure).toBe(2);
    const xmp = parseEditFile(paramsToXmp(fullyEdited()));
    expect(xmp.params.presence.clarity).toBe(18);
    expect(() => parseEditFile('{nope')).toThrow(/Not a KLOUD edit file/);
    expect(() => parseEditFile('[1,2]')).toThrow();
    expect(() => parseEditFile('{"format":"other"}')).toThrow();
  });
});
