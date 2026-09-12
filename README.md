# REELROOM 3D

Turn your Letterboxd film collection into physical Blu-ray cases you can pick up, arrange and shelve inside a cosy, customisable 3D room. Built with Three.js, TypeScript and Vite. Everything runs in the browser — your export never leaves your machine.

![stack](https://img.shields.io/badge/three.js-r170-black) ![ts](https://img.shields.io/badge/TypeScript-strict-blue) ![vite](https://img.shields.io/badge/Vite-5-purple)

## Quick start

```bash
npm install
```

```bash
npm run dev
```

Open <http://localhost:5173>. The room boots with a bundled 24-film sample collection so there's something on the shelves before you import anything.

Other scripts: `npm run build` (typecheck + production bundle → `dist/`), `npm run preview`, `npm run typecheck`.

## TMDB key (optional)

Without a key the app generates a **procedural cover** for every film (deterministic palette hashed from the title, big typographic title, year and star rating). With a key it fetches real posters, runtime, genres and director.

1. Create a free account at <https://www.themoviedb.org/> and request an API key under **Settings → API** (choose "Developer"). Use the *API Key (v3 auth)*.
2. Copy `.env.example` to `.env` and paste it in:

   ```
   VITE_TMDB_API_KEY=your_v3_key_here
   ```

3. Restart `npm run dev` (Vite reads `.env` at startup).

Lookups are batched and rate-limited; results and poster blobs are cached in IndexedDB, so the second launch is instant and works offline. Posters are fetched with CORS (`crossOrigin="anonymous"`) so they can be uploaded as WebGL textures and colour-sampled for the rainbow sort.

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
| Inspect a case | Click it — it lifts to the camera and opens the detail panel; click anywhere or `Esc` to put it back |
| Re-shelve a case | Drag it; a blue ghost shows the target slot, orange means the occupant will swap; right-click / `Esc` cancels |
| Arrange | Toolbar: Rating, Year, Director, Genre, Runtime, Rainbow (dominant poster hue), Title |
| Search | Type in the search box; non-matches dim, matches slide forward |
| Room | Wall / wood / floor colour pickers; add or remove shelving units (bookcase, wall shelf, display stand) |
| Persistence | Layout auto-saves to `localStorage`; Export/Import layout as JSON; Reset room |
| Snapshot | Renders the current view to a 2× PNG download |

## Project layout

```
index.html
package.json · tsconfig.json · vite.config.ts · .env.example
src/
  main.ts              bootstrap, renderer, resize, single RAF loop (fixed-step tweens + variable-step camera)
  types.ts             shared Film / RoomLayout / Slot types used end-to-end
  scene/room.ts        room geometry, lighting, window, shelving units + slot generation on a snap grid
  scene/case.ts        instanced CaseMesh (3 materials), spine canvas atlas, LRU poster atlas, display states
  data/letterboxd.ts   ZIP/CSV parsing & normalisation (client-side)
  data/tmdb.ts         TMDB lookups, rate limiting, IndexedDB cache, procedural cover fallback, hue sampling
  data/sample.ts       bundled 24-film sample
  systems/tween.ts     fixed-step tween scheduler
  systems/layout.ts    sort strategies, slot assignment, staggered move tweens, search push
  systems/picking.ts   raycaster hover, click-to-inspect, drag → row-collider → slot snapping, swap
  systems/camera.ts    orbit (constrained) & first-person walk (pointer lock, AABB collision)
  state/store.ts       typed app state, pub/sub, localStorage persistence
  ui/                  import screen, toolbar, detail panel, stats strip, styles
```

## How the rendering scales

- **One `InstancedMesh` for every case.** The box geometry is regrouped into three material slots (front / spine / everything else), so a 1 000-film collection is three draw calls.
- **Spine atlas.** Each spine (title + year rotated 90°) is drawn once into a canvas atlas at import and uploaded once.
- **Poster atlas as an LRU cache.** A single 4096² texture holds 160 resident posters. Every few frames the loop asks for posters of cases inside the frustum or within 2.5 m, uploads at most two tiles per frame with `texSubImage2D`, and evicts the least-recently-seen tiles. Cases without a resident poster fall back to a per-film tint colour, so nothing pops black.
- **Per-instance attributes** carry atlas rects, tint and fx (dim / glow) so search, hover and inspect never touch materials.
- **Slot snapping without per-slot colliders.** Each shelf row has one invisible collider; a drag raycast hits it, converts the point to row-local space and quantises `x` to the slot pitch.

## Notes

- The app persists an imported collection in `localStorage` so it survives reloads; posters and metadata live in IndexedDB. Use **Import collection → Use sample collection** to go back to the sample.
- Walk mode needs pointer lock, which browsers only grant after a click on the page.
