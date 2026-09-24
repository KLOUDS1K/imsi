/**
 * Camera display names: EXIF Make/Model → what photographers call the body,
 * e.g. SONY / ILCE-7M4 → "Sony α7 IV (ILCE-7M4)", NIKON CORPORATION /
 * NIKON Z 6_2 → "Nikon Z6 II", samsung / SM-S918B → "Samsung Galaxy S23 Ultra
 * (SM-S918B)". Unknown bodies fall back to "<Brand> <Model>" with the brand
 * de-duplicated and corporate suffixes removed.
 */

const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const roman = (n: number): string => ROMAN[n] ?? String(n);

const BRANDS: [RegExp, string][] = [
  [/^sony/i, 'Sony'],
  [/^canon/i, 'Canon'],
  [/^nikon/i, 'Nikon'],
  [/^fuji/i, 'Fujifilm'],
  [/^apple/i, 'Apple'],
  [/^samsung/i, 'Samsung'],
  [/^google/i, 'Google'],
  [/^(dji|hasselblad.*dji)/i, 'DJI'],
  [/^hasselblad/i, 'Hasselblad'],
  [/^panasonic/i, 'Panasonic'],
  [/^leica/i, 'Leica'],
  [/^(olympus|om digital)/i, 'OM System'],
  [/^ricoh/i, 'Ricoh'],
  [/^pentax/i, 'Pentax'],
  [/^gopro/i, 'GoPro'],
  [/^xiaomi/i, 'Xiaomi'],
  [/^huawei/i, 'Huawei'],
  [/^oneplus/i, 'OnePlus'],
  [/^sigma/i, 'Sigma'],
  [/^insta360|^arashi/i, 'Insta360'],
];

/** Samsung model codes (first 4 chars after "SM-") → Galaxy names. */
const SAMSUNG: Record<string, string> = {
  S901: 'Galaxy S22', S906: 'Galaxy S22+', S908: 'Galaxy S22 Ultra',
  S911: 'Galaxy S23', S916: 'Galaxy S23+', S918: 'Galaxy S23 Ultra', S711: 'Galaxy S23 FE',
  S921: 'Galaxy S24', S926: 'Galaxy S24+', S928: 'Galaxy S24 Ultra', S721: 'Galaxy S24 FE',
  S931: 'Galaxy S25', S936: 'Galaxy S25+', S938: 'Galaxy S25 Ultra', S937: 'Galaxy S25 Edge',
  G991: 'Galaxy S21', G996: 'Galaxy S21+', G998: 'Galaxy S21 Ultra', G990: 'Galaxy S21 FE',
  G981: 'Galaxy S20', G986: 'Galaxy S20+', G988: 'Galaxy S20 Ultra', G780: 'Galaxy S20 FE',
  G973: 'Galaxy S10', G975: 'Galaxy S10+', G970: 'Galaxy S10e',
  N981: 'Galaxy Note20', N986: 'Galaxy Note20 Ultra', N970: 'Galaxy Note10', N975: 'Galaxy Note10+',
  F936: 'Galaxy Z Fold4', F946: 'Galaxy Z Fold5', F956: 'Galaxy Z Fold6', F966: 'Galaxy Z Fold7',
  F721: 'Galaxy Z Flip4', F731: 'Galaxy Z Flip5', F741: 'Galaxy Z Flip6', F766: 'Galaxy Z Flip7',
  A536: 'Galaxy A53', A546: 'Galaxy A54', A556: 'Galaxy A55', A566: 'Galaxy A56',
  A346: 'Galaxy A34', A356: 'Galaxy A35', A256: 'Galaxy A25',
};

/** DJI camera codes (Model tag) → aircraft names. */
const DJI: Record<string, string> = {
  FC3582: 'Mini 3 Pro', FC3682: 'Mini 3', FC8482: 'Mini 4 Pro', FC7303: 'Mini 2', FC7203: 'Mavic Mini',
  FC3411: 'Air 2S', FC3170: 'Mavic Air 2', FC2103: 'Mavic Air', FC4382: 'Air 3', FC8671: 'Air 3S',
  'L2D-20C': 'Mavic 3', 'L1D-20C': 'Mavic 2 Pro', FC2204: 'Mavic 2 Zoom', FC220: 'Mavic Pro',
  FC6310: 'Phantom 4 Pro', FC6310S: 'Phantom 4 Pro V2.0', FC330: 'Phantom 4', FC4170: 'Mavic 3 Classic',
  FC9113: 'Mini 4K', FC4280: 'Avata 2', FC3582S: 'Mini 3 Pro', 'L3D-20C': 'Mavic 4 Pro',
};

/** Fixed names that do not follow a pattern. */
const SONY_FIXED: Record<string, string> = {
  'ILCE-QX1': 'QX1',
  'ILME-FX3': 'FX3',
  'ILME-FX30': 'FX30',
  'ILME-FX6': 'FX6',
  'ILME-FX2': 'FX2',
};

export function normalizeBrand(make: string | undefined): string {
  const m = (make ?? '').trim();
  if (!m) return '';
  for (const [re, name] of BRANDS) if (re.test(m)) return name;
  // Strip corporate suffixes and title-case ALL-CAPS makes.
  const cleaned = m
    .replace(/\b(corporation|corp\.?|co\.?,?\s*ltd\.?|ltd\.?|inc\.?|imaging|optical|digital solutions|company)\b/gi, '')
    .replace(/[\s,.]+$/, '')
    .trim();
  return cleaned === cleaned.toUpperCase() && cleaned.length > 3 ? cleaned.charAt(0) + cleaned.slice(1).toLowerCase() : cleaned;
}

/** "Sony α7 IV" style name of an ILCE/ILME/DSC code, or null. */
function sonyName(model: string): string | null {
  const m = model.toUpperCase().replace(/\s+/g, '');
  if (SONY_FIXED[m]) return SONY_FIXED[m];
  let r = /^ILCE-(\d+)([A-Z]*?)(?:M(\d+))?(A)?$/.exec(m);
  if (r) return `α${r[1]}${r[2]}${r[3] ? ' ' + roman(Number(r[3])) : ''}${r[4] ? (r[3] ? 'A' : ' A') : ''}`;
  r = /^DSC-(RX\d+)([A-Z]*?)(?:M(\d+))?(A)?$/.exec(m);
  if (r) return `${r[1]}${r[2]}${r[3] ? ' ' + roman(Number(r[3])) : ''}${r[4] ?? ''}`;
  r = /^(ZV-E\d+|ZV-\d+)(?:M(\d+))?$/.exec(m);
  if (r) return `${r[1]}${r[2] ? ' ' + roman(Number(r[2])) : ''}`;
  r = /^SLT-A(\d+)$/.exec(m);
  if (r) return `α${r[1]}`;
  r = /^ILCA-(\d+)(M(\d+))?$/.exec(m);
  if (r) return `α${r[1]}${r[3] ? ' ' + roman(Number(r[3])) : ''}`;
  return null;
}

function nikonName(model: string): string {
  let s = model.replace(/^nikon\s*/i, '').trim();
  // "Z 6_2" → "Z6 II", "Z 8" → "Z8", "Z f" → "Zf", "Z fc" → "Zfc"
  s = s.replace(/^Z\s+/i, 'Z').replace(/_(\d)$/, (_, d: string) => ' ' + roman(Number(d)));
  return s;
}

function canonName(model: string): string {
  return model.replace(/^canon\s*/i, '').replace(/\s+/g, ' ').trim();
}

function fujiName(model: string): string {
  return model.replace(/^fujifilm\s*/i, '').trim();
}

function panasonicName(model: string): string {
  // DC-S5M2 → Lumix S5 II, DC-G9M2 → Lumix G9 II, DC-GH6 → Lumix GH6
  const m = /^(?:DC|DMC)-([A-Z]+\d+[A-Z]*?)(?:M(\d))?(X)?$/i.exec(model.trim());
  if (m) return `Lumix ${m[1].toUpperCase()}${m[2] ? ' ' + roman(Number(m[2])) : ''}${m[3] ? 'X' : ''}`;
  return model.trim();
}

/**
 * Human-readable camera name. When the marketing name differs from the EXIF
 * code (Sony, Samsung, DJI), the code is kept in parentheses so users can
 * still search for it.
 */
export function normalizeCameraName(make: string | undefined, model: string | undefined): string | undefined {
  const brand = normalizeBrand(make);
  const rawModel = (model ?? '').replace(/\0/g, '').trim();
  if (!brand && !rawModel) return undefined;
  if (!rawModel) return brand || undefined;
  const code = rawModel;
  const withCode = (name: string): string => (name.toUpperCase() === code.toUpperCase() ? `${brand} ${name}` : `${brand} ${name} (${code})`);
  switch (brand) {
    case 'Sony': {
      const n = sonyName(code);
      return n ? withCode(n) : `Sony ${code.replace(/^sony\s*/i, '')}`;
    }
    case 'Nikon':
      return `Nikon ${nikonName(code)}`;
    case 'Canon':
      return `Canon ${canonName(code)}`;
    case 'Fujifilm':
      return `Fujifilm ${fujiName(code)}`;
    case 'Samsung': {
      const m = /^SM-([A-Z]\d{3})/i.exec(code);
      const n = m ? SAMSUNG[m[1].toUpperCase()] : undefined;
      if (n) return withCode(n);
      return `Samsung ${code.replace(/^samsung\s*/i, '')}`;
    }
    case 'Apple':
      return code.replace(/^apple\s*/i, '').startsWith('iPhone') || code.startsWith('iPad') ? `Apple ${code.replace(/^apple\s*/i, '')}` : `Apple ${code}`;
    case 'Google':
      return `Google ${code.replace(/^google\s*/i, '')}`;
    case 'DJI': {
      const n = DJI[code.toUpperCase()];
      return n ? withCode(n) : `DJI ${code.replace(/^dji\s*/i, '')}`;
    }
    case 'Panasonic':
      return `Panasonic ${panasonicName(code)}`;
    default: {
      if (!brand) return code;
      const stripped = code.toLowerCase().startsWith(brand.toLowerCase()) ? code.slice(brand.length).trim() : code;
      return stripped ? `${brand} ${stripped}` : brand;
    }
  }
}
