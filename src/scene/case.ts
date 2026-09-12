/**
 * CaseMesh: every film case in the room is ONE InstancedMesh with a 3-material
 * box (front = poster atlas, spine = spine atlas, everything else = flat tint).
 *
 *  - All fronts share a single 4096² poster atlas that acts as an LRU cache:
 *    only cases the picking/frustum system asks for are resident. A case whose
 *    poster isn't resident renders its tint colour instead.
 *  - All spines are drawn once into a canvas atlas at import time (title + year
 *    rotated 90°), uploaded once.
 *  - Per-instance attributes carry the atlas rects, tint and fx (dim/glow), so
 *    the whole collection is 3 draw calls regardless of size.
 */
import * as THREE from 'three';
import type { Film } from '../types';
import { hashString, resolveCover, type CoverSource } from '../data/tmdb';

// Standard Blu-ray case: 135 × 172 × 14 mm, scaled ×1.5 so spines stay legible
// in a room-sized scene (1 unit = 1 m). The ratio is untouched.
export const CASE_SCALE = 1.5;
export const CASE_W = 0.135 * CASE_SCALE;
export const CASE_H = 0.172 * CASE_SCALE;
export const CASE_D = 0.014 * CASE_SCALE;
/** Distance between spines on a shelf (case depth + a hair of air). */
export const SLOT_PITCH = CASE_D + 0.004;

// ---------------------------------------------------------------------------
// Display-state orientations (local to the shelf slot frame)
// ---------------------------------------------------------------------------
/**
 * SHELVED: the case stands upright with its spine (-X face) rotated to +Z so it
 * faces out of the shelf. A small lean around the shelf's depth axis (Z) makes
 * rows look hand-placed. Quaternion = lean(Z) ∘ rotY(+90°).
 */
export function shelvedQuaternion(lean: number, target = new THREE.Quaternion()): THREE.Quaternion {
  const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  const qLean = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), lean);
  return target.copy(qLean).multiply(qY);
}
/** FACING: poster (+Z face) toward the viewer, optionally tilted back (stands). */
export function facingQuaternion(tiltBack = 0, target = new THREE.Quaternion()): THREE.Quaternion {
  return target.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -tiltBack);
}
/** Deterministic lean in ±3° derived from the film id. */
export function leanFor(id: string): number {
  return ((hashString(id) % 1000) / 1000 - 0.5) * 0.1;
}

// ---------------------------------------------------------------------------
// Geometry: a BoxGeometry re-grouped so faces map to 3 materials.
// BoxGeometry index layout (1 segment per side): px, nx, py, ny, pz, nz — 6 indices each.
// ---------------------------------------------------------------------------
function makeCaseGeometry(): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(CASE_W, CASE_H, CASE_D);
  g.clearGroups();
  g.addGroup(0, 6, 0); // +X edge (opening side)
  g.addGroup(6, 6, 2); // -X spine
  g.addGroup(12, 12, 0); // top + bottom
  g.addGroup(24, 6, 1); // +Z front (poster)
  g.addGroup(30, 6, 0); // -Z back
  return g;
}

// ---------------------------------------------------------------------------
// Spine atlas
// ---------------------------------------------------------------------------
const SPINE_TILE_W = 24;
const SPINE_TILE_H = 288;
const SPINE_ATLAS_W = 2048;
const SPINE_COLS = Math.floor(SPINE_ATLAS_W / SPINE_TILE_W); // 85
const SPINE_MAX_ROWS = 14; // 14 × 288 = 4032 ≤ 4096

export class SpineAtlas {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly rows: number;

  constructor(films: Film[]) {
    this.rows = Math.max(1, Math.min(SPINE_MAX_ROWS, Math.ceil(films.length / SPINE_COLS)));
    this.canvas = document.createElement('canvas');
    this.canvas.width = SPINE_ATLAS_W;
    this.canvas.height = this.rows * SPINE_TILE_H;
    const ctx = this.canvas.getContext('2d')!;
    films.forEach((f, i) => this.drawSpine(ctx, f, i));
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  /** UV rect (u, v, w, h) of film index i. The canvas is uploaded with flipY, so v counts from the bottom. */
  rect(i: number, out: THREE.Vector4): THREE.Vector4 {
    const idx = i % (SPINE_COLS * this.rows);
    const col = idx % SPINE_COLS;
    const row = Math.floor(idx / SPINE_COLS);
    const H = this.canvas.height;
    return out.set((col * SPINE_TILE_W) / SPINE_ATLAS_W, 1 - ((row + 1) * SPINE_TILE_H) / H, SPINE_TILE_W / SPINE_ATLAS_W, SPINE_TILE_H / H);
  }

  /**
   * Spine texture generation: a 24×288 tile. The tile is drawn upright but the
   * text is rotated -90° so it reads top-to-bottom, like a real Blu-ray spine.
   * Background colour is hashed from the title so each spine is distinguishable
   * from a distance; a light band at the top mimics the Blu-ray branding strip.
   */
  private drawSpine(ctx: CanvasRenderingContext2D, film: Film, i: number): void {
    const idx = i % (SPINE_COLS * this.rows);
    const x = (idx % SPINE_COLS) * SPINE_TILE_W;
    const y = Math.floor(idx / SPINE_COLS) * SPINE_TILE_H;
    const h = hashString(film.title);
    const hue = film.hue ?? h % 360;
    const light = 18 + (h % 20);
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = `hsl(${hue} 45% ${light}%)`;
    ctx.fillRect(0, 0, SPINE_TILE_W, SPINE_TILE_H);
    ctx.fillStyle = `hsl(${hue} 60% ${light + 30}%)`;
    ctx.fillRect(0, 0, SPINE_TILE_W, 14);
    // Rotate so that +x of text runs downward along the spine.
    ctx.translate(SPINE_TILE_W / 2, 20);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#f5f1e8';
    ctx.textBaseline = 'middle';
    ctx.font = '700 12px system-ui, "Segoe UI", Helvetica, Arial, sans-serif';
    const maxW = SPINE_TILE_H - 60;
    let title = film.title.toUpperCase();
    while (ctx.measureText(title).width > maxW && title.length > 3) title = title.slice(0, -2) + '…';
    ctx.fillText(title, 0, 0);
    if (film.year) {
      ctx.font = '500 9px system-ui, "Segoe UI", Helvetica, Arial, sans-serif';
      ctx.globalAlpha = 0.8;
      ctx.textAlign = 'right';
      ctx.fillText(String(film.year), SPINE_TILE_H - 26, 0);
    }
    ctx.restore();
  }

  dispose(): void {
    this.texture.dispose();
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}

// ---------------------------------------------------------------------------
// Poster atlas (LRU-resident tiles, partial GPU uploads)
// ---------------------------------------------------------------------------
const POSTER_TILE_W = 256;
const POSTER_TILE_H = 384;
const POSTER_ATLAS = 4096;
const POSTER_COLS = Math.floor(POSTER_ATLAS / POSTER_TILE_W); // 16
const POSTER_ROWS = Math.floor(POSTER_ATLAS / POSTER_TILE_H); // 10
export const POSTER_CAPACITY = POSTER_COLS * POSTER_ROWS; // 160 resident posters

interface Tile {
  slot: number;
  filmId: string;
  lastUsed: number;
}

export class PosterAtlas {
  readonly texture: THREE.DataTexture;
  private readonly tiles = new Map<string, Tile>(); // resident by filmId
  private readonly free: number[] = [];
  private readonly loading = new Set<string>();
  private readonly pendingUploads: { slot: number; source: CoverSource }[] = [];
  private frame = 0;
  private readonly onResident: (filmId: string, rect: THREE.Vector4) => void;
  private readonly onEvicted: (filmId: string) => void;
  private disposed = false;

  constructor(cb: { onResident: (filmId: string, rect: THREE.Vector4) => void; onEvicted: (filmId: string) => void }) {
    this.onResident = cb.onResident;
    this.onEvicted = cb.onEvicted;
    // Null data: the GPU allocates the storage, we fill tiles with texSubImage2D.
    this.texture = new THREE.DataTexture(null, POSTER_ATLAS, POSTER_ATLAS, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = true; // tiles are canvases; flip them on upload
    this.texture.generateMipmaps = false; // partial uploads can't cheaply rebuild mips
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.anisotropy = 8;
    // `dataReady = false` makes three allocate storage (texStorage2D) without
    // trying to upload the null buffer; tiles arrive later via texSubImage2D.
    this.texture.source.dataReady = false;
    this.texture.needsUpdate = true;
    for (let i = POSTER_CAPACITY - 1; i >= 0; i--) this.free.push(i);
  }

  rect(slot: number, out: THREE.Vector4): THREE.Vector4 {
    const col = slot % POSTER_COLS;
    const row = Math.floor(slot / POSTER_COLS);
    return out.set((col * POSTER_TILE_W) / POSTER_ATLAS, (row * POSTER_TILE_H) / POSTER_ATLAS, POSTER_TILE_W / POSTER_ATLAS, POSTER_TILE_H / POSTER_ATLAS);
  }

  /** Mark a film as wanted this frame; loads it if not resident (evicting LRU if needed). */
  request(film: Film): void {
    if (this.disposed) return;
    const t = this.tiles.get(film.id);
    if (t) {
      t.lastUsed = this.frame;
      return;
    }
    if (this.loading.has(film.id)) return;
    let slot = this.free.pop();
    if (slot === undefined) {
      // Evict least-recently-used tile that wasn't used this frame.
      let victim: Tile | null = null;
      for (const tile of this.tiles.values()) if (tile.lastUsed < this.frame && (!victim || tile.lastUsed < victim.lastUsed)) victim = tile;
      if (!victim) return; // atlas saturated with visible cases; skip this frame
      this.tiles.delete(victim.filmId);
      this.onEvicted(victim.filmId);
      slot = victim.slot;
    }
    const mySlot = slot;
    this.loading.add(film.id);
    this.tiles.set(film.id, { slot: mySlot, filmId: film.id, lastUsed: this.frame });
    void resolveCover(film).then((source) => {
      this.loading.delete(film.id);
      if (this.disposed || this.tiles.get(film.id)?.slot !== mySlot) return; // evicted meanwhile
      this.pendingUploads.push({ slot: mySlot, source });
    });
  }

  /** Called once per frame: uploads at most `budget` tiles into the GPU atlas. */
  tick(renderer: THREE.WebGLRenderer, budget = 2): void {
    this.frame++;
    for (let n = 0; n < budget && this.pendingUploads.length; n++) {
      const { slot, source } = this.pendingUploads.shift()!;
      const tileCanvas = document.createElement('canvas');
      tileCanvas.width = POSTER_TILE_W;
      tileCanvas.height = POSTER_TILE_H;
      const ctx = tileCanvas.getContext('2d')!;
      ctx.drawImage(source, 0, 0, POSTER_TILE_W, POSTER_TILE_H);
      const src = new THREE.CanvasTexture(tileCanvas);
      src.flipY = true;
      src.colorSpace = THREE.SRGBColorSpace;
      const col = slot % POSTER_COLS;
      const row = Math.floor(slot / POSTER_COLS);
      try {
        renderer.copyTextureToTexture(src, this.texture, null, new THREE.Vector2(col * POSTER_TILE_W, row * POSTER_TILE_H));
      } catch (e) {
        console.warn('atlas upload failed', e);
      }
      src.dispose();
      const filmId = [...this.tiles.values()].find((t) => t.slot === slot)?.filmId;
      if (filmId) this.onResident(filmId, this.rect(slot, new THREE.Vector4()));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.texture.dispose();
    this.tiles.clear();
    this.pendingUploads.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Materials with instanced atlas sampling
// ---------------------------------------------------------------------------
type MatKind = 'flat' | 'front' | 'spine';

const FX_VERTEX_DECL = /* glsl */ `
  attribute vec4 aRect;
  attribute vec3 aTint;
  attribute vec2 aFx; // x = dim (0..1), y = glow (0..1)
  varying vec4 vRect;
  varying vec3 vTint;
  varying vec2 vFx;
`;
const FX_VERTEX_BODY = /* glsl */ `
  vRect = aRect; vTint = aTint; vFx = aFx;
`;
const FX_FRAGMENT_DECL = /* glsl */ `
  varying vec4 vRect;
  varying vec3 vTint;
  varying vec2 vFx;
`;

function makeCaseMaterial(kind: MatKind, atlas: THREE.Texture | null): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: kind === 'flat' ? 0.55 : 0.4,
    metalness: 0.0,
    map: atlas,
  });
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FX_VERTEX_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FX_VERTEX_BODY}`);
    const sample =
      kind === 'flat'
        ? /* glsl */ `diffuseColor.rgb *= vTint;`
        : /* glsl */ `
          // Atlas lookup: rect.xy = tile origin, rect.zw = tile size (UV space).
          // rect.z == 0 means "not resident" → fall back to the tint colour.
          if (vRect.z > 0.0) {
            vec2 auv = vRect.xy + clamp(vMapUv, 0.002, 0.998) * vRect.zw;
            vec4 tex = texture2D(map, auv);
            diffuseColor *= tex;
          } else {
            diffuseColor.rgb *= vTint;
          }`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FX_FRAGMENT_DECL}`)
      .replace('#include <map_fragment>', sample)
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
         diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.18, vFx.x);
         totalEmissiveRadiance += diffuseColor.rgb * vFx.y * 0.9 + vec3(0.35, 0.3, 0.2) * vFx.y;`,
      );
  };
  // Distinct cache key per kind so three doesn't share the compiled program.
  mat.customProgramCacheKey = () => `reelroom-case-${kind}`;
  return mat;
}

// ---------------------------------------------------------------------------
// CaseBatch: the InstancedMesh + attribute management
// ---------------------------------------------------------------------------
export class CaseBatch {
  readonly mesh: THREE.InstancedMesh;
  readonly films: Film[];
  readonly indexOf = new Map<string, number>();
  readonly spines: SpineAtlas;
  readonly posters: PosterAtlas;
  private readonly rectAttr: THREE.InstancedBufferAttribute;
  private readonly tintAttr: THREE.InstancedBufferAttribute;
  private readonly fxAttr: THREE.InstancedBufferAttribute;
  private readonly spineRectAttr: THREE.InstancedBufferAttribute;
  private readonly geometry: THREE.BoxGeometry;
  private readonly materials: THREE.MeshStandardMaterial[];
  private readonly tmpV4 = new THREE.Vector4();

  constructor(films: Film[]) {
    this.films = films;
    films.forEach((f, i) => this.indexOf.set(f.id, i));
    const n = Math.max(1, films.length);

    this.spines = new SpineAtlas(films);
    this.posters = new PosterAtlas({
      onResident: (id, rect) => this.setPosterRect(id, rect),
      onEvicted: (id) => this.setPosterRect(id, null),
    });

    this.geometry = makeCaseGeometry();
    // Both fronts and spines read `aRect` — but they need different rects.
    // Trick: the geometry is shared, so we register both attributes and alias
    // `aRect` per material via a tiny defines swap in onBeforeCompile.
    this.rectAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.spineRectAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    this.tintAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.fxAttr = new THREE.InstancedBufferAttribute(new Float32Array(n * 2), 2);
    this.rectAttr.setUsage(THREE.DynamicDrawUsage);
    this.fxAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('aPosterRect', this.rectAttr);
    this.geometry.setAttribute('aSpineRect', this.spineRectAttr);
    this.geometry.setAttribute('aTint', this.tintAttr);
    this.geometry.setAttribute('aFx', this.fxAttr);

    const flat = makeCaseMaterial('flat', null);
    const front = makeCaseMaterial('front', this.posters.texture);
    const spine = makeCaseMaterial('spine', this.spines.texture);
    // Alias aRect → the right attribute for each material.
    for (const [m, attr] of [
      [flat, 'aPosterRect'],
      [front, 'aPosterRect'],
      [spine, 'aSpineRect'],
    ] as const) {
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = (shader, renderer) => {
        prev(shader, renderer);
        shader.vertexShader = shader.vertexShader.replace('attribute vec4 aRect;', `attribute vec4 ${attr};\n#define aRect ${attr}`);
      };
    }
    this.materials = [flat, front, spine];

    this.mesh = new THREE.InstancedMesh(this.geometry, this.materials, n);
    this.mesh.count = films.length;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false; // instances span the room; cull per-instance ourselves
    this.mesh.name = 'cases';

    films.forEach((f, i) => {
      const c = new THREE.Color().setHSL(((f.hue ?? hashString(f.title) % 360) / 360), 0.35, 0.28);
      this.tintAttr.setXYZ(i, c.r, c.g, c.b);
      this.spines.rect(i, this.tmpV4);
      this.spineRectAttr.setXYZW(i, this.tmpV4.x, this.tmpV4.y, this.tmpV4.z, this.tmpV4.w);
      this.rectAttr.setXYZW(i, 0, 0, 0, 0);
      this.fxAttr.setXY(i, 0, 0);
      this.mesh.setMatrixAt(i, new THREE.Matrix4());
    });
  }

  private setPosterRect(id: string, rect: THREE.Vector4 | null): void {
    const i = this.indexOf.get(id);
    if (i === undefined) return;
    if (rect) this.rectAttr.setXYZW(i, rect.x, rect.y, rect.z, rect.w);
    else this.rectAttr.setXYZW(i, 0, 0, 0, 0);
    this.rectAttr.needsUpdate = true;
  }

  setMatrix(i: number, m: THREE.Matrix4): void {
    this.mesh.setMatrixAt(i, m);
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  getMatrix(i: number, out: THREE.Matrix4): THREE.Matrix4 {
    this.mesh.getMatrixAt(i, out);
    return out;
  }
  setFx(i: number, dim: number, glow: number): void {
    this.fxAttr.setXY(i, dim, glow);
    this.fxAttr.needsUpdate = true;
  }
  getDim(i: number): number {
    return this.fxAttr.getX(i);
  }

  /** Per-frame: push pending poster uploads. */
  tick(renderer: THREE.WebGLRenderer): void {
    this.posters.tick(renderer);
  }

  /** Clean dispose path used when the collection is re-imported. */
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.dispose();
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.spines.dispose();
    this.posters.dispose();
  }
}
