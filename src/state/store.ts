/**
 * Typed application state with a tiny pub/sub and localStorage persistence.
 * The scene and the UI both subscribe to this; neither talks to the other directly.
 */
import type { AppPhase, CameraMode, Film, ImportProgress, RoomLayout, RoomTheme, SortMode, StorePlan } from '../types';
import { planStore } from '../scene/room';

export interface AppState {
  phase: AppPhase;
  films: Film[];
  progress: ImportProgress;
  layout: RoomLayout;
  /** Film currently lifted to the inspect pose (or null). */
  inspectId: string | null;
  hoverId: string | null;
  search: string;
  /** Set when a real Letterboxd import replaced the bundled sample. */
  source: 'sample' | 'import';
}

export type StateKey = keyof AppState;
type Listener = (state: AppState, changed: Set<StateKey>) => void;

const LS_LAYOUT = 'reelroom:layout:v2';
const LS_FILMS = 'reelroom:films:v1';

/** Retail look: white walls, black powder-coated steel, pale tile. */
export const DEFAULT_THEME: RoomTheme = { wall: '#f1f0ec', wood: '#1f1f22', floor: '#e2ded6' };

export function defaultLayout(filmCount = 0): RoomLayout {
  return { version: 2, plan: planStore(filmCount), assignments: {}, pinned: [], cameraMode: 'orbit', theme: { ...DEFAULT_THEME }, sortMode: 'genre' };
}

function isLayout(v: unknown): v is RoomLayout {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const plan = o.plan as Partial<StorePlan> | undefined;
  return o.version === 2 && !!plan && Array.isArray(plan.units) && typeof plan.width === 'number' && typeof o.assignments === 'object' && typeof o.theme === 'object' && Array.isArray(o.pinned);
}

export function loadLayout(): RoomLayout | null {
  try {
    const raw = localStorage.getItem(LS_LAYOUT);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isLayout(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseLayoutJson(text: string): RoomLayout {
  const parsed: unknown = JSON.parse(text);
  if (!isLayout(parsed)) throw new Error('Not a REELROOM layout file.');
  return parsed;
}

function loadFilms(): Film[] | null {
  try {
    const raw = localStorage.getItem(LS_FILMS);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Film[]) : null;
  } catch {
    return null;
  }
}

class Store {
  private state: AppState;
  private listeners = new Set<Listener>();
  private pending = new Set<StateKey>();
  private scheduled = false;

  constructor() {
    const savedFilms = loadFilms();
    this.state = {
      phase: 'loading',
      films: savedFilms ?? [],
      progress: { done: 0, total: 0, label: '' },
      layout: loadLayout() ?? defaultLayout(),
      inspectId: null,
      hoverId: null,
      search: '',
      source: savedFilms ? 'import' : 'sample',
    };
  }

  get(): AppState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Shallow-merge a patch; listeners are notified once per microtask. */
  set(patch: Partial<AppState>): void {
    for (const k of Object.keys(patch) as StateKey[]) this.pending.add(k);
    this.state = { ...this.state, ...patch };
    if (!this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        const changed = this.pending;
        this.pending = new Set();
        for (const l of this.listeners) l(this.state, changed);
      });
    }
  }

  // ---- Convenience mutators --------------------------------------------------
  setPhase(phase: AppPhase): void {
    this.set({ phase });
  }
  setProgress(progress: ImportProgress): void {
    this.set({ progress });
  }
  setFilms(films: Film[], source: AppState['source']): void {
    this.set({ films, source });
    if (source === 'import') {
      try {
        localStorage.setItem(LS_FILMS, JSON.stringify(films));
      } catch {
        /* quota exceeded: layout still persists, films will need re-import */
      }
    } else localStorage.removeItem(LS_FILMS);
  }
  patchLayout(patch: Partial<RoomLayout>): void {
    const layout: RoomLayout = { ...this.state.layout, ...patch };
    this.set({ layout });
    this.persistLayout(layout);
  }
  setAssignments(assignments: Record<string, string>): void {
    this.patchLayout({ assignments });
  }
  setCameraMode(cameraMode: CameraMode): void {
    this.patchLayout({ cameraMode });
  }
  setTheme(theme: Partial<RoomTheme>): void {
    this.patchLayout({ theme: { ...this.state.layout.theme, ...theme } });
  }
  setSortMode(sortMode: SortMode): void {
    this.patchLayout({ sortMode });
  }
  setPinned(pinned: Iterable<string>): void {
    this.patchLayout({ pinned: [...pinned] });
  }
  setPlan(plan: StorePlan): void {
    this.patchLayout({ plan });
  }
  resetLayout(): void {
    const layout = defaultLayout(this.state.films.length);
    this.set({ layout });
    this.persistLayout(layout);
  }
  replaceLayout(layout: RoomLayout): void {
    this.set({ layout });
    this.persistLayout(layout);
  }
  /** Full wipe: films, layout, persisted keys. Leaves the app on the Import screen. */
  clearAll(): void {
    localStorage.removeItem(LS_LAYOUT);
    localStorage.removeItem(LS_FILMS);
    this.set({ films: [], layout: defaultLayout(), source: 'sample', inspectId: null, hoverId: null, search: '', progress: { done: 0, total: 0, label: '' }, phase: 'import' });
  }

  private persistLayout(layout: RoomLayout): void {
    try {
      localStorage.setItem(LS_LAYOUT, JSON.stringify(layout));
    } catch {
      /* ignore */
    }
  }
}

export const store = new Store();
