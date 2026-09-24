# KLOUD Studio — architecture & build brief

A browser photo editor for **kloud.photography** (a Lightroom-style, non-destructive editor). This is a standalone
prototype that the owner will later drop into the site project. It must therefore be:

- **Framework-free** (vanilla TypeScript + DOM, Vite build). Entry point `mountKloudEditor(root, options)` in
  `src/app/index.ts`, so it can be wrapped by React/Next/Vue/plain HTML later.
- **Themed only through `src/theme/tokens.css`** (CSS custom properties, `--k-*`). No hard-coded colors in
  components except in canvas drawing, where colors are read from the tokens via `getComputedStyle`.
- **Offline-capable**: everything runs client-side (WebGL2, Web Workers, IndexedDB). Optional ML models load from
  CDNs at runtime and must degrade gracefully when blocked.

## Visual language (from the live site)

The site is a Finder-style archive:

- Toolbar (44px) with thin chevrons (back / forward / up), a bold breadcrumb ("Archive"), a rounded search pill
  ("Search by name"), a grid/list segmented toggle (active segment = raised white/`--k-surface`), a sort icon (↑↓), a
  sun/moon theme toggle and a lock icon. Icons are 1.5px-stroke line icons (lucide-like), ~16px, muted color.
- Left sidebar (~216px) with the wordmark **KLOUD** (bold, tight) followed by **.PHOTOGRAPHY** (tiny, uppercase,
  wide tracking, muted), then a flat list of items with small leading icons. Sidebar footer shows a count ("2
  folders") above a hairline.
- Content: H1 page title (~24px semibold), a one-line muted description, a hairline divider, then section labels in
  tiny uppercase letter-spaced muted text with a pill count badge ("FOLDERS 2"), then a grid of large yellow macOS-style
  folder tiles with the name in bold small text and a muted sub-line ("Locked").
- Bottom status bar (26px) with muted small text.
- Light: warm off-white (`#f4f3f0` content, `#fafaf9` sidebar). Dark: near-black `#0e0e10`. Hairline borders.
  Folder-yellow is the only accent. Font: Inter / system grotesque.

The editor reuses this chrome: same toolbar, sidebar, section labels, status bar, theme toggle. The photo viewport
uses `--k-canvas` (near-neutral so colors are judged correctly). Develop panels are dense (12–13px), with section
headers in the same uppercase-label style. Sliders: thin 2px track, small round thumb, value on the right in tabular
numerals; the accent marks the active/modified state. Everything must work in both themes.

## Directory ownership

| Path | Owner (agent) | Notes |
| --- | --- | --- |
| `src/editor/types.ts`, `defaults.ts`, `contracts.ts`, `color/*`, `src/app/context.ts`, `src/ui/dom.ts`, `src/ui/signal.ts`, `src/theme/tokens.css` | foundation (read-only for everyone) | Change only by editing the contract deliberately and noting it in `docs/CONTRACT_CHANGES.md`. |
| `src/editor/state/`, `src/editor/presets/` | state | EditorStore, params math, XMP, presets |
| `src/editor/engine/pass-types.ts` | foundation | PassDef contract between the orchestrator and the pass modules |
| `src/editor/engine/*` (except the three below) | engine-core | WebGL2 context, textures/FBOs, pass runner, blur mechanism, pipeline orchestration, masks/patches upload, present (zoom/compare/clipping/overlay), readback, export render, caps |
| `src/editor/engine/color/` | engine-color | PassDefs: PRE (calibration, WB, exposure, lens vignetting), DEVELOP (dehaze, tone, presence, curve, HSL, grading, vibrance/saturation, defringe), LOCAL (mask adjustments) |
| `src/editor/engine/fx/`, `src/editor/engine/geometry.ts` | engine-fx | PassDefs: HEAL/clone, DETAIL (NR, AI denoise, sharpen), GEOMETRY (lens distortion, CA, orientation, straighten/transform, crop), EFFECTS (bloom, glow, halation, vignette, grain) + the CPU geometry mirror |
| `src/editor/io/`, `src/editor/lens/` | io | decode (JPEG/PNG/WebP/TIFF/RAW), EXIF, thumbnails, lens profiles |
| `src/editor/export/`, `src/editor/watermark/` | export | encoders, ICC, EXIF writer, TIFF/DNG, resize, sharpening, zip |
| `src/editor/analysis/` | analysis | histogram/scopes, auto tone/WB, image analysis, auto edit, level/perspective, dust |
| `src/editor/masks/`, `src/editor/ai/segment/` | masks-ai | mask rasterizer, segmentation (heuristic + optional MediaPipe), depth |
| `src/editor/ai/inpaint/`, `src/editor/ai/style/` | ai-style | PatchMatch inpainting, heal source search, KLOUD Style learning |
| `src/editor/storage/`, `src/editor/library/` | library | IndexedDB, autosave/recovery, library model, batch ops |
| `src/ui/kit/`, `src/theme/base.css` | ui-kit | components + icons + base styles |
| `src/ui/panels/` | ui-panels | right-side Develop panels |
| `src/ui/viewer/` | ui-viewer | viewport interaction, crop/mask/heal overlays, compare |
| `src/ui/shell/`, `src/app/` (except context.ts) | ui-shell | layout, library grid, dialogs, shortcuts, wiring |

Each module exposes a single `index.ts`. Import other modules only through their `index.ts` (or `engine/geometry.ts`).
Use the `@/` alias for `src/`.

## Coordinate spaces

1. **Source** — decoded pixels, EXIF orientation already applied. Masks, heal spots and removal patches live here
   (source-normalized 0..1).
2. **Lens-corrected** — distortion removal (Brown–Conrady, radius normalized to the half-diagonal) and lateral CA.
3. **Oriented** — `crop.orientation` (90° steps, clockwise) then `flipH` / `flipV`.
4. **Frame** — straighten `crop.angle` + `transform` (keystone vertical/horizontal, rotate, aspect, scale, offsets)
   about the image centre. This is the uncropped output shown by the crop tool.
5. **Output** — `crop` rect (frame-normalized) → final pixels. Post-crop effects (vignette, grain) use output coords.

`engine/geometry.ts` implements the forward/inverse mapping on the CPU with exactly the math used by the geometry
shader. The viewer uses it to convert pointer positions to source coordinates.

## Sign conventions (engine, analysis, UI must agree)

- Texture/image coordinates: (0,0) = top-left, y down (see `engine/pass-types.ts`).
- `crop.angle` and `transform.rotate`: positive = image content rotates **clockwise** on screen.
- `crop.orientation`: clockwise quarter turns. Applied before flips; flips are in the oriented space.
- `transform.vertical = v`: let `k = 0.4 * v / 100`. The frame is warped by a projective transform that scales the
  TOP edge width by `(1 + k)` and the BOTTOM edge by `(1 - k)` (positive v widens the top, correcting verticals that
  converge upward when shooting up at a building).
- `transform.horizontal = v`: same with `k = 0.4 * v / 100`, scaling the RIGHT edge height by `(1 + k)` and the LEFT
  edge by `(1 - k)`.
- `transform.aspect = a`: horizontal stretch `2^(a/100 * 0.5)` (positive = wider), vertical `1 / that`.
- `transform.scale` %: uniform zoom about the centre (100 = none). `offsetX/offsetY` ±100 shift the content by up to
  50% of the frame width/height (positive = right/down).
- `lens.distortion = d` (manual): adds `k1 += -0.15 * d/100` to the correction (positive d removes barrel distortion).
- Brush sizes and heal radii are fractions of the source long edge.

## Render pipeline (WebGL2, RGBA16F where supported, linear-light working space = linear sRGB/Rec.709, unclamped)

Preview works on a **proxy** of the source (long edge ≤ 2560, or less on small devices); export renders the full
image (tiled if needed).

1. **Upload** source → linear float (sRGB decode / 16-bit normalize / primaries → linear sRGB matrix).
2. **Retouch** (source space): removal patches composited, then heal/clone spots (clone = copy; heal = copy + low-
   frequency colour match).
3. **Pre** (source space): calibration primaries, white balance gains (`wbGains` in `color/math.ts`), exposure, lens
   vignetting correction.
4. **Blur pyramid** of the Pre result (luminance + min-channel): small / medium / large radii (scaled with resolution)
   — used by texture, clarity, structure, local contrast, highlights/shadows and dehaze.
5. **Develop** (engine-color): dehaze, highlights/shadows/whites/blacks, contrast, presence (texture, clarity, structure,
   local contrast), parametric + point curves (LUT from `color/curves.ts`), HSL, color grading, vibrance/saturation,
   defringe. Output is display-referred (sRGB-encoded) float.
6. **Detail**: noise reduction (luminance/color, bilateral / guided), AI denoise (non-local-means style, heavier),
   sharpening (unsharp with radius/detail/edge masking).
7. **Local adjustments**: one pass per visible mask using its coverage texture (from `MaskProvider`).
8. **Geometry**: lens distortion + CA + orientation/flip + straighten/transform + crop → output size.
9. **Effects**: post-crop vignette (amount/midpoint/roundness/feather/highlights), bloom/glow/halation, grain.
10. **Present**: zoom/pan, compare layouts, clipping overlay, mask overlay.

Draft quality (during slider drags) may skip or cheapen steps 6 and the large blurs.

## Conventions

- TypeScript strict. `npm run typecheck` and `npm run build` must stay green for your files.
- No new npm dependencies without need; already installed: `exifr`, `utif`, `fflate`, `libraw-wasm`.
- Heavy CPU work (RAW decode, thumbnails, PatchMatch, style training on big sets) goes in Web Workers
  (`new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`).
- Never use `alert/confirm/prompt` — use `ctx.confirm/ctx.prompt/ctx.toast`.
- CSS: each UI module ships its own `*.css` imported from its TS, class names prefixed `k-`, styled only via tokens.
- Accessibility: buttons are `<button>`, sliders have `role="slider"` + aria values, focus is visible
  (`--k-focus-ring`), respects `prefers-reduced-motion`.
- Mobile: layouts must work at 390px width (panels become bottom sheets / drawers). Touch: pointer events everywhere.
- Features that need a trained ML model we cannot ship (generative fill, semantic segmentation) use the best
  classical algorithm available and are labelled honestly in the UI (e.g. "Heuristic" / "On-device model" badge).
