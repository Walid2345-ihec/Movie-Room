/**
 * Shared domain types used end-to-end (data → scene → UI → persistence).
 * Keep this file dependency-free so every layer can import it.
 */

/** A single film in the user's collection. Merged from Letterboxd + TMDB. */
export interface Film {
  /** Stable id: `${slug}-${year}` derived from the Letterboxd row. */
  id: string;
  title: string;
  year: number | null;
  /** Letterboxd URI (e.g. https://boxd.it/abc) if present in the export. */
  letterboxdUri: string | null;
  /** User's own rating 0.5..5 (Letterboxd half-star scale) or null. */
  rating: number | null;
  /** ISO date (YYYY-MM-DD) of the latest watch, if known. */
  watchedDate: string | null;
  /** True if the film came from watchlist.csv rather than a watched list. */
  onWatchlist: boolean;
  /** How many diary entries reference this film (rewatches). */
  watchCount: number;

  // ---- Enriched from TMDB (or procedurally faked in fallback mode) ----
  tmdbId: number | null;
  /** Wikidata entity (e.g. "Q47703") when matched through Wikipedia. */
  wikidataId: string | null;
  posterUrl: string | null;
  runtime: number | null;
  genres: string[];
  director: string | null;
  /** Release year from the provider (may differ from the Letterboxd year). */
  releaseYear: number | null;
  /** Dominant hue (0..360) sampled from the poster; used by the rainbow sort. */
  hue: number | null;
  /** True when the cover was generated procedurally (no TMDB match / no key). */
  procedural: boolean;
}

/** Enrichment payload persisted in IndexedDB, keyed by Film.id. */
export interface FilmMeta {
  tmdbId: number | null;
  wikidataId: string | null;
  posterUrl: string | null;
  runtime: number | null;
  genres: string[];
  director: string | null;
  releaseYear: number | null;
  hue: number | null;
  fetchedAt: number;
}

export type ShelfKind = 'gondola' | 'wall' | 'endcap';

/**
 * One shelving unit in the store. Positions are metres in the room frame
 * (origin at the room centre, Y up, +Z toward the entrance).
 */
export interface ShelfPlacement {
  id: string;
  kind: ShelfKind;
  x: number;
  z: number;
  /** Yaw in radians. The unit's shelves face local +Z (gondolas: both ±Z). */
  rot: number;
  /** Number of 1 m bays along the unit. */
  bays: number;
}

/** Procedurally generated store: room envelope + shelving units. */
export interface StorePlan {
  width: number;
  depth: number;
  height: number;
  units: ShelfPlacement[];
}

export type SortMode = 'rating' | 'year' | 'director' | 'genre' | 'runtime' | 'hue' | 'title';
export type CameraMode = 'orbit' | 'walk';

export interface RoomTheme {
  wall: string;
  /** Shelving steel colour. */
  wood: string;
  floor: string;
}

/** Everything needed to rebuild the store exactly. Persisted to localStorage. */
export interface RoomLayout {
  version: 2;
  plan: StorePlan;
  /** filmId → global slot id ("unitId:slotIndex"). */
  assignments: Record<string, string>;
  /** Films the user placed by hand; auto-arrange leaves them where they are. */
  pinned: string[];
  cameraMode: CameraMode;
  theme: RoomTheme;
  sortMode: SortMode;
}

export type AppPhase = 'import' | 'loading' | 'room' | 'inspect';

export interface ImportProgress {
  done: number;
  total: number;
  label: string;
}
