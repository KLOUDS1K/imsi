/**
 * Built-in lens profiles. Coefficients are APPROXIMATE (plausible direction
 * and magnitude from published reviews), not measured calibration data.
 *
 * dist:  [focal, k1, k2, k3?] — distortion to REMOVE (negative k1 removes barrel)
 * vig:   [focal, aperture, corner falloff in EV] (negative = darker corners)
 * ca:    [focal, red scale, blue scale] relative to green
 */
import { buildProfile, type LensProfileDef, type LensSpec } from './build';

const SPECS: LensSpec[] = [
  {
    id: 'sony-fe-24-70-gm2', make: 'Sony', model: 'FE 24-70mm F2.8 GM II', mount: 'E',
    match: ['24-70mm F2\\.8 GM II', 'SEL2470GM2'], focal: [24, 70],
    dist: [[24, -0.045, 0.012], [35, -0.008, 0.002], [50, 0.012, -0.002], [70, 0.018, -0.004]],
    vig: [[24, 2.8, -1.4], [50, 2.8, -1.0], [70, 2.8, -1.1]],
    ca: [[24, 1.0004, 0.9996], [70, 1.0002, 0.9998]],
  },
  {
    id: 'sony-fe-24-70-gm', make: 'Sony', model: 'FE 24-70mm F2.8 GM', mount: 'E',
    match: ['24-70mm F2\\.8 GM(?! II)', 'SEL2470GM(?!2)'], focal: [24, 70],
    dist: [[24, -0.055, 0.015], [35, -0.01, 0.003], [70, 0.022, -0.005]],
    vig: [[24, 2.8, -1.6], [70, 2.8, -1.2]],
    ca: [[24, 1.0005, 0.9995], [70, 1.0003, 0.9997]],
  },
  {
    id: 'sony-fe-16-35-gm', make: 'Sony', model: 'FE 16-35mm F2.8 GM', mount: 'E',
    match: ['16-35mm F2\\.8 GM', 'SEL1635GM'], focal: [16, 35],
    dist: [[16, -0.085, 0.03], [24, -0.03, 0.008], [35, 0.01, -0.002]],
    vig: [[16, 2.8, -2.0], [35, 2.8, -1.3]],
    ca: [[16, 1.0007, 0.9993], [35, 1.0003, 0.9997]],
  },
  {
    id: 'sony-fe-85-1.8', make: 'Sony', model: 'FE 85mm F1.8', mount: 'E',
    match: ['FE 85mm F1\\.8', 'SEL85F18'], focal: [85, 85],
    dist: [[85, 0.008, 0]], vig: [[85, 1.8, -1.5]], ca: [[85, 1.0002, 0.9998]],
  },
  {
    id: 'canon-rf-24-70-2.8', make: 'Canon', model: 'RF24-70mm F2.8 L IS USM', mount: 'RF',
    match: ['RF24-70mm F2\\.8'], focal: [24, 70],
    dist: [[24, -0.07, 0.02], [35, -0.015, 0.004], [70, 0.02, -0.004]],
    vig: [[24, 2.8, -2.2], [70, 2.8, -1.4]],
    ca: [[24, 1.0005, 0.9995], [70, 1.0003, 0.9997]],
  },
  {
    id: 'canon-rf-50-1.8', make: 'Canon', model: 'RF50mm F1.8 STM', mount: 'RF',
    match: ['RF50mm F1\\.8'], focal: [50, 50],
    dist: [[50, -0.012, 0.002]], vig: [[50, 1.8, -1.9]], ca: [[50, 1.0003, 0.9997]],
  },
  {
    id: 'nikon-z-24-70-4', make: 'Nikon', model: 'NIKKOR Z 24-70mm f/4 S', mount: 'Z',
    match: ['NIKKOR Z 24-70mm f/4'], focal: [24, 70],
    dist: [[24, -0.06, 0.018], [50, 0.008, -0.001], [70, 0.016, -0.003]],
    vig: [[24, 4, -1.5], [70, 4, -0.9]],
    ca: [[24, 1.0004, 0.9996], [70, 1.0002, 0.9998]],
  },
  {
    id: 'nikon-z-50-1.8-s', make: 'Nikon', model: 'NIKKOR Z 50mm f/1.8 S', mount: 'Z',
    match: ['NIKKOR Z 50mm f/1\\.8'], focal: [50, 50],
    dist: [[50, -0.006, 0.001]], vig: [[50, 1.8, -1.4]], ca: [[50, 1.0002, 0.9998]],
  },
  {
    id: 'fuji-xf-16-55', make: 'Fujifilm', model: 'XF16-55mmF2.8 R LM WR', mount: 'X',
    match: ['XF16-55mm'], focal: [16, 55],
    dist: [[16, -0.06, 0.015], [23, -0.02, 0.004], [55, 0.012, -0.002]],
    vig: [[16, 2.8, -1.3], [55, 2.8, -0.9]],
    ca: [[16, 1.0004, 0.9996], [55, 1.0002, 0.9998]],
  },
  {
    id: 'fuji-xf-23-1.4', make: 'Fujifilm', model: 'XF23mmF1.4 R', mount: 'X',
    match: ['XF23mmF1\\.4'], focal: [23, 23],
    dist: [[23, -0.02, 0.004]], vig: [[23, 1.4, -1.8]], ca: [[23, 1.0004, 0.9996]],
  },
  {
    id: 'sigma-35-dgdn-art', make: 'Sigma', model: '35mm F1.4 DG DN | Art', mount: 'E/L',
    match: ['35mm F1\\.4 DG DN'], focal: [35, 35],
    dist: [[35, -0.015, 0.003]], vig: [[35, 1.4, -2.1]], ca: [[35, 1.0003, 0.9997]],
  },
  {
    id: 'tamron-28-75-g2', make: 'Tamron', model: '28-75mm F/2.8 Di III VXD G2', mount: 'E',
    match: ['28-75mm F/?2\\.8 Di III VXD G2', 'A063'], focal: [28, 75],
    dist: [[28, -0.05, 0.012], [50, 0.012, -0.002], [75, 0.022, -0.004]],
    vig: [[28, 2.8, -1.6], [75, 2.8, -1.3]],
    ca: [[28, 1.0005, 0.9995], [75, 1.0003, 0.9997]],
  },
  {
    id: 'apple-iphone-main', make: 'Apple', model: 'iPhone main camera',
    match: ['iPhone.*back.*(main|wide) camera', 'iPhone.*back (dual|triple) camera 6\\.'], focal: [4, 7],
    bodies: ['Apple iPhone'], eq35: [23, 30],
    dist: [[5, -0.01, 0.002]], vig: [[5, 1.8, -0.5]], ca: [[5, 1.0002, 0.9998]],
  },
  {
    id: 'apple-iphone-ultrawide', make: 'Apple', model: 'iPhone ultra wide camera',
    match: ['iPhone.*ultra wide camera', 'iPhone.*back.*1\\.5[0-9]mm'], focal: [1.5, 2.5],
    bodies: ['Apple iPhone'], eq35: [12, 16],
    dist: [[2, -0.09, 0.03]], vig: [[2, 2.2, -1.0]], ca: [[2, 1.0008, 0.9992]],
  },
  {
    id: 'samsung-galaxy-main', make: 'Samsung', model: 'Galaxy main camera',
    match: ['Galaxy.*(main|wide)'], focal: [5, 8],
    bodies: ['Samsung (SM-|Galaxy)'], eq35: [22, 28],
    dist: [[6, -0.012, 0.002]], vig: [[6, 1.8, -0.6]], ca: [[6, 1.0002, 0.9998]],
  },
  {
    id: 'dji-drone-24', make: 'DJI', model: 'Drone camera (24 mm eq.)',
    match: ['DJI'], focal: [4, 13],
    bodies: ['DJI'], eq35: [20, 28],
    dist: [[7, -0.035, 0.008]], vig: [[7, 2.8, -0.9]], ca: [[7, 1.0004, 0.9996]],
  },
];

/** Fallbacks by 35 mm-equivalent focal length, used when the lens is unknown. */
const GENERIC: LensSpec[] = [
  {
    id: 'generic-zoom', make: 'Generic', model: 'Generic lens (by focal length)', match: [], focal: [10, 400], generic: true,
    dist: [[14, -0.07, 0.02], [18, -0.05, 0.012], [24, -0.03, 0.006], [35, -0.012, 0.002], [50, -0.004, 0], [85, 0.008, 0], [200, 0.012, 0]],
    vig: [[14, 2.8, -1.6], [24, 2.8, -1.1], [50, 2.8, -0.8], [85, 2.8, -0.6], [200, 4, -0.5]],
    ca: [[14, 1.0006, 0.9994], [35, 1.0003, 0.9997], [85, 1.0002, 0.9998], [200, 1.0002, 0.9998]],
  },
];

export const PROFILE_DEFS: LensProfileDef[] = SPECS.map(buildProfile);
export const GENERIC_DEFS: LensProfileDef[] = GENERIC.map(buildProfile);
