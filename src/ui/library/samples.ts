/**
 * Procedurally painted demo photos, so the editor can be explored without
 * importing anything (e.g. on a phone). Each is a JPEG File with EXIF.
 */
import { buildExifSegment, insertExif, type SampleExif } from './sample-exif';

const W = 2000;
const H = 1333;

type Painter = (g: CanvasRenderingContext2D) => void;

function rand(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function glow(g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha = 1): void {
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalAlpha = alpha;
  g.fillStyle = grad;
  g.fillRect(x - r, y - r, r * 2, r * 2);
  g.globalAlpha = 1;
}

/** Dusk city street with a car under street lights. */
const cityDusk: Painter = (g) => {
  const r = rand(7);
  const sky = g.createLinearGradient(0, 0, 0, H * 0.62);
  sky.addColorStop(0, '#1b2a4a');
  sky.addColorStop(0.55, '#5b4a78');
  sky.addColorStop(0.85, '#e0875a');
  sky.addColorStop(1, '#f2b36b');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  // skyline
  let x = 0;
  while (x < W) {
    const bw = 60 + r() * 140;
    const bh = H * (0.18 + r() * 0.32);
    const top = H * 0.62 - bh;
    g.fillStyle = `rgb(${22 + r() * 18},${24 + r() * 16},${38 + r() * 20})`;
    g.fillRect(x, top, bw, bh);
    for (let wy = top + 12; wy < H * 0.6; wy += 18) {
      for (let wx = x + 8; wx < x + bw - 10; wx += 16) {
        if (r() < 0.35) {
          g.fillStyle = r() < 0.7 ? 'rgba(255,196,120,0.85)' : 'rgba(170,210,255,0.8)';
          g.fillRect(wx, wy, 7, 9);
        }
      }
    }
    x += bw + 4;
  }
  // road
  const road = g.createLinearGradient(0, H * 0.62, 0, H);
  road.addColorStop(0, '#2a2833');
  road.addColorStop(1, '#121117');
  g.fillStyle = road;
  g.fillRect(0, H * 0.62, W, H * 0.38);
  g.strokeStyle = 'rgba(255,220,150,0.55)';
  g.lineWidth = 6;
  for (let i = 0; i < 9; i++) {
    const t = i / 9;
    const y0 = H * 0.64 + t * t * H * 0.36;
    g.beginPath();
    g.moveTo(W * 0.5 - 10 * (1 + t * 6), y0);
    g.lineTo(W * 0.5 - 10 * (1 + t * 6) - 4 * (1 + t * 8), y0 + 14 + t * 30);
    g.stroke();
  }
  // street lights
  for (const lx of [W * 0.12, W * 0.34, W * 0.72, W * 0.9]) {
    g.fillStyle = '#0d0d12';
    g.fillRect(lx - 4, H * 0.3, 8, H * 0.34);
    glow(g, lx, H * 0.3, 180, 'rgba(255,190,110,0.55)');
    glow(g, lx, H * 0.3, 26, 'rgba(255,245,220,1)');
  }
  // car
  const cx = W * 0.56;
  const cy = H * 0.8;
  g.fillStyle = '#0c0f16';
  g.beginPath();
  g.moveTo(cx - 330, cy + 40);
  g.quadraticCurveTo(cx - 320, cy - 40, cx - 200, cy - 60);
  g.quadraticCurveTo(cx - 90, cy - 150, cx + 70, cy - 140);
  g.quadraticCurveTo(cx + 190, cy - 130, cx + 250, cy - 60);
  g.quadraticCurveTo(cx + 340, cy - 45, cx + 345, cy + 40);
  g.closePath();
  g.fill();
  g.fillStyle = 'rgba(120,150,190,0.35)';
  g.beginPath();
  g.moveTo(cx - 150, cy - 70);
  g.quadraticCurveTo(cx - 70, cy - 132, cx + 60, cy - 126);
  g.lineTo(cx + 170, cy - 70);
  g.closePath();
  g.fill();
  for (const wx of [cx - 210, cx + 210]) {
    g.fillStyle = '#050507';
    g.beginPath();
    g.arc(wx, cy + 40, 58, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3a3d46';
    g.beginPath();
    g.arc(wx, cy + 40, 26, 0, Math.PI * 2);
    g.fill();
  }
  glow(g, cx + 330, cy - 20, 150, 'rgba(255,245,225,0.75)');
  glow(g, cx + 330, cy - 20, 22, 'rgba(255,255,255,1)');
  glow(g, cx - 320, cy - 18, 90, 'rgba(255,40,40,0.65)');
};

/** Mountain lake landscape with sky and clouds. */
const mountainLake: Painter = (g) => {
  const r = rand(21);
  const sky = g.createLinearGradient(0, 0, 0, H * 0.55);
  sky.addColorStop(0, '#2f6fb8');
  sky.addColorStop(1, '#a9cdee');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 26; i++) {
    const x = r() * W;
    const y = H * (0.08 + r() * 0.25);
    glow(g, x, y, 90 + r() * 140, 'rgba(255,255,255,0.55)', 0.8);
  }
  const ridge = (base: number, amp: number, color: string, seed: number) => {
    const rr = rand(seed);
    g.fillStyle = color;
    g.beginPath();
    g.moveTo(0, H);
    let y = base;
    for (let x = 0; x <= W; x += 20) {
      y += (rr() - 0.5) * amp;
      y = Math.max(base - amp * 6, Math.min(base + amp * 2, y));
      g.lineTo(x, y);
    }
    g.lineTo(W, H);
    g.closePath();
    g.fill();
  };
  ridge(H * 0.42, 22, '#6d86a6', 3);
  ridge(H * 0.48, 26, '#4c6380', 5);
  // snow caps
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(0, H * 0.36, W, H * 0.02);
  ridge(H * 0.54, 18, '#2f4a3c', 9);
  // lake
  const lake = g.createLinearGradient(0, H * 0.6, 0, H);
  lake.addColorStop(0, '#5f8fb5');
  lake.addColorStop(1, '#23405a');
  g.fillStyle = lake;
  g.fillRect(0, H * 0.6, W, H * 0.4);
  g.save();
  g.globalAlpha = 0.35;
  g.translate(0, H * 1.2);
  g.scale(1, -1);
  ridge(H * 0.54, 18, '#2f4a3c', 9);
  g.restore();
  // shore + trees
  g.fillStyle = '#3f5a2c';
  g.fillRect(0, H * 0.86, W, H * 0.14);
  for (let i = 0; i < 70; i++) {
    const tx = r() * W;
    const th = 60 + r() * 120;
    g.fillStyle = `rgb(${30 + r() * 20},${60 + r() * 30},${35 + r() * 15})`;
    g.beginPath();
    g.moveTo(tx, H * 0.88 - th);
    g.lineTo(tx - th * 0.25, H * 0.9);
    g.lineTo(tx + th * 0.25, H * 0.9);
    g.closePath();
    g.fill();
  }
};

/** Night motorcycle with light trails. */
const nightRide: Painter = (g) => {
  const r = rand(42);
  g.fillStyle = '#07080c';
  g.fillRect(0, 0, W, H);
  const haze = g.createRadialGradient(W * 0.5, H * 0.45, 50, W * 0.5, H * 0.45, W * 0.7);
  haze.addColorStop(0, 'rgba(40,60,90,0.8)');
  haze.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = haze;
  g.fillRect(0, 0, W, H);
  // neon signs
  for (let i = 0; i < 12; i++) {
    const nx = r() * W;
    const ny = H * (0.1 + r() * 0.35);
    const col = r() < 0.5 ? 'rgba(255,60,160,0.9)' : 'rgba(60,220,255,0.9)';
    glow(g, nx, ny, 70, col, 0.6);
    g.fillStyle = col;
    g.fillRect(nx - 30, ny - 4, 60, 8);
  }
  // light trails
  g.lineCap = 'round';
  for (let i = 0; i < 9; i++) {
    const y0 = H * (0.62 + i * 0.03);
    const col = i % 3 === 0 ? '255,70,50' : i % 3 === 1 ? '255,190,90' : '235,245,255';
    for (const [w, a] of [
      [28, 0.08],
      [12, 0.25],
      [4, 0.9],
    ] as const) {
      g.strokeStyle = `rgba(${col},${a})`;
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(-50, y0 + 60);
      g.bezierCurveTo(W * 0.3, y0 - 40, W * 0.7, y0 + 40, W + 50, y0 - 30);
      g.stroke();
    }
  }
  // motorcycle + rider silhouette
  const mx = W * 0.47;
  const my = H * 0.72;
  g.fillStyle = '#020203';
  for (const wx of [mx - 190, mx + 200]) {
    g.beginPath();
    g.arc(wx, my, 88, 0, Math.PI * 2);
    g.fill();
  }
  g.beginPath();
  g.moveTo(mx - 230, my - 40);
  g.lineTo(mx - 60, my - 120);
  g.lineTo(mx + 140, my - 130);
  g.lineTo(mx + 240, my - 40);
  g.lineTo(mx + 60, my + 10);
  g.closePath();
  g.fill();
  g.beginPath();
  g.ellipse(mx + 10, my - 250, 58, 120, -0.35, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(mx + 60, my - 380, 46, 0, Math.PI * 2);
  g.fill();
  glow(g, mx + 250, my - 70, 120, 'rgba(255,250,235,0.8)');
  glow(g, mx - 235, my - 50, 60, 'rgba(255,30,30,0.8)');
  // rim light
  g.strokeStyle = 'rgba(80,200,255,0.55)';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(mx + 60, my - 380, 46, Math.PI * 1.1, Math.PI * 1.7);
  g.stroke();
};

function addNoise(g: CanvasRenderingContext2D, amount: number, seed: number): void {
  const img = g.getImageData(0, 0, W, H);
  const d = img.data;
  const r = rand(seed);
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() + r() + r() - 1.5) * amount;
    d[i] = d[i] + n;
    d[i + 1] = d[i + 1] + n;
    d[i + 2] = d[i + 2] + n;
  }
  g.putImageData(img, 0, 0);
}

const SAMPLES: { name: string; paint: Painter; noise: number; exif: SampleExif }[] = [
  {
    name: 'KLOUD_Seoul_Dusk.jpg',
    paint: cityDusk,
    noise: 7,
    exif: { make: 'SONY', model: 'ILCE-7M4', lens: 'FE 24-70mm F2.8 GM II', exposure: 1 / 60, fNumber: 2.8, iso: 1600, focal: 35, date: '2026:09:12 19:42:10', artist: 'KLOUD' },
  },
  {
    name: 'KLOUD_Mountain_Lake.jpg',
    paint: mountainLake,
    noise: 3,
    exif: { make: 'FUJIFILM', model: 'X-T5', lens: 'XF16-55mmF2.8 R LM WR', exposure: 1 / 250, fNumber: 8, iso: 125, focal: 16, focal35: 24, date: '2026:08:03 10:15:32', artist: 'KLOUD' },
  },
  {
    name: 'KLOUD_Night_Ride.jpg',
    paint: nightRide,
    noise: 10,
    exif: { make: 'Canon', model: 'Canon EOS R6m2', lens: 'RF50mm F1.8 STM', exposure: 1 / 8, fNumber: 1.8, iso: 3200, focal: 50, date: '2026:09:20 23:05:44', artist: 'KLOUD' },
  },
];

export async function createSamplePhotos(): Promise<File[]> {
  const files: File[] = [];
  for (const [i, s] of SAMPLES.entries()) {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('Canvas 2D is not available.');
    s.paint(g);
    addNoise(g, s.noise, 100 + i);
    const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('JPEG encoding failed'))), 'image/jpeg', 0.92));
    let bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      bytes = insertExif(bytes, buildExifSegment(s.exif)) as Uint8Array<ArrayBuffer>;
    } catch {
      /* EXIF is optional */
    }
    files.push(new File([bytes], s.name, { type: 'image/jpeg', lastModified: Date.now() - (SAMPLES.length - i) * 60_000 }));
    await new Promise((res) => setTimeout(res, 0));
  }
  return files;
}
