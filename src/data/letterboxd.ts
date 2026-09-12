/**
 * Letterboxd export parsing — 100% client side, nothing leaves the browser.
 *
 * A Letterboxd export ZIP contains (among others):
 *   watched.csv   Date,Name,Year,Letterboxd URI
 *   ratings.csv   Date,Name,Year,Letterboxd URI,Rating
 *   watchlist.csv Date,Name,Year,Letterboxd URI
 *   diary.csv     Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date
 *
 * All of them are merged into one Film[] keyed by `${slug}-${year}`.
 */
import JSZip from 'jszip';
import type { Film } from '../types';

type Row = Record<string, string>;

/** Minimal RFC-4180 CSV parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): Row[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const pushRow = (): void => {
    row.push(field);
    field = '';
    if (row.some((f) => f.length > 0)) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      pushRow();
    } else field += c;
  }
  if (field.length || row.length) pushRow();

  const header = rows.shift();
  if (!header) return [];
  return rows.map((r) => {
    const obj: Row = {};
    header.forEach((h, i) => {
      obj[h.trim()] = (r[i] ?? '').trim();
    });
    return obj;
  });
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function filmId(title: string, year: number | null): string {
  return `${slugify(title)}-${year ?? 'x'}`;
}

export function emptyFilm(title: string, year: number | null, uri: string | null): Film {
  return {
    id: filmId(title, year),
    title,
    year,
    letterboxdUri: uri,
    rating: null,
    watchedDate: null,
    onWatchlist: false,
    watchCount: 0,
    tmdbId: null,
    posterUrl: null,
    runtime: null,
    genres: [],
    director: null,
    hue: null,
    procedural: true,
  };
}

interface Buckets {
  watched: Row[];
  ratings: Row[];
  watchlist: Row[];
  diary: Row[];
  generic: Row[];
}

const newer = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b);

/** Merge CSV buckets into one normalised Film list. */
export function mergeRows(b: Buckets): Film[] {
  const films = new Map<string, Film>();
  const upsert = (r: Row): Film | null => {
    const title = r['Name'] ?? r['Title'] ?? '';
    if (!title) return null;
    const yearRaw = parseInt(r['Year'] ?? '', 10);
    const year = Number.isFinite(yearRaw) ? yearRaw : null;
    const id = filmId(title, year);
    let f = films.get(id);
    if (!f) {
      f = emptyFilm(title, year, r['Letterboxd URI'] || null);
      films.set(id, f);
    }
    if (!f.letterboxdUri && r['Letterboxd URI']) f.letterboxdUri = r['Letterboxd URI'];
    return f;
  };
  const applyRating = (f: Film, r: Row): void => {
    const rt = parseFloat(r['Rating'] ?? '');
    if (Number.isFinite(rt)) f.rating = rt;
  };

  for (const r of b.watched) {
    const f = upsert(r);
    if (f) f.watchedDate = newer(f.watchedDate, r['Date'] || null);
  }
  for (const r of b.generic) {
    const f = upsert(r);
    if (!f) continue;
    applyRating(f, r);
    f.watchedDate = newer(f.watchedDate, r['Watched Date'] || r['Date'] || null);
  }
  for (const r of b.ratings) {
    const f = upsert(r);
    if (f) applyRating(f, r);
  }
  for (const r of b.diary) {
    const f = upsert(r);
    if (!f) continue;
    f.watchCount += 1;
    applyRating(f, r);
    f.watchedDate = newer(f.watchedDate, r['Watched Date'] || r['Date'] || null);
  }
  for (const r of b.watchlist) {
    const f = upsert(r);
    if (f && !f.watchedDate) f.onWatchlist = true;
  }
  for (const f of films.values()) if (f.watchCount === 0 && f.watchedDate) f.watchCount = 1;
  return [...films.values()];
}

/** Accepts a Letterboxd .zip export or a single .csv file. */
export async function importLetterboxdFile(file: File): Promise<Film[]> {
  const b: Buckets = { watched: [], ratings: [], watchlist: [], diary: [], generic: [] };
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.zip')) {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter((e) => !e.dir && e.name.toLowerCase().endsWith('.csv'));
    for (const e of entries) {
      const base = (e.name.split('/').pop() ?? '').toLowerCase();
      const rows = parseCsv(await e.async('string'));
      if (base === 'watched.csv') b.watched = rows;
      else if (base === 'ratings.csv') b.ratings = rows;
      else if (base === 'watchlist.csv') b.watchlist = rows;
      else if (base === 'diary.csv') b.diary = rows;
      // likes/, lists/, comments.csv, profile.csv … are ignored.
    }
  } else {
    const rows = parseCsv(await file.text());
    if (lower.includes('watchlist')) b.watchlist = rows;
    else if (lower.includes('diary')) b.diary = rows;
    else if (lower.includes('rating')) b.ratings = rows;
    else b.generic = rows;
  }
  const films = mergeRows(b);
  if (!films.length) throw new Error('No films found. Expected columns: Name, Year, Letterboxd URI.');
  return films;
}
