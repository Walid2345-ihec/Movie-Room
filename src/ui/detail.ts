/** Detail panel shown while a case is in the inspect pose. */
import type { Film } from '../types';
import { resolveCover } from '../data/tmdb';
import { button, el, stars } from './dom';

export class DetailPanel {
  readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private current: string | null = null;

  constructor(parent: HTMLElement, onClose: () => void) {
    this.body = el('div');
    this.root = el('div', { class: 'detail' }, button('✕', onClose, 'close'), this.body);
    parent.append(this.root);
  }

  async show(film: Film): Promise<void> {
    this.current = film.id;
    const cover = el('div');
    const decade = film.year ? `${Math.floor(film.year / 10) * 10}s` : '';
    const rows: [string, string][] = [
      ['Director', film.director ?? '—'],
      ['Runtime', film.runtime ? `${film.runtime} min` : '—'],
      ['Your rating', stars(film.rating)],
      ['Watched', film.watchedDate ?? (film.onWatchlist ? 'On watchlist' : '—')],
      ['Rewatches', film.watchCount > 1 ? String(film.watchCount - 1) : '0'],
    ];
    this.body.replaceChildren(
      cover,
      el('h2', { text: film.title }),
      el('div', { class: 'meta', text: [film.year ? String(film.year) : '', decade, film.procedural ? 'procedural cover' : 'TMDB'].filter(Boolean).join(' · ') }),
      el('div', { class: 'chips' }, ...film.genres.map((g) => el('span', { class: 'chip', text: g }))),
      ...rows.map(([k, v]) => el('div', { class: 'row' }, el('span', { text: k }), el('span', { class: k === 'Your rating' ? 'stars' : '', text: v }))),
      el(
        'div',
        { class: 'row' },
        el('span', { text: 'Letterboxd' }),
        film.letterboxdUri
          ? el('a', { href: film.letterboxdUri, target: '_blank', rel: 'noopener', text: 'Open film page ↗' })
          : el('a', { href: `https://letterboxd.com/search/${encodeURIComponent(film.title)}/`, target: '_blank', rel: 'noopener', text: 'Search ↗' }),
      ),
    );
    this.root.classList.add('open');
    const src = await resolveCover(film);
    if (this.current !== film.id) return;
    // The image element is already decoded (its blob URL may be revoked), so append it directly.
    if (src instanceof HTMLImageElement) src.alt = film.title;
    cover.replaceWith(src);
  }

  hide(): void {
    this.current = null;
    this.root.classList.remove('open');
  }
}
