/**
 * Export dialog: format / size / colour space / metadata / watermark /
 * output sharpening / file naming, then a sequential full-resolution export
 * (one decode at a time) downloaded as a file or a zip.
 */
import './export.css';
import type { AppContext } from '../../app/context';
import { createDefaultParams } from '../../editor/defaults';
import { outputSize } from '../../editor/engine/geometry';
import { buildFileName, downloadBlob, exportPhoto, fileExtension, zipResults } from '../../editor/export';
import { decodeFile } from '../../editor/io';
import { normalizeParams } from '../../editor/state';
import type { ExportResult } from '../../editor/contracts';
import type { EditParams } from '../../editor/types';
import type { ExportSettings, PhotoMeta, SourceImage, WatermarkPosition, WatermarkSettings } from '../../editor/types';
import { renderWatermarkPreview } from '../../editor/watermark';
import { Disposer, h } from '../dom';
import { createSelect, createSlider, createToggle, openDialog } from '../kit';

const QUICK: { label: string; apply: (s: ExportSettings) => void }[] = [
  { label: 'Web 2048', apply: (s) => Object.assign(s, { format: 'jpeg', quality: 85, bitDepth: 8, colorSpace: 'srgb', resize: { ...s.resize, mode: 'long-edge', value: 2048 } }) },
  { label: 'Instagram', apply: (s) => Object.assign(s, { format: 'jpeg', quality: 90, bitDepth: 8, colorSpace: 'srgb', resize: { ...s.resize, mode: 'dimensions', width: 1080, height: 1350 } }) },
  { label: 'Full JPEG', apply: (s) => Object.assign(s, { format: 'jpeg', quality: 95, bitDepth: 8, resize: { ...s.resize, mode: 'none' } }) },
  { label: 'Print TIFF 16-bit', apply: (s) => Object.assign(s, { format: 'tiff', bitDepth: 16, colorSpace: 'adobe-rgb', dpi: 300, resize: { ...s.resize, mode: 'none' } }) },
  { label: 'Archive DNG', apply: (s) => Object.assign(s, { format: 'dng', bitDepth: 16, resize: { ...s.resize, mode: 'none' } }) },
];

const POSITIONS: WatermarkPosition[] = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

function field(label: string, ...controls: (Node | string | null)[]): HTMLElement {
  return h('label', { class: 'k-exp__field' }, h('span', { class: 'k-exp__label' }, label), h('span', { class: 'k-exp__ctl' }, ...controls));
}

function numInput(value: number, onChange: (v: number) => void, attrs: Record<string, number> = {}): HTMLInputElement {
  return h('input', {
    class: 'k-exp__input',
    type: 'number',
    value: String(value),
    attrs,
    onchange: (e: Event) => onChange(Number((e.target as HTMLInputElement).value)),
  });
}

function textInput(value: string, onInput: (v: string) => void, placeholder = ''): HTMLInputElement {
  return h('input', { class: 'k-exp__input', type: 'text', value, placeholder, oninput: (e: Event) => onInput((e.target as HTMLInputElement).value) });
}

export function openExportDialog(ctx: AppContext, photoIds: string[]): void {
  const ids = photoIds.length ? photoIds : ctx.doc.value ? [ctx.doc.value.photoId] : ctx.selection.value;
  if (!ids.length) {
    ctx.toast('Select photos to export first.', 'info');
    return;
  }
  if (!ctx.engine) {
    ctx.toast('Export needs WebGL2, which this browser does not provide.', 'error');
    return;
  }
  const d = new Disposer();
  const s: ExportSettings = structuredClone(ctx.exportSettings.value);
  const body = h('div', { class: 'k-exp' });
  const preview = h('canvas', { class: 'k-exp__preview', width: 480, height: 320 });
  const nameExample = h('span', { class: 'k-exp__example' });
  let previewBg: HTMLCanvasElement | null = null;
  if (ctx.doc.value) {
    const px = ctx.engine.readPixels(640, 'main');
    previewBg = document.createElement('canvas');
    previewBg.width = px.width;
    previewBg.height = px.height;
    previewBg.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
  }

  let rebuildQueued = false;
  const refresh = () => {
    if (rebuildQueued) return;
    rebuildQueued = true;
    requestAnimationFrame(() => {
      rebuildQueued = false;
      void renderWatermarkPreview(preview, s.watermark, previewBg);
      const first = ctx.library.get(ids[0]);
      const meta: PhotoMeta = first?.meta ?? ({ fileName: 'photo', fileSize: 0, mimeType: '', format: 'jpeg', width: 0, height: 0, orientation: 1, bitDepth: 8 } as PhotoMeta);
      nameExample.textContent = buildFileName(s.fileNameTemplate, { name: (first?.name ?? 'photo').replace(/\.[^.]+$/, ''), seq: s.sequenceStart, meta, width: meta.width, height: meta.height }, fileExtension(s.format));
    });
  };

  const build = () => {
    d.dispose();
    body.replaceChildren();
    const quick = h('div', { class: 'k-exp__quick' });
    for (const q of QUICK) quick.append(h('button', { type: 'button', class: 'k-exp__chip', onclick: () => (q.apply(s), build()) }, q.label));

    const fmt = createSelect<ExportSettings['format']>({
      ariaLabel: 'Format',
      size: 'sm',
      value: s.format,
      options: [
        { value: 'jpeg', label: 'JPEG' },
        { value: 'png', label: 'PNG' },
        { value: 'webp', label: 'WebP' },
        { value: 'tiff', label: 'TIFF' },
        { value: 'dng', label: 'DNG (rendered)' },
      ],
      onChange: (v) => {
        s.format = v;
        build();
      },
    });
    const quality = createSlider({ label: 'Quality', min: 1, max: 100, step: 1, value: s.quality, defaultValue: 90, fill: 'min', onChange: (v) => (s.quality = v), onInput: (v) => (s.quality = v) });
    const depth = createSelect<'8' | '16'>({
      ariaLabel: 'Bit depth',
      size: 'sm',
      value: String(s.bitDepth) as '8' | '16',
      disabled: s.format === 'jpeg' || s.format === 'webp' || s.format === 'dng',
      options: [
        { value: '8', label: '8-bit' },
        { value: '16', label: '16-bit' },
      ],
      onChange: (v) => (s.bitDepth = Number(v) as 8 | 16),
    });
    const mode = createSelect<ExportSettings['resize']['mode']>({
      ariaLabel: 'Resize',
      size: 'sm',
      value: s.resize.mode,
      options: [
        { value: 'none', label: 'Original size' },
        { value: 'long-edge', label: 'Long edge' },
        { value: 'short-edge', label: 'Short edge' },
        { value: 'width', label: 'Width' },
        { value: 'height', label: 'Height' },
        { value: 'dimensions', label: 'Fit W × H' },
        { value: 'megapixels', label: 'Megapixels' },
      ],
      onChange: (v) => {
        s.resize.mode = v;
        build();
      },
    });
    const sizeCtl =
      s.resize.mode === 'none'
        ? null
        : s.resize.mode === 'dimensions'
          ? h('span', { class: 'k-exp__pair' }, numInput(s.resize.width, (v) => (s.resize.width = v), { min: 16 }), '×', numInput(s.resize.height, (v) => (s.resize.height = v), { min: 16 }))
          : numInput(s.resize.value, (v) => (s.resize.value = v), { min: 1 });
    const enlarge = createToggle({ checked: s.resize.dontEnlarge, label: "Don't enlarge", size: 'sm', onChange: (v) => (s.resize.dontEnlarge = v) });
    const space = createSelect<ExportSettings['colorSpace']>({
      ariaLabel: 'Colour space',
      size: 'sm',
      value: s.colorSpace,
      options: [
        { value: 'srgb', label: 'sRGB (web)' },
        { value: 'display-p3', label: 'Display P3' },
        { value: 'adobe-rgb', label: 'Adobe RGB (1998)' },
      ],
      onChange: (v) => (s.colorSpace = v),
    });
    const metaSel = createSelect<ExportSettings['metadata']>({
      ariaLabel: 'Metadata',
      size: 'sm',
      value: s.metadata,
      options: [
        { value: 'all', label: 'All metadata' },
        { value: 'copyright', label: 'Copyright only' },
        { value: 'copyright-contact', label: 'Copyright & contact' },
        { value: 'none', label: 'None' },
      ],
      onChange: (v) => (s.metadata = v),
    });
    const noGps = createToggle({ checked: s.removeLocation, label: 'Remove location', size: 'sm', onChange: (v) => (s.removeLocation = v) });

    const wm: WatermarkSettings = s.watermark;
    const wmOn = createToggle({
      checked: wm.enabled,
      label: 'Add watermark',
      size: 'sm',
      onChange: (v) => {
        wm.enabled = v;
        refresh();
      },
    });
    const wmKind = createSelect<WatermarkSettings['kind']>({
      ariaLabel: 'Watermark type',
      size: 'sm',
      value: wm.kind,
      options: [
        { value: 'kloud-photography', label: 'KLOUD.PHOTOGRAPHY' },
        { value: 'kloud', label: 'KLOUD' },
        { value: 'text', label: 'Custom text' },
        { value: 'image', label: 'Logo image' },
      ],
      onChange: (v) => {
        wm.kind = v;
        build();
      },
    });
    const posGrid = h('div', { class: 'k-exp__pos', attrs: { role: 'radiogroup', 'aria-label': 'Watermark position' } });
    for (const p of POSITIONS) {
      posGrid.append(
        h('button', {
          type: 'button',
          class: ['k-exp__posbtn', wm.position === p && 'is-on'],
          attrs: { 'aria-label': p, 'aria-checked': wm.position === p, role: 'radio' },
          onclick: () => {
            wm.position = p;
            build();
          },
        }),
      );
    }
    const wmSliders = [
      createSlider({ label: 'Size', min: 1, max: 30, step: 0.1, value: wm.size, defaultValue: 2.2, unit: '%', fill: 'min', onInput: (v) => ((wm.size = v), refresh()) }),
      createSlider({ label: 'Opacity', min: 0, max: 100, step: 1, value: wm.opacity, defaultValue: 70, unit: '%', fill: 'min', onInput: (v) => ((wm.opacity = v), refresh()) }),
      createSlider({ label: 'Margin', min: 0, max: 20, step: 0.1, value: wm.margin, defaultValue: 3, unit: '%', fill: 'min', onInput: (v) => ((wm.margin = v), refresh()) }),
    ];
    const wmShadow = createToggle({ checked: wm.shadow, label: 'Soft shadow', size: 'sm', onChange: (v) => ((wm.shadow = v), refresh()) });
    const color = h('input', { type: 'color', class: 'k-exp__color', value: wm.color, oninput: (e: Event) => ((wm.color = (e.target as HTMLInputElement).value), refresh()) });
    const logo = h('input', {
      type: 'file',
      accept: 'image/png,image/svg+xml,image/webp,image/jpeg',
      onchange: (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
          wm.imageDataUrl = String(reader.result);
          refresh();
        };
        reader.readAsDataURL(f);
      },
    });
    const sharpOn = createToggle({ checked: s.outputSharpening.enabled, label: 'Sharpen for', size: 'sm', onChange: (v) => (s.outputSharpening.enabled = v) });
    const sharpTarget = createSelect<ExportSettings['outputSharpening']['target']>({
      ariaLabel: 'Sharpen for',
      size: 'sm',
      value: s.outputSharpening.target,
      options: [
        { value: 'screen', label: 'Screen' },
        { value: 'matte', label: 'Matte paper' },
        { value: 'glossy', label: 'Glossy paper' },
      ],
      onChange: (v) => (s.outputSharpening.target = v),
    });
    const sharpAmount = createSelect<ExportSettings['outputSharpening']['amount']>({
      ariaLabel: 'Sharpening amount',
      size: 'sm',
      value: s.outputSharpening.amount,
      options: [
        { value: 'low', label: 'Low' },
        { value: 'standard', label: 'Standard' },
        { value: 'high', label: 'High' },
      ],
      onChange: (v) => (s.outputSharpening.amount = v),
    });
    d.add(() => [fmt, quality, depth, mode, enlarge, space, metaSel, noGps, wmOn, wmKind, wmShadow, sharpOn, sharpTarget, sharpAmount, ...wmSliders].forEach((c) => c.destroy()));

    body.append(
      h('div', { class: 'k-exp__col' },
        h('div', { class: 'k-label' }, 'Presets'),
        quick,
        h('div', { class: 'k-label' }, 'File'),
        field('Format', fmt.el),
        s.format === 'jpeg' || s.format === 'webp' ? quality.el : null,
        field('Bit depth', depth.el),
        h('div', { class: 'k-label' }, 'Size'),
        field('Resize', mode.el, sizeCtl),
        s.resize.mode !== 'none' ? enlarge.el : null,
        field('Resolution', numInput(s.dpi, (v) => (s.dpi = v), { min: 72, max: 1200 }), 'ppi'),
        field('Colour space', space.el),
        h('div', { class: 'k-label' }, 'Metadata'),
        field('Include', metaSel.el),
        noGps.el,
        field('Copyright', textInput(s.copyright, (v) => (s.copyright = v), '© Your name')),
        field('Artist', textInput(s.artist, (v) => (s.artist = v))),
        h('div', { class: 'k-label' }, 'Output sharpening'),
        h('div', { class: 'k-exp__row' }, sharpOn.el, sharpTarget.el, sharpAmount.el),
        h('div', { class: 'k-label' }, 'File name'),
        field('Template', textInput(s.fileNameTemplate, (v) => ((s.fileNameTemplate = v), refresh()), '{name}_kloud')),
        h('p', { class: 'k-exp__hint' }, 'Tokens: {name} {seq} {date} {camera} {lens} {iso} {rating} {width} {height}'),
        field('Example', nameExample),
      ),
      h('div', { class: 'k-exp__col' },
        h('div', { class: 'k-label' }, 'Watermark'),
        wmOn.el,
        field('Type', wmKind.el),
        wm.kind === 'text' ? field('Text', textInput(wm.text, (v) => ((wm.text = v), refresh()))) : null,
        wm.kind === 'image' ? field('Logo', logo) : field('Colour', color),
        field('Position', posGrid),
        ...wmSliders.map((x) => x.el),
        wmShadow.el,
        preview,
        h('p', { class: 'k-exp__hint' }, ids.length > 1 ? `The watermark is applied to all ${ids.length} photos.` : 'Preview of the watermark on this photo.'),
      ),
    );
    refresh();
  };
  build();

  const dialog = openDialog<'export' | 'cancel'>({
    title: ids.length > 1 ? `Export ${ids.length} photos` : 'Export photo',
    content: body,
    size: 'xl',
    class: 'k-exp-dialog',
    actions: [
      { label: 'Cancel', value: 'cancel', variant: 'ghost' },
      {
        label: 'Export',
        value: 'export',
        variant: 'primary',
        icon: 'download',
        onClick: () => {
          void run();
          return false;
        },
      },
    ],
    onClose: () => d.dispose(),
  });

  let running: AbortController | null = null;
  async function run(): Promise<void> {
    if (running) return;
    const engine = ctx.engine;
    if (!engine) return;
    ctx.exportSettings.set(structuredClone(s));
    running = new AbortController();
    dialog.setBusy(true);
    const results: ExportResult[] = [];
    const errors: string[] = [];
    try {
      for (const [index, id] of ids.entries()) {
        if (running.signal.aborted) break;
        const rec = ctx.library.get(id);
        if (!rec) continue;
        ctx.busy.set({ active: true, label: `Exporting ${index + 1}/${ids.length}`, progress: index / ids.length });
        try {
          const doc = ctx.doc.value;
          let params: EditParams;
          let source: SourceImage;
          let meta: PhotoMeta;
          if (doc && doc.photoId === id) {
            params = doc.store.params;
            source = await doc.decoded.loadFull();
            meta = doc.meta;
          } else {
            const file = await ctx.library.getFile(id);
            if (!file) throw new Error('original file is missing');
            const decoded = await decodeFile(file, rec.name);
            source = decoded.source;
            meta = decoded.meta;
            const saved = await ctx.library.loadEdit(id);
            params = saved ? normalizeParams(saved.params, source.isRaw) : createDefaultParams(source.isRaw);
          }
          const full = outputSize(params, source.fullWidth || source.width, source.fullHeight || source.height);
          const res = await exportPhoto({
            params,
            meta,
            settings: s,
            baseName: rec.name.replace(/\.[^.]+$/, ''),
            index,
            batchSize: ids.length,
            rating: rec.rating,
            fullOutputSize: full,
            signal: running.signal,
            render: (width, height, bitDepth, colorSpace) => engine.renderFull(params, { width, height, bitDepth, colorSpace, source, signal: running?.signal }),
          });
          results.push(res);
        } catch (e) {
          if ((e as Error).name === 'AbortError') break;
          errors.push(`${rec.name}: ${(e as Error).message}`);
        }
      }
      if (results.length === 1) downloadBlob(results[0].blob, results[0].fileName);
      else if (results.length > 1) {
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        downloadBlob(await zipResults(results), `KLOUD_export_${stamp}.zip`);
      }
      if (errors.length) ctx.toast(`Exported ${results.length}, failed ${errors.length}: ${errors[0]}`, 'error', 8000);
      else if (results.length) ctx.toast(`Exported ${results.length} photo${results.length === 1 ? '' : 's'}.`, 'success');
      dialog.close('export');
    } finally {
      ctx.busy.set({ active: false });
      dialog.setBusy(false);
      running = null;
    }
  }
}
