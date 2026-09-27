// The deck's materials: a tile per file the person added, with its kind,
// size and -- once the extract step has read it -- how many pages came out.
// Files are added by dropping them on the window or from a picker, and
// removed from the tile. What the agent will be given is exactly what is
// here; nothing is hidden in a folder the person cannot see.
//
// Sorted into shelves by kind, so the lecture, its transcript and its
// objectives read as what they are. Everything the person adds lands at the
// top of the deck's folder (a dropped folder brings its files one level up),
// so a file in a subfolder was made during the steps -- the agent converting
// an .rtf to text, say. Those are material too, and the agent is given them,
// but they sit on their own shelf, folded, apart from what was brought.

import type { CourseFile, Extracted } from '../engine/client.js';
import { mountNotice } from './notice.js';

export interface MaterialsOptions {
  onAdd(): void;
  onRemove(relPath: string): void;
}

export interface Materials {
  set(files: CourseFile[], extracted: Extracted[]): void;
  /** A line above the files -- one removed, with the way back. */
  notify(text: string, action?: { label: string; run(): void }): void;
  /** Takes the line away: another deck is opening, and its Undo belongs to this one. */
  hideNotice(): void;
  count(): number;
  /** A deck's lecture files, or a class's own papers: only the words change. */
  setKind(kind: 'deck' | 'class'): void;
  /** A class's papers its brief has not read yet, marked on their tiles. */
  markNew(relPaths: string[]): void;
}

const KIND: Record<CourseFile['kind'], string> = { pdf: 'PDF', image: 'image', audio: 'audio', video: 'video', text: 'text', slides: 'slides', doc: 'document', other: 'file' };

/** The shelves, in the order they are shown; a kind not named here has none. */
const SHELVES: { label: string; kinds: CourseFile['kind'][] }[] = [
  { label: 'PDFs', kinds: ['pdf'] },
  { label: 'Slides', kinds: ['slides'] },
  { label: 'Documents', kinds: ['doc'] },
  { label: 'Transcripts & notes', kinds: ['text'] },
  { label: 'Images', kinds: ['image'] },
  { label: 'Audio & video', kinds: ['audio', 'video'] },
  { label: 'Other', kinds: ['other'] },
];
const MADE = 'Made along the way';

const byName = (a: CourseFile, b: CourseFile) => a.relPath.localeCompare(b.relPath, undefined, { numeric: true, sensitivity: 'base' });

/** The files on their shelves: what was brought by kind, then what the steps made. Empty shelves are left out. */
export function shelve(files: CourseFile[]): { label: string; files: CourseFile[] }[] {
  const brought = files.filter((f) => !f.relPath.includes('/'));
  const made = files.filter((f) => f.relPath.includes('/')).sort(byName);
  const out = SHELVES.map((s) => ({ label: s.label, files: brought.filter((f) => s.kinds.includes(f.kind)).sort(byName) })).filter((s) => s.files.length);
  if (made.length) out.push({ label: MADE, files: made });
  return out;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** What a file's tile says under its name. */
export function describe(f: CourseFile, e: Extracted | undefined): string {
  const parts = [size(f.bytes)];
  if (e?.text) parts.push(e.images.length ? `${e.images.length} page${e.images.length === 1 ? '' : 's'} read` : 'text read');
  else if (f.kind === 'slides') parts.push('export to PDF for the agent to read it');
  else if (f.kind === 'doc') parts.push('the agent reads this as it can');
  return parts.join(' · ');
}

export function mountMaterials(host: HTMLElement, opts: MaterialsOptions): Materials {
  host.innerHTML = `
    <header class="mhead"><h3><span id="m-title">Materials</span> <small id="m-count"></small></h3><span class="grow"></span><button type="button" id="m-add" class="quiet">Add files…</button></header>
    <p class="mnote" id="m-note" hidden>Optional — the syllabus, notes, a study guide. The agent turns them into a short brief every deck in this class reads: exam dates, what is off the exam.</p>
    <div id="m-notice"></div>
    <div class="tiles" id="m-tiles"></div>`;
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
  const tiles = $<HTMLElement>('#m-tiles');
  const notice = mountNotice($<HTMLElement>('#m-notice'));
  let files: CourseFile[] = [];
  let shownMade = false;
  let kind: 'deck' | 'class' = 'deck';
  let fresh = new Set<string>();

  $<HTMLButtonElement>('#m-add').addEventListener('click', () => opts.onAdd());
  tiles.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const remove = t.closest<HTMLButtonElement>('button[data-remove]');
    if (remove) return opts.onRemove(remove.dataset.remove!);
    if (t.closest('[data-made]')) {
      shownMade = !shownMade;
      return render(lastExtracted);
    }
    if (t.closest('.tile.add')) opts.onAdd();
  });
  tiles.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && (e.target as HTMLElement).closest('.tile.add')) {
      e.preventDefault();
      opts.onAdd();
    }
  });
  let lastExtracted: Extracted[] = [];

  const tile = (f: CourseFile, extracted: Extracted[]): string => {
    const e = extracted.find((x) => x.source === f.relPath);
    const name = f.relPath.includes('/') ? f.relPath : f.name;
    const isNew = fresh.has(f.relPath);
    return `<div class="tile kind-${f.kind}${isNew ? ' fresh' : ''}" title="${esc(f.relPath)}${isNew ? ' — not in the class brief yet' : ''}"><div class="tkind">${KIND[f.kind]}</div><div class="tname">${esc(name)}</div><div class="tmeta">${esc(describe(f, e))}${isNew ? ' · <span class="tnew">not in the brief yet</span>' : ''}</div><button type="button" class="tremove" data-remove="${esc(f.relPath)}" title="Remove ${esc(f.name)}" aria-label="Remove ${esc(f.name)}">×</button></div>`;
  };

  function render(extracted: Extracted[]): void {
    lastExtracted = extracted;
    const shelves = shelve(files);
    // One shelf of one kind needs no label; the tiles already say PDF.
    const labelled = shelves.length > 1;
    tiles.innerHTML =
      shelves
        .map((s) => {
          if (s.label === MADE) {
            return `<div class="shelf made"><button type="button" class="shelf-label" data-made aria-expanded="${shownMade}" title="Written from your files during the steps. The agent reads these too.">${s.label} <small>${s.files.length}</small></button><div class="shelf-tiles">${shownMade ? s.files.map((f) => tile(f, extracted)).join('') : ''}</div></div>`;
          }
          return `<div class="shelf">${labelled ? `<div class="shelf-label">${s.label} <small>${s.files.length}</small></div>` : ''}<div class="shelf-tiles">${s.files.map((f) => tile(f, extracted)).join('')}</div></div>`;
        })
        .join('') +
      // A class's docs are an option: its button in the header is the way in, and a drop anywhere still works.
      (kind === 'class' ? '' : `<div class="tile add" role="button" tabindex="0"><div class="tname">${files.length ? 'Add more' : 'Add files'}</div><div class="tmeta">Drop slides as PDF, the transcript, notes — or a whole folder — here</div></div>`);
  }

  return {
    set(list, extracted) {
      files = list;
      $('#m-count').textContent = files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : '';
      render(extracted);
    },
    notify: (text, action) => notice.show(text, action),
    hideNotice: () => notice.hide(),
    count: () => files.length,
    setKind(k) {
      if (k === kind) return;
      kind = k;
      $('#m-title').textContent = k === 'class' ? 'Class docs' : 'Materials';
      $('#m-add').textContent = k === 'class' ? 'Add docs…' : 'Add files…';
      $('#m-note').hidden = k !== 'class';
      host.classList.toggle('class-docs', k === 'class');
      if (k === 'deck') fresh = new Set();
      render(lastExtracted);
    },
    markNew(relPaths) {
      const next = new Set(relPaths);
      if (next.size === fresh.size && [...next].every((p) => fresh.has(p))) return;
      fresh = next;
      render(lastExtracted);
    },
  };
}
