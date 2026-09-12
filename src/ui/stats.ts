/** Stats strip: total films, total hours, most-watched decade, average rating. */
import type { Film } from '../types';
import { el } from './dom';

export function computeStats(films: Film[]): { films: number; hours: number; decade: string; avg: string } {
  const watched = films.filter((f) => !f.onWatchlist);
  const minutes = watched.reduce((s, f) => s + (f.runtime ?? 0) * Math.max(1, f.watchCount), 0);
  const decades = new Map<number, number>();
  for (const f of watched) if (f.year) decades.set(Math.floor(f.year / 10) * 10, (decades.get(Math.floor(f.year / 10) * 10) ?? 0) + 1);
  let best: [number, number] | null = null;
  for (const e of decades) if (!best || e[1] > best[1]) best = e;
  const rated = watched.filter((f) => f.rating !== null);
  const avg = rated.length ? (rated.reduce((s, f) => s + (f.rating ?? 0), 0) / rated.length).toFixed(2) : '—';
  return { films: watched.length, hours: Math.round(minutes / 60), decade: best ? `${best[0]}s` : '—', avg };
}

export class StatsStrip {
  readonly root: HTMLDivElement;
  private readonly values: Record<string, HTMLElement> = {};

  constructor(parent: HTMLElement) {
    const make = (key: string, label: string): HTMLDivElement => {
      const b = el('b', { text: '—' });
      this.values[key] = b;
      return el('div', { class: 'stat' }, b, el('span', { text: label }));
    };
    this.root = el('div', { class: 'stats' }, make('films', 'Films'), make('hours', 'Hours watched'), make('decade', 'Top decade'), make('avg', 'Avg rating'));
    parent.append(this.root);
  }

  update(films: Film[]): void {
    const s = computeStats(films);
    this.values['films']!.textContent = String(s.films);
    this.values['hours']!.textContent = s.hours ? String(s.hours) : '—';
    this.values['decade']!.textContent = s.decade;
    this.values['avg']!.textContent = s.avg === '—' ? '—' : `${s.avg} ★`;
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}
