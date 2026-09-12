/**
 * REELROOM 3D — bootstrap.
 *
 * Owns the renderer, the scene graph roots, the systems (layout, picking,
 * camera), the UI overlay, and the single requestAnimationFrame loop.
 */
import * as THREE from 'three';
import type { CameraMode, Film, RoomTheme, ShelfKind, ShelfPlacement, SortMode } from './types';
import { Room, ROOM_D, ROOM_W } from './scene/room';
import { CaseBatch, POSTER_CAPACITY } from './scene/case';
import { LayoutSystem } from './systems/layout';
import { PickingSystem } from './systems/picking';
import { CameraSystem } from './systems/camera';
import { store, parseLayoutJson } from './state/store';
import { enrichFilms } from './data/tmdb';
import { importLetterboxdFile } from './data/letterboxd';
import { sampleFilms } from './data/sample';
import { ImportScreen } from './ui/importScreen';
import { Toolbar } from './ui/toolbar';
import { DetailPanel } from './ui/detail';
import { StatsStrip } from './ui/stats';
import { download, el, pickFile, toast } from './ui/dom';

// ---------------------------------------------------------------------------
// Renderer & scene
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f0d0b);
scene.fog = new THREE.Fog(0x1a1512, 8, 22); // mild fog, only touches the far corners

const room = new Room(store.get().layout.theme);
scene.add(room.group);

const cameraSys = new CameraSystem(canvas, () => room.colliders);
const camera = cameraSys.camera;

let batch = new CaseBatch([]);
scene.add(batch.mesh);
const layout = new LayoutSystem(room, batch);

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
uiRoot.append(el('div', { class: 'vignette' }));
const crosshair = el('div', { class: 'crosshair hidden' });
uiRoot.append(crosshair);

const detail = new DetailPanel(uiRoot, () => picking.endInspect());
const stats = new StatsStrip(uiRoot);

const picking = new PickingSystem(canvas, camera, room, batch, layout, {
  pointerNdc: () => cameraSys.pointerNdc(),
  onInspect: (id) => {
    const film = id ? store.get().films.find((f) => f.id === id) : undefined;
    if (film) void detail.show(film);
    else detail.hide();
  },
});

const toolbar = new Toolbar(uiRoot, {
  onSort: (mode) => arrange(mode),
  onSearch: (q) => applySearch(q),
  onCameraMode: (m) => cameraSys.setMode(m),
  onTheme: (t) => {
    store.setTheme(t);
    room.setTheme(store.get().layout.theme);
  },
  onAddShelf: (kind) => addShelf(kind),
  onRemoveShelf: () => removeLastShelf(),
  onSnapshot: () => snapshot(),
  onExportLayout: () => {
    const json = JSON.stringify(store.get().layout, null, 2);
    download(new Blob([json], { type: 'application/json' }), 'reelroom-layout.json');
  },
  onImportLayout: async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const layoutData = parseLayoutJson(await f.text());
      store.replaceLayout(layoutData);
      rebuildShelves(layoutData.shelves);
      layout.apply(layoutData.assignments, true);
      layout.fillGaps(store.get().films, layoutData.sortMode);
      store.setAssignments(layout.toRecord());
      room.setTheme(layoutData.theme);
      cameraSys.setMode(layoutData.cameraMode);
      toast('Layout imported');
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`);
    }
  },
  onResetRoom: () => {
    store.resetLayout();
    const l = store.get().layout;
    rebuildShelves(l.shelves);
    room.setTheme(l.theme);
    arrange(l.sortMode);
    toast('Room reset');
  },
  onImportCollection: () => store.setPhase('import'),
});
void toolbar;

const importScreen = new ImportScreen(uiRoot, {
  onFile: async (file) => {
    try {
      store.setPhase('loading');
      store.setProgress({ done: 0, total: 0, label: `Reading ${file.name}…` });
      const films = await importLetterboxdFile(file);
      await loadCollection(films, 'import');
      toast(`Imported ${films.length} films`);
    } catch (e) {
      store.setPhase('import');
      toast(`Import failed: ${(e as Error).message}`, 4000);
    }
  },
  onUseSample: () => void loadCollection(sampleFilms(), 'sample'),
  onContinue: () => store.setPhase('room'),
});
void importScreen;

cameraSys.onModeChange = (m: CameraMode) => {
  store.setCameraMode(m);
  crosshair.classList.toggle('hidden', m !== 'walk');
};

// ---------------------------------------------------------------------------
// Collection lifecycle
// ---------------------------------------------------------------------------
async function loadCollection(films: Film[], source: 'sample' | 'import'): Promise<void> {
  store.setPhase('loading');
  store.setProgress({ done: 0, total: films.length, label: 'Looking up metadata…' });
  await enrichFilms(films, (p) => store.setProgress(p));

  // Dispose the previous batch (geometry, materials, atlases) before building anew.
  batch.dispose();
  batch = new CaseBatch(films);
  scene.add(batch.mesh);
  layout.setBatch(batch);
  picking.setBatch(batch);
  store.setFilms(films, source);
  stats.update(films);

  rebuildShelves(store.get().layout.shelves);
  const saved = store.get().layout.assignments;
  const known = Object.keys(saved).filter((id) => batch.indexOf.has(id)).length;
  if (known > films.length * 0.5) {
    layout.apply(saved, false);
    layout.fillGaps(films, store.get().layout.sortMode);
  } else {
    layout.apply(layout.arrange(films, store.get().layout.sortMode), false);
  }
  store.setAssignments(layout.toRecord());
  applySearch(store.get().search);
  store.setPhase('room');
  if (layout.capacity < films.length) toast(`${films.length - layout.capacity} films don't fit — add shelves`, 4000);
}

function rebuildShelves(placements: ShelfPlacement[]): void {
  room.setShelves(placements);
  layout.refreshSlots();
  picking.refreshColliders();
}

function arrange(mode: SortMode): void {
  store.setSortMode(mode);
  layout.apply(layout.arrange(store.get().films, mode), true);
  store.setAssignments(layout.toRecord());
}

function applySearch(q: string): void {
  store.set({ search: q });
  const needle = q.trim().toLowerCase();
  const before = new Set(layout.pushed);
  layout.pushed.clear();
  batch.films.forEach((f, i) => {
    const match = !needle || f.title.toLowerCase().includes(needle) || (f.director ?? '').toLowerCase().includes(needle) || f.genres.some((g) => g.toLowerCase().includes(needle)) || String(f.year ?? '').includes(needle);
    batch.setFx(i, needle && !match ? 0.85 : 0, 0);
    if (needle && match) layout.pushed.add(f.id);
  });
  const changed = new Set<string>();
  for (const id of before) if (!layout.pushed.has(id)) changed.add(id);
  for (const id of layout.pushed) if (!before.has(id)) changed.add(id);
  const exclude = new Set<string>();
  if (picking.inspectId) exclude.add(picking.inspectId);
  layout.reseat(changed, exclude);
}

// ---- Shelves on the snap grid ------------------------------------------------
function footprint(p: ShelfPlacement): THREE.Box2 {
  const w = p.kind === 'bookcase' ? 1.8 : p.kind === 'wall' ? 1.0 : 0.9;
  const cx = p.gx + 0.5;
  const cz = p.gz + 0.5;
  const alongX = p.rot % 2 === 0;
  return new THREE.Box2(new THREE.Vector2(cx - (alongX ? w / 2 : 0.5), cz - (alongX ? 0.5 : w / 2)), new THREE.Vector2(cx + (alongX ? w / 2 : 0.5), cz + (alongX ? 0.5 : w / 2)));
}

function addShelf(kind: ShelfKind): void {
  const shelves = store.get().layout.shelves;
  const y = kind === 'wall' ? 1.45 : 0;
  // Candidate cells hugging the three walls, back wall first.
  const candidates: ShelfPlacement[] = [];
  for (let gx = -ROOM_W / 2 + 1; gx <= ROOM_W / 2 - 2; gx++) candidates.push({ id: '', kind, gx, gz: -ROOM_D / 2, rot: 0, y });
  for (let gz = -ROOM_D / 2 + 1; gz <= ROOM_D / 2 - 2; gz++) candidates.push({ id: '', kind, gx: -ROOM_W / 2, gz, rot: 1, y });
  for (let gz = -ROOM_D / 2 + 1; gz <= ROOM_D / 2 - 2; gz++) candidates.push({ id: '', kind, gx: ROOM_W / 2 - 1, gz, rot: 3, y });
  // Wall shelves stack above floor units, so only compare against other wall shelves.
  const same = (a: ShelfPlacement, b: ShelfPlacement): boolean => (a.kind === 'wall') === (b.kind === 'wall');
  const free = candidates.find((c) => {
    const fp = footprint(c);
    if (c.kind === 'wall' && c.rot === 3 && Math.abs(c.gz + 0.5 - 0.6) < 1.3) return false; // don't cover the window
    return !shelves.some((s) => same(s, c) && footprint(s).intersectsBox(fp));
  });
  if (!free) {
    toast('No free wall space for that unit');
    return;
  }
  free.id = `${kind}-${Date.now().toString(36)}`;
  const next = [...shelves, free];
  store.patchLayout({ shelves: next });
  rebuildShelves(next);
  layout.apply(layout.toRecord(), false);
  layout.fillGaps(store.get().films, store.get().layout.sortMode);
  store.setAssignments(layout.toRecord());
  toast(`Added ${kind}`);
}

function removeLastShelf(): void {
  const shelves = store.get().layout.shelves;
  if (shelves.length <= 1) return;
  const next = shelves.slice(0, -1);
  store.patchLayout({ shelves: next });
  rebuildShelves(next);
  layout.apply(layout.toRecord(), true);
  layout.fillGaps(store.get().films, store.get().layout.sortMode);
  store.setAssignments(layout.toRecord());
}

// ---- Snapshot -------------------------------------------------------------------
function snapshot(): void {
  const prevRatio = renderer.getPixelRatio();
  const size = renderer.getSize(new THREE.Vector2());
  renderer.setPixelRatio(prevRatio * 2); // 2× resolution
  renderer.setSize(size.x, size.y, false);
  renderer.render(scene, camera);
  canvas.toBlob((blob) => {
    if (blob) download(blob, `reelroom-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`);
    toast('Snapshot saved');
  }, 'image/png');
  renderer.setPixelRatio(prevRatio);
  renderer.setSize(size.x, size.y, false);
}

// ---------------------------------------------------------------------------
// Lazy poster residency: frustum + radius
// ---------------------------------------------------------------------------
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const NEAR_RADIUS = 2.5;

function requestVisiblePosters(): void {
  projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projView);
  const wanted: { film: Film; d: number }[] = [];
  const priority = new Set([picking.inspectId, store.get().hoverId].filter((x): x is string => !!x));
  batch.films.forEach((film, i) => {
    batch.getMatrix(i, _mat);
    _pos.setFromMatrixPosition(_mat);
    const d = _pos.distanceTo(camera.position);
    if (priority.has(film.id)) wanted.push({ film, d: -1 });
    else if (d < NEAR_RADIUS || (frustum.containsPoint(_pos) && d < 9)) wanted.push({ film, d });
  });
  wanted.sort((a, b) => a.d - b.d);
  // Never ask for more than the atlas can hold, so nearby cases aren't evicted by far ones.
  for (const w of wanted.slice(0, POSTER_CAPACITY - 8)) batch.posters.request(w.film);
}

// ---------------------------------------------------------------------------
// Resize + render loop
// ---------------------------------------------------------------------------
function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const FIXED_STEP = 1 / 120; // tweens advance in fixed 8.3 ms steps
let accumulator = 0;
let last = performance.now();
let frame = 0;

function loop(now: number): void {
  requestAnimationFrame(loop);
  // Delta time, clamped so a background tab doesn't fast-forward everything.
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // 1. Fixed-step simulation: tweens (case movement) run deterministically.
  accumulator += dt;
  while (accumulator >= FIXED_STEP) {
    layout.update(FIXED_STEP);
    accumulator -= FIXED_STEP;
  }

  // 2. Variable-step systems: camera, inspect-follow, orbit damping.
  cameraSys.setOrbitEnabled(!picking.isDragging);
  cameraSys.update(dt);
  picking.update();

  // 3. Streaming: every 8th frame decide which posters should be resident; upload ≤2 tiles per frame.
  if (frame++ % 8 === 0 && store.get().phase !== 'loading') requestVisiblePosters();
  batch.tick(renderer);

  // 4. Draw.
  renderer.render(scene, camera);
}
requestAnimationFrame(loop);

// ---------------------------------------------------------------------------
// Boot: restore a previous import from localStorage, otherwise the sample.
// ---------------------------------------------------------------------------
const initial = store.get();
cameraSys.setMode(initial.layout.cameraMode === 'walk' ? 'orbit' : initial.layout.cameraMode); // pointer lock needs a gesture; start in orbit
void loadCollection(initial.films.length ? initial.films : sampleFilms(), initial.films.length ? 'import' : 'sample');

// Expose a little debug handle.
declare global {
  interface Window {
    reelroom: { scene: THREE.Scene; renderer: THREE.WebGLRenderer; store: typeof store; cameraSys: CameraSystem; theme: () => RoomTheme };
  }
}
window.reelroom = { scene, renderer, store, cameraSys, theme: () => store.get().layout.theme };
