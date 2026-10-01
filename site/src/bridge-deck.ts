// The tool page's deck view, for the agent shell over the bridge. The
// desktop app loads and exports through the sidecar's deck/* methods; here
// the checks, the card preview and the .apkg export run in this tab, on the
// engine the tool page already carries (tool.ts) -- the bridge only
// supplies deck.json's text, the image bytes beside it, and the flags file.
// That keeps every deck operation on Node 20 (the bridge never touches
// node:sqlite) and keeps the preview that was proven at 10 MB.

import type { DeckView } from '../../app/src/agent/app.js';
import { EngineError, type EngineHost, type Flag, type SidecarClient } from '../../app/src/engine/client.js';
import { addMediaBytes, exportApkg, loadDeckText, postToPreview, setPreviewExtras } from './tool.js';

/** Appended to the review page: a Flag button per card, and an outline on flagged ones. */
const FLAG_SCRIPT = `<script>
document.querySelectorAll('article').forEach((a, i) => {
  const b = document.createElement('button');
  b.textContent = 'Flag';
  b.className = 'flag';
  b.style.cssText = 'float:right;margin-left:8px';
  b.onclick = () => parent.postMessage({ type: 'ape:flag', noteIndex: i }, '*');
  a.querySelector('.idx').prepend(b);
});
window.addEventListener('message', (e) => {
  if (!e.data || e.data.type !== 'ape:flagged') return;
  document.querySelectorAll('article').forEach((a, i) => {
    a.style.outline = e.data.indexes.includes(i) ? '2px solid #E8C07D' : '';
  });
});
<\/script>`;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function makeBridgeDeckView(sidecar: SidecarClient, host: EngineHost, say: (text: string, isError?: boolean) => void): DeckView {
  const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
  const panes = ['drop', 'results', 'exportnote'].map((id) => $(id));
  let loaded = false;
  let deckPath: string | null = null;
  let flags: Flag[] = [];

  function renderFlags(): void {
    postToPreview({ type: 'ape:flagged', indexes: flags.map((f) => f.noteIndex) });
    $('flags').innerHTML = flags.map((f, i) => `<li>#${f.noteIndex + 1} ${f.note ? `— ${esc(f.note)}` : ''} <button type="button" data-unflag="${i}">×</button></li>`).join('');
    $('flagcount').textContent = flags.length ? `(${flags.length})` : '';
    $('flagbox').hidden = false;
  }
  async function persistFlags(): Promise<void> {
    if (deckPath) await sidecar.writeFlags(deckPath, flags);
  }
  $('flags').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-unflag]');
    if (!b) return;
    flags.splice(Number(b.dataset.unflag), 1);
    renderFlags();
    void persistFlags();
  });
  setPreviewExtras({
    script: FLAG_SCRIPT,
    onMessage(data) {
      const m = data as { type?: string; noteIndex?: number };
      if (m?.type !== 'ape:flag' || !Number.isInteger(m.noteIndex)) return;
      // A stand-in for a designed flag sheet, as on the desktop (docs/APP.md).
      const note = window.prompt(`Flag card #${m.noteIndex! + 1}. What is wrong?`) ?? '';
      flags.push({ noteIndex: m.noteIndex!, note, at: new Date().toISOString() });
      renderFlags();
      void persistFlags();
    },
  });

  async function open(dir: string): Promise<void> {
    say('loading deck.json…');
    const path = `${dir}/deck.json`;
    try {
      const text = (await sidecar.readCourse(dir, 'deck.json')).text;
      const info = await loadDeckText(text, 'deck.json');
      loaded = true;
      deckPath = path;
      $('drop').hidden = true;
      // Images: beside the material first, then the Anki media folder.
      const mediaDir = await sidecar.mediaDir().then((m) => (m.exists ? m.mediaDir : null), () => null);
      let found = 0;
      for (const name of info.referencedMedia) {
        const bytes = (await host.readFile(dir, name)) ?? (mediaDir ? await host.readFile(mediaDir, name) : null);
        if (bytes) {
          addMediaBytes(name, bytes);
          found += 1;
        }
      }
      flags = (await sidecar.readFlags(path)).flags;
      renderFlags();
      say(`${info.count} notes${info.clean ? ', checks clean' : ', checks found problems'}${info.referencedMedia.length ? ` · ${found}/${info.referencedMedia.length} images` : ''}`, !info.clean);
    } catch (err) {
      say(err instanceof EngineError ? `${err.message} (code ${err.code})` : String(err), true);
    }
  }

  return {
    show(visible) {
      for (const el of panes) if (!visible) el.hidden = true;
      if (visible) {
        $('drop').hidden = loaded;
        $('results').hidden = !loaded;
      }
    },
    open,
    async export(dir) {
      if (!loaded) await open(dir);
      await exportApkg();
      return null; // saved by the browser, wherever it puts downloads
    },
    async sendToAnki(dir) {
      try {
        const r = await sidecar.sendToAnki(`${dir.replace(/[\\/]$/, '')}/deck.json`);
        const added = r.added === 0 && r.total > 0 ? `nothing new — all ${r.total} already in ${r.decks.join(', ')}` : `${r.added} of ${r.total} added to ${r.decks.join(', ')}${r.skipped ? ` · ${r.skipped} already there` : ''}`;
        say(`Anki: ${added}${r.unresolvedMedia.length ? ` · missing media: ${r.unresolvedMedia.join(', ')}` : ''}`, r.unresolvedMedia.length > 0);
        return r;
      } catch (err) {
        say(err instanceof EngineError ? err.message : String(err), true);
        return null;
      }
    },
  };
}
