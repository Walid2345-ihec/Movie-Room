/**
 * Import / loading screen. Shown for phases 'import' and 'loading'.
 * Files never leave the browser: parsing happens in letterboxd.ts.
 */
import { store } from '../state/store';
import { hasTmdbKey } from '../data/tmdb';
import { button, el } from './dom';

export interface ImportScreenHandlers {
  onFile: (file: File) => void;
  onUseSample: () => void;
  onContinue: () => void;
}

export class ImportScreen {
  readonly root: HTMLDivElement;
  private readonly bar: HTMLDivElement;
  private readonly label: HTMLDivElement;
  private readonly importBox: HTMLDivElement;
  private readonly loadingBox: HTMLDivElement;

  constructor(parent: HTMLElement, h: ImportScreenHandlers) {
    const drop = el('div', { class: 'drop' }, el('b', { text: 'Drop your Letterboxd export here' }), el('small', { text: 'letterboxd-username-…zip, or a single watched.csv / diary.csv' }));
    drop.addEventListener('click', () => {
      const input = el('input', { type: 'file', accept: '.zip,.csv' });
      input.addEventListener('change', () => {
        const f = input.files?.[0];
        if (f) h.onFile(f);
      });
      input.click();
    });
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      const f = e.dataTransfer?.files?.[0];
      if (f) h.onFile(f);
    });

    const keyNote = hasTmdbKey()
      ? 'TMDB key detected — posters, directors and genres will be fetched and cached offline.'
      : 'No TMDB key set: covers will be generated procedurally. Add VITE_TMDB_API_KEY to .env for real posters.';

    this.importBox = el(
      'div',
      {},
      el('p', { text: 'Turn your film collection into cases you can pick up, arrange and shelve. Everything is parsed locally in your browser.' }),
      drop,
      el('div', { class: 'actions' }, button('Use sample collection', h.onUseSample, 'primary'), button('Back to room', h.onContinue)),
      el('div', { class: 'note' }, keyNote),
    );

    this.bar = el('div');
    this.label = el('div', { class: 'label' });
    this.loadingBox = el('div', { class: 'hidden' }, el('p', { text: 'Building your room…' }), el('div', { class: 'progress' }, this.bar), this.label);

    this.root = el('div', { class: 'screen' }, el('div', { class: 'card' }, el('h1', { text: 'REELROOM 3D' }), this.importBox, this.loadingBox));
    parent.append(this.root);

    store.subscribe((s, changed) => {
      if (changed.has('phase')) this.setPhase(s.phase);
      if (changed.has('progress')) {
        const p = s.progress;
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        this.bar.style.width = `${pct}%`;
        this.label.textContent = p.total ? `${p.label} (${p.done}/${p.total})` : p.label;
      }
      if (changed.has('films') || changed.has('phase')) {
        const backBtn = this.importBox.querySelector<HTMLButtonElement>('.actions button:last-child');
        if (backBtn) backBtn.classList.toggle('hidden', s.films.length === 0);
      }
    });
    this.setPhase(store.get().phase);
  }

  private setPhase(phase: string): void {
    const show = phase === 'import' || phase === 'loading';
    this.root.classList.toggle('hidden', !show);
    this.importBox.classList.toggle('hidden', phase !== 'import');
    this.loadingBox.classList.toggle('hidden', phase !== 'loading');
  }
}
