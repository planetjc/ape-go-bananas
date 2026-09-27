// Settings: the agent, and the app's own facts. The agent is a setting, not
// a step -- chosen once, remembered, and connected on its own whenever a
// course folder is chosen. picker.ts renders into the agent slot.

import type { EngineHost } from '../engine/client.js';
import { readTheme, setTheme, type Theme } from '../theme.js';
import { mountSignIn } from './signin.js';
import { readNewPerDay, setNewPerDay } from './study.js';

export interface SettingsOptions {
  onDone(): void;
  say(text: string, isError?: boolean): void;
}

export interface Settings {
  readonly agentSlot: HTMLElement;
  /** Facts that arrive after mount: where the method files are. */
  setMethodDir(dir: string | null): void;
  /** Whether the School view is in use: its study settings show only then. */
  setSchool(on: boolean): void;
}

/** Where people reach the author: forwarded by the domain, so it outlives any one inbox. */
const CONTACT_EMAIL = 'contact@ankiengine.com';

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function mountSettings(host: HTMLElement, engine: EngineHost, opts: SettingsOptions): Settings {
  host.innerHTML = `
    <header class="bar"><h2>Settings</h2><span class="grow"></span><button type="button" id="set-done">Done</button></header>
    <section class="set-section">
      <h3>Agent</h3>
      <p class="hint">The agent does the reading and writing, on a subscription you already pay for. It runs on this computer, in the course folder, and is connected on its own each time a folder is chosen.</p>
      <div id="set-agent"></div>
      <div id="set-signin"></div>
    </section>
    <section class="set-section" id="set-studying" hidden>
      <h3>Studying</h3>
      <p class="hint">How many new cards you add a day — set it to match New cards/day in Anki's deck options. A deck in a class with an exam date is sized to what this many a day reviews before that exam.</p>
      <label class="set-rate"><input type="number" id="set-rate" min="1" max="9999" step="1" inputmode="numeric"> new cards a day</label>
    </section>
    <section class="set-section">
      <h3>Appearance</h3>
      <p class="hint">Follow the system, or pin it.</p>
      <div class="set-theme" id="set-theme" role="group" aria-label="Appearance">
        <button type="button" data-theme="system">System</button>
        <button type="button" data-theme="light">Light</button>
        <button type="button" data-theme="dark">Dark</button>
      </div>
    </section>
    <section class="set-section">
      <h3>This app</h3>
      <dl class="facts">
        <dt>Engine</dt><dd>${esc(engine.info.engine)} ${esc(engine.info.version)} on Node ${esc(engine.info.node)}, over ${esc(engine.info.transport)}</dd>
        <dt>Agents are installed in</dt><dd class="path">${esc(engine.dataDir())}</dd>
        <dt>Method files</dt><dd class="path" id="set-method">…</dd>
      </dl>
      <p class="hint">Nothing leaves this computer except what the agent sends to its own service. Artifacts live beside your material; the app keeps no copy.</p>
    </section>
    <section class="set-section">
      <h3>Get in touch</h3>
      <p class="hint">A question, a card that came out wrong, an idea: write to us.</p>
      <p class="set-contact"><span class="path" id="set-email">${CONTACT_EMAIL}</span><button type="button" id="set-email-copy" class="quiet">Copy</button></p>
    </section>`;
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
  $<HTMLButtonElement>('#set-done').addEventListener('click', () => opts.onDone());

  // Copied rather than linked: the window has no way to hand a mailto: link
  // to the mail app, and a link that does nothing is worse than none.
  // The clipboard API is the first try; a webview may refuse it, so the
  // address is then selected and copied the older way, and if that is
  // refused too it stays selected for ⌘C.
  const copy = $<HTMLButtonElement>('#set-email-copy');
  const copied = (): void => {
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy'), 1500);
  };
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(CONTACT_EMAIL).then(copied, () => {
      const range = document.createRange();
      range.selectNodeContents($<HTMLElement>('#set-email'));
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      if (document.execCommand('copy')) copied();
      else opts.say('the address is selected — press ⌘C to copy it');
    });
  });

  // New cards a day: kept as typed once it is a whole number; anything else puts the kept one back.
  const rate = $<HTMLInputElement>('#set-rate');
  rate.value = String(readNewPerDay());
  rate.addEventListener('change', () => {
    const n = Number(rate.value);
    if (Number.isInteger(n) && n > 0 && n <= 9999) {
      setNewPerDay(n);
      opts.say(`${n} new card${n === 1 ? '' : 's'} a day`);
    } else rate.value = String(readNewPerDay());
  });

  // Appearance. The pressed one is the one in force; the banana marks it.
  const themeGroup = $<HTMLElement>('#set-theme');
  const showTheme = (theme: Theme): void => {
    themeGroup.querySelectorAll<HTMLButtonElement>('button[data-theme]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.theme === theme));
    });
  };
  themeGroup.addEventListener('click', (e) => {
    const picked = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-theme]')?.dataset.theme;
    if (picked !== 'system' && picked !== 'light' && picked !== 'dark') return;
    setTheme(picked);
    showTheme(picked);
  });
  showTheme(readTheme());

  // Signing in is the CLI's own flow, so a host that runs it offers it as a
  // console rather than a form (signin.ts). Neither current host does.
  if (engine.signIn) {
    const slot = $<HTMLElement>('#set-signin');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    button.textContent = 'Sign in to Claude';
    button.addEventListener('click', () => {
      button.disabled = true;
      mountSignIn(slot, engine, opts.say, () => {
        button.disabled = false;
      });
    });
    slot.append(button);
  }

  return {
    agentSlot: $<HTMLElement>('#set-agent'),
    setMethodDir(dir) {
      $<HTMLElement>('#set-method').textContent = dir ?? '(not found — the steps cannot run)';
    },
    setSchool(on) {
      $<HTMLElement>('#set-studying').hidden = !on;
    },
  };
}
