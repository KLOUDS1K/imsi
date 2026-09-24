/**
 * Drag & drop import anywhere over the app: files and whole folders. While a
 * file drag is over the window a full-window overlay shows "Drop to import"
 * with a big folder tile (site look). In-page drags (thumbnails onto albums…)
 * are ignored because they don't carry 'Files'.
 */
import './dropzone.css';
import { folderArt } from '@/ui/kit';
import { Disposer, h, on } from '@/ui/dom';
import type { AppRuntime } from '@/app/createContext';
import { isFileDrag } from '@/app/importer';

export function attachDropzone(rt: AppRuntime, host: HTMLElement): () => void {
  const d = new Disposer();
  const overlay = h(
    'div',
    { class: 'k-drop', hidden: true, attrs: { 'aria-hidden': 'true' } },
    h(
      'div',
      { class: 'k-drop__card' },
      h('div', { class: 'k-drop__art' }, folderArt('upload')),
      h('p', { class: 'k-drop__title' }, 'Drop to import'),
      h('p', { class: 'k-drop__sub' }, 'Photos or whole folders · JPEG, PNG, WebP, TIFF, HEIC, RAW'),
    ),
  );
  host.appendChild(overlay);
  d.add(() => overlay.remove());

  // dragenter/dragleave fire for every child; count depth to know when the drag really left.
  let depth = 0;
  const show = (v: boolean): void => {
    overlay.hidden = !v;
    host.classList.toggle('is-dropping', v);
  };
  d.add(
    on(window, 'dragenter', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth++;
      show(true);
    }),
  );
  d.add(
    on(window, 'dragover', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    }),
  );
  d.add(
    on(window, 'dragleave', (e) => {
      if (!isFileDrag(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) show(false);
    }),
  );
  d.add(
    on(window, 'drop', (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      depth = 0;
      show(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      void rt.importDataTransfer(dt).then((ids) => {
        if (ids.length && rt.ctx.module.value === 'develop') void rt.ctx.openPhoto(ids[0]);
      });
    }),
  );
  return () => d.dispose();
}
