// anki/status and anki/send: the deck goes straight into a running Anki
// through AnkiConnect (src/sidecar/anki.ts), against the fake in
// fake-anki.ts. What is checked is the order and content of the actions --
// note type created only when missing, deck created before notes, every
// referenced image stored under the field's own name from the deck's media
// list, notes added with duplicates refused -- and that Anki being closed is
// reported in words, with the JSON-RPC code the app already handles.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test, { after } from 'node:test';

import { tidyError } from '../../dist/sidecar/anki.js';
import { startFakeAnki, type FakeAnki } from './fake-anki.ts';
import { TIMEOUT, makeTmpDir, spawnSidecar, sweepSidecars } from './helpers.ts';

after(sweepSidecars);

const NOT_OPEN = /Anki is not open, or the AnkiConnect add-on/;

function writeDeck(dir: string): { deckPath: string; page: string } {
  const extracted = join(dir, '_extracted', 'Lecture 9.pdf');
  mkdirSync(extracted, { recursive: true });
  const page = join(extracted, 'p003.jpg');
  writeFileSync(page, readFileSync(join(import.meta.dirname, '..', 'apkg', 'fixtures', 'slide.jpg')));
  const deckPath = join(dir, 'deck.json');
  const note = (text: string) => ({
    deckName: 'ISF::Biochemistry::Gene Expression',
    modelName: 'Custom Cloze',
    fields: { Text: text, Extra: '<img src="isf-biochem-09-slide-03.jpg"><br>Source: "…" &mdash; Slide 3', Source: 'Slide 3' },
    tags: ['isf::biochemistry', 'slide::biochem-09-03'],
  });
  writeFileSync(
    deckPath,
    JSON.stringify({
      deckName: 'ISF::Biochemistry::Gene Expression',
      modelName: 'Custom Cloze',
      media: [{ filename: 'isf-biochem-09-slide-03.jpg', path: '_extracted/Lecture 9.pdf/p003.jpg' }],
      notes: [
        note('{{c1::<b>E. coli</b>::which bacterium?}} has {{c2::<i>one circular chromosome</i>::what chromosome?}}'),
        note('{{c1::<b>Prokaryotic</b>::which?}} <b>gene transcripts</b> {{c2::<i>do not</i>::do or do not?}} contain introns'),
      ],
    }),
  );
  return { deckPath, page };
}

test('anki/status: reachable with the version when the endpoint answers; not, in words, when nothing listens', { timeout: TIMEOUT }, async () => {
  const fake: FakeAnki = await startFakeAnki();
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;
  const up = (await s.request(1, 'anki/status', {})).result as { reachable: boolean; version: number; url: string };
  assert.equal(up.reachable, true);
  assert.equal(up.version, 6);
  assert.equal(up.url, fake.url);
  await fake.close();
  const down = (await s.request(2, 'anki/status', {})).result as { reachable: boolean; error: string };
  assert.equal(down.reachable, false);
  assert.match(down.error, NOT_OPEN);
  assert.equal(await s.end(), 0);
});

test('anki/send: creates the note type only when missing, the deck before the notes, stores every image under the field\'s name, adds the notes', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeAnki();
  const { deckPath, page } = writeDeck(makeTmpDir('ape-sidecar-anki-'));
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;

  const res = await s.request(1, 'anki/send', { path: deckPath });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const r = res.result as { decks: string[]; total: number; added: number; skipped: number; media: number; unresolvedMedia: string[]; createdModel: boolean };
  assert.deepEqual(r, { decks: ['ISF::Biochemistry::Gene Expression'], total: 2, added: 2, skipped: 0, media: 1, unresolvedMedia: [], createdModel: true });

  const actions = fake.calls.map((c) => c.action);
  assert.deepEqual(actions, ['version', 'modelNames', 'createModel', 'createDeck', 'storeMediaFile', 'canAddNotes', 'addNotes'], 'the order AnkiConnect needs: type, deck, media, notes');
  const created = fake.calls.find((c) => c.action === 'createModel')!.params;
  assert.equal(created.modelName, 'Custom Cloze');
  assert.deepEqual(created.inOrderFields, ['Text', 'Extra', 'Source']);
  assert.equal(created.isCloze, true);
  assert.deepEqual(fake.media, [{ filename: 'isf-biochem-09-slide-03.jpg', path: page }], 'the referenced name, the file from the deck\'s list');
  assert.equal(fake.notes.length, 2);
  assert.deepEqual((fake.notes[0].options as Record<string, unknown>), { allowDuplicate: false, duplicateScope: 'deck' });

  // A second send: the type exists now, and both notes are duplicates.
  for (const n of fake.notes) fake.duplicates.add((n.fields as Record<string, string>).Text);
  const again = (await s.request(2, 'anki/send', { path: deckPath })).result as { added: number; skipped: number; createdModel: boolean };
  assert.deepEqual([again.added, again.skipped, again.createdModel], [0, 2, false]);
  const second = fake.calls.slice(7).map((c) => c.action);
  assert.ok(!second.includes('createModel'), 'no second createModel');
  assert.ok(!second.includes('addNotes'), 'nothing new, so nothing added');

  await fake.close();
  assert.equal(await s.end(), 0);
});

test('anki/send: a deck sent again to an AnkiConnect that fails a batch on any duplicate adds the new notes and counts the rest, without an error', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeAnki({ strict: true });
  const { deckPath } = writeDeck(makeTmpDir('ape-sidecar-anki-'));
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;

  assert.equal((await s.request(1, 'anki/send', { path: deckPath })).error, undefined);
  // One already in Anki, one not: the first note stays as a duplicate, the second is gone.
  const [kept] = fake.notes.splice(0);
  fake.duplicates.add((kept!.fields as Record<string, string>).Text);
  const res = await s.request(2, 'anki/send', { path: deckPath });
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  const r = res.result as { added: number; skipped: number; total: number };
  assert.deepEqual([r.added, r.skipped, r.total], [1, 1, 2]);
  const sent = fake.calls.filter((c) => c.action === 'addNotes').at(-1)!.params.notes as unknown[];
  assert.equal(sent.length, 1, 'only the note Anki can take is sent');

  await fake.close();
  assert.equal(await s.end(), 0);
});

test('tidyError: an AnkiConnect error list is said once per message, with a count', () => {
  const dup = 'cannot create note because it is a duplicate';
  assert.equal(tidyError(`['${dup}', '${dup}', '${dup}', "deck's gone"]`), `${dup} (3 notes); deck's gone`);
  assert.equal(tidyError(`['${dup}']`), dup);
  assert.equal(tidyError('collection is not available'), 'collection is not available');
});

test('anki/send: deckName overrides every note\'s own; Anki closed is -32000 in words; a missing path is -32602', { timeout: TIMEOUT }, async () => {
  const fake = await startFakeAnki();
  const { deckPath } = writeDeck(makeTmpDir('ape-sidecar-anki-'));
  const s = spawnSidecar({ env: { APE_ANKI_CONNECT: fake.url } });
  await s.ready;

  const r = (await s.request(1, 'anki/send', { path: deckPath, deckName: 'Testy test' })).result as { decks: string[] };
  assert.deepEqual(r.decks, ['Testy test']);
  assert.ok(fake.decks.includes('Testy test'));
  assert.ok(fake.notes.every((n) => n.deckName === 'Testy test'));

  const bad = await s.request(2, 'anki/send', {});
  assert.equal(bad.error?.code, -32602);

  await fake.close();
  const closed = await s.request(3, 'anki/send', { path: deckPath });
  assert.equal(closed.error?.code, -32000);
  assert.match(closed.error?.message ?? '', NOT_OPEN);
  assert.equal(await s.end(), 0);
});
