// A class's one step, as a line under its docs and the gate while a class is open: the
// agent reads the class's own papers -- the syllabus, exam guides, the
// schedule -- into class.md, which every deck in the class is then given,
// and names the exams it found in exams.json, which join the class's exams
// for the person to check. Nothing here is a card; the deck steps are
// stages.ts's, and do not run while a class is open.

import { CLASS_STAGE, classUpdateStage, makeRunner, type Runner } from '../../../dist/pipeline/index.js';
import { EngineError, type ClassSummary, type ConnectResult, type SidecarClient } from '../engine/client.js';
import type { Bus } from './bus.js';
import { mergeExams, parseFoundExams, shortDate } from './class-rules.js';
import type { Directive } from './steps-note.js';

const QUIET_MS = 60_000;
const STALLED_MS = 240_000;

export interface ClassStepsHost {
  sidecar: SidecarClient;
  bus: Bus;
  decksRoot: string;
  /** The class that is open, or null while a deck (or nothing) is. */
  current(): ClassSummary | null;
  say(text: string, isError?: boolean): void;
  showAgentView(): void;
  /** Extracts text and page images beside every PDF that has none yet. */
  prepareMaterials(dir: string): Promise<void>;
  openSettings(): void;
  hasMaterials(): boolean;
  addFiles(): void;
  /** The class's record changed -- its exams, its brief -- as the engine now has it. */
  changed(summary: ClassSummary): void;
}

export interface ClassSteps {
  setConnection(conn: ConnectResult | null): void;
  /** Re-reads the class and redraws the line; takes in exams.json if the agent wrote one since. */
  refresh(): Promise<void>;
  busy(): string | null;
  /** What the agent is told in the chat while a class is open. */
  note(): string;
  /** Draws the line again: the class changed under it. */
  redraw(): void;
  act(d: Directive): Promise<string>;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function human(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function mountClassSteps(line: HTMLElement, gate: HTMLElement, host: ClassStepsHost): ClassSteps {
  const { sidecar } = host;
  let conn: ConnectResult | null = null;
  let runner: Runner | null = null;
  let runnerFor: string | null = null;
  let busy: string | null = null;
  let stopRequested = false;
  let startedAt = 0;
  let lastHeard = 0;
  let ticker: number | null = null;
  /** Whether the gate is showing class.md, so the line's second press is the approval. */
  let showing = false;

  host.bus.onNotification((method) => {
    if (busy && method === 'agent/update') lastHeard = Date.now();
  });

  /** The runner for the open class, made when first needed: its session was opened in the class's folder. */
  function runnerOf(cls: ClassSummary): Runner | null {
    if (!conn?.session) return null;
    if (!runner || runnerFor !== cls.path) {
      runner = makeRunner(sidecar, conn, cls.path, () => host.current()?.folder ?? cls.folder, note);
      runnerFor = cls.path;
    }
    return runner;
  }

  function setBusy(label: string | null): void {
    busy = label;
    if (label !== null) stopRequested = false;
    startedAt = label === null ? 0 : Date.now();
    lastHeard = startedAt;
    if (ticker !== null) clearInterval(ticker);
    ticker = label === null ? null : (setInterval(tick, 1000) as unknown as number);
    render();
  }

  function tick(): void {
    if (!busy) return;
    const now = Date.now();
    const elapsed = line.querySelector<HTMLElement>('.nb-elapsed');
    const idle = line.querySelector<HTMLElement>('.nb-idle');
    if (elapsed) elapsed.textContent = human(now - startedAt);
    if (!idle) return;
    const quiet = now - lastHeard;
    idle.textContent = quiet < QUIET_MS ? '' : `nothing heard for ${human(quiet)}`;
    idle.classList.toggle('stalled', quiet >= STALLED_MS);
  }

  /**
   * The brief's one line, under the class's docs: what state it is in and
   * the one thing to do about it. Small on purpose -- a class's docs and its
   * brief are an option, not the page; its decks are.
   */
  function render(): void {
    const cls = host.current();
    if (!cls) return;
    if (busy) {
      line.innerHTML = `<span class="nb-spin" aria-hidden="true"></span><span class="cb-text"><strong>${esc(busy)}…</strong> <span class="nb-elapsed">0s</span> <span class="nb-idle"></span></span><button type="button" data-stop="1" class="quiet">Stop</button>`;
      tick();
      return;
    }
    const fresh = cls.newPapers ?? [];
    const agent = !!conn?.session;
    const docs = cls.files;
    let text = '';
    let buttons = '';
    if (!docs && cls.brief === 'none') text = '';
    else if (!agent && (cls.brief === 'none' || fresh.length)) {
      text = cls.brief === 'none' ? 'An agent writes the brief from these docs.' : `${fresh.length} doc${fresh.length === 1 ? '' : 's'} not in the brief yet.`;
      buttons = '<button type="button" data-settings="1" class="quiet">Set up an agent</button>';
    } else if (cls.brief === 'none') {
      text = `No brief yet.`;
      buttons = '<button type="button" data-run="1">Write the brief</button>';
    } else if (fresh.length) {
      text = `${fresh.length === 1 ? esc(fresh[0]!) : `${fresh.length} docs`} not in the brief yet.`;
      buttons = `<button type="button" data-update="1">Update the brief</button>`;
    } else if (cls.brief === 'written') {
      text = showing ? 'Anything wrong, tell the agent below.' : 'Brief written — read it before decks use it.';
      buttons = `<button type="button" data-${showing ? 'approve' : 'read'}="1">${showing ? 'Looks right' : 'Read the brief'}</button>`;
    } else {
      text = `<span class="cb-ok">Brief read</span> — every deck in this class is given it.`;
      buttons = showing ? '' : '<button type="button" data-read="1" class="quiet">Read the brief</button>';
    }
    line.innerHTML = text || buttons ? `<span class="cb-text">${text}</span>${buttons}` : '';
  }

  line.addEventListener('click', (e) => {
    if (!host.current()) return;
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.dataset.stop) {
      stopRequested = true;
      const id = runner?.activeSession() ?? conn?.session?.sessionId;
      if (id) void sidecar.cancel(id);
      host.say('stopping the class brief…');
    } else if (b.dataset.settings) host.openSettings();
    else if (b.dataset.run) void runBrief();
    else if (b.dataset.update) void runBrief(host.current()?.newPapers ?? []);
    else if (b.dataset.read) void showBrief();
    else if (b.dataset.approve) void approve();
  });

  function hideGate(): void {
    gate.hidden = true;
    gate.innerHTML = '';
    showing = false;
    render();
  }

  async function showBrief(lead = ''): Promise<void> {
    const cls = host.current();
    if (!cls) return;
    const text = await sidecar.readCourse(cls.path, 'class.md').then((r) => r.text, () => null);
    const approveButton = cls.brief === 'written' && text !== null ? '<button type="button" data-approve="1">Looks right</button>' : '';
    const again = conn?.session && text !== null ? '<button type="button" data-rewrite="1" class="quiet" title="Read every doc again and write the brief from scratch">Write it again</button>' : '';
    gate.innerHTML = `<header class="bar"><span>class.md${cls.brief === 'reviewed' ? ' · read' : ''}</span><span class="grow"></span>${approveButton}${again}<button type="button" data-reread="1" class="quiet">Re-read</button><button type="button" data-close="1" class="quiet">Close</button></header>
      ${lead ? `<p class="gate-lead">${esc(lead)}</p>` : ''}<pre class="artifact">${text === null ? '(no class.md was written — write the brief again, or ask the agent below)' : esc(text)}</pre>`;
    gate.hidden = false;
    showing = text !== null;
    host.showAgentView();
    render();
  }

  gate.addEventListener('click', (e) => {
    if (!host.current()) return;
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.dataset.close) hideGate();
    else if (b.dataset.reread) void refresh().then(() => showBrief());
    else if (b.dataset.approve) void approve();
    else if (b.dataset.rewrite) void runBrief();
  });

  async function approve(): Promise<void> {
    const cls = host.current();
    if (!cls) return;
    try {
      const r = await sidecar.reviewClass(host.decksRoot, cls.path);
      host.changed(r);
      hideGate();
      host.say(`class brief for ${cls.folder} is read — every deck in it is given class.md`);
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    }
  }

  /**
   * exams.json into the class's exams: new ones added, a missing date or
   * coverage filled in, nothing the person set overwritten. Then it goes,
   * so an exam the person deletes is not brought back by the next look.
   */
  async function takeExams(cls: ClassSummary): Promise<string> {
    const text = await sidecar.readCourse(cls.path, 'exams.json').then((r) => r.text, () => null);
    if (text === null) return '';
    const found = parseFoundExams(text);
    const { exams, added, filled, moved, differ } = mergeExams(cls.exams, found);
    // Written as the papers': an exam keeps whose it was, so the next paper can move this one's date.
    if (added || filled || moved.length) host.changed(await sidecar.updateClass(host.decksRoot, cls.path, exams, 'papers'));
    await sidecar.deleteCourse(cls.path, 'exams.json').catch(() => undefined);
    if (!found.length) return 'The docs named no exams.';
    const undated = exams.filter((e) => !e.date).length;
    const when = (d: string) => shortDate(d);
    const parts = [
      added ? `${added} exam${added === 1 ? '' : 's'} added from the docs` : '',
      filled ? `${filled} filled in` : '',
      ...moved.map((m) => `${m.name} moved to ${when(m.to)} (was ${when(m.from)})`),
    ].filter(Boolean);
    const theirs = differ.map((d) => `the docs put ${d.name} on ${when(d.papers)}; you set ${when(d.yours)}, and yours stands — change it under Exams if they are right`);
    return `${[parts.length ? parts.join('; ') : 'No change to the exams', ...theirs].join('. ')}${undated ? `. ${undated} without a date — add ${undated === 1 ? 'it' : 'them'} under Exams` : ''}. Check the dates under Exams: they are what the decks are sized to.`;
  }

  /** The brief, written from every paper -- or, given the papers added since it was, brought up to date from those. */
  async function runBrief(added: string[] = []): Promise<void> {
    const cls = host.current();
    if (!cls) return;
    if (busy) return host.say(`${busy} is still running — watch the agent below, or press Stop`);
    if (!host.hasMaterials()) {
      host.say('add the class\'s docs first — the syllabus, notes, a study guide', true);
      return host.addFiles();
    }
    const r0 = runnerOf(cls);
    if (!r0) {
      host.say('no agent is connected — set one up in Settings', true);
      return host.openSettings();
    }
    host.showAgentView();
    gate.hidden = true;
    showing = false;
    setBusy(added.length ? 'updating the brief' : 'class brief');
    try {
      await host.prepareMaterials(cls.path);
      if (stopRequested) {
        host.say('the class brief stopped before the agent started');
        return;
      }
      host.say(added.length ? 'updating the class brief…' : 'writing the class brief…');
      const r = await r0.run(added.length ? classUpdateStage(added) : CLASS_STAGE);
      const halted = r.stopReason !== 'end_turn';
      // Written from what is here now: a paper added from here on is new to it. Not when it stopped short.
      if (!halted && r.artifactText !== null) host.changed(await sidecar.briefedClass(host.decksRoot, cls.path).catch(() => cls));
      await refresh();
      const now = host.current() ?? cls;
      const lead = await takeExams(now);
      host.say(halted ? `the class brief stopped: ${r.stopReason}` : added.length ? 'class brief updated' : 'class brief written', halted);
      setBusy(null);
      await showBrief(lead);
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      if (busy) setBusy(null);
    }
  }

  async function refresh(): Promise<void> {
    const cls = host.current();
    if (!cls) return;
    try {
      const { class: now } = await sidecar.listCourse(cls.path);
      if (now) host.changed(now);
      if (!busy) {
        const lead = await takeExams(host.current() ?? cls);
        if (lead) host.say(lead);
      }
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    }
    render();
  }

  function note(): string {
    const cls = host.current();
    if (!cls) return '';
    const state = cls.brief === 'none' ? 'not written yet' : cls.brief === 'written' ? 'written, and not yet read by the person' : 'written and read by the person';
    return [
      `[From the A.P.E. app, not typed by the person.] This is the class ${cls.folder}, not a deck. Its folder holds the class's own papers -- the syllabus, exam guides, the schedule -- and its one step is the class brief: reading those papers by the method's step 0 into class.md beside them, with exams.json for the exams. Every deck in the class is given class.md at each of its steps.`,
      `The class brief is ${state}. No cards are made here.`,
      'When the person asks for a change to the brief, edit class.md in this folder. Exam dates are kept by the app, under Exams, where the person changes them.',
    ].join('\n');
  }

  async function act(d: Directive): Promise<string> {
    return `this is the class ${host.current()?.folder ?? ''}, not a deck: it has no ${d.stage} step`;
  }

  return {
    setConnection(c) {
      conn = c;
      runner = null;
      runnerFor = null;
      render();
    },
    refresh,
    busy: () => busy,
    note,
    act,
    redraw: render,
  };
}
