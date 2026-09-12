/** Top toolbar: arrange, search, camera mode, room colours, shelves, persistence, snapshot. */
import type { CameraMode, RoomTheme, SortMode } from '../types';
import { SORT_LABELS } from '../systems/layout';
import { store } from '../state/store';
import { button, el } from './dom';

export interface ToolbarHandlers {
  onSort: (mode: SortMode) => void;
  onSearch: (q: string) => void;
  onCameraMode: (m: CameraMode) => void;
  onTheme: (t: Partial<RoomTheme>) => void;
  /** Clear every manual placement and re-run the current sort. */
  onResortAll: () => void;
  onSnapshot: () => void;
  onExportLayout: () => void;
  onImportLayout: () => void;
  onResetLayout: () => void;
  onResetAll: () => void;
  onImportCollection: () => void;
}

export class Toolbar {
  readonly root: HTMLDivElement;
  private readonly sortButtons = new Map<SortMode, HTMLButtonElement>();
  private readonly camButtons: Record<CameraMode, HTMLButtonElement>;
  private readonly hint: HTMLSpanElement;

  constructor(parent: HTMLElement, h: ToolbarHandlers) {
    const sortGroup = el('div', { class: 'group' }, el('label', { text: 'Arrange' }));
    for (const mode of Object.keys(SORT_LABELS) as SortMode[]) {
      const b = button(SORT_LABELS[mode], () => h.onSort(mode));
      this.sortButtons.set(mode, b);
      sortGroup.append(b);
    }
    const resort = button('Re-sort everything', h.onResortAll);
    resort.title = 'Forget manual placements and lay every case out by the current sort';
    sortGroup.append(resort);

    const search = el('input', { type: 'search', placeholder: 'Search title / director / genre…' });
    search.addEventListener('input', () => h.onSearch(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        search.value = '';
        h.onSearch('');
        search.blur();
      }
      e.stopPropagation();
    });

    this.camButtons = {
      orbit: button('Orbit', () => h.onCameraMode('orbit')),
      walk: button('Walk', () => h.onCameraMode('walk')),
    };

    const theme = store.get().layout.theme;
    const colorInputs: [keyof RoomTheme, HTMLInputElement][] = [];
    const color = (key: keyof RoomTheme, title: string): HTMLInputElement => {
      const i = el('input', { type: 'color', value: theme[key], title });
      i.addEventListener('input', () => h.onTheme({ [key]: i.value }));
      colorInputs.push([key, i]);
      return i;
    };
    const colors = el('div', { class: 'group' }, el('label', { text: 'Store' }), color('wall', 'Wall colour'), color('wood', 'Shelving steel colour'), color('floor', 'Floor tile colour'));

    this.hint = el('span', { class: 'hint' });

    this.root = el(
      'div',
      { class: 'toolbar' },
      el('span', { class: 'brand', text: 'REELROOM 3D' }),
      sortGroup,
      el('div', { class: 'group' }, search),
      el('div', { class: 'group' }, el('label', { text: 'Camera' }), this.camButtons.orbit, this.camButtons.walk),
      colors,
      el('div', { class: 'spacer' }),
      this.hint,
      el('div', { class: 'group' }, button('📷 Snapshot', h.onSnapshot), button('Export layout', h.onExportLayout), button('Import layout', h.onImportLayout), button('Reset layout', h.onResetLayout), button('Reset', h.onResetAll, 'danger')),
      el('div', { class: 'group' }, button('Import collection', h.onImportCollection, 'primary')),
    );
    parent.append(this.root);

    store.subscribe((s, changed) => {
      if (changed.has('layout')) {
        this.setSort(s.layout.sortMode);
        this.setCamera(s.layout.cameraMode);
        for (const [k, i] of colorInputs) if (i.value !== s.layout.theme[k]) i.value = s.layout.theme[k];
      }
      if (changed.has('phase')) this.root.classList.toggle('hidden', s.phase === 'import' || s.phase === 'loading');
    });
    this.setSort(store.get().layout.sortMode);
    this.setCamera(store.get().layout.cameraMode);
  }

  setSort(mode: SortMode): void {
    for (const [m, b] of this.sortButtons) b.classList.toggle('active', m === mode);
  }
  setCamera(mode: CameraMode): void {
    this.camButtons.orbit.classList.toggle('active', mode === 'orbit');
    this.camButtons.walk.classList.toggle('active', mode === 'walk');
    this.hint.innerHTML =
      mode === 'walk'
        ? '<kbd>WASD</kbd> move · mouse look · <kbd>Tab</kbd> orbit · <kbd>Esc</kbd> release mouse'
        : 'drag to orbit · click a case to select · drag it to another slot · <kbd>Tab</kbd> walk';
  }
}
