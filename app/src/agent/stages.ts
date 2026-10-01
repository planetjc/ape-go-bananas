// The steps: the rail on the left says where a run is, the bar at the top
// of the main pane says what is next and runs it with one button. Writing
// stages run the method through the agent and show the artifact behind a
// gate; the review stages are that gate ("Looks right → organize"); the
// preview is the deck view; the audit runs the whole-deck auditor in a
// fresh session, merges its findings with the owner's flags, hands them to
// an adjudicator, and the writer applies the verdicts verbatim; deliver
// exports. Nothing here decides what a card says; the method text and the
// agent do.
//
// What is done is read from the course folder (course/list's artifacts, the
// flags, verdicts.md), so a run picks up where it was left; what was merely
// looked at this session (a review, the preview) is remembered here.

import {
  WRITING_STAGES,
  makeRunner,
  type AuditFinding,
  type Runner,
  type StageId,
} from '../../../dist/pipeline/index.js';
import { EngineError, type ConnectResult, type Flag, type SidecarClient, type SendToAnkiResult } from '../engine/client.js';
import type { Bus } from './bus.js';
import { mergeFlags } from './flags.js';
import { STAGES, stepsNote, type Directive, type StepState } from './steps-note.js';
import { readNewPerDay } from './study.js';

/** Silence long enough to mention, and long enough to worry about. */
const QUIET_MS = 60_000;
const STALLED_MS = 240_000;

export { STAGES };

/** One line per step: what it does, shown in the bar before it runs. */
const ABOUT: Record<StageId, string> = {
  extract: 'The agent reads the material and writes inventory.md: every fact, with where it came from.',
  'inventory review': 'Read the inventory. Anything missing or wrong, tell the agent below; continue when it is right.',
  organize: 'The agent turns the inventory into plan.md: which cards, in what order.',
  'plan review': 'Read the plan; continue when it looks right.',
  cards: 'The agent writes deck.json. The structural checks run on it here.',
  'deck preview': 'Every card, rendered. Flag any that are wrong.',
  audit: 'A fresh session that wrote none of the cards reads the whole deck. Its findings and your flags go to an adjudicator; the writer applies the verdicts as written.',
  deliver: 'Export the .apkg beside your material. Double-click it to import into Anki.',
};

export interface StageHost {
  sidecar: SidecarClient;
  /** The shared notification stream, for knowing the agent is still alive. */
  bus: Bus;
  courseDir(): string | null;
  deckName(): string;
  say(text: string, isError?: boolean): void;
  /** Puts the agent pane (gate + chat) in the main pane. */
  showAgentView(): void;
  /** Loads `<courseDir>/deck.json` into the deck view and shows it. */
  openDeck(courseDir: string): Promise<void>;
  /** Exports the deck; the path written, or null when the shell saved it some other way (a download) or failed. */
  exportDeck(): Promise<string | null>;
  /** Puts the deck into the running Anki; null when it failed (Anki closed, most often). */
  sendToAnki(): Promise<SendToAnkiResult | null>;
  /** Extracts text and page images beside every PDF that has none yet; runs before the extract stage. */
  prepareMaterials(courseDir: string): Promise<void>;
  openSettings(): void;
  /** Whether the deck has any material to read; extract has nothing to do without it. */
  hasMaterials(): boolean;
  /** Opens the shell's way of adding files (a picker). */
  addFiles(): void;
}

/** What each stage that can be discarded writes beside the material, besides whatever else the agent leaves. */
const OUTPUT: Partial<Record<StageId, string[]>> = {
  extract: ['inventory.md'],
  organize: ['plan.md'],
  cards: ['deck.json'],
  audit: ['audit.md', 'audit.json'],
};
/** What finishing each step means, in the note the agent is sent. */
const FINISH: Record<StageId, string> = {
  extract: 'writes inventory.md',
  'inventory review': 'the person reads inventory.md and says it is right',
  organize: 'writes plan.md',
  'plan review': 'the person reads plan.md and says it is right',
  cards: 'writes deck.json',
  'deck preview': 'the person looks through every card',
  audit: 'a fresh session reviews the whole deck; the person rules on its findings',
  deliver: 'the person exports the deck or sends it to Anki',
};
/** The file a writing step leaves, which is what "done" is checked against. */
const FILE: Partial<Record<StageId, string>> = { extract: 'inventory.md', organize: 'plan.md', cards: 'deck.json', audit: 'audit.md' };

/** The stage behind an artifact a gate shows. */
const WRITER: Record<string, StageId> = { 'inventory.md': 'extract', 'plan.md': 'organize', 'deck.json': 'cards' };

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function next(stage: StageId): StageId | null {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i + 1 < STAGES.length ? STAGES[i + 1]! : null;
}

export interface Stages {
  /** Called when an agent is connected or gone; before that only the two deck stages work. */
  setConnection(conn: ConnectResult | null): void;
  run(stage: StageId): Promise<void>;
  /** Re-reads the folder and redraws the rail and the bar. */
  refresh(): Promise<void>;
  /** What is running, or null; a deck is not switched out from under a run. */
  busy(): string | null;
  /** The note on where the deck stands, for the agent (steps-note.ts). */
  note(): string;
  /** Acts on one line the agent ended a reply with, after checking it; says what happened, for the chat. */
  act(d: Directive): Promise<string>;
}

interface Action {
  stage: StageId;
  button: string;
  hint: string;
  go: () => Promise<void>;
  secondary?: { label: string; go: () => Promise<void> };
}

export function mountStages(rail: HTMLOListElement, bar: HTMLElement, gate: HTMLElement, host: StageHost): Stages {
  const { sidecar } = host;
  let runner: Runner | null = null;
  let writerSession: string | null = null;
  /** What is running, or null. Named rather than a flag so the rail can mark it and the refusal can say which. */
  let busy: string | null = null;
  /** When the running stage started, and when the agent last said anything. */
  let startedAt = 0;
  let lastHeard = 0;
  let ticker: number | null = null;
  // Any traffic at all counts as a sign of life, including a tool call or a
  // single token. Only agent/update -- the engine's forward of the agent's own
  // session/update stream -- so it cannot be kept alive by the shell's own
  // polling. Any session counts: the audit and the adjudicator run in their own.
  host.bus.onNotification((method) => {
    if (busy && method === 'agent/update') lastHeard = Date.now();
  });
  /** Stages the user asked to run again despite an artifact already existing. */
  const force = new Set<StageId>();
  // What the folder says, as of the last refresh.
  let has = { inventory: false, plan: false, deck: false, audit: false, verdicts: false, flags: 0 };
  // What happened this session and leaves no file: reviews looked at, the preview opened, the export written.
  const reviewed = new Set<StageId>();
  let previewed = false;
  let exportedTo: string | null = null;
  let sentToAnki: string | null = null; // what landed in Anki, once it has
  /** The artifact the gate is showing, if any. */
  let showing: string | null = null;
  /** A run-through is in progress: each stage starts the next until the audit. */
  let through = false;
  /** Stop was pressed during the current run. A stage's file can already exist when it is cancelled, so this, not the file, ends a run-through. */
  let stopRequested = false;
  /** The last stage did not finish its turn: stopped, cut short, or failed. */
  let halted = false;
  /** Cancel was pressed: the run stops, then what it wrote is offered for the trash. */
  let discardAfter = false;
  /** The folder's files as the last run found them, so what the run added -- a converted/ folder, notes -- can be told apart. */
  let lastRun: { dir: string; stage: StageId; before: Set<string> } | null = null;
  /** The stage whose artifact the gate shows, so Re-read can redraw it whole. */
  let gateStage: StageId | null = null;
  /** What the discard gate on screen listed, moved to the trash on a yes. */
  let pendingDiscard: { dir: string; stage: StageId; names: string[] } | null = null;

  // Each step is a button, and says so: the first person through this screen
  // read the list as a progress display and asked how to start the process.
  rail.innerHTML = STAGES.map(
    (s) => `<li data-stage="${s}" role="button" tabindex="0" title="${esc(ABOUT[s])}"><span class="sname">${esc(s)}</span><span class="sstate"></span></li>`,
  ).join('');

  function setStage(name: StageId | null): void {
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('on', li.dataset.stage === name));
  }

  /**
   * A stage takes minutes -- the PDFs are read, then an agent writes -- and
   * the status line is one line that anything else can overwrite. So the step
   * itself carries the state, where it cannot be clobbered.
   */
  function setBusy(label: string | null): void {
    busy = label;
    if (label !== null) stopRequested = discardAfter = false;
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('running', li.dataset.stage === label));
    rail.setAttribute('aria-busy', label === null ? 'false' : 'true');
    startedAt = label === null ? 0 : Date.now();
    lastHeard = startedAt;
    renderBar();
    if (ticker !== null) clearInterval(ticker);
    ticker = label === null ? null : (setInterval(tick, 1000) as unknown as number);
  }

  /**
   * A stage is minutes of someone else's work and the window has nothing to
   * say about it, which is indistinguishable from a hang. There is no total to
   * count towards -- the agent decides how much reading a lecture takes -- so
   * the bar reports the two things that are actually known: how long this has
   * been going, and how long since the agent last said anything. The second is
   * the one that answers "is this stuck?".
   */
  function human(ms: number): string {
    const s = Math.floor(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  }

  function tick(): void {
    if (!busy) return;
    const now = Date.now();
    const elapsed = bar.querySelector<HTMLElement>('.nb-elapsed');
    const idle = bar.querySelector<HTMLElement>('.nb-idle');
    if (elapsed) elapsed.textContent = human(now - startedAt);
    if (!idle) return;
    const quiet = now - lastHeard;
    // Under a minute of silence is ordinary: the agent is reading, or thinking.
    idle.textContent = quiet < QUIET_MS ? '' : `nothing heard for ${human(quiet)}`;
    idle.classList.toggle('stalled', quiet >= STALLED_MS);
    // The count changes every second, so it is not what a screen reader hears:
    // only crossing into quiet, and into stalled, is announced.
    const said = bar.querySelector<HTMLElement>('.nb-said');
    const state = quiet >= STALLED_MS ? 'The agent may be stalled: nothing heard for four minutes.' : quiet >= QUIET_MS ? 'Nothing heard from the agent for a minute.' : '';
    if (said && said.textContent !== state) said.textContent = state;
  }

  // A later artifact implies the earlier steps: a folder with only deck.json
  // in it resumes at the preview, not at extract.
  function done(stage: StageId): boolean {
    switch (stage) {
      case 'extract':
        return has.inventory || has.plan || has.deck;
      case 'inventory review':
        return reviewed.has(stage) || has.plan || has.deck;
      case 'organize':
        return has.plan || has.deck;
      case 'plan review':
        return reviewed.has(stage) || has.deck;
      case 'cards':
        return has.deck;
      case 'deck preview':
        return has.deck && (previewed || has.audit);
      case 'audit':
        return has.audit && !(has.flags > 0);
      case 'deliver':
        return exportedTo !== null;
    }
  }

  /** What the bar offers: the first step not done, with the audit's sub-steps spelled out. */
  function action(): Action {
    const writing = (stage: StageId): Action => ({
      stage,
      button: `Run ${stage}`,
      hint: ABOUT[stage],
      go: () => run(stage),
    });
    // A review is read before it is approved: the first press opens the
    // artifact in the gate, the second is the approval and runs what follows.
    const review = (stage: StageId): Action => {
      const after = next(stage)!;
      const artifact = stage === 'inventory review' ? 'inventory.md' : 'plan.md';
      if (showing !== artifact) return { stage, button: `Read ${artifact}`, hint: ABOUT[stage], go: () => run(stage) };
      return {
        stage,
        button: `Looks right → ${after}`,
        hint: ABOUT[stage],
        go: async () => {
          reviewed.add(stage);
          await run(after);
        },
      };
    };
    if (!has.deck) {
      if (!has.plan) {
        if (!has.inventory && !host.hasMaterials()) return { stage: 'extract', button: 'Add files…', hint: 'Add the lecture\'s files first: slides as PDF, the transcript, the objectives.', go: async () => host.addFiles() };
        if (!has.inventory) return writing('extract');
        if (!reviewed.has('inventory review')) return review('inventory review');
        return writing('organize');
      }
      if (!reviewed.has('plan review')) return review('plan review');
      return writing('cards');
    }
    if (!has.audit && !previewed) return { stage: 'deck preview', button: 'Open the deck', hint: ABOUT['deck preview'], go: () => run('deck preview') };
    if (!has.audit) return { stage: 'audit', button: 'Run audit', hint: ABOUT.audit, go: () => run('audit') };
    if (has.flags > 0 && !has.verdicts)
      return {
        stage: 'audit',
        button: `Adjudicate ${has.flags} flag${has.flags === 1 ? '' : 's'}`,
        hint: 'An adjudicator that wrote none of the cards rules on each flag: approve, fix, or cut.',
        go: adjudicate,
        secondary: { label: 'Re-run audit', go: () => (force.add('audit'), run('audit')) },
      };
    if (has.flags > 0)
      return {
        stage: 'audit',
        button: 'Apply verdicts',
        hint: 'The writer applies every verdict as written -- no re-judging -- and the deck is re-checked.',
        go: applyVerdicts,
        secondary: { label: 'Re-adjudicate', go: adjudicate },
      };
    const toAnki = { label: 'Send to Anki', go: send };
    if (sentToAnki !== null)
      return {
        stage: 'deliver',
        button: 'Send again',
        hint: `Done. ${sentToAnki} — open Anki and study.`,
        go: send,
        secondary: { label: 'Export .apkg', go: () => run('deliver') },
      };
    if (exportedTo !== null)
      return {
        stage: 'deliver',
        button: 'Export again',
        hint: `Done. ${exportedTo} is beside your material — double-click it to import into Anki, or send it straight in.`,
        go: () => run('deliver'),
        secondary: toAnki,
      };
    return { stage: 'deliver', button: 'Send to Anki', hint: `${ABOUT.deliver} Anki must be open with the AnkiConnect add-on; Export writes an .apkg to import by hand instead.`, go: send, secondary: { label: 'Export .apkg', go: () => run('deliver') } };
  }

  function renderBar(): void {
    if (!host.courseDir()) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    if (busy) {
      const n = STAGES.indexOf(busy as StageId) + 1;
      bar.innerHTML = `<span class="nb-spin" aria-hidden="true"></span>
        <div class="nb-text"><span class="nb-k">${
          through ? 'Running through to audit' : n > 0 ? `Running · step ${n} of ${STAGES.length}` : 'Running'
        }</span><strong>${esc(busy)}…</strong><span class="nb-hint">${
        through
          ? 'Each stage starts the next; it stops at the audit for you. Stop ends the run and keeps what it wrote; Cancel ends it and offers what it wrote for the trash.'
          : 'Watch the agent below. Stop ends its turn and keeps what it wrote; Cancel ends it and offers what it wrote for the trash.'
      }</span></div>
        <div class="nb-run"><span class="nb-elapsed">0s</span><span class="nb-idle" aria-hidden="true"></span><span class="nb-said sr-only" role="status"></span></div>
        <div class="nb-actions">${OUTPUT[busy as StageId] ? '<button type="button" data-cancel="1" class="quiet">Cancel</button>' : ''}<button type="button" data-stop="1" class="quiet">Stop</button></div>`;
      tick();
      return;
    }
    const a = action();
    const n = STAGES.indexOf(a.stage) + 1;
    const needsAgent = !runner && (WRITING_STAGES.some((w) => w.id === a.stage) || a.stage === 'audit');
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('next', li.dataset.stage === a.stage));
    // Run to audit: offered wherever a stage is still ahead of the audit and an agent can run it.
    const canThrough = !!runner && !needsAgent && nextAuto() !== null && !(a.stage === 'extract' && !has.inventory && !host.hasMaterials());
    // The number belongs to the kicker, with how many there are -- "step 4 of
    // 8" says where a run is; "4 ·" in front of the name only crowds it.
    bar.innerHTML = `<div class="nb-text"><span class="nb-k">${
      exportedTo !== null && a.stage === 'deliver' ? 'Done' : `Next · step ${n} of ${STAGES.length}`
    }</span><strong>${esc(a.stage)}</strong><span class="nb-hint">${esc(a.hint)}</span></div>
      <div class="nb-actions">${
        canThrough ? `<button type="button" data-through="1" class="quiet" title="Extract, organize, cards and audit in a row, with no stops; come back to the findings.">Run to audit</button>` : ''
      }${a.secondary ? `<button type="button" data-secondary="1" class="quiet">${esc(a.secondary.label)}</button>` : ''}${
        needsAgent ? `<button type="button" data-settings="1">Set up an agent in Settings</button>` : `<button type="button" data-go="1">${esc(a.button)}</button>`
      }</div>`;
  }

  bar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    // The bar is a class's while one is open (class-steps.ts); its buttons are not these.
    if (!b || !host.courseDir()) return;
    if (b.dataset.stop || b.dataset.cancel) {
      // The audit and the adjudicator run in sessions of their own; the runner
      // knows which one is prompting. Between turns there is nothing to cancel,
      // and the flag still ends a run-through before its next stage.
      stopRequested = true;
      if (b.dataset.cancel) discardAfter = true;
      const id = runner?.activeSession() ?? writerSession;
      if (id) void sidecar.cancel(id);
      host.say(`${b.dataset.cancel ? 'cancelling' : 'stopping'} ${busy ?? 'the run'}…`);
      return;
    }
    if (b.dataset.settings) return host.openSettings();
    if (b.dataset.through) return void runThrough();
    const a = action();
    if (b.dataset.go) void a.go();
    else if (b.dataset.secondary && a.secondary) void a.secondary.go();
  });

  async function refresh(): Promise<void> {
    const dir = host.courseDir();
    if (!dir) {
      renderBar();
      return;
    }
    try {
      const { artifacts } = await sidecar.listCourse(dir);
      const audit = artifacts.deck ? await sidecar.readCourse(dir, 'audit.md').then(() => true, () => false) : false;
      const verdicts = artifacts.deck ? await sidecar.readCourse(dir, 'verdicts.md').then(() => true, () => false) : false;
      const flags = artifacts.deck ? await sidecar.readFlags(`${dir}/deck.json`).then((r) => r.flags.length, () => 0) : 0;
      has = { inventory: artifacts.inventory, plan: artifacts.plan, deck: artifacts.deck, audit, verdicts, flags };
    } catch {
      has = { inventory: false, plan: false, deck: false, audit: false, verdicts: false, flags: 0 };
    }
    rail.querySelectorAll<HTMLLIElement>('li').forEach((li) => li.classList.toggle('done', done(li.dataset.stage as StageId)));
    renderBar();
  }

  function showGate(html: string, artifact: string | null = null): void {
    gate.innerHTML = html;
    gate.hidden = false;
    showing = artifact;
    host.showAgentView();
    renderBar();
  }
  function hideGate(): void {
    gate.hidden = true;
    showing = null;
    renderBar();
  }

  /**
   * The artifact a stage wrote, with the way on. After a writing stage the
   * gate is the review: the button marks the review step done and runs the
   * stage after it, rather than showing the same file twice.
   */
  function showArtifactGate(stage: StageId, artifact: string, text: string | null): void {
    gateStage = stage;
    let after = next(stage);
    const reviewStep = after === 'inventory review' || after === 'plan review' ? after : null;
    if (reviewStep) after = next(reviewStep);
    const label = after === 'deck preview' ? 'Open the deck →' : after ? `Looks right → ${after}` : '';
    // No file, nothing to approve: a stopped organize offered "Looks right →
    // cards" over "(no plan.md was written)". The way on is the step again.
    const writer = WRITER[artifact];
    const forward =
      text === null
        ? writer ? `<button type="button" data-go="${writer}">Run ${esc(writer)} again</button>` : ''
        : after ? `<button type="button" data-go="${after}" ${reviewStep ? `data-reviewed="${reviewStep}"` : ''}>${esc(label)}</button>` : '';
    const missing = halted && stage === writer ? `${stage} stopped before writing ${artifact}` : `no ${artifact} was written`;
    showGate(`<header class="bar"><span>${esc(artifact)}</span><span class="grow"></span>
      ${forward}<button type="button" data-reread="${esc(artifact)}" class="quiet">Re-read</button>${
        writer && text !== null ? `<button type="button" data-discard="${writer}" class="quiet" title="Move what this step wrote to the deck's trash and go back to it">Discard…</button>` : ''
      }<button type="button" data-close="1" class="quiet">Close</button></header>
      <pre class="artifact">${text === null ? `(${esc(missing)} — run it again, or ask the agent below)` : esc(text)}</pre>`, artifact);
  }

  async function run(stage: StageId): Promise<void> {
    const dir = host.courseDir();
    if (!dir) return host.say('choose a course folder first', true);
    // Not an error: the previous click is still working. Saying which, and
    // where to watch it, is the whole of what the person needed to know.
    if (busy) return host.say(`${busy} is still running — watch the agent below, or press Stop in the bar`);
    if (stage === 'extract' && !host.hasMaterials()) {
      host.say('add the lecture files first', true);
      return host.addFiles();
    }
    const writing = WRITING_STAGES.find((w) => w.id === stage);
    if ((writing || stage === 'audit') && !runner) {
      host.say('no agent is connected — set one up in Settings', true);
      return host.openSettings();
    }
    setStage(stage);
    // Only a branch that claimed the bar gives it back: opening the deck or a
    // review is not a run, and clearing busy when it finished used to clear it
    // for whatever stage had started meanwhile.
    let claimed = false;
    const claim = (label: string): void => {
      setBusy(label);
      claimed = true;
    };
    // What was here before, so a discard takes only what this run added.
    const snapshot = async (): Promise<void> => {
      const before = await sidecar.listCourse(dir).then((r) => new Set(r.files.map((f) => f.relPath)), () => null);
      lastRun = before ? { dir, stage, before } : null;
    };
    halted = false;
    try {
      if (writing) {
        host.showAgentView();
        hideGate();
        claim(stage);
        await snapshot();
        if (stage === 'extract') await host.prepareMaterials(dir);
        if (stopRequested) {
          halted = true;
          host.say(`${stage} stopped before the agent started`);
          return;
        }
        host.say(`running ${stage}…`);
        const r = await runner!.run(writing);
        halted = r.stopReason !== 'end_turn';
        host.say(!halted ? `${stage} finished` : `${stage} stopped: ${r.stopReason}`, halted);
        if (!discardAfter) showArtifactGate(stage, writing.artifact, r.artifactText);
      } else if (stage === 'inventory review' || stage === 'plan review') {
        const artifact = stage === 'inventory review' ? 'inventory.md' : 'plan.md';
        const text = await sidecar.readCourse(dir, artifact).then((r) => r.text, () => null);
        showArtifactGate(stage, artifact, text);
      } else if (stage === 'deck preview') {
        previewed = true;
        await host.openDeck(dir);
      } else if (stage === 'audit') {
        // Resumable: if audit.md is already beside the deck -- from an earlier
        // run, or a run lost to a restart -- show it and offer the adjudicator
        // rather than paying for the audit again. "Re-run" is there for when
        // the deck has changed since.
        const existing = await sidecar.readCourse(dir, 'audit.md').then((r) => r.text, () => null);
        if (existing !== null && !force.has('audit')) {
          const { flags } = await sidecar.readFlags(`${dir}/deck.json`);
          showGate(`<header class="bar"><span>audit.md (already written) · ${flags.length} flag(s) to adjudicate</span><span class="grow"></span>
            ${flags.length ? '<button type="button" data-adjudicate="1">Adjudicate</button>' : ''}<button type="button" data-rerun="audit" class="quiet">Re-run audit</button><button type="button" data-close="1" class="quiet">Close</button></header>
            <pre class="artifact">${esc(existing)}</pre>`);
          host.say('audit.md is already there — adjudicate, or re-run the audit');
          return;
        }
        force.delete('audit');
        // What the last audit wrote is about a deck that has changed since; an
        // auditor that writes nothing this time must not have it read back as
        // this run's findings.
        await Promise.all(['audit.md', 'audit.json'].map((name) => sidecar.deleteCourse(dir, name).catch(() => undefined)));
        // The method's run-sheet: an auditor who wrote none of the cards reads
        // the whole deck first; its findings and the owner's flags then go to
        // a separate adjudicator. The owner sees the report before that step.
        host.showAgentView();
        hideGate();
        claim(stage);
        await snapshot();
        host.say('auditing the whole deck in a fresh session…');
        const deckPath = `${dir}/deck.json`;
        // The auditor is told review.html is beside deck.json -- the run-sheet's
        // step 2, every front rendered as the student will see it. The app keeps
        // its own preview in memory, so the file is written here, just before.
        await sidecar.review(deckPath, { outPath: `${dir}/review.html` }).catch(() => undefined);
        const a = await runner!.audit();
        halted = a.stopReason !== 'end_turn';
        // A cancelled audit's findings are not merged into the owner's flags.
        if (discardAfter) return;
        const { flags } = await sidecar.readFlags(deckPath);
        const merged: Flag[] = mergeFlags([
          ...flags,
          ...a.findings.filter((f: AuditFinding) => f.card > 0).map((f: AuditFinding) => ({ noteIndex: f.card - 1, note: `[${f.angle}] ${f.finding}`, at: new Date().toISOString() })),
        ]);
        await sidecar.writeFlags(deckPath, merged);
        showGate(`<header class="bar"><span>audit.md · ${a.findings.length} finding(s), ${flags.length} owner flag(s)</span><span class="grow"></span>
          ${merged.length ? `<button type="button" data-adjudicate="1">Adjudicate ${merged.length}</button>` : ''}<button type="button" data-close="1" class="quiet">Close</button></header>
          <pre class="artifact">${a.report === null ? '(no audit.md was written)' : esc(a.report)}</pre>`);
        host.say(a.stopReason === 'end_turn' ? `audit filed ${a.findings.length} finding(s)` : `auditor stopped: ${a.stopReason}`, a.stopReason !== 'end_turn');
      } else if (stage === 'deliver') {
        claim(stage);
        const out = await host.exportDeck();
        if (out !== null) exportedTo = out;
        else if (exportedTo === null) exportedTo = 'the .apkg';
      }
    } catch (err) {
      halted = true;
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      const cancelled = claimed && discardAfter;
      if (claimed) setBusy(null);
      await refresh();
      if (cancelled) await offerDiscard(stage);
    }
  }

  /**
   * Cancel, or Discard on a review: what the stage wrote and whatever else
   * its run added to the folder, listed, then moved to the deck's trash on a
   * yes -- the step goes back to not done. Nothing that was there before the
   * run is offered: the person's material stays, and so does an earlier
   * step's output. Without a record of the run (a later step has run since,
   * or the app restarted), only the step's own file is offered.
   */
  async function offerDiscard(stage: StageId): Promise<void> {
    const dir = host.courseDir();
    const outputs = OUTPUT[stage];
    if (!dir || !outputs) return;
    if (busy) return host.say(`${busy} is still running — stop it first`);
    const own = (await Promise.all(outputs.map((name) => sidecar.readCourse(dir, name).then(() => name, () => null)))).filter((n): n is string => n !== null);
    const run = lastRun && lastRun.dir === dir && lastRun.stage === stage ? lastRun : null;
    const added = run ? await sidecar.listCourse(dir).then((r) => r.files.map((f) => f.relPath).filter((f) => !run.before.has(f)), () => []) : [];
    const names = [...own, ...added];
    if (names.length === 0) {
      hideGate();
      return host.say(`${stage} left nothing behind`);
    }
    const note = run ? 'Everything that was in the folder before the run stays.' : "Only the step's own file is listed: what else a run added is known only for the latest run, until the app closes.";
    showGate(`<header class="bar"><span>Discard ${esc(stage)}?</span><span class="grow"></span><button type="button" data-discard-yes="1">Move ${names.length} to the trash</button><button type="button" data-close="1" class="quiet">Keep</button></header>
      <pre class="artifact">${esc(`These go to the deck's trash, kept there 30 days:\n\n${names.map((n) => `  ${n}`).join('\n')}\n\n${note}`)}</pre>`);
    pendingDiscard = { dir, stage, names };
  }

  async function discard(): Promise<void> {
    const d = pendingDiscard;
    pendingDiscard = null;
    if (!d || d.dir !== host.courseDir()) return hideGate();
    if (busy) return host.say(`${busy} is still running — stop it first`);
    const failed: string[] = [];
    for (const name of d.names) await sidecar.deleteCourse(d.dir, name, { trash: true }).catch(() => failed.push(name));
    if (lastRun?.dir === d.dir && lastRun.stage === d.stage) lastRun = null;
    const review = next(d.stage);
    if (review === 'inventory review' || review === 'plan review') reviewed.delete(review);
    if (d.stage === 'cards') previewed = false;
    hideGate();
    host.say(failed.length ? `could not move ${failed.join(', ')} to the trash` : `${d.stage} discarded — ${d.names.length} moved to the deck's trash`, failed.length > 0);
    await refresh();
  }

  /** Send to Anki: no agent runs, so it is not a busy stage; it either lands or says why not. */
  async function send(): Promise<void> {
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    host.say('sending to Anki…');
    const r = await host.sendToAnki();
    if (r === null) return renderBar();
    // A deck sent again is all duplicates: that is not a failure, just nothing new.
    const cards = (n: number) => `${n} card${n === 1 ? '' : 's'}`;
    const where = r.decks.join(', ');
    sentToAnki =
      r.added === 0 && r.total > 0
        ? `${r.total === 1 ? 'The card was' : `All ${cards(r.total)} were`} already in ${where}`
        : r.skipped > 0
          ? `${cards(r.added)} added to ${where}; ${r.skipped} ${r.skipped === 1 ? 'was' : 'were'} already there`
          : `${r.added} of ${cards(r.total)} in ${where}`;
    renderBar();
  }

  /** The next stage a run-through would start, or null when it is the person's turn: the audit is written, or there is nothing to extract from. */
  function nextAuto(): StageId | null {
    if (!has.inventory) return host.hasMaterials() ? 'extract' : null;
    if (!has.plan) return 'organize';
    if (!has.deck) return 'cards';
    if (!has.audit) return 'audit';
    return null;
  }

  /**
   * Run through to the audit: the writing stages and the audit in a row,
   * with no stop at the read-and-confirm gates -- for the person who has
   * been through the steps enough times and wants to come back to findings.
   * It ends where judgment starts, with the audit on screen and adjudication
   * waiting, or at the first stage that wrote nothing.
   */
  async function runThrough(): Promise<void> {
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    if (!runner) {
      host.say('no agent is connected — set one up in Settings', true);
      return host.openSettings();
    }
    through = true;
    renderBar();
    try {
      for (;;) {
        await refresh();
        const stage = nextAuto();
        if (stage === null) break;
        if (stage === 'organize') reviewed.add('inventory review');
        if (stage === 'cards') reviewed.add('plan review');
        await run(stage);
        // A stopped stage can leave its file behind -- deck.json written early,
        // then cancelled mid-fix -- so the file existing is not the test.
        if (stopRequested || halted) {
          host.say(`run-through stopped at ${stage}`, !stopRequested);
          return;
        }
        await refresh();
        if (!done(stage) && !(stage === 'audit' && has.audit)) {
          host.say(`run-through stopped: ${stage} wrote nothing`, true);
          return;
        }
      }
      host.say(has.audit ? 'run-through done — the audit is ready to read' : 'run-through done');
    } finally {
      through = false;
      renderBar();
    }
  }

  async function adjudicate(): Promise<void> {
    const dir = host.courseDir();
    if (!dir || !runner) return;
    const { flags } = await sidecar.readFlags(`${dir}/deck.json`);
    if (flags.length === 0) return host.say('nothing is flagged', true);
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    host.showAgentView();
    hideGate();
    setBusy('adjudicate');
    host.say(`adjudicating ${flags.length} flag(s) in a fresh session…`);
    try {
      // Verdicts from an earlier round rule on other flags, by card numbers
      // that may have moved; an adjudicator that writes nothing must not have
      // them shown, and offered for applying, as its own.
      await sidecar.deleteCourse(dir, 'verdicts.md').catch(() => undefined);
      const r = await runner.adjudicate(mergeFlags(flags)); // the owner may have flagged a card the audit already had
      showGate(`<header class="bar"><span>verdicts.md</span><span class="grow"></span>
        ${r.verdicts !== null ? '<button type="button" data-apply="1">Apply verdicts</button>' : ''}<button type="button" data-close="1" class="quiet">Close</button></header>
        <pre class="artifact">${r.verdicts === null ? '(no verdicts.md was written)' : esc(r.verdicts)}</pre>`);
      host.say(r.stopReason === 'end_turn' ? 'verdicts in — review them, then apply' : `adjudicator stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  async function applyVerdicts(): Promise<void> {
    const dir = host.courseDir();
    if (!dir || !runner) return;
    if (busy) return host.say(`${busy} is still running — watch the agent below`);
    host.showAgentView();
    hideGate();
    setBusy('applying verdicts');
    host.say('writer applying verdicts…');
    try {
      const r = await runner.applyVerdicts();
      host.say(r.stopReason === 'end_turn' ? 'verdicts applied — re-checking the deck' : `writer stopped: ${r.stopReason}`, r.stopReason !== 'end_turn');
      // The flags were the adjudicator's input; once its verdicts are applied
      // they are resolved, and their note indexes no longer line up with a
      // deck that may have lost cards. Clear them before the reload, so the
      // deck view does not show sixteen stale flags on a clean deck.
      // verdicts.md goes with them, for the same reason: left behind, the next
      // round's flags made the button "Apply verdicts" again, and the writer
      // applied the old rulings by number to cards that had since moved.
      if (r.stopReason === 'end_turn') {
        await sidecar.writeFlags(`${dir}/deck.json`, []).catch(() => undefined);
        await sidecar.deleteCourse(dir, 'verdicts.md').catch(() => undefined);
      }
      previewed = true;
      await host.openDeck(dir);
    } catch (err) {
      host.say(err instanceof EngineError ? err.message : String(err), true);
    } finally {
      setBusy(null);
      await refresh();
    }
  }

  function note(): string {
    const nextStage = busy ? null : action().stage;
    // The audit's sub-steps (adjudicating, applying verdicts) run under the audit.
    const runningStage = busy ? ((STAGES as readonly string[]).includes(busy) ? (busy as StageId) : 'audit') : null;
    const steps = STAGES.map((stage) => {
      const state: StepState = stage === runningStage ? 'running' : done(stage) ? 'done' : stage === nextStage ? 'next' : 'not yet';
      return { stage, state, about: FINISH[stage] };
    });
    return stepsNote(steps, host.deckName());
  }

  /**
   * One line from the agent, checked before anything moves: a writing step is
   * done only if its file is in the folder; a step is started only when it is
   * the one the bar offers and nothing is running. Delivering is left to the
   * person -- it puts cards into their Anki.
   */
  async function act(d: Directive): Promise<string> {
    if (!host.courseDir()) return `no deck is open; ${d.stage} is left as it is`;
    await refresh();
    const { stage } = d;
    if (d.verb === 'done') {
      const file = FILE[stage];
      if (file) return done(stage) ? `✓ ${stage} is done — ${file} is in the folder` : `${stage} is not done: there is no ${file} in the folder yet`;
      if (stage === 'inventory review' || stage === 'plan review') {
        const needs = stage === 'inventory review' ? 'extract' : 'organize';
        if (!done(needs)) return `${stage} cannot be checked off: ${needs} has not written ${FILE[needs]} yet`;
        if (done(stage)) return `✓ ${stage} was already done`;
        reviewed.add(stage);
        if (showing === (stage === 'inventory review' ? 'inventory.md' : 'plan.md')) hideGate();
        await refresh();
        return `✓ ${stage} checked off — next: ${action().stage}`;
      }
      if (stage === 'deck preview') {
        if (!has.deck) return 'deck preview cannot be checked off: there is no deck.json yet';
        previewed = true;
        await refresh();
        return `✓ deck preview checked off — next: ${action().stage}`;
      }
      return "deliver is done when the deck is exported or sent to Anki — that is the person's button";
    }
    if (busy) return `${busy} is still running; ${stage} waits until it finishes`;
    if (stage === 'deliver') return "deliver puts cards into Anki — that is the person's button, in the bar above";
    const a = action();
    if (a.stage !== stage) return `${stage} is not next — ${a.stage} is`;
    if (a.button === 'Add files…') return "there are no files to read yet; add the lecture's files first";
    if (!runner && (WRITING_STAGES.some((w) => w.id === stage) || stage === 'audit')) return `${stage} needs an agent connected — see Settings`;
    void a.go();
    return `▸ ${a.button}`;
  }

  rail.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-stage]');
    if (li) void run(li.dataset.stage as StageId);
  });
  rail.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const li = (e.target as HTMLElement).closest<HTMLLIElement>('li[data-stage]');
    if (!li) return;
    e.preventDefault();
    void run(li.dataset.stage as StageId);
  });

  gate.addEventListener('click', async (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    const dir = host.courseDir();
    if (!b || !dir) return;
    if (b.dataset.close) hideGate();
    else if (b.dataset.go) {
      if (b.dataset.reviewed) reviewed.add(b.dataset.reviewed as StageId);
      void run(b.dataset.go as StageId);
    } else if (b.dataset.reread) {
      const text = await sidecar.readCourse(dir, b.dataset.reread).then((r) => r.text, () => null);
      // Redrawn whole: a file the agent wrote since, asked in the chat, brings
      // the way on with it.
      if (gateStage && showing === b.dataset.reread) showArtifactGate(gateStage, b.dataset.reread, text);
      else {
        const pre = gate.querySelector('pre');
        if (pre) pre.textContent = text ?? `(no ${b.dataset.reread})`;
      }
    } else if (b.dataset.discard) void offerDiscard(b.dataset.discard as StageId);
    else if (b.dataset.discardYes) void discard();
    else if (b.dataset.adjudicate) void adjudicate();
    else if (b.dataset.apply) void applyVerdicts();
    else if (b.dataset.rerun) {
      force.add(b.dataset.rerun as StageId);
      void run(b.dataset.rerun as StageId);
    }
  });

  return {
    setConnection(conn) {
      const dir = host.courseDir();
      // The rate is read at each run, so a change in Settings reaches the next organize.
      runner = conn && conn.session && dir ? makeRunner(sidecar, conn, dir, host.deckName, note, () => ({ newPerDay: readNewPerDay() })) : null;
      writerSession = conn?.session?.sessionId ?? null;
      renderBar();
    },
    run,
    refresh,
    busy: () => busy,
    note,
    act,
  };
}
