// A local stand-in for AnkiConnect (the add-on's JSON endpoint on
// localhost:8765): every request is `{action, version, params}` and every
// answer `{result, error}`. The test points the sidecar here through env
// APE_ANKI_CONNECT and reads back every action from `calls`. It holds a
// tiny collection -- model names, deck names, stored media, added notes --
// so a send can be checked for what it created and in what order.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeCall {
  action: string;
  params: Record<string, unknown>;
}

export interface FakeAnki {
  url: string;
  calls: FakeCall[];
  models: string[];
  decks: string[];
  media: { filename: string; path: string }[];
  notes: Record<string, unknown>[];
  /** Field Text values that addNotes should refuse as duplicates. */
  duplicates: Set<string>;
  close(): Promise<void>;
}

/**
 * `strict` is AnkiConnect as it is now: addNotes fails the whole call when
 * any note is refused, its error a Python list of one message per note.
 * Without it, the older answer: a null id for each refused note.
 */
export async function startFakeAnki(opts: { models?: string[]; decks?: string[]; strict?: boolean } = {}): Promise<FakeAnki> {
  const state: Omit<FakeAnki, 'url' | 'close'> = { calls: [], models: opts.models ?? ['Basic', 'Cloze'], decks: opts.decks ?? ['Default'], media: [], notes: [], duplicates: new Set() };
  const refusal = (n: Record<string, unknown>): string | null => {
    if (!state.decks.includes(n.deckName as string)) return 'deck was not found';
    if (state.duplicates.has((n.fields as Record<string, string>).Text)) return 'cannot create note because it is a duplicate';
    return null;
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const { action, params = {} } = JSON.parse(body) as { action: string; params?: Record<string, unknown> };
      state.calls.push({ action, params });
      const reply = (result: unknown, error: string | null = null) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ result, error }));
      };
      switch (action) {
        case 'version':
          return reply(6);
        case 'modelNames':
          return reply(state.models);
        case 'createModel':
          state.models.push(params.modelName as string);
          return reply({ id: 1 });
        case 'deckNames':
          return reply(state.decks);
        case 'createDeck':
          if (!state.decks.includes(params.deck as string)) state.decks.push(params.deck as string);
          return reply(1);
        case 'storeMediaFile':
          state.media.push({ filename: params.filename as string, path: params.path as string });
          return reply(params.filename);
        case 'canAddNotes':
          return reply((params.notes as Record<string, unknown>[]).map((n) => refusal(n) === null));
        case 'addNotes': {
          const notes = params.notes as Record<string, unknown>[];
          const refused = notes.map(refusal).filter((r) => r !== null);
          if (opts.strict && refused.length) return reply(null, `[${refused.map((r) => `'${r}'`).join(', ')}]`);
          const ids = notes.map((n, i) => {
            if (refusal(n) !== null) return null;
            state.notes.push(n);
            return 1000 + i;
          });
          return reply(ids);
        }
        default:
          return reply(null, `unsupported action: ${action}`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    ...state,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
