/**
 * Room geometry, lighting, and modular shelving with slot generation.
 *
 * Coordinate system: metres, Y up. The room is ROOM_W wide (X) and ROOM_D deep
 * (Z), centred on the origin; the back wall is at z = -ROOM_D/2 and the front
 * (camera side) is open. Furniture snaps to a 1 m grid whose cell (gx, gz) has
 * its centre at (gx + 0.5, gz + 0.5).
 */
import * as THREE from 'three';
import type { RoomTheme, ShelfKind, ShelfPlacement } from '../types';
import { CASE_D, CASE_H, CASE_W, SLOT_PITCH, facingQuaternion, leanFor, shelvedQuaternion } from './case';

export const ROOM_W = 8;
export const ROOM_D = 8;
export const ROOM_H = 2.9;
export const GRID = 1;

/** A discrete case slot with its world-space transform. */
export interface Slot {
  /** Global id "shelfId:index". */
  id: string;
  shelfId: string;
  index: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Display state the slot wants: spine-out or poster-out. */
  facing: boolean;
  occupant: string | null;
}

/** Invisible collider for a row of slots; the picker maps hit points to slot indices. */
export interface RowCollider {
  mesh: THREE.Mesh;
  shelfId: string;
  firstIndex: number;
  count: number;
  /** Local-space x of the first slot centre and the pitch, for hit → index. */
  x0: number;
  pitch: number;
}

interface ShelfSpec {
  width: number;
  depth: number;
  height: number;
  rows: number[]; // y of each row's board top surface (local)
  facing: boolean;
  tilt: number;
  slotPitch: number;
}

const SPECS: Record<ShelfKind, ShelfSpec> = {
  bookcase: { width: 1.8, depth: 0.3, height: 2.1, rows: [0.06, 0.58, 1.1, 1.62], facing: false, tilt: 0, slotPitch: SLOT_PITCH },
  wall: { width: 1.2, depth: 0.24, height: 0.3, rows: [0.02], facing: false, tilt: 0, slotPitch: SLOT_PITCH },
  stand: { width: 1.1, depth: 0.32, height: 0.6, rows: [0.06, 0.36], facing: true, tilt: 0.22, slotPitch: CASE_W + 0.02 },
};

export class ShelfUnit {
  readonly group = new THREE.Group();
  readonly slots: Slot[] = [];
  readonly colliders: RowCollider[] = [];
  readonly placement: ShelfPlacement;
  private readonly wood: THREE.MeshStandardMaterial;

  constructor(placement: ShelfPlacement, wood: THREE.MeshStandardMaterial) {
    this.placement = placement;
    this.wood = wood;
    this.group.name = `shelf:${placement.id}`;
    this.build();
    this.applyPlacement();
    this.computeSlots();
  }

  get spec(): ShelfSpec {
    return SPECS[this.placement.kind];
  }

  private box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this.wood);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    this.group.add(m);
    return m;
  }

  /** Low-poly furniture built from boxes. Origin: floor centre of the unit's front edge plane. */
  private build(): void {
    const s = this.spec;
    const t = 0.025; // board thickness
    switch (this.placement.kind) {
      case 'bookcase': {
        this.box(t, s.height, s.depth, -s.width / 2 + t / 2, s.height / 2, 0);
        this.box(t, s.height, s.depth, s.width / 2 - t / 2, s.height / 2, 0);
        this.box(s.width, t, s.depth, 0, s.height - t / 2, 0);
        this.box(s.width, s.height, t, 0, s.height / 2, -s.depth / 2 + t / 2); // back panel
        for (const y of s.rows) this.box(s.width - 2 * t, t, s.depth - t, 0, y - t / 2, t / 2);
        break;
      }
      case 'wall': {
        this.box(s.width, t, s.depth, 0, s.rows[0]! - t / 2, 0);
        this.box(t, 0.12, s.depth * 0.8, -s.width / 2 + 0.06, s.rows[0]! - t - 0.06, 0);
        this.box(t, 0.12, s.depth * 0.8, s.width / 2 - 0.06, s.rows[0]! - t - 0.06, 0);
        this.box(s.width, 0.1, t, 0, s.rows[0]! + 0.05, -s.depth / 2 + t / 2); // lip behind
        break;
      }
      case 'stand': {
        this.box(s.width, t, s.depth, 0, t / 2, 0);
        for (const y of s.rows) {
          // tilted ledge: rotate a thin board back by `tilt`
          const ledge = this.box(s.width, t, 0.05, 0, y, 0.05);
          const back = this.box(s.width, CASE_H * 0.9, t, 0, y + CASE_H * 0.4, -0.05);
          back.rotation.x = -s.tilt;
          ledge.rotation.x = 0;
        }
        break;
      }
    }
    // One invisible collider per row; the picker raycasts these to find a slot.
    const rowLen = s.width - 0.08;
    for (let r = 0; r < s.rows.length; r++) {
      const geo = new THREE.BoxGeometry(rowLen, s.facing ? CASE_H : CASE_H + 0.02, s.facing ? 0.2 : s.depth);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false }));
      mesh.position.set(0, s.rows[r]! + CASE_H / 2, 0);
      mesh.name = 'rowCollider';
      this.group.add(mesh);
      this.colliders.push({ mesh, shelfId: this.placement.id, firstIndex: 0, count: 0, x0: 0, pitch: s.slotPitch });
    }
  }

  applyPlacement(): void {
    const p = this.placement;
    const s = this.spec;
    // Snap-grid cell centre; rotate so the unit's front faces away from the nearest wall.
    const cx = (p.gx + 0.5) * GRID;
    const cz = (p.gz + 0.5) * GRID;
    this.group.rotation.set(0, (p.rot * Math.PI) / 2, 0);
    // Push the unit back so its rear touches the cell's back edge.
    const back = new THREE.Vector3(0, 0, -(GRID / 2 - s.depth / 2)).applyEuler(this.group.rotation);
    this.group.position.set(cx + back.x, p.kind === 'wall' ? p.y : 0, cz + back.z);
    this.group.updateMatrixWorld(true);
  }

  /**
   * Slot-transform math.
   * For row r with board top at local y_r, slot i sits at:
   *   local x = -rowLen/2 + pitch/2 + i·pitch       (left → right along the board)
   *   local y = y_r + CASE_H/2                         (case resting on the board)
   *   local z = 0 (bookcase: slightly back so spines align with the front edge)
   * SHELVED slots use the spine-out quaternion with a per-film lean; FACING slots
   * (display stands) use the poster-out quaternion tilted back by `tilt`.
   * World transform = shelfMatrixWorld ∘ local.
   */
  private computeSlots(): void {
    const s = this.spec;
    const rowLen = s.width - 0.08;
    const perRow = Math.floor(rowLen / s.slotPitch);
    const rowStart = -rowLen / 2 + s.slotPitch / 2;
    this.slots.length = 0;
    const mw = this.group.matrixWorld;
    const worldQ = new THREE.Quaternion();
    this.group.getWorldQuaternion(worldQ);
    let index = 0;
    s.rows.forEach((y, r) => {
      const col = this.colliders[r]!;
      col.firstIndex = index;
      col.count = perRow;
      col.x0 = rowStart;
      for (let i = 0; i < perRow; i++, index++) {
        const local = new THREE.Vector3(rowStart + i * s.slotPitch, y + CASE_H / 2 + (s.facing ? 0.01 : 0), s.facing ? 0.0 : -0.02);
        const pos = local.applyMatrix4(mw);
        const q = s.facing ? facingQuaternion(s.tilt) : shelvedQuaternion(0);
        this.slots.push({
          id: `${this.placement.id}:${index}`,
          shelfId: this.placement.id,
          index,
          position: pos,
          quaternion: worldQ.clone().multiply(q),
          facing: s.facing,
          occupant: null,
        });
      }
    });
  }

  /** Final case quaternion for a slot, adding the per-film lean for shelved slots. */
  caseQuaternion(slot: Slot, filmId: string, out: THREE.Quaternion): THREE.Quaternion {
    if (slot.facing) return out.copy(slot.quaternion);
    const worldQ = new THREE.Quaternion();
    this.group.getWorldQuaternion(worldQ);
    return out.copy(worldQ).multiply(shelvedQuaternion(leanFor(filmId)));
  }

  dispose(): void {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        if (o.material !== this.wood && o.material instanceof THREE.Material) o.material.dispose();
      }
    });
    this.group.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// Room
// ---------------------------------------------------------------------------
export class Room {
  readonly group = new THREE.Group();
  readonly shelves = new Map<string, ShelfUnit>();
  readonly wood: THREE.MeshStandardMaterial;
  readonly wallMat: THREE.MeshStandardMaterial;
  readonly floorMat: THREE.MeshStandardMaterial;
  readonly lamp: THREE.PointLight;
  /** AABBs (world) used by the walk-mode collision. */
  readonly colliders: THREE.Box3[] = [];
  private readonly shelfGroup = new THREE.Group();

  constructor(theme: RoomTheme) {
    this.wood = new THREE.MeshStandardMaterial({ color: theme.wood, roughness: 0.7, metalness: 0.02 });
    this.wallMat = new THREE.MeshStandardMaterial({ color: theme.wall, roughness: 0.95 });
    this.floorMat = new THREE.MeshStandardMaterial({ color: theme.floor, roughness: 0.8 });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), this.floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.group.add(floor);

    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(ROOM_W, ROOM_D), new THREE.MeshStandardMaterial({ color: 0xf1ece4, roughness: 1 }));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = ROOM_H;
    this.group.add(ceiling);

    const wall = (w: number, x: number, z: number, ry: number): void => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, ROOM_H), this.wallMat);
      m.position.set(x, ROOM_H / 2, z);
      m.rotation.y = ry;
      m.receiveShadow = true;
      this.group.add(m);
      // Baseboard
      const bb = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, 0.02), this.wood);
      bb.position.set(x, 0.05, z);
      bb.rotation.y = ry;
      bb.translateZ(0.01);
      this.group.add(bb);
    };
    wall(ROOM_W, 0, -ROOM_D / 2, 0); // back
    wall(ROOM_D, -ROOM_W / 2, 0, Math.PI / 2); // left
    wall(ROOM_D, ROOM_W / 2, 0, -Math.PI / 2); // right

    // Window on the right wall: frame + soft emissive backdrop.
    const win = new THREE.Group();
    win.position.set(ROOM_W / 2 - 0.02, 1.6, 0.6);
    win.rotation.y = -Math.PI / 2;
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.3), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2d6, emissiveIntensity: 1.4, roughness: 1 }));
    win.add(glow);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xf6f3ee, roughness: 0.6 });
    for (const [w, h, x, y] of [
      [1.7, 0.06, 0, 0.67],
      [1.7, 0.06, 0, -0.67],
      [0.06, 1.4, -0.82, 0],
      [0.06, 1.4, 0.82, 0],
      [0.04, 1.3, 0, 0],
      [1.6, 0.04, 0, 0],
    ] as const) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.05), frameMat);
      f.position.set(x, y, 0.02);
      win.add(f);
    }
    this.group.add(win);

    // Lighting: soft key, warm ambient, one lamp.
    const hemi = new THREE.HemisphereLight(0xfff4e6, 0x6b5a4a, 0.55);
    this.group.add(hemi);
    const key = new THREE.DirectionalLight(0xfff1dc, 1.6);
    key.position.set(3.8, 2.5, 1.0); // from the window
    key.target.position.set(-1, 0.6, -1);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    const cam = key.shadow.camera;
    cam.left = -6;
    cam.right = 6;
    cam.top = 5;
    cam.bottom = -5;
    cam.near = 0.5;
    cam.far = 16;
    this.group.add(key, key.target);

    this.lamp = new THREE.PointLight(0xffb36b, 6, 7, 1.6);
    this.lamp.position.set(-3.0, 1.35, 2.6);
    this.lamp.castShadow = false;
    this.group.add(this.lamp);
    // Lamp body
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.6 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.04, 16), lampMat);
    base.position.set(-3.0, 0.02, 2.6);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 1.3, 8), lampMat);
    pole.position.set(-3.0, 0.67, 2.6);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.22, 0.3, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0xf3d9b4, emissive: 0xffa04a, emissiveIntensity: 0.5, side: THREE.DoubleSide, roughness: 1 }));
    shade.position.set(-3.0, 1.45, 2.6);
    this.group.add(base, pole, shade);

    // A rug for cosiness.
    const rug = new THREE.Mesh(new THREE.CircleGeometry(1.6, 40), new THREE.MeshStandardMaterial({ color: 0x8c3b3b, roughness: 1 }));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(0.3, 0.005, 1.0);
    rug.receiveShadow = true;
    this.group.add(rug);

    this.group.add(this.shelfGroup);
  }

  setTheme(theme: RoomTheme): void {
    this.wood.color.set(theme.wood);
    this.wallMat.color.set(theme.wall);
    this.floorMat.color.set(theme.floor);
  }

  /** Rebuild furniture from placements; returns all slots in a stable order. */
  setShelves(placements: ShelfPlacement[]): Slot[] {
    for (const s of this.shelves.values()) s.dispose();
    this.shelves.clear();
    this.colliders.length = 0;
    for (const p of placements) {
      const unit = new ShelfUnit(p, this.wood);
      this.shelfGroup.add(unit.group);
      this.shelves.set(p.id, unit);
      if (p.kind !== 'wall') this.colliders.push(new THREE.Box3().setFromObject(unit.group));
    }
    // Room walls as thin AABBs for walk-mode collision.
    const t = 0.3;
    this.colliders.push(
      new THREE.Box3(new THREE.Vector3(-ROOM_W / 2 - t, 0, -ROOM_D / 2 - t), new THREE.Vector3(ROOM_W / 2 + t, ROOM_H, -ROOM_D / 2)),
      new THREE.Box3(new THREE.Vector3(-ROOM_W / 2 - t, 0, -ROOM_D / 2), new THREE.Vector3(-ROOM_W / 2, ROOM_H, ROOM_D / 2 + t)),
      new THREE.Box3(new THREE.Vector3(ROOM_W / 2, 0, -ROOM_D / 2), new THREE.Vector3(ROOM_W / 2 + t, ROOM_H, ROOM_D / 2 + t)),
      new THREE.Box3(new THREE.Vector3(-ROOM_W / 2 - t, 0, ROOM_D / 2), new THREE.Vector3(ROOM_W / 2 + t, ROOM_H, ROOM_D / 2 + t)),
    );
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

  dispose(): void {
    for (const s of this.shelves.values()) s.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        if (o.material instanceof THREE.Material) o.material.dispose();
      }
    });
  }
}

export { CASE_D, CASE_H, CASE_W };
