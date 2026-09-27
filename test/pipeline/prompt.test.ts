// src/pipeline/stageBlocks: what a writing stage hands the agent, over a
// fake client. The two additions since the first website run are pinned:
// a companion method file is attached and named, and extracted text is
// described and linked so the agent never probes for PDF tooling.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CLASS_STAGE, classUpdateStage, describeExtracted, makeRunner, stageBlocks, timeLine, WRITING_STAGES, type ContentBlock, type CourseClassLike, type PipelineClient } from '../../dist/pipeline/index.js';

const EXTRACT = WRITING_STAGES[0]!;
const PDF = { relPath: 'L.pdf', kind: 'pdf', bytes: 4096, mimeType: 'application/pdf' };
const ORIGINAL = { relPath: 'notes.md', kind: 'text', bytes: 10, mimeType: 'text/markdown' };

function client(over: Partial<PipelineClient> & { extracted?: unknown[] } = {}): PipelineClient {
  return {
    readMethod: async (name) => ({ text: `<${name}>` }),
    listCourse: async () => ({ files: [PDF, ORIGINAL], extracted: over.extracted as never }),
    readCourse: async () => ({ text: '' }),
    newSession: async () => ({ session: { sessionId: 'x' } }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    isRpcError: () => false,
    ...over,
  };
}
const textOf = (b: ContentBlock[]) => (b[1] as { text: string }).text;
const uris = (b: ContentBlock[]) => b.map((x) => ('resource' in x ? x.resource.uri : 'uri' in x ? x.uri : x.type));

test('extract attaches SETUP.md as a method resource and says not to search for it', async () => {
  const b = await stageBlocks(client(), EXTRACT, '/c', 'Deck');
  assert.deepEqual(uris(b), ['ape://system', 'text', 'ape://method/SETUP.md', 'file:///c/L.pdf', 'file:///c/notes.md']);
  assert.match(textOf(b), /SETUP\.md from the method repository is attached below; do not search the file system for it\./);
  assert.equal((b[2] as { resource: { text: string } }).resource.text, '<SETUP.md>');
});

test('a companion the bridge cannot give is left out, and the stage still runs', async () => {
  const c = client({ readMethod: async (name) => { if (name === 'SETUP.md') throw new Error('no method file'); return { text: `<${name}>` }; } });
  const b = await stageBlocks(c, EXTRACT, '/c', 'Deck');
  assert.deepEqual(uris(b), ['ape://system', 'text', 'file:///c/L.pdf', 'file:///c/notes.md']);
  assert.doesNotMatch(textOf(b), /attached below/);
});

test('with nothing extracted the prompt reads as before: no paragraph, no extra link', async () => {
  for (const extracted of [undefined, []]) {
    const b = await stageBlocks(client({ extracted }), EXTRACT, '/c', 'Deck');
    assert.doesNotMatch(textOf(b), /extracted/i);
    assert.equal(b.length, 5);
  }
});

test('extracted text is described, tooling is waved off, and text.md is linked after the materials', async () => {
  const extracted = [{ source: 'L.pdf', text: '_extracted/L.pdf/text.md', images: ['_extracted/L.pdf/p001.png', '_extracted/L.pdf/p002.png', '_extracted/L.pdf/p003.png'] }];
  const b = await stageBlocks(client({ extracted }), EXTRACT, '/c', 'Deck');
  const t = textOf(b);
  assert.match(t, /Already extracted beside the material by this app, with no tools:/);
  assert.match(t, /- L\.pdf → _extracted\/L\.pdf\/text\.md \(the text of every page, under "## Page N" headings\); 3 page images, _extracted\/L\.pdf\/p001\.png … _extracted\/L\.pdf\/p003\.png/);
  assert.match(t, /do not look for pdftotext, pypdf or any other tooling/);
  assert.equal(uris(b).at(-1), 'file:///c/_extracted/L.pdf/text.md');
  assert.equal((b.at(-1) as { mimeType: string }).mimeType, 'text/markdown');
});

test('describeExtracted: one image, images only, text only, and an empty entry', () => {
  assert.match(describeExtracted([{ source: 'a.pdf', text: 'x/text.md', images: ['x/p001.png'] }]), /x\/text\.md \(.*\); one page image, x\/p001\.png/);
  assert.match(describeExtracted([{ source: 'a.pdf', text: null, images: ['x/p001.png', 'x/p002.png'] }]), /- a\.pdf → 2 page images, x\/p001\.png … x\/p002\.png$/m);
  assert.match(describeExtracted([{ source: 'a.pdf', text: 'x/text.md', images: [] }]), /- a\.pdf → x\/text\.md \(/);
  assert.equal(describeExtracted([{ source: 'a.pdf', text: null, images: [] }]), '');
});

test('a stage run carries the shell\'s note on where the deck stands, after the stage\'s own blocks', async () => {
  const sent: ContentBlock[][] = [];
  const c = client({ prompt: async (_id, blocks) => (sent.push(blocks), { stopReason: 'end_turn' }) });
  const conn = { connectionId: 'k', session: { sessionId: 'w' } };
  await makeRunner(c, conn as never, '/c', () => 'Deck', () => 'Steps: extract — running').run(EXTRACT);
  const last = sent[0]!.at(-1) as { type: string; text: string };
  assert.deepEqual(last, { type: 'text', text: 'Steps: extract — running' });
  sent.length = 0;
  await makeRunner(c, conn as never, '/c', () => 'Deck').run(EXTRACT);
  assert.ok(!sent[0]!.some((b) => 'text' in b && b.text.startsWith('Steps:')), 'no note when the shell gives none');
});

// A deck in a class: the class's brief with every writing step, and the exam
// date with the student's rate only where the deck is sized -- organize.
const ORGANIZE = WRITING_STAGES.find((w) => w.id === 'organize')!;
const TODAY = new Date(2026, 8, 27); // Sep 27, local
const HISTO: CourseClassLike = { folder: 'Year 1::Histology', path: '/classes/histo', brief: 'written', exam: { name: 'Midterm 2', date: '2026-10-14', covers: 'Lectures 5–8' } };

function inClass(cls: CourseClassLike | null, brief = '# Histology brief'): PipelineClient {
  return client({
    listCourse: async () => ({ files: [PDF], class: cls }),
    readCourse: async (path, name) => {
      if (path === '/classes/histo' && name === 'class.md') return { text: brief };
      throw new Error(`no ${name}`);
    },
  });
}

test('a deck in a class is given class.md, whole, after the method files, and told what it is', async () => {
  const b = await stageBlocks(inClass(HISTO), EXTRACT, '/c', 'Year 1::Histology::05 Cartilage', { today: TODAY, newPerDay: 20 });
  assert.deepEqual(uris(b), ['ape://system', 'text', 'ape://method/SETUP.md', 'file:///classes/histo/class.md', 'file:///c/L.pdf']);
  assert.equal((b[3] as { resource: { text: string } }).resource.text, '# Histology brief');
  assert.match(textOf(b), /This deck is in the class Year 1::Histology\. Its class brief, class\.md, is attached below/);
  assert.doesNotMatch(textOf(b), /Time:/, 'extract is not told the date: it records, it does not size');
});

test('organize is told the exam, the days left and the room at the student\'s rate', async () => {
  const b = await stageBlocks(inClass(HISTO), ORGANIZE, '/c', 'Deck', { today: TODAY, newPerDay: 20 });
  assert.match(textOf(b), /Time: this deck is studied for Midterm 2 on 2026-10-14, 17 days from today \(2026-09-27\)\. The student adds up to 20 new cards a day \(their own setting\), so about 340 new cards can be reviewed before it\. The syllabus says it covers: Lectures 5–8\./);
});

test('a class with no brief yet, or none at all, attaches nothing', async () => {
  const none = await stageBlocks(inClass({ ...HISTO, brief: 'none' }), ORGANIZE, '/c', 'Deck', { today: TODAY, newPerDay: 20 });
  assert.deepEqual(uris(none), ['ape://system', 'text', 'file:///c/L.pdf']);
  assert.match(textOf(none), /in the class Year 1::Histology, which has no class brief yet\./);
  const loose = await stageBlocks(inClass(null), ORGANIZE, '/c', 'Deck', { today: TODAY, newPerDay: 20 });
  assert.doesNotMatch(textOf(loose), /class|Time:/);
});

test('the time line: nothing without a date ahead; today; a rate not given', () => {
  assert.equal(timeLine(null, { today: TODAY }), '');
  assert.equal(timeLine({ name: 'Final', date: null }, { today: TODAY }), '');
  assert.equal(timeLine({ name: 'Quiz', date: '2026-09-20' }, { today: TODAY }), '', 'an exam already past');
  assert.match(timeLine({ name: 'Quiz', date: '2026-09-27' }, { today: TODAY, newPerDay: 20 }), /on 2026-09-27, today\. .* about 0 new cards/);
  assert.match(timeLine({ name: 'Quiz', date: '2026-09-28' }, { today: TODAY }), /1 day from today .* has not said how many new cards a day/);
});

test('the class brief step runs in the class folder: its papers, no brief of its own attached', async () => {
  const own: CourseClassLike = { ...HISTO, path: '/classes/histo', exam: null };
  const b = await stageBlocks(inClass(own), CLASS_STAGE, '/classes/histo', 'Year 1::Histology', { today: TODAY, newPerDay: 20 });
  assert.deepEqual(uris(b), ['ape://system', 'text', 'file:///classes/histo/L.pdf']);
  assert.equal((b[0] as { resource: { text: string } }).resource.text, '<0-class.md>');
  const t = textOf(b);
  assert.match(t, /^Run this step on the class folder below and write class\.md beside its files\. Also write exams\.json/);
  assert.match(t, /\n\nClass: Year 1::Histology\nClass folder: \/classes\/histo\n\nFiles:\n- L\.pdf/);
  assert.doesNotMatch(t, /This deck is in the class|Time:/);
});

test('a runner hands its stages the options the shell reads at each run', async () => {
  const sent: ContentBlock[][] = [];
  const c = inClass(HISTO);
  c.prompt = async (_id, blocks) => (sent.push(blocks), { stopReason: 'end_turn' });
  c.isRpcError = () => true; // plan.md not written, as the sidecar would say
  const conn = { connectionId: 'k', session: { sessionId: 'w' } };
  let rate = 10;
  const runner = makeRunner(c, conn as never, '/c', () => 'Deck', undefined, () => ({ newPerDay: rate, today: TODAY }));
  await runner.run(ORGANIZE);
  rate = 30;
  await runner.run(ORGANIZE);
  assert.match(textOf(sent[0]!), /about 170 new cards/);
  assert.match(textOf(sent[1]!), /about 510 new cards/);
});

test('papers added after the brief are folded into it, named, rather than the brief written over', async () => {
  const own: CourseClassLike = { ...HISTO, exam: null };
  const b = await stageBlocks(inClass(own), classUpdateStage(['study guide.pdf', 'notes.txt']), '/classes/histo', 'Year 1::Histology', { today: TODAY });
  assert.equal((b[0] as { resource: { text: string } }).resource.text, '<0-class.md>', 'the same method');
  const t = textOf(b);
  assert.match(t, /^class\.md is already written beside the class's papers.*These papers were added since:\n- study guide\.pdf\n- notes\.txt\nRead each of them end to end and fold what they add into class\.md/s);
  assert.match(t, /Then write exams\.json again/);
  assert.match(t, /\n\nClass: Year 1::Histology\nClass folder: \/classes\/histo/);
});
