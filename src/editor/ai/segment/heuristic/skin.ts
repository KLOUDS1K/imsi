/**
 * Skin & face (heuristic).
 *
 * Skin: illumination-normalized (clamped grey-world gains) YCbCr box model
 * (Chai & Ngan ranges, soft edges) × HSV hue/saturation gate, smoothed and
 * cleaned with connected components.
 *
 * Face: skin blobs (cut at the neck by the row-width profile) scored by
 * elliptical shape (moment ellipse fill ratio, aspect, upright orientation),
 * a dark eye/brow feature check in the upper half, and a size prior.
 */
import { boxBlur, smoothstep, type Img } from './image';
import { components, fillHoles, filterComponents, openClose } from './morph';

const band = (v: number, lo: number, hi: number, soft: number) => smoothstep(lo - soft, lo + soft, v) * (1 - smoothstep(hi - soft, hi + soft, v));

export function skinProbability(img: Img): Float32Array {
  const { n, r, g, b } = img;
  // Grey-world gains from mid-tone pixels, clamped so strongly coloured
  // scenes (sunsets, stage light) are only partly neutralized.
  let sr = 0, sg = 0, sb = 0, c = 0;
  for (let i = 0; i < n; i++) {
    const y = 0.299 * r[i]! + 0.587 * g[i]! + 0.114 * b[i]!;
    if (y > 0.15 && y < 0.9) { sr += r[i]!; sg += g[i]!; sb += b[i]!; c++; }
  }
  const gray = c ? (sr + sg + sb) / (3 * c) : 0.5;
  const gain = (s: number) => (c && s > 0 ? Math.max(0.85, Math.min(1.18, gray / (s / c))) : 1);
  const kr = gain(sr), kg = gain(sg), kb = gain(sb);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const R = Math.min(1, r[i]! * kr) * 255, G = Math.min(1, g[i]! * kg) * 255, B = Math.min(1, b[i]! * kb) * 255;
    const Y = 0.299 * R + 0.587 * G + 0.114 * B;
    const Cb = 128 - 0.168736 * R - 0.331264 * G + 0.5 * B;
    const Cr = 128 + 0.5 * R - 0.418688 * G - 0.081312 * B;
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const s = mx > 0 ? (mx - mn) / mx : 0;
    let hue = 0;
    if (mx > mn) {
      if (mx === R) hue = (60 * (G - B)) / (mx - mn);
      else if (mx === G) hue = 60 * (2 + (B - R) / (mx - mn));
      else hue = 60 * (4 + (R - G) / (mx - mn));
    }
    if (hue < 0) hue += 360;
    const hueOk = hue <= 50 ? 1 : hue >= 340 ? 1 : hue < 60 ? 1 - (hue - 50) / 10 : 0;
    const ycc = band(Cb, 80, 125, 5) * band(Cr, 135, 172, 5);
    const sat = band(s, 0.12, 0.72, 0.05);
    const lum = smoothstep(35, 60, Y) * (R > G ? 1 : 0.3);
    p[i] = ycc * sat * hueOk * lum;
  }
  return p;
}

/** Binary skin at work resolution. */
export function skinMask(img: Img, prob = skinProbability(img)): Uint8Array {
  const { w, h, n } = img;
  const sm = boxBlur(prob, w, h, 1);
  const bin = new Uint8Array(n);
  for (let i = 0; i < n; i++) bin[i] = sm[i]! > 0.4 ? 1 : 0;
  const clean = openClose(bin, w, h, 1);
  return filterComponents(clean, w, h, (c) => c.area >= Math.max(6, n * 0.0004));
}

export interface Face {
  /** Ellipse in work-resolution pixels; angle in radians from the x axis. */
  cx: number;
  cy: number;
  /** semi-axes: a = vertical extent, b = horizontal half-width (upright faces). */
  a: number;
  b: number;
  angle: number;
  score: number;
}

/** Moment ellipse of the pixels of `labels === label` within rows [y0, y1]. */
function momentEllipse(labels: Int32Array, label: number, w: number, x0: number, x1: number, y0: number, y1: number) {
  let n = 0, sx = 0, sy = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (labels[y * w + x] === label) { n++; sx += x; sy += y; }
  if (!n) return null;
  const mx = sx / n, my = sy / n;
  let cxx = 0, cyy = 0, cxy = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (labels[y * w + x] === label) {
        const dx = x - mx, dy = y - my;
        cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
      }
  cxx /= n; cyy /= n; cxy /= n;
  const tr = cxx + cyy, det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
  // Major-axis direction.
  const angle = Math.abs(cxy) > 1e-9 ? Math.atan2(l1 - cxx, cxy) : cxx >= cyy ? 0 : Math.PI / 2;
  return { n, mx, my, major: 2 * Math.sqrt(l1), minor: 2 * Math.sqrt(l2), angle };
}

export function detectFaces(img: Img, skin: Uint8Array): Face[] {
  const { w, h, n, L } = img;
  const filled = fillHoles(skin, w, h, n * 0.02);
  const { labels, comps } = components(filled, w, h);
  const faces: Face[] = [];
  for (const c of comps) {
    if (c.area < n * 0.001 || c.area > n * 0.6) continue;
    // Cut the blob at the neck: first row (below a face-sized top part) whose
    // width is < 70% of the widest row above it and then widens again.
    const rows: number[] = [];
    for (let y = c.y0; y <= c.y1; y++) {
      let cnt = 0;
      for (let x = c.x0; x <= c.x1; x++) if (labels[y * w + x] === c.label) cnt++;
      rows.push(cnt);
    }
    let cut = c.y1;
    let widest = 0;
    for (let k = 0; k < rows.length; k++) {
      widest = Math.max(widest, rows[k]!);
      if (k > widest * 0.9 && rows[k]! < widest * 0.7) {
        const after = rows.slice(k, k + Math.max(3, Math.round(widest * 0.6)));
        if (after.some((v) => v > rows[k]! * 1.25) || k > widest * 1.6) {
          cut = c.y0 + k;
          break;
        }
      }
    }
    const e = momentEllipse(labels, c.label, w, c.x0, c.x1, c.y0, cut);
    if (!e || e.n < n * 0.0008) continue;
    const area = Math.PI * e.major * e.minor;
    const fill = e.n / Math.max(1, area);
    const aspect = e.major / Math.max(1e-6, e.minor);
    const tilt = Math.abs(Math.abs(e.angle) - Math.PI / 2); // 0 = upright major axis
    const shape =
      band(fill, 0.72, 1.25, 0.1) * band(aspect, 1.0, 1.9, 0.2) * (aspect < 1.15 ? 1 : 1 - smoothstep(0.5, 0.9, tilt));
    // Eye/brow check: dark (vs. the blob's mean lightness) pixels in the upper
    // half of the ellipse, balanced left/right.
    let meanL = 0;
    let cnt = 0;
    const x0 = Math.max(0, Math.floor(e.mx - e.minor)), x1 = Math.min(w - 1, Math.ceil(e.mx + e.minor));
    const y0 = Math.max(0, Math.floor(e.my - e.major)), y1 = Math.min(h - 1, Math.ceil(e.my + e.major));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (labels[y * w + x] === c.label) { meanL += L[y * w + x]!; cnt++; }
    meanL /= Math.max(1, cnt);
    let darkL = 0, darkR = 0, upper = 0;
    for (let y = Math.max(0, Math.floor(e.my - e.major * 0.6)); y <= e.my; y++)
      for (let x = x0; x <= x1; x++) {
        const dx = (x - e.mx) / e.minor, dy = (y - e.my) / e.major;
        if (dx * dx + dy * dy > 0.8) continue;
        upper++;
        if (L[y * w + x]! < meanL * 0.78) {
          if (x < e.mx) darkL++;
          else darkR++;
        }
      }
    const darkFrac = (darkL + darkR) / Math.max(1, upper);
    const balance = darkL + darkR > 0 ? Math.min(darkL, darkR) / Math.max(darkL, darkR) : 0;
    const eyes = band(darkFrac, 0.02, 0.3, 0.015) * smoothstep(0.15, 0.5, balance);
    const size = smoothstep(n * 0.0008, n * 0.004, e.n) * (1 - smoothstep(n * 0.35, n * 0.6, e.n));
    const score = 0.55 * shape + 0.3 * eyes + 0.15 * size;
    if (score >= 0.5 && shape >= 0.4) {
      faces.push({ cx: e.mx, cy: e.my, a: e.major * 1.08, b: e.minor * 1.05, angle: e.angle, score });
    }
  }
  return faces.sort((p, q) => q.score - p.score);
}

/** Soft ellipse rasterization (work resolution). */
export function ellipseMask(w: number, h: number, faces: Face[], scaleA = 1, scaleB = 1, offsetY = 0): Float32Array {
  const out = new Float32Array(w * h);
  for (const f of faces) {
    const a = f.a * scaleA, b = f.b * scaleB;
    const cy = f.cy + offsetY * f.a;
    // Major axis is ~vertical for upright faces: use a (vertical) and b (horizontal).
    const R = Math.max(a, b) + 2;
    for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(h, Math.ceil(cy + R)); y++)
      for (let x = Math.max(0, Math.floor(f.cx - R)); x < Math.min(w, Math.ceil(f.cx + R)); x++) {
        const dx = (x + 0.5 - f.cx) / b, dy = (y + 0.5 - cy) / a;
        const d = Math.sqrt(dx * dx + dy * dy);
        const v = 1 - smoothstep(0.92, 1.05, d);
        const i = y * w + x;
        if (v > out[i]!) out[i] = v;
      }
  }
  return out;
}
