/**
 * Picking: raycaster-driven hover, click-to-inspect and drag-to-reshelve.
 *
 * Hover   → the case glows and swings out to its FACING pose.
 * Click   → the case tweens to an inspect pose in front of the camera.
 * Drag    → the case follows the pointer; the nearest free slot under the
 *           pointer shows a translucent ghost; release snaps (or swaps).
 * Esc / right-click cancels a drag or inspect and returns the case home.
 */
import * as THREE from 'three';
import type { CaseBatch } from '../scene/case';
import { CASE_D, CASE_H, CASE_W, facingQuaternion } from '../scene/case';
import type { Room, RowCollider, Slot } from '../scene/room';
import type { LayoutSystem } from './layout';
import { store } from '../state/store';

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _local = new THREE.Vector3();
const _curQ = new THREE.Quaternion();
const _right = new THREE.Vector3();

export interface PickingHooks {
  /** Returns the pointer position in NDC; walk mode returns the screen centre. */
  pointerNdc: () => THREE.Vector2;
  onInspect: (filmId: string | null) => void;
}

export class PickingSystem {
  private readonly ray = new THREE.Raycaster();
  private hovered: string | null = null;
  private inspecting: string | null = null;
  private dragging: string | null = null;
  private dragTarget: Slot | null = null;
  private pressPos: THREE.Vector2 | null = null;
  private pressId: string | null = null;
  private dragDistance = 0.6;
  private readonly ghost: THREE.Mesh;
  private readonly ghostMat: THREE.MeshBasicMaterial;
  private colliders: RowCollider[] = [];
  private inspectSettled = false;
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
    this.ray.params.Line = { threshold: 0 };
    this.refreshColliders();

    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('contextmenu', this.onContext);
    window.addEventListener('keydown', this.onKey);
  }

  setBatch(batch: CaseBatch): void {
    this.batch = batch;
    this.hovered = this.inspecting = this.dragging = null;
    this.ghost.visible = false;
  }

  refreshColliders(): void {
    this.colliders = this.room.rowColliders();
  }

  get isDragging(): boolean {
    return this.dragging !== null;
  }
  get inspectId(): string | null {
    return this.inspecting;
  }

  // ---- Pointer helpers ------------------------------------------------------
  private castCases(): string | null {
    if (this.batch.mesh.count === 0) return null;
    this.ray.setFromCamera(this.hooks.pointerNdc(), this.camera);
    const hits = this.ray.intersectObject(this.batch.mesh, false);
    const hit = hits.find((h) => h.instanceId !== undefined && this.batch.getDim(h.instanceId) < 0.5);
    if (!hit || hit.instanceId === undefined) return null;
    return this.batch.films[hit.instanceId]?.id ?? null;
  }

  /**
   * Raycast-to-slot snapping: intersect the invisible per-row colliders, bring
   * the hit point into the collider's local frame, and quantise local X to the
   * row's slot pitch: index = round((x - x0) / pitch). That gives an exact slot
   * without a collider per slot, even for 100-slot rows.
   */
  private castSlot(): Slot | null {
    this.ray.setFromCamera(this.hooks.pointerNdc(), this.camera);
    const meshes = this.colliders.map((c) => c.mesh);
    const hits = this.ray.intersectObjects(meshes, false);
    const hit = hits[0];
    if (!hit) return null;
    const col = this.colliders.find((c) => c.mesh === hit.object);
    if (!col) return null;
    col.mesh.worldToLocal(_local.copy(hit.point));
    const idx = THREE.MathUtils.clamp(Math.round((_local.x - col.x0) / col.pitch), 0, col.count - 1);
    const unit = this.room.shelves.get(col.shelfId);
    return unit?.slots[col.firstIndex + idx] ?? null;
  }

  private onMove = (e: PointerEvent): void => {
    if (!this.enabled) return;
    if (this.pressPos && this.pressId && !this.dragging) {
      if (Math.hypot(e.clientX - this.pressPos.x, e.clientY - this.pressPos.y) > 6) this.beginDrag(this.pressId);
    }
    if (this.dragging) {
      this.updateDrag();
      return;
    }
    if (this.inspecting) return;
    const id = this.castCases();
    if (id !== this.hovered) {
      if (this.hovered) this.unhover(this.hovered);
      this.hovered = id;
      if (id) this.hover(id);
      store.set({ hoverId: id });
      this.dom.style.cursor = id ? 'grab' : '';
    }
  };

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled || e.button !== 0) return;
    if (this.inspecting) {
      // Click anywhere while inspecting → put the case back.
      this.endInspect();
      return;
    }
    const id = this.castCases();
    if (!id) return;
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
    if (pressId && this.enabled) this.beginInspect(pressId);
  };

  private onContext = (e: MouseEvent): void => {
    e.preventDefault();
    if (this.dragging) this.endDrag(false);
    else if (this.inspecting) this.endInspect();
  };

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      if (this.dragging) this.endDrag(false);
      else if (this.inspecting) this.endInspect();
    }
  };

  // ---- Hover ------------------------------------------------------------------
  private hover(id: string): void {
    const i = this.batch.indexOf.get(id);
    const slot = this.layout.slotOf(id);
    if (i === undefined || !slot) return;
    this.batch.setFx(i, this.batch.getDim(i), 1);
    if (slot.facing) return; // already showing the poster
    // Swing out: forward along the slot's facing direction, up a little, poster toward the camera.
    const unit = this.room.shelves.get(slot.shelfId);
    _q.identity();
    if (unit) unit.group.getWorldQuaternion(_q);
    _dir.set(0, 0, 1).applyQuaternion(_q); // shelf +Z = out of the shelf
    _p.copy(slot.position).addScaledVector(_dir, CASE_W * 0.55).add(new THREE.Vector3(0, 0.02, 0));
    _q.multiply(facingQuaternion(0.08));
    this.layout.tweenTo(id, _p.clone(), _q.clone(), 0.28);
  }

  private unhover(id: string): void {
    const i = this.batch.indexOf.get(id);
    if (i === undefined) return;
    this.batch.setFx(i, this.batch.getDim(i), 0);
    const slot = this.layout.slotOf(id);
    if (slot) this.layout.moveToSlot(id, slot, 0.3, 0);
    this.dom.style.cursor = '';
  }

  // ---- Inspect ---------------------------------------------------------------
  private inspectPose(outP: THREE.Vector3, outQ: THREE.Quaternion): void {
    this.camera.getWorldDirection(_dir);
    // 60 cm ahead, nudged left so the detail panel (right side) doesn't cover it.
    _right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    outP.copy(this.camera.position).addScaledVector(_dir, 0.6).addScaledVector(_right, -0.09);
    outQ.copy(this.camera.quaternion);
  }

  beginInspect(id: string): void {
    if (this.hovered && this.hovered !== id) this.unhover(this.hovered);
    this.hovered = null;
    this.inspecting = id;
    this.inspectSettled = false;
    const i = this.batch.indexOf.get(id);
    if (i !== undefined) this.batch.setFx(i, 0, 0);
    this.inspectPose(_p, _q);
    this.layout.tweenTo(id, _p.clone(), _q.clone(), 0.55, 0, () => {
      this.inspectSettled = true;
    });
    this.dom.style.cursor = '';
    store.set({ inspectId: id, phase: 'inspect', hoverId: null });
    this.hooks.onInspect(id);
  }

  endInspect(): void {
    const id = this.inspecting;
    if (!id) return;
    this.inspecting = null;
    this.inspectSettled = false;
    const i = this.batch.indexOf.get(id);
    if (i !== undefined) this.batch.setFx(i, this.batch.getDim(i), 0);
    const slot = this.layout.slotOf(id);
    if (slot) this.layout.moveToSlot(id, slot, 0.5, 0);
    store.set({ inspectId: null, phase: 'room' });
    this.hooks.onInspect(null);
  }

  // ---- Drag ------------------------------------------------------------------
  private beginDrag(id: string): void {
    if (this.hovered === id) {
      const i = this.batch.indexOf.get(id);
      if (i !== undefined) this.batch.setFx(i, 0, 0.6);
    }
    this.hovered = null;
    this.dragging = id;
    this.layout.tweens.cancel(`case:${id}`);
    const slot = this.layout.slotOf(id);
    this.dragDistance = slot ? Math.min(1.2, Math.max(0.35, this.camera.position.distanceTo(slot.position) * 0.85)) : 0.6;
    this.dom.style.cursor = 'grabbing';
    this.updateDrag();
  }

  private updateDrag(): void {
    const id = this.dragging;
    if (!id) return;
    const i = this.batch.indexOf.get(id);
    if (i === undefined) return;
    // Case rides on the pointer ray at a fixed distance, poster toward the camera.
    this.ray.setFromCamera(this.hooks.pointerNdc(), this.camera);
    _p.copy(this.ray.ray.origin).addScaledVector(this.ray.ray.direction, this.dragDistance);
    _q.copy(this.camera.quaternion);
    this.batch.setMatrix(i, _m.compose(_p, _q, _s.set(1, 1, 1)));

    // Ghost preview in the nearest slot under the pointer.
    const slot = this.castSlot();
    this.dragTarget = slot;
    if (slot) {
      const tq = new THREE.Quaternion();
      this.layout.slotTransform(slot, id, _p, tq);
      this.ghost.position.copy(_p);
      this.ghost.quaternion.copy(tq);
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
    const i = this.batch.indexOf.get(id);
    if (i !== undefined) this.batch.setFx(i, this.batch.getDim(i), 0);
    const target = this.dragTarget;
    this.dragTarget = null;
    const origin = this.layout.slotOf(id);
    if (commit && target && target.id !== origin?.id) {
      if (target.occupant && target.occupant !== id) this.layout.swap(id, target);
      else this.layout.place(id, target);
      store.setAssignments(this.layout.toRecord());
    } else if (origin) this.layout.moveToSlot(id, origin, 0.45, 0);
    else this.layout.fillGaps([this.batch.films[i ?? 0]!], store.get().layout.sortMode);
  }

  /** Per-frame: keep the inspected case glued in front of a moving camera. */
  update(): void {
    if (this.inspecting && this.inspectSettled) {
      const i = this.batch.indexOf.get(this.inspecting);
      if (i === undefined) return;
      this.inspectPose(_p, _q);
      this.batch.getMatrix(i, _m).decompose(_local, _curQ, _s);
      const curQ = _curQ;
      _local.lerp(_p, 0.25);
      curQ.slerp(_q, 0.25);
      this.batch.setMatrix(i, _m.compose(_local, curQ, _s.set(1, 1, 1)));
    }
  }

  dispose(): void {
    this.dom.removeEventListener('pointermove', this.onMove);
    this.dom.removeEventListener('pointerdown', this.onDown);
    this.dom.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('contextmenu', this.onContext);
    window.removeEventListener('keydown', this.onKey);
    this.ghost.geometry.dispose();
    this.ghostMat.dispose();
  }
}
