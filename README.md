# REELROOM 3D

Turn your Letterboxd film collection into physical DVD cases shelved face-front in a 3D media store — double-sided gondola aisles, wall runs, end-caps, shelf-edge tickets and category headers — that you can walk through, pick up and rearrange. Built with Three.js, TypeScript and Vite. Everything runs in the browser — your export never leaves your machine.

![stack](https://img.shields.io/badge/three.js-r170-black) ![ts](https://img.shields.io/badge/TypeScript-strict-blue) ![vite](https://img.shields.io/badge/Vite-5-purple)

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:5173>. The store boots with a bundled 24-film sample collection so there's something on the shelves before you import anything. The store is planned from the collection size (`planStore()` in `src/scene/room.ts`): enough gondola runs and wall bays to hold every film plus ~15 % empty slots, each 1 m bay holding 7 face-front cases per row × 8 rows.

Other scripts: `npm run build` (typecheck + production bundle → `dist/`), `npm run preview`, `npm run typecheck`.

## Posters & metadata — no key needed

Out of the box, every film is looked up on **Wikipedia / Wikidata** (`src/data/wikipedia.ts`): the article's infobox poster becomes the case front, and Wikidata supplies director, runtime, genres and release year. No account, no API key. Posters are Wikipedia's fair-use resolution (~250 px wide), which is about the resolution of a case front anyway. A film that has no article at all gets a procedural cover (and is logged as `[Wikipedia] no match …`).

## TMDB key (optional upgrade)

If you add a TMDB key, it is tried first (higher-resolution `w500` posters) and Wikipedia is the fallback.

1. Create a free account at <https://www.themoviedb.org/> and request an API key under **Settings → API** (choose "Developer"). Use the *API Key (v3 auth)*.
2. Copy `.env.example` to `.env` and paste it in:

   ```
   VITE_TMDB_API_KEY=your_v3_key_here
   ```

3. Restart `npm run dev` (Vite reads `.env` at startup).

Lookups are batched (8 per batch, 3 in flight) and rate-limited with `429` back-off; each film's TMDB/Wikidata id, director, runtime, genres, release year and the `w500` poster blob are cached in IndexedDB keyed by film id, so a reload never re-hits the API and works offline. Titles TMDB can't match are logged as `[TMDB] no match for …` in the console and get a procedural cover; a rejected key logs one `401` error and stops the batch (nothing is cached in that case). Posters are fetched with CORS (`crossOrigin="anonymous"`) so they can be uploaded as WebGL textures and colour-sampled for the rainbow sort.

## Exporting from Letterboxd

1. Sign in to Letterboxd → **Settings → Data → Export your data**.
2. You get `letterboxd-<username>-<date>.zip` containing `watched.csv`, `ratings.csv`, `watchlist.csv`, `diary.csv` and more.
3. In REELROOM click **Import collection** and drop the ZIP on the drop zone (or a single CSV such as `diary.csv`).

The importer merges all four files: `diary.csv` supplies watch dates, rewatch counts and ratings; `ratings.csv` fills in ratings; `watched.csv` supplies the rest; `watchlist.csv` entries are shelved too but flagged as unwatched.

## Controls

| Action | Input |
| --- | --- |
| Orbit / zoom / pan | Left drag / wheel / right drag |
| Toggle first-person walk | `Tab` (WASD to move, mouse to look, `Shift` to run, `Esc` releases the mouse) |
| Select a case | Click it — it lifts toward you with an outline and the detail panel opens; click empty space or `Esc` to deselect |
| Rearrange | Drag a case; a blue ghost marks the target slot and the row's neighbours slide apart to preview the insertion; orange means the occupant will swap; right-click / `Esc` cancels. Hand-placed cases are **pinned**: auto-arrange leaves them alone until **Re-sort everything** |
| Arrange | Toolbar: Genre, Rating, Year, Director, Runtime, Rainbow (dominant poster hue), Title — gondola header signs follow the dominant category of what's shelved there |
| Search | Type in the search box; non-matches dim, matches slide forward |
| Store | Wall / shelving-steel / floor-tile colour pickers |
| Persistence | Layout auto-saves to `localStorage`; Export/Import layout as JSON; **Reset layout** (furniture + colours only) or **Reset** (wipes collection, layout, and the IndexedDB poster/metadata cache — asks first) |
| Snapshot | Renders the current view to a 2× PNG download |

## Project layout

```
index.html
package.json · tsconfig.json · vite.config.ts · .env.example
src/
  main.ts              bootstrap, renderer, resize, single RAF loop (fixed-step tweens + variable-step camera)
  types.ts             shared Film / RoomLayout / Slot types used end-to-end
  scene/room.ts        procedural store plan, gondola/wall/end-cap units built from real retail dimensions, face-front slot math, ceiling grid, tile floor, signage, shelf-edge tickets, props
  scene/case.ts        instanced CaseMesh (real 135×190×14 mm, bevel + lip) + hit proxy, spine atlas, hi-res LRU atlas + low-res LOD atlas, per-frame frustum compaction
  data/letterboxd.ts   ZIP/CSV parsing & normalisation (client-side)
  data/tmdb.ts         enrichment pipeline: provider dispatch, rate limiting, IndexedDB cache, procedural fallback, hue sampling
  data/wikipedia.ts    keyless provider: Wikipedia search + page image, Wikidata claims (director/runtime/genres/year)
  data/sample.ts       bundled 24-film sample
  systems/tween.ts     fixed-step tween scheduler
  systems/layout.ts    sort strategies, pinned placements, slot assignment, staggered move tweens, search push, row nudges
  systems/picking.ts   raycaster hover, click-to-select (outline), drag → row-collider → slot snapping, insertion preview, swap
  systems/camera.ts    orbit (constrained) & first-person walk (pointer lock, AABB collision)
  state/store.ts       typed app state, pub/sub, localStorage persistence
  ui/                  import screen, toolbar, detail panel, stats strip, styles
```

## How the rendering scales

- **One `InstancedMesh` for every case**, a bevelled real-size DVD keep-case with four material groups (front poster / blurred back / spine / dark plastic). An invisible twin `InstancedMesh` at each case's *rest* pose is what the picker raycasts, so hover/select animations never change what the pointer hits.
- **Per-instance frustum compaction.** Every frame the visible instances are packed to the front of the render buffers and `mesh.count` is set; off-screen cases cost nothing.
- **Two poster atlases.** A 4096² hi-res LRU atlas holds 176 posters for cases within 4 m (tiles stream in via `texSubImage2D`, ≤2 per frame); a 2048² low-res atlas holds every poster (up to 704) and is what distant cases sample — the shader picks the atlas per instance by LOD, so nothing falls back to a flat tint once loaded.
- **Slot snapping without per-slot colliders.** Each bay-row has one invisible collider; a drag raycast hits it, converts to row-local space and quantises `x` to the slot pitch.
- **Adaptive quality.** If the rolling frame time stays over 15 ms, the pixel ratio drops to 1 and shadow maps switch off.

Measured with a 600-film collection, camera at eye height walking an aisle, 1600×900 drawing buffer (1280×720 @ 1.25 dpr): **≈3.1 ms GPU time per frame (p50 2.9 ms, p95 7.5 ms) on an RTX 3050 Laptop GPU** via `EXT_disjoint_timer_query_webgl2`; 36 draw calls, ~110 k triangles, 346 of 600 cases visible after culling. Cases alone are ~0.5 ms; the rest is the envelope's fill rate.

## Notes

- The app persists an imported collection in `localStorage` so it survives reloads; posters and metadata live in IndexedDB. Use **Import collection → Use sample collection** to go back to the sample.
- Walk mode needs pointer lock, which browsers only grant after a click on the page.
