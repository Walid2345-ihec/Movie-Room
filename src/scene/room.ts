/**
 * The store: a procedurally planned media shop with double-sided gondola runs,
 * perimeter wall runs and end-caps, all shelving face-front.
 *
 * Coordinate system: metres, Y up, origin at the room centre. The back wall is
 * at z = -depth/2, the entrance/checkout area at +z.
 *
 * Every shelving unit is built from real retail dimensions (1 m bays, 2 m
 * uprights, 160 mm shelves) and the slot grid is derived from the real DVD
 * case size, so a bay holds 7 cases per row and 8 rows.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RoomTheme, ShelfPlacement, StorePlan } from '../types';
import { CASE_H, CASE_W, facingQuaternion } from './case';
import { hashString } from '../data/tmdb';

// ---------------------------------------------------------------------------
// Retail dimensions (metres)
// ---------------------------------------------------------------------------
export const BAY_W = 1.0; // one shelving bay, upright to upright
export const UNIT_H = 2.0; // upright height
export const UPRIGHT_T = 0.025; // slotted standard thickness
export const SHELF_T = 0.02; // shelf steel thickness
export const SHELF_DEPTH = 0.16; // shallow: one case deep
export const SPINE_T = 0.05; // gondola centre panel
export const LIP_H = 0.03; // front riser the cases lean on
export const STRIP_H = 0.028; // blue shelf-edge strip
export const CASE_GAP = 0.004; // shoulder-to-shoulder gap
export const SLOT_PITCH = CASE_W + CASE_GAP; // 0.139
export const LEAN = THREE.MathUtils.degToRad(10); // cases lean back against the riser
export const ROW_CLEARANCE = 0.015; // air above each case
export const FIRST_SHELF_Y = 0.12; // top surface of the lowest shelf
export const ROW_PITCH = CASE_H * Math.cos(LEAN) + ROW_CLEARANCE + SHELF_T; // ≈ 0.222
export const AISLE_W = 1.1;
export const GONDOLA_D = SPINE_T + 2 * (SHELF_DEPTH + 0.025); // ≈ 0.42
export const WALL_UNIT_D = SHELF_DEPTH + 0.04;
export const FRONT_AREA = 2.4; // checkout / entrance zone at +z
export const BACK_AISLE = 1.2;

/** Cases per row in one bay: (bay − upright) / pitch → 7 at real scale. */
export const SLOTS_PER_ROW = Math.floor((BAY_W - UPRIGHT_T) / SLOT_PITCH);
/** Rows per unit: first shelf at 0.12 m, then one row per ROW_PITCH while a case still fits under the top. */
export const ROWS_PER_UNIT = Math.floor((UNIT_H - FIRST_SHELF_Y - CASE_H * Math.cos(LEAN)) / ROW_PITCH) + 1;
export const SLOTS_PER_BAY = SLOTS_PER_ROW * ROWS_PER_UNIT;

// ---------------------------------------------------------------------------
// Store planning
// ---------------------------------------------------------------------------
function unitCapacity(u: ShelfPlacement): number {
  return (u.kind === 'gondola' ? 2 : 1) * u.bays * SLOTS_PER_BAY;
}

/**
 * Pick the smallest store (gondola count × gondola length) whose shelving holds
 * the collection plus ~15 % empty slots, then lay the units out:
 * back wall run, two side wall runs, N gondolas with an end-cap each.
 */
export function planStore(filmCount: number): StorePlan {
  const target = Math.max(SLOTS_PER_BAY * 4, Math.ceil(filmCount * 1.15));
  let best: StorePlan | null = null;
  for (let g = 1; g <= 6; g++) {
    for (let b = 2; b <= 6; b++) {
      const plan = buildPlan(g, b);
      const cap = plan.units.reduce((s, u) => s + unitCapacity(u), 0);
      if (cap >= target && (!best || cap < best.units.reduce((s, u) => s + unitCapacity(u), 0))) best = plan;
    }
  }
  return best ?? buildPlan(6, 6);
}

function buildPlan(gondolas: number, bays: number): StorePlan {
  const width = 2 * WALL_UNIT_D + AISLE_W * (gondolas + 1) + GONDOLA_D * gondolas;
  const depth = WALL_UNIT_D + BACK_AISLE + bays * BAY_W + FRONT_AREA;
  const units: ShelfPlacement[] = [];
  const backBays = Math.floor((width - 2 * WALL_UNIT_D - 0.1) / BAY_W);
  units.push({ id: 'wall-back', kind: 'wall', x: 0, z: -depth / 2 + WALL_UNIT_D / 2, rot: 0, bays: backBays });
  const sideLen = depth - FRONT_AREA - WALL_UNIT_D - 0.3;
  const sideBays = Math.floor(sideLen / BAY_W);
  const sideZ = -depth / 2 + WALL_UNIT_D + 0.15 + sideLen / 2;
  units.push({ id: 'wall-left', kind: 'wall', x: -width / 2 + WALL_UNIT_D / 2, z: sideZ, rot: Math.PI / 2, bays: sideBays });
  units.push({ id: 'wall-right', kind: 'wall', x: width / 2 - WALL_UNIT_D / 2, z: sideZ, rot: -Math.PI / 2, bays: sideBays });
  const gz = -depth / 2 + WALL_UNIT_D + BACK_AISLE + (bays * BAY_W) / 2;
  for (let i = 0; i < gondolas; i++) {
    const x = -width / 2 + WALL_UNIT_D + AISLE_W + GONDOLA_D / 2 + i * (GONDOLA_D + AISLE_W);
    units.push({ id: `gondola-${i}`, kind: 'gondola', x, z: gz, rot: Math.PI / 2, bays });
    units.push({ id: `endcap-${i}`, kind: 'endcap', x, z: gz + (bays * BAY_W) / 2 + WALL_UNIT_D / 2 + 0.01, rot: 0, bays: 1 });
  }
  return { width, depth, height: 3.2, units };
}

// ---------------------------------------------------------------------------
// Slots and colliders
// ---------------------------------------------------------------------------
export interface Slot {
  /** Global id "unitId:index". */
  id: string;
  shelfId: string;
  index: number;
  /** Row key "unitId:side:bay:row" — cases in a row shuffle together during drag preview. */
  rowKey: string;
  col: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Lateral (row-wise) unit vector in world space, for nudges and jitter. */
  lateral: THREE.Vector3;
  facing: true;
  occupant: string | null;
}

/** Invisible collider for one bay-row; the picker maps a hit point to a slot index. */
export interface RowCollider {
  mesh: THREE.Mesh;
  shelfId: string;
  rowKey: string;
  firstIndex: number;
  count: number;
  /** First slot centre in the collider's local X, and the slot pitch. */
  x0: number;
  pitch: number;
}

interface RowStrip {
  side: number;
  bay: number;
  row: number;
  slotIds: string[];
}

// ---------------------------------------------------------------------------
// Canvas textures for dressing
// ---------------------------------------------------------------------------
function canvasTexture(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const FONT = 'system-ui, "Segoe UI", Helvetica, Arial, sans-serif';

/** Black category header ("ACTION", "HORROR" …). */
function headerTexture(text: string): THREE.CanvasTexture {
  return canvasTexture(1024, 200, (ctx) => {
    ctx.fillStyle = '#121214';
    ctx.fillRect(0, 0, 1024, 200);
    ctx.fillStyle = '#f5f5f5';
    ctx.font = `800 96px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let size = 96;
    while (ctx.measureText(text).width > 940 && size > 40) ctx.font = `800 ${(size -= 6)}px ${FONT}`;
    ctx.fillText(text, 512, 100);
    ctx.fillStyle = '#e6007e';
    ctx.fillRect(0, 186, 1024, 14);
  });
}

/** Magenta "new" sign from the reference. */
function newSignTexture(): THREE.CanvasTexture {
  return canvasTexture(768, 300, (ctx) => {
    ctx.fillStyle = '#e4007c';
    ctx.fillRect(0, 0, 768, 300);
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 190px ${FONT}`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('new', 40, 200);
    ctx.font = `600 44px ${FONT}`;
    ctx.fillText('and trending', 48, 262);
  });
}

// ---------------------------------------------------------------------------
// ShelfUnit
// ---------------------------------------------------------------------------
export class ShelfUnit {
  readonly group = new THREE.Group();
  readonly slots: Slot[] = [];
  readonly colliders: RowCollider[] = [];
  readonly placement: ShelfPlacement;
  readonly sides: number;
  readonly length: number;
  private readonly rows: RowStrip[] = [];
  private readonly stripCanvas: HTMLCanvasElement[] = [];
  private readonly stripTexture: THREE.CanvasTexture[] = [];
  private readonly headers: THREE.Mesh[] = [];
  private readonly disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];
  private readonly steel: THREE.MeshStandardMaterial;

  constructor(placement: ShelfPlacement, steel: THREE.MeshStandardMaterial) {
    this.placement = placement;
    this.steel = steel;
    this.sides = placement.kind === 'gondola' ? 2 : 1;
    this.length = placement.bays * BAY_W;
    this.group.name = `unit:${placement.id}`;
    this.group.position.set(placement.x, 0, placement.z);
    this.group.rotation.y = placement.rot;
    this.group.updateMatrixWorld(true);
    this.build();
  }

  /** AABB for walk-mode collision. */
  aabb(): THREE.Box3 {
    const d = this.sides === 2 ? GONDOLA_D : WALL_UNIT_D;
    const box = new THREE.Box3(new THREE.Vector3(-this.length / 2, 0, -d / 2), new THREE.Vector3(this.length / 2, UNIT_H, d / 2));
    return box.applyMatrix4(this.group.matrixWorld);
  }

  private build(): void {
    const L = this.length;
    const p = this.placement;
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a2a2d, roughness: 0.85 });
    this.disposables.push(dark);

    // Back / centre panel
    const panelT = this.sides === 2 ? SPINE_T : 0.02;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(L + 0.02, UNIT_H, panelT), dark);
    panel.position.set(0, UNIT_H / 2, this.sides === 2 ? 0 : -WALL_UNIT_D / 2 + panelT / 2 + 0.005);
    panel.receiveShadow = true;
    this.group.add(panel);
    this.disposables.push(panel.geometry);

    for (let side = 0; side < this.sides; side++) {
      // Side frame: local +Z faces the aisle. Gondola back side is the front frame rotated 180°.
      const frame = new THREE.Group();
      frame.rotation.y = side === 0 ? 0 : Math.PI;
      const zBack = this.sides === 2 ? panelT / 2 : -WALL_UNIT_D / 2 + panelT + 0.01;
      const zFront = zBack + SHELF_DEPTH;
      this.group.add(frame);
      frame.updateMatrixWorld(true);

      // ---- merged steel: uprights, shelves, lips ----
      const parts: THREE.BufferGeometry[] = [];
      for (let b = 0; b <= p.bays; b++) {
        const g = new THREE.BoxGeometry(UPRIGHT_T, UNIT_H, SHELF_DEPTH + 0.01);
        g.translate(-L / 2 + b * BAY_W, UNIT_H / 2, zBack + SHELF_DEPTH / 2);
        parts.push(g);
      }
      for (let r = 0; r < ROWS_PER_UNIT; r++) {
        const top = FIRST_SHELF_Y + r * ROW_PITCH;
        const shelf = new THREE.BoxGeometry(L, SHELF_T, SHELF_DEPTH);
        shelf.translate(0, top - SHELF_T / 2, zBack + SHELF_DEPTH / 2);
        parts.push(shelf);
        const lip = new THREE.BoxGeometry(L, LIP_H, 0.006);
        lip.translate(0, top + LIP_H / 2 - 0.004, zFront - 0.003);
        parts.push(lip);
      }
      const merged = mergeGeometries(parts, false);
      for (const g of parts) g.dispose();
      const steelMesh = new THREE.Mesh(merged, this.steel);
      steelMesh.castShadow = true;
      steelMesh.receiveShadow = true;
      frame.add(steelMesh);
      this.disposables.push(merged);

      // ---- shelf-edge strip atlas: one canvas per side, one plane per bay-row ----
      const stripW = 512;
      const stripH = 32;
      const canvas = document.createElement('canvas');
      canvas.width = stripW * p.bays;
      canvas.height = stripH * ROWS_PER_UNIT;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      this.stripCanvas[side] = canvas;
      this.stripTexture[side] = tex;
      const stripMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4 });
      this.disposables.push(stripMat, tex);
      const stripParts: THREE.BufferGeometry[] = [];

      const inner = BAY_W - UPRIGHT_T;
      const rowStart = -inner / 2 + (inner - SLOTS_PER_ROW * SLOT_PITCH) / 2 + SLOT_PITCH / 2;

      for (let b = 0; b < p.bays; b++) {
        const bayCx = -L / 2 + b * BAY_W + BAY_W / 2;
        for (let r = ROWS_PER_UNIT - 1; r >= 0; r--) {
          // top row first, so fill order reads top-left → bottom-right per bay
          const top = FIRST_SHELF_Y + r * ROW_PITCH;
          const rowIndex = ROWS_PER_UNIT - 1 - r; // 0 = top row (ticket canvas rows run top→bottom)
          // strip plane with UVs into this side's canvas
          const sp = new THREE.PlaneGeometry(inner, STRIP_H);
          const uv = sp.attributes.uv as THREE.BufferAttribute;
          for (let i = 0; i < uv.count; i++) {
            uv.setXY(i, (b + uv.getX(i)) / p.bays, 1 - (rowIndex + 1 - uv.getY(i)) / ROWS_PER_UNIT);
          }
          sp.translate(bayCx, top - SHELF_T / 2 + 0.002, zFront + 0.002);
          stripParts.push(sp);

          // slots — top row first so fill order reads like a shelf label
          const rowKey = `${p.id}:${side}:${b}:${rowIndex}`;
          const strip: RowStrip = { side, bay: b, row: rowIndex, slotIds: [] };
          this.rows.push(strip);
          const firstIndex = this.slots.length;
          for (let c = 0; c < SLOTS_PER_ROW; c++) {
            const x = bayCx + rowStart + c * SLOT_PITCH;
            // Slot-transform math: the case's bottom edge rests 40 mm behind the
            // front lip and the case leans back by LEAN, so its centre is
            //   y = shelfTop + (H/2)·cos(LEAN),  z = zBottom − (H/2)·sin(LEAN)
            const local = new THREE.Vector3(x, top + (CASE_H / 2) * Math.cos(LEAN), zFront - 0.04 - (CASE_H / 2) * Math.sin(LEAN));
            const pos = local.applyMatrix4(frame.matrixWorld);
            const q = new THREE.Quaternion();
            frame.getWorldQuaternion(q);
            const lateral = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
            q.multiply(facingQuaternion(LEAN));
            const index = this.slots.length;
            const id = `${p.id}:${index}`;
            strip.slotIds.push(id);
            this.slots.push({ id, shelfId: p.id, index, rowKey, col: c, position: pos, quaternion: q, lateral, facing: true, occupant: null });
          }
          // row collider (zero padding in X beyond the slot run; sized to the case)
          const cg = new THREE.BoxGeometry(SLOTS_PER_ROW * SLOT_PITCH, CASE_H, CASE_D_COLLIDER);
          const cm = new THREE.Mesh(cg, INVISIBLE);
          cm.position.set(bayCx, top + (CASE_H / 2) * Math.cos(LEAN), zFront - 0.04 - (CASE_H / 2) * Math.sin(LEAN));
          cm.rotation.x = -LEAN;
          cm.name = 'rowCollider';
          frame.add(cm);
          this.disposables.push(cg);
          // x0 is in the collider's own frame (collider is centred on the bay)
          this.colliders.push({ mesh: cm, shelfId: p.id, rowKey, firstIndex, count: SLOTS_PER_ROW, x0: rowStart, pitch: SLOT_PITCH });
        }
      }
      const stripGeo = mergeGeometries(stripParts, false);
      for (const g of stripParts) g.dispose();
      frame.add(new THREE.Mesh(stripGeo, stripMat));
      this.disposables.push(stripGeo);
      frame.updateMatrixWorld(true);
    }

    // Category header panels on gondola ends (both ends) and above end-caps.
    if (p.kind === 'gondola') {
      for (const end of [1, -1]) {
        const tex = headerTexture('FILMS');
        const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 });
        const m = new THREE.Mesh(new THREE.PlaneGeometry(GONDOLA_D + 0.2, (GONDOLA_D + 0.2) / 5.12), mat);
        m.position.set((end * L) / 2 + end * 0.012, UNIT_H + 0.1, 0);
        m.rotation.y = end === 1 ? Math.PI / 2 : -Math.PI / 2;
        this.group.add(m);
        this.headers.push(m);
        this.disposables.push(tex, mat, m.geometry);
      }
    }
    this.drawTickets(() => null);
  }

  /** Redraw every shelf-edge strip: blue plastic with a white ticket per occupied slot. */
  drawTickets(labelFor: (slotId: string) => string | null): void {
    for (let side = 0; side < this.sides; side++) {
      const canvas = this.stripCanvas[side]!;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#1d5fc9';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#4a86e0';
      for (let r = 0; r < ROWS_PER_UNIT; r++) ctx.fillRect(0, r * 32, canvas.width, 3);
      ctx.font = `700 13px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const inner = BAY_W - UPRIGHT_T;
      const pxPerM = 512 / inner;
      const rowStart = (inner - SLOTS_PER_ROW * SLOT_PITCH) / 2 + SLOT_PITCH / 2;
      for (const row of this.rows) {
        if (row.side !== side) continue;
        const y0 = row.row * 32;
        row.slotIds.forEach((id, c) => {
          const label = labelFor(id);
          if (!label) return;
          const cx = row.bay * 512 + (rowStart + c * SLOT_PITCH) * pxPerM;
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(cx - 22, y0 + 6, 44, 20);
          ctx.fillStyle = '#111';
          ctx.fillText(label, cx, y0 + 16);
        });
      }
      this.stripTexture[side]!.needsUpdate = true;
    }
  }

  setHeader(text: string): void {
    for (const h of this.headers) {
      const mat = h.material as THREE.MeshStandardMaterial;
      mat.map?.dispose();
      mat.map = headerTexture(text);
      mat.needsUpdate = true;
    }
  }

  /**
   * Final case pose for a slot: the slot's leaning, face-front quaternion plus
   * a deterministic per-film jitter (±1° lean, ±2 mm lateral) so rows look
   * stocked by hand rather than instanced.
   */
  casePose(slot: Slot, filmId: string, outP: THREE.Vector3, outQ: THREE.Quaternion): void {
    const h = hashString(filmId + slot.id);
    const jLean = (((h & 0xff) / 255) * 2 - 1) * THREE.MathUtils.degToRad(1);
    const jLat = ((((h >> 8) & 0xff) / 255) * 2 - 1) * 0.002;
    outP.copy(slot.position).addScaledVector(slot.lateral, jLat);
    outQ.copy(slot.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -jLean));
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    for (const h of this.headers) (h.material as THREE.MeshStandardMaterial).map?.dispose();
    this.group.removeFromParent();
  }
}

const CASE_D_COLLIDER = 0.03;
const INVISIBLE = new THREE.MeshBasicMaterial({ visible: false });

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------
export class Room {
  readonly group = new THREE.Group();
  readonly shelves = new Map<string, ShelfUnit>();
  readonly steel: THREE.MeshStandardMaterial;
  readonly wallMat: THREE.MeshLambertMaterial;
  readonly floorMat: THREE.MeshStandardMaterial;
  /** AABBs (world) used by the walk-mode collision. */
  readonly colliders: THREE.Box3[] = [];
  plan: StorePlan = { width: 6, depth: 8, height: 3.2, units: [] };
  private readonly staticGroup = new THREE.Group();
  private readonly shelfGroup = new THREE.Group();
  private readonly staticDisposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(theme: RoomTheme) {
    this.steel = new THREE.MeshStandardMaterial({ color: theme.wood, roughness: 0.55, metalness: 0.35 });
    // Big screen-filling surfaces use the cheapest shading that still reads right (integrated-GPU budget).
    this.wallMat = new THREE.MeshLambertMaterial({ color: theme.wall });
    this.floorMat = new THREE.MeshStandardMaterial({ color: theme.floor, roughness: 0.32, metalness: 0.06, envMapIntensity: 0.8 });
    this.group.add(this.staticGroup, this.shelfGroup);
  }

  get bounds(): { minX: number; maxX: number; minZ: number; maxZ: number; height: number } {
    return { minX: -this.plan.width / 2, maxX: this.plan.width / 2, minZ: -this.plan.depth / 2, maxZ: this.plan.depth / 2, height: this.plan.height };
  }

  setTheme(theme: RoomTheme): void {
    this.steel.color.set(theme.wood);
    this.wallMat.color.set(theme.wall);
    this.floorMat.color.set(theme.floor);
  }

  /** Rebuild the whole store from a plan. Returns all slots in fill order. */
  build(plan: StorePlan): Slot[] {
    this.plan = plan;
    this.buildEnvelope();
    for (const s of this.shelves.values()) s.dispose();
    this.shelves.clear();
    this.colliders.length = 0;
    for (const p of plan.units) {
      const unit = new ShelfUnit(p, this.steel);
      this.shelfGroup.add(unit.group);
      this.shelves.set(p.id, unit);
      this.colliders.push(unit.aabb());
    }
    this.colliders.push(...this.propColliders);
    return this.allSlots();
  }

  allSlots(): Slot[] {
    const out: Slot[] = [];
    for (const s of this.shelves.values()) out.push(...s.slots);
    return out;
  }

  rowColliders(): RowCollider[] {
    const out: RowCollider[] = [];
    for (const s of this.shelves.values()) out.push(...s.colliders);
    return out;
  }

  /** Meshes that can occlude a case for picking (everything in the store except row colliders). */
  occluders(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh && o.name !== 'rowCollider' && o.name !== 'ghost') out.push(o);
    });
    return out;
  }

  // ---- Envelope: floor, walls, ceiling grid, lights, signage, props ----------
  private propColliders: THREE.Box3[] = [];

  private add(mesh: THREE.Mesh, shadow = true): THREE.Mesh {
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    this.staticGroup.add(mesh);
    this.staticDisposables.push(mesh.geometry);
    return mesh;
  }

  private buildEnvelope(): void {
    for (const d of this.staticDisposables) d.dispose();
    this.staticDisposables.length = 0;
    this.staticGroup.clear();
    this.propColliders = [];
    const { width: W, depth: D, height: H } = this.plan;

    // Floor: large-format pale tile with grout, glossy sheen from the env map.
    const tile = canvasTexture(256, 256, (ctx) => {
      ctx.fillStyle = '#dedad2';
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = '#cfcac1';
      ctx.fillRect(0, 0, 256, 5);
      ctx.fillRect(0, 0, 5, 256);
      for (let i = 0; i < 400; i++) {
        ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.03})`;
        ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
      }
    });
    tile.wrapS = tile.wrapT = THREE.RepeatWrapping;
    tile.repeat.set(W / 0.6, D / 0.6);
    this.floorMat.map = tile;
    this.floorMat.needsUpdate = true;
    this.staticDisposables.push(tile);
    const floor = this.add(new THREE.Mesh(new THREE.PlaneGeometry(W, D), this.floorMat), false);
    floor.rotation.x = -Math.PI / 2;

    // Walls
    const wall = (w: number, x: number, z: number, ry: number): void => {
      const m = this.add(new THREE.Mesh(new THREE.PlaneGeometry(w, H), this.wallMat), false);
      m.position.set(x, H / 2, z);
      m.rotation.y = ry;
    };
    wall(W, 0, -D / 2, 0);
    wall(D, -W / 2, 0, Math.PI / 2);
    wall(D, W / 2, 0, -Math.PI / 2);
    wall(W, 0, D / 2, Math.PI); // entrance wall (behind the camera start)

    // Soffit band above the wall shelving
    const soffitMat = new THREE.MeshLambertMaterial({ color: 0x2b2b2e });
    this.staticDisposables.push(soffitMat);
    const soffitH = H - UNIT_H - 0.55;
    const soffitY = H - soffitH / 2;
    const s1 = this.add(new THREE.Mesh(new THREE.BoxGeometry(W, soffitH, 0.35), soffitMat), false);
    s1.position.set(0, soffitY, -D / 2 + 0.175);
    for (const sx of [-1, 1]) {
      const s = this.add(new THREE.Mesh(new THREE.BoxGeometry(0.35, soffitH, D), soffitMat), false);
      s.position.set((sx * (W - 0.35)) / 2, soffitY, 0);
    }

    // Ceiling: white drop-ceiling grid + recessed light panels
    const grid = canvasTexture(256, 256, (ctx) => {
      ctx.fillStyle = '#f4f4f2';
      ctx.fillRect(0, 0, 256, 256);
      ctx.fillStyle = '#c9c9c6';
      ctx.fillRect(0, 0, 256, 4);
      ctx.fillRect(0, 0, 4, 256);
    });
    grid.wrapS = grid.wrapT = THREE.RepeatWrapping;
    grid.repeat.set(W / 0.6, D / 0.6);
    const ceilMat = new THREE.MeshLambertMaterial({ map: grid });
    this.staticDisposables.push(grid, ceilMat);
    const ceil = this.add(new THREE.Mesh(new THREE.PlaneGeometry(W, D), ceilMat), false);
    ceil.rotation.x = Math.PI / 2;
    ceil.position.y = H;
    const panelMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xf4f7ff, emissiveIntensity: 2.2 });
    this.staticDisposables.push(panelMat);
    const panelGeos: THREE.BufferGeometry[] = [];
    for (let x = -W / 2 + 0.9; x < W / 2 - 0.5; x += 1.2) {
      for (let z = -D / 2 + 0.9; z < D / 2 - 0.5; z += 1.2) {
        const g = new THREE.PlaneGeometry(0.58, 0.58);
        g.rotateX(Math.PI / 2);
        g.translate(x, H - 0.01, z);
        panelGeos.push(g);
      }
    }
    const panels = mergeGeometries(panelGeos, false);
    for (const g of panelGeos) g.dispose();
    this.add(new THREE.Mesh(panels, panelMat), false);

    // "new" signs above the back wall run
    const signTex = newSignTexture();
    const signMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.6, emissive: 0x330019, emissiveIntensity: 0.4 });
    this.staticDisposables.push(signTex, signMat);
    const signCount = Math.max(2, Math.floor((W - 1) / 1.15));
    const signStart = -((signCount - 1) * 1.15) / 2;
    for (let i = 0; i < signCount; i++) {
      const m = this.add(new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.37), signMat), false);
      m.position.set(signStart + i * 1.15, UNIT_H + 0.32, -D / 2 + 0.36);
    }

    // ---- Props: checkout counter, register, spinner racks, promo display, floor mat ----
    const counterMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3e, roughness: 0.7 });
    const counterTop = new THREE.MeshStandardMaterial({ color: 0xdcd8cf, roughness: 0.5 });
    const blackPlastic = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.5 });
    const screenMat = new THREE.MeshStandardMaterial({ color: 0x0b1a2b, emissive: 0x2a5fa8, emissiveIntensity: 0.9, roughness: 0.3 });
    this.staticDisposables.push(counterMat, counterTop, blackPlastic, screenMat);
    const cx = W / 2 - 1.3;
    const cz = D / 2 - 1.0;
    const counter = this.add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.95, 0.6), counterMat));
    counter.position.set(cx, 0.475, cz);
    const top = this.add(new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.04, 0.7), counterTop));
    top.position.set(cx, 0.97, cz);
    const register = this.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.35), blackPlastic));
    register.position.set(cx - 0.3, 1.05, cz);
    const screen = this.add(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.24, 0.02), screenMat), false);
    screen.position.set(cx - 0.3, 1.25, cz - 0.1);
    screen.rotation.x = -0.25;
    this.propColliders.push(new THREE.Box3(new THREE.Vector3(cx - 0.85, 0, cz - 0.35), new THREE.Vector3(cx + 0.85, 1, cz + 0.35)));

    const rackAt = (x: number, z: number): void => {
      const pole = this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.6, 8), blackPlastic));
      pole.position.set(x, 0.8, z);
      const base = this.add(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 0.03, 20), blackPlastic));
      base.position.set(x, 0.015, z);
      for (let i = 0; i < 4; i++) {
        const ring = this.add(new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.006, 6, 28), blackPlastic));
        ring.rotation.x = Math.PI / 2;
        ring.position.set(x, 0.45 + i * 0.32, z);
      }
      this.propColliders.push(new THREE.Box3(new THREE.Vector3(x - 0.3, 0, z - 0.3), new THREE.Vector3(x + 0.3, 1.6, z + 0.3)));
    };
    rackAt(-W / 2 + 0.45, D / 2 - 0.5);
    if (W > 5) rackAt(-W / 2 + 1.2, D / 2 - 0.5);

    const promoTex = canvasTexture(256, 640, (ctx) => {
      ctx.fillStyle = '#e4007c';
      ctx.fillRect(0, 0, 256, 640);
      ctx.fillStyle = '#fff';
      ctx.font = `800 96px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText('3', 128, 200);
      ctx.font = `800 64px ${FONT}`;
      ctx.fillText('for 2', 128, 280);
      ctx.font = `600 34px ${FONT}`;
      ctx.fillText('ON ALL DVD', 128, 380);
      ctx.fillText('& BLU-RAY', 128, 424);
      ctx.fillStyle = '#ffd400';
      ctx.fillRect(28, 470, 200, 8);
    });
    const promoMat = new THREE.MeshStandardMaterial({ map: promoTex, roughness: 0.8 });
    const cardboard = new THREE.MeshStandardMaterial({ color: 0xb8a37e, roughness: 1 });
    this.staticDisposables.push(promoTex, promoMat, cardboard);
    const promo = this.add(new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.5, 0.4), [cardboard, cardboard, cardboard, cardboard, promoMat, cardboard]));
    const px = cx - 1.35;
    const pz = D / 2 - 0.55;
    promo.position.set(px, 0.75, pz);
    promo.rotation.y = -0.35;
    this.propColliders.push(new THREE.Box3(new THREE.Vector3(px - 0.4, 0, pz - 0.3), new THREE.Vector3(px + 0.4, 1.5, pz + 0.3)));

    const matMat = new THREE.MeshStandardMaterial({ color: 0x262626, roughness: 1 });
    this.staticDisposables.push(matMat);
    const mat = this.add(new THREE.Mesh(new THREE.PlaneGeometry(1.4, 0.9), matMat), false);
    mat.rotation.x = -Math.PI / 2;
    mat.position.set(Math.min(cx - 2.4, -0.6), 0.004, D / 2 - 0.55);

    // Lighting: even, slightly cool retail light + a faint warm bounce from the floor.
    const hemi = new THREE.HemisphereLight(0xe8eeff, 0xd8c9b0, 0.7);
    this.staticGroup.add(hemi);
    const key = new THREE.DirectionalLight(0xf2f5ff, 0.5);
    key.position.set(0.8, H, 0.5);
    key.target.position.set(0, 0, -1);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    const sc = key.shadow.camera;
    sc.left = -W / 2 - 1;
    sc.right = W / 2 + 1;
    sc.top = D / 2 + 1;
    sc.bottom = -D / 2 - 1;
    sc.near = 0.1;
    sc.far = H + 6;
    this.staticGroup.add(key, key.target);
    // A few point lights down the aisles for the "panel" feel (kept low for perf).
    const aisleXs: number[] = [];
    for (const u of this.plan.units) if (u.kind === 'gondola') aisleXs.push(u.x - (GONDOLA_D + AISLE_W) / 2, u.x + (GONDOLA_D + AISLE_W) / 2);
    const uniq = [...new Set(aisleXs.map((x) => Math.round(x * 100) / 100))].slice(0, 4);
    for (const x of uniq) {
      for (const z of [-D / 4, D / 4]) {
        const pl = new THREE.PointLight(0xffffff, 5, 7, 1.8);
        pl.position.set(x, H - 0.2, z);
        this.staticGroup.add(pl);
      }
    }
  }

  dispose(): void {
    for (const s of this.shelves.values()) s.dispose();
    for (const d of this.staticDisposables) d.dispose();
    this.staticGroup.clear();
  }
}
