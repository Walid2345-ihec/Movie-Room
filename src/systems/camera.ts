/**
 * Two camera modes, toggled with Tab:
 *  - orbit: OrbitControls, target clamped inside the room.
 *  - walk : pointer-lock mouse look + WASD, eye height 1.6 m, simple AABB
 *           collision against walls and floor furniture (slide along walls).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { CameraMode } from '../types';

const EYE = 1.6;

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
}
const RADIUS = 0.25;
const _v = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

export class CameraSystem {
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  mode: CameraMode = 'orbit';
  private readonly keys = new Set<string>();
  private readonly pointer = new THREE.Vector2();
  private locked = false;
  private yaw = 0;
  private pitch = 0;
  private velocity = new THREE.Vector3();
  private savedOrbit: { pos: THREE.Vector3; target: THREE.Vector3 } | null = null;
  onModeChange: ((m: CameraMode) => void) | null = null;

  /** Default framing: standing at the entrance looking down the first aisle. */
  home = { pos: new THREE.Vector3(0, 1.6, 2.5), target: new THREE.Vector3(0, 1.3, -2) };

  constructor(
    private readonly dom: HTMLCanvasElement,
    private readonly colliders: () => THREE.Box3[],
    private readonly bounds: () => Bounds,
  ) {
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.05, 60);
    this.orbit = new OrbitControls(this.camera, dom);
    this.resetView();
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 0.3;
    this.orbit.maxDistance = 12;
    this.orbit.maxPolarAngle = Math.PI * 0.52;
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    this.orbit.update();

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('click', this.onClick);
    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  /** Default orbit framing (also used by the full reset). */
  resetView(): void {
    this.camera.position.copy(this.home.pos);
    this.orbit.target.copy(this.home.target);
    this.savedOrbit = null;
    this.velocity.set(0, 0, 0);
    this.orbit.update();
  }

  /** Pointer in NDC, or screen centre when the pointer is locked (walk mode). */
  pointerNdc(): THREE.Vector2 {
    return this.locked ? this.pointer.set(0, 0) : this.pointer;
  }

  /** Block orbit rotation while a case is being dragged. */
  setOrbitEnabled(v: boolean): void {
    this.orbit.enabled = v && this.mode === 'orbit';
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'walk') {
      this.savedOrbit = { pos: this.camera.position.clone(), target: this.orbit.target.clone() };
      this.orbit.enabled = false;
      // Drop to eye height, keep looking the same way.
      _euler.setFromQuaternion(this.camera.quaternion);
      this.yaw = _euler.y;
      this.pitch = _euler.x;
      this.camera.position.y = EYE;
      this.clampInside(this.camera.position);
      this.requestLock();
    } else {
      if (document.pointerLockElement === this.dom) document.exitPointerLock();
      this.orbit.enabled = true;
      if (this.savedOrbit) {
        this.camera.position.copy(this.savedOrbit.pos);
        this.orbit.target.copy(this.savedOrbit.target);
      } else {
        this.camera.getWorldDirection(_v);
        this.orbit.target.copy(this.camera.position).addScaledVector(_v, 2);
      }
      this.orbit.update();
    }
    this.onModeChange?.(mode);
  }

  toggle(): void {
    this.setMode(this.mode === 'orbit' ? 'walk' : 'orbit');
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    if (e.code === 'Tab') {
      e.preventDefault();
      this.toggle();
      return;
    }
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };
  private onPointerMove = (e: PointerEvent): void => {
    if (this.locked) {
      this.yaw -= e.movementX * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.4, 1.4);
    } else {
      const r = this.dom.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    }
  };
  private onClick = (): void => {
    // Re-acquire pointer lock if the user pressed Esc while walking.
    if (this.mode === 'walk' && !this.locked) this.requestLock();
  };
  /** Pointer lock can be refused (no user gesture, iframe policy); walking still works without it. */
  private requestLock(): void {
    try {
      const p = this.dom.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch?.(() => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
  }
  private onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.dom;
  };

  private clampInside(p: THREE.Vector3): void {
    const b = this.bounds();
    p.x = THREE.MathUtils.clamp(p.x, b.minX + RADIUS, b.maxX - RADIUS);
    p.z = THREE.MathUtils.clamp(p.z, b.minZ + RADIUS, b.maxZ - RADIUS);
  }

  /** AABB collision: move on X then Z separately so the player slides along obstacles. */
  private moveWithCollision(delta: THREE.Vector3): void {
    const p = this.camera.position;
    const boxes = this.colliders();
    const test = (): boolean => {
      for (const b of boxes) {
        if (p.x + RADIUS > b.min.x && p.x - RADIUS < b.max.x && p.z + RADIUS > b.min.z && p.z - RADIUS < b.max.z && b.max.y > 0.2) return true;
      }
      return false;
    };
    const ox = p.x;
    p.x += delta.x;
    if (test()) p.x = ox;
    const oz = p.z;
    p.z += delta.z;
    if (test()) p.z = oz;
    this.clampInside(p);
  }

  update(dt: number): void {
    if (this.mode === 'orbit') {
      // Keep the orbit target inside the room so the camera can't fly through walls.
      const b = this.bounds();
      const t = this.orbit.target;
      t.x = THREE.MathUtils.clamp(t.x, b.minX + 0.3, b.maxX - 0.3);
      t.z = THREE.MathUtils.clamp(t.z, b.minZ + 0.3, b.maxZ - 0.3);
      t.y = THREE.MathUtils.clamp(t.y, 0.2, b.height - 0.3);
      this.orbit.update();
      const p = this.camera.position;
      p.x = THREE.MathUtils.clamp(p.x, b.minX + 0.15, b.maxX - 0.15);
      p.z = THREE.MathUtils.clamp(p.z, b.minZ + 0.15, b.maxZ - 0.15);
      p.y = THREE.MathUtils.clamp(p.y, 0.25, b.height - 0.1);
      return;
    }
    // Walk mode
    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(fwd.z, 0, -fwd.x).negate();
    const wish = new THREE.Vector3();
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) wish.add(fwd);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) wish.sub(fwd);
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) wish.add(right);
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) wish.sub(right);
    const speed = this.keys.has('ShiftLeft') ? 3.4 : 1.9;
    if (wish.lengthSq() > 0) wish.normalize().multiplyScalar(speed);
    // Exponential smoothing for a little inertia.
    this.velocity.lerp(wish, 1 - Math.exp(-dt * 12));
    this.moveWithCollision(_v.copy(this.velocity).multiplyScalar(dt));
    this.camera.position.y = EYE;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('click', this.onClick);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    this.orbit.dispose();
  }
}
