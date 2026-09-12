/**
 * Layout system: sort strategies, slot assignment and tween scheduling.
 *
 * The LayoutSystem owns the mapping filmId → Slot and knows how to move every
 * case (instance) to its slot with a staggered, eased tween. Picking/drag code
 * mutates assignments through `place()` / `swap()` so the store stays in sync.
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
const _pushQ = new THREE.Quaternion();
const _pushDir = new THREE.Vector3();

export type SortStrategy = (a: Film, b: Film) => number;

const byTitle: SortStrategy = (a, b) => a.title.localeCompare(b.title);
const numDesc = (x: number | null, y: number | null): number => (y ?? -1) - (x ?? -1);
const numAsc = (x: number | null, y: number | null): number => (x ?? Infinity) - (y ?? Infinity);
const str = (x: string | null | undefined, y: string | null | undefined): number => (x ?? '~').localeCompare(y ?? '~');

export const SORTS: Record<SortMode, SortStrategy> = {
  title: byTitle,
  rating: (a, b) => numDesc(a.rating, b.rating) || byTitle(a, b),
  year: (a, b) => numAsc(a.year, b.year) || byTitle(a, b),
  director: (a, b) => str(a.director?.split(' ').pop(), b.director?.split(' ').pop()) || str(a.director, b.director) || numAsc(a.year, b.year),
  genre: (a, b) => str(a.genres[0], b.genres[0]) || numDesc(a.rating, b.rating),
  runtime: (a, b) => numAsc(a.runtime, b.runtime) || byTitle(a, b),
  /** Rainbow shelf: sort by the poster's dominant hue (0..360). */
  hue: (a, b) => numAsc(a.hue, b.hue) || byTitle(a, b),
};

export const SORT_LABELS: Record<SortMode, string> = {
  rating: 'Rating',
  year: 'Year',
  director: 'Director',
  genre: 'Genre',
  runtime: 'Runtime',
  hue: 'Rainbow',
  title: 'Title',
};

export class LayoutSystem {
  readonly tweens = new TweenManager();
  /** Ordered slot list: display stands first (they show the top of the sort), then shelves top row → bottom. */
  slots: Slot[] = [];
  readonly slotById = new Map<string, Slot>();
  /** filmId → slotId */
  readonly assignments = new Map<string, string>();
  /** Films matching the current search; they sit a little proud of the shelf. */
  readonly pushed = new Set<string>();

  constructor(
    private readonly room: Room,
    private batch: CaseBatch,
  ) {}

  setBatch(batch: CaseBatch): void {
    this.batch = batch;
    this.assignments.clear();
  }

  /** Refresh slot list from the room (after shelves change). Existing assignments to vanished slots are dropped. */
  refreshSlots(): void {
    const all = this.room.allSlots();
    const rank = (s: Slot): number => (s.facing ? 0 : 1);
    // Stable sort: stands first; within a shelf, higher rows first so the eye
    // reads top-left → bottom-right like a real bookcase.
    this.slots = all
      .map((s, i) => ({ s, i }))
      .sort((a, b) => rank(a.s) - rank(b.s) || a.s.shelfId.localeCompare(b.s.shelfId) || b.s.position.y - a.s.position.y || a.i - b.i)
      .map((x) => x.s);
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

  /** Compute a full assignment for a sort mode. Overflow films (no slot) are left unassigned. */
  arrange(films: Film[], mode: SortMode): Map<string, string> {
    const sorted = [...films].sort(SORTS[mode]);
    const out = new Map<string, string>();
    sorted.forEach((f, i) => {
      const slot = this.slots[i];
      if (slot) out.set(f.id, slot.id);
    });
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
      this.moveToSlot(film.id, slot, animate ? 0.7 : 0, animate ? (k++ % 60) * 0.012 : 0);
    }
  }

  /** Fill any unassigned films into free slots (used after import / when slots grow). */
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

  /** Cases without a slot are parked in a pile on the floor near the door. */
  private park(filmId: string): void {
    const i = this.batch.indexOf.get(filmId);
    if (i === undefined) return;
    const n = i % 40;
    _pos.set(2.2 + (n % 8) * 0.22, 0.011 + Math.floor(n / 8) * 0.022, 3.0 + Math.floor(i / 40) * 0.3);
    _quat.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, (i % 7) * 0.05));
    this.batch.setMatrix(i, _m.compose(_pos, _quat, _scale));
  }

  slotOf(filmId: string): Slot | undefined {
    const id = this.assignments.get(filmId);
    return id ? this.slotById.get(id) : undefined;
  }

  /** Move a case into `slot` (unassigning it from wherever it was). */
  place(filmId: string, slot: Slot, duration = 0.35): void {
    const prev = this.slotOf(filmId);
    if (prev) prev.occupant = null;
    slot.occupant = filmId;
    this.assignments.set(filmId, slot.id);
    this.moveToSlot(filmId, slot, duration, 0);
  }

  /** Drop `filmId` onto an occupied slot: the occupant takes the dragged case's origin slot. */
  swap(filmId: string, target: Slot): void {
    const other = target.occupant;
    const origin = this.slotOf(filmId);
    if (other && other !== filmId && origin) {
      origin.occupant = other;
      this.assignments.set(other, origin.id);
      this.moveToSlot(other, origin, 0.4, 0);
      target.occupant = filmId;
      this.assignments.set(filmId, target.id);
      this.moveToSlot(filmId, target, 0.35, 0);
    } else this.place(filmId, target);
  }

  /** World transform a case should have when resting in a slot. */
  slotTransform(slot: Slot, filmId: string, outP: THREE.Vector3, outQ: THREE.Quaternion): void {
    outP.copy(slot.position);
    const unit = this.room.shelves.get(slot.shelfId);
    if (unit) unit.caseQuaternion(slot, filmId, outQ);
    else outQ.copy(slot.quaternion);
    if (this.pushed.has(filmId) && unit) {
      // Search matches are pushed 3 cm out of the shelf along the unit's facing axis.
      unit.group.getWorldQuaternion(_pushQ);
      outP.addScaledVector(_pushDir.set(0, 0, 1).applyQuaternion(_pushQ), 0.03);
    }
  }

  /** Re-seat every case that is resting in its slot (after search push/unpush). */
  reseat(ids: Iterable<string>, exclude: Set<string>): void {
    for (const id of ids) {
      if (exclude.has(id)) continue;
      const slot = this.slotOf(id);
      if (slot) this.moveToSlot(id, slot, 0.3, 0);
    }
  }

  /** Tween instance `filmId` from its current matrix to the slot pose. */
  moveToSlot(filmId: string, slot: Slot, duration: number, delay: number): void {
    const i = this.batch.indexOf.get(filmId);
    if (i === undefined) return;
    const toP = new THREE.Vector3();
    const toQ = new THREE.Quaternion();
    this.slotTransform(slot, filmId, toP, toQ);
    this.tweenTo(filmId, toP, toQ, duration, delay);
  }

  /** Generic pose tween for one instance (also used by picking for inspect/return). */
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
    // Lift along an arc so cases don't slide through their neighbours.
    const lift = Math.min(0.25, fromP.distanceTo(toP) * 0.35);
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

  /** Snapshot for persistence. */
  toRecord(): Record<string, string> {
    return Object.fromEntries(this.assignments);
  }

  update(dt: number): void {
    this.tweens.update(dt);
  }
}
