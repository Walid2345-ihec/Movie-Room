/**
 * REELROOM 3D — bootstrap.
 *
 * Owns the renderer, the scene graph roots, the systems (layout, picking,
 * camera), the UI overlay, and the single requestAnimationFrame loop.
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CameraMode, Film, RoomTheme, SortMode, StorePlan } from './types';
import { Room, planStore, GONDOLA_D, AISLE_W, BAY_W } from './scene/room';
import { CaseBatch, POSTER_CAPACITY } from './scene/case';
import { LayoutSystem } from './systems/layout';
import { PickingSystem } from './systems/picking';
import { CameraSystem } from './systems/camera';
import { store, parseLayoutJson, DEFAULT_THEME, defaultLayout } from './state/store';
import { clearCache, enrichFilms } from './data/tmdb';
import { importLetterboxdFile } from './data/letterboxd';
import { sampleFilms } from './data/sample';
import { ImportScreen } from './ui/importScreen';
import { Toolbar } from './ui/toolbar';
import { DetailPanel } from './ui/detail';
import { StatsStrip } from './ui/stats';
import { download, el, pickFile, toast, stars } from './ui/dom';

// ---------------------------------------------------------------------------
// Renderer & scene
// ---------------------------------------------------------------------------
const canvas = document.getElementById('scene') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.92;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf1f0ec);
scene.fog = new THREE.Fog(0xf1f0ec, 18, 40); // barely there; keeps the far wall from popping

// Image-based lighting so glossy cases and the tile floor pick up reflections.
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
pmrem.dispose();

const room = new Room(store.get().layout.theme);
scene.add(room.group);

const cameraSys = new CameraSystem(
  canvas,
  () => room.colliders,
  () => room.bounds,
);
const camera = cameraSys.camera;

const MAX_ANISOTROPY = renderer.capabilities.getMaxAnisotropy();
let batch = new CaseBatch([], MAX_ANISOTROPY);
scene.add(batch.mesh, batch.hitProxy);
const layout = new LayoutSystem(room, batch);
const filmsById = new Map<string, Film>();

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
uiRoot.append(el('div', { class: 'vignette' }));
const crosshair = el('div', { class: 'crosshair hidden' });
uiRoot.append(crosshair);

const detail = new DetailPanel(uiRoot, () => picking.deselect());
const stats = new StatsStrip(uiRoot);

const picking = new PickingSystem(canvas, camera, room, batch, layout, {
  pointerNdc: () => cameraSys.pointerNdc(),
  onSelect: (id) => {
    const film = id ? filmsById.get(id) : undefined;
    if (film) void detail.show(film);
    else detail.hide();
  },
  onRearranged: () => {
    store.setAssignments(layout.toRecord());
    store.setPinned(layout.pinned);
    refreshDressing();
  },
});

const toolbar = new Toolbar(uiRoot, {
  onSort: (mode) => arrange(mode),
  onResortAll: () => {
    layout.pinned.clear();
    store.setPinned([]);
    arrange(store.get().layout.sortMode);
    toast('Manual placements cleared');
  },
  onSearch: (q) => applySearch(q),
  onCameraMode: (m) => cameraSys.setMode(m),
  onTheme: (t) => {
    store.setTheme(t);
    room.setTheme(store.get().layout.theme);
  },
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
      rebuildStore(layoutData.plan);
      layout.pinned.clear();
      for (const id of layoutData.pinned) layout.pinned.add(id);
      layout.apply(layoutData.assignments, true);
      layout.fillGaps(store.get().films, layoutData.sortMode);
      store.setAssignments(layout.toRecord());
      room.setTheme(layoutData.theme);
      cameraSys.setMode(layoutData.cameraMode);
      refreshDressing();
      toast('Layout imported');
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`);
    }
  },
  onResetLayout: () => {
    store.resetLayout();
    const l = store.get().layout;
    rebuildStore(l.plan);
    room.setTheme(l.theme);
    layout.pinned.clear();
    arrange(l.sortMode);
    toast('Layout reset');
  },
  onResetAll: () => void resetEverything(),
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
/** Bumped by resetEverything() so an import that was in flight during a reset is abandoned. */
let loadGeneration = 0;

async function loadCollection(films: Film[], source: 'sample' | 'import'): Promise<void> {
  const gen = ++loadGeneration;
  store.setPhase('loading');
  store.setProgress({ done: 0, total: films.length, label: 'Looking up metadata…' });
  await enrichFilms(films, (p) => {
    if (gen === loadGeneration) store.setProgress(p);
  });
  if (gen !== loadGeneration) return; // reset happened meanwhile

  // Dispose the previous batch (geometry, materials, atlases) before building anew.
  batch.dispose();
  batch = new CaseBatch(films, MAX_ANISOTROPY);
  scene.add(batch.mesh, batch.hitProxy);
  layout.setBatch(batch);
  picking.setBatch(batch);
  store.setFilms(films, source);
  filmsById.clear();
  for (const f of films) filmsById.set(f.id, f);
  stats.update(films);

  // The store grows with the collection: re-plan when the saved plan can't hold it.
  let plan = store.get().layout.plan;
  const capacity = plan.units.reduce((s, u) => s + (u.kind === 'gondola' ? 2 : 1) * u.bays, 0);
  if (!plan.units.length || capacity * 56 < films.length) {
    plan = planStore(films.length);
    store.setPlan(plan);
  }
  rebuildStore(plan);

  layout.pinned.clear();
  const saved = store.get().layout.assignments;
  const known = Object.keys(saved).filter((id) => batch.indexOf.has(id)).length;
  if (known > films.length * 0.5) {
    for (const id of store.get().layout.pinned) if (batch.indexOf.has(id)) layout.pinned.add(id);
    layout.apply(saved, false);
    layout.fillGaps(films, store.get().layout.sortMode);
  } else {
    layout.apply(layout.arrange(films, store.get().layout.sortMode), false);
  }
  store.setAssignments(layout.toRecord());
  store.setPinned(layout.pinned);
  applySearch(store.get().search);
  refreshDressing();
  placeCameraAtEntrance();
  store.setPhase('room');
  if (layout.capacity < films.length) toast(`${films.length - layout.capacity} films don't fit on the shelves`, 4000);
}

/**
 * Destructive reset: wipes localStorage + IndexedDB caches, drops the film
 * array, disposes every case GPU resource, restores camera/store defaults and
 * returns to the Import screen.
 */
async function resetEverything(): Promise<void> {
  if (!window.confirm('This deletes your imported collection and room layout. Continue?')) return;
  loadGeneration++;
  picking.deselect();
  detail.hide();
  await clearCache();
  store.clearAll();
  batch.dispose();
  batch = new CaseBatch([], MAX_ANISOTROPY);
  scene.add(batch.mesh, batch.hitProxy);
  layout.setBatch(batch);
  picking.setBatch(batch);
  layout.pushed.clear();
  layout.pinned.clear();
  filmsById.clear();
  rebuildStore(defaultLayout(0).plan);
  room.setTheme(DEFAULT_THEME);
  cameraSys.setMode('orbit');
  placeCameraAtEntrance();
  stats.update([]);
  toast('Everything reset');
}

function rebuildStore(plan: StorePlan): void {
  room.build(plan);
  layout.refreshSlots();
  picking.refreshColliders();
  const b = room.bounds;
  // Home: standing at the mouth of the first aisle, eye height, looking down it.
  const g = plan.units.find((u) => u.kind === 'gondola');
  const aisleX = g ? g.x - (GONDOLA_D + AISLE_W) / 2 : 0;
  const aisleMouthZ = g ? g.z + (g.bays * BAY_W) / 2 + 0.6 : b.maxZ - 1;
  cameraSys.home.pos.set(aisleX, 1.6, aisleMouthZ);
  cameraSys.home.target.set(aisleX, 1.2, b.minZ + 0.5);
}

function placeCameraAtEntrance(): void {
  cameraSys.resetView();
}

function arrange(mode: SortMode): void {
  store.setSortMode(mode);
  layout.apply(layout.arrange(store.get().films, mode), true);
  store.setAssignments(layout.toRecord());
  refreshDressing();
}

/** Category headers + shelf-edge tickets follow whatever is actually shelved. */
function refreshDressing(): void {
  const cats = layout.unitCategories(filmsById);
  for (const [id, unit] of room.shelves) {
    if (unit.placement.kind === 'gondola') unit.setHeader(cats.get(id) ?? cats.get(`endcap-${id.split('-')[1]}`) ?? 'FILMS');
    unit.drawTickets((slotId) => {
      const filmId = layout.slotById.get(slotId)?.occupant;
      const f = filmId ? filmsById.get(filmId) : undefined;
      if (!f) return null;
      return f.rating !== null ? stars(f.rating) : String(f.releaseYear ?? f.year ?? '');
    });
  }
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
  if (picking.selectedId) exclude.add(picking.selectedId);
  layout.reseat(changed, exclude);
}

// ---- Snapshot -------------------------------------------------------------------
function snapshot(): void {
  const prevRatio = renderer.getPixelRatio();
  const size = renderer.getSize(new THREE.Vector2());
  renderer.setPixelRatio(prevRatio * 2);
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
// Hi-res poster residency: cases within a few metres and on screen
// ---------------------------------------------------------------------------
const frustum = new THREE.Frustum();
const projView = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _mat = new THREE.Matrix4();

function requestVisiblePosters(): void {
  projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projView);
  const wanted: { film: Film; d: number }[] = [];
  const priority = new Set([picking.selectedId, store.get().hoverId].filter((x): x is string => !!x));
  const lod = batch.lodDistance;
  batch.films.forEach((film, i) => {
    batch.getMatrix(i, _mat);
    _pos.setFromMatrixPosition(_mat);
    const d = _pos.distanceTo(camera.position);
    if (priority.has(film.id)) wanted.push({ film, d: -1 });
    else if (d < lod && frustum.containsPoint(_pos)) wanted.push({ film, d });
  });
  wanted.sort((a, b) => a.d - b.d);
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

const FIXED_STEP = 1 / 120;
let accumulator = 0;
let last = performance.now();
let frame = 0;
/** Rolling frame-time stats (ms) for the perf report. */
const perf = { frameMs: 0, renderMs: 0, samples: 0, avgFrameMs: 0, avgRenderMs: 0, maxFrameMs: 0, quality: 'high' as 'high' | 'low' };

/**
 * Adaptive quality for integrated GPUs: if the rolling average frame time
 * stays over budget, drop the pixel ratio to 1 and switch off shadow maps.
 */
let slowFrames = 0;
function adaptQuality(): void {
  if (perf.quality !== 'high' || perf.samples < 180) return;
  slowFrames = perf.frameMs > 15 ? slowFrames + 1 : Math.max(0, slowFrames - 2);
  if (slowFrames > 90) {
    perf.quality = 'low';
    renderer.setPixelRatio(1);
    resize();
    renderer.shadowMap.enabled = false;
    scene.traverse((o) => {
      if (o instanceof THREE.Mesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.needsUpdate = true));
    });
    console.info('[perf] frame time over budget — reduced pixel ratio and disabled shadows');
  }
}

function loop(now: number): void {
  requestAnimationFrame(loop);
  const t0 = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // 1. Fixed-step simulation: tweens (case movement).
  accumulator += dt;
  while (accumulator >= FIXED_STEP) {
    layout.update(FIXED_STEP);
    accumulator -= FIXED_STEP;
  }

  // 2. Variable-step systems: camera, selection outline.
  cameraSys.setOrbitEnabled(!picking.isDragging);
  cameraSys.update(dt);
  picking.update();

  // 3. Streaming + compaction: decide hi-res residency every 8th frame; compact visible instances every frame.
  camera.updateMatrixWorld();
  if (frame++ % 8 === 0 && store.get().phase !== 'loading') requestVisiblePosters();
  batch.tick(renderer, camera);

  // 4. Draw.
  const t1 = performance.now();
  renderer.render(scene, camera);
  const t2 = performance.now();
  perf.frameMs = t2 - t0;
  perf.renderMs = t2 - t1;
  perf.samples++;
  perf.avgFrameMs += (perf.frameMs - perf.avgFrameMs) / Math.min(perf.samples, 120);
  perf.avgRenderMs += (perf.renderMs - perf.avgRenderMs) / Math.min(perf.samples, 120);
  perf.maxFrameMs = Math.max(perf.maxFrameMs * 0.98, perf.frameMs);
  adaptQuality();
}
requestAnimationFrame(loop);

// ---------------------------------------------------------------------------
// Boot: restore a previous import from localStorage, otherwise the sample.
// ---------------------------------------------------------------------------
const initial = store.get();
cameraSys.setMode('orbit'); // pointer lock needs a gesture; walk mode is one Tab away
void loadCollection(initial.films.length ? initial.films : sampleFilms(), initial.films.length ? 'import' : 'sample');

declare global {
  interface Window {
    reelroom: {
      scene: THREE.Scene;
      renderer: THREE.WebGLRenderer;
      store: typeof store;
      cameraSys: CameraSystem;
      room: Room;
      layout: LayoutSystem;
      picking: PickingSystem;
      batch: () => CaseBatch;
      perf: typeof perf;
      theme: () => RoomTheme;
    };
  }
}
window.reelroom = { scene, renderer, store, cameraSys, room, layout, picking, batch: () => batch, perf, theme: () => store.get().layout.theme };
