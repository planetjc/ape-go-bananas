// Anki itself, through AnkiConnect: the add-on serves a plain JSON endpoint
// on localhost while Anki is open, and the method's own insertion route is
// that endpoint (method/3-cards.md, "Getting the notes in"). This is the
// app's "Send to Anki": the same deck.json the exporter packs, put straight
// into the running collection -- the note type created if the collection
// lacks it, the deck created, every image stored under the name the field
// uses (from the deck's own media list, apkg-format.md §3), then the notes
// added. No agent, no MCP server: the sidecar is a program and can POST.
//
// Anki closed, or the add-on not installed, is the ordinary failure and is
// reported as such, in words the person can act on.

import { dirname } from 'node:path';
import { extractMediaFilenames } from '../apkg/text.js';
import { resolveMediaFile } from '../apkg/media-node.js';
import { CUSTOM_CLOZE_AFMT, CUSTOM_CLOZE_CSS, CUSTOM_CLOZE_FIELD_NAMES, CUSTOM_CLOZE_MODEL_NAME, CUSTOM_CLOZE_QFMT, CUSTOM_CLOZE_TEMPLATE_NAME } from '../apkg/notetype-source.js';
import { loadDeckMedia, loadDeckNotes } from '../cli/deck-loader.js';
import { resolveMediaDir } from '../cli/media-dir.js';
import type { DeckNote } from '../types.js';
import { InvalidParams, type MethodHandler } from './methods.js';

/** AnkiConnect's default; APE_ANKI_CONNECT overrides it (tests point it at a fake). */
export const ANKI_CONNECT_URL = process.env.APE_ANKI_CONNECT ?? 'http://127.0.0.1:8765';
const ADDON_CODE = '2055492159';
// The app takes this line down once Anki answers, by its start (app/src/agent/app.ts, "Anki, watched").
export const NOT_OPEN = `Anki is not open, or the AnkiConnect add-on (code ${ADDON_CODE}) is not installed. Open Anki and try again.`;

export interface AnkiStatus {
  url: string;
  reachable: boolean;
  version: number | null;
  error: string | null;
}

export interface SendResult {
  /** The deck name(s) the notes went into. */
  decks: string[];
  total: number;
  added: number;
  /** Notes AnkiConnect refused -- duplicates, almost always. */
  skipped: number;
  /** Images stored into the collection's media folder. */
  media: number;
  /** Referenced image names with no file to store. */
  unresolvedMedia: string[];
  /** Whether the Custom Cloze note type had to be created. */
  createdModel: boolean;
}

class AnkiUnreachable extends Error {
  constructor(public readonly cause_: string) {
    super(NOT_OPEN);
    this.name = 'AnkiUnreachable';
  }
}

async function invoke<T>(url: string, action: string, params?: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, version: 6, params: params ?? {} }) });
  } catch (err) {
    throw new AnkiUnreachable(String((err as Error)?.cause ?? err));
  }
  if (!res.ok) throw new Error(`AnkiConnect answered ${res.status} to ${action}`);
  const body = (await res.json()) as { result?: T; error?: string | null };
  if (body.error) throw new Error(`AnkiConnect: ${tidyError(body.error)}`);
  return body.result as T;
}

/**
 * AnkiConnect's errors for a batch are a Python list printed as a string,
 * one entry per note -- "['cannot create note because it is a duplicate',
 * …]" a hundred times over. Said once each, with how many.
 */
export function tidyError(error: string): string {
  const list = error.trim();
  if (!list.startsWith('[') || !list.endsWith(']')) return error;
  const items = [...list.matchAll(/(['"])(.*?)\1/gs)].map((m) => m[2]!);
  if (!items.length) return error;
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts].map(([text, n]) => (n > 1 ? `${text} (${n} notes)` : text)).join('; ');
}

export async function ankiStatus(url = ANKI_CONNECT_URL): Promise<AnkiStatus> {
  try {
    const version = await invoke<number>(url, 'version');
    return { url, reachable: true, version, error: null };
  } catch (err) {
    return { url, reachable: false, version: null, error: err instanceof AnkiUnreachable ? NOT_OPEN : String((err as Error).message ?? err) };
  }
}

/** Puts `<path>`'s notes, media and note type into the running Anki. `deckName` overrides every note's own. */
export async function sendDeck(path: string, deckName?: string, url = ANKI_CONNECT_URL): Promise<SendResult> {
  const notes = loadDeckNotes(path);
  if (notes.length === 0) throw new Error(`${path} contains no notes`);
  const media = loadDeckMedia(path);
  const status = await ankiStatus(url);
  if (!status.reachable) throw new Error(status.error ?? NOT_OPEN);

  // The note type, once: the same one the exporter writes into an .apkg.
  const models = await invoke<string[]>(url, 'modelNames');
  const createdModel = !models.includes(CUSTOM_CLOZE_MODEL_NAME);
  if (createdModel) {
    await invoke(url, 'createModel', {
      modelName: CUSTOM_CLOZE_MODEL_NAME,
      inOrderFields: [...CUSTOM_CLOZE_FIELD_NAMES],
      css: CUSTOM_CLOZE_CSS,
      isCloze: true,
      cardTemplates: [{ Name: CUSTOM_CLOZE_TEMPLATE_NAME, Front: CUSTOM_CLOZE_QFMT, Back: CUSTOM_CLOZE_AFMT }],
    });
  }

  // The decks: createDeck is idempotent, and addNotes fails the whole batch
  // on a deck it does not know (method/3-cards.md).
  const placed: DeckNote[] = notes.map((n) => (deckName ? { ...n, deckName } : n));
  const decks = [...new Set(placed.map((n) => n.deckName))];
  for (const deck of decks) await invoke(url, 'createDeck', { deck });

  // Every image a field references, from wherever the deck's list says it is.
  const dirs = [resolveMediaDir(), dirname(path)];
  const referenced = [...new Set(placed.flatMap((n) => [...extractMediaFilenames(n.fields.Text), ...extractMediaFilenames(n.fields.Extra ?? '')]))];
  const unresolvedMedia: string[] = [];
  let stored = 0;
  for (const filename of referenced) {
    const file = resolveMediaFile(filename, media, dirs);
    if (file === undefined) {
      unresolvedMedia.push(filename);
      continue;
    }
    await invoke(url, 'storeMediaFile', { filename, path: file });
    stored += 1;
  }

  // Only the notes Anki will take. Older AnkiConnect answered a duplicate
  // with a null id; newer versions fail the whole addNotes call with one
  // error per refused note, so a deck sent twice came back as a wall of
  // "cannot create note because it is a duplicate". canAddNotes is in both.
  const asked = placed.map((n) => ({ deckName: n.deckName, modelName: n.modelName, fields: n.fields, tags: n.tags ?? [], options: { allowDuplicate: false, duplicateScope: 'deck' } }));
  const can = await invoke<boolean[]>(url, 'canAddNotes', { notes: asked });
  const fresh = asked.filter((_, i) => can[i] !== false);
  const ids = fresh.length ? await invoke<(number | null)[]>(url, 'addNotes', { notes: fresh }) : [];
  const added = ids.filter((id) => id !== null).length;
  return { decks, total: placed.length, added, skipped: placed.length - added, media: stored, unresolvedMedia, createdModel };
}

export function ankiMethods(): Record<string, MethodHandler> {
  const str = (params: unknown, key: string, required: boolean): string | undefined => {
    const p = (params ?? {}) as Record<string, unknown>;
    const v = p[key];
    if (v === undefined) {
      if (required) throw new InvalidParams(`${key} is required`);
      return undefined;
    }
    if (typeof v !== 'string' || v === '') throw new InvalidParams(`${key} must be a non-empty string`);
    return v;
  };
  return {
    'anki/status': () => ankiStatus(),
    'anki/send': (params) => sendDeck(str(params, 'path', true)!, str(params, 'deckName', false)),
  };
}
