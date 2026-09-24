/**
 * Lazy thumbnail loading for grid tiles, list rows and the filmstrip.
 *
 * Elements are observed with an IntersectionObserver (rooted at the scroll
 * container, with a margin so images arrive just before they scroll in); when
 * one becomes visible its URL is fetched from library.getThumbnailUrl (an
 * object-URL cache owned by the library) and assigned. Recycled elements are
 * re-bound with bind(); refresh() re-resolves URLs after thumbnails changed.
 */
import type { LibraryApi } from '@/editor/contracts';

export class ThumbLoader {
  private readonly io: IntersectionObserver | null;
  private readonly bound = new Map<HTMLImageElement, string>();
  private readonly visible = new Set<HTMLImageElement>();
  private disposed = false;

  constructor(
    private readonly library: LibraryApi,
    root: Element | null,
    rootMargin = '300px',
  ) {
    this.io =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const e of entries) {
                const img = e.target as HTMLImageElement;
                if (e.isIntersecting) {
                  this.visible.add(img);
                  this.load(img);
                } else this.visible.delete(img);
              }
            },
            { root, rootMargin },
          );
  }

  /** Bind `img` to photo `id` (no-op when already bound to it). */
  bind(img: HTMLImageElement, id: string): void {
    if (this.bound.get(img) === id) return;
    const had = this.bound.has(img);
    this.bound.set(img, id);
    img.dataset.thumb = id;
    img.removeAttribute('src');
    img.classList.remove('is-loaded');
    if (!this.io) {
      this.load(img);
      return;
    }
    if (!had) this.io.observe(img);
    else if (this.visible.has(img)) this.load(img);
  }

  unbind(img: HTMLImageElement): void {
    if (!this.bound.delete(img)) return;
    this.visible.delete(img);
    this.io?.unobserve(img);
  }

  /** Re-resolve URLs of every visible image (after setThumbnail / library changes). */
  refresh(): void {
    for (const img of this.visible) this.load(img);
    if (!this.io) for (const img of this.bound.keys()) this.load(img);
  }

  private load(img: HTMLImageElement): void {
    const id = this.bound.get(img);
    if (!id) return;
    void this.library.getThumbnailUrl(id).then(
      (url) => {
        if (this.disposed || this.bound.get(img) !== id) return;
        if (!url) {
          img.removeAttribute('src');
          img.classList.add('is-missing');
          return;
        }
        img.classList.remove('is-missing');
        if (img.getAttribute('src') !== url) img.src = url;
      },
      () => undefined,
    );
  }

  dispose(): void {
    this.disposed = true;
    this.io?.disconnect();
    this.bound.clear();
    this.visible.clear();
  }
}

/** Create an <img> for thumbnails that fades in on load. */
export function thumbImg(className: string, alt = ''): HTMLImageElement {
  const img = document.createElement('img');
  img.className = className;
  img.alt = alt;
  img.decoding = 'async';
  img.draggable = false;
  img.addEventListener('load', () => img.classList.add('is-loaded'));
  return img;
}
