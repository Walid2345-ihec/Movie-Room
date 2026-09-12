/**
 * Picking: raycaster-driven hover, click-to-select and drag-to-rearrange.
 *
 * Hover   → soft glow, case eases 8 mm out of the row.
 * Click   → SELECT: the case lifts toward the viewer with an outline and the
 *           detail panel opens. Click empty space / Esc deselects.
 * Drag    → the case follows the pointer; the nearest slot under the pointer
 *           shows a translucent ghost; the row's neighbours slide apart to
 *           preview the insertion; release snaps (free slot) or swaps
 *           (occupied slot). Moved cases become pinned.
 * Esc / right-click cancels a drag and returns the case to its origin slot.
 *
 * All hit-testing uses the batch's hit proxy (exact case geometry at REST
 * poses) plus the store furniture, nearest-first — so a lifted or hovered
 * case never shadows its neighbours and hover === click, always.
 */
import * as THREE from 'three';
import type { CaseBatch } from '../scene/case';
import { CASE_D, CASE_H, CASE_W, makeCaseGeometry } from '../scene/case';
import type { Room, RowCollider, Slot } from '../scene/room';
import type { LayoutSystem } from './layout';
import { store } from '../state/store';

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3(1, 1, 1);
const _fwd = new THREE.Vector3();
const _local = new THREE.Vector3();
const _restP = new THREE.Vector3();
const _restQ = new THREE.Quaternion();

export interface PickingHooks {
  /** Returns the pointer position in NDC; walk mode returns the screen centre. */
  pointerNdc: () => THREE.Vector2;
  onSelect: (filmId: string | null) => void;
  /** Called after a drop that changed assignments (persist + redraw tickets). */
  onRearranged: () => void;
}

const NUDGE = 0.004;

export class PickingSystem {
  private readonly ray = new THREE.Raycaster();
  private hovered: string | null = null;
  private selected: string | null = null;
  private dragging: string | null = null;
  private dragTarget: Slot | null = null;
  private pressPos: THREE.Vector2 | null = null;
  private pressId: string | null = null;
  private dragDistance = 0.6;
  private readonly ghost: THREE.Mesh;
  private readonly ghostMat: THREE.MeshBasicMaterial;
  private readonly outline: THREE.Mesh;
  private colliders: RowCollider[] = [];
  private occluders: THREE.Object3D[] = [];
  enabled = true;

  constructor(
    private readonly dom: HTMLElement,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly room: Room,
    private batch: CaseBatch,
    private readonly layout: LayoutSystem,
    private readonly hooks: PickingHooks,
  ) {
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x7ee0ff, transparent: true, opacity: 0.45, depthWrite: false });
    this.ghost = new THREE.Mesh(new THREE.BoxGeometry(CASE_W * 1.02, CASE_H * 1.02, CASE_D * 1.5), this.ghostMat);
    this.ghost.visible = false;
    this.ghost.name = 'ghost';
    room.group.add(this.ghost);
    // Selection outline: the case geometry drawn back-face, slightly inflated, in the accent colour.
    this.outline = new THREE.Mesh(makeCaseGeometry(), new THREE.MeshBasicMaterial({ color: 0xffd166, side: THREE.BackSide, transparent: true, opacity: 0.85, depthWrite: false }));
    this.outline.scale.setScalar(1.06);
    this.outline.visible = false;
    this.outline.name = 'ghost';
    room.group.add(this.outline);
    // Meshes use exact triangle tests; zero the Line/Points thresholds so nothing inflates a hit.
    this.ray.params.Line = { threshold: 0 };
    this.ray.params.Points = { threshold: 0 };
    this.refreshColliders();

    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('contextmenu', this.onContext);
    window.addEventListener('keydown', this.onKey);
  }

  setBatch(batch: CaseBatch): void {
    this.batch = batch;
    this.hovered = this.selected = this.dragging = null;
    this.ghost.visible = false;
    this.outline.visible = false;
  }

  refreshColliders(): void {
    this.colliders = this.room.rowColliders();
    this.occluders = this.room.occluders();
  }

  get isDragging(): boolean {
    return this.dragging !== null;
  }
  get selectedId(): string | null {
    return this.selected;
  }

  // ---- Raycasts ----------------------------------------------------------------
  private castCases(): string | null {
    if (this.batch.films.length === 0) return null;
    this.ray.setFromCamera(this.hooks.pointerNdc(), this.camera);
    const hits = this.ray.intersectObjects([this.batch.hitProxy, ...this.occluders], false);
    for (const h of hits) {
      if (h.object !== this.batch.hitProxy) return null; // furniture in front
      if (h.instanceId === undefined) continue;
      if (this.batch.getDim(h.instanceId) >= 0.5) continue; // dimmed by search: not pickable
      return this.batch.films[h.instanceId]?.id ?? null;
    }
    return null;
  }

  /**
   * Raycast-to-slot snapping: hit the invisible bay-row colliders, bring the
   * point into the collider's local frame, quantise local X to the slot pitch.
   */
  private castSlot(): Slot | null {
    this.ray.setFromCamera(this.hooks.pointerNdc(), this.camera);
    const hits = this.ray.intersectObjects(
      this.colliders.map((c) => c.mesh),
      false,
    );
    const hit = hits[0];
    if (!hit) return null;
    const col = this.colliders.find((c) => c.mesh === hit.object);
    if (!col) return null;
    col.mesh.worldToLocal(_local.copy(hit.point));
    const idx = THREE.MathUtils.clamp(Math.round((_local.x - col.x0) / col.pitch), 0, col.count - 1);
    const unit = this.room.shelves.get(col.shelfId);
    return unit?.slots[col.firstIndex + idx] ?? null;
  }

  // ---- Pointer events ------------------------------------------------------------
  private onMove = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (this.pressPos && this.pressId && !this.dragging) {
      if (Math.hypot(e.clientX - this.pressPos.x, e.clientY - this.pressPos.y) > 6) this.beginDrag(this.pressId);
    }
    if (this.dragging) {
      this.updateDrag();
      return;
    }
    const id = this.castCases();
    if (id !== this.hovered) {
      if (this.hovered && this.hovered !== this.selected) this.unhover(this.hovered);
      this.hovered = id;
      if (id && id !== this.selected) this.hover(id);
      store.set({ hoverId: id });
      this.dom.style.cursor = id ? 'grab' : '';
    }
  };

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled || e.button !== 0) return;
    const id = this.castCases();
    if (!id) {
      if (this.selected) this.deselect();
      return;
    }
    this.pressPos = new THREE.Vector2(e.clientX, e.clientY);
    this.pressId = id;
  };

  private onUp = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const pressId = this.pressId;
    this.pressPos = null;
    this.pressId = null;
    if (this.dragging) {
      this.endDrag(true);
      return;
    }
    if (pressId && this.enabled) {
      if (pressId === this.selected) this.deselect();
      else this.select(pressId);
    }
  };

  private onContext = (e: MouseEvent): void => {
    e.preventDefault();
    if (this.dragging) this.endDrag(false);
    else if (this.selected) this.deselect();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.dragging) this.endDrag(false);
      else if (this.selected) this.deselect();
    }
  };

  // ---- Hover ---------------------------------------------------------------------
  private hover(id: string): void {
    const i = this.batch.indexOf.get(id);
    const slot = this.layout.slotOf(id);
    if (i === undefined || !slot) return;
    this.batch.setFx(i, this.batch.getDim(i), 0.5);
    this.layout.slotTransform(slot, id, _p, _q);
    _fwd.set(0, 0, 1).applyQuaternion(slot.quaternion);
    _p.addScaledVector(_fwd, 0.008);
    this.layout.tweenTo(id, _p.clone(), _q.clone(), 0.15);
  }

  private unhover(id: string): void {
    const i = this.batch.indexOf.get(id);
    if (i === undefined) return;
    this.batch.setFx(i, this.batch.getDim(i), 0);
    const slot = this.layout.slotOf(id);
    if (slot) this.layout.moveToSlot(id, slot, 0.2, 0);
    this.dom.style.cursor = '';
  }

  // ---- Select ---------------------------------------------------------------------
  select(id: string): void {
    if (this.selected && this.selected !== id) this.deselect(false);
    this.selected = id;
    const i = this.batch.indexOf.get(id);
    const slot = this.layout.slotOf(id);
    if (i === undefined) return;
    this.batch.setFx(i, 0, 0.35);
    if (slot) {
      // Lift 60 mm toward the aisle and 20 mm up, straightening the lean a touch.
      this.layout.slotTransform(slot, id, _p, _q);
      _fwd.set(0, 0, 1).applyQuaternion(slot.quaternion);
      _p.addScaledVector(_fwd, 0.06).add(new THREE.Vector3(0, 0.02, 0));
      this.layout.tweenTo(id, _p.clone(), _q.clone(), 0.25);
    }
    this.outline.visible = true;
    store.set({ inspectId: id, phase: 'inspect', hoverId: null });
    this.hooks.onSelect(id);
  }

  deselect(notify = true): void {
    const id = this.selected;
    if (!id) return;
    this.selected = null;
    this.outline.visible = false;
    const i = this.batch.indexOf.get(id);
    if (i !== undefined) this.batch.setFx(i, this.batch.getDim(i), 0);
    const slot = this.layout.slotOf(id);
    if (slot) this.layout.moveToSlot(id, slot, 0.3, 0);
    if (notify) {
      store.set({ inspectId: null, phase: 'room' });
      this.hooks.onSelect(null);
    }
  }

  /** Backwards-compatible name used by the detail panel close button. */
  endInspect(): void {
    this.deselect();
  }
  get inspectId(): string | null {
    return this.selected;
  }

  // ---- Drag -----------------------------------------------------------------------
  private beginDrag(id: string): void {
    if (this.selected !== id) this.select(id);
    this.hovered = null;
    this.dragging = id;
    this.outline.visible = false;
    this.layout.tweens.cancel(`case:${id}`);
    const slot = this.layout.slotOf(id);
    this.dragDistance = slot ? Math.min(1.0, Math.max(0.35, this.camera.position.distanceTo(slot.position) * 0.8)) : 0.6;
    this.dom.style.cursor = 'grabbing';
    this.updateDrag();
  }

  private setRowNudges(target: Slot | null, dragged: string): void {
    // Only a free target slot previews an insertion; a swap target just shows the orange ghost.
    const nextRow = target && (!target.occupant || target.occupant === dragged) ? target.rowKey : null;
    const changed = new Set<string>();
    for (const id of this.layout.nudge.keys()) changed.add(id);
    this.layout.nudge.clear();
    if (target && nextRow) {
      for (const { film, slot } of this.layout.rowMates(target, dragged)) {
        this.layout.nudge.set(film, slot.col < target.col ? -NUDGE : NUDGE);
        changed.add(film);
      }
    }
    this.layout.reseat(changed, new Set([dragged]), 0.12);
  }

  private updateDrag(): void {
    const id = this.dragging;
    if (!id) return;
    const i = this.batch.indexOf.get(id);
    if (i === undefined) return;
    // The case rides on the pointer ray at a fixed distance, facing the camera.
    this.ray.setFromCamera(this.hooks.pointerNdc(), this.camera);
    _p.copy(this.ray.ray.origin).addScaledVector(this.ray.ray.direction, this.dragDistance);
    _q.copy(this.camera.quaternion);
    this.batch.setMatrix(i, _m.compose(_p, _q, _s.set(1, 1, 1)));

    const slot = this.castSlot();
    if (slot !== this.dragTarget) {
      this.dragTarget = slot;
      this.setRowNudges(slot, id);
    }
    if (slot) {
      this.layout.slotTransform(slot, id, _restP, _restQ);
      this.ghost.position.copy(_restP);
      this.ghost.quaternion.copy(_restQ);
      this.ghost.visible = true;
      const occupied = slot.occupant !== null && slot.occupant !== id;
      this.ghostMat.color.set(occupied ? 0xffb347 : 0x7ee0ff); // orange = swap, blue = free
    } else this.ghost.visible = false;
  }

  private endDrag(commit: boolean): void {
    const id = this.dragging;
    if (!id) return;
    this.dragging = null;
    this.ghost.visible = false;
    this.dom.style.cursor = '';
    const target = this.dragTarget;
    this.dragTarget = null;
    this.setRowNudges(null, id);
    const i = this.batch.indexOf.get(id);
    if (i !== undefined) this.batch.setFx(i, this.batch.getDim(i), 0);
    const origin = this.layout.slotOf(id);
    let changed = false;
    if (commit && target && target.id !== origin?.id) {
      if (target.occupant && target.occupant !== id) this.layout.swap(id, target);
      else this.layout.place(id, target);
      changed = true;
    } else if (origin) this.layout.moveToSlot(id, origin, 0.35, 0);
    else this.layout.fillGaps([this.batch.films[i ?? 0]!], store.get().layout.sortMode);
    this.selected = null;
    store.set({ inspectId: null, phase: 'room' });
    this.hooks.onSelect(null);
    if (changed) this.hooks.onRearranged();
  }

  /** Per-frame: keep the outline glued to the selected case. */
  update(): void {
    if (this.selected && !this.dragging) {
      const i = this.batch.indexOf.get(this.selected);
      if (i === undefined) return;
      this.batch.getMatrix(i, _m).decompose(this.outline.position, this.outline.quaternion, _s);
      this.outline.scale.setScalar(1.06);
      this.outline.visible = true;
    } else this.outline.visible = false;
  }

  dispose(): void {
    this.dom.removeEventListener('pointermove', this.onMove);
    this.dom.removeEventListener('pointerdown', this.onDown);
    this.dom.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('contextmenu', this.onContext);
    window.removeEventListener('keydown', this.onKey);
    this.ghost.geometry.dispose();
    this.ghostMat.dispose();
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
  }
}
