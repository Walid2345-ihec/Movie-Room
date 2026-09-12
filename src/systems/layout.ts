/**
 * Layout system: sort strategies, slot assignment and tween scheduling.
 *
 * Owns filmId → Slot. Auto-arrange fills the unpinned films into the slots
 * left free by pinned (hand-placed) films; drag/drop mutates through place()
 * and swap() and pins the moved film so later sorts leave it alone.
 */
import * as THREE from 'three';
import type { Film, SortMode } from '../types';
import type { CaseBatch } from '../scene/case';
import type { Room, Slot } from '../scene/room';
import { TweenManager, easeInOutCubic } from './tween';

const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _fromP = new THREE.Vector3();
const _fromQ = new THREE.Quaternion();
const _fwd = new THREE.Vector3();

export type SortStrategy = (a: Film, b: Film) => number;

const byTitle: SortStrategy = (a, b) => a.title.localeCompare(b.title);
const numDesc = (x: number | null, y: number | null): number => (y ?? -1) - (x ?? -1);
const numAsc = (x: number | null, y: number | null): number => (x ?? Infinity) - (y ?? Infinity);
const str = (x: string | null | undefined, y: string | null | undefined): number => (x ?? '~').localeCompare(y ?? '~');

export const SORTS: Record<SortMode, SortStrategy> = {
  title: byTitle,
  rating: (a, b) => numDesc(a.rating, b.rating) || byTitle(a, b),
  year: (a, b) => numAsc(a.releaseYear ?? a.year, b.releaseYear ?? b.year) || byTitle(a, b),
  director: (a, b) => str(a.director?.split(' ').pop(), b.director?.split(' ').pop()) || str(a.director, b.director) || numAsc(a.year, b.year),
  genre: (a, b) => str(primaryGenre(a), primaryGenre(b)) || numDesc(a.rating, b.rating) || byTitle(a, b),
  runtime: (a, b) => numAsc(a.runtime, b.runtime) || byTitle(a, b),
  hue: (a, b) => numAsc(a.hue, b.hue) || byTitle(a, b),
};

export const SORT_LABELS: Record<SortMode, string> = {
  genre: 'Genre',
  rating: 'Rating',
  year: 'Year',
  director: 'Director',
  runtime: 'Runtime',
  hue: 'Rainbow',
  title: 'Title',
};

/** Retail category buckets, in the order they appear on the header signs. */
const CATEGORY_RULES: [string, RegExp][] = [
  ['ACTION', /action|adventure|war|western|martial|superhero/i],
  ['HORROR', /horror|slasher|zombie|supernatural/i],
  ['SCI-FI', /science fiction|sci-fi|cyberpunk|space|dystopi|post-apocalyptic|tech noir/i],
  ['COMEDY', /comedy|comic|parody|satir/i],
  ['ANIMATION', /animat|anime|stop motion|cartoon/i],
  ['THRILLER', /thriller|crime|mystery|noir|heist|spy/i],
  ['DRAMA', /drama|romance|romantic|biograph|historical|coming-of-age|independent|art film|slice of life/i],
  ['CLASSICS', /.^/], // fallback bucket
];

export function categoryOf(film: Film): string {
  const year = film.releaseYear ?? film.year;
  for (const [name, re] of CATEGORY_RULES) if (film.genres.some((g) => re.test(g))) return year !== null && year < 1970 && name === 'DRAMA' ? 'CLASSICS' : name;
  return year !== null && year < 1970 ? 'CLASSICS' : 'DRAMA';
}
function primaryGenre(f: Film): string {
  const i = CATEGORY_RULES.findIndex(([name]) => name === categoryOf(f));
  return `${String(i).padStart(2, '0')}-${f.genres[0] ?? ''}`;
}

export class LayoutSystem {
  readonly tweens = new TweenManager();
  /** Slots in fill order: wall runs first, then gondolas; per bay top row → bottom. */
  slots: Slot[] = [];
  readonly slotById = new Map<string, Slot>();
  /** filmId → slotId */
  readonly assignments = new Map<string, string>();
  /** Films placed by hand; auto-arrange skips them. */
  readonly pinned = new Set<string>();
  /** Films matching the current search; they sit a little proud of the row. */
  readonly pushed = new Set<string>();
  /** Temporary lateral nudges (metres along the row) used for the insertion preview. */
  readonly nudge = new Map<string, number>();

  constructor(
    private readonly room: Room,
    private batch: CaseBatch,
  ) {}

  setBatch(batch: CaseBatch): void {
    this.batch = batch;
    this.assignments.clear();
    this.nudge.clear();
  }

  /** Refresh slot list from the room (after the store is rebuilt). Assignments to vanished slots are dropped. */
  refreshSlots(): void {
    this.slots = this.room.allSlots();
    this.slotById.clear();
    for (const s of this.slots) {
      s.occupant = null;
      this.slotById.set(s.id, s);
    }
    for (const [film, slotId] of [...this.assignments]) {
      const s = this.slotById.get(slotId);
      if (!s || s.occupant) this.assignments.delete(film);
      else s.occupant = film;
    }
  }

  get capacity(): number {
    return this.slots.length;
  }

  /**
   * Compute assignments for a sort mode: pinned films keep their slots, the
   * rest are laid out in sorted order into the remaining slots.
   */
  arrange(films: Film[], mode: SortMode): Map<string, string> {
    const out = new Map<string, string>();
    const taken = new Set<string>();
    for (const f of films) {
      if (!this.pinned.has(f.id)) continue;
      const slotId = this.assignments.get(f.id);
      if (slotId && !taken.has(slotId)) {
        out.set(f.id, slotId);
        taken.add(slotId);
      }
    }
    const sorted = films.filter((f) => !out.has(f.id)).sort(SORTS[mode]);
    let si = 0;
    for (const f of sorted) {
      while (si < this.slots.length && taken.has(this.slots[si]!.id)) si++;
      const slot = this.slots[si];
      if (!slot) break;
      out.set(f.id, slot.id);
      taken.add(slot.id);
    }
    return out;
  }

  /** Replace all assignments and animate cases to their new slots (staggered). */
  apply(assignments: Map<string, string> | Record<string, string>, animate = true): void {
    const next = assignments instanceof Map ? assignments : new Map(Object.entries(assignments));
    for (const s of this.slots) s.occupant = null;
    this.assignments.clear();
    let k = 0;
    for (const film of this.batch.films) {
      const slotId = next.get(film.id);
      const slot = slotId ? this.slotById.get(slotId) : undefined;
      if (!slot || slot.occupant) {
        this.park(film.id);
        continue;
      }
      slot.occupant = film.id;
      this.assignments.set(film.id, slot.id);
      this.moveToSlot(film.id, slot, animate ? 0.7 : 0, animate ? (k++ % 80) * 0.01 : 0);
    }
  }

  /** Fill any unassigned films into free slots. */
  fillGaps(films: Film[], mode: SortMode): void {
    const missing = films.filter((f) => !this.assignments.has(f.id)).sort(SORTS[mode]);
    if (!missing.length) return;
    let si = 0;
    for (const f of missing) {
      while (si < this.slots.length && this.slots[si]!.occupant) si++;
      const slot = this.slots[si];
      if (!slot) break;
      slot.occupant = f.id;
      this.assignments.set(f.id, slot.id);
      this.moveToSlot(f.id, slot, 0.6, 0);
    }
  }

  /** Cases without a slot are stacked on the checkout counter. */
  private park(filmId: string): void {
    const i = this.batch.indexOf.get(filmId);
    if (i === undefined) return;
    const b = this.room.bounds;
    const n = i % 40;
    _pos.set(b.maxX - 1.9 + (n % 8) * 0.15, 1.0 + Math.floor(n / 8) * 0.015, b.maxZ - 1.0 + Math.floor(i / 40) * 0.2);
    _quat.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, (i % 7) * 0.05));
    this.batch.setMatrix(i, _m.compose(_pos, _quat, _scale));
    this.batch.setRestMatrix(i, _m);
  }

  slotOf(filmId: string): Slot | undefined {
    const id = this.assignments.get(filmId);
    return id ? this.slotById.get(id) : undefined;
  }

  /** Every film currently in the same row as `slot` (excluding `except`). */
  rowMates(slot: Slot, except?: string): { film: string; slot: Slot }[] {
    const out: { film: string; slot: Slot }[] = [];
    for (const s of this.slots) if (s.rowKey === slot.rowKey && s.occupant && s.occupant !== except) out.push({ film: s.occupant, slot: s });
    return out;
  }

  /** Move a case into `slot` by hand (unassigning it from wherever it was) and pin it. */
  place(filmId: string, slot: Slot, duration = 0.35): void {
    const prev = this.slotOf(filmId);
    if (prev) prev.occupant = null;
    slot.occupant = filmId;
    this.assignments.set(filmId, slot.id);
    this.pinned.add(filmId);
    this.moveToSlot(filmId, slot, duration, 0);
  }

  /** Drop `filmId` onto an occupied slot: the occupant takes the dragged case's origin slot. Both become pinned. */
  swap(filmId: string, target: Slot): void {
    const other = target.occupant;
    const origin = this.slotOf(filmId);
    if (other && other !== filmId && origin) {
      origin.occupant = other;
      this.assignments.set(other, origin.id);
      this.pinned.add(other);
      this.moveToSlot(other, origin, 0.4, 0);
      target.occupant = filmId;
      this.assignments.set(filmId, target.id);
      this.pinned.add(filmId);
      this.moveToSlot(filmId, target, 0.35, 0);
    } else this.place(filmId, target);
  }

  /** World transform a case should have when resting in a slot (jitter, search push and row nudge included). */
  slotTransform(slot: Slot, filmId: string, outP: THREE.Vector3, outQ: THREE.Quaternion): void {
    const unit = this.room.shelves.get(slot.shelfId);
    if (unit) unit.casePose(slot, filmId, outP, outQ);
    else {
      outP.copy(slot.position);
      outQ.copy(slot.quaternion);
    }
    const nudge = this.nudge.get(filmId);
    if (nudge) outP.addScaledVector(slot.lateral, nudge);
    if (this.pushed.has(filmId)) {
      // Search matches slide 25 mm out of the row toward the aisle.
      _fwd.set(0, 0, 1).applyQuaternion(slot.quaternion);
      outP.addScaledVector(_fwd, 0.025);
    }
  }

  /** Re-seat cases that are resting in their slot (after search push / nudge changes). */
  reseat(ids: Iterable<string>, exclude: Set<string>, duration = 0.25): void {
    for (const id of ids) {
      if (exclude.has(id)) continue;
      const slot = this.slotOf(id);
      if (slot) this.moveToSlot(id, slot, duration, 0);
    }
  }

  /** Tween instance `filmId` from its current matrix to the slot pose (and set the rest pose for picking). */
  moveToSlot(filmId: string, slot: Slot, duration: number, delay: number): void {
    const i = this.batch.indexOf.get(filmId);
    if (i === undefined) return;
    const toP = new THREE.Vector3();
    const toQ = new THREE.Quaternion();
    this.slotTransform(slot, filmId, toP, toQ);
    this.batch.setRestMatrix(i, _m.compose(toP, toQ, _scale.set(1, 1, 1)));
    this.tweenTo(filmId, toP, toQ, duration, delay);
  }

  /** Generic pose tween for one instance (also used by picking for select/return). */
  tweenTo(filmId: string, toP: THREE.Vector3, toQ: THREE.Quaternion, duration: number, delay = 0, onComplete?: () => void): void {
    const i = this.batch.indexOf.get(filmId);
    if (i === undefined) return;
    this.batch.getMatrix(i, _m).decompose(_fromP, _fromQ, _scale);
    if (duration <= 0) {
      this.batch.setMatrix(i, _m.compose(toP, toQ, _scale.set(1, 1, 1)));
      onComplete?.();
      return;
    }
    const fromP = _fromP.clone();
    const fromQ = _fromQ.clone();
    // Long moves arc out of the row so cases don't slide through their neighbours.
    const dist = fromP.distanceTo(toP);
    const lift = dist > 0.05 ? Math.min(0.2, dist * 0.3) : 0;
    this.tweens.start({
      key: `case:${filmId}`,
      duration,
      delay,
      ease: easeInOutCubic,
      onUpdate: (t) => {
        _pos.lerpVectors(fromP, toP, t);
        _pos.y += Math.sin(t * Math.PI) * lift;
        _quat.slerpQuaternions(fromQ, toQ, t);
        this.batch.setMatrix(i, _m.compose(_pos, _quat, _scale.set(1, 1, 1)));
      },
      onComplete,
    });
  }

  /** Dominant category per shelving unit, for the header signs. */
  unitCategories(films: Map<string, Film>): Map<string, string> {
    const counts = new Map<string, Map<string, number>>();
    for (const s of this.slots) {
      if (!s.occupant) continue;
      const f = films.get(s.occupant);
      if (!f) continue;
      const cat = categoryOf(f);
      let m = counts.get(s.shelfId);
      if (!m) counts.set(s.shelfId, (m = new Map()));
      m.set(cat, (m.get(cat) ?? 0) + 1);
    }
    const out = new Map<string, string>();
    for (const [unit, m] of counts) {
      let best: [string, number] | null = null;
      for (const e of m) if (!best || e[1] > best[1]) best = e;
      if (best) out.set(unit, best[0]);
    }
    return out;
  }

  toRecord(): Record<string, string> {
    return Object.fromEntries(this.assignments);
  }

  update(dt: number): void {
    this.tweens.update(dt);
  }
}
