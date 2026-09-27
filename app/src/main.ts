// The desktop app's window: the agent shell (agent/app.ts, shared with the
// tool page over the bridge) over a TauriHost, plus this shell's own deck
// view -- checks, the card preview and the .apkg export through the
// sidecar's deck/* methods, on the Node engine Rust spawned. Nothing here
// says what a card is; the engine renders the review and the method text
// decides the rest.
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { mountAgentApp, type DeckView } from './agent/app.js';
import { EngineError, makeSidecarClient, type Flag, type SidecarClient, type SendToAnkiResult } from './engine/client.js';
import { TauriHost, secrets, sidecarStatus } from './engine/tauri-host.js';
import { mountPreview } from './preview.js';
import { applyTheme, readTheme } from './theme.js';
import { offerUpdate } from './updater.js';

// Before anything is drawn, so a pinned theme does not flash the other one.
// It cannot be an inline script in index.html: the window's CSP allows
// script-src 'self' only.
applyTheme(readTheme());

const root = document.getElementById('app')!;
root.innerHTML = `
  <aside class="rail" id="rail"></aside>
  <main class="main" id="main">
    <div id="bar" hidden></div>
    <section id="view-agent" class="view" hidden></section>
    <section id="view-deck" class="view" hidden>
      <section class="drop" id="drop">
        <p>Drop a <code>deck.json</code> (or the folder holding one) here</p>
        <button type="button" id="open">Open…</button>
      </section>
      <section class="work" id="work" hidden>
        <header class="bar">
          <span id="deckname"></span><span class="grow"></span>
          <div class="cardnav" id="cardnav" hidden>
            <button type="button" id="cardprev" class="quiet" aria-label="Previous card">&#8592;</button>
            <span id="cardat" aria-live="polite"></span>
            <button type="button" id="cardnext" class="quiet" aria-label="Next card">&#8594;</button>
          </div>
          <button type="button" id="flagthis" class="quiet">Flag this card</button>
          <button type="button" id="send">Send to Anki</button>
          <button type="button" id="export" class="quiet">Export .apkg</button>
        </header>
        <div class="split">
          <div class="preview" id="preview"></div>
          <div class="side">
            <form class="flagsheet" id="flagsheet" hidden>
              <div class="fs-head">Flagging card <strong id="fs-card"></strong></div>
              <label for="fs-note">What is wrong with it?</label>
              <textarea id="fs-note" rows="3" placeholder="The hint gives the answer away"></textarea>
              <div class="fs-actions"><button type="submit">Flag it</button><button type="button" id="fs-cancel" class="quiet">Cancel</button></div>
            </form>
            <h2>Checks</h2><pre id="report"></pre>
            <h2>Flags <small id="flagcount"></small></h2><ul id="flags" class="flags"></ul>
          </div>
        </div>
      </section>
    </section>
  </main>`;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---- the deck view, over the sidecar ----------------------------------------

function makeDeckView(sidecar: SidecarClient, say: (text: string, isError?: boolean) => void): DeckView {
  let deckPath: string | null = null;
  let flags: Flag[] = [];
  let preview: ReturnType<typeof mountPreview> | null = null;
  // Where the review is: how many cards it holds, and which one is at the top.
  // The count comes from the load; the position comes from the frame, so
  // scrolling by hand keeps the counter honest.
  let cards = 0;
  let at = 0;

  function renderAt(): void {
    $('cardat').textContent = cards ? `card ${at + 1} / ${cards}` : '';
    $<HTMLButtonElement>('cardprev').disabled = at <= 0;
    $<HTMLButtonElement>('cardnext').disabled = at >= cards - 1;
  }
  function goto(index: number): void {
    at = Math.min(Math.max(index, 0), Math.max(cards - 1, 0));
    preview?.goto(at);
    renderAt();
  }
  $('cardprev').addEventListener('click', () => goto(at - 1));
  $('cardnext').addEventListener('click', () => goto(at + 1));

  // Flagging a card: a sheet in the panel the flags live in, rather than the
  // browser's prompt -- which also flagged the card when it was cancelled,
  // because a cancelled prompt and an empty note look the same.
  let flagging: number | null = null;
  const sheet = $<HTMLFormElement>('flagsheet');
  const note = $<HTMLTextAreaElement>('fs-note');
  function openFlagSheet(noteIndex: number): void {
    flagging = noteIndex;
    $('fs-card').textContent = `#${noteIndex + 1}`;
    note.value = '';
    sheet.hidden = false;
    note.focus();
  }
  function closeFlagSheet(): void {
    flagging = null;
    sheet.hidden = true;
  }
  sheet.addEventListener('submit', (e) => {
    e.preventDefault();
    if (flagging === null) return;
    flags.push({ noteIndex: flagging, note: note.value.trim(), at: new Date().toISOString() });
    closeFlagSheet();
    renderFlags();
    void persistFlags();
  });
  $('fs-cancel').addEventListener('click', () => closeFlagSheet());
  sheet.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeFlagSheet();
  });
  $('flagthis').addEventListener('click', () => openFlagSheet(at));

  function renderFlags(): void {
    $('flagcount').textContent = flags.length ? `(${flags.length})` : '';
    $('flags').innerHTML = flags.map((f, i) => `<li>#${f.noteIndex + 1} ${f.note ? `— ${esc(f.note)}` : ''} <button type="button" data-unflag="${i}">×</button></li>`).join('');
    preview?.markFlagged(flags.map((f) => f.noteIndex));
  }
  async function persistFlags(): Promise<void> {
    if (deckPath) await sidecar.writeFlags(deckPath, flags);
  }
  $('flags').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-unflag]');
    if (!btn) return;
    flags.splice(Number(btn.dataset.unflag), 1);
    renderFlags();
    void persistFlags();
  });

  async function openPath(path: string): Promise<void> {
    say(`loading ${path}`);
    try {
      const [loaded, check, review, stored] = await Promise.all([sidecar.load(path), sidecar.check(path), sidecar.review(path), sidecar.readFlags(path)]);
      deckPath = path;
      flags = stored.flags;
      $('deckname').textContent = `${loaded.notes[0]?.deckName ?? '(no deck name)'} · ${loaded.count} notes`;
      $('report').textContent = (check.mediaNote ? `${check.mediaNote}\n` : '') + check.report;
      $('report').classList.toggle('clean', check.clean);
      $('drop').hidden = true;
      $('work').hidden = false;
      cards = loaded.count;
      at = 0;
      closeFlagSheet();
      $('cardnav').hidden = cards === 0;
      renderAt();
      preview = mountPreview($('preview'), review.html, {
        onFlag: openFlagSheet,
        onAt: (index) => {
          at = index;
          renderAt();
        },
      });
      renderFlags();
      say(check.clean ? 'checks clean' : `${check.result.findings.length} finding(s)`, !check.clean);
    } catch (err) {
      // Whatever was open before is not this deck: left up, its Export, Send
      // and Flag acted on the previous deck while the rail named this one.
      deckPath = null;
      flags = [];
      cards = 0;
      preview = null;
      $('preview').replaceChildren();
      $('work').hidden = true;
      $('drop').hidden = false;
      say(err instanceof EngineError ? `${err.message} (code ${err.code})` : String(err), true);
    }
  }

  async function exportPath(path: string): Promise<string | null> {
    try {
      const out = await sidecar.export(path);
      say(`wrote ${out.outPath}` + (out.unresolvedMedia.length ? ` (missing media: ${out.unresolvedMedia.join(', ')})` : ''), out.unresolvedMedia.length > 0);
      return out.outPath;
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
      return null;
    }
  }

  async function sendPath(path: string): Promise<SendToAnkiResult | null> {
    try {
      const r = await sidecar.sendToAnki(path);
      const bits = [`${r.added} of ${r.total} added to ${r.decks.join(', ')}`];
      if (r.skipped) bits.push(`${r.skipped} already there`);
      if (r.media) bits.push(`${r.media} image${r.media === 1 ? '' : 's'} stored`);
      if (r.createdModel) bits.push('note type created');
      if (r.unresolvedMedia.length) bits.push(`missing media: ${r.unresolvedMedia.join(', ')}`);
      say(`Anki: ${bits.join(' · ')}`, r.unresolvedMedia.length > 0);
      return r;
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
      return null;
    }
  }

  $('open').addEventListener('click', () => {
    void open({ multiple: false, filters: [{ name: 'deck.json', extensions: ['json'] }] }).then((picked) => {
      if (typeof picked === 'string') void openPath(picked);
    });
  });
  $('export').addEventListener('click', () => {
    if (deckPath) void exportPath(deckPath);
  });
  $('send').addEventListener('click', () => {
    if (deckPath) void sendPath(deckPath);
  });

  return {
    show(visible) {
      $('view-deck').hidden = !visible;
    },
    open: (dir) => openPath(`${dir.replace(/[\\/]$/, '')}/deck.json`),
    export: (dir) => exportPath(`${dir.replace(/[\\/]$/, '')}/deck.json`),
    sendToAnki: (dir) => sendPath(`${dir.replace(/[\\/]$/, '')}/deck.json`),
  };
}

// ---- start -------------------------------------------------------------------

// The engine did not start. The update check still runs: an engine that
// cannot start is exactly what an update may fix, and without it a Windows
// install of v0.1.6 -- whose engine never started -- could not update itself.
function fail(message: string): void {
  root.innerHTML = `<div class="dead"><h1>A.P.E.</h1><p class="error">${esc(message)}</p></div>`;
  const dead = root.querySelector<HTMLElement>('.dead')!;
  void offerUpdate(dead, (text) => dead.insertAdjacentHTML('beforeend', `<p class="error">${esc(text)}</p>`));
}

void (async () => {
  let host: TauriHost;
  try {
    host = await TauriHost.start(await sidecarStatus());
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return;
  }
  const sidecar = makeSidecarClient(host);
  const status = { say: (text: string, isError = false): void => app.say(text, isError) };
  const deck = makeDeckView(sidecar, (t, e) => status.say(t, e));
  const app = mountAgentApp(host, {
    rail: $('rail'),
    bar: $('bar'),
    view: $('view-agent'),
    deck,
    keys: secrets,
    pickFiles: async (title) => {
      const picked = await open({ multiple: true, directory: false, title });
      return Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : null;
    },
  });

  // A drop anywhere in the window: files, or a folder of them, into the deck.
  void getCurrentWebview().onDragDropEvent((event) => {
    document.body.classList.toggle('dropping', event.payload.type === 'over');
    if (event.payload.type !== 'drop' || event.payload.paths.length === 0) return;
    void app.addPaths(event.payload.paths);
  });

  void offerUpdate($('main'), app.say);
})();
