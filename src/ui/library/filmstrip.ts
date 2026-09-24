/** Develop filmstrip: thumbnails of the photos in the current library view. */
import type { AppContext } from '../../app/context';
import { Disposer, h } from '../dom';
import { photoMenu } from './actions';
import './filmstrip.css';

export function createFilmstrip(ctx: AppContext): { el: HTMLElement; dispose(): void } {
  const d = new Disposer();
  const track = h('div', { class: 'k-film__track', attrs: { role: 'listbox', 'aria-label': 'Filmstrip' } });
  const el = h('div', { class: 'k-film' }, track);
  const cells = new Map<string, HTMLElement>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const cell = e.target as HTMLElement;
        const id = cell.dataset.id!;
        io.unobserve(cell);
        void ctx.library.getThumbnailUrl(id).then((url) => {
          const img = cell.querySelector('img');
          if (url && img) img.src = url;
        });
      }
    },
    { root: el, rootMargin: '0px 400px' },
  );
  d.add(() => io.disconnect());

  const render = () => {
    const ids = ctx.visibleIds.value;
    track.replaceChildren();
    cells.clear();
    for (const id of ids) {
      const rec = ctx.library.get(id);
      if (!rec) continue;
      const cell = h(
        'button',
        {
          type: 'button',
          class: 'k-film__cell',
          dataset: { id },
          attrs: { role: 'option', 'aria-label': rec.name, title: rec.name },
          onclick: () => void ctx.openPhoto(id),
          oncontextmenu: (e: MouseEvent) => {
            e.preventDefault();
            import('../kit').then(({ openMenu }) => openMenu({ x: e.clientX, y: e.clientY } as never, photoMenu(ctx, [id])));
          },
        },
        h('img', { class: 'k-film__img', alt: '', draggable: false }),
        rec.rating ? h('span', { class: 'k-film__stars' }, '★'.repeat(rec.rating)) : null,
        rec.flag === 'reject' ? h('span', { class: 'k-film__flag' }) : null,
      );
      cells.set(id, cell);
      track.append(cell);
      io.observe(cell);
    }
    highlight();
  };
  const highlight = () => {
    const cur = ctx.doc.value?.photoId;
    for (const [id, cell] of cells) {
      const on = id === cur;
      cell.classList.toggle('is-current', on);
      cell.setAttribute('aria-selected', String(on));
      if (on) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
  d.add(ctx.visibleIds.subscribe(render, true));
  d.add(ctx.doc.subscribe(highlight));
  d.add(ctx.library.subscribe(render));
  return { el, dispose: () => d.dispose() };
}
