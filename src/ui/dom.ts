/** Tiny DOM helpers so UI modules stay dependency-free. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Partial<Record<string, string>> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', { class: cls, text: label });
  b.addEventListener('click', onClick);
  return b;
}

let toastEl: HTMLDivElement | null = null;
let toastTimer = 0;
export function toast(msg: string, ms = 2200): void {
  if (!toastEl) {
    toastEl = el('div', { class: 'toast' });
    document.getElementById('ui-root')?.append(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove('show'), ms);
}

export function stars(rating: number | null): string {
  if (rating === null) return '—';
  const full = Math.floor(rating);
  return '★'.repeat(full) + (rating - full >= 0.5 ? '½' : '');
}

/** Trigger a browser download for a Blob. */
export function download(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Open a file picker and resolve with the chosen file (or null). */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.click();
  });
}
