/**
 * CaseMesh: every film case is drawn by ONE InstancedMesh with a six-material
 * rounded box (front = poster, back = darkened poster crop, spine = canvas
 * texture, opening edge / top / bottom = dark plastic).
 *
 * Rendering scales through three mechanisms:
 *  - Atlasing. Fronts sample a 4096² hi-res LRU atlas (only cases near the
 *    camera are resident) and a 2048² low-res atlas that holds EVERY poster,
 *    so distant cases never fall back to a flat tint once loaded. Per-instance
 *    attributes carry the UV rects; the shader picks the atlas by LOD.
 *  - Compaction. Each frame the visible instances (frustum + radius) are packed
 *    to the front of the render buffers and `mesh.count` is set, so off-screen
 *    cases cost nothing at all.
 *  - A second, invisible InstancedMesh with the SAME geometry (zero padding)
 *    holds each case's rest pose and is what the picker raycasts, so hover /
 *    select animations never change what the pointer hits.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Film } from '../types';
import { hashString, resolveCover, type CoverSource } from '../data/tmdb';

// DVD keep-case, real size: 135 × 190 × 14 mm (1 unit = 1 m).
export const CASE_W = 0.135;
export const CASE_H = 0.19;
export const CASE_D = 0.014;
/** Bounding radius used for per-instance culling. */
export const CASE_RADIUS = Math.hypot(CASE_W, CASE_H, CASE_D) / 2;

export const MAT_FRONT = 0;
export const MAT_BACK = 1;
export const MAT_SPINE = 2;
export const MAT_EDGE = 3;

/** FACING: poster (+Z face) toward the viewer, tilted back by `tiltBack` radians. */
export function facingQuaternion(tiltBack = 0, target = new THREE.Quaternion()): THREE.Quaternion {
  return target.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -tiltBack);
}

// ---------------------------------------------------------------------------
// Geometry: rounded box with per-face material groups + an opening-edge lip.
// RoundedBoxGeometry is non-indexed and lays its faces out contiguously in the
// order right(+X), left(-X), top(+Y), bottom(-Y), front(+Z), back(-Z).
// ---------------------------------------------------------------------------
export function makeCaseGeometry(): THREE.BufferGeometry {
  const body = new RoundedBoxGeometry(CASE_W, CASE_H, CASE_D, 2, 0.0025);
  const faceMats = [MAT_EDGE, MAT_SPINE, MAT_EDGE, MAT_EDGE, MAT_FRONT, MAT_BACK];
  const bodyCount = body.attributes.position!.count;
  const perFace = bodyCount / 6;
  const lipW = 0.004;
  const lip = new THREE.BoxGeometry(lipW, CASE_H - 0.008, 0.0015).toNonIndexed();
  lip.translate(CASE_W / 2 - lipW / 2 - 0.003, 0, CASE_D / 2 + 0.0007);
  const cat = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, b: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): THREE.BufferAttribute => {
    const A = a.array as Float32Array;
    const B = b.array as Float32Array;
    const out = new Float32Array(A.length + B.length);
    out.set(A, 0);
    out.set(B, A.length);
    return new THREE.BufferAttribute(out, size);
  };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', cat(body.attributes.position!, lip.attributes.position!, 3));
  g.setAttribute('normal', cat(body.attributes.normal!, lip.attributes.normal!, 3));
  g.setAttribute('uv', cat(body.attributes.uv!, lip.attributes.uv!, 2));
  faceMats.forEach((m, i) => g.addGroup(i * perFace, perFace, m));
  g.addGroup(bodyCount, lip.attributes.position!.count, MAT_EDGE);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  body.dispose();
  lip.dispose();
  return g;
}

// ---------------------------------------------------------------------------
// Spine atlas
// ---------------------------------------------------------------------------
const SPINE_TILE_W = 32;
const SPINE_TILE_H = 400;
const SPINE_ATLAS_W = 2048;
const SPINE_COLS = Math.floor(SPINE_ATLAS_W / SPINE_TILE_W);
const SPINE_MAX_ROWS = 10;

export class SpineAtlas {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly rows: number;

  constructor(films: Film[], anisotropy: number) {
    this.rows = Math.max(1, Math.min(SPINE_MAX_ROWS, Math.ceil(films.length / SPINE_COLS)));
    this.canvas = document.createElement('canvas');
    this.canvas.width = SPINE_ATLAS_W;
    this.canvas.height = this.rows * SPINE_TILE_H;
    const ctx = this.canvas.getContext('2d')!;
    films.forEach((f, i) => this.drawSpine(ctx, f, i));
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = anisotropy;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
  }

  rect(i: number, out: THREE.Vector4): THREE.Vector4 {
    const idx = i % (SPINE_COLS * this.rows);
    const col = idx % SPINE_COLS;
    const row = Math.floor(idx / SPINE_COLS);
    const H = this.canvas.height;
    return out.set((col * SPINE_TILE_W) / SPINE_ATLAS_W, 1 - ((row + 1) * SPINE_TILE_H) / H, SPINE_TILE_W / SPINE_ATLAS_W, SPINE_TILE_H / H);
  }

  /** Studio block top, year block bottom, title rotated to read top-to-bottom. */
  private drawSpine(ctx: CanvasRenderingContext2D, film: Film, i: number): void {
    const idx = i % (SPINE_COLS * this.rows);
    const x = (idx % SPINE_COLS) * SPINE_TILE_W;
    const y = Math.floor(idx / SPINE_COLS) * SPINE_TILE_H;
    const h = hashString(film.title);
    const hue = film.hue ?? h % 360;
    const light = 16 + (h % 18);
    const W = SPINE_TILE_W;
    const H = SPINE_TILE_H;
    const block = 34;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = `hsl(${hue} 42% ${light}%)`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `hsl(${hue} 30% ${light + 55}%)`;
    ctx.fillRect(0, 0, W, block);
    ctx.fillStyle = `hsl(${hue} 42% ${light}%)`;
    ctx.fillRect(W / 2 - 7, 9, 14, 14);
    ctx.fillStyle = `hsl(${hue} 30% ${light + 55}%)`;
    ctx.fillRect(W / 2 - 4, 12, 8, 8);
    ctx.fillStyle = `hsl(${hue} 35% ${Math.max(6, light - 8)}%)`;
    ctx.fillRect(0, H - block, W, block);
    ctx.fillStyle = '#e8e2d6';
    ctx.font = '600 9px system-ui, "Segoe UI", Helvetica, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(film.year ? String(film.year) : '', W / 2, H - block / 2);
    ctx.translate(W / 2, block + 8);
    ctx.rotate(Math.PI / 2);
    ctx.fillStyle = '#f5f1e8';
    ctx.textAlign = 'left';
    ctx.font = '700 15px system-ui, "Segoe UI", Helvetica, Arial, sans-serif';
    const maxW = H - 2 * block - 16;
    let title = film.title.toUpperCase();
    while (ctx.measureText(title).width > maxW && title.length > 3) title = title.slice(0, -2) + '…';
    ctx.fillText(title, 0, 0);
    ctx.restore();
  }

  dispose(): void {
    this.texture.dispose();
    this.canvas.width = 1;
    this.canvas.height = 1;
  }
}

// ---------------------------------------------------------------------------
// Poster atlases
// ---------------------------------------------------------------------------
/** Cover-fit draw: fill the tile, crop the overflow, keep the aspect ratio. */
function drawCover(ctx: CanvasRenderingContext2D, src: CoverSource, tw: number, th: number): void {
  const sw = src instanceof HTMLImageElement ? src.naturalWidth || src.width : src.width;
  const sh = src instanceof HTMLImageElement ? src.naturalHeight || src.height : src.height;
  if (!sw || !sh) return;
  const scale = Math.max(tw / sw, th / sh);
  const cw = tw / scale;
  const ch = th / scale;
  ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, tw, th);
}

function makeAtlasTexture(size: number, anisotropy: number, mipmaps: boolean): THREE.DataTexture {
  const t = new THREE.DataTexture(null, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = THREE.SRGBColorSpace;
  t.flipY = true;
  t.generateMipmaps = mipmaps;
  t.minFilter = mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = anisotropy;
  t.source.dataReady = false; // allocate on the GPU, fill with texSubImage2D later
  t.needsUpdate = true;
  return t;
}

/** Upload a cover into a tile of an atlas (partial texSubImage2D copy). */
function uploadTile(renderer: THREE.WebGLRenderer, atlas: THREE.DataTexture, source: CoverSource, x: number, y: number, tw: number, th: number): void {
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  drawCover(c.getContext('2d')!, source, tw, th);
  const src = new THREE.CanvasTexture(c);
  src.flipY = true;
  src.colorSpace = THREE.SRGBColorSpace;
  try {
    renderer.copyTextureToTexture(src, atlas, null, new THREE.Vector2(x, y));
  } catch (e) {
    console.warn('atlas upload failed', e);
  }
  src.dispose();
}

// ---- Hi-res LRU atlas ----------------------------------------------------------
const HI_TILE_W = 256;
const HI_TILE_H = 360; // 135:190 aspect → cover-fit never stretches
const HI_ATLAS = 4096;
const HI_COLS = Math.floor(HI_ATLAS / HI_TILE_W);
const HI_ROWS = Math.floor(HI_ATLAS / HI_TILE_H);
export const POSTER_CAPACITY = HI_COLS * HI_ROWS; // 176 resident hi-res posters

interface Tile {
  slot: number;
  filmId: string;
  lastUsed: number;
}

export class PosterAtlas {
  readonly texture: THREE.DataTexture;
  private readonly tiles = new Map<string, Tile>();
  private readonly free: number[] = [];
  private readonly loading = new Set<string>();
  private readonly pending: { slot: number; source: CoverSource }[] = [];
  private frame = 0;
  private disposed = false;

  constructor(
    anisotropy: number,
    private readonly cb: { onResident: (filmId: string, rect: THREE.Vector4) => void; onEvicted: (filmId: string) => void },
  ) {
    this.texture = makeAtlasTexture(HI_ATLAS, anisotropy, false);
    for (let i = POSTER_CAPACITY - 1; i >= 0; i--) this.free.push(i);
  }

  rect(slot: number, out: THREE.Vector4): THREE.Vector4 {
    const col = slot % HI_COLS;
    const row = Math.floor(slot / HI_COLS);
    return out.set((col * HI_TILE_W) / HI_ATLAS, (row * HI_TILE_H) / HI_ATLAS, HI_TILE_W / HI_ATLAS, HI_TILE_H / HI_ATLAS);
  }

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
      let victim: Tile | null = null;
      for (const tile of this.tiles.values()) if (tile.lastUsed < this.frame && (!victim || tile.lastUsed < victim.lastUsed)) victim = tile;
      if (!victim) return;
      this.tiles.delete(victim.filmId);
      this.cb.onEvicted(victim.filmId);
      slot = victim.slot;
    }
    const mySlot = slot;
    this.loading.add(film.id);
    this.tiles.set(film.id, { slot: mySlot, filmId: film.id, lastUsed: this.frame });
    void resolveCover(film).then((source) => {
      this.loading.delete(film.id);
      if (this.disposed || this.tiles.get(film.id)?.slot !== mySlot) return;
      this.pending.push({ slot: mySlot, source });
    });
  }

  tick(renderer: THREE.WebGLRenderer, budget = 2): void {
    this.frame++;
    for (let n = 0; n < budget && this.pending.length; n++) {
      const { slot, source } = this.pending.shift()!;
      uploadTile(renderer, this.texture, source, (slot % HI_COLS) * HI_TILE_W, Math.floor(slot / HI_COLS) * HI_TILE_H, HI_TILE_W, HI_TILE_H);
      const filmId = [...this.tiles.values()].find((t) => t.slot === slot)?.filmId;
      if (filmId) this.cb.onResident(filmId, this.rect(slot, new THREE.Vector4()));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.texture.dispose();
    this.tiles.clear();
    this.pending.length = 0;
  }
}

// ---- Low-res "mip" atlas: every poster, always resident -------------------------
const LO_TILE_W = 64;
const LO_TILE_H = 90;
const LO_ATLAS = 2048;
const LO_COLS = Math.floor(LO_ATLAS / LO_TILE_W); // 32
const LO_ROWS = Math.floor(LO_ATLAS / LO_TILE_H); // 22
export const LOW_CAPACITY = LO_COLS * LO_ROWS; // 704 posters

export class LowAtlas {
  readonly texture: THREE.DataTexture;
  private queue: Film[] = [];
  private readonly pending: { i: number; source: CoverSource }[] = [];
  private inflight = 0;
  private disposed = false;

  constructor(
    anisotropy: number,
    private readonly onResident: (filmIndex: number, rect: THREE.Vector4) => void,
  ) {
    this.texture = makeAtlasTexture(LO_ATLAS, anisotropy, true);
  }

  rect(i: number, out: THREE.Vector4): THREE.Vector4 {
    const col = i % LO_COLS;
    const row = Math.floor(i / LO_COLS);
    return out.set((col * LO_TILE_W) / LO_ATLAS, (row * LO_TILE_H) / LO_ATLAS, LO_TILE_W / LO_ATLAS, LO_TILE_H / LO_ATLAS);
  }

  /** Queue every film; tiles stream in a few per frame in the background. */
  enqueue(films: Film[]): void {
    this.queue = films.slice(0, LOW_CAPACITY);
  }

  tick(renderer: THREE.WebGLRenderer, films: Film[]): void {
    while (this.inflight < 4 && this.queue.length) {
      const film = this.queue.shift()!;
      const i = films.indexOf(film);
      this.inflight++;
      void resolveCover(film).then((source) => {
        this.inflight--;
        if (!this.disposed) this.pending.push({ i, source });
      });
    }
    for (let n = 0; n < 3 && this.pending.length; n++) {
      const { i, source } = this.pending.shift()!;
      uploadTile(renderer, this.texture, source, (i % LO_COLS) * LO_TILE_W, Math.floor(i / LO_COLS) * LO_TILE_H, LO_TILE_W, LO_TILE_H);
      this.onResident(i, this.rect(i, new THREE.Vector4()));
    }
  }

  get busy(): boolean {
    return this.queue.length > 0 || this.pending.length > 0 || this.inflight > 0;
  }

  dispose(): void {
    this.disposed = true;
    this.texture.dispose();
    this.queue.length = 0;
    this.pending.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Materials with instanced atlas sampling + LOD select
// ---------------------------------------------------------------------------
type MatKind = 'edge' | 'front' | 'back' | 'spine';

const FX_VERTEX_DECL = /* glsl */ `
  attribute vec4 aRect;
  attribute vec4 aLowRect;
  attribute vec3 aTint;
  attribute vec3 aFx; // x = dim (0..1), y = glow (0..1), z = lod (0 = hi-res, 1 = low-res)
  varying vec4 vRect;
  varying vec4 vLowRect;
  varying vec3 vTint;
  varying vec3 vFx;
`;
const FX_VERTEX_BODY = /* glsl */ `
  vRect = aRect; vLowRect = aLowRect; vTint = aTint; vFx = aFx;
`;
const FX_FRAGMENT_DECL = /* glsl */ `
  uniform sampler2D mapLow;
  varying vec4 vRect;
  varying vec4 vLowRect;
  varying vec3 vTint;
  varying vec3 vFx;
`;

/** Atlas select: hi-res when near and resident, else low-res if loaded, else hi-res if resident, else tint. */
const SELECT_GLSL = /* glsl */ `
  vec2 cuv = clamp(vMapUv, 0.002, 0.998);
  bool haveTex = false;
  vec4 tex = vec4(1.0);
  if (vFx.z < 0.5 && vRect.z > 0.0) { tex = texture2D(map, vRect.xy + cuv * vRect.zw); haveTex = true; }
  else if (vLowRect.z > 0.0) { tex = texture2D(mapLow, vLowRect.xy + cuv * vLowRect.zw); haveTex = true; }
  else if (vRect.z > 0.0) { tex = texture2D(map, vRect.xy + cuv * vRect.zw); haveTex = true; }
`;

function makeCaseMaterial(kind: MatKind, atlas: THREE.Texture | null, low: THREE.Texture | null): THREE.MeshPhysicalMaterial {
  // Glossy polypropylene: low roughness + faint clearcoat so the ceiling panels catch the surface.
  const mat = new THREE.MeshPhysicalMaterial({
    color: kind === 'edge' ? 0x1c1c1f : 0xffffff,
    roughness: kind === 'edge' ? 0.45 : 0.3,
    metalness: 0.0,
    clearcoat: kind === 'edge' ? 0.15 : 0.4,
    clearcoatRoughness: 0.3,
    map: atlas,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.mapLow = { value: low };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${FX_VERTEX_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${FX_VERTEX_BODY}`);
    let sample: string;
    if (kind === 'edge') sample = /* glsl */ `diffuseColor.rgb *= mix(vec3(1.0), vTint, 0.15);`;
    else if (kind === 'back')
      sample = /* glsl */ `
        vec2 bak = 0.18 + clamp(vMapUv, 0.0, 1.0) * 0.64;
        if (vLowRect.z > 0.0) { diffuseColor.rgb *= texture2D(mapLow, vLowRect.xy + bak * vLowRect.zw).rgb * 0.38; }
        else if (vRect.z > 0.0) { diffuseColor.rgb *= texture2D(map, vRect.xy + bak * vRect.zw).rgb * 0.38; }
        else { diffuseColor.rgb *= vTint * 0.5; }`;
    else if (kind === 'spine') sample = /* glsl */ `if (vRect.z > 0.0) diffuseColor *= texture2D(map, vRect.xy + clamp(vMapUv, 0.002, 0.998) * vRect.zw); else diffuseColor.rgb *= vTint;`;
    else sample = `${SELECT_GLSL}\n if (haveTex) diffuseColor *= tex; else diffuseColor.rgb *= vTint;`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${FX_FRAGMENT_DECL}`)
      .replace('#include <map_fragment>', sample)
      .replace(
        '#include <emissivemap_fragment>',
        /* glsl */ `#include <emissivemap_fragment>
         diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.18, vFx.x);
         totalEmissiveRadiance += diffuseColor.rgb * vFx.y * 0.6 + vec3(0.30, 0.26, 0.18) * vFx.y;`,
      );
  };
  mat.customProgramCacheKey = () => `reelroom-case-${kind}`;
  return mat;
}

// ---------------------------------------------------------------------------
// CaseBatch
// ---------------------------------------------------------------------------
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _v = new THREE.Vector3();

export class CaseBatch {
  /** Rendered instances (compacted each frame to the visible set). */
  readonly mesh: THREE.InstancedMesh;
  /** Invisible twin holding rest poses for ALL films; the picker raycasts this. */
  readonly hitProxy: THREE.InstancedMesh;
  readonly films: Film[];
  readonly indexOf = new Map<string, number>();
  readonly spines: SpineAtlas;
  readonly posters: PosterAtlas;
  readonly low: LowAtlas;
  readonly geometry: THREE.BufferGeometry;
  /** Distance beyond which a case uses the low-res atlas. */
  lodDistance = 4;
  /** Stats from the last compaction. */
  visibleCount = 0;

  // Source-of-truth per film (index = film index)
  private readonly srcMatrix: Float32Array;
  private readonly srcRect: Float32Array;
  private readonly srcLow: Float32Array;
  private readonly srcSpine: Float32Array;
  private readonly srcTint: Float32Array;
  private readonly srcFx: Float32Array; // dim, glow, (lod is computed per frame)
  // Render buffers
  private readonly rRect: THREE.InstancedBufferAttribute;
  private readonly rLow: THREE.InstancedBufferAttribute;
  private readonly rSpine: THREE.InstancedBufferAttribute;
  private readonly rTint: THREE.InstancedBufferAttribute;
  private readonly rFx: THREE.InstancedBufferAttribute;
  private readonly materials: THREE.MeshPhysicalMaterial[];
  private readonly proxyMaterial: THREE.MeshBasicMaterial;
  private readonly tmpV4 = new THREE.Vector4();

  constructor(films: Film[], anisotropy = 1) {
    this.films = films;
    films.forEach((f, i) => this.indexOf.set(f.id, i));
    const n = Math.max(1, films.length);

    this.spines = new SpineAtlas(films, anisotropy);
    this.posters = new PosterAtlas(anisotropy, {
      onResident: (id, rect) => this.setRect(this.srcRect, this.indexOf.get(id), rect),
      onEvicted: (id) => this.setRect(this.srcRect, this.indexOf.get(id), null),
    });
    this.low = new LowAtlas(anisotropy, (i, rect) => this.setRect(this.srcLow, i, rect));
    this.low.enqueue(films);

    this.srcMatrix = new Float32Array(n * 16);
    this.srcRect = new Float32Array(n * 4);
    this.srcLow = new Float32Array(n * 4);
    this.srcSpine = new Float32Array(n * 4);
    this.srcTint = new Float32Array(n * 3);
    this.srcFx = new Float32Array(n * 3);

    this.geometry = makeCaseGeometry();
    const mk = (size: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.rRect = mk(4);
    this.rLow = mk(4);
    this.rSpine = mk(4);
    this.rTint = mk(3);
    this.rFx = mk(3);
    this.geometry.setAttribute('aPosterRect', this.rRect);
    this.geometry.setAttribute('aLowRect', this.rLow);
    this.geometry.setAttribute('aSpineRect', this.rSpine);
    this.geometry.setAttribute('aTint', this.rTint);
    this.geometry.setAttribute('aFx', this.rFx);

    const front = makeCaseMaterial('front', this.posters.texture, this.low.texture);
    const back = makeCaseMaterial('back', this.posters.texture, this.low.texture);
    const spine = makeCaseMaterial('spine', this.spines.texture, null);
    const edge = makeCaseMaterial('edge', null, null);
    for (const [m, attr] of [
      [front, 'aPosterRect'],
      [back, 'aPosterRect'],
      [spine, 'aSpineRect'],
      [edge, 'aPosterRect'],
    ] as const) {
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = (shader, renderer) => {
        prev(shader, renderer);
        shader.vertexShader = shader.vertexShader.replace('attribute vec4 aRect;', `attribute vec4 ${attr};\n#define aRect ${attr}`);
      };
    }
    this.materials = [front, back, spine, edge];

    this.mesh = new THREE.InstancedMesh(this.geometry, this.materials, n);
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = false;
    this.mesh.frustumCulled = false; // we cull per instance
    this.mesh.name = 'cases';

    this.proxyMaterial = new THREE.MeshBasicMaterial({ visible: false });
    this.hitProxy = new THREE.InstancedMesh(this.geometry, this.proxyMaterial, n);
    this.hitProxy.count = films.length;
    this.hitProxy.visible = false;
    this.hitProxy.frustumCulled = false;
    this.hitProxy.name = 'casesHitProxy';

    const identity = new THREE.Matrix4();
    films.forEach((f, i) => {
      const c = new THREE.Color().setHSL(((f.hue ?? hashString(f.title) % 360) / 360), 0.35, 0.28);
      this.srcTint.set([c.r, c.g, c.b], i * 3);
      this.spines.rect(i, this.tmpV4);
      this.srcSpine.set([this.tmpV4.x, this.tmpV4.y, this.tmpV4.z, this.tmpV4.w], i * 4);
      identity.toArray(this.srcMatrix, i * 16);
      this.hitProxy.setMatrixAt(i, identity);
    });
  }

  private setRect(target: Float32Array, i: number | undefined, rect: THREE.Vector4 | null): void {
    if (i === undefined) return;
    if (rect) target.set([rect.x, rect.y, rect.z, rect.w], i * 4);
    else target.fill(0, i * 4, i * 4 + 4);
  }

  /** Rendered pose (animated). */
  setMatrix(i: number, m: THREE.Matrix4): void {
    m.toArray(this.srcMatrix, i * 16);
  }
  getMatrix(i: number, out: THREE.Matrix4): THREE.Matrix4 {
    return out.fromArray(this.srcMatrix, i * 16);
  }
  /** Rest pose (what the pointer hits). Set whenever a case is (re)assigned to a slot. */
  setRestMatrix(i: number, m: THREE.Matrix4): void {
    this.hitProxy.setMatrixAt(i, m);
    this.hitProxy.instanceMatrix.needsUpdate = true;
    this.hitProxy.boundingSphere = null;
  }
  setFx(i: number, dim: number, glow: number): void {
    this.srcFx[i * 3] = dim;
    this.srcFx[i * 3 + 1] = glow;
  }
  getDim(i: number): number {
    return this.srcFx[i * 3] ?? 0;
  }
  hasLowRes(i: number): boolean {
    return (this.srcLow[i * 4 + 2] ?? 0) > 0;
  }

  /**
   * Per-frame: stream atlas tiles, then compact the visible instances.
   * Visibility = bounding sphere inside the frustum. LOD = distance to camera.
   */
  tick(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    this.posters.tick(renderer);
    this.low.tick(renderer, this.films);

    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pv);
    const camPos = _v.setFromMatrixPosition(camera.matrixWorld).clone();
    const lod2 = this.lodDistance * this.lodDistance;
    const mArr = this.mesh.instanceMatrix.array as Float32Array;
    let k = 0;
    for (let i = 0; i < this.films.length; i++) {
      const o = i * 16;
      _sphere.center.set(this.srcMatrix[o + 12]!, this.srcMatrix[o + 13]!, this.srcMatrix[o + 14]!);
      _sphere.radius = CASE_RADIUS;
      if (!_frustum.intersectsSphere(_sphere)) continue;
      mArr.set(this.srcMatrix.subarray(o, o + 16), k * 16);
      (this.rRect.array as Float32Array).set(this.srcRect.subarray(i * 4, i * 4 + 4), k * 4);
      (this.rLow.array as Float32Array).set(this.srcLow.subarray(i * 4, i * 4 + 4), k * 4);
      (this.rSpine.array as Float32Array).set(this.srcSpine.subarray(i * 4, i * 4 + 4), k * 4);
      (this.rTint.array as Float32Array).set(this.srcTint.subarray(i * 3, i * 3 + 3), k * 3);
      const fx = this.rFx.array as Float32Array;
      fx[k * 3] = this.srcFx[i * 3]!;
      fx[k * 3 + 1] = this.srcFx[i * 3 + 1]!;
      fx[k * 3 + 2] = _sphere.center.distanceToSquared(camPos) > lod2 ? 1 : 0;
      k++;
    }
    this.visibleCount = k;
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.rRect.needsUpdate = this.rLow.needsUpdate = this.rSpine.needsUpdate = this.rTint.needsUpdate = this.rFx.needsUpdate = true;
  }

  /** Clean dispose path: meshes out of the scene, geometry, materials and atlases freed. */
  dispose(): void {
    this.mesh.removeFromParent();
    this.hitProxy.removeFromParent();
    this.mesh.dispose();
    this.hitProxy.dispose();
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
    this.proxyMaterial.dispose();
    this.spines.dispose();
    this.posters.dispose();
    this.low.dispose();
  }
}
