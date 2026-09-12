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
  posterUrl: string | null;
  runtime: number | null;
  genres: string[];
  director: string | null;
  /** Dominant hue (0..360) sampled from the poster; used by the rainbow sort. */
  hue: number | null;
  /** True when the cover was generated procedurally (no TMDB match / no key). */
  procedural: boolean;
}

/** Enrichment payload persisted in IndexedDB, keyed by Film.id. */
export interface FilmMeta {
  tmdbId: number | null;
  posterUrl: string | null;
  runtime: number | null;
  genres: string[];
  director: string | null;
  hue: number | null;
  fetchedAt: number;
}

export type ShelfKind = 'wall' | 'bookcase' | 'stand';

/** A shelf placed in the room on the snap grid. */
export interface ShelfPlacement {
  id: string;
  kind: ShelfKind;
  /** Grid cell coordinates (x along the back wall, z toward the camera). */
  gx: number;
  gz: number;
  /** Rotation in quarter turns (0..3). */
  rot: number;
  /** Height offset for wall shelves (metres). Ignored for floor units. */
  y: number;
}

export type SortMode = 'rating' | 'year' | 'director' | 'genre' | 'runtime' | 'hue' | 'title';
export type CameraMode = 'orbit' | 'walk';

export interface RoomTheme {
  wall: string;
  wood: string;
  floor: string;
}

/** Everything needed to rebuild the room exactly. Persisted to localStorage. */
export interface RoomLayout {
  version: 1;
  shelves: ShelfPlacement[];
  /** filmId → global slot id ("shelfId:slotIndex"). */
  assignments: Record<string, string>;
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
