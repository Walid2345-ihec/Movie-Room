/**
 * Keyless metadata + poster provider built on Wikipedia / Wikidata.
 *
 *  1. MediaWiki search (`generator=search`) for `"<title>" <year> film`, asking
 *     for each candidate page's infobox image (`pageimages`) and its Wikidata id.
 *  2. Wikidata `wbgetentities` on the candidates' Q-ids: keep the first one that
 *     is an instance of film (P31 → Q11424 or subclasses commonly used) and whose
 *     publication year (P577) is within ±1 of the Letterboxd year. Director (P57),
 *     duration (P2047) and genres (P136) come from the same claims.
 *  3. Director / genre Q-ids are resolved to English labels in batched calls.
 *
 * The poster is the article's infobox image served from upload.wikimedia.org,
 * which sends `Access-Control-Allow-Origin: *`, so it can become a WebGL texture.
 */
import type { Film, FilmMeta } from '../types';

const WIKI = 'https://en.wikipedia.org/w/api.php';
const WIKIDATA = 'https://www.wikidata.org/w/api.php';

// film, feature film, anime film, animated film, short film, silent film, documentary, TV film …
const FILM_CLASSES = new Set(['Q11424', 'Q24869', 'Q20650540', 'Q202866', 'Q506240', 'Q226730', 'Q20667187', 'Q29168811', 'Q24862', 'Q93204', 'Q17517379', 'Q1261214', 'Q2431196', 'Q7889']);

interface SearchPage {
  pageid: number;
  title: string;
  index: number;
  original?: { source: string; width: number; height: number };
  thumbnail?: { source: string };
  pageprops?: { wikibase_item?: string; disambiguation?: string };
}
interface SearchResponse {
  query?: { pages?: Record<string, SearchPage> };
}
interface Claim {
  mainsnak: { datavalue?: { value: unknown } };
}
interface Entity {
  claims?: Record<string, Claim[]>;
  labels?: Record<string, { value: string }>;
}
interface EntitiesResponse {
  entities?: Record<string, Entity>;
}

async function getJson<T>(base: string, params: Record<string, string>): Promise<T> {
  const url = new URL(base);
  url.searchParams.set('format', 'json');
  url.searchParams.set('origin', '*'); // anonymous CORS
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${res.status} ${base}`);
  return (await res.json()) as T;
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s*\((?:\d{4}\s+)?(?:film|movie)\)\s*$/i, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

function claimId(c: Claim | undefined): string | null {
  const v = c?.mainsnak.datavalue?.value as { id?: string } | undefined;
  return v?.id ?? null;
}
function claimYear(c: Claim | undefined): number | null {
  const v = c?.mainsnak.datavalue?.value as { time?: string } | undefined;
  const m = v?.time?.match(/^[+-]?(\d{4})/);
  return m ? parseInt(m[1]!, 10) : null;
}
function claimAmount(c: Claim | undefined): number | null {
  const v = c?.mainsnak.datavalue?.value as { amount?: string; unit?: string } | undefined;
  if (!v?.amount) return null;
  const n = parseFloat(v.amount);
  if (!Number.isFinite(n)) return null;
  if (v.unit?.endsWith('/Q25235')) return Math.round(n * 60); // hours
  if (v.unit?.endsWith('/Q11574')) return Math.round(n / 60); // seconds
  return Math.round(n); // minutes (Q7727) or unitless
}

// ---- Label cache (director / genre Q-ids → English names), batched -----------
const labelCache = new Map<string, string>();
let labelQueue: { id: string; resolve: (v: string) => void }[] = [];
let labelTimer = 0;

function label(id: string): Promise<string> {
  const hit = labelCache.get(id);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    labelQueue.push({ id, resolve });
    if (!labelTimer) labelTimer = window.setTimeout(flushLabels, 150);
  });
}
async function flushLabels(): Promise<void> {
  labelTimer = 0;
  const batch = labelQueue.splice(0, 50);
  if (labelQueue.length) labelTimer = window.setTimeout(flushLabels, 150);
  const ids = [...new Set(batch.map((b) => b.id))];
  let entities: Record<string, Entity> = {};
  try {
    entities = (await getJson<EntitiesResponse>(WIKIDATA, { action: 'wbgetentities', ids: ids.join('|'), props: 'labels', languages: 'en' })).entities ?? {};
  } catch {
    /* labels stay as ids */
  }
  for (const b of batch) {
    const name = entities[b.id]?.labels?.en?.value ?? b.id;
    labelCache.set(b.id, name);
    b.resolve(name);
  }
}

/** Resolve one film via Wikipedia + Wikidata. Returns null when nothing matches. */
export async function lookupWikipedia(film: Film): Promise<FilmMeta | null> {
  const query = `"${film.title}" ${film.year ?? ''} film`.trim();
  const res = await getJson<SearchResponse>(WIKI, {
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '6',
    gsrnamespace: '0',
    prop: 'pageimages|pageprops',
    piprop: 'original|thumbnail',
    pithumbsize: '600',
    pilicense: 'any', // enwiki hides fair-use posters unless asked
    ppprop: 'wikibase_item|disambiguation',
  });
  const pages = Object.values(res.query?.pages ?? {})
    .filter((p) => p.pageprops?.wikibase_item && p.pageprops.disambiguation === undefined)
    .sort((a, b) => a.index - b.index);
  if (!pages.length) return null;

  // Prefer candidates whose article title matches the film title; keep the rest as backups.
  const want = norm(film.title);
  const ranked = [...pages.filter((p) => norm(p.title) === want), ...pages.filter((p) => norm(p.title) !== want)];
  const ids = ranked.map((p) => p.pageprops!.wikibase_item!);
  const ent = (await getJson<EntitiesResponse>(WIKIDATA, { action: 'wbgetentities', ids: ids.join('|'), props: 'claims' })).entities ?? {};

  for (const page of ranked) {
    const qid = page.pageprops!.wikibase_item!;
    const claims = ent[qid]?.claims;
    if (!claims) continue;
    // Known film classes, or the strong structural signal of director + release date.
    const isFilm = (claims['P31'] ?? []).some((c) => FILM_CLASSES.has(claimId(c) ?? '')) || (claims['P57'] !== undefined && claims['P577'] !== undefined);
    if (!isFilm) continue;
    const years = (claims['P577'] ?? []).map(claimYear).filter((y): y is number => y !== null);
    const year = years.length ? Math.min(...years) : null;
    if (film.year && year && Math.abs(year - film.year) > 1) continue;
    if (norm(page.title) !== want && !norm(page.title).startsWith(want)) continue;

    const directorId = claimId(claims['P57']?.[0]);
    const genreIds = (claims['P136'] ?? []).map(claimId).filter((g): g is string => g !== null).slice(0, 3);
    const [director, ...genres] = await Promise.all([directorId ? label(directorId) : Promise.resolve(null), ...genreIds.map(label)]);
    const posterUrl = page.original?.source ?? page.thumbnail?.source ?? null;
    return {
      tmdbId: null,
      wikidataId: qid,
      posterUrl,
      runtime: claimAmount(claims['P2047']?.[0]),
      genres: genres.map((g) => g.replace(/\s+film$/i, '').replace(/^\w/, (c) => c.toUpperCase())),
      director,
      releaseYear: year,
      hue: null,
      fetchedAt: Date.now(),
    };
  }
  return null;
}
