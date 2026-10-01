// The agent, as a setting: every agent the public registry knows, the ones
// installed here first, plus the API-key slot. "Use" remembers the choice;
// the shell connects it whenever a course folder is known (the agent's
// session is opened in that folder), so the ordinary path is: choose once,
// never see this screen again. Sign-in runs the vendor's own flow from a
// button -- the sidecar spawns it on this computer and a browser opens for
// the OAuth step (docs/research/claude-adapter-auth.md §4).
//
// An API key entered here goes to agent/connect and to the store the shell
// provides: the OS keychain in the desktop app, sessionStorage on the tool
// page (this tab, until it closes). Nothing else sees it.

import { EngineError, type ConnectResult, type Provider, type SidecarClient } from '../engine/client.js';
import type { Bus } from './bus.js';
import { isNewer } from './versions.js';

export interface PickerCallbacks {
  /** The user picked this agent; remember it. Called before any connection is attempted. */
  onChosen(id: string): void;
  onConnected(result: ConnectResult): void;
  say(text: string, isError?: boolean): void;
  /**
   * The agent's files are about to change (update, remove): let go of it
   * first. npm rewrites what a running agent is executing, so a connected
   * one is disconnected, and the answer is false while a stage is running.
   */
  release(id: string): Promise<boolean>;
  /** The list was (re)read: what is installed, and what could be updated, may have changed. */
  onListed?(): void;
  /** Where a connect is that has not landed (yet): null when it did, or was let go of. */
  onPhase?(phase: AgentPhase): void;
}

/** A connect on its way, waiting on a sign-in, or refused; null for none. */
export type AgentPhase = 'connecting' | 'sign-in' | 'failed' | null;

/** Where an API key lives between sessions. Names are provider ids. */
export interface KeyStore {
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
}

export interface PickerState {
  /** The remembered agent's id, if any. */
  chosen: string | null;
  /** The provider id currently connected, if any. */
  connected: string | null;
  /** Whether a course folder is set: without one nothing can connect, and the buttons say so. */
  hasFolder: boolean;
}

export interface Picker {
  /** Resolves once the registry has been read the first time, so names can be looked up. */
  readonly ready: Promise<void>;
  /** Connects `id` if it is installed here (waits for the registry first); false when it is not. */
  connectIfInstalled(id: string): Promise<boolean>;
  setState(state: Partial<PickerState>): void;
  /** The display name of an agent id, once the registry is loaded. */
  nameOf(id: string): string | null;
  /** The registry's newer version of an installed agent, or null when it is current. */
  updateFor(id: string): string | null;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

export function mountPicker(host: HTMLElement, sidecar: SidecarClient, bus: Bus, dataDir: string, courseDir: () => string | null, keys: KeyStore, cb: PickerCallbacks): Picker {
  let providers: Provider[] = [];
  let pending: ConnectResult | null = null; // a connection waiting on sign-in
  const progress = new Map<string, string[]>();
  const state: PickerState = { chosen: null, connected: null, hasFolder: false };

  host.innerHTML = `
    <div class="picker">
      <div id="pk-current" class="pk-current"></div>
      <ul class="providers" id="pk-main"></ul>
      <details class="pk-more"><summary id="pk-install-sum">Install another agent</summary><ul class="providers" id="pk-install"></ul></details>
      <details class="pk-more"><summary id="pk-other-sum">Other agents in the registry</summary><ul class="providers" id="pk-other"></ul></details>
      <div id="auth" class="auth hidden"></div>
      <pre id="log" class="log hidden"></pre>
      <p class="hint"><button type="button" id="refresh" class="link">Refresh the list</button></p>
    </div>`;
  const $ = <T extends HTMLElement>(sel: string): T => host.querySelector<T>(sel)!;
  const auth = $<HTMLDivElement>('#auth');
  const log = $<HTMLPreElement>('#log');

  /** The registry has a later release than the one installed here. */
  function update(p: Provider | undefined): string | null {
    return p && p.kind !== 'api' && p.installed && p.installable && isNewer(p.version, p.installedVersion) ? p.version : null;
  }

  function card(p: Provider): string {
    const isChosen = p.id === state.chosen;
    const isConnected = p.id === state.connected;
    const badge = isConnected ? '<span class="pk-badge on">connected</span>' : isChosen ? '<span class="pk-badge">chosen</span>' : '';
    const newer = update(p);
    const state_ = p.kind === 'api' ? 'any model, one API key' : p.installed ? `installed ${p.installedVersion}${newer ? ` · ${newer} available` : ''}` : p.installable ? `v${p.version ?? '?'}` : `${p.distribution} — not installable from here yet`;
    const useLabel = isConnected ? 'Reconnect' : state.hasFolder ? 'Use' : 'Use';
    const useTitle = state.hasFolder ? '' : 'Remembered now; connects when a course folder is chosen';
    const actions =
      p.kind === 'api'
        ? `<input type="password" placeholder="sk-or-…" data-key="${esc(p.id)}" autocomplete="off"><button type="button" data-use="${esc(p.id)}" title="${useTitle}">${useLabel}</button>`
        : p.installed
          ? `<button type="button" data-use="${esc(p.id)}" title="${useTitle}">${useLabel}</button>${
              newer ? `<button type="button" data-update="${esc(p.id)}" title="The newer release brings whatever the agent has added since -- for Claude, the newest models.">Update to ${esc(newer)}</button>` : ''
            }<button type="button" data-uninstall="${esc(p.id)}" class="quiet">Remove</button>`
          : p.installable
            ? `<button type="button" data-install="${esc(p.id)}">Install</button>`
            : '';
    const lines = progress.get(p.id);
    return `<li data-id="${esc(p.id)}"><div class="pname">${esc(p.name)} <small>${esc(state_)}</small> ${badge}</div><div class="pdesc">${esc(p.description)}</div><div class="pactions">${actions}</div>${lines ? `<pre class="plog">${esc(lines.slice(-6).join('\n'))}</pre>` : ''}</li>`;
  }

  function render(): void {
    const main = providers.filter((p) => p.installed || p.kind === 'api' || p.id === state.chosen);
    const install = providers.filter((p) => !main.includes(p) && p.installable);
    const other = providers.filter((p) => !main.includes(p) && !p.installable);
    // The chosen one leads; the connected one, if different, next.
    main.sort((a, b) => Number(b.id === state.chosen) - Number(a.id === state.chosen) || Number(b.kind !== 'api') - Number(a.kind !== 'api'));
    $('#pk-main').innerHTML = main.map(card).join('');
    $('#pk-install').innerHTML = install.map(card).join('');
    $('#pk-other').innerHTML = other.map(card).join('');
    $('#pk-install-sum').textContent = `Install another agent (${install.length})`;
    $('#pk-other-sum').textContent = `${other.length} more in the registry that cannot be installed from here yet`;
    const chosen = providers.find((p) => p.id === state.chosen);
    $('#pk-current').innerHTML = !state.chosen
      ? `<strong>No agent chosen yet.</strong> Pick one below — Use it — and it is remembered.`
      : state.connected === state.chosen
        ? `<strong>${esc(chosen?.name ?? state.chosen)}</strong> is connected in the course folder.`
        : state.hasFolder
          ? `<strong>${esc(chosen?.name ?? state.chosen)}</strong> is the chosen agent${chosen && !chosen.installed && chosen.kind !== 'api' ? ', but it is not installed here' : ''}.`
          : `<strong>${esc(chosen?.name ?? state.chosen)}</strong> is the chosen agent; it connects when a course folder is chosen.`;
    for (const input of host.querySelectorAll<HTMLInputElement>('input[data-key]')) {
      void keys.get(input.dataset.key!).then(
        (v) => {
          if (v && !input.value) input.value = v;
        },
        () => undefined,
      );
    }
  }

  let loaded: Promise<void>;
  async function load(refresh = false): Promise<void> {
    try {
      const res = await sidecar.listProviders(dataDir, refresh);
      providers = res.providers;
      if (res.registry.error) cb.say(`registry: ${res.registry.error}`, true);
    } catch (err) {
      cb.say(String(err), true);
    }
    render();
    cb.onListed?.();
  }

  /** npm install into the agent's own prefix: a first install, or an update over the old one. */
  async function installNow(id: string): Promise<boolean> {
    progress.set(id, ['installing…']);
    render();
    let ok = false;
    try {
      const r = await sidecar.installProvider(dataDir, id);
      cb.say(`installed ${r.package} ${r.version}`);
      ok = true;
    } catch (err) {
      cb.say(err instanceof EngineError ? err.message : String(err), true);
    }
    progress.delete(id);
    await load();
    return ok;
  }
  loaded = load();

  function showAuth(result: ConnectResult): void {
    pending = result;
    auth.classList.remove('hidden');
    const name = result.agent?.name ?? providers.find((p) => p.id === result.provider)?.name ?? result.provider;
    const status = result.authStatus ? `${result.authStatus.label}` : 'Sign-in needed';
    // A method that takes a key (codex's "API Key") gets a field beside its button;
    // the key goes to the agent with the sign-in and is kept nowhere here.
    const takesKey = (m: ConnectResult['authMethods'][number]) => typeof m._meta === 'object' && m._meta !== null && 'api-key' in m._meta;
    const methods = result.authMethods.map((m) =>
      takesKey(m)
        ? `<span class="pk-key"><input type="password" data-login-key="${esc(m.id)}" placeholder="API key" autocomplete="off" aria-label="${esc(m.name)}"><button type="button" data-login="${esc(m.id)}" title="${esc(m.description ?? '')}">${esc(m.name)}</button></span>`
        : `<button type="button" data-login="${esc(m.id)}" title="${esc(m.description ?? '')}">${esc(m.name)}</button>`,
    );
    // Some agents sign in only through their own command (auggie): nothing to press here but Reconnect, after.
    const none = result.authMethods.length === 0 ? `<p class="hint">${esc(name)} offers no way to sign in from here. Sign in with its own command in a terminal (${esc(result.provider === 'auggie' ? 'auggie login' : `its login command`)}), then press Reconnect.</p>` : '';
    auth.innerHTML = `<div class="pname">${esc(name)} · ${esc(status)}</div>${none}
      <div class="pactions">${methods.join('')}${
        none ? `<button type="button" data-use="${esc(result.provider)}">Reconnect</button>` : ''
      }${result.session ? '<button type="button" data-skip="1" class="quiet">Continue anyway</button>' : ''}</div>`;
  }

  async function connect(id: string): Promise<boolean> {
    const cwd = courseDir();
    const p = providers.find((x) => x.id === id);
    if (!cwd) {
      cb.say(`${p?.name ?? id} will connect when a course folder is chosen`);
      return false;
    }
    const params: { provider: string; dataDir: string; cwd: string; apiKey?: string } = { provider: id, dataDir, cwd };
    if (p?.kind === 'api') {
      const input = host.querySelector<HTMLInputElement>(`input[data-key="${CSS.escape(id)}"]`);
      const key = input?.value.trim() || (await keys.get(id).catch(() => null)) || '';
      if (!key) {
        cb.say('enter an API key first', true);
        return false;
      }
      params.apiKey = key;
      await keys.set(id, key).catch(() => undefined);
    }
    cb.say(`connecting ${p?.name ?? id}…`);
    cb.onPhase?.('connecting');
    progress.set(id, ['connecting…']);
    render();
    try {
      const result = await sidecar.connect(params);
      progress.delete(id);
      // The session is rooted in the folder it was asked for; if the deck
      // changed while the agent started, it belongs to no deck on screen.
      if (courseDir() !== cwd) {
        void sidecar.disconnect(result.connectionId).catch(() => undefined);
        render();
        return false;
      }
      if (result.authRequired || (result.authStatus?.kind === 'none' && result.authMethods.length > 0)) {
        render();
        showAuth(result);
        cb.onPhase?.('sign-in');
        cb.say(result.authStatus?.label ?? 'sign-in needed');
        return false;
      }
      cb.onPhase?.(null);
      cb.onConnected(result);
      return true;
    } catch (err) {
      progress.delete(id);
      render();
      cb.onPhase?.('failed');
      cb.say(err instanceof EngineError ? err.message : String(err), true);
      return false;
    }
  }

  host.addEventListener('click', async (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('button');
    if (!t) return;
    if (t.id === 'refresh') return void load(true);
    const { install, update: updating, uninstall, use, login, skip } = t.dataset;
    if (install) {
      await installNow(install);
    } else if (updating) {
      const wasConnected = state.connected === updating;
      if (!(await cb.release(updating))) return;
      state.connected = null;
      // Back where it was: connected before, connected again, on the new version.
      if ((await installNow(updating)) && (wasConnected || (state.chosen === updating && state.hasFolder))) await connect(updating);
    } else if (uninstall) {
      if (!(await cb.release(uninstall))) return;
      state.connected = state.connected === uninstall ? null : state.connected;
      await sidecar.uninstallProvider(dataDir, uninstall).catch(() => undefined);
      await load();
    } else if (use) {
      state.chosen = use;
      cb.onChosen(use);
      render();
      await connect(use);
    } else if (login && pending) {
      log.classList.remove('hidden');
      log.textContent = '';
      cb.say('signing in — finish in the browser window that opens…');
      try {
        const key = host.querySelector<HTMLInputElement>(`input[data-login-key="${CSS.escape(login)}"]`)?.value.trim();
        const r = await sidecar.login(pending.connectionId, login, key || undefined);
        if (r.authenticated && r.session) {
          cb.say('signed in');
          auth.classList.add('hidden');
          cb.onConnected({ ...pending, ...r, session: r.session, authRequired: false } as ConnectResult);
        } else {
          cb.say(`sign-in did not complete (exit ${r.exitCode})`, true);
        }
      } catch (err) {
        cb.say(err instanceof EngineError ? err.message : String(err), true);
      }
    } else if (skip && pending?.session) {
      cb.onConnected(pending);
    }
  });

  // Through the bus, never the client directly: the host holds ONE
  // notification handler, so registering here would silently replace the
  // chat pane's and the stage runner's.
  bus.onNotification((method, params) => {
    if (method === 'agents/progress') {
      const p = params as { id: string; line: string };
      const lines = progress.get(p.id) ?? [];
      lines.push(p.line);
      progress.set(p.id, lines);
      render();
    } else if (method === 'agent/loginOutput') {
      const p = params as { line: string };
      log.textContent += `${p.line}\n`;
      log.scrollTop = log.scrollHeight;
    }
  });

  return {
    ready: loaded,
    async connectIfInstalled(id) {
      await loaded;
      const p = providers.find((x) => x.id === id);
      if (!p || (!p.installed && p.kind !== 'api')) return false;
      if (p.kind === 'api' && !(await keys.get(id).catch(() => null))) return false;
      return connect(id);
    },
    setState(s) {
      Object.assign(state, s);
      render();
    },
    nameOf(id) {
      return providers.find((p) => p.id === id)?.name ?? null;
    },
    updateFor(id) {
      return update(providers.find((p) => p.id === id));
    },
  };
}
