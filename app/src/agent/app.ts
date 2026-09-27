// The shell: docs/APP.md's one window. The rail on the left holds the deck's
// name, the eight steps and Settings; the main pane is card generation --
// the materials the person added, the bar that says what is next, the
// artifact gate, the agent's live output, the deck preview at step 6 --
// and, with no deck open, the list of decks. A deck is a workspace the app
// owns, one folder per deck under its data dir; files are added by dropping
// them on the window or from a picker. The agent is a setting: chosen once
// in Settings, remembered, connected on its own whenever a deck is opened,
// because its session is opened in the deck's folder.
//
// A class is a workspace too: a folder whose decks share a syllabus. Its
// own course folder holds the syllabus and the brief written from it, its
// agent session is opened there, and the bar runs its one step
// (class-steps.ts) instead of the deck's eight.
//
// The library is seen one of two ways, switched at the top of the rail:
// Decks, the folders as Anki has them and nothing about school; or School,
// semesters and their classes (school.ts). Someone who only wants cards
// never sees a class.
//
// It is the same code in the desktop app and on the tool page when
// `ape-bridge` opens it -- the host (engine/host.ts) is what differs. The
// deck view is injected, because that is the one thing the two shells do
// differently: the desktop app loads, checks, renders and exports through
// the sidecar's deck/* methods on the Node engine; the tool page does all
// of that in the tab on the engine it already carries.

import { toBase64 } from '../engine/bytes.js';
import { EngineError, makeSidecarClient, type ClassSummary, type ConnectResult, type CourseClass, type DeckSummary, type EngineHost, type Semester, type SidecarClient, type SendToAnkiResult } from '../engine/client.js';
import { makeBus } from './bus.js';
import { mountChat, type Chat } from './chat.js';
import { mountClassPane, type ClassPane } from './class-pane.js';
import { mountClassSteps, type ClassSteps } from './class-steps.js';
import { extractMaterials } from './extract.js';
import { mountHome, type Home } from './home.js';
import { mountMaterials, type Materials } from './materials.js';
import { mountFallbackPermissions } from './permission-any.js';
import { mountPicker, type KeyStore, type Picker } from './picker.js';
import { mountSchool, type NewClass, type School } from './school.js';
import { mountSettings, type Settings } from './settings.js';
import { mountStages, type Stages } from './stages.js';

/** The deck half of the window: everything from "deck.json is there" to the .apkg. */
export interface DeckView {
  /** Shows or hides the deck panes; when hidden, the agent pane has the main area. */
  show(visible: boolean): void;
  /** Loads `<courseDir>/deck.json`: the checks, the card preview, the owner's flags. Reports its own failures. */
  open(courseDir: string): Promise<void>;
  /** Exports `<courseDir>/deck.json`; the path written, or null when it was saved some other way (a download) or failed. Reports its own failures. */
  export(courseDir: string): Promise<string | null>;
  /** Puts `<courseDir>/deck.json` into the running Anki; null when it failed (Anki closed, most often). Reports its own failures. */
  sendToAnki(courseDir: string): Promise<SendToAnkiResult | null>;
}

export interface AgentAppOptions {
  rail: HTMLElement;
  /** The next-step bar's element, above the main pane's views. */
  bar: HTMLElement;
  /** The main pane's container for everything but the deck view: home, settings, materials, the gate and the agent's output. */
  view: HTMLElement;
  deck: DeckView;
  /** Where an API key entered in Settings is kept: the OS keychain on the desktop, the tab on the site. */
  keys: KeyStore;
  /** A native file dialog returning paths, where the shell has one; without it, a file input whose bytes go through the sidecar. */
  pickFiles?: (title: string) => Promise<string[] | null>;
}

export interface AgentApp {
  courseDir(): string | null;
  /** Files by path (a drop on the desktop window): into the open deck, or into a new deck named after them. */
  addPaths(paths: string[]): Promise<void>;
  /** Files by content (a browser drop or file input): same. */
  addFiles(files: File[]): Promise<void>;
  /** The one status line, for the shell's own messages too (an update). */
  say(text: string, isError?: boolean): void;
  dispose(): Promise<void>;
}

const REMEMBER = { deck: 'ape.deck', agent: 'ape.agent', mode: 'ape.mode', view: 'ape.view', name: (dir: string) => `ape.name:${dir}` };
const remember = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string | null): void => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* a webview with storage blocked: the app still works, it just forgets */
    }
  },
};

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function basename(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p;
}

export function mountAgentApp(host: EngineHost, opts: AgentAppOptions): AgentApp {
  const { rail, bar, view, deck } = opts;
  rail.innerHTML = `
    <h1>A.P.E.</h1>
    <div class="viewswitch" role="group" aria-label="How the library is shown"><button type="button" data-view="decks">Decks</button><button type="button" data-view="school">School</button></div>
    <label class="railhead" for="rail-deck">Deck</label>
    <input id="rail-deck" placeholder="Course::Lecture 3" autocomplete="off" title="What the deck is called in Anki. Two colons make a subdeck.">
    <section class="rail-class" id="rail-class" hidden>
      <div class="railhead">Class</div>
      <div class="rail-class-name" id="rail-class-name"></div>
    </section>
    <div id="rail-summary" class="muted"></div>
    <div class="railhead">Steps</div>
    <ol class="stages" id="stages"></ol>
    <section class="rail-class" id="rail-class-decks" hidden></section>
    <nav class="library" id="rail-library" aria-label="Folders" hidden></nav>
    <nav class="library" id="rail-school" aria-label="Classes" hidden></nav>
    <div class="railfoot">
      <div id="rail-agent" class="muted"></div>
      <button type="button" id="rail-settings" class="quiet">Settings</button>
      <div class="status" id="status"></div>
    </div>`;
  view.innerHTML = `<section class="home-pane" hidden></section><section class="school-pane" hidden></section><section class="settings-pane" hidden></section><section class="class-pane" hidden></section><section class="materials" hidden></section><section class="class-brief" hidden></section><section class="class-more" hidden></section><section class="gate" hidden></section><section class="agent-host" hidden></section>`;
  bar.className = 'nextbar';
  bar.hidden = true;
  // The way out of a deck, where the eye is when it wants out: above the
  // next-step bar, naming where the deck sits, as Anki does.
  const crumb = document.createElement('nav');
  crumb.className = 'crumb';
  crumb.setAttribute('aria-label', 'Where you are');
  crumb.hidden = true;
  bar.before(crumb);
  const $ = <T extends HTMLElement>(root: HTMLElement, sel: string): T => root.querySelector<T>(sel)!;
  const status = $<HTMLElement>(rail, '#status');
  const say = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle('error', isError);
  };
  const homeEl = $<HTMLElement>(view, '.home-pane');
  const schoolEl = $<HTMLElement>(view, '.school-pane');
  // Decks or School: the one chosen is remembered, and anyone who never switches never sees School.
  let libraryView: 'decks' | 'school' = remember.get(REMEMBER.view) === 'school' ? 'school' : 'decks';
  const viewSwitch = $<HTMLElement>(rail, '.viewswitch');
  const settingsEl = $<HTMLElement>(view, '.settings-pane');
  const materialsEl = $<HTMLElement>(view, '.materials');
  const gate = $<HTMLElement>(view, '.gate');
  const agentHost = $<HTMLElement>(view, '.agent-host');
  const classPaneEl = $<HTMLElement>(view, '.class-pane');
  const classBriefEl = $<HTMLElement>(view, '.class-brief');
  const classMoreEl = $<HTMLElement>(view, '.class-more');
  const deckInput = $<HTMLInputElement>(rail, '#rail-deck');
  const railSummary = $<HTMLElement>(rail, '#rail-summary');
  const railClass = $<HTMLElement>(rail, '#rail-class');
  const railClassDecks = $<HTMLElement>(rail, '#rail-class-decks');
  // The deck's own: its name, its steps. A class open in its place shows its own (#rail-class).
  const railDeckBits = [...rail.querySelectorAll<HTMLElement>(':scope > .railhead, :scope > .stages, :scope > #rail-deck')];

  // ---- the engine, wherever it is running -------------------------------------
  const sidecar: SidecarClient = makeSidecarClient(host);
  const bus = makeBus(sidecar);
  // A dev build's engine respawns itself when dist/ is rebuilt under it
  // (sidecar.rs). Everything the shell held on the old process is gone --
  // the agent connection first -- so start over, as a code change does.
  bus.onNotification((method) => {
    if (method === 'engine/restarted') location.reload();
  });
  const decksRoot = `${host.dataDir().replace(/[\\/]$/, '')}/decks`;

  // ---- screens ---------------------------------------------------------------
  type Screen = 'home' | 'settings' | 'agent' | 'deck';
  let screen: Screen = 'home';
  let before: Screen = 'home';
  function show(name: Screen): void {
    if (name !== 'settings') before = name;
    screen = name;
    view.hidden = name === 'deck';
    homeEl.hidden = name !== 'home' || libraryView !== 'decks';
    schoolEl.hidden = name !== 'home' || libraryView !== 'school';
    for (const b of viewSwitch.querySelectorAll<HTMLButtonElement>('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === libraryView));
    settingsEl.hidden = name !== 'settings';
    materialsEl.hidden = name !== 'agent';
    syncClassPane();
    gate.hidden = name !== 'agent' || gate.innerHTML === '';
    agentHost.hidden = name !== 'agent';
    // A class has no next-step bar: its docs and brief are an option, and its decks are what it is for.
    crumb.hidden = !(name === 'agent' || name === 'deck') || !courseDir;
    bar.hidden = crumb.hidden || !!openClass;
    renderCrumb();
    // On the deck list no deck is being worked on, so the rail does not name
    // one. The deck stays open behind it -- its agent connected -- and is
    // marked in the list; opening it again is instant.
    const inside = !!courseDir && name !== 'home';
    for (const el of railDeckBits) el.hidden = !inside || !!openClass;
    railSummary.hidden = !inside;
    railClass.hidden = railClassDecks.hidden = !inside || !openClass;
    $<HTMLElement>(rail, '#rail-library').hidden = name !== 'home' || libraryView !== 'decks';
    $<HTMLElement>(rail, '#rail-school').hidden = name !== 'home' || libraryView !== 'school';
    home.setOpen(courseDir);
    school.setOpen(courseDir);
    settings.setSchool(libraryView === 'school');
    deck.show(name === 'deck');
    if (name === 'home') void refreshHome();
  }

  /**
   * Back goes up the way the person came down: a class to School, a deck in
   * a class to that class (in the School view), any other deck to Decks.
   */
  function up(): { label: string; go: () => void } {
    if (openClass) return { label: 'School', go: () => showLibrary('school') };
    if (deckClass && libraryView === 'school') {
      const cls = deckClass;
      return { label: cls.folder.split('::').pop()!, go: () => void openWorkspace(cls.path, cls.folder) };
    }
    return { label: libraryView === 'school' ? 'School' : 'Decks', go: () => show('home') };
  }

  /**
   * The class pane shows on the workspace screen, when it has something: a
   * class's decks and exams, or a deck's class. On a class its papers come
   * first -- they are what everything else there is made from; on a deck the
   * class's strip sits above the lecture's files.
   */
  function syncClassPane(): void {
    const here = screen === 'agent';
    classPaneEl.hidden = !here || classPaneEl.innerHTML === '';
    // The brief's line is empty when there is nothing to say, and then takes no room (:empty).
    classMoreEl.hidden = classBriefEl.hidden = !here || !openClass;
    // A class: its decks, then its docs and the brief's line, then its exams. A deck: its class's strip over its files.
    const order = [classPaneEl, materialsEl, classBriefEl, classMoreEl];
    for (let i = 1; i < order.length; i += 1) if (order[i - 1]!.nextElementSibling !== order[i]) order[i - 1]!.after(order[i]!);
  }

  function renderCrumb(): void {
    const back = `<button type="button" class="crumb-back" title="Back (⌘[)">← ${esc(up().label)}</button>`;
    if (openClass) {
      crumb.innerHTML = `${back}<span class="crumb-path"><span class="dclass">class</span> <strong>${esc(openClass.folder)}</strong></span>`;
      return;
    }
    const segs = deckName.split('::');
    const leaf = segs.pop() ?? '';
    crumb.innerHTML = back + `<span class="crumb-path">${segs.map((s) => `<span class="crumb-folder">${esc(s)}</span><i>::</i>`).join('')}<strong>${esc(leaf)}</strong></span>`;
  }
  crumb.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('.crumb-back')) up().go();
  });
  // ⌘[ (Ctrl+[ elsewhere) is back, as in a browser or Finder.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === '[' && !crumb.hidden) {
      e.preventDefault();
      up().go();
    }
  });

  /** The library, seen as Decks or as School; the choice is kept. */
  function showLibrary(v: 'decks' | 'school'): void {
    libraryView = v;
    remember.set(REMEMBER.view, v);
    show('home');
  }
  viewSwitch.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-view]');
    if (b) showLibrary(b.dataset.view as 'decks' | 'school');
  });

  // ---- the deck: a workspace -----------------------------------------------------
  let courseDir: string | null = null;
  let connection: ConnectResult | null = null;
  let chat: Chat | null = null;
  /** The class open as the workspace, or null while a deck (or nothing) is. courseDir is its folder. */
  let openClass: ClassSummary | null = null;
  /** The class the open deck is in, as its folder last said; null for a deck in none. */
  let deckClass: CourseClass | null = null;
  /** The decks and semesters as last listed, for the class's rail and its semester picker. */
  let lastDecks: DeckSummary[] = [];
  let lastSemesters: Semester[] = [];
  /** Whichever steps the open workspace has: a deck's eight, or a class's one. */
  const steps = (): { busy(): string | null; refresh(): Promise<void>; setConnection(c: ConnectResult | null): void; note(): string; act: Stages['act'] } => (openClass ? classSteps : stages);
  const busyNow = (): string | null => stages.busy() ?? classSteps.busy();
  const inFolder = (name: string, folder: string): boolean => name === folder || name.startsWith(`${folder}::`);

  // A deck under the decks root keeps its name in its own folder, so the
  // list, the rail and Anki agree; a folder the bridge was opened on is not
  // the app's to write a record into, and keeps the older way: this window's
  // storage.
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const inRoot = (dir: string): boolean => norm(dir).replace(/\/[^/]*$/, '') === norm(decksRoot);
  let deckName = '';

  async function renameDeck(dir: string, name: string): Promise<string | null> {
    // A run reads the deck's name into its prompt and writes deck.json; a
    // rename rewrites deck.json. Not both at once.
    const running = dir === courseDir ? stages.busy() : null;
    if (running) {
      say(`${running} is still running — rename the deck when it has finished`, true);
      return null;
    }
    try {
      if (!inRoot(dir)) {
        remember.set(REMEMBER.name(dir), name);
        return name;
      }
      const r = await sidecar.renameDeck(decksRoot, dir, name);
      remember.set(REMEMBER.name(dir), null);
      if (r.moved) say(`${r.moved} card${r.moved === 1 ? '' : 's'} now go to ${r.name}`);
      if (dir === courseDir) {
        deckName = deckInput.value = r.name;
        renderCrumb();
        if (screen === 'deck') await deck.open(dir);
      }
      return r.name;
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
      return null;
    }
  }

  deckInput.addEventListener('change', () => {
    if (!courseDir) return;
    const name = deckInput.value.trim();
    if (!name || name === deckName) {
      deckInput.value = deckName;
      return;
    }
    const dir = courseDir;
    void renameDeck(dir, name).then((named) => {
      if (!named && dir === courseDir) deckInput.value = deckName;
    });
  });

  async function refreshHome(): Promise<void> {
    try {
      let { decks, folders, classes, semesters } = await sidecar.listDecks(decksRoot);
      // Names given before decks kept their own were kept in this window's
      // storage. Written into the deck the first time it is listed, unless
      // it has cards: those already say which deck they go to.
      let adopted = false;
      for (const d of decks) {
        const kept = remember.get(REMEMBER.name(d.path));
        if (kept === null) continue;
        remember.set(REMEMBER.name(d.path), null);
        if (kept && kept !== d.name && !d.artifacts.deck) adopted = (await sidecar.renameDeck(decksRoot, d.path, kept).then(() => true, () => false)) || adopted;
      }
      if (adopted) ({ decks, folders, classes, semesters } = await sidecar.listDecks(decksRoot));
      lastDecks = decks;
      lastSemesters = semesters ?? [];
      home.setDecks(decks, folders ?? []);
      school.set(decks, folders ?? [], classes ?? [], lastSemesters);
      renderClassRail();
      if (openClass) {
        classPane.showClass(openClass);
        syncClassPane();
      }
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  /** Lets go of the open deck: its agent session, its place in the rail. */
  async function closeWorkspace(): Promise<void> {
    if (chat) {
      // The agent's session was opened in the old folder; a new folder is a new session.
      await chat.dispose();
      chat = null;
      connection = null;
      stages.setConnection(null);
      classSteps.setConnection(null);
      picker.setState({ connected: null });
    }
    courseDir = null;
    openClass = null;
    deckClass = null;
    classPane.hide();
    gate.innerHTML = '';
    gate.hidden = true;
    materials.setKind('deck');
    deckName = deckInput.value = '';
    materials.hideNotice();
    home.setOpen(null);
    remember.set(REMEMBER.deck, null);
    picker.setState({ hasFolder: false });
    showAgentLine();
  }

  async function deleteDeck(d: DeckSummary): Promise<void> {
    if (d.path === courseDir) {
      const running = stages.busy();
      if (running) {
        say(`${running} is still running in ${d.name} — stop it or let it finish first`, true);
        return;
      }
      await closeWorkspace();
    }
    try {
      const { trashed } = await sidecar.deleteDeck(decksRoot, d.path);
      await refreshHome();
      home.notify(`Deleted ${d.name}. Its files are kept for 30 days; nothing in Anki is touched.`, {
        label: 'Undo',
        run: () =>
          void sidecar
            .restoreDeck(decksRoot, trashed)
            .then((r) => {
              home.notify(`Restored ${r.name}.`);
              return refreshHome();
            })
            .catch((err: unknown) => say(err instanceof EngineError ? err.message : String(err), true)),
      });
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  async function refreshMaterials(): Promise<void> {
    if (!courseDir) return;
    try {
      const dir = courseDir;
      const { files, extracted, class: cls } = await sidecar.listCourse(dir);
      if (dir !== courseDir) return;
      const material = files.filter((f) => f.kind !== 'other');
      materials.set(material, extracted);
      if (openClass) classChanged(cls ?? openClass);
      else {
        const was = deckClass?.path ?? null;
        deckClass = cls ?? null;
        classPane.showDeck(deckClass, dir);
        if ((deckClass?.path ?? null) !== was) renderCrumb();
      }
      syncClassPane();
      const pdfs = material.filter((f) => f.kind === 'pdf').length;
      $<HTMLElement>(rail, '#rail-summary').textContent = material.length ? `${material.length} file${material.length === 1 ? '' : 's'}${pdfs ? `, ${pdfs} PDF${pdfs === 1 ? '' : 's'}` : ''}` : 'no files yet';
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  /**
   * Opens a deck's folder: the materials, the steps, and the chosen agent
   * connected in it. `quiet` is for the deck remembered from last time, which
   * may simply be gone -- renamed, deleted, on a disk that is not mounted.
   * That is not a failure the person caused and should not be shouted at them
   * in red on a screen they did not ask for.
   */
  async function openWorkspace(dir: string, name: string, quiet = false): Promise<boolean> {
    if (dir === courseDir) {
      show('agent');
      return true;
    }
    // A run belongs to the deck it started in: its results, its Stop and a
    // run-through's next stage all read "the current deck", so the deck does
    // not change under it.
    const running = busyNow();
    if (running) {
      say(`${running} is still running in ${openClass?.folder ?? (deckInput.value.trim() || 'this deck')} — stop it or let it finish first`, true);
      return false;
    }
    let named: string | null = null;
    let cls: CourseClass | null = null;
    try {
      ({ name: named, class: cls = null } = await sidecar.listCourse(dir));
    } catch (err) {
      if (quiet) say(`${basename(dir)} is not there any more — pick a deck, or start a new one`);
      else say(err instanceof EngineError ? err.message : String(err), true);
      return false;
    }
    await closeWorkspace();
    courseDir = dir;
    remember.set(REMEMBER.deck, dir);
    // A class's own folder is listed as its own class; a deck's, as the class it is in.
    if (cls && norm(cls.path) === norm(dir)) {
      openClass = cls;
      // A class lives in School; the switch says so, and back leads there.
      libraryView = 'school';
      remember.set(REMEMBER.view, 'school');
      deckName = cls.folder;
      materials.setKind('class');
      classPane.showClass(cls);
    } else deckName = deckInput.value = named ?? remember.get(REMEMBER.name(dir)) ?? name;
    renderCrumb();
    picker.setState({ hasFolder: true });
    show('agent');
    if (openClass) {
      if (!lastDecks.length) await refreshHome();
      renderClassRail();
    }
    await Promise.all([refreshMaterials(), steps().refresh()]);
    const chosen = remember.get(REMEMBER.agent);
    if (chosen) {
      const ok = await picker.connectIfInstalled(chosen);
      if (!ok && !connection) say(`${picker.nameOf(chosen) ?? chosen} could not be connected — see Settings`, true);
    } else {
      say('no agent chosen yet — the first step will send you to Settings');
    }
    return true;
  }

  async function newDeck(name: string): Promise<string | null> {
    try {
      const made = await sidecar.createDeck(decksRoot, name);
      await openWorkspace(made.path, made.name);
      return made.path;
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
      return null;
    }
  }

  // ---- adding and removing materials ----------------------------------------------
  async function addPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    if (!courseDir && !(await newDeck(basename(paths[0]!).replace(/\.[^.]+$/, '')))) return;
    try {
      const { imported } = await sidecar.importCourse(courseDir!, paths);
      say(imported.length ? `added ${imported.length} file${imported.length === 1 ? '' : 's'}` : 'nothing to add from that');
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
    await Promise.all([refreshMaterials(), steps().refresh()]);
  }
  async function addFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    if (!courseDir && !(await newDeck(files[0]!.name.replace(/\.[^.]+$/, '')))) return;
    let added = 0;
    for (const file of files) {
      try {
        say(`adding ${file.name}…`);
        await sidecar.writeCourse(courseDir!, file.name, { base64: toBase64(new Uint8Array(await file.arrayBuffer())) });
        added += 1;
      } catch (err) {
        say(err instanceof EngineError ? err.message : String(err), true);
      }
    }
    if (added) say(`added ${added} file${added === 1 ? '' : 's'}`);
    await Promise.all([refreshMaterials(), steps().refresh()]);
  }
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    void addFiles([...(fileInput.files ?? [])]);
    fileInput.value = '';
  });
  view.append(fileInput);
  function askForFiles(): void {
    if (opts.pickFiles) {
      void opts.pickFiles(openClass ? `Add docs to ${openClass.folder}` : 'Add lecture files').then((paths) => {
        if (paths) void addPaths(paths);
      });
    } else fileInput.click();
  }
  // A browser drop anywhere: files by content. (The desktop webview hands
  // drops to Rust instead, and main.ts calls addPaths with the paths.)
  for (const type of ['dragenter', 'dragover'] as const) document.addEventListener(type, (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) void addFiles(files);
  });
  const materials: Materials = mountMaterials(materialsEl, {
    onAdd: askForFiles,
    onRemove(relPath) {
      if (!courseDir) return;
      const dir = courseDir;
      const name = basename(relPath);
      const refresh = () => (dir === courseDir ? Promise.all([refreshMaterials(), steps().refresh()]) : undefined);
      const failed = (err: unknown) => say(err instanceof EngineError ? err.message : String(err), true);
      void sidecar
        .deleteCourse(dir, relPath, { trash: true })
        .then(async ({ trashed }) => {
          await refresh();
          if (!trashed || dir !== courseDir) return;
          materials.notify(`Removed ${name}. It is kept for 30 days.`, {
            label: 'Undo',
            run: () =>
              void sidecar
                .restoreCourse(dir, trashed)
                .then(async (r) => {
                  await refresh();
                  if (dir === courseDir) materials.notify(r.name === relPath ? `Put back ${name}.` : `Put back as ${r.name}: ${name} was added again meanwhile.`);
                })
                .catch(failed),
          });
        })
        .catch(failed);
    },
  });

  $<HTMLButtonElement>(rail, '#rail-settings').addEventListener('click', () => show('settings'));

  // ---- home, settings ----------------------------------------------------------
  const home: Home = mountHome(homeEl, {
    rail: $<HTMLElement>(rail, '#rail-library'),
    onNew: (name) => void newDeck(name),
    onOpen: (d) => void openWorkspace(d.path, d.name),
    onRename: async (d, name) => {
      const ok = (await renameDeck(d.path, name)) !== null;
      await refreshHome();
      return ok;
    },
    async onNewFolder(name) {
      try {
        const r = await sidecar.createFolder(decksRoot, name);
        await refreshHome();
        home.notify(`Made the folder ${r.name}.`);
        return true;
      } catch (err) {
        say(err instanceof EngineError ? err.message : String(err), true);
        return false;
      }
    },
    onDeleteFolder: (name) => deleteFolder(name, (text, action) => home.notify(text, action)),
    onRenameFolder: (from, to) => moveFolder(from, to).then(() => undefined),
    onDelete: deleteDeck,
    openSettings: () => show('settings'),
  });

  /** An empty folder, and any class or semester in it, with the way back; said in whichever view asked. */
  async function deleteFolder(name: string, notify: (text: string, action?: { label: string; run(): void }) => void): Promise<void> {
    // A class in it goes to the trash; its folder is not left open behind the list.
    if (openClass && inFolder(openClass.folder, name)) {
      const running = busyNow();
      if (running) return say(`${running} is still running in ${openClass.folder} — stop it or let it finish first`, true);
      await closeWorkspace();
    }
    try {
      const { removed, classes = [], semesters = [] } = await sidecar.deleteFolder(decksRoot, name);
      await refreshHome();
      notify(`Deleted ${semesters.some((t) => t.folder === name) ? 'the semester' : 'the folder'} ${name}.${classes.length ? ' Its class docs are kept for 30 days.' : ''}`, {
        label: 'Undo',
        run: () =>
          void (async () => {
            for (const f of removed) await sidecar.createFolder(decksRoot, f);
            for (const t of semesters) await sidecar.createSemester(decksRoot, t.folder, t.start, t.end);
            for (const t of classes) await sidecar.restoreClass(decksRoot, t);
            await refreshHome();
          })().catch((err: unknown) => say(err instanceof EngineError ? err.message : String(err), true)),
      });
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  // ---- the School view ------------------------------------------------------------
  /** A class made from the School view: a semester first when it asks for a new one, a folder moved into the semester when it came from one. */
  async function newClass(spec: NewClass): Promise<boolean> {
    try {
      if (spec.newSemester && !lastSemesters.some((t) => t.folder === spec.newSemester!.folder)) {
        const { newSemester: t } = spec;
        await sidecar.createSemester(decksRoot, t.folder, t.start, t.end);
      }
      let folder: string;
      if (spec.fromFolder) {
        folder = spec.fromFolder;
        const leaf = folder.split('::').pop()!;
        const into = spec.semester ? `${spec.semester}::${leaf}` : folder;
        if (into !== folder) {
          if (!(await moveFolder(folder, into))) return false;
          folder = into;
        }
      } else folder = spec.semester ? `${spec.semester}::${spec.name}` : spec.name!;
      const cls = await sidecar.createClass(decksRoot, folder);
      await refreshHome();
      await openWorkspace(cls.path, cls.folder);
      say(`${cls.folder} is a class — add its syllabus`);
      return true;
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
      await refreshHome();
      return false;
    }
  }

  const school: School = mountSchool(schoolEl, {
    rail: $<HTMLElement>(rail, '#rail-school'),
    onOpenClass: (cls) => void openWorkspace(cls.path, cls.folder),
    onNewClass: newClass,
    onRenameFolder: (from, to) => moveFolder(from, to).then(() => undefined),
    onDeleteFolder: (name) => deleteFolder(name, (text, action) => school.notify(text, action)),
    showDecks: () => showLibrary('decks'),
    async onMakeSemester(folder, start, end) {
      try {
        const { semester } = await sidecar.createSemester(decksRoot, folder, start, end);
        await refreshHome();
        school.notify(`${semester.folder} is a semester. Add its classes with + New class.`);
        return true;
      } catch (err) {
        say(err instanceof EngineError ? err.message : String(err), true);
        return false;
      }
    },
    async onSemesterDates(folder, start, end) {
      try {
        await sidecar.updateSemester(decksRoot, folder, start, end);
        await refreshHome();
        return true;
      } catch (err) {
        say(err instanceof EngineError ? err.message : String(err), true);
        return false;
      }
    },
    async onUnsemester(folder) {
      try {
        const { removed } = await sidecar.removeSemester(decksRoot, folder);
        await refreshHome();
        school.notify(`${folder} is a plain folder again; its classes and decks are where they were.`, {
          label: 'Undo',
          run: () =>
            void sidecar
              .createSemester(decksRoot, removed.folder, removed.start, removed.end)
              .then(() => refreshHome())
              .catch((err: unknown) => say(err instanceof EngineError ? err.message : String(err), true)),
        });
      } catch (err) {
        say(err instanceof EngineError ? err.message : String(err), true);
      }
    },
  });

  /**
   * A folder moved -- renamed, or a class taken to another semester: the
   * record first (the engine refuses a move that would nest classes or
   * semesters), then every deck beneath, each with its cards.
   */
  async function moveFolder(from: string, to: string): Promise<boolean> {
    const running = busyNow();
    if (running) {
      say(`${running} is still running — move the folder when it has finished`, true);
      return false;
    }
    try {
      await sidecar.renameFolder(decksRoot, from, to);
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
      return false;
    }
    const { decks } = await sidecar.listDecks(decksRoot);
    const inside = decks.filter((d) => d.name === from || d.name.startsWith(`${from}::`));
    let failed = 0;
    for (const d of inside) if ((await renameDeck(d.path, to + d.name.slice(from.length))) === null) failed += 1;
    // The open class follows its folder.
    if (openClass && courseDir) await refreshMaterials();
    await refreshHome();
    if (!failed) (libraryView === 'school' ? school : home).notify(`Moved ${inside.length} deck${inside.length === 1 ? '' : 's'} to ${to}.`);
    return failed === 0;
  }

  // ---- a class, when one is the workspace -----------------------------------------
  /** The open class's record changed (its exams, its brief): everything that shows it follows. */
  function classChanged(cls: ClassSummary): void {
    if (!openClass || norm(cls.path) !== norm(openClass.path)) return;
    const renamed = cls.folder !== openClass.folder;
    openClass = { folder: cls.folder, path: cls.path, exams: cls.exams, brief: cls.brief, files: cls.files, newPapers: cls.newPapers ?? [] };
    deckName = cls.folder;
    classPane.showClass(openClass);
    materials.markNew(openClass.newPapers ?? []);
    syncClassPane();
    if (renamed) renderCrumb();
    classSteps.redraw();
    renderClassRail();
  }

  /** The class's name and its decks, in the rail: the way into each. */
  function renderClassRail(): void {
    if (!openClass) return;
    const cls = openClass;
    $<HTMLElement>(rail, '#rail-class-name').textContent = cls.folder;
    const mine = lastDecks.filter((d) => inFolder(d.name, cls.folder)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const leaf = (n: string) => (n === cls.folder ? n.split('::').pop()! : n.slice(cls.folder.length + 2));
    railClassDecks.innerHTML =
      `<div class="railhead">Decks in it</div>` +
      (mine.length
        ? `<ul class="lib">${mine.map((d) => `<li><button type="button" data-class-deck="${esc(d.path)}" title="${esc(d.name)}"><span class="lname">${esc(leaf(d.name))}</span></button></li>`).join('')}</ul>`
        : '<p class="muted rail-class-empty">None yet.</p>') +
      `<button type="button" class="lnewfolder" data-class-new-deck>+ New deck</button>`;
  }
  railClassDecks.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>('[data-class-deck]');
    const d = b && lastDecks.find((x) => x.path === b.dataset.classDeck);
    if (d) return void openWorkspace(d.path, d.name);
    if (t.closest('[data-class-new-deck]')) classPane.focusNewDeck();
  });

  async function unclass(cls: ClassSummary): Promise<void> {
    const running = busyNow();
    if (running) return say(`${running} is still running — stop it or let it finish first`, true);
    const wasOpen = openClass && norm(openClass.path) === norm(cls.path);
    try {
      if (wasOpen) await closeWorkspace();
      // To the list first: the class's screen is gone, and the engine's answer is a round trip away.
      showLibrary('school');
      const { trashed } = await sidecar.removeClass(decksRoot, cls.path);
      await refreshHome();
      school.notify(`${cls.folder} is a plain folder again; its decks are as they were. Its docs and brief are kept for 30 days.`, {
        label: 'Undo',
        run: () =>
          void sidecar
            .restoreClass(decksRoot, trashed)
            .then(async (r) => {
              await refreshHome();
              school.notify(`${r.folder} is a class again.`);
            })
            .catch((err: unknown) => say(err instanceof EngineError ? err.message : String(err), true)),
      });
    } catch (err) {
      say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  const classPane: ClassPane = mountClassPane(classPaneEl, classMoreEl, {
    sidecar,
    decksRoot,
    say,
    changed: classChanged,
    deckChanged: (cls) => {
      if (cls?.exam) say(`studied for ${cls.exam.name}`);
      else if (cls) say('studied for no exam: organize is told no date');
    },
    openClass: (path) => void openWorkspace(path, path),
    unclass: (cls) => void unclass(cls),
    openSettings: () => show('settings'),
    semesters: () => lastSemesters,
    decks: () => lastDecks,
    openDeck: (d) => void openWorkspace(d.path, d.name),
    newDeck: (name) => void newDeck(name),
    // A class taken to another semester keeps its own name: "Fall 2026::Histology" -> "Spring 2027::Histology".
    async moveClass(cls, semester) {
      const leaf = cls.folder.split('::').pop()!;
      const to = semester ? `${semester}::${leaf}` : leaf;
      if (to === cls.folder) return true;
      const ok = await moveFolder(cls.folder, to);
      if (ok) say(`${leaf} is in ${semester || 'no semester'} now`);
      return ok;
    },
  });
  const settings: Settings = mountSettings(settingsEl, host, {
    onDone: () => show(before === 'settings' ? 'home' : before),
    say,
  });
  void sidecar.listMethod().then(
    (m) => settings.setMethodDir(m.dir),
    () => settings.setMethodDir(null),
  );

  // Prompts for sessions no chat pane owns -- the auditor's and the
  // adjudicator's. Without this their write permissions went unanswered.
  mountFallbackPermissions(view, sidecar, bus, () => courseDir);

  // ---- the agent, as a setting --------------------------------------------------
  function showAgentLine(): void {
    const chosen = remember.get(REMEMBER.agent);
    const name = chosen ? (picker.nameOf(chosen) ?? chosen) : null;
    // Said where it is seen every day: an agent is never updated on its own,
    // and Settings is a screen nobody opens once the agent works.
    const newer = chosen ? picker.updateFor(chosen) : null;
    $<HTMLElement>(rail, '#rail-agent').textContent =
      (!name ? 'No agent chosen' : connection ? `${name} · connected` : `${name} · not connected`) + (newer ? ` · update ${newer} in Settings` : '');
    home.setAgent(name);
  }
  let attaching: Promise<void> = Promise.resolve();
  const picker: Picker = mountPicker(settings.agentSlot, sidecar, bus, host.dataDir(), () => courseDir, opts.keys, {
    say,
    onListed: () => showAgentLine(),
    async release(id) {
      const running = busyNow();
      if (running) {
        say(`${running} is still running — change the agent when it has finished`, true);
        return false;
      }
      await attaching; // a connect that is landing now is let go of too, not left behind
      if (connection?.provider === id) {
        await chat?.dispose();
        chat = null;
        connection = null;
        stages.setConnection(null);
        classSteps.setConnection(null);
        picker.setState({ connected: null });
        showAgentLine();
      }
      return true;
    },
    onChosen(id) {
      remember.set(REMEMBER.agent, id);
      picker.setState({ chosen: id });
      showAgentLine();
    },
    onConnected(result) {
      if (!result.session || !courseDir) {
        say('connected but no session', true);
        return;
      }
      // One at a time: two connects finishing together (a double press, the
      // auto-connect meeting a Reconnect) both disposed the same old pane and
      // mounted a new one each, and the first new one was never closed.
      attaching = attaching.then(async () => {
        if (chat) await chat.dispose();
        // The adapter names itself by its package; the person chose "Claude Agent".
        const named: ConnectResult = { ...result, agent: { name: picker.nameOf(result.provider) ?? result.agent?.name ?? result.provider, version: result.agent?.version ?? '' } };
        connection = named;
        chat = mountChat(agentHost, sidecar, bus, named, say, () => courseDir, { get: () => remember.get(REMEMBER.mode), set: (id) => remember.set(REMEMBER.mode, id) }, { note: () => steps().note(), act: (d) => steps().act(d) });
        steps().setConnection(named);
        picker.setState({ connected: result.provider, chosen: result.provider });
        remember.set(REMEMBER.agent, result.provider);
        showAgentLine();
        say(`${named.agent!.name} ready`);
        if (screen === 'settings') show('agent');
        await steps().refresh();
      }).catch((err: unknown) => say(err instanceof EngineError ? err.message : String(err), true));
    },
  });
  picker.setState({ chosen: remember.get(REMEMBER.agent) });
  void picker.ready.then(showAgentLine);

  // ---- the steps ---------------------------------------------------------------
  // The runner gets a client whose newSession carries the chat pane's
  // selections over: the method's fresh auditor/adjudicator sessions must use
  // the model and mode the user picked, not the agent's defaults.
  const runnerClient: SidecarClient = {
    ...sidecar,
    newSession: async (connectionId: string) => {
      const r = await sidecar.newSession(connectionId);
      await chat?.applyConfigTo(r.session.sessionId);
      return r;
    },
  };
  const stages: Stages = mountStages($<HTMLOListElement>(rail, '#stages'), bar, gate, {
    sidecar: runnerClient,
    bus,
    // A class's folder is not a deck: the eight steps stand aside while one is open.
    courseDir: () => (openClass ? null : courseDir),
    deckName: () => deckInput.value.trim(),
    say,
    showAgentView: () => show('agent'),
    openDeck: async (dir) => {
      show('deck');
      await deck.open(dir);
    },
    exportDeck: async () => (courseDir ? deck.export(courseDir) : null),
    sendToAnki: async () => (courseDir ? deck.sendToAnki(courseDir) : null),
    prepareMaterials: async (dir) => {
      await extractMaterials(sidecar, host, dir, say);
      await refreshMaterials();
    },
    openSettings: () => show('settings'),
    hasMaterials: () => materials.count() > 0,
    addFiles: askForFiles,
  });
  const classSteps: ClassSteps = mountClassSteps(classBriefEl, gate, {
    sidecar: runnerClient,
    bus,
    decksRoot,
    current: () => openClass,
    say,
    showAgentView: () => show('agent'),
    prepareMaterials: async (dir) => {
      await extractMaterials(sidecar, host, dir, say);
      await refreshMaterials();
    },
    openSettings: () => show('settings'),
    hasMaterials: () => materials.count() > 0,
    addFiles: askForFiles,
    changed: classChanged,
  });

  // ---- start -------------------------------------------------------------------
  say(`engine ${host.info.version} on node ${host.info.node}`);
  show('home');
  showAgentLine();
  void (async () => {
    // The folder the host was opened on (ape-bridge's argument), else the deck from last time.
    const given = host.courseRoot();
    const last = remember.get(REMEMBER.deck);
    const first = given ?? last;
    // `given` was asked for on the command line, so its failure is worth
    // saying plainly; `last` is just where we were, and may be long gone.
    if (first && !(await openWorkspace(first, basename(first), first === last && !given))) {
      remember.set(REMEMBER.deck, null);
      show('home');
    }
    showAgentLine();
  })();

  const dispose = async (): Promise<void> => {
    await chat?.dispose();
    host.close();
  };
  window.addEventListener('beforeunload', () => void dispose());

  return {
    courseDir: () => courseDir,
    addPaths,
    addFiles,
    say,
    dispose,
  };
}

export { EngineError, esc };
export type { DeckSummary };
