// The browser tool: drop a deck.json, get the checks, the cards and a real
// .apkg. Every computation happens in the worker (src/engine/worker.ts);
// this file is DOM and file handling only.

import './tool.css';
import type { WorkerRequest, WorkerResponse } from './engine/protocol.js';

/**
 * The worker is a replaceable resource, not a constant.
 *
 * A failed WASM load cannot be retried inside the worker that suffered it:
 * emscripten's abort() latches a flag in the sql.js glue module, so every
 * later initSqlJs() there throws the same CompileError however healthy the
 * network becomes. The worker says so with `fatal`, and the only recovery is
 * a new one. Nothing is lost by replacing it -- it holds no state between
 * requests.
 */
let worker: Worker;

let nextId = 1;
const pending = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();

/**
 * Set once the worker is known to be dead with no replacement pending. A
 * worker-level failure posts no response, so nothing would otherwise clear
 * the pending entries: loadDeck would await forever with the page blank, and
 * exportApkg's finally would never run, leaving the button disabled reading
 * "Exporting..." for the life of the page.
 *
 * Rejecting the in-flight entries is only half of it. The common case is a
 * worker that dies while evaluating its own module, which fires before the
 * user has dropped anything -- so `pending` is empty at that moment and every
 * LATER request would hang instead. Remembering the failure is what makes
 * those fail fast too.
 */
let workerFailure: string | undefined;

function rejectAllPending(message: string): void {
  const waiting = [...pending.values()];
  pending.clear();
  for (const slot of waiting) slot.reject(new Error(message));
}

function failWorker(message: string): void {
  workerFailure = message;
  rejectAllPending(message);
}

function startWorker(): void {
  worker = new Worker(new URL('./engine/worker.ts', import.meta.url), { type: 'module' });

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const response = event.data;
    const slot = pending.get(response.id);
    if (!slot) return;
    pending.delete(response.id);
    if (response.ok) {
      slot.resolve(response);
      return;
    }
    // This worker can serve nothing further; the next request needs a new one.
    if (response.fatal) replaceWorker();
    slot.reject(new Error(response.message));
  };

  worker.onerror = (event) => {
    failWorker((event instanceof ErrorEvent && event.message) || 'the engine worker failed to start');
  };

  worker.onmessageerror = () => {
    failWorker('the engine worker sent a message this page could not read');
  };
}

/** Discards a poisoned worker and stands up a fresh one. */
function replaceWorker(): void {
  worker.terminate();
  rejectAllPending('the engine worker was restarted; please try again');
  workerFailure = undefined;
  startWorker();
}

startWorker();

/**
 * Omit over a union has to distribute, or it collapses to the keys the
 * members share and a load request looks like a valid export one.
 */
type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never;

function ask<T extends WorkerResponse>(request: Unsent<WorkerRequest>): Promise<T> {
  // Already dead: nothing would answer this, so say so now.
  if (workerFailure !== undefined) return Promise.reject(new Error(workerFailure));
  const id = nextId++;
  return new Promise<WorkerResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...request, id } as WorkerRequest);
  }) as Promise<T>;
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const dropZone = $('drop');
const results = $('results');
const errorBox = $('error');

/**
 * Media the user has supplied, keyed by filename.
 *
 * Keys are NFC-normalized because the two sides disagree otherwise: macOS
 * hands back NFD-decomposed File.name values, while the engine NFC-normalizes
 * every name it extracts from deck text (src/apkg/text.ts). An accented
 * filename would then be reported missing, render broken in the preview, and
 * be dropped from the package while the export still looked successful.
 * media-node.ts solves the same problem for Node with an NFC directory
 * rescan; a Map needs only a consistent key.
 */
const media = new Map<string, Uint8Array>();

/** The one spelling of a media filename this page stores or looks up under. */
function mediaKey(filename: string): string {
  return filename.normalize('NFC');
}

interface LoadedDeck {
  text: string;
  label: string;
  deckName: string;
  reviewHtml: string;
  /** Filenames the deck references, so the missing-media note can be
   *  recomputed when images arrive without re-running the whole engine. */
  referencedMedia: string[];
}
let deck: LoadedDeck | undefined;

function showError(message: string): void {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError(): void {
  errorBox.hidden = true;
}

/**
 * Fills in the preview's images without inlining anything.
 *
 * renderReview writes `src="file://<name>"` once per card face
 * (src/checks/render.ts), so a deck with two clozes repeats each image three
 * times. Substituting a data: URL at every occurrence therefore multiplies
 * the payload: 100 slides at 300 KB measured 29 MB of images -> a 117 MB
 * srcdoc string, which freezes the tab.
 *
 * Instead each reference becomes a `data-ape-media` marker and the bytes go
 * over postMessage once; the bridge below mints ONE blob: URL per distinct
 * image inside the iframe. A blob URL created by the sandboxed document is
 * loadable by that document, even though its origin is opaque -- which is
 * why the parent cannot mint them on its behalf.
 */
function withLocalImages(html: string): string {
  return html.replace(/src="file:\/\/([^"]*)"/g, (whole, raw: string) => {
    // No decodeURI: renderReview writes the filename verbatim, so decoding
    // throws URIError on a bare '%' and silently mangles a literal '%20'.
    const name = raw.split('/').pop() ?? '';
    return media.has(mediaKey(name)) ? `data-ape-media="${name}"` : whole;
  });
}

/** Runs inside the sandboxed preview; see withLocalImages. */
const PREVIEW_BRIDGE = `
<script>
window.addEventListener('message', function (event) {
  var supplied = event.data && event.data.apeMedia;
  if (!supplied) return;
  var urls = new Map();
  document.querySelectorAll('[data-ape-media]').forEach(function (el) {
    var name = el.getAttribute('data-ape-media');
    if (!supplied.has(name)) return;
    if (!urls.has(name)) urls.set(name, URL.createObjectURL(new Blob([supplied.get(name)])));
    el.src = urls.get(name);
  });
});
<\/script>`;

function renderSummary(count: number, deckNames: string[], clean: boolean): void {
  const deckLabel =
    deckNames.length === 1 ? deckNames[0]! : `${deckNames.length} decks`;
  $('summary').innerHTML =
    `<span class="count">${count} note${count === 1 ? '' : 's'}</span> ` +
    `<span class="deck">· ${escapeHtml(deckLabel)} ·</span> ` +
    (clean ? '<span class="clean">checks clean</span>' : '<span class="dirty">checks found problems</span>');
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function refreshPreview(): void {
  if (!deck) return;
  const frame = $('review') as HTMLIFrameElement;
  // The bytes can only be posted once the bridge is listening.
  frame.onload = () => {
    if (media.size === 0) return;
    frame.contentWindow?.postMessage({ apeMedia: media }, '*');
  };
  frame.srcdoc = withLocalImages(deck.reviewHtml) + PREVIEW_BRIDGE + (previewExtras?.script ?? '');
}

/** The "referenced but not supplied" note, over what is already in memory. */
function updateMissingNote(): void {
  const note = $('exportnote');
  const missing = deck ? deck.referencedMedia.filter((name) => !media.has(mediaKey(name))) : [];
  if (missing.length === 0) {
    note.hidden = true;
    return;
  }
  note.textContent =
    `${missing.length} image${missing.length === 1 ? '' : 's'} referenced but not supplied ` +
    `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}). ` +
    `Add them to include them in the package and see them here.`;
  note.hidden = false;
}

/** Drops everything the last deck put on screen. */
function clearDeck(): void {
  deck = undefined;
  results.hidden = true;
  $('summary').textContent = '';
  $('report').textContent = '';
  ($('review') as HTMLIFrameElement).srcdoc = '';
  $('exportnote').hidden = true;
}

export interface LoadedDeckInfo {
  count: number;
  deckNames: string[];
  clean: boolean;
  referencedMedia: string[];
}

async function loadDeck(file: File): Promise<void> {
  await loadDeckText(await file.text(), file.name).catch(() => undefined);
}

/** Loads a deck from its text; the agent shell feeds deck.json read through the bridge. */
export async function loadDeckText(text: string, label: string): Promise<LoadedDeckInfo> {
  clearError();
  try {
    const loaded = await ask<Extract<WorkerResponse, { kind: 'load' }>>({
      kind: 'load',
      deckText: text,
      label: label,
    });

    deck = {
      text,
      label,
      // Every note must share one deckName for export (src/apkg/collection.ts);
      // the engine rejects a mismatch, so take the first and let it complain.
      deckName: loaded.deckNames[0] ?? 'A.P.E.',
      reviewHtml: loaded.reviewHtml,
      referencedMedia: loaded.referencedMedia,
    };

    renderSummary(loaded.count, loaded.deckNames, loaded.clean);
    $('report').textContent = loaded.report;
    refreshPreview();

    updateMissingNote();

    results.hidden = false;
    dropZone.classList.remove('over');
    return { count: loaded.count, deckNames: loaded.deckNames, clean: loaded.clean, referencedMedia: loaded.referencedMedia };
  } catch (err) {
    // Without this the previous deck stays on screen and stays exportable:
    // `deck` is only reassigned on success, so Export would silently ship the
    // old notes while the error box describes the new file.
    clearDeck();
    showError(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Media supplied by something other than a drop -- the agent shell, from the bridge. */
export function addMediaBytes(name: string, bytes: Uint8Array): void {
  media.set(mediaKey(name), bytes);
  updateMissingNote();
  refreshPreview();
}

export { showError, clearError };

/**
 * Something the agent shell layers onto the preview: a script appended to
 * the review page (the Flag buttons), and a handler for what that script
 * posts back. The tool page alone sets nothing here.
 */
export interface PreviewExtras {
  script: string;
  onMessage(data: unknown): void;
}
let previewExtras: PreviewExtras | null = null;
export function setPreviewExtras(extras: PreviewExtras | null): void {
  previewExtras = extras;
  refreshPreview();
}
/** Posts into the preview -- e.g. which cards are flagged. */
export function postToPreview(message: unknown): void {
  ($('review') as HTMLIFrameElement).contentWindow?.postMessage(message, '*');
}
window.addEventListener('message', (event) => {
  const frame = $('review') as HTMLIFrameElement;
  if (event.source === frame.contentWindow) previewExtras?.onMessage(event.data);
});

async function addMedia(files: File[]): Promise<void> {
  // Every other async entry point reports its own failures; without this a
  // dropped folder (a zero-byte File that rejects on read) would surface as
  // an unhandled rejection and silently abort the whole drop.
  try {
    for (const file of files) {
      media.set(mediaKey(file.name), new Uint8Array(await file.arrayBuffer()));
    }
    updateMissingNote();
    refreshPreview();
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  }
}

export async function exportApkg(): Promise<void> {
  if (!deck) return;
  clearError();
  const button = $('export') as HTMLButtonElement;
  button.disabled = true;
  button.textContent = 'Exporting…';
  try {
    const built = await ask<Extract<WorkerResponse, { kind: 'export' }>>({
      kind: 'export',
      deckText: deck.text,
      label: deck.label,
      deckName: deck.deckName,
      media,
    });

    const filename = `${deck.label.replace(/\.json$/i, '')}.apkg`;
    await save(built.bytes, filename);
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err));
  } finally {
    button.disabled = false;
    button.textContent = 'Export .apkg';
  }
}

/**
 * Real folder when the browser has one, download otherwise. showSaveFilePicker
 * is Chromium-only; everywhere else this is an ordinary download, which is why
 * nothing on this page depends on it.
 */
const REVOKE_DELAY_MS = 60_000;

async function save(bytes: Uint8Array, filename: string): Promise<void> {
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
  const picker = (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await (picker as (o: unknown) => Promise<FileSystemFileHandle>)({
        suggestedName: filename,
        types: [{ description: 'Anki package', accept: { 'application/octet-stream': ['.apkg'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // A cancelled picker is not an error worth reporting; anything else
      // falls through to the download path rather than losing the export.
      if (err instanceof DOMException && err.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  // In the document, and revoked later: click() only QUEUES the download, so
  // revoking in the same task can cancel a multi-megabyte save before the
  // browser has read the blob -- and this is the only save path on Firefox
  // and Safari, where showSaveFilePicker does not exist. A detached anchor is
  // the same class of hazard.
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

function isDeckFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.json');
}

// ---- wiring ----------------------------------------------------------------

for (const event of ['dragenter', 'dragover'] as const) {
  document.addEventListener(event, (e) => {
    e.preventDefault();
    dropZone.classList.add('over');
  });
}
for (const event of ['dragleave', 'drop'] as const) {
  document.addEventListener(event, (e) => {
    e.preventDefault();
    if (event === 'drop' || e.target === dropZone) dropZone.classList.remove('over');
  });
}

// The first thing a student did on the landing page was try to give it a
// lecture PDF. The page cannot take one -- building a deck is the desktop
// app's job, or the bridge's -- so say that, and point there, instead of
// ignoring the drop.
function isMediaFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('audio/');
}

document.addEventListener('drop', (e) => {
  if (document.body.classList.contains('with-rail')) return; // the shell takes drops as materials
  const files = [...(e.dataTransfer?.files ?? [])];
  const json = files.find(isDeckFile);
  const rest = files.filter((f) => !isDeckFile(f));
  if (!json && rest.length > 0 && !rest.every(isMediaFile)) {
    showError(
      `This box takes a finished deck.json. To build a deck from lecture files (${rest.map((f) => f.name).join(', ')}), ` +
        `use the desktop app — the link below.`,
    );
    return;
  }
  void (async () => {
    // Deck first, images second. addMedia reports its own errors and never
    // rejects, so a bad image cannot stop the deck loading -- and doing the
    // deck first means loadDeck's opening clearError() cannot wipe a media
    // failure the user still needs to see.
    if (json) await loadDeck(json);
    if (rest.length > 0) await addMedia(rest);
  })();
});

$('pick').addEventListener('click', () => ($('file') as HTMLInputElement).click());
$('file').addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) void loadDeck(file);
});
$('addmedia').addEventListener('click', () => ($('mediafile') as HTMLInputElement).click());
$('mediafile').addEventListener('change', (e) => {
  const files = [...((e.target as HTMLInputElement).files ?? [])];
  if (files.length > 0) void addMedia(files);
});
$('export').addEventListener('click', () => void exportApkg());

// ---- agent mode --------------------------------------------------------------
// When `ape-bridge` opened this page -- its details are in the fragment --
// the page becomes the app: the same shell the desktop app runs
// (app/src/agent/app.ts), over the bridge instead of Tauri, with this page's
// in-tab engine as the deck view. A developer's route: the shell can be
// driven in a browser without building the Tauri app. The page does not
// advertise it; the front door is the app. Nothing here is fetched until then.
import { Bridge, locateBridge } from './engine/bridge-transport.js';
{
  const locator = locateBridge();
  if (locator) {
    void (async () => {
      const bridge = new Bridge(locator);
      $('build').hidden = true;
      document.querySelector<HTMLElement>('header.top')!.hidden = true;
      document.querySelector<HTMLElement>('main > footer')!.hidden = true;
      document.body.classList.add('with-rail');
      $('rail').hidden = false;
      try {
        await bridge.health();
        await bridge.connect();
      } catch {
        showError(
          `This page was opened by ape-bridge, but the bridge cannot be reached. ` +
            `Is it still running in your terminal? If your browser asked to allow access to your local network, it needs a yes. ` +
            `Brave blocks websites from reaching this computer unless you add this site under brave://settings/content/localhostAccess.`,
        );
        return;
      }
      const [{ mountAgentApp }, { makeSidecarClient }, { makeBridgeDeckView }] = await Promise.all([
        import('../../app/src/agent/app.js'),
        import('../../app/src/engine/client.js'),
        import('./bridge-deck.js'),
      ]);
      const rail = $('rail');
      // The deck view is made before the app it reports through.
      let app: { say(text: string, isError?: boolean): void } | null = null;
      const say = (text: string, isError = false): void => app?.say(text, isError);
      app = mountAgentApp(bridge, {
        rail,
        bar: $('bar'),
        view: $('view-agent'),
        deck: makeBridgeDeckView(makeSidecarClient(bridge), bridge, say),
        // This tab, until it closes: a page has no keychain.
        keys: {
          get: async (id) => sessionStorage.getItem(`ape.key.${id}`),
          set: async (id, value) => sessionStorage.setItem(`ape.key.${id}`, value),
        },
      });
    })();
  }
}
