// The shell's typed door to the sidecar, over whichever host is running it.
// One function per protocol method (docs/research/sidecar-protocol.md,
// agent-protocol.md); the shapes below are the protocol's. How a call
// travels is the host's business (host.ts): Tauri's invoke in the desktop
// app, loopback HTTP from the tool page.
//
// Not here: where an API key is kept. The desktop app has the OS keychain
// through Rust; the tool page has only the tab. The picker takes a store
// (agent/picker.ts, KeyStore) and hands the key to agent/connect either way.

import { EngineError, type EngineHost, type ReverseRequest } from './host.js';
import type { PipelineClient } from '../../../dist/pipeline/index.js';

export { EngineError, type EngineHost, type EngineInfo, type ReverseRequest } from './host.js';

export interface DeckNote {
  deckName: string;
  modelName: string;
  fields: { Text: string; Extra: string; Source: string };
  tags: string[];
}

export interface Finding {
  message: string;
  noteIndex?: number;
}

export interface CheckResult {
  result: { findings: Finding[]; notesCount: number };
  report: string;
  clean: boolean;
  count: number;
  mediaNote: string | null;
}

export interface Flag {
  noteIndex: number;
  note: string;
  at: string;
}

export interface SidecarStatus {
  running: boolean;
  node: string | null;
  script: string | null;
  error: string | null;
  initial_deck: string | null;
  data_dir: string | null;
}

// ---- agent-protocol.md shapes ---------------------------------------------

export interface Provider {
  id: string;
  kind: 'acp' | 'api';
  name: string;
  description: string;
  version: string | null;
  installed: boolean;
  installedVersion: string | null;
  distribution: 'npx' | 'binary' | 'uvx' | null;
  installable: boolean;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string | null;
  type?: 'terminal';
}

export interface SelectOption {
  id: string;
  type: 'select';
  name: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

export interface ConfigOption {
  id: string;
  type: 'select' | 'boolean';
  name: string;
  /** ACP's grouping, when the agent gives one: "mode", "model", "thought_level"… */
  category?: string;
  currentValue: string | boolean;
  options?: { value: string; name: string }[];
}

export interface ModeState {
  currentModeId: string;
  availableModes: { id: string; name: string; description?: string }[];
}

export interface SessionInfo {
  sessionId: string;
  modes: ModeState | null;
  configOptions: ConfigOption[] | null;
  commands: { name: string; description?: string }[];
}

export interface ConnectResult {
  connectionId: string;
  provider: string;
  kind: 'acp' | 'api';
  agent: { name: string; version: string } | null;
  authStatus: { kind: string; label: string } | null;
  authMethods: AuthMethod[];
  session: SessionInfo | null;
  authRequired: boolean;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string }
  | { type: 'resource'; resource: { uri: string; text: string; mimeType?: string } };

export type SessionUpdate = { sessionUpdate: string } & Record<string, unknown>;

export interface CourseFile {
  name: string;
  relPath: string;
  bytes: number;
  kind: 'pdf' | 'image' | 'audio' | 'video' | 'text' | 'slides' | 'doc' | 'other';
  mimeType: string;
}

/** What the page extracted from one source file, beside it (course/list's `extracted`). */
export interface Extracted {
  source: string;
  text: string | null;
  images: string[];
}

/** One deck workspace as decks/list reports it. */
export interface DeckSummary {
  /** What it is called in Anki: where its cards go once written, else the name it was given. `::` makes folders. */
  name: string;
  /** Its folder under the decks root: an id, fixed at creation, never shown. */
  folder: string;
  path: string;
  files: number;
  pdfs: number;
  /** What the person brought, by CourseFile kind; what the steps made in subfolders is not counted. Absent from an older engine. */
  kinds?: Partial<Record<CourseFile['kind'], number>>;
  artifacts: { inventory: boolean; plan: boolean; deck: boolean; flags: boolean; review: boolean };
  modified: string;
}

export interface Exam {
  id: string;
  name: string;
  /** YYYY-MM-DD, or null when none is known. */
  date: string | null;
  covers?: string;
  /** Made or changed by the person: a later paper never moves it. */
  setBy?: 'person';
}

/** A folder whose decks share a syllabus: its own files, the brief written from them, its exams. */
export interface ClassSummary {
  /** The folder it is, as Anki's `::` path. */
  folder: string;
  /** Its own course folder, where the syllabus and class.md are. */
  path: string;
  /** Soonest first; an exam with no date last. */
  exams: Exam[];
  /** class.md: not written, written and not yet read, or read and said to be right (that version of it). */
  brief: 'none' | 'written' | 'reviewed';
  files: number;
  /** Papers added since class.md was written, which it does not know yet. Absent from an engine before this was kept. */
  newPapers?: string[];
}

/** A folder whose classes share a term: "Fall 2026". Its dates say which one is now. */
export interface Semester {
  folder: string;
  /** YYYY-MM-DD, or null when not set. */
  start: string | null;
  end: string | null;
}

/** The class a course folder is in, as course/list gives it; for a class's own folder, itself. */
export interface CourseClass extends ClassSummary {
  /** The exam the deck is studied for; null for none, and for the class's own folder. */
  exam: Exam | null;
  /** An exam's id, "none", or "next" (whichever is next on the calendar). */
  choice: string;
}

export interface PermissionRequest {
  id: number;
  method: 'agent/requestPermission';
  params: {
    sessionId: string;
    toolCall: { toolCallId?: string; title?: string; kind?: string; locations?: { path: string }[] } & Record<string, unknown>;
    options: { optionId: string; name: string; kind: string }[];
  };
}


export interface AnkiStatus {
  url: string;
  reachable: boolean;
  version: number | null;
  error: string | null;
}

export interface SendToAnkiResult {
  decks: string[];
  total: number;
  added: number;
  skipped: number;
  media: number;
  unresolvedMedia: string[];
  createdModel: boolean;
}

export type SidecarClient = ReturnType<typeof makeSidecarClient>;

/** Every method of the sidecar, bound to one host. Satisfies PipelineClient. */
export function makeSidecarClient(host: EngineHost) {
  const call = <T>(method: string, params?: unknown) => host.call<T>(method, params);
  const client = {
    ping: () => call<{ engine: string; version: string; node: string }>('sidecar/ping'),
    mediaDir: () => call<{ mediaDir: string; exists: boolean }>('media/dir'),
    load: (path: string) => call<{ notes: DeckNote[]; count: number }>('deck/load', { path }),
    check: (path: string, opts: { checkMedia?: boolean; mediaDir?: string } = {}) =>
      call<CheckResult>('deck/check', { path, ...opts }),
    review: (path: string, opts: { mediaDir?: string; outPath?: string } = {}) =>
      call<{ html: string; count: number; outPath: string | null }>('deck/review', { path, ...opts }),
    export: (path: string, opts: { outPath?: string; deckName?: string; mediaDir?: string } = {}) =>
      call<{ outPath: string; count: number; unresolvedMedia: string[] }>('deck/export', { path, ...opts }),
    /** Whether Anki is open with AnkiConnect answering. */
    ankiStatus: () => call<AnkiStatus>('anki/status'),
    /** Puts the deck straight into the running Anki: note type, deck, media, notes. */
    sendToAnki: (path: string, deckName?: string) => call<SendToAnkiResult>('anki/send', deckName ? { path, deckName } : { path }),
    readFlags: (path: string) => call<{ flags: Flag[]; flagsPath: string }>('flags/read', { path }),
    writeFlags: (path: string, flags: Flag[]) => call<{ flagsPath: string; count: number }>('flags/write', { path, flags }),

    /**
     * Notifications the sidecar sends on its own: `agents/progress`,
     * `agent/update`, `agent/loginOutput`, `agent/authStatus`. ONE handler:
     * a second call replaces the first. UI code goes through agent/bus.ts,
     * which owns this slot and fans out.
     */
    onNotification: (handler: (method: string, params: unknown) => void) => host.onNotification(handler),
    /** Requests the sidecar makes of the shell (agent-protocol.md §3). One handler, same rule; see agent/bus.ts. */
    onRequest: (handler: (request: ReverseRequest) => void) => host.onRequest(handler),
    answer: (id: number, result: unknown) => host.answer(id, result),
    refuse: (id: number, message: string) => host.refuse(id, message),

    // agents/* and agent/*
    listProviders: (dataDir: string, refresh = false) =>
      call<{ providers: Provider[]; registry: { fetchedAt: string | null; url: string; error: string | null } }>('agents/list', { dataDir, refresh }),
    installProvider: (dataDir: string, id: string) => call<{ id: string; package: string; version: string; bin: string }>('agents/install', { dataDir, id }),
    uninstallProvider: (dataDir: string, id: string) => call<{ id: string; removed: boolean }>('agents/uninstall', { dataDir, id }),
    connect: (params: { provider: string; dataDir: string; cwd: string; apiKey?: string }) => call<ConnectResult>('agent/connect', params),
    login: (connectionId: string, methodId: string) =>
      call<{ methodId: string; exitCode: number | null; authenticated: boolean } & Partial<ConnectResult>>('agent/login', { connectionId, methodId }),
    newSession: (connectionId: string) => call<{ session: SessionInfo }>('agent/newSession', { connectionId }),
    listMethod: () => call<{ dir: string; files: { name: string; title: string; bytes: number }[] }>('method/list'),
    readMethod: (name: string) => call<{ name: string; text: string }>('method/read', { name }),
    listCourse: (path: string) =>
      call<{ path: string; name: string | null; files: CourseFile[]; artifacts: { inventory: boolean; plan: boolean; deck: boolean; flags: boolean; review: boolean }; extracted: Extracted[]; class?: CourseClass | null }>('course/list', { path }),
    readCourse: (path: string, name: string) => call<{ name: string; text: string; bytes: number }>('course/read', { path, name }),
    /** Copies files (or a folder's files, one level) into the course folder by name: the desktop shell's drop and picker. */
    importCourse: (path: string, files: string[]) => call<{ imported: string[] }>('course/import', { path, files }),
    /** Removes one file beneath the course folder, and what was extracted from it; with `trash`, into the folder's trash for restoreCourse. */
    deleteCourse: (path: string, name: string, opts: { trash?: boolean } = {}) =>
      call<{ name: string; removed: boolean; trashed?: string | null }>('course/delete', { path, name, ...opts }),
    /** Puts a material removed with `trash` back; its name, numbered if the old one was taken since. */
    restoreCourse: (path: string, trashed: string) => call<{ name: string }>('course/restore', { path, trashed }),
    /** The shell's workspaces: one course folder per deck under `root`, newest first. */
    listDecks: (root: string) => call<{ root: string; decks: DeckSummary[]; folders?: string[]; classes?: ClassSummary[]; semesters?: Semester[] }>('decks/list', { root }),
    /** Folders are Anki's `::` paths, kept under `root` so one can exist empty; its parents are made with it. */
    createFolder: (root: string, name: string) => call<{ name: string; folders: string[] }>('folders/create', { root, name }),
    /** The folder record only; the decks in it are renamed one by one with renameDeck. */
    renameFolder: (root: string, from: string, to: string) => call<{ name: string; folders: string[] }>('folders/rename', { root, from, to }),
    /** An empty folder and its empty subfolders; refused while a deck is beneath. */
    deleteFolder: (root: string, name: string) => call<{ name: string; removed: string[]; folders: string[]; classes?: string[]; semesters?: Semester[] }>('folders/delete', { root, name }),
    /** Makes a folder a semester (the folder too, if it is new); never inside a class or another semester. */
    createSemester: (root: string, folder: string, start: string | null, end: string | null) => call<{ semester: Semester; semesters: Semester[] }>('semesters/create', { root, folder, start, end }),
    updateSemester: (root: string, folder: string, start: string | null, end: string | null) => call<{ semester: Semester; semesters: Semester[] }>('semesters/update', { root, folder, start, end }),
    /** Back to a plain folder; its classes and decks stay. */
    removeSemester: (root: string, folder: string) => call<{ removed: Semester; semesters: Semester[] }>('semesters/remove', { root, folder }),
    /** Makes a folder a class (the folder too, if it is new); refused inside another class or around one. */
    createClass: (root: string, folder: string) => call<ClassSummary>('classes/create', { root, folder }),
    /** The class's exams, whole; one without an id is given one. */
    updateClass: (root: string, path: string, exams: (Omit<Exam, 'id'> & { id?: string })[], by: 'person' | 'papers' = 'person') => call<ClassSummary>('classes/update', { root, path, exams, by }),
    /** class.md was just written, from the papers there now; one added later is named in newPapers until it is updated. */
    briefedClass: (root: string, path: string) => call<ClassSummary>('classes/briefed', { root, path }),
    /** The person has read class.md, as it is now, and says it is right. */
    reviewClass: (root: string, path: string) => call<ClassSummary>('classes/review', { root, path }),
    /** Back to a plain folder; the class's files go to the trash, for restoreClass. */
    removeClass: (root: string, path: string) => call<{ trashed: string }>('classes/remove', { root, path }),
    restoreClass: (root: string, trashed: string) => call<ClassSummary>('classes/restore', { root, trashed }),
    /** Which exam a deck in a class is studied for: an exam's id, "none", or "next". */
    setDeckExam: (root: string, path: string, exam: string) => call<{ path: string; class: CourseClass | null }>('decks/exam', { root, path, exam }),
    createDeck: (root: string, name: string) => call<{ name: string; folder: string; path: string }>('decks/create', { root, name }),
    /** Renames (so moves, in Anki's `::` tree) a deck under `root`; cards already written follow it. */
    renameDeck: (root: string, path: string, name: string) => call<{ name: string; path: string; moved: number }>('decks/rename', { root, path, name }),
    /** Moves a deck under `root` to its trash, kept 30 days; `trashed` is what decks/restore takes. */
    deleteDeck: (root: string, path: string) => call<{ trashed: string }>('decks/delete', { root, path }),
    restoreDeck: (root: string, trashed: string) => call<{ name: string; folder: string; path: string }>('decks/restore', { root, trashed }),
    /** One file beneath the course folder, text or bytes; directories are made. Confined to the folder like course/read. */
    writeCourse: (path: string, name: string, body: { text: string } | { base64: string }) => call<{ name: string; bytes: number }>('course/write', { path, name, ...body }),
    /** `steered`: the message went into a turn already running, and this is that turn's end. */
    prompt: (sessionId: string, blocks: ContentBlock[]) => call<{ stopReason: string; steered?: boolean }>('agent/prompt', { sessionId, blocks }),
    cancel: (sessionId: string) => call<Record<string, never>>('agent/cancel', { sessionId }),
    setMode: (sessionId: string, modeId: string) => call<{ modes: ModeState }>('agent/setMode', { sessionId, modeId }),
    setConfigOption: (sessionId: string, id: string, value: string | boolean) =>
      call<{ configOptions: ConfigOption[] }>('agent/setConfigOption', { sessionId, id, value }),
    disconnect: (connectionId: string) => call<Record<string, never>>('agent/disconnect', { connectionId }),

    /** PipelineClient: a sidecar-reported failure, as opposed to a bug. */
    isRpcError: (err: unknown): boolean => err instanceof EngineError,
  } satisfies PipelineClient & Record<string, unknown>;
  return client;
}
