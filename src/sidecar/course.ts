// File methods over the course folder -- docs/research/course-protocol.md.
// The app builds a stage's prompt from these without the webview touching
// the filesystem, and nothing here interprets what it reads. The one write,
// course/write, exists so the page can put what it extracted from a PDF
// beside the PDF; it is confined to the folder the same way course/read is.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { InvalidParams, type MethodHandler } from './methods.js';

// What the stages write beside the material. None of it is material: listed,
// it became a tile on the deck screen and a "material" linked into the next
// stage's prompt, so the writer was handed the audit of its own deck as a source.
// class.md and exams.json are the class brief's, written beside a class's files.
const ARTIFACTS = ['inventory.md', 'plan.md', 'deck.json', 'flags.json', 'review.html', 'audit.md', 'audit.json', 'verdicts.md', 'class.md', 'exams.json'] as const;
// Where the page puts what it extracted from a source file: text.md and one
// image per page under `_extracted/<relPath of the source>/`. Not material,
// so not listed as files; reported as `extracted` instead.
const EXTRACTED = '_extracted';
const PAGE_IMAGE = /^p\d+\.(png|jpe?g|webp)$/i;

const KINDS: Record<string, { kind: string; mime: string }> = {
  pdf: { kind: 'pdf', mime: 'application/pdf' },
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  gif: { kind: 'image', mime: 'image/gif' },
  webp: { kind: 'image', mime: 'image/webp' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  webm: { kind: 'video', mime: 'video/webm' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  md: { kind: 'text', mime: 'text/markdown' },
  txt: { kind: 'text', mime: 'text/plain' },
  vtt: { kind: 'text', mime: 'text/vtt' },
  srt: { kind: 'text', mime: 'application/x-subrip' },
  csv: { kind: 'text', mime: 'text/csv' },
  json: { kind: 'text', mime: 'application/json' },
  html: { kind: 'text', mime: 'text/html' },
  pptx: { kind: 'slides', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  ppt: { kind: 'slides', mime: 'application/vnd.ms-powerpoint' },
  key: { kind: 'slides', mime: 'application/vnd.apple.keynote' },
  odp: { kind: 'slides', mime: 'application/vnd.oasis.opendocument.presentation' },
  docx: { kind: 'doc', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  doc: { kind: 'doc', mime: 'application/msword' },
  pages: { kind: 'doc', mime: 'application/vnd.apple.pages' },
  rtf: { kind: 'doc', mime: 'application/rtf' },
};

function classify(name: string): { kind: string; mimeType: string } {
  const ext = extname(name).slice(1).toLowerCase();
  const k = KINDS[ext];
  return k ? { kind: k.kind, mimeType: k.mime } : { kind: 'other', mimeType: 'application/octet-stream' };
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || v.length === 0) throw new InvalidParams(`params.${key} must be a non-empty string`);
  return v;
}

function asParams(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidParams('params must be an object');
  return raw as Record<string, unknown>;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function methodDir(): string {
  const dir = process.env.APE_METHOD_DIR;
  if (!dir || !isDirectory(dir)) throw new Error('APE_METHOD_DIR is not set or not a directory');
  return dir;
}

function titleOf(text: string, name: string): string {
  for (const line of text.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim();
  }
  if (text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    const front = end === -1 ? text : text.slice(0, end);
    const m = /^name:\s*(.+)$/m.exec(front);
    if (m) return m[1]!.trim().replace(/^["']|["']$/g, '');
  }
  return name.replace(/\.md$/, '');
}

/** A bare file name only: no separators, no traversal. */
function bareName(name: string, field: string): string {
  if (name.includes('/') || name.includes('\\') || name === '..' || name === '.' || name.includes('\0')) {
    throw new InvalidParams(`params.${field} must be a bare file name`);
  }
  return name;
}

function listFiles(root: string, dir: string, out: { name: string; relPath: string; bytes: number; kind: string; mimeType: string }[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (dir === root && entry.name === EXTRACTED) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(root, full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(root, full).split(sep).join('/');
    if (dir === root && (ARTIFACTS as readonly string[]).includes(entry.name)) continue;
    if (entry.name.toLowerCase().endsWith('.apkg')) continue;
    out.push({ name: entry.name, relPath: rel, bytes: statSync(full).size, ...classify(entry.name) });
  }
}

/** For each listed file, what `_extracted/<relPath>/` holds: the text, the page images. Source order. */
function extractedFor(root: string, files: { relPath: string }[]): { source: string; text: string | null; images: string[] }[] {
  const out: { source: string; text: string | null; images: string[] }[] = [];
  for (const f of files) {
    const dir = join(root, EXTRACTED, ...f.relPath.split('/'));
    if (!isDirectory(dir)) continue;
    const names = readdirSync(dir).sort();
    const at = (n: string) => `${EXTRACTED}/${f.relPath}/${n}`;
    const text = names.includes('text.md') && statSync(join(dir, 'text.md')).isFile() ? at('text.md') : null;
    const images = names.filter((n) => PAGE_IMAGE.test(n)).map(at);
    if (text !== null || images.length > 0) out.push({ source: f.relPath, text, images });
  }
  return out;
}

// A deck's own record, beside its material: what the person called it. A
// dotfile, so it is never listed as material. The folder name is only an id;
// it is made once from the first name and never follows a rename, because
// the shell remembers decks by path.
const META = '.ape-deck.json';
// Where a deleted thing waits, TRASH_DAYS: a deck under the decks root, as
// `<folder>~<ms deleted>`; a removed material under its deck, as `<ms>`. A
// dot folder, so it is never listed as a deck or as material.
const TRASH = '.trash';
const TRASH_DAYS = 30;

// The folders of the decks root, kept so that one can be made before any
// deck is in it, and outlast the last deck moved out. A folder is Anki's
// `::` path; every folder a deck's name implies is written here too, so a
// folder only goes when it is deleted, as a parent deck in Anki does.
const FOLDERS = '.folders.json';

function readFolders(root: string): string[] {
  const data = readJson(join(root, FOLDERS));
  const list = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).folders : undefined;
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
}

/** Each folder with the folders above it, once, sorted. */
function withParents(folders: Iterable<string>): string[] {
  const all = new Set<string>();
  for (const f of folders) {
    const segs = f.split('::');
    for (let i = 1; i <= segs.length; i += 1) all.add(segs.slice(0, i).join('::'));
  }
  return [...all].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function writeFolders(root: string, folders: Iterable<string>): string[] {
  const list = withParents(folders);
  writeFileSync(join(root, FOLDERS), JSON.stringify({ folders: list }, null, 2) + '\n');
  return list;
}

/** Whether `name` is `folder` or beneath it. */
const inFolder = (name: string, folder: string): boolean => name === folder || name.startsWith(`${folder}::`);

// A class is a folder whose decks share one syllabus. Its own files -- the
// syllabus, exam guides, the schedule -- and the brief the agent writes from
// them (class.md) live in `<decks root>/.classes/<id>/`, a course folder like
// any deck's, so adding, removing, extracting and trashing them are the
// course/* methods as they are. A dot folder, so never listed as a deck. The
// record in it says which folder it is and when the exams are; the folder is
// the record's, not the directory name's, so a rename moves no files.
const CLASSES = '.classes';
const CLASS_META = '.ape-class.json';
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface Exam {
  id: string;
  name: string;
  /** YYYY-MM-DD, or null when the syllabus gives none. */
  date: string | null;
  /** What it covers, in the syllabus's words. */
  covers?: string;
  /**
   * "person" once the person has made or changed it by hand: a later paper
   * never moves it. One the papers gave follows the papers.
   */
  setBy?: 'person';
}

interface ClassRecord {
  folder: string;
  exams: Exam[];
  /** class.md's mtime when the person said it was right; a later write is unread again. */
  reviewedAt?: number;
  /** The papers class.md was last written from; one added since is not in the brief yet. */
  briefFrom?: string[];
}

export interface ClassSummary {
  folder: string;
  path: string;
  exams: Exam[];
  brief: 'none' | 'written' | 'reviewed';
  files: number;
  /** Papers added since the brief was written, which it does not know yet. */
  newPapers: string[];
}

function readClass(dir: string): ClassRecord | null {
  const data = readJson(join(dir, CLASS_META));
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.folder !== 'string' || !d.folder) return null;
  const exams = Array.isArray(d.exams) ? d.exams.filter((e): e is Exam => typeof e === 'object' && e !== null && typeof (e as Exam).id === 'string' && typeof (e as Exam).name === 'string') : [];
  const briefFrom = Array.isArray(d.briefFrom) ? d.briefFrom.filter((f): f is string => typeof f === 'string') : undefined;
  return { folder: d.folder, exams, ...(typeof d.reviewedAt === 'number' ? { reviewedAt: d.reviewedAt } : {}), ...(briefFrom ? { briefFrom } : {}) };
}

function writeClass(dir: string, record: ClassRecord): void {
  writeFileSync(join(dir, CLASS_META), JSON.stringify(record, null, 2) + '\n');
}

function briefMtime(dir: string): number | null {
  try {
    const st = statSync(join(dir, 'class.md'));
    return st.isFile() ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

/** A class's papers: what the person brought, at the top of its folder -- not what a step made in a subfolder. */
function papersOf(dir: string): string[] {
  const files: { name: string; relPath: string; bytes: number; kind: string; mimeType: string }[] = [];
  listFiles(dir, dir, files);
  return files.filter((f) => !f.relPath.includes('/') && f.kind !== 'other').map((f) => f.relPath).sort();
}

function summarize(dir: string, record: ClassRecord): ClassSummary {
  const papers = papersOf(dir);
  const at = briefMtime(dir);
  const brief = at === null ? 'none' : record.reviewedAt === at ? 'reviewed' : 'written';
  const exams = [...record.exams].sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  // A brief from before this was kept knows nothing of what it read, and is taken to have read everything.
  const newPapers = brief !== 'none' && record.briefFrom ? papers.filter((f) => !record.briefFrom!.includes(f)) : [];
  return { folder: record.folder, path: dir, exams, brief, files: papers.length, newPapers };
}

/** Every class under `root`, with its directory. */
function classesIn(root: string): { dir: string; record: ClassRecord }[] {
  const base = join(root, CLASSES);
  if (!isDirectory(base)) return [];
  const out: { dir: string; record: ClassRecord }[] = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = join(base, e.name);
    const record = readClass(dir);
    if (record) out.push({ dir, record });
  }
  return out.sort((a, b) => a.record.folder.localeCompare(b.record.folder, undefined, { numeric: true, sensitivity: 'base' }));
}

/** `path` as a class directly under `<root>/.classes`, with its record. */
function classIn(root: string, path: string, field = 'path'): { dir: string; record: ClassRecord } {
  const full = resolve(path);
  if (dirname(full) !== resolve(root, CLASSES) || basename(full).startsWith('.')) throw new InvalidParams(`params.${field}: "${path}" is not a class under ${root}`);
  const record = isDirectory(full) ? readClass(full) : null;
  if (!record) throw new InvalidParams(`params.${field}: no class at "${path}"`);
  return { dir: full, record };
}

/** Today on this machine's calendar, as YYYY-MM-DD: an exam is on a day, not at an instant. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The exams as given, checked; one without an id is given the next free one.
 * `by` says who is changing them: an exam the person makes or changes is
 * theirs from then on (setBy); from the papers, each keeps whose it was.
 */
function examsFrom(raw: unknown, kept: Exam[], by: 'person' | 'papers' = 'person'): Exam[] {
  if (!Array.isArray(raw)) throw new InvalidParams('params.exams must be an array');
  const used = new Set<string>();
  let n = Math.max(0, ...kept.map((e) => Number(/^e(\d+)$/.exec(e.id)?.[1] ?? 0)));
  const out: Exam[] = [];
  raw.forEach((x, i) => {
    if (typeof x !== 'object' || x === null) throw new InvalidParams(`params.exams[${i}] must be an object`);
    const e = x as Record<string, unknown>;
    const name = typeof e.name === 'string' ? e.name.replace(/\s+/g, ' ').trim() : '';
    if (!name) throw new InvalidParams(`params.exams[${i}].name must name the exam`);
    const date = e.date === null || e.date === undefined || e.date === '' ? null : e.date;
    if (date !== null && (typeof date !== 'string' || !DATE.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`)))) throw new InvalidParams(`params.exams[${i}].date must be YYYY-MM-DD or null`);
    let id = typeof e.id === 'string' && e.id && !used.has(e.id) ? e.id : '';
    if (!id) {
      n += 1;
      id = `e${n}`;
    }
    used.add(id);
    const covers = typeof e.covers === 'string' ? e.covers.trim().slice(0, 500) : '';
    const was = kept.find((k) => k.id === id);
    const changed = !was || was.name !== name.slice(0, 120) || was.date !== date || (was.covers ?? '') !== covers;
    const theirs = by === 'person' ? changed || was?.setBy === 'person' : e.setBy === 'person' || was?.setBy === 'person';
    out.push({ id, name: name.slice(0, 120), date, ...(covers ? { covers } : {}), ...(theirs ? { setBy: 'person' as const } : {}) });
  });
  return out;
}

/**
 * The exam a deck is studied for: the one it was given, or none if it was
 * told none; otherwise the next one on the calendar, since a deck is almost
 * always made for the exam coming up.
 */
function examFor(choice: unknown, exams: Exam[]): Exam | null {
  if (choice === null) return null;
  const chosen = typeof choice === 'string' ? exams.find((e) => e.id === choice) : undefined;
  if (chosen) return chosen;
  const now = today();
  return exams.filter((e) => e.date !== null && e.date >= now).sort((a, b) => a.date!.localeCompare(b.date!))[0] ?? null;
}

// A semester is a folder whose classes share a term: "Fall 2026::Histology".
// It holds no files of its own, only its dates, so it is a record in
// `<decks root>/.semesters.json` keyed by its folder. Semesters do not nest,
// do not sit inside a class, and a class does not hold one.
const SEMESTERS = '.semesters.json';

export interface Semester {
  folder: string;
  /** YYYY-MM-DD, or null when not set. */
  start: string | null;
  end: string | null;
}

function readSemesters(root: string): Semester[] {
  const data = readJson(join(root, SEMESTERS));
  const list = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).semesters : undefined;
  if (!Array.isArray(list)) return [];
  return list
    .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null && typeof (s as Record<string, unknown>).folder === 'string')
    .map((s) => ({ folder: s.folder as string, start: typeof s.start === 'string' && DATE.test(s.start) ? s.start : null, end: typeof s.end === 'string' && DATE.test(s.end) ? s.end : null }));
}

function writeSemesters(root: string, semesters: Semester[]): Semester[] {
  const list = [...semesters].sort((a, b) => (b.start ?? '').localeCompare(a.start ?? '') || a.folder.localeCompare(b.folder, undefined, { numeric: true, sensitivity: 'base' }));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, SEMESTERS), JSON.stringify({ semesters: list }, null, 2) + '\n');
  return list;
}

/** A date param: YYYY-MM-DD, or null for none. */
function dateParam(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new InvalidParams(`params.${field} must be YYYY-MM-DD or null`);
  return v;
}

/** Start and end, checked together: an end before its start is a typo, not a term. */
function termDates(p: Record<string, unknown>): { start: string | null; end: string | null } {
  const start = dateParam(p.start, 'start');
  const end = dateParam(p.end, 'end');
  if (start && end && end < start) throw new InvalidParams('params.end must not be before params.start');
  return { start, end };
}

/**
 * Whether folders of these kinds can sit where they are: no semester inside
 * a semester or a class, no class inside a class. The message names the
 * first that cannot, or null when all can.
 */
function nesting(semesters: string[], classes: string[]): string | null {
  for (const s of semesters) {
    const over = semesters.find((o) => o !== s && inFolder(s, o));
    if (over) return `${s} would be a semester inside the semester ${over}`;
    const cls = classes.find((c) => inFolder(s, c));
    if (cls) return `${s} would be a semester inside the class ${cls}`;
  }
  for (const c of classes) {
    const over = classes.find((o) => o !== c && inFolder(c, o));
    if (over) return `${c} would put one class inside another (${over})`;
  }
  return null;
}

/** A class's folder into `<root>/.trash`, as `<dir>~<ms>`, for classes/restore; the trash empties it in TRASH_DAYS like a deck. */
function trashClass(root: string, dir: string): string {
  mkdirSync(join(root, TRASH), { recursive: true });
  const trashed = join(root, TRASH, `${basename(dir)}~${Date.now()}`);
  renameSync(dir, trashed);
  return trashed;
}

/** A deck's own record, whatever else it holds besides the name. */
function deckMeta(path: string): Record<string, unknown> {
  const meta = readJson(join(path, META));
  return typeof meta === 'object' && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

export interface CourseClass extends ClassSummary {
  /** The exam the deck is studied for; null for none, and for a class's own folder. */
  exam: Exam | null;
  /** How it came to be that one: an exam's id, "none", or "next" (the next on the calendar). */
  choice: string;
}

/**
 * The class a course folder belongs to, as its steps are given it: for a
 * deck, the class whose folder it is in, with the exam it is studied for;
 * for a class's own folder, itself. Null for a deck in no class, and for a
 * folder the bridge was opened on outside any decks root.
 */
function classOfCourse(path: string): CourseClass | null {
  const full = resolve(path);
  const parent = dirname(full);
  if (basename(parent) === CLASSES) {
    const record = readClass(full);
    return record ? { ...summarize(full, record), exam: null, choice: 'next' } : null;
  }
  const name = nameOf(full);
  if (!name) return null;
  const found = classesIn(parent).find((c) => inFolder(name, c.record.folder));
  if (!found) return null;
  const given = deckMeta(full).exam;
  const kept = typeof given === 'string' && found.record.exams.some((e) => e.id === given);
  return { ...summarize(found.dir, found.record), exam: examFor(given === null ? null : kept ? given : undefined, found.record.exams), choice: given === null ? 'none' : kept ? (given as string) : 'next' };
}

/** Every deck under `root` by the name it goes by. */
function deckNames(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => nameOf(join(root, e.name)) ?? e.name);
}

/** "Anatomy :: Lecture 3" -> "Anatomy::Lecture 3": what Anki would make of it, empty segments dropped. */
function deckName(name: string, field: string): string {
  const clean = name.split('::').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('::');
  if (!clean) throw new InvalidParams(`params.${field} must name a deck`);
  return clean;
}

/** deck.json's notes array, found the way deck-json.ts finds it (a list, {notes}, or {params:{notes}}); null when there is none. */
function notesIn(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data;
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const params = 'params' in d ? d.params : d;
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  const notes = (params as Record<string, unknown>).notes;
  return Array.isArray(notes) ? notes : null;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** The deck its cards will land in: the `::` path every note's deckName shares. Null before there are cards, or when they share none. */
function cardsDeckName(path: string): string | null {
  const notes = notesIn(readJson(join(path, 'deck.json')));
  if (!notes) return null;
  let common: string[] | null = null;
  for (const n of notes) {
    const name = typeof n === 'object' && n !== null ? (n as Record<string, unknown>).deckName : undefined;
    if (typeof name !== 'string' || !name.trim()) continue;
    const segs = name.split('::').map((s) => s.trim());
    if (common === null) common = segs;
    else {
      let i = 0;
      while (i < common.length && i < segs.length && common[i] === segs[i]) i += 1;
      common = common.slice(0, i);
    }
  }
  return common && common.length ? common.join('::') : null;
}

/** What a deck is called: where its cards go, once there are cards (that is what Anki will show); before that, what the person named it. */
function nameOf(path: string): string | null {
  const meta = readJson(join(path, META));
  const named = typeof meta === 'object' && meta !== null && typeof (meta as Record<string, unknown>).name === 'string' ? ((meta as Record<string, unknown>).name as string) : null;
  return cardsDeckName(path) ?? named;
}

/** `path` as a deck directly under `root` -- not the root, not beside it, not the trash. */
function deckIn(root: string, path: string, field = 'path'): string {
  const r = resolve(root);
  const full = resolve(path);
  if (dirname(full) !== r || basename(full).startsWith('.')) throw new InvalidParams(`params.${field}: "${path}" is not a deck under ${root}`);
  if (!isDirectory(full)) throw new InvalidParams(`params.${field}: no deck at "${path}"`);
  return full;
}

/** `base`, or `base (2)`, `base (3)`… whichever is free under `root`. */
function freeName(root: string, base: string): string {
  let name = base;
  for (let n = 2; existsSync(join(root, name)); n += 1) name = `${base} (${n})`;
  return name;
}

/** What was deleted into `<root>/.trash` more than TRASH_DAYS ago goes for good: decks under the decks root, materials under a deck. */
function emptyTrash(root: string): void {
  const trash = join(root, TRASH);
  if (!isDirectory(trash)) return;
  const cutoff = Date.now() - TRASH_DAYS * 24 * 60 * 60 * 1000;
  for (const e of readdirSync(trash, { withFileTypes: true })) {
    // A deck is `<folder>~<ms>`, a material `<ms>` or `<ms>-<n>`.
    const at = Number((/~(\d+)$/.exec(e.name) ?? /^(\d+)(?:-\d+)?$/.exec(e.name))?.[1]);
    if (e.isDirectory() && at && at < cutoff) rmSync(join(trash, e.name), { recursive: true, force: true });
  }
}

/** When a deck was last worked on: its newest top-level entry. The folder's own mtime misses a file rewritten in place (deck.json after an audit). */
function lastTouched(path: string): Date {
  let latest = statSync(path).mtime;
  for (const e of readdirSync(path)) {
    try {
      const m = statSync(join(path, e)).mtime;
      if (m > latest) latest = m;
    } catch {
      /* gone between the read and the stat */
    }
  }
  return latest;
}

/** A deck's folder name from what the user called it: no separators, no characters a filesystem refuses. */
function folderName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').replace(/^[\s.-]+|[\s.-]+$/g, '');
  return clean || 'deck';
}

function artifactsOf(path: string): { inventory: boolean; plan: boolean; deck: boolean; flags: boolean; review: boolean } {
  const has = (f: string) => {
    try {
      return statSync(join(path, f)).isFile();
    } catch {
      return false;
    }
  };
  return { inventory: has('inventory.md'), plan: has('plan.md'), deck: has('deck.json'), flags: has('flags.json'), review: has('review.html') };
}

/** `name` resolved beneath `path`, or -32602 when it is the folder itself or climbs out of it. */
function within(path: string, name: string): string {
  const root = resolve(path);
  const full = resolve(root, name);
  if (full === root || !full.startsWith(root + sep)) throw new InvalidParams(`params.name: "${name}" escapes the course folder`);
  return full;
}

export function courseMethods(): Record<string, MethodHandler> {
  return {
    'method/list': () => {
      const dir = methodDir();
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.md') && statSync(join(dir, f)).isFile())
        .sort()
        .map((name) => {
          const text = readFileSync(join(dir, name), 'utf8');
          return { name, title: titleOf(text, name), bytes: Buffer.byteLength(text) };
        });
      return { dir, files };
    },

    'method/read': (raw) => {
      const name = bareName(str(asParams(raw), 'name'), 'name');
      const dir = methodDir();
      const full = join(dir, name);
      if (!name.endsWith('.md') || !existsSync(full) || !statSync(full).isFile()) throw new InvalidParams(`params.name: no method file "${name}"`);
      return { name, text: readFileSync(full, 'utf8') };
    },

    'course/list': (raw) => {
      const path = str(asParams(raw), 'path');
      if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
      emptyTrash(path);
      const files: { name: string; relPath: string; bytes: number; kind: string; mimeType: string }[] = [];
      listFiles(path, path, files);
      files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
      const has = (f: string) => {
        try {
          return statSync(join(path, f)).isFile();
        } catch {
          return false;
        }
      };
      return {
        path,
        name: nameOf(path),
        files,
        artifacts: artifactsOf(path),
        extracted: extractedFor(path, files),
        class: classOfCourse(path),
      };
    },

    // ---- decks: course folders the shell owns, one per deck, under a root ----

    'decks/list': (raw) => {
      const root = str(asParams(raw), 'root');
      mkdirSync(root, { recursive: true });
      emptyTrash(root);
      const decks = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => {
          const path = join(root, e.name);
          const files: { name: string; relPath: string; bytes: number; kind: string; mimeType: string }[] = [];
          listFiles(path, path, files);
          // By kind, what the person brought: top-level files only, since a subfolder is what the steps made.
          const kinds: Record<string, number> = {};
          for (const f of files) if (!f.relPath.includes('/')) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
          return { name: nameOf(path) ?? e.name, folder: e.name, path, files: files.length, pdfs: files.filter((f) => f.kind === 'pdf').length, kinds, artifacts: artifactsOf(path), modified: lastTouched(path).toISOString() };
        })
        .sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : 0));
      const kept = readFolders(root);
      const classes = classesIn(root);
      const semesters = readSemesters(root);
      // A class's or a semester's folder is kept with the rest, so it shows before any deck is in it.
      const implied = [...decks.map((d) => d.name.split('::').slice(0, -1).join('::')), ...classes.map((c) => c.record.folder), ...semesters.map((t) => t.folder)].filter(Boolean);
      let folders = withParents([...kept, ...implied]);
      if (folders.length !== kept.length || folders.some((f, i) => f !== kept[i])) folders = writeFolders(root, folders);
      return { root, decks, folders, classes: classes.map((c) => summarize(c.dir, c.record)), semesters };
    },

    'folders/create': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const name = deckName(str(p, 'name'), 'name');
      mkdirSync(root, { recursive: true });
      return { name, folders: writeFolders(root, [...readFolders(root), name]) };
    },

    // The record only: the decks in the folder are renamed by the shell,
    // one decks/rename each, since each may carry cards to move.
    'folders/rename': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const from = deckName(str(p, 'from'), 'from');
      const to = deckName(str(p, 'to'), 'to');
      if (inFolder(to, from) && to !== from) throw new InvalidParams(`params.to: a folder cannot move inside itself`);
      // A class or a semester goes where its folder goes. A move that would
      // nest them -- a class in a class, a semester in a semester or a class --
      // is refused before anything is written.
      const moved = (f: string): string => (inFolder(f, from) ? to + f.slice(from.length) : f);
      const classes = classesIn(root).map((c) => ({ ...c, to: moved(c.record.folder) }));
      const semesters = readSemesters(root);
      const clash = nesting(semesters.map((t) => moved(t.folder)), classes.map((c) => c.to));
      if (clash) throw new InvalidParams(`params.to: ${clash}`);
      for (const c of classes) if (c.to !== c.record.folder) writeClass(c.dir, { ...c.record, folder: c.to });
      if (semesters.some((t) => moved(t.folder) !== t.folder)) writeSemesters(root, semesters.map((t) => ({ ...t, folder: moved(t.folder) })));
      const folders = readFolders(root).map((f) => (inFolder(f, from) ? to + f.slice(from.length) : f));
      return { name: to, folders: writeFolders(root, folders) };
    },

    // Only an empty folder: a deck in it would take the folder straight
    // back, and deleting decks is decks/delete's, one at a time, with Undo.
    // A class in it goes to the trash, whole -- its syllabus may be the only
    // copy -- and `classes` is what classes/restore takes to bring it back.
    'folders/delete': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const name = deckName(str(p, 'name'), 'name');
      const inside = deckNames(root).filter((d) => d.startsWith(`${name}::`));
      if (inside.length) throw new InvalidParams(`params.name: ${name} still holds ${inside.length} deck${inside.length === 1 ? '' : 's'} — move or delete ${inside.length === 1 ? 'it' : 'them'} first`);
      const trashed = classesIn(root)
        .filter((c) => inFolder(c.record.folder, name))
        .map((c) => trashClass(root, c.dir));
      // A semester in it goes with it; its dates come back, so Undo can make it again.
      const terms = readSemesters(root);
      const gone = terms.filter((t) => inFolder(t.folder, name));
      if (gone.length) writeSemesters(root, terms.filter((t) => !inFolder(t.folder, name)));
      const kept = readFolders(root);
      return { name, removed: kept.filter((f) => inFolder(f, name)), folders: writeFolders(root, kept.filter((f) => !inFolder(f, name))), classes: trashed, semesters: gone };
    },

    // ---- classes: a folder whose decks share a syllabus, and its exams ----

    'classes/create': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const folder = deckName(str(p, 'folder'), 'folder');
      const classes = classesIn(root).map((c) => c.record.folder);
      if (classes.includes(folder)) throw new InvalidParams(`params.folder: ${folder} is a class already`);
      const terms = readSemesters(root).map((t) => t.folder);
      if (terms.includes(folder)) throw new InvalidParams(`params.folder: ${folder} is a semester; a class goes inside one`);
      const clash = nesting(terms, [...classes, folder]);
      if (clash) throw new InvalidParams(`params.folder: ${clash}`);
      const base = join(root, CLASSES);
      mkdirSync(base, { recursive: true });
      const dir = join(base, freeName(base, folderName(folder)));
      mkdirSync(dir);
      const record: ClassRecord = { folder, exams: [] };
      writeClass(dir, record);
      writeFolders(root, [...readFolders(root), folder]);
      return summarize(dir, record);
    },

    // The exams, whole: what the person sees is what is kept.
    'classes/update': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const { dir, record } = classIn(root, str(p, 'path'));
      if (p.by !== undefined && p.by !== 'person' && p.by !== 'papers') throw new InvalidParams('params.by must be "person" or "papers"');
      const next: ClassRecord = { ...record, exams: examsFrom(p.exams, record.exams, p.by === 'papers' ? 'papers' : 'person') };
      writeClass(dir, next);
      return summarize(dir, next);
    },

    // The person has read class.md and says it is right -- this version of it.
    'classes/review': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const { dir, record } = classIn(root, str(p, 'path'));
      const at = briefMtime(dir);
      if (at === null) throw new InvalidParams('params.path: the class has no class.md to review yet');
      const next = { ...record, reviewedAt: at };
      writeClass(dir, next);
      return summarize(dir, next);
    },

    // class.md was just written: from these papers. One added after it is not in the brief until it is updated.
    'classes/briefed': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const { dir, record } = classIn(root, str(p, 'path'));
      if (briefMtime(dir) === null) throw new InvalidParams('params.path: the class has no class.md yet');
      const next = { ...record, briefFrom: papersOf(dir) };
      writeClass(dir, next);
      return summarize(dir, next);
    },

    // Back to a plain folder. The class's files go to the trash, whole, for classes/restore.
    'classes/remove': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const { dir } = classIn(root, str(p, 'path'));
      return { trashed: trashClass(root, dir) };
    },

    'classes/restore': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const trashed = resolve(str(p, 'trashed'));
      if (dirname(trashed) !== resolve(root, TRASH) || !/~\d+$/.test(trashed)) throw new InvalidParams(`params.trashed: "${trashed}" is not a removed class under ${root}`);
      const record = isDirectory(trashed) ? readClass(trashed) : null;
      if (!record) throw new InvalidParams(`params.trashed: "${trashed}" is gone`);
      const clash = nesting(readSemesters(root).map((t) => t.folder), [...classesIn(root).map((c) => c.record.folder), record.folder]);
      if (clash) throw new InvalidParams(`params.trashed: ${record.folder} cannot be a class again where it is: ${clash}`);
      const base = join(root, CLASSES);
      mkdirSync(base, { recursive: true });
      const dir = join(base, freeName(base, basename(trashed).replace(/~\d+$/, '')));
      renameSync(trashed, dir);
      writeFolders(root, [...readFolders(root), record.folder]);
      return summarize(dir, record);
    },

    // ---- semesters: a folder whose classes share a term, and its dates ----

    'semesters/create': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const folder = deckName(str(p, 'folder'), 'folder');
      const terms = readSemesters(root);
      if (terms.some((t) => t.folder === folder)) throw new InvalidParams(`params.folder: ${folder} is a semester already`);
      const classes = classesIn(root).map((c) => c.record.folder);
      if (classes.includes(folder)) throw new InvalidParams(`params.folder: ${folder} is a class; a semester holds classes`);
      const clash = nesting([...terms.map((t) => t.folder), folder], classes);
      if (clash) throw new InvalidParams(`params.folder: ${clash}`);
      const made: Semester = { folder, ...termDates(p) };
      mkdirSync(root, { recursive: true });
      writeFolders(root, [...readFolders(root), folder]);
      return { semester: made, semesters: writeSemesters(root, [...terms, made]) };
    },

    'semesters/update': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const folder = deckName(str(p, 'folder'), 'folder');
      const terms = readSemesters(root);
      if (!terms.some((t) => t.folder === folder)) throw new InvalidParams(`params.folder: ${folder} is not a semester`);
      const made: Semester = { folder, ...termDates(p) };
      return { semester: made, semesters: writeSemesters(root, terms.map((t) => (t.folder === folder ? made : t))) };
    },

    // Back to a plain folder: its classes and decks stay where they are.
    'semesters/remove': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const folder = deckName(str(p, 'folder'), 'folder');
      const terms = readSemesters(root);
      const gone = terms.find((t) => t.folder === folder);
      if (!gone) throw new InvalidParams(`params.folder: ${folder} is not a semester`);
      return { removed: gone, semesters: writeSemesters(root, terms.filter((t) => t !== gone)) };
    },

    // Which exam a deck is studied for: an exam's id, "none", or "next" -- the next on the calendar, as it moves.
    'decks/exam': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const path = deckIn(root, str(p, 'path'));
      const exam = str(p, 'exam');
      const cls = classOfCourse(path);
      if (!cls) throw new InvalidParams('params.path: the deck is in no class, so it has no exams');
      if (exam !== 'next' && exam !== 'none' && !cls.exams.some((e) => e.id === exam)) throw new InvalidParams(`params.exam: ${cls.folder} has no exam "${exam}"`);
      const meta = deckMeta(path);
      delete meta.exam;
      writeFileSync(join(path, META), JSON.stringify({ ...meta, ...(exam === 'next' ? {} : { exam: exam === 'none' ? null : exam }) }, null, 2) + '\n');
      return { path, class: classOfCourse(path) };
    },

    'decks/create': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const name = deckName(str(p, 'name'), 'name');
      mkdirSync(root, { recursive: true });
      const folder = freeName(root, folderName(name));
      const path = join(root, folder);
      mkdirSync(path);
      writeFileSync(join(path, META), JSON.stringify({ name }, null, 2) + '\n');
      return { name, folder, path };
    },

    // A rename is a move in Anki's tree: "Anatomy::Lecture 3" is "Lecture 3"
    // in the folder "Anatomy". Cards already written follow it -- every note
    // whose deck was the old name, or beneath it, is moved -- so what the
    // list says and where Send to Anki puts them never disagree.
    'decks/rename': (raw) => {
      const p = asParams(raw);
      const path = deckIn(str(p, 'root'), str(p, 'path'));
      const name = deckName(str(p, 'name'), 'name');
      const before = nameOf(path);
      let moved = 0;
      const file = join(path, 'deck.json');
      const data = before ? readJson(file) : undefined;
      const notes = notesIn(data);
      if (before && notes) {
        for (const n of notes) {
          if (typeof n !== 'object' || n === null) continue;
          const note = n as Record<string, unknown>;
          if (typeof note.deckName !== 'string') continue;
          const was = note.deckName.split('::').map((s) => s.trim()).join('::');
          if (was === before) note.deckName = name;
          else if (was.startsWith(before + '::')) note.deckName = name + was.slice(before.length);
          else continue;
          moved += 1;
        }
        if (moved) writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
      }
      // The rest of the record stays: the exam a deck is studied for is not its name.
      writeFileSync(join(path, META), JSON.stringify({ ...deckMeta(path), name }, null, 2) + '\n');
      return { name, path, moved };
    },

    // Deleting puts the deck in the trash, whole, for TRASH_DAYS: the
    // lecture files in it may be the only copy the person has.
    'decks/delete': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const path = deckIn(root, str(p, 'path'));
      mkdirSync(join(root, TRASH), { recursive: true });
      const trashed = join(root, TRASH, `${basename(path)}~${Date.now()}`);
      renameSync(path, trashed);
      return { trashed };
    },

    'decks/restore': (raw) => {
      const p = asParams(raw);
      const root = str(p, 'root');
      const trashed = resolve(str(p, 'trashed'));
      if (dirname(trashed) !== resolve(root, TRASH) || !/~\d+$/.test(trashed)) throw new InvalidParams(`params.trashed: "${trashed}" is not a deleted deck under ${root}`);
      if (!isDirectory(trashed)) throw new InvalidParams(`params.trashed: "${trashed}" is gone`);
      if (readClass(trashed)) throw new InvalidParams(`params.trashed: "${trashed}" is a class; classes/restore brings it back`);
      const folder = freeName(root, basename(trashed).replace(/~\d+$/, ''));
      const path = join(root, folder);
      renameSync(trashed, path);
      return { name: nameOf(path) ?? folder, folder, path };
    },

    'course/import': (raw) => {
      const p = asParams(raw);
      const path = str(p, 'path');
      if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
      const sources = p.files;
      if (!Array.isArray(sources) || sources.some((f) => typeof f !== 'string' || f.length === 0)) throw new InvalidParams('params.files must be an array of paths');
      // A dropped folder brings its files, one level, minus dotfiles; the
      // folder itself is not recreated, so "the lecture folder" becomes "the
      // lecture's files" beside whatever was already here.
      const imported: string[] = [];
      const copy = (src: string): void => {
        const dest = join(path, basename(src));
        if (resolve(dest) === resolve(src)) return;
        copyFileSync(src, dest);
        imported.push(basename(src));
      };
      for (const src of sources as string[]) {
        let st;
        try {
          st = statSync(src);
        } catch {
          throw new InvalidParams(`params.files: no such file "${src}"`);
        }
        if (st.isDirectory()) {
          for (const e of readdirSync(src, { withFileTypes: true })) if (e.isFile() && !e.name.startsWith('.')) copy(join(src, e.name));
        } else if (st.isFile()) copy(src);
      }
      return { imported };
    },

    // With `trash: true` -- a material the person removed -- the file and
    // its extraction are moved to the course's own trash rather than
    // deleted, for course/restore; they may be the only copy (a browser drop
    // is). Without it -- a stage clearing its own leftovers -- they are gone.
    'course/delete': (raw) => {
      const p = asParams(raw);
      const path = str(p, 'path');
      const name = str(p, 'name');
      if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
      const full = within(path, name);
      const rel = relative(resolve(path), full);
      if (rel.split(sep)[0] === TRASH) throw new InvalidParams(`params.name: "${name}" is in the trash`);
      if (existsSync(full) && !statSync(full).isFile()) throw new InvalidParams(`params.name: "${name}" is not a regular file`);
      // What the shell extracted from it goes with it -- found from the name
      // as resolved and confined above, not as given: "../../b/c/x" passed the
      // check on the course folder, then climbed out of _extracted/, one level
      // deeper, and was deleted recursively.
      const extraction = join(path, EXTRACTED, rel);
      if (p.trash === true) {
        const moves = [full, extraction].filter((f) => existsSync(f));
        if (moves.length === 0) return { name, removed: false, trashed: null };
        mkdirSync(join(path, TRASH), { recursive: true });
        const stamp = Date.now();
        let id = String(stamp);
        for (let n = 2; existsSync(join(path, TRASH, id)); n += 1) id = `${stamp}-${n}`;
        // The trash entry mirrors the course: <id>/<rel> and <id>/_extracted/<rel>.
        for (const from of moves) {
          const to = join(path, TRASH, id, relative(resolve(path), from));
          mkdirSync(dirname(to), { recursive: true });
          renameSync(from, to);
        }
        return { name, removed: moves.includes(full), trashed: id };
      }
      let removed = false;
      if (existsSync(full)) {
        rmSync(full);
        removed = true;
      }
      rmSync(extraction, { recursive: true, force: true });
      return { name, removed };
    },

    // Puts a trashed material back under its old name, or a numbered one
    // beside it when that name has been taken since.
    'course/restore': (raw) => {
      const p = asParams(raw);
      const path = str(p, 'path');
      const id = str(p, 'trashed');
      if (!/^\d+(-\d+)?$/.test(id)) throw new InvalidParams(`params.trashed: "${id}" is not a trash entry`);
      if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
      const entry = join(path, TRASH, id);
      if (!isDirectory(entry)) throw new InvalidParams(`params.trashed: "${id}" is gone`);
      // The entry's one file outside _extracted/ is the material.
      const found: string[] = [];
      const walk = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const f = join(dir, e.name);
          if (e.isDirectory()) {
            if (!(dir === entry && e.name === EXTRACTED)) walk(f);
          } else if (e.isFile()) found.push(relative(entry, f));
        }
      };
      walk(entry);
      if (found.length !== 1) throw new InvalidParams(`params.trashed: "${id}" does not hold one file`);
      const was = found[0]!;
      const ext = extname(was);
      const stem = was.slice(0, was.length - ext.length);
      let rel = was;
      for (let n = 2; existsSync(join(path, rel)); n += 1) rel = `${stem} (${n})${ext}`;
      mkdirSync(dirname(join(path, rel)), { recursive: true });
      renameSync(join(entry, was), join(path, rel));
      const extraction = join(entry, EXTRACTED, was);
      if (isDirectory(extraction)) {
        const to = join(path, EXTRACTED, rel);
        rmSync(to, { recursive: true, force: true });
        mkdirSync(dirname(to), { recursive: true });
        renameSync(extraction, to);
      }
      rmSync(entry, { recursive: true, force: true });
      return { name: rel.split(sep).join('/') };
    },

    'course/write': (raw) => {
      const p = asParams(raw);
      const path = str(p, 'path');
      const name = str(p, 'name');
      if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
      const full = within(path, name);
      const hasText = typeof p.text === 'string';
      const hasBase64 = typeof p.base64 === 'string';
      if (hasText === hasBase64) throw new InvalidParams('params: exactly one of `text` (UTF-8) or `base64` (bytes) must be given');
      const data = hasText ? Buffer.from(p.text as string, 'utf8') : Buffer.from(p.base64 as string, 'base64');
      if (existsSync(full) && !statSync(full).isFile()) throw new InvalidParams(`params.name: "${name}" is not a regular file`);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
      return { name, bytes: data.length };
    },

    'course/read': (raw) => {
      const p = asParams(raw);
      const path = str(p, 'path');
      const name = str(p, 'name');
      // `encoding: 'base64'` is how a shell with no filesystem of its own gets
      // the bytes of a PDF to the PDF reader in its webview: the desktop app
      // reaches files only through this process. The bridge has /file for the
      // same purpose. Text stays the default and keeps its kind check.
      const encoding = p.encoding === undefined ? 'utf8' : p.encoding;
      if (encoding !== 'utf8' && encoding !== 'base64') throw new InvalidParams(`params.encoding must be "utf8" or "base64"`);
      if (!isDirectory(path)) throw new Error(`${path} is not a directory`);
      const full = within(path, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        throw new InvalidParams(`params.name: no file "${name}"`);
      }
      if (!st.isFile()) throw new InvalidParams(`params.name: "${name}" is not a regular file`);
      if (encoding === 'base64') return { name, base64: readFileSync(full).toString('base64'), bytes: st.size };
      if (classify(basename(full)).kind !== 'text') throw new InvalidParams(`params.name: "${name}" is not a text file`);
      const text = readFileSync(full, 'utf8');
      return { name, text, bytes: st.size };
    },
  };
}
