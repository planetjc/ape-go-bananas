// The pipeline as prompts and a runner -- docs/APP.md: each stage hands the
// agent the bundled method file, the course folder and its materials, and
// asks for that step's artifact beside them; the adjudicator is a fresh
// session that wrote none of the cards, and the writer applies its verdicts
// verbatim. Nothing here says what a card is; the method text does.
//
// Over an injected client, so the desktop app (app/, through Tauri) and the
// browser page (site/, through the bridge) run the same stages with the same
// prompts. It began as app/src/pipeline.ts; the app kept a copy for a while,
// by a rule that it imports nothing from the engine at build time, and the
// copy silently missed `companions` and `describeExtracted` -- so the rule
// went, and there is one pipeline (docs/APP.md, "Where it lives").

import type { ContentBlock } from '../acp/protocol.js';
import type { Flag } from '../sidecar/methods.js';

export type { ContentBlock, Flag };

/** What a course folder listing looks like to the prompts: course/list's `files`. */
export interface CourseFileLike {
  relPath: string;
  kind: string;
  bytes: number;
  mimeType: string;
}

/** What the page extracted from one source file, beside it: course/list's `extracted`. */
export interface ExtractedLike {
  source: string; // relPath of the PDF
  text: string | null; // relPath of text.md, when written
  images: string[]; // relPaths of the page images, in page order
}

/** The class a course folder is in, as course/list gives it: its brief, and the exam the deck is studied for. */
export interface CourseClassLike {
  folder: string;
  path: string; // the class's own folder, where class.md is
  brief: 'none' | 'written' | 'reviewed';
  exam: { name: string; date: string | null; covers?: string } | null;
}

/** The subset of the sidecar surface the stages need, however it is reached. */
export interface PipelineClient {
  readMethod(name: string): Promise<{ text: string }>;
  listCourse(path: string): Promise<{ files: CourseFileLike[]; extracted?: ExtractedLike[]; class?: CourseClassLike | null }>;
  readCourse(path: string, name: string): Promise<{ text: string }>;
  newSession(connectionId: string): Promise<{ session: { sessionId: string } }>;
  prompt(sessionId: string, blocks: ContentBlock[]): Promise<{ stopReason: string }>;
  /**
   * True for a failure the sidecar reported (a JSON-RPC error such as an
   * artifact not being there yet), which the runner tolerates; anything
   * else is a bug and is rethrown.
   */
  isRpcError(err: unknown): boolean;
}

/** An open agent connection with its writer session: agent/connect's result. */
export interface ConnectionLike {
  connectionId: string;
  session: { sessionId: string } | null;
}

export type StageId = 'extract' | 'inventory review' | 'organize' | 'plan review' | 'cards' | 'deck preview' | 'audit' | 'deliver';

export interface WritingStage {
  id: StageId | 'class brief';
  method: string; // method file name
  artifact: string; // what the stage writes beside the material
  ask: string; // the one app-side sentence: which folder, which artifact
  companions?: string[]; // other method-repo files this step refers to by name; attached so the agent never searches for them
  time?: boolean; // told the exam date and the student's rate: the step that sizes the deck to them
}

export const WRITING_STAGES: WritingStage[] = [
  { id: 'extract', method: '1-extract.md', artifact: 'inventory.md', ask: 'Run this step on the course folder below and write inventory.md beside the material.', companions: ['SETUP.md'] },
  { id: 'organize', method: '2-organize.md', artifact: 'plan.md', ask: 'Run this step on the course folder below: inventory.md is already there; write plan.md beside it.', time: true },
  {
    id: 'cards',
    method: '3-cards.md',
    artifact: 'deck.json',
    ask: 'Run this step on the course folder below: plan.md and inventory.md are already there. Write deck.json beside them and stop there -- this app runs the structural checks and renders the review itself, and nothing is inserted into Anki from here. Slide images: reference each one in Extra by the name the method gives it, and list every such name once in a top-level "media" array in deck.json as {"filename": "<that name>", "path": "<absolute path of the page image under _extracted/>"} -- this app packs, checks and renders the images from that list; there is no collection.media here to stage into, and no file is copied or renamed.',
  },
];

/**
 * A class's one step, run in the class's own folder: the syllabus and the
 * other papers read once into class.md, which every deck in the class is
 * then given. exams.json is this app's, not the method's: the dates, which
 * the app keeps and does arithmetic with, as data the person confirms.
 */
export const CLASS_STAGE: WritingStage = {
  id: 'class brief',
  method: '0-class.md',
  artifact: 'class.md',
  ask: 'Run this step on the class folder below and write class.md beside its files. Also write exams.json beside it: a JSON array with one object per exam the papers name, {"name": "<as they name it>", "date": "YYYY-MM-DD" or null when no date is given, "covers": "<what it covers, in their words>"}. This app shows the person those exams to confirm and keeps the dates; no cards are written here.',
};

/**
 * The class brief again, for papers added since it was written: the same
 * step, told which papers are new and to fold them into class.md rather than
 * start over -- the person has read and corrected what is there.
 */
export function classUpdateStage(newPapers: string[]): WritingStage {
  const list = newPapers.map((f) => `- ${f}`).join('\n');
  return {
    ...CLASS_STAGE,
    ask: `class.md is already written beside the class's papers, from the ones it names, and the person has read it. These papers were added since:\n${list}\nRead each of them end to end and fold what they add into class.md, in its sections, each new line with its source -- as your method's "A paper added later" says. Keep every line that is there unless a new paper changes it, and say so where it does. Then write exams.json again, with every exam class.md now names, as before: a JSON array of {"name", "date": "YYYY-MM-DD" or null, "covers"}. No cards are written here.`,
  };
}

/** What the app knows that the folder does not: the student's own rate, and what day it is. */
export interface StageOptions {
  /** New cards a day, the student's own setting. */
  newPerDay?: number;
  /** Today; the clock, when not given. */
  today?: Date;
}

const ATTACH_LIMIT = 20 * 1024 * 1024; // embedded attachments above this are listed by path only

function fileUri(dir: string, rel: string): string {
  return `file://${encodeURI(`${dir.replace(/\/$/, '')}/${rel}`)}`;
}

function describe(files: CourseFileLike[]): string {
  return files.map((f) => `- ${f.relPath} (${f.kind}, ${(f.bytes / 1024).toFixed(0)} KB)`).join('\n');
}

/**
 * The paragraph that stops the agent probing for PDF tooling: what the page
 * already extracted, where it is, and that nothing needs converting. Empty
 * when nothing was extracted, so a folder of plain text reads as before.
 */
export function describeExtracted(extracted: ExtractedLike[]): string {
  const lines = extracted
    .filter((e) => e.text !== null || e.images.length > 0)
    .map((e) => {
      const parts: string[] = [];
      if (e.text) parts.push(`${e.text} (the text of every page, under "## Page N" headings)`);
      if (e.images.length > 0) parts.push(e.images.length === 1 ? `one page image, ${e.images[0]}` : `${e.images.length} page images, ${e.images[0]} … ${e.images[e.images.length - 1]}`);
      return `- ${e.source} → ${parts.join('; ')}`;
    });
  if (lines.length === 0) return '';
  return `\n\nAlready extracted beside the material by this app, with no tools:\n${lines.join('\n')}\nRead those instead of converting the source; do not look for pdftotext, pypdf or any other tooling. The text can carry stray spaces inside words where the PDF's fonts have odd widths ("c opied"); for exact wording, the page image is the authority.`;
}

/** A date as the calendar has it, YYYY-MM-DD, in local time. */
function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Whole days from one YYYY-MM-DD to another. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The line the method's "From the time" rule waits for: the exam date and
 * the student's rate. Empty when there is no dated exam still ahead -- the
 * tiers then stand as written, as the method says.
 */
export function timeLine(exam: CourseClassLike['exam'], opts: StageOptions = {}): string {
  if (!exam?.date) return '';
  const today = ymd(opts.today ?? new Date());
  const days = daysBetween(today, exam.date);
  if (days < 0) return '';
  const when = days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} from today (${today})`;
  const covers = exam.covers ? ` The syllabus says it covers: ${exam.covers}.` : '';
  const rate =
    opts.newPerDay && opts.newPerDay > 0
      ? ` The student adds up to ${opts.newPerDay} new card${opts.newPerDay === 1 ? '' : 's'} a day (their own setting), so about ${days * opts.newPerDay} new cards can be reviewed before it.`
      : ' The student has not said how many new cards a day they add.';
  return `Time: this deck is studied for ${exam.name} on ${exam.date}, ${when}.${rate}${covers} This date is the student's own and wins over any date in class.md.`;
}

/** The prompt for a writing stage: method as the system block, the ask, the listing, then the materials as links. */
export async function stageBlocks(client: PipelineClient, stage: WritingStage, courseDir: string, deckName: string, opts: StageOptions = {}): Promise<ContentBlock[]> {
  const [method, course] = await Promise.all([client.readMethod(stage.method), client.listCourse(courseDir)]);
  // A bridge started before SETUP.md was fetched, or APE_METHOD_DIR pointing at a
  // bare method/ checkout, has no companion to give: the stage runs without it
  // rather than failing on a file the agent can live without.
  const extras = (await Promise.all((stage.companions ?? []).map((name) => client.readMethod(name).then((r) => ({ name, text: r.text }), () => null)))).filter((e) => e !== null);
  const materials = course.files.filter((f) => f.kind !== 'other');
  const isClass = stage.id === 'class brief';
  // The method asks the user for the deck name and refuses to infer it
  // (a live run without one wrote "Deck: not supplied"); the app collects it.
  const deckLine = isClass ? `Class: ${deckName}` : deckName ? `Deck: ${deckName}` : 'Deck: not supplied by the user';
  const attached = extras.length > 0 ? `\n\n${extras.map((e) => e.name).join(', ')} from the method repository ${extras.length === 1 ? 'is' : 'are'} attached below; do not search the file system for ${extras.length === 1 ? 'it' : 'them'}.` : '';
  const extracted = course.extracted ?? [];
  // A deck in a class is given the class's brief, whole: a page or two, read
  // at every step, where the syllabus it came from would be paid for each time.
  const cls = !isClass && course.class ? course.class : null;
  const brief = cls && cls.brief !== 'none' ? await client.readCourse(cls.path, 'class.md').then((r) => r.text, () => null) : null;
  const classPara = cls
    ? brief !== null
      ? `\n\nThis deck is in the class ${cls.folder}. Its class brief, class.md, is attached below: what the syllabus and the class's other papers say about the whole course. It is course context, not lecture material; your method says how to use it.`
      : `\n\nThis deck is in the class ${cls.folder}, which has no class brief yet.`
    : '';
  const time = stage.time && cls ? timeLine(cls.exam, opts) : '';
  const blocks: ContentBlock[] = [
    { type: 'resource', resource: { uri: 'ape://system', text: method.text, mimeType: 'text/markdown' } },
    { type: 'text', text: `${stage.ask}${attached}\n\n${deckLine}\n${isClass ? 'Class' : 'Course'} folder: ${courseDir}\n\n${isClass ? 'Files' : 'Materials'}:\n${describe(materials) || '(none)'}${describeExtracted(extracted)}${classPara}${time ? `\n\n${time}` : ''}` },
    ...extras.map((e): ContentBlock => ({ type: 'resource', resource: { uri: `ape://method/${e.name}`, text: e.text, mimeType: 'text/markdown' } })),
  ];
  if (cls && brief !== null) blocks.push({ type: 'resource', resource: { uri: fileUri(cls.path, 'class.md'), text: brief, mimeType: 'text/markdown' } });
  for (const f of materials) {
    if ((f.kind === 'pdf' || f.kind === 'image' || f.kind === 'text') && f.bytes <= ATTACH_LIMIT) {
      blocks.push({ type: 'resource_link', uri: fileUri(courseDir, f.relPath), name: f.relPath, mimeType: f.mimeType });
    }
  }
  // The extracted text is linked, not inlined: the agent reads it when it
  // gets there, and a 60-page lecture is not paid for twice in one prompt.
  for (const e of extracted) {
    if (e.text) blocks.push({ type: 'resource_link', uri: fileUri(courseDir, e.text), name: e.text, mimeType: 'text/markdown' });
  }
  return blocks;
}

export interface AuditFinding {
  card: number; // 1-based; 0 for a deck-wide (coverage) finding
  angle: 'truth' | 'fluency' | 'coverage' | 'style' | string;
  finding: string;
}

/** The auditor's prompt: the deck-auditor brief as the system block, the step-3 method for its reference cards, the deck. A fresh session that wrote none of the cards. */
export async function auditBlocks(client: PipelineClient, courseDir: string): Promise<ContentBlock[]> {
  const [brief, method, deck] = await Promise.all([client.readMethod('4-audit.md'), client.readMethod('3-cards.md'), client.readCourse(courseDir, 'deck.json')]);
  return [
    { type: 'resource', resource: { uri: 'ape://system', text: brief.text, mimeType: 'text/markdown' } },
    {
      type: 'text',
      text: `Audit the deck in the course folder below. The seven reference cards your brief tells you to read first are at the top of the attached step-3 method; review.html is already rendered beside deck.json, so do not run render_review.py. Cards are numbered from 1 in deck.json array order. Write your findings to audit.md beside the deck -- all four angles of your brief -- and ALSO write audit.json beside it: a JSON array of objects { "card": <number>, "angle": "truth"|"fluency"|"coverage"|"style", "finding": "<one or two sentences>" }, one per finding that names a specific card (a coverage finding with no card uses "card": 0). Edit nothing else.\n\nCourse folder: ${courseDir}`,
    },
    { type: 'resource', resource: { uri: 'ape://method/3-cards.md', text: method.text, mimeType: 'text/markdown' } },
    { type: 'resource', resource: { uri: fileUri(courseDir, 'deck.json'), text: deck.text, mimeType: 'application/json' } },
  ];
}

/** The adjudicator's prompt: method 3, the deck, the flags -- and a verdict per flag, written beside the deck. */
export async function adjudicateBlocks(client: PipelineClient, courseDir: string, flags: Flag[]): Promise<ContentBlock[]> {
  const [method, deck] = await Promise.all([client.readMethod('3-cards.md'), client.readCourse(courseDir, 'deck.json')]);
  const list = flags.map((f, i) => `${i + 1}. card #${f.noteIndex + 1}: ${f.note || '(no note -- the reviewer flagged it without saying why; judge the card on the method alone)'}`).join('\n');
  return [
    { type: 'resource', resource: { uri: 'ape://system', text: method.text, mimeType: 'text/markdown' } },
    {
      type: 'text',
      text: `You are the adjudicator for a deck you did not write. You wrote none of these cards. For each flag below, read the card in deck.json (cards are numbered from 1 in array order) against the method above and the sources in the course folder, and return exactly one verdict per flag: "approve" with one sentence saying why the card stands as written, "fix" with the complete corrected Text/Extra/Source fields, or "cut" if the card should not exist. Write the verdicts to verdicts.md beside deck.json, numbered like the flags, and nothing else.\n\nCourse folder: ${courseDir}\n\nFlags:\n${list}`,
    },
    { type: 'resource', resource: { uri: fileUri(courseDir, 'deck.json'), text: deck.text, mimeType: 'application/json' } },
  ];
}

/** The writer applies the adjudicator's verdicts verbatim -- the standing rule, as wiring. */
export async function applyVerdictsBlocks(client: PipelineClient, courseDir: string): Promise<ContentBlock[]> {
  const verdicts = await client.readCourse(courseDir, 'verdicts.md');
  return [
    {
      type: 'text',
      text: `An adjudicator who wrote none of the cards has ruled on the flagged ones. Apply every "fix" verdict below to deck.json exactly as written -- do not re-judge, soften, or improve on them -- remove every card with a "cut" verdict, and leave every "approve" card as it is. Keep the array order of surviving cards. Rewrite deck.json in place and stop.\n\nCourse folder: ${courseDir}\n\n${verdicts.text}`,
    },
  ];
}

export interface Runner {
  run(stage: WritingStage): Promise<{ stopReason: string; artifactText: string | null }>;
  /** The whole-deck read the method's run-sheet calls step 3: a fresh session files findings; nothing is edited. */
  audit(): Promise<{ stopReason: string; report: string | null; findings: AuditFinding[] }>;
  adjudicate(flags: Flag[]): Promise<{ stopReason: string; verdicts: string | null }>;
  applyVerdicts(): Promise<{ stopReason: string }>;
  /**
   * The session a turn is running in right now, or null. The audit and the
   * adjudicator run in fresh sessions, so "cancel the writer" does not stop
   * them; Stop cancels this one.
   */
  activeSession(): string | null;
}

/**
 * `context`, when given, is the shell's note on where the deck stands --
 * which steps are done, which is running, what the agent may do about it --
 * sent after the stage's own blocks. A writer that was only ever told its
 * current step answered a note mid-extract with "I already extracted it" and
 * set off on the rest of the process its own way.
 */
export function makeRunner(client: PipelineClient, conn: ConnectionLike, courseDir: string, deckName: () => string, context?: () => string, options?: () => StageOptions): Runner {
  const writer = conn.session!.sessionId;
  let active: string | null = null;
  const prompt = async (sessionId: string, blocks: ContentBlock[]): Promise<{ stopReason: string }> => {
    active = sessionId;
    try {
      return await client.prompt(sessionId, blocks);
    } finally {
      if (active === sessionId) active = null;
    }
  };
  return {
    async run(stage) {
      const blocks = await stageBlocks(client, stage, courseDir, deckName(), options?.());
      const where = context?.();
      if (where) blocks.push({ type: 'text', text: where });
      const { stopReason } = await prompt(writer, blocks);
      let artifactText: string | null = null;
      try {
        artifactText = (await client.readCourse(courseDir, stage.artifact)).text;
      } catch (err) {
        if (!client.isRpcError(err)) throw err;
      }
      return { stopReason, artifactText };
    },
    async audit() {
      const fresh = await client.newSession(conn.connectionId);
      const { stopReason } = await prompt(fresh.session.sessionId, await auditBlocks(client, courseDir));
      const report = await client.readCourse(courseDir, 'audit.md').then((r) => r.text, () => null);
      let findings: AuditFinding[] = [];
      try {
        const raw = JSON.parse((await client.readCourse(courseDir, 'audit.json')).text) as unknown;
        if (Array.isArray(raw)) findings = raw.filter((f): f is AuditFinding => typeof f === 'object' && f !== null && typeof (f as AuditFinding).finding === 'string');
      } catch {
        /* no machine-readable findings: the report still shows */
      }
      return { stopReason, report, findings };
    },
    async adjudicate(flags) {
      const fresh = await client.newSession(conn.connectionId);
      const blocks = await adjudicateBlocks(client, courseDir, flags);
      const { stopReason } = await prompt(fresh.session.sessionId, blocks);
      let verdicts: string | null = null;
      try {
        verdicts = (await client.readCourse(courseDir, 'verdicts.md')).text;
      } catch (err) {
        if (!client.isRpcError(err)) throw err;
      }
      return { stopReason, verdicts };
    },
    async applyVerdicts() {
      return prompt(writer, await applyVerdictsBlocks(client, courseDir));
    },
    activeSession: () => active,
  };
}
