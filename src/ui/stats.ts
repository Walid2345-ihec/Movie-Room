/** Stats strip: total films, total hours, most-watched decade, average rating. */
import type { Film } from '../types';
import { el } from './dom';

export interface Stats {
  films: number;
  /** Total minutes across watched films that HAVE a runtime (rewatches counted). */
  minutes: number;
  /** Watched films with no runtime — excluded from `minutes`, never counted as zero. */
  missingRuntime: number;
  decade: string;
  director: string;
  avg: string;
}

/** "412h" */
export const formatHours = (minutes: number): string => (minutes > 0 ? `${Math.round(minutes / 60)}h` : '—');
/** "17d 4h" */
export function formatDaysHours(minutes: number): string {
  const hours = Math.round(minutes / 60);
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}
/** "1h 47m" */
export function formatRuntime(minutes: number | null): string {
  if (!minutes) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m.toString().padStart(2, '0')}m` : `${m}m`;
}

function mode<K>(counts: Map<K, number>): K | null {
  let best: [K, number] | null = null;
  for (const e of counts) if (!best || e[1] > best[1]) best = e;
  return best ? best[0] : null;
}

export function computeStats(films: Film[]): Stats {
  const watched = films.filter((f) => !f.onWatchlist);
  let minutes = 0;
  let missingRuntime = 0;
  const decades = new Map<number, number>();
  const directors = new Map<string, number>();
  for (const f of watched) {
    const plays = Math.max(1, f.watchCount);
    if (f.runtime && f.runtime > 0) minutes += f.runtime * plays;
    else missingRuntime++;
    const year = f.releaseYear ?? f.year;
    if (year) decades.set(Math.floor(year / 10) * 10, (decades.get(Math.floor(year / 10) * 10) ?? 0) + 1);
    if (f.director) directors.set(f.director, (directors.get(f.director) ?? 0) + plays);
  }
  const rated = watched.filter((f) => f.rating !== null);
  const avg = rated.length ? (rated.reduce((s, f) => s + (f.rating ?? 0), 0) / rated.length).toFixed(2) : '—';
  const decade = mode(decades);
  return { films: watched.length, minutes, missingRuntime, decade: decade !== null ? `${decade}s` : '—', director: mode(directors) ?? '—', avg };
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
    this.root = el('div', { class: 'stats' }, make('films', 'Films'), make('hours', 'Hours watched'), make('avg', 'Avg rating'), make('decade', 'Top decade'), make('director', 'Top director'));
    parent.append(this.root);
  }

  update(films: Film[]): void {
    const s = computeStats(films);
    this.values['films']!.textContent = String(s.films);
    const hours = this.values['hours']!;
    hours.textContent = formatHours(s.minutes);
    hours.title = s.minutes > 0 ? formatDaysHours(s.minutes) : 'No runtimes known';
    const label = hours.nextElementSibling;
    if (label) label.textContent = s.missingRuntime > 0 ? `Hours watched (${s.missingRuntime} film${s.missingRuntime === 1 ? '' : 's'} missing runtime)` : 'Hours watched';
    this.values['decade']!.textContent = s.decade;
    this.values['director']!.textContent = s.director;
    this.values['avg']!.textContent = s.avg === '—' ? '—' : `${s.avg} ★`;
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }
}
