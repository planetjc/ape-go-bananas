// Course-protocol §3 (docs/research/course-protocol.md): method/list,
// method/read, course/list, course/read. Written from that page and
// sidecar-protocol.md §1-§3 only -- see helpers.ts's header; src/sidecar/
// was never opened. The sidecar reads APE_METHOD_DIR from its environment,
// which spawnSidecar copies from process.env, so each spawn below sets or
// deletes it on process.env for the duration of the spawn call.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import test, { after } from 'node:test';

import { TIMEOUT, makeTmpDir, spawnSidecar, sweepSidecars, writeTmpFile, type RpcMessage, type Sidecar } from './helpers.ts';

after(sweepSidecars);

const METHOD_DIR_MSG = 'APE_METHOD_DIR is not set or not a directory';
const bytesOf = (s: string | Buffer) => Buffer.byteLength(s);

function spawnWithMethodDir(dir: string | undefined): Sidecar {
  const saved = process.env.APE_METHOD_DIR;
  if (dir === undefined) delete process.env.APE_METHOD_DIR; else process.env.APE_METHOD_DIR = dir;
  try { return spawnSidecar(); } finally {
    if (saved === undefined) delete process.env.APE_METHOD_DIR; else process.env.APE_METHOD_DIR = saved;
  }
}

function expectError(res: RpcMessage, code: number, label: string): { message: string; data?: unknown } {
  assert.ok(res.error, `${label}: expected an error response, got ${JSON.stringify(res)}`);
  assert.ok(!('result' in res), `${label}: an error response carries no result`);
  assert.equal(res.error.code, code, `${label}: ${res.error.message}`);
  assert.ok(res.error.message.length > 0, `${label}: message must be human-readable`);
  return res.error;
}
/** Protocol §3: -32602's message names the offending field. */
function expectParamError(res: RpcMessage, field: string, label: string): void {
  const err = expectError(res, -32602, label);
  assert.match(err.message, new RegExp(`\\b${field}\\b`), `${label}: must name \`${field}\`: ${err.message}`);
}

// --- §1 method files -------------------------------------------------------

// Sorted order is a-, b-, c-; each title comes from a different rule.
const METHOD_FILES: Record<string, string> = {
  'a-heading.md': 'Intro prose before the heading.\n\n# Extract facts\n\nBody.\n',
  'b-frontmatter.md': '---\nname: Organize plan\ndescription: no heading anywhere below\n---\n\nBody without a heading.\n',
  'c-bare.md': 'Just prose: no heading, no frontmatter.\n',
};
function makeMethodDir(): string {
  const dir = makeTmpDir('ape-method-');
  for (const [name, text] of Object.entries(METHOD_FILES).reverse()) writeTmpFile(dir, name, text);
  writeTmpFile(dir, 'README.txt', 'not markdown\n'); // not *.md -> not listed
  mkdirSync(join(dir, 'nested'));
  writeTmpFile(join(dir, 'nested'), 'deep.md', '# Not directly in the directory\n'); // not listed either
  return dir;
}

test('method/list: every *.md directly in APE_METHOD_DIR, sorted, titled by heading / frontmatter / file name (§1, §3)', { timeout: TIMEOUT }, async () => {
  const dir = makeMethodDir();
  const s = spawnWithMethodDir(dir);
  await s.ready;
  const res = await s.request(1, 'method/list');
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepStrictEqual(res.result, {
    dir,
    files: [
      { name: 'a-heading.md', title: 'Extract facts', bytes: bytesOf(METHOD_FILES['a-heading.md']) },
      { name: 'b-frontmatter.md', title: 'Organize plan', bytes: bytesOf(METHOD_FILES['b-frontmatter.md']) },
      { name: 'c-bare.md', title: 'c-bare', bytes: bytesOf(METHOD_FILES['c-bare.md']) },
    ],
  });
  assert.equal(await s.end(), 0);
});

test('method/read returns the exact text of each listed file (§1, §3)', { timeout: TIMEOUT }, async () => {
  const s = spawnWithMethodDir(makeMethodDir());
  await s.ready;
  let id = 0;
  for (const [name, text] of Object.entries(METHOD_FILES)) {
    const res = await s.request(++id, 'method/read', { name });
    assert.deepStrictEqual(res, { jsonrpc: '2.0', id, result: { name, text } });
  }
  assert.equal(await s.end(), 0);
});

test('method/read refuses ../x.md, a/b.md, an unknown name and a bad `name` param with -32602 (§1, §3)', { timeout: TIMEOUT }, async () => {
  const s = spawnWithMethodDir(makeMethodDir());
  await s.ready;
  // "bare file name that method/list would return (no `/`, no `..`); otherwise -32602 naming `name`"
  for (const [id, name] of [[1, '../x.md'], [2, 'a/b.md'], [3, 'nested/deep.md'], [4, '..']] as const) {
    expectParamError(await s.request(id, 'method/read', { name }), 'name', name);
  }
  expectParamError(await s.request(5, 'method/read', {}), 'name', 'name absent');
  expectParamError(await s.request(6, 'method/read', { name: 7 }), 'name', 'name not a string');
  // "A name not present -> -32602" (the message text is not pinned by the spec).
  expectError(await s.request(7, 'method/read', { name: 'unknown.md' }), -32602, 'unknown name');
  expectError(await s.request(8, 'method/read', { name: 'README.txt' }), -32602, 'present on disk but never listed');
  // §2 lifecycle: the process survives every refusal.
  assert.deepStrictEqual((await s.request(9, 'method/read', { name: 'c-bare.md' })).result, { name: 'c-bare.md', text: METHOD_FILES['c-bare.md'] });
  assert.equal(await s.end(), 0);
});

test('APE_METHOD_DIR unset or not a directory -> -32000 with the fixed message on both methods (§1, §3)', { timeout: TIMEOUT }, async () => {
  const unset = spawnWithMethodDir(undefined);
  const notDir = spawnWithMethodDir(writeTmpFile(makeTmpDir(), 'method-file.md', '# a file, not a directory\n'));
  await Promise.all([unset.ready, notDir.ready]);
  for (const [s, label] of [[unset, 'unset'], [notDir, 'a file']] as const) {
    assert.equal(expectError(await s.request(1, 'method/list'), -32000, `${label}: list`).message, METHOD_DIR_MSG);
    assert.equal(expectError(await s.request(2, 'method/read', { name: 'a.md' }), -32000, `${label}: read`).message, METHOD_DIR_MSG);
    assert.equal(((await s.request(3, 'sidecar/ping')).result as { engine: string }).engine, 'ape', `${label}: still alive`);
    assert.equal(await s.end(), 0);
  }
});

// --- §2 the course folder --------------------------------------------------

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP = Buffer.from('PK', 'latin1');
/** [relPath, content, kind, mimeType], already in the order `course/list` must return. */
const COURSE_FILES: Array<[string, string | Buffer, string, string]> = [
  // "audio/mp4" is the usual (RFC 4337) registration for .m4a.
  ['audio/lecture.m4a', Buffer.from('\0\0\0\x1cftypM4A ', 'latin1'), 'audio', 'audio/mp4'],
  ['data.json', '{"k": 1}\n', 'text', 'application/json'],
  ['deck.pptx', ZIP, 'slides', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['handout.docx', ZIP, 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['lecture.pdf', '%PDF-1.4\n', 'pdf', 'application/pdf'],
  ['notes.md', '# Notes\n\nUTF-8 text — with a real dash.\n', 'text', 'text/markdown'],
  ['slide.png', PNG, 'image', 'image/png'],
  ['slides/01.png', PNG, 'image', 'image/png'],
  // Strict reading of "`kind` by extension": the extension is matched
  // case-insensitively, so an uppercase .JPG is still an image / image/jpeg.
  ['slides/02.JPG', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image', 'image/jpeg'],
  ['sub/a.txt', 'nested text\n', 'text', 'text/plain'],
  ['transcript.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nhi\n', 'text', 'text/vtt'],
  ['video/clip.mp4', Buffer.from('\0\0\0\x1cftypisom', 'latin1'), 'video', 'video/mp4'],
  ['weird.xyz', 'unknown extension\n', 'other', 'application/octet-stream'],
];
const SKIPPED = ['.DS_Store', '.hidden/secret.md', 'node_modules/x/index.js'];
const ARTIFACTS = ['inventory.md', 'plan.md', 'deck.json', 'flags.json', 'review.html', 'audit.md', 'audit.json', 'verdicts.md', 'out.apkg'];
const NO_ARTIFACTS = { inventory: false, plan: false, deck: false, flags: false, review: false };
const EXPECTED_FILES = COURSE_FILES.map(([relPath, content, kind, mimeType]) => ({ name: basename(relPath), relPath, bytes: bytesOf(content), kind, mimeType }));

/** `<root>/course` holding COURSE_FILES (written in reverse order), the skipped entries, `artifacts`; plus `<root>/outside.md`. */
function makeCourseTree(artifacts: string[] = []): { root: string; dir: string } {
  const root = makeTmpDir('ape-course-');
  const dir = join(root, 'course');
  const put = (rel: string, content: string | Buffer) => {
    mkdirSync(join(dir, dirname(rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  for (const [rel, content] of [...COURSE_FILES].reverse()) put(rel, content);
  for (const rel of SKIPPED) put(rel, 'skipped\n');
  for (const rel of artifacts) put(rel, '{}\n');
  writeFileSync(join(root, 'outside.md'), 'outside the course folder\n');
  return { root, dir };
}

test('course/list: every regular file recursively, sorted by relPath, dotfiles and node_modules skipped, kinds and mime types by extension (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  const res = await s.request(1, 'course/list', { path: dir });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.deepStrictEqual(res.result, { path: dir, name: null, files: EXPECTED_FILES, artifacts: NO_ARTIFACTS, extracted: [], class: null });
  assert.equal(await s.end(), 0);
});

test('course/list: artifacts are reported, never listed as files; *.apkg is skipped (§2, §3)', { timeout: TIMEOUT }, async () => {
  const all = makeCourseTree(ARTIFACTS);
  const planOnly = makeCourseTree(['plan.md']);
  const s = spawnSidecar();
  await s.ready;
  const full = await s.request(1, 'course/list', { path: all.dir });
  assert.equal(full.error, undefined, JSON.stringify(full.error));
  assert.deepStrictEqual(full.result, { path: all.dir, name: null, files: EXPECTED_FILES, artifacts: { inventory: true, plan: true, deck: true, flags: true, review: true }, extracted: [], class: null });
  assert.deepStrictEqual((await s.request(2, 'course/list', { path: planOnly.dir })).result, { path: planOnly.dir, name: null, files: EXPECTED_FILES, artifacts: { ...NO_ARTIFACTS, plan: true }, extracted: [], class: null });
  assert.equal(await s.end(), 0);
});

test('course/list: a path that is not a directory -> -32000; a bad `path` param -> -32602 (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  expectError(await s.request(1, 'course/list', { path: join(dir, 'notes.md') }), -32000, 'a file');
  expectError(await s.request(2, 'course/list', { path: join(dir, 'no-such-dir') }), -32000, 'nonexistent');
  expectParamError(await s.request(3, 'course/list', {}), 'path', 'path absent');
  expectParamError(await s.request(4, 'course/list', { path: 3 }), 'path', 'path not a string');
  assert.equal(((await s.request(5, 'course/list', { path: dir })).result as { files: unknown[] }).files.length, EXPECTED_FILES.length, 'still alive');
  assert.equal(await s.end(), 0);
});

test('course/read returns exact UTF-8 text and byte count for notes.md and nested sub/a.txt (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  for (const [id, name] of [[1, 'notes.md'], [2, 'sub/a.txt']] as const) {
    const text = COURSE_FILES.find(([rel]) => rel === name)![1] as string;
    assert.deepStrictEqual(await s.request(id, 'course/read', { path: dir, name }), { jsonrpc: '2.0', id, result: { name, text, bytes: bytesOf(text) } });
  }
  assert.equal(await s.end(), 0);
});

test('decks/create names a folder from the deck name, numbers a clash; decks/list reports each with its material and artifacts, newest first', { timeout: TIMEOUT }, async () => {
  const root = join(makeTmpDir(), 'decks');
  const s = spawnSidecar();
  await s.ready;
  assert.deepStrictEqual((await s.request(1, 'decks/list', { root })).result, { root, decks: [], folders: [], classes: [], semesters: [] }, 'an empty root is created and empty');
  const a = (await s.request(2, 'decks/create', { root, name: 'Anatomy :: Lecture 3 / part 1' })).result as { name: string; folder: string; path: string };
  assert.equal(a.name, 'Anatomy::Lecture 3 / part 1', 'the name is kept as Anki would read it');
  assert.equal(a.folder, 'Anatomy-Lecture 3 - part 1');
  assert.equal(a.path, join(root, a.folder));
  const b = (await s.request(3, 'decks/create', { root, name: 'Anatomy::Lecture 3 / part 1' })).result as { folder: string };
  assert.equal(b.folder, 'Anatomy-Lecture 3 - part 1 (2)', 'a clash is numbered, not overwritten');
  writeFileSync(join(a.path, 'slides.pdf'), '%PDF-1.4\n');
  writeFileSync(join(a.path, 'inventory.md'), '# inv\n');
  const listed = (await s.request(4, 'decks/list', { root })).result as { decks: { name: string; folder: string; files: number; pdfs: number; artifacts: { inventory: boolean; deck: boolean } }[] };
  assert.deepStrictEqual(listed.decks.map((d) => d.folder).sort(), [a.folder, b.folder]);
  const da = listed.decks.find((d) => d.folder === a.folder)!;
  assert.equal(da.name, 'Anatomy::Lecture 3 / part 1', 'listed by its name, not its folder');
  assert.equal(da.files, 1, 'the name record is not material');
  assert.equal(da.pdfs, 1);
  mkdirSync(join(a.path, 'converted'));
  writeFileSync(join(a.path, 'converted', 'transcript.txt'), 'made by a step');
  writeFileSync(join(a.path, 'objectives.doc'), 'doc');
  const kinds = ((await s.request(7, 'decks/list', { root })).result as { decks: { folder: string; kinds: Record<string, number> }[] }).decks.find((d) => d.folder === a.folder)!.kinds;
  assert.deepStrictEqual(kinds, { pdf: 1, doc: 1 }, 'what was brought, by kind; a subfolder is not counted');
  assert.equal(da.artifacts.inventory, true);
  assert.equal(da.artifacts.deck, false);
  expectParamError(await s.request(5, 'decks/create', { root }), 'name', 'name absent');
  expectParamError(await s.request(6, 'decks/create', { root, name: ' :: ' }), 'name', 'nothing but separators');
  assert.equal(await s.end(), 0);
});

test('decks/rename moves the cards already written with it, and a deck is listed under the deck its cards go to', { timeout: TIMEOUT }, async () => {
  const root = join(makeTmpDir(), 'decks');
  const s = spawnSidecar();
  await s.ready;
  const a = (await s.request(1, 'decks/create', { root, name: 'biochem' })).result as { path: string };
  // The writer chose its own deck path; that is where Send to Anki puts the cards, so that is the name.
  const deck = { notes: [
    { deckName: 'ISF::Biochem', fields: { Text: '{{c1::a}}' } },
    { deckName: 'ISF::Biochem::Sub', fields: { Text: '{{c1::b}}' } },
    { deckName: 'Elsewhere', fields: { Text: '{{c1::c}}' } },
  ] };
  writeFileSync(join(a.path, 'deck.json'), JSON.stringify(deck));
  let listed = (await s.request(2, 'decks/list', { root })).result as { decks: { name: string }[] };
  assert.equal(listed.decks[0]!.name, 'biochem', 'no shared deck across the notes: the given name stands');
  deck.notes.pop();
  writeFileSync(join(a.path, 'deck.json'), JSON.stringify(deck));
  listed = (await s.request(3, 'decks/list', { root })).result as { decks: { name: string }[] };
  assert.equal(listed.decks[0]!.name, 'ISF::Biochem', 'the deck the cards share');

  const r = (await s.request(4, 'decks/rename', { root, path: a.path, name: 'Year 1::Biochem' })).result as { name: string; moved: number };
  assert.deepStrictEqual(r, { name: 'Year 1::Biochem', path: a.path, moved: 2 });
  const after = JSON.parse(readFileSync(join(a.path, 'deck.json'), 'utf8')) as typeof deck;
  assert.deepStrictEqual(after.notes.map((n) => n.deckName), ['Year 1::Biochem', 'Year 1::Biochem::Sub'], 'a subdeck keeps its place beneath');
  assert.equal(((await s.request(5, 'course/list', { path: a.path })).result as { name: string }).name, 'Year 1::Biochem');

  expectParamError(await s.request(6, 'decks/rename', { root, path: root, name: 'x' }), 'path', 'the root itself');
  expectParamError(await s.request(7, 'decks/rename', { root, path: join(root, '..', 'elsewhere'), name: 'x' }), 'path', 'outside the root');
  expectParamError(await s.request(8, 'decks/rename', { root, path: a.path, name: '::' }), 'name', 'an empty name');
  assert.equal(await s.end(), 0);
});

test('folders: made before any deck, nested, kept once empty; renamed with what is beneath; deleted only when empty', { timeout: TIMEOUT }, async () => {
  const root = join(makeTmpDir(), 'decks');
  const s = spawnSidecar();
  await s.ready;
  const r = (await s.request(1, 'folders/create', { root, name: 'ISF :: Test 2' })).result as { name: string; folders: string[] };
  assert.deepStrictEqual(r, { name: 'ISF::Test 2', folders: ['ISF', 'ISF::Test 2'] }, 'its parents come with it');
  const listed = (await s.request(2, 'decks/list', { root })).result as { decks: unknown[]; folders: string[] };
  assert.deepStrictEqual(listed, { root, decks: [], folders: ['ISF', 'ISF::Test 2'], classes: [], semesters: [] }, 'an empty folder is listed');

  const a = (await s.request(3, 'decks/create', { root, name: 'Year 1::Pharm::Lecture 1' })).result as { path: string };
  assert.deepStrictEqual(((await s.request(4, 'decks/list', { root })).result as { folders: string[] }).folders, ['ISF', 'ISF::Test 2', 'Year 1', 'Year 1::Pharm'], 'a deck\'s folders are kept too');
  await s.request(5, 'decks/rename', { root, path: a.path, name: 'Lecture 1' });
  assert.deepStrictEqual(((await s.request(6, 'decks/list', { root })).result as { folders: string[] }).folders, ['ISF', 'ISF::Test 2', 'Year 1', 'Year 1::Pharm'], 'and outlast the deck moving out');

  const moved = (await s.request(7, 'folders/rename', { root, from: 'ISF', to: 'Summer::ISF' })).result as { folders: string[] };
  assert.deepStrictEqual(moved.folders, ['Summer', 'Summer::ISF', 'Summer::ISF::Test 2', 'Year 1', 'Year 1::Pharm']);
  expectParamError(await s.request(8, 'folders/rename', { root, from: 'Summer', to: 'Summer::Inner' }), 'to', 'into itself');

  await s.request(9, 'decks/rename', { root, path: a.path, name: 'Year 1::Pharm::Lecture 1' });
  expectParamError(await s.request(10, 'folders/delete', { root, name: 'Year 1' }), 'name', 'a folder with a deck beneath');
  const del = (await s.request(11, 'folders/delete', { root, name: 'Summer' })).result as { removed: string[]; folders: string[] };
  assert.deepStrictEqual(del.folders, ['Year 1', 'Year 1::Pharm'], 'an empty folder goes with its empty subfolders');
  assert.deepStrictEqual(del.removed, ['Summer', 'Summer::ISF', 'Summer::ISF::Test 2'], 'named, so they can be made again');
  assert.deepStrictEqual((del as { classes?: string[] }).classes, [], 'no class was in it');
  assert.deepStrictEqual((del as { semesters?: unknown[] }).semesters, [], 'nor a semester');
  expectParamError(await s.request(12, 'folders/create', { root, name: '::' }), 'name', 'an empty name');
  assert.equal(await s.end(), 0);
});

/** A day `n` days from today on this machine's calendar, as the engine reads "today". */
function dayFromToday(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface ClassResult { folder: string; path: string; exams: { id: string; name: string; date: string | null; covers?: string; setBy?: string }[]; brief: string; files: number; newPapers?: string[]; exam?: { name: string } | null; choice?: string }

test('classes: a folder made a class keeps its papers apart, lists its exams, reviews its brief by version; one class to a deck', { timeout: TIMEOUT }, async () => {
  const root = join(makeTmpDir(), 'decks');
  const s = spawnSidecar();
  await s.ready;
  const made = (await s.request(1, 'classes/create', { root, folder: 'Year 1 :: Histology' })).result as ClassResult;
  assert.equal(made.folder, 'Year 1::Histology', 'the folder is kept as Anki would read it');
  assert.equal(dirname(made.path), join(root, '.classes'), 'its papers live in a dot folder, never listed as a deck');
  assert.deepStrictEqual({ ...made, path: '' }, { folder: 'Year 1::Histology', path: '', exams: [], brief: 'none', files: 0, newPapers: [] });
  const listed = (await s.request(2, 'decks/list', { root })).result as { decks: unknown[]; folders: string[]; classes: ClassResult[] };
  assert.deepStrictEqual(listed.decks, [], 'the class folder is not a deck');
  assert.deepStrictEqual(listed.folders, ['Year 1', 'Year 1::Histology'], 'its folder exists before any deck is in it');
  assert.deepStrictEqual(listed.classes.map((c) => c.folder), ['Year 1::Histology']);

  expectParamError(await s.request(3, 'classes/create', { root, folder: 'Year 1::Histology' }), 'folder', 'a class already');
  expectParamError(await s.request(4, 'classes/create', { root, folder: 'Year 1' }), 'folder', 'around a class');
  expectParamError(await s.request(5, 'classes/create', { root, folder: 'Year 1::Histology::Lab' }), 'folder', 'inside a class');

  // Its papers are material; the brief, exams.json and the record are not.
  writeFileSync(join(made.path, 'syllabus.pdf'), '%PDF-1.4\n');
  writeFileSync(join(made.path, 'class.md'), '# Histology\n');
  writeFileSync(join(made.path, 'exams.json'), '[]');
  const own = (await s.request(6, 'course/list', { path: made.path })).result as { files: { relPath: string }[]; class: ClassResult };
  assert.deepStrictEqual(own.files.map((f) => f.relPath), ['syllabus.pdf']);
  assert.equal(own.class.path, made.path, 'a class\'s own folder is listed as its own class');
  assert.equal(own.class.brief, 'written');
  assert.equal(own.class.exam, null);

  const future = dayFromToday(30);
  const past = dayFromToday(-30);
  const upd = (await s.request(7, 'classes/update', { root, path: made.path, exams: [
    { name: ' Midterm  2 ', date: future, covers: 'Lectures 5–8' },
    { name: 'Midterm 1', date: past },
    { name: 'Final', date: null },
  ] })).result as ClassResult;
  assert.deepStrictEqual(upd.exams, [
    { id: 'e2', name: 'Midterm 1', date: past, setBy: 'person' },
    { id: 'e1', name: 'Midterm 2', date: future, covers: 'Lectures 5–8', setBy: 'person' },
    { id: 'e3', name: 'Final', date: null, setBy: 'person' },
  ], 'ids given in order; listed soonest first, an undated one last; made by hand, so the person\'s');
  // From the papers, an exam is not the person's; changed by hand afterwards, it is.
  const fromPapers = (await s.request(71, 'classes/update', { root, path: made.path, by: 'papers', exams: [{ name: 'Quiz', date: future }] })).result as ClassResult;
  assert.deepStrictEqual(fromPapers.exams, [{ id: 'e4', name: 'Quiz', date: future }]);
  const unchanged = (await s.request(72, 'classes/update', { root, path: made.path, exams: [{ id: 'e4', name: 'Quiz', date: future }] })).result as ClassResult;
  assert.equal((unchanged.exams[0] as { setBy?: string }).setBy, undefined, 'saved as it was: still the papers\'');
  const edited = (await s.request(73, 'classes/update', { root, path: made.path, exams: [{ id: 'e4', name: 'Quiz', date: past }] })).result as ClassResult;
  assert.equal((edited.exams[0] as { setBy?: string }).setBy, 'person', 'its date changed by hand');
  expectParamError(await s.request(74, 'classes/update', { root, path: made.path, by: 'agent', exams: [] }), 'by', 'an unknown source');
  await s.request(75, 'classes/update', { root, path: made.path, exams: upd.exams });
  expectParamError(await s.request(8, 'classes/update', { root, path: made.path, exams: [{ name: 'X', date: '2026-02-30x' }] }), 'exams', 'not a date');
  expectParamError(await s.request(9, 'classes/update', { root, path: made.path, exams: [{ name: '  ' }] }), 'exams', 'no name');
  expectParamError(await s.request(10, 'classes/update', { root, path: root, exams: [] }), 'path', 'not a class');

  const reviewed = (await s.request(11, 'classes/review', { root, path: made.path })).result as ClassResult;
  assert.equal(reviewed.brief, 'reviewed');
  // Papers added after the brief are named as not in it, until it is written from them.
  assert.deepStrictEqual(reviewed.newPapers, [], 'a brief with no record of its papers is taken to have read them all');
  const briefed = (await s.request(111, 'classes/briefed', { root, path: made.path })).result as ClassResult & { newPapers: string[] };
  assert.deepStrictEqual(briefed.newPapers, []);
  writeFileSync(join(made.path, 'study guide.pdf'), '%PDF-1.4\n');
  writeFileSync(join(made.path, 'notes.txt'), 'notes');
  mkdirSync(join(made.path, 'converted'));
  writeFileSync(join(made.path, 'converted', 'made.md'), 'a step made this');
  assert.deepStrictEqual(((await s.request(112, 'decks/list', { root })).result as { classes: (ClassResult & { newPapers: string[] })[] }).classes[0]!.newPapers, ['notes.txt', 'study guide.pdf'], 'new papers, not what a step made');
  assert.deepStrictEqual(((await s.request(113, 'classes/briefed', { root, path: made.path })).result as { newPapers: string[] }).newPapers, [], 'written from them: none new');
  writeFileSync(join(made.path, 'class.md'), '# Histology, again\n');
  utimesSync(join(made.path, 'class.md'), new Date(), new Date(Date.now() + 5000));
  assert.equal(((await s.request(12, 'decks/list', { root })).result as { classes: ClassResult[] }).classes[0]!.brief, 'written', 'a rewritten brief is unread again');

  // A deck in the class is given the class, and the next exam unless it was given another.
  const deck = (await s.request(13, 'decks/create', { root, name: 'Year 1::Histology::03 Cartilage' })).result as { path: string };
  let cls = ((await s.request(14, 'course/list', { path: deck.path })).result as { class: ClassResult }).class;
  assert.equal(cls.path, made.path);
  assert.deepStrictEqual([cls.exam?.name, cls.choice], ['Midterm 2', 'next'], 'the past exam is passed over');
  cls = ((await s.request(15, 'decks/exam', { root, path: deck.path, exam: 'e3' })).result as { class: ClassResult }).class;
  assert.deepStrictEqual([cls.exam?.name, cls.choice], ['Final', 'e3']);
  cls = ((await s.request(16, 'decks/exam', { root, path: deck.path, exam: 'none' })).result as { class: ClassResult }).class;
  assert.deepStrictEqual([cls.exam, cls.choice], [null, 'none']);
  expectParamError(await s.request(17, 'decks/exam', { root, path: deck.path, exam: 'e9' }), 'exam', 'no such exam');
  await s.request(18, 'decks/rename', { root, path: deck.path, name: 'Year 1::Histology::03 Cartilage and bone' });
  cls = ((await s.request(19, 'course/list', { path: deck.path })).result as { class: ClassResult }).class;
  assert.equal(cls.choice, 'none', 'a rename keeps the exam the deck was given');
  const loose = (await s.request(20, 'decks/create', { root, name: 'Loose' })).result as { path: string };
  assert.equal(((await s.request(21, 'course/list', { path: loose.path })).result as { class: unknown }).class, null);
  expectParamError(await s.request(22, 'decks/exam', { root, path: loose.path, exam: 'next' }), 'path', 'in no class');

  // The class follows its folder; one moved inside another is refused.
  await s.request(23, 'folders/rename', { root, from: 'Year 1', to: 'Y1' });
  assert.equal(((await s.request(24, 'decks/list', { root })).result as { classes: ClassResult[] }).classes[0]!.folder, 'Y1::Histology');
  const pharm = (await s.request(25, 'classes/create', { root, folder: 'Pharm' })).result as ClassResult;
  expectParamError(await s.request(26, 'folders/rename', { root, from: 'Pharm', to: 'Y1::Histology::Pharm' }), 'to', 'a class inside a class');

  // Back to a plain folder, and back again; a deck's restore does not take a class.
  const { trashed } = (await s.request(27, 'classes/remove', { root, path: pharm.path })).result as { trashed: string };
  const after = (await s.request(28, 'decks/list', { root })).result as { folders: string[]; classes: ClassResult[] };
  assert.deepStrictEqual(after.classes.map((c) => c.folder), ['Y1::Histology']);
  assert.ok(after.folders.includes('Pharm'), 'the folder stays');
  expectParamError(await s.request(29, 'decks/restore', { root, trashed }), 'trashed', 'a class is not a deck');
  const back = (await s.request(30, 'classes/restore', { root, trashed })).result as ClassResult;
  assert.equal(back.folder, 'Pharm');

  // Deleting an empty folder takes its class to the trash, for restoring.
  const del = (await s.request(31, 'folders/delete', { root, name: 'Pharm' })).result as { classes: string[] };
  assert.equal(del.classes.length, 1);
  assert.deepStrictEqual(((await s.request(32, 'decks/list', { root })).result as { classes: ClassResult[] }).classes.map((c) => c.folder), ['Y1::Histology']);
  assert.equal(((await s.request(33, 'classes/restore', { root, trashed: del.classes[0] })).result as ClassResult).folder, 'Pharm');
  assert.equal(await s.end(), 0);
});

interface SemesterResult { folder: string; start: string | null; end: string | null }

test('semesters: a folder whose classes share a term, with its dates; they follow their folder and never nest', { timeout: TIMEOUT }, async () => {
  const root = join(makeTmpDir(), 'decks');
  const s = spawnSidecar();
  await s.ready;
  const made = (await s.request(1, 'semesters/create', { root, folder: 'Fall 2026', start: '2026-08-24', end: '2026-12-18' })).result as { semester: SemesterResult; semesters: SemesterResult[] };
  assert.deepStrictEqual(made.semester, { folder: 'Fall 2026', start: '2026-08-24', end: '2026-12-18' });
  await s.request(2, 'semesters/create', { root, folder: 'Spring 2026', start: '2026-01-12', end: null });
  const listed = (await s.request(3, 'decks/list', { root })).result as { folders: string[]; semesters: SemesterResult[] };
  assert.deepStrictEqual(listed.folders, ['Fall 2026', 'Spring 2026'], 'a semester is a folder before anything is in it');
  assert.deepStrictEqual(listed.semesters.map((t) => t.folder), ['Fall 2026', 'Spring 2026'], 'newest term first');

  expectParamError(await s.request(4, 'semesters/create', { root, folder: 'Fall 2026' }), 'folder', 'a semester already');
  expectParamError(await s.request(5, 'semesters/create', { root, folder: 'Fall 2026::Block 1' }), 'folder', 'a semester inside a semester');
  expectParamError(await s.request(6, 'semesters/create', { root, folder: 'X', start: '2026-09-01', end: '2026-08-01' }), 'end', 'an end before its start');
  expectParamError(await s.request(7, 'semesters/create', { root, folder: 'X', start: 'Sept' }), 'start', 'not a date');

  // Classes go inside a semester; a semester goes inside no class, and no class is one.
  const cls = (await s.request(8, 'classes/create', { root, folder: 'Fall 2026::Histology' })).result as ClassResult;
  assert.equal(cls.folder, 'Fall 2026::Histology');
  expectParamError(await s.request(9, 'classes/create', { root, folder: 'Spring 2026' }), 'folder', 'a semester is not a class');
  expectParamError(await s.request(10, 'semesters/create', { root, folder: 'Fall 2026::Histology' }), 'folder', 'a class is not a semester');
  expectParamError(await s.request(11, 'semesters/create', { root, folder: 'Fall 2026::Histology::Term' }), 'folder', 'inside a class');
  expectParamError(await s.request(12, 'folders/rename', { root, from: 'Spring 2026', to: 'Fall 2026::Spring' }), 'to', 'a semester moved into a semester');

  // A class moved from one semester to another is a folder rename; its record follows.
  await s.request(13, 'folders/rename', { root, from: 'Fall 2026::Histology', to: 'Spring 2026::Histology' });
  assert.equal(((await s.request(14, 'decks/list', { root })).result as { classes: ClassResult[] }).classes[0]!.folder, 'Spring 2026::Histology');
  // A semester renamed takes its dates and its classes along.
  await s.request(15, 'folders/rename', { root, from: 'Spring 2026', to: 'Year 1::Spring 2026' });
  const after = (await s.request(16, 'decks/list', { root })).result as { classes: ClassResult[]; semesters: SemesterResult[] };
  assert.deepStrictEqual(after.semesters.find((t) => t.folder === 'Year 1::Spring 2026'), { folder: 'Year 1::Spring 2026', start: '2026-01-12', end: null });
  assert.equal(after.classes[0]!.folder, 'Year 1::Spring 2026::Histology');

  const upd = (await s.request(17, 'semesters/update', { root, folder: 'Fall 2026', start: '2026-08-20', end: '2026-12-20' })).result as { semester: SemesterResult };
  assert.deepStrictEqual(upd.semester, { folder: 'Fall 2026', start: '2026-08-20', end: '2026-12-20' });
  expectParamError(await s.request(18, 'semesters/update', { root, folder: 'Nope' }), 'folder', 'not a semester');

  // Made plain, the folder stays; deleted, its dates come back for Undo, and its classes go to the trash.
  const plain = (await s.request(19, 'semesters/remove', { root, folder: 'Fall 2026' })).result as { removed: SemesterResult; semesters: SemesterResult[] };
  assert.deepStrictEqual(plain.removed, { folder: 'Fall 2026', start: '2026-08-20', end: '2026-12-20' });
  assert.ok(((await s.request(20, 'decks/list', { root })).result as { folders: string[] }).folders.includes('Fall 2026'));
  const del = (await s.request(21, 'folders/delete', { root, name: 'Year 1' })).result as { classes: string[]; semesters: SemesterResult[] };
  assert.deepStrictEqual(del.semesters, [{ folder: 'Year 1::Spring 2026', start: '2026-01-12', end: null }]);
  assert.equal(del.classes.length, 1, 'the class inside went to the trash');
  assert.deepStrictEqual(((await s.request(22, 'decks/list', { root })).result as { semesters: SemesterResult[] }).semesters, []);
  assert.equal(await s.end(), 0);
});

test('decks/delete puts a deck in the trash, whole; decks/restore brings it back beside whatever took its folder', { timeout: TIMEOUT }, async () => {
  const root = join(makeTmpDir(), 'decks');
  const s = spawnSidecar();
  await s.ready;
  const a = (await s.request(1, 'decks/create', { root, name: 'Lecture 1' })).result as { path: string; folder: string };
  writeFileSync(join(a.path, 'slides.pdf'), '%PDF-1.4\n');
  const { trashed } = (await s.request(2, 'decks/delete', { root, path: a.path })).result as { trashed: string };
  assert.equal(existsSync(a.path), false);
  assert.equal(readFileSync(join(trashed, 'slides.pdf'), 'utf8'), '%PDF-1.4\n', 'the files went with it, not away');
  assert.deepStrictEqual(((await s.request(3, 'decks/list', { root })).result as { decks: unknown[] }).decks, [], 'the trash is not a deck');

  await s.request(4, 'decks/create', { root, name: 'Lecture 1' }); // takes the folder back meanwhile
  const back = (await s.request(5, 'decks/restore', { root, trashed })).result as { name: string; folder: string; path: string };
  assert.deepStrictEqual(back, { name: 'Lecture 1', folder: 'Lecture 1 (2)', path: join(root, 'Lecture 1 (2)') });
  assert.equal(existsSync(join(back.path, 'slides.pdf')), true);

  expectParamError(await s.request(6, 'decks/delete', { root, path: root }), 'path', 'the root');
  expectParamError(await s.request(7, 'decks/delete', { root, path: join(root, '.trash') }), 'path', 'the trash');
  expectParamError(await s.request(8, 'decks/delete', { root, path: join(dirname(root), 'x') }), 'path', 'beside the root');
  expectParamError(await s.request(9, 'decks/restore', { root, trashed: back.path }), 'trashed', 'not in the trash');

  // A deck deleted long ago is gone for good at the next listing.
  const { trashed: old } = (await s.request(10, 'decks/delete', { root, path: back.path })).result as { trashed: string };
  const ancient = old.replace(/~\d+$/, `~${Date.now() - 31 * 24 * 60 * 60 * 1000}`);
  renameSync(old, ancient);
  await s.request(11, 'decks/list', { root });
  assert.equal(existsSync(ancient), false);
  assert.equal(await s.end(), 0);
});

test('course/import copies files, and a folder\'s files one level deep minus dotfiles; course/delete removes a file with its extraction', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const src = makeTmpDir();
  writeFileSync(join(src, 'a.pdf'), '%PDF-a');
  mkdirSync(join(src, 'lecture'));
  writeFileSync(join(src, 'lecture', 'b.pdf'), '%PDF-b');
  writeFileSync(join(src, 'lecture', '.DS_Store'), 'x');
  mkdirSync(join(src, 'lecture', 'nested'));
  writeFileSync(join(src, 'lecture', 'nested', 'c.pdf'), '%PDF-c');
  const s = spawnSidecar();
  await s.ready;
  const r = (await s.request(1, 'course/import', { path: dir, files: [join(src, 'a.pdf'), join(src, 'lecture')] })).result as { imported: string[] };
  assert.deepStrictEqual(r.imported.sort(), ['a.pdf', 'b.pdf'], 'nested/ and the dotfile are left behind');
  assert.equal(readFileSync(join(dir, 'b.pdf'), 'utf8'), '%PDF-b');
  expectParamError(await s.request(2, 'course/import', { path: dir, files: [join(src, 'missing.pdf')] }), 'files', 'a missing source');
  expectParamError(await s.request(3, 'course/import', { path: dir, files: 'a.pdf' }), 'files', 'not an array');
  // An extraction beside the file goes with it.
  await s.request(4, 'course/write', { path: dir, name: '_extracted/a.pdf/text.md', text: '# a' });
  assert.deepStrictEqual((await s.request(5, 'course/delete', { path: dir, name: 'a.pdf' })).result, { name: 'a.pdf', removed: true });
  assert.equal(existsSync(join(dir, 'a.pdf')), false);
  assert.equal(existsSync(join(dir, '_extracted', 'a.pdf')), false);
  assert.deepStrictEqual((await s.request(6, 'course/delete', { path: dir, name: 'a.pdf' })).result, { name: 'a.pdf', removed: false }, 'deleting twice is not an error');
  expectParamError(await s.request(7, 'course/delete', { path: dir, name: '../outside.md' }), 'name', 'escapes path');
  expectParamError(await s.request(8, 'course/delete', { path: dir, name: 'sub' }), 'name', 'a directory');
  assert.equal(await s.end(), 0);
});

test('course/delete with trash: true moves a material and its extraction aside; course/restore puts them back, beside a file that took the name meanwhile', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  writeFileSync(join(dir, 'a.pdf'), '%PDF-a');
  await s.request(1, 'course/write', { path: dir, name: '_extracted/a.pdf/text.md', text: '# a' });
  const del = (await s.request(2, 'course/delete', { path: dir, name: 'a.pdf', trash: true })).result as { removed: boolean; trashed: string };
  assert.equal(del.removed, true);
  assert.match(del.trashed, /^\d+$/);
  assert.equal(existsSync(join(dir, 'a.pdf')), false);
  assert.equal(existsSync(join(dir, '_extracted', 'a.pdf')), false);
  const listed = (await s.request(3, 'course/list', { path: dir })).result as { files: { relPath: string }[] };
  assert.ok(!listed.files.some((f) => f.relPath.includes('a.pdf') || f.relPath.startsWith('.trash')), 'the trash is not material');

  writeFileSync(join(dir, 'a.pdf'), '%PDF-new'); // dropped again meanwhile
  assert.deepStrictEqual((await s.request(4, 'course/restore', { path: dir, trashed: del.trashed })).result, { name: 'a (2).pdf' });
  assert.equal(readFileSync(join(dir, 'a (2).pdf'), 'utf8'), '%PDF-a');
  assert.equal(readFileSync(join(dir, 'a.pdf'), 'utf8'), '%PDF-new', 'the newer file is left alone');
  assert.equal(readFileSync(join(dir, '_extracted', 'a (2).pdf', 'text.md'), 'utf8'), '# a', 'its extraction follows its new name');
  assert.equal(existsSync(join(dir, '.trash', del.trashed)), false, 'the entry is emptied');

  expectParamError(await s.request(5, 'course/restore', { path: dir, trashed: del.trashed }), 'trashed', 'restored twice');
  expectParamError(await s.request(6, 'course/restore', { path: dir, trashed: '../x' }), 'trashed', 'not an entry id');
  expectParamError(await s.request(7, 'course/delete', { path: dir, name: '.trash/x', trash: true }), 'name', 'inside the trash');

  // Without trash: gone, as the stages want their leftovers.
  assert.deepStrictEqual((await s.request(8, 'course/delete', { path: dir, name: 'a.pdf' })).result, { name: 'a.pdf', removed: true });
  assert.equal(existsSync(join(dir, '.trash')) && readdirSync(join(dir, '.trash')).length > 0, false);

  // A removal a month old is gone for good at the next listing.
  const { trashed } = (await s.request(9, 'course/delete', { path: dir, name: 'a (2).pdf', trash: true })).result as { trashed: string };
  const old = String(Date.now() - 31 * 24 * 60 * 60 * 1000);
  renameSync(join(dir, '.trash', trashed), join(dir, '.trash', old));
  await s.request(10, 'course/list', { path: dir });
  assert.equal(existsSync(join(dir, '.trash', old)), false);
  assert.equal(await s.end(), 0);
});

test('course/delete: a name that stays in the course folder cannot climb out of _extracted/ when its extraction is removed', { timeout: TIMEOUT }, async () => {
  // <root>/course is the course. "../../<root name>/course/x" resolves to
  // <root>/course/x -- inside, so it passes -- but joined onto _extracted/ it
  // named <root>/<root name>/course/x, outside the course, deleted recursively.
  const { root, dir } = makeCourseTree();
  const victim = join(root, basename(root), 'course', 'x');
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, 'keep.txt'), 'not the course\'s');
  writeFileSync(join(dir, 'x'), 'a file in the course');
  const s = spawnSidecar();
  await s.ready;
  const name = `../../${basename(root)}/course/x`;
  assert.deepStrictEqual((await s.request(1, 'course/delete', { path: dir, name })).result, { name, removed: true });
  assert.equal(existsSync(join(dir, 'x')), false, 'the course file it names is removed');
  assert.equal(readFileSync(join(victim, 'keep.txt'), 'utf8'), 'not the course\'s', 'nothing outside the course is');
  assert.equal(await s.end(), 0);
});

test('course/read with encoding "base64" returns the exact bytes of any kind, and refuses another encoding (§2)', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  for (const [id, name] of [[1, 'slide.png'], [2, 'lecture.pdf'], [3, 'notes.md']] as const) {
    const content = COURSE_FILES.find(([rel]) => rel === name)![1];
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    assert.deepStrictEqual(await s.request(id, 'course/read', { path: dir, name, encoding: 'base64' }), { jsonrpc: '2.0', id, result: { name, base64: buf.toString('base64'), bytes: buf.length } });
  }
  // The confinement is the same in both encodings; the text-kind check is not.
  expectParamError(await s.request(4, 'course/read', { path: dir, name: '../outside.md', encoding: 'base64' }), 'name', 'escapes path');
  expectParamError(await s.request(5, 'course/read', { path: dir, name: 'notes.md', encoding: 'latin1' }), 'encoding', 'unknown encoding');
  assert.equal(await s.end(), 0);
});

test('course/read refuses an escaping name, a non-text kind, a non-file, and bad params with -32602 (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { root, dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  expectParamError(await s.request(1, 'course/read', { path: dir, name: '../outside.md' }), 'name', 'escapes path (exists, still refused)');
  expectParamError(await s.request(2, 'course/read', { path: dir, name: join(root, 'outside.md') }), 'name', 'absolute name escapes path');
  const png = expectError(await s.request(3, 'course/read', { path: dir, name: 'slide.png' }), -32602, 'slide.png');
  assert.match(png.message, /is not a text file/, png.message);
  expectError(await s.request(4, 'course/read', { path: dir, name: 'sub' }), -32602, 'a directory is not a regular file');
  expectError(await s.request(5, 'course/read', { path: dir, name: 'missing.txt' }), -32602, 'a missing file is not a regular file');
  expectParamError(await s.request(6, 'course/read', { path: dir }), 'name', 'name absent');
  expectParamError(await s.request(7, 'course/read', { name: 'notes.md' }), 'path', 'path absent');
  assert.equal(((await s.request(8, 'course/read', { path: dir, name: 'sub/a.txt' })).result as { bytes: number }).bytes, bytesOf('nested text\n'), 'still alive');
  assert.equal(await s.end(), 0);
});

// --- §2 course/write and `extracted` ---------------------------------------

test('course/write puts text and bytes beneath the folder, creating directories; course/list reports them as `extracted`, never as files (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  const md = '# lecture.pdf\n\n## Page 1\n\nUTF-8 text — with a dash.\n';
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  // images first, text last: the page writes in that order, and only a
  // finished extraction has its text.md
  assert.deepStrictEqual(await s.request(1, 'course/write', { path: dir, name: '_extracted/lecture.pdf/p002.png', base64: png.toString('base64') }), { jsonrpc: '2.0', id: 1, result: { name: '_extracted/lecture.pdf/p002.png', bytes: png.length } });
  assert.deepStrictEqual((await s.request(2, 'course/write', { path: dir, name: '_extracted/lecture.pdf/p001.png', base64: png.toString('base64') })).result, { name: '_extracted/lecture.pdf/p001.png', bytes: png.length });
  const partial = (await s.request(3, 'course/list', { path: dir })).result as { files: unknown; extracted: unknown };
  assert.deepStrictEqual(partial.files, EXPECTED_FILES, 'nothing under _extracted/ is material');
  assert.deepStrictEqual(partial.extracted, [{ source: 'lecture.pdf', text: null, images: ['_extracted/lecture.pdf/p001.png', '_extracted/lecture.pdf/p002.png'] }], 'images sorted by name, text absent until written');
  assert.deepStrictEqual((await s.request(4, 'course/write', { path: dir, name: '_extracted/lecture.pdf/text.md', text: md })).result, { name: '_extracted/lecture.pdf/text.md', bytes: bytesOf(md) });
  const done = (await s.request(5, 'course/list', { path: dir })).result as { extracted: unknown };
  assert.deepStrictEqual(done.extracted, [{ source: 'lecture.pdf', text: '_extracted/lecture.pdf/text.md', images: ['_extracted/lecture.pdf/p001.png', '_extracted/lecture.pdf/p002.png'] }]);
  assert.deepStrictEqual(readFileSync(join(dir, '_extracted/lecture.pdf/p001.png')), png, 'bytes round-trip exactly');
  assert.equal(readFileSync(join(dir, '_extracted/lecture.pdf/text.md'), 'utf8'), md, 'text round-trips exactly');
  assert.deepStrictEqual((await s.request(6, 'course/read', { path: dir, name: '_extracted/lecture.pdf/text.md' })).result, { name: '_extracted/lecture.pdf/text.md', text: md, bytes: bytesOf(md) }, 'and is readable back through course/read');
  // a nested source keeps its path; an extracted dir for nothing listed is ignored
  await s.request(7, 'course/write', { path: dir, name: '_extracted/sub/a.txt/text.md', text: 'x' });
  await s.request(8, 'course/write', { path: dir, name: '_extracted/ghost.pdf/text.md', text: 'x' });
  const nested = (await s.request(9, 'course/list', { path: dir })).result as { extracted: { source: string }[] };
  assert.deepStrictEqual(nested.extracted.map((e) => e.source), ['lecture.pdf', 'sub/a.txt'], 'source order, ghost skipped');
  // overwriting is allowed: a re-extraction replaces
  assert.deepStrictEqual((await s.request(10, 'course/write', { path: dir, name: '_extracted/lecture.pdf/text.md', text: 'v2' })).result, { name: '_extracted/lecture.pdf/text.md', bytes: 2 });
  assert.equal(readFileSync(join(dir, '_extracted/lecture.pdf/text.md'), 'utf8'), 'v2');
  assert.equal(await s.end(), 0);
});

test('course/write refuses an escaping name, the folder itself, a directory, both or neither body, and bad params with -32602 (§2, §3)', { timeout: TIMEOUT }, async () => {
  const { root, dir } = makeCourseTree();
  const s = spawnSidecar();
  await s.ready;
  expectParamError(await s.request(1, 'course/write', { path: dir, name: '../outside.md', text: 'x' }), 'name', 'escapes path');
  expectParamError(await s.request(2, 'course/write', { path: dir, name: join(root, 'outside.md'), text: 'x' }), 'name', 'absolute name escapes path');
  expectParamError(await s.request(3, 'course/write', { path: dir, name: '.', text: 'x' }), 'name', 'the folder itself');
  expectParamError(await s.request(4, 'course/write', { path: dir, name: 'sub', text: 'x' }), 'name', 'a directory is not a regular file');
  expectError(await s.request(5, 'course/write', { path: dir, name: 'a.md', text: 'x', base64: 'eA==' }), -32602, 'both bodies');
  expectError(await s.request(6, 'course/write', { path: dir, name: 'a.md' }), -32602, 'neither body');
  expectParamError(await s.request(7, 'course/write', { path: dir, text: 'x' }), 'name', 'name absent');
  expectParamError(await s.request(8, 'course/write', { name: 'a.md', text: 'x' }), 'path', 'path absent');
  expectError(await s.request(9, 'course/write', { path: join(dir, 'notes.md'), name: 'a.md', text: 'x' }), -32000, 'path is a file');
  assert.equal(readFileSync(join(root, 'outside.md'), 'utf8'), 'outside the course folder\n', 'nothing outside was touched');
  assert.equal(existsSync(join(dir, 'a.md')), false, 'nothing was written by a refused call');
  assert.equal(await s.end(), 0);
})
