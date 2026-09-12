/**
 * TMDB enrichment + IndexedDB cache + procedural cover fallback.
 *
 *  - enrichFilms(): batched, rate-limited /search/movie + /movie/{id} lookups.
 *  - Metadata and poster blobs are cached in IndexedDB so a second launch is
 *    instant and works offline.
 *  - With no API key (or a failed lookup) every film gets a deterministic
 *    procedural cover drawn on a 2D canvas, so the room is never empty.
 */
import type { Film, FilmMeta, ImportProgress } from '../types';

export const TMDB_KEY: string = (import.meta.env.VITE_TMDB_API_KEY as string | undefined)?.trim() ?? '';
export const hasTmdbKey = (): boolean => TMDB_KEY.length > 0;

const API = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/w342';

// ---------------------------------------------------------------------------
// IndexedDB cache
// ---------------------------------------------------------------------------
const DB_NAME = 'reelroom';
const DB_VERSION = 1;
const STORE_META = 'meta';
const STORE_POSTERS = 'posters';

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_POSTERS)) db.createObjectStore(STORE_POSTERS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => resolve(undefined);
  });
}

async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function clearCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction([STORE_META, STORE_POSTERS], 'readwrite');
    tx.objectStore(STORE_META).clear();
    tx.objectStore(STORE_POSTERS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

// ---------------------------------------------------------------------------
// TMDB lookups
// ---------------------------------------------------------------------------
interface SearchResult {
  id: number;
  title: string;
  release_date?: string;
  poster_path: string | null;
}
interface SearchResponse {
  results?: SearchResult[];
}
interface Crew {
  job: string;
  name: string;
}
interface MovieResponse {
  id: number;
  runtime: number | null;
  genres?: { name: string }[];
  poster_path: string | null;
  credits?: { crew?: Crew[] };
}

/** Simple token-bucket limiter: TMDB allows ~50 req/s; we stay well under. */
class RateLimiter {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly concurrency: number, private readonly minGapMs: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
    try {
      return await fn();
    } finally {
      setTimeout(() => {
        this.active--;
        this.pump();
      }, this.minGapMs);
    }
  }
  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      this.active++;
      this.queue.shift()!();
    }
  }
}
const limiter = new RateLimiter(4, 120);

async function tmdbFetch<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const url = new URL(API + path);
  url.searchParams.set('api_key', TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url.toString());
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After') ?? '2') * 1000;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) return null;
    return (await res.json()) as T;
  }
  return null;
}

async function lookupOne(film: Film): Promise<FilmMeta | null> {
  const params: Record<string, string> = { query: film.title, include_adult: 'false' };
  if (film.year) params.year = String(film.year);
  let search = await tmdbFetch<SearchResponse>('/search/movie', params);
  let hit = search?.results?.[0];
  if (!hit && film.year) {
    // Year mismatch between Letterboxd and TMDB is common; retry without it.
    search = await tmdbFetch<SearchResponse>('/search/movie', { query: film.title, include_adult: 'false' });
    hit = search?.results?.[0];
  }
  if (!hit) return null;
  const movie = await tmdbFetch<MovieResponse>(`/movie/${hit.id}`, { append_to_response: 'credits' });
  const director = movie?.credits?.crew?.find((c) => c.job === 'Director')?.name ?? null;
  const posterPath = movie?.poster_path ?? hit.poster_path;
  return {
    tmdbId: hit.id,
    posterUrl: posterPath ? IMG + posterPath : null,
    runtime: movie?.runtime ?? null,
    genres: movie?.genres?.map((g) => g.name) ?? [],
    director,
    hue: null,
    fetchedAt: Date.now(),
  };
}

function applyMeta(film: Film, m: FilmMeta): void {
  film.tmdbId = m.tmdbId;
  film.posterUrl = m.posterUrl;
  film.runtime = m.runtime ?? film.runtime;
  film.genres = m.genres.length ? m.genres : film.genres;
  film.director = m.director ?? film.director;
  film.hue = m.hue;
  film.procedural = !m.posterUrl;
}

/**
 * Enrich films in place. Cached entries resolve immediately; misses are
 * fetched in rate-limited batches. Reports progress via `onProgress`.
 */
export async function enrichFilms(films: Film[], onProgress: (p: ImportProgress) => void): Promise<void> {
  let done = 0;
  const total = films.length;
  const misses: Film[] = [];

  for (const f of films) {
    const cached = await idbGet<FilmMeta>(STORE_META, f.id);
    if (cached) applyMeta(f, cached);
    else misses.push(f);
    done++;
    if (done % 25 === 0) onProgress({ done, total, label: 'Reading cache…' });
  }

  if (!hasTmdbKey() || !misses.length) {
    // Fallback: assign a deterministic hue so the rainbow sort still works.
    for (const f of films) if (f.hue === null) f.hue = hashHue(f.title);
    onProgress({ done: total, total, label: hasTmdbKey() ? 'Ready' : 'No TMDB key — procedural covers' });
    return;
  }

  done = total - misses.length;
  const BATCH = 8;
  for (let i = 0; i < misses.length; i += BATCH) {
    const batch = misses.slice(i, i + BATCH);
    await Promise.all(
      batch.map((f) =>
        limiter.run(async () => {
          let meta: FilmMeta | null = null;
          try {
            meta = await lookupOne(f);
          } catch {
            meta = null;
          }
          if (meta) {
            if (meta.posterUrl) {
              const img = await loadPosterImage(f.id, meta.posterUrl);
              meta.hue = img ? dominantHue(img) : hashHue(f.title);
            } else meta.hue = hashHue(f.title);
            applyMeta(f, meta);
            await idbPut(STORE_META, f.id, meta);
          } else {
            f.hue = hashHue(f.title);
          }
          done++;
          onProgress({ done, total, label: `Matching "${f.title}"` });
        }),
      ),
    );
  }
  onProgress({ done: total, total, label: 'Ready' });
}

// ---------------------------------------------------------------------------
// Poster loading (blob cache) + procedural fallback
// ---------------------------------------------------------------------------
export type CoverSource = HTMLImageElement | HTMLCanvasElement;

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('decode failed'));
      img.src = url;
    });
    return img;
  } finally {
    // Revoke on next tick so the decode has finished using the URL.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Load a poster from the IDB blob cache, or fetch (crossOrigin) + cache it. */
export async function loadPosterImage(filmId: string, url: string): Promise<HTMLImageElement | null> {
  const cached = await idbGet<Blob>(STORE_POSTERS, filmId);
  if (cached) {
    try {
      return await blobToImage(cached);
    } catch {
      /* fall through and refetch */
    }
  }
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) return null;
    const blob = await res.blob();
    await idbPut(STORE_POSTERS, filmId, blob);
    return await blobToImage(blob);
  } catch {
    return null;
  }
}

/**
 * Resolve the cover to draw on a case: cached/fetched poster when available,
 * otherwise a procedural canvas. Never rejects.
 */
export async function resolveCover(film: Film): Promise<CoverSource> {
  if (film.posterUrl) {
    const img = await loadPosterImage(film.id, film.posterUrl);
    if (img) return img;
  }
  return proceduralCover(film);
}

// ---- Colour utilities -------------------------------------------------------
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export const hashHue = (s: string): number => hashString(s) % 360;

/** Average hue of saturated pixels in an image, sampled at low resolution. */
export function dominantHue(img: CoverSource): number {
  const c = document.createElement('canvas');
  c.width = 24;
  c.height = 36;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 0;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, c.width, c.height).data;
  } catch {
    return 0; // tainted canvas (CORS) — should not happen with crossOrigin
  }
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]! / 255;
    const g = data[i + 1]! / 255;
    const b = data[i + 2]! / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d < 0.15 || max < 0.15) continue;
    let h = 0;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    const w = d; // weight by saturation
    sx += Math.cos((h * Math.PI) / 180) * w;
    sy += Math.sin((h * Math.PI) / 180) * w;
  }
  if (sx === 0 && sy === 0) return 0;
  let hue = (Math.atan2(sy, sx) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return hue;
}

// ---- Procedural cover --------------------------------------------------------
const PALETTES: [string, string, string][] = [
  ['#1b1f3b', '#f2c14e', '#f78154'],
  ['#0b3954', '#bfd7ea', '#ff6663'],
  ['#2d3142', '#ef8354', '#ffffff'],
  ['#3a0ca3', '#f72585', '#4cc9f0'],
  ['#1f2421', '#dce1de', '#49a078'],
  ['#231942', '#e0b1cb', '#9f86c0'],
  ['#6a040f', '#ffba08', '#f48c06'],
  ['#0d1b2a', '#e0e1dd', '#778da9'],
  ['#264653', '#e9c46a', '#f4a261'],
  ['#14213d', '#fca311', '#e5e5e5'],
  ['#132a13', '#ecf39e', '#90a955'],
  ['#3d0000', '#ffd6a5', '#ff5c5c'],
];

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
    } else cur = test;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Deterministic 2D-canvas cover: palette hashed from the title, big
 * typographic title, year, star rating and a geometric motif.
 */
export function proceduralCover(film: Film, w = 342, h = 513): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const hash = hashString(film.title);
  const [bg, accent, fg] = PALETTES[hash % PALETTES.length]!;

  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Motif: hashed choice of circle / diagonal band / concentric rings
  ctx.save();
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = accent;
  const motif = (hash >> 4) % 3;
  if (motif === 0) {
    ctx.beginPath();
    ctx.arc(w * 0.62, h * 0.42, w * 0.38, 0, Math.PI * 2);
    ctx.fill();
  } else if (motif === 1) {
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-0.5);
    ctx.fillRect(-w, -h * 0.12, w * 2, h * 0.24);
  } else {
    ctx.strokeStyle = accent;
    ctx.lineWidth = 10;
    for (let r = w * 0.1; r < w * 0.7; r += 28) {
      ctx.beginPath();
      ctx.arc(w * 0.3, h * 0.35, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();

  // Title
  ctx.fillStyle = fg;
  ctx.textBaseline = 'top';
  let size = 44;
  ctx.font = `800 ${size}px system-ui, "Segoe UI", Helvetica, Arial, sans-serif`;
  let lines = wrapLines(ctx, film.title.toUpperCase(), w - 48);
  while (lines.length > 5 && size > 22) {
    size -= 4;
    ctx.font = `800 ${size}px system-ui, "Segoe UI", Helvetica, Arial, sans-serif`;
    lines = wrapLines(ctx, film.title.toUpperCase(), w - 48);
  }
  const lh = size * 1.08;
  let y = h * 0.55;
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 8;
  for (const line of lines) {
    ctx.fillText(line, 24, y);
    y += lh;
  }
  ctx.shadowBlur = 0;

  // Year + rating
  ctx.font = `500 20px system-ui, "Segoe UI", Helvetica, Arial, sans-serif`;
  ctx.fillStyle = fg;
  ctx.globalAlpha = 0.85;
  ctx.fillText(film.year ? String(film.year) : '—', 24, h - 64);
  if (film.rating !== null) {
    const full = Math.floor(film.rating);
    const half = film.rating - full >= 0.5;
    const stars = '★'.repeat(full) + (half ? '½' : '');
    ctx.textAlign = 'right';
    ctx.fillText(stars, w - 24, h - 64);
    ctx.textAlign = 'left';
  }
  ctx.globalAlpha = 1;

  // Thin frame
  ctx.strokeStyle = fg;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 3;
  ctx.strokeRect(10, 10, w - 20, h - 20);
  ctx.globalAlpha = 1;
  return c;
}
