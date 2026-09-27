// The agent half of the sidecar -- docs/research/agent-protocol.md §1-§4.
// Two kinds of provider behind one method surface: ACP agents through
// src/acp, API providers through src/agent. After `agent/connect` the app
// cannot tell which it got, and nothing here decides what a card says --
// the system prompt arrives from the app as an `ape://system` block.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connect, type AcpClient, type AcpSession } from '../acp/index.js';
import type {
  AuthMethod,
  AvailableCommand,
  ContentBlock,
  RequestPermissionOutcome,
  RequestPermissionParams,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
} from '../acp/protocol.js';
import {
  DEFAULT_BASE_URL,
  OpenRouterError,
  createEmbeddedSession,
  defaultModelId,
  listModels,
  modelOptionName,
  usableModels,
  validateKey,
  type EmbeddedMode,
  type EmbeddedSession,
  type Effort,
} from '../agent/index.js';
import {
  BUILT_IN_PROVIDERS,
  binaryLaunch,
  binaryTarget,
  installAgent,
  isBuiltIn,
  launchFor,
  loadRegistry,
  platformKey,
  resolveBin,
  toProvider,
  isAgentId,
  uninstallAgent,
  type RegistryEntry,
} from '../agents/index.js';
import { InvalidParams, type MethodHandler } from './methods.js';

/** What index.ts gives this module: a way to notify the app and to ask it. */
export interface AppLink {
  notify(method: string, params: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
}

interface AuthStatus {
  kind: string;
  label: string;
}

interface AcpConnection {
  kind: 'acp';
  connectionId: string;
  provider: string;
  entry: RegistryEntry;
  launch: { command: string; args: string[]; env: Record<string, string>; cwd: string };
  client: AcpClient;
  authStatus: AuthStatus | null;
  sessions: Map<string, AcpSessionState>;
  /** The agent's own session id -> the id we minted for the app (§2: ids are the sidecar's, so two agents' `sess_1`s never collide). */
  byAgentId: Map<string, string>;
}

interface AcpSessionState {
  kind: 'acp';
  sessionId: string;
  connectionId: string;
  session: AcpSession;
  commands: AvailableCommand[];
  /** Settles when the last prompt handed to this session has finished; the next one waits on it. */
  tail: Promise<void>;
  /** The turn running now, or null. */
  current: RunningTurn | null;
  /** Stop ended a turn and the agent has not been told yet: the next prompt carries STOPPED_NOTE. */
  stopped: boolean;
}

interface ApiConnection {
  kind: 'api';
  connectionId: string;
  provider: 'openrouter';
  baseUrl: string;
  apiKey: string;
  cwd: string;
  models: ReturnType<typeof usableModels>;
  sessions: Map<string, ApiSessionState>;
}

interface ApiSessionState {
  kind: 'api';
  sessionId: string;
  connectionId: string;
  session: EmbeddedSession;
  modes: SessionModeState;
  configOptions: SessionConfigOption[];
  /** Settles when the last prompt handed to this session has finished; the next one waits on it. */
  tail: Promise<void>;
  /** The turn running now, or null. */
  current: RunningTurn | null;
  /** Stop ended a turn and the agent has not been told yet: the next prompt carries STOPPED_NOTE. */
  stopped: boolean;
}

/** A turn in progress: how it ends (for a message steered into it), and whether Stop was pressed on it. */
interface RunningTurn {
  ended: Promise<{ stopReason: StopReason } | { error: Error }>;
  stopping: boolean;
}

/**
 * Said to the agent with the first prompt after Stop. Stop ends a turn but
 * tells the agent nothing, and it read the next short message -- "work?",
 * the person asking whether the app worked -- as leave to carry on with the
 * extraction it had been stopped in, outside any step the app could stop.
 */
const STOPPED_NOTE = '(A note from the app, not from the person: they pressed Stop, which ended your previous turn before it finished. Do not resume or continue that work unless the message below plainly asks you to. If what they want is unclear, ask them.)';

type Connection = AcpConnection | ApiConnection;
type SessionState = AcpSessionState | ApiSessionState;

type Params = Record<string, unknown>;

function asParams(raw: unknown): Params {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidParams('params must be an object');
  return raw as Params;
}

function str(p: Params, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || v.length === 0) throw new InvalidParams(`params.${key} must be a non-empty string`);
  return v;
}

function optStr(p: Params, key: string): string | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new InvalidParams(`params.${key} must be a string`);
  return v;
}

function optBool(p: Params, key: string): boolean | undefined {
  const v = p[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new InvalidParams(`params.${key} must be a boolean`);
  return v;
}

function isAuthRequiredError(err: unknown): boolean {
  const e = err as { code?: unknown; data?: unknown; message?: unknown };
  if (typeof e?.message === 'string' && /auth/i.test(e.message)) return true;
  const data = e?.data as { reason?: unknown } | undefined;
  return typeof data?.reason === 'string' && /auth/i.test(data.reason);
}

const EMBEDDED_MODES: SessionModeState = {
  currentModeId: 'default',
  availableModes: [
    { id: 'default', name: 'Manual', description: 'Always ask before writing files' },
    { id: 'acceptEdits', name: 'Accept edits', description: 'Write files without asking' },
  ],
};

const EFFORT_OPTIONS: { value: Effort; name: string }[] = [
  { value: 'none', name: 'None' },
  { value: 'low', name: 'Low' },
  { value: 'medium', name: 'Medium' },
  { value: 'high', name: 'High' },
];

export class AgentBridge {
  private readonly connections = new Map<string, Connection>();
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly app: AppLink) {}

  methods(): Record<string, MethodHandler> {
    return {
      'agents/list': (raw) => this.list(asParams(raw)),
      'agents/install': (raw) => this.install(asParams(raw)),
      'agents/uninstall': (raw) => {
        const p = asParams(raw);
        const id = str(p, 'id');
        if (!isAgentId(id)) throw new InvalidParams(`params.id: not an agent id: ${JSON.stringify(id)}`);
        return { id, removed: uninstallAgent(str(p, 'dataDir'), id) };
      },
      'agent/connect': (raw) => this.connect(asParams(raw)),
      'agent/login': (raw) => this.login(asParams(raw)),
      'agent/newSession': (raw) => this.newSession(asParams(raw)),
      'agent/status': (raw) => this.status(asParams(raw)),
      'agent/prompt': (raw) => this.prompt(asParams(raw)),
      'agent/cancel': (raw) => {
        const s = this.session(str(asParams(raw), 'sessionId'));
        if (s.current) {
          s.current.stopping = true;
          s.stopped = true;
        }
        s.session.cancel();
        return {};
      },
      'agent/setMode': (raw) => this.setMode(asParams(raw)),
      'agent/setConfigOption': (raw) => this.setConfigOption(asParams(raw)),
      'agent/disconnect': async (raw) => {
        await this.disconnect(str(asParams(raw), 'connectionId'));
        return {};
      },
    };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id).catch(() => undefined)));
  }

  // ---- §1 -----------------------------------------------------------------

  private async registryEntries(p: Params): Promise<{ dataDir: string; entries: RegistryEntry[]; state: Awaited<ReturnType<typeof loadRegistry>> }> {
    const dataDir = str(p, 'dataDir');
    const state = await loadRegistry(dataDir, { registryUrl: optStr(p, 'registryUrl'), refresh: optBool(p, 'refresh') });
    return { dataDir, entries: state.entries, state };
  }

  private async list(p: Params) {
    const { dataDir, entries, state } = await this.registryEntries(p);
    return {
      providers: [...BUILT_IN_PROVIDERS, ...entries.map((e) => toProvider(dataDir, e))],
      registry: { fetchedAt: state.fetchedAt, url: state.url, error: state.error },
    };
  }

  private async entryFor(p: Params, id: string): Promise<{ dataDir: string; entry: RegistryEntry }> {
    const { dataDir, entries } = await this.registryEntries(p);
    const entry = entries.find((e) => e.id === id);
    if (entry === undefined) throw new InvalidParams(`params.id: no registry entry "${id}"`);
    return { dataDir, entry };
  }

  private async install(p: Params) {
    const id = str(p, 'id');
    const { dataDir, entry } = await this.entryFor(p, id);
    if (entry.distribution !== 'npx' && binaryTarget(entry) === null) throw new InvalidParams(`params.id: "${id}" is distributed as ${entry.distribution}${entry.distribution === 'binary' ? ` with no build for ${platformKey()}` : ''}; it cannot be installed here`);
    const npm = p.npm as { registry?: unknown } | undefined;
    const registry = typeof npm?.registry === 'string' ? npm.registry : undefined;
    return installAgent(dataDir, entry, {
      registry,
      onProgress: (stream, line) => this.app.notify('agents/progress', { id, stream, line }),
    });
  }

  // ---- §2 connect ---------------------------------------------------------

  private async connect(p: Params) {
    const provider = str(p, 'provider');
    const cwd = str(p, 'cwd');
    if (provider === 'openrouter') return this.connectOpenRouter(p, cwd);
    if (isBuiltIn(provider)) throw new InvalidParams(`params.provider: "${provider}" has no connect path`);
    const { dataDir, entry } = await this.entryFor(p, provider);
    const bin = resolveBin(dataDir, entry);
    if (bin === null) throw new Error(`${provider} is not installed (agents/install first)`);
    const extraArgs = Array.isArray(p.extraArgs) ? (p.extraArgs as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    const env = typeof p.env === 'object' && p.env !== null ? (p.env as Record<string, string>) : {};
    // A binary agent's program runs as itself, with its platform's args; an npx
    // agent's entry runs on this Node when it is JavaScript, as itself when not.
    const program = entry.distribution === 'binary' ? { command: bin, args: binaryLaunch(dataDir, entry)?.args ?? [] } : (() => {
      const l = launchFor(bin);
      return { command: l.command, args: [...l.args, ...(entry.npx?.args ?? [])] };
    })();
    const baseEnv = entry.distribution === 'binary' ? (binaryLaunch(dataDir, entry)?.env ?? {}) : (entry.npx?.env ?? {});
    const connectionId = randomUUID();
    const conn: AcpConnection = {
      kind: 'acp',
      connectionId,
      provider,
      entry,
      launch: { command: program.command, args: [...program.args, ...extraArgs], env: { ...baseEnv, ...env }, cwd },
      client: undefined as unknown as AcpClient,
      authStatus: null,
      sessions: new Map(),
      byAgentId: new Map(),
    };
    this.connections.set(connectionId, conn);
    // A connect that fails after the spawn -- session/new refused, the agent
    // gone mid-handshake -- returns no connectionId to disconnect with, so the
    // agent process is closed here or it runs until the sidecar exits, one
    // more with every retry.
    try {
      await this.spawnAcp(conn);
      const session = await this.openAcpSession(conn);
      return this.connectResult(conn, session);
    } catch (err) {
      await this.disconnect(connectionId).catch(() => undefined);
      throw err;
    }
  }

  private async spawnAcp(conn: AcpConnection): Promise<void> {
    conn.client = await connect({
      command: conn.launch.command,
      args: conn.launch.args,
      env: conn.launch.env,
      cwd: conn.launch.cwd,
      clientCapabilities: { auth: { terminal: true } },
      clientInfo: { name: 'ape', version: '0.1.0' },
      onPermissionRequest: (params) =>
        this.relayPermission({ ...params, sessionId: conn.byAgentId.get(params.sessionId) ?? params.sessionId }),
      onExtNotification: (method, params) => {
        if (method === '_auth/status_update') {
          const status = (params as { authStatus?: AuthStatus })?.authStatus;
          if (status && typeof status.kind === 'string') {
            conn.authStatus = { kind: status.kind, label: typeof status.label === 'string' ? status.label : status.kind };
            this.app.notify('agent/authStatus', { connectionId: conn.connectionId, authStatus: conn.authStatus });
          }
        }
      },
    });
  }

  /** §2: `newSession`, pin `default` when modes exist; the agent's auth-required error is not a failure. */
  private async openAcpSession(conn: AcpConnection): Promise<AcpSessionState | null> {
    let session: AcpSession;
    try {
      session = await conn.client.newSession({ cwd: conn.launch.cwd });
    } catch (err) {
      if (isAuthRequiredError(err)) return null;
      throw err;
    }
    const sessionId = randomUUID();
    const state: AcpSessionState = { kind: 'acp', sessionId, connectionId: conn.connectionId, session, commands: [], tail: Promise.resolve(), current: null, stopped: false };
    conn.byAgentId.set(session.sessionId, sessionId);
    session.onUpdate((update) => this.forwardUpdate(state, update));
    // Pinned only when the agent offers it: an agent whose modes have other
    // ids refused the call, and every connect to it failed.
    if (session.modes?.availableModes.some((m) => m.id === 'default')) await session.setMode('default');
    conn.sessions.set(sessionId, state);
    this.sessions.set(sessionId, state);
    return state;
  }

  private forwardUpdate(state: AcpSessionState, update: SessionUpdate): void {
    if (update.sessionUpdate === 'available_commands_update') state.commands = update.availableCommands;
    this.app.notify('agent/update', { sessionId: state.sessionId, update });
  }

  /** `modes` is the session/new block; `currentModeId` is what setMode/current_mode_update moved it to. Report the live one. */
  private liveModes(session: AcpSession): SessionModeState | null {
    const modes = session.modes;
    if (modes === undefined) return null;
    return { ...modes, currentModeId: session.currentModeId ?? modes.currentModeId };
  }

  private connectResult(conn: AcpConnection, state: AcpSessionState | null) {
    const info = conn.client.agentInfo;
    return {
      connectionId: conn.connectionId,
      provider: conn.provider,
      kind: 'acp' as const,
      agent: info ? { name: info.name, version: info.version } : null,
      authStatus: conn.authStatus,
      authMethods: conn.client.authMethods as AuthMethod[],
      session:
        state === null
          ? null
          : { sessionId: state.sessionId, modes: this.liveModes(state.session), configOptions: state.session.configOptions ?? null, commands: state.commands },
      authRequired: state === null,
    };
  }

  private async connectOpenRouter(p: Params, cwd: string) {
    const apiKey = optStr(p, 'apiKey');
    if (apiKey === undefined) throw new InvalidParams('params.apiKey is required for openrouter');
    const baseUrl = process.env.APE_OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
    await validateKey(baseUrl, apiKey);
    const models = usableModels(await listModels(baseUrl, apiKey));
    if (models.length === 0) throw new Error('OpenRouter listed no model with tool and image support');
    const connectionId = randomUUID();
    const conn: ApiConnection = { kind: 'api', connectionId, provider: 'openrouter', baseUrl, apiKey, cwd, models, sessions: new Map() };
    this.connections.set(connectionId, conn);
    const state = this.openApiSession(conn);
    return {
      connectionId,
      provider: 'openrouter',
      kind: 'api' as const,
      agent: { name: 'OpenRouter', version: 'v1' },
      authStatus: { kind: 'api-key', label: 'API key' },
      authMethods: [] as AuthMethod[],
      session: { sessionId: state.sessionId, modes: state.modes, configOptions: state.configOptions, commands: [] as AvailableCommand[] },
      authRequired: false,
    };
  }

  private openApiSession(conn: ApiConnection): ApiSessionState {
    const sessionId = randomUUID();
    const modes: SessionModeState = { ...EMBEDDED_MODES, availableModes: [...EMBEDDED_MODES.availableModes] };
    const session = createEmbeddedSession({
      sessionId,
      baseUrl: conn.baseUrl,
      apiKey: conn.apiKey,
      cwd: conn.cwd,
      model: defaultModelId(conn.models),
      effort: 'medium',
      mode: 'default',
      models: conn.models,
      onUpdate: (update) => {
        if (update.sessionUpdate === 'current_mode_update') {
          const id = (update as { currentModeId?: string; modeId?: string }).currentModeId ?? (update as { modeId?: string }).modeId;
          if (id) modes.currentModeId = id;
        }
        this.app.notify('agent/update', { sessionId, update });
      },
      onPermissionRequest: (params) => this.relayPermission({ ...params, sessionId }),
    });
    const state: ApiSessionState = { kind: 'api', sessionId, connectionId: conn.connectionId, session, modes, configOptions: [], tail: Promise.resolve(), current: null, stopped: false };
    state.configOptions = this.apiConfigOptions(conn, state);
    conn.sessions.set(sessionId, state);
    this.sessions.set(sessionId, state);
    return state;
  }

  private apiConfigOptions(conn: ApiConnection, state: ApiSessionState): SessionConfigOption[] {
    return [
      {
        id: 'model',
        type: 'select',
        name: 'Model',
        currentValue: state.session.model,
        options: conn.models.map((m) => ({ value: m.id, name: modelOptionName(m) })),
      },
      { id: 'effort', type: 'select', name: 'Reasoning effort', currentValue: state.session.effort, options: EFFORT_OPTIONS },
    ] as SessionConfigOption[];
  }

  // ---- §3 permission relay ------------------------------------------------

  private async relayPermission(params: RequestPermissionParams): Promise<RequestPermissionOutcome> {
    try {
      const answer = (await this.app.request('agent/requestPermission', params)) as { outcome?: RequestPermissionOutcome } | undefined;
      const outcome = answer?.outcome;
      if (outcome?.outcome === 'selected' && typeof outcome.optionId === 'string') return outcome;
      return { outcome: 'cancelled' };
    } catch {
      return { outcome: 'cancelled' };
    }
  }

  // ---- §2 login -----------------------------------------------------------

  private async login(p: Params) {
    const conn = this.connection(str(p, 'connectionId'));
    const methodId = str(p, 'methodId');
    if (conn.kind === 'api') throw new InvalidParams('params.connectionId: API providers have no login method');
    const method = conn.client.authMethods.find((m) => m.id === methodId);
    if (method === undefined) throw new InvalidParams(`params.methodId: "${methodId}" was not advertised`);
    if (method.type !== 'terminal') {
      // A key the method asked for (codex's "API Key": `_meta["api-key"]`) goes with the request, as it expects.
      const apiKey = typeof p.apiKey === 'string' && p.apiKey ? p.apiKey : null;
      const wantsKey = typeof method._meta === 'object' && method._meta !== null && 'api-key' in (method._meta as Record<string, unknown>);
      await conn.client.authenticate(methodId, wantsKey && apiKey ? { 'api-key': { apiKey } } : undefined);
      // Signed in: the session the connect could not open, opened now -- without
      // one the shell had a sign-in that worked and nothing to work in, and said
      // it had failed.
      const state = conn.sessions.size ? [...conn.sessions.values()][0]! : await this.openAcpSession(conn);
      return { methodId, exitCode: null, authenticated: state !== null, ...this.connectResult(conn, state) };
    }
    const launch = conn.client.terminalAuthLaunch(methodId);
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, { env: launch.env, cwd: launch.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const pump = (stream: 'stdout' | 'stderr') => {
        let buf = '';
        child[stream]!.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let i: number;
          while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i).replace(/\r$/, '');
            buf = buf.slice(i + 1);
            this.app.notify('agent/loginOutput', { connectionId: conn.connectionId, stream, line });
          }
        });
        child[stream]!.on('end', () => {
          if (buf.trim() !== '') this.app.notify('agent/loginOutput', { connectionId: conn.connectionId, stream, line: buf });
        });
      };
      pump('stdout');
      pump('stderr');
      child.on('error', (err) => reject(new Error(`login command failed to start: ${err.message}`)));
      child.on('exit', (code) => resolve(code));
    });
    // Reconnect on the same connectionId: close, respawn, read the fresh auth status.
    for (const s of conn.sessions.values()) this.sessions.delete(s.sessionId);
    conn.sessions.clear();
    conn.byAgentId.clear();
    await conn.client.close();
    conn.authStatus = null;
    await this.spawnAcp(conn);
    await this.waitForAuthStatus(conn, 3000);
    const state = await this.openAcpSession(conn);
    const result = this.connectResult(conn, state);
    const status: AuthStatus | null = result.authStatus;
    return { methodId, exitCode, authenticated: status !== null && status.kind !== 'none', ...result };
  }

  private waitForAuthStatus(conn: AcpConnection, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const started = Date.now();
      const tick = () => {
        if (conn.authStatus !== null || Date.now() - started >= ms) resolve();
        else setTimeout(tick, 25);
      };
      tick();
    });
  }

  /** A second session that shares the process but none of the conversation: the adjudicator's seat. */
  private async newSession(p: Params) {
    const conn = this.connection(str(p, 'connectionId'));
    if (conn.kind === 'api') {
      const state = this.openApiSession(conn);
      return { session: { sessionId: state.sessionId, modes: state.modes, configOptions: state.configOptions, commands: [] as AvailableCommand[] } };
    }
    const state = await this.openAcpSession(conn);
    if (state === null) throw new Error('the agent requires sign-in before a session can be opened');
    return { session: this.connectResult(conn, state).session };
  }

  private status(p: Params) {
    const conn = this.connection(str(p, 'connectionId'));
    return {
      connectionId: conn.connectionId,
      provider: conn.provider,
      kind: conn.kind,
      authStatus: conn.kind === 'acp' ? conn.authStatus : { kind: 'api-key', label: 'API key' },
      authMethods: conn.kind === 'acp' ? (conn.client.authMethods as AuthMethod[]) : [],
      sessions: [...conn.sessions.keys()],
    };
  }

  // ---- §2 prompt / cancel / mode / config ---------------------------------

  private async prompt(p: Params) {
    const state = this.session(str(p, 'sessionId'));
    const blocks = p.blocks;
    if (!Array.isArray(blocks) || blocks.some((b) => typeof b !== 'object' || b === null || typeof (b as { type?: unknown }).type !== 'string')) {
      throw new InvalidParams('params.blocks must be an array of content blocks');
    }
    // A prompt sent during a turn is never refused: the chat and the stages
    // share the writer session, and a message typed while a stage ran was once
    // refused and never reached the agent. Where the agent takes steering
    // (claude-agent-acp's _session/steering), it goes into the running turn
    // and the agent reads it at its next step -- held until the turn ended,
    // a note sent during a four-minute extract read as ignored. The result is
    // that turn's, marked `steered`. A turn being stopped takes nothing.
    const running = state.current;
    if (state.kind === 'acp' && running && !running.stopping && (this.connection(state.connectionId) as AcpConnection).client.steering) {
      const outcome = await state.session.steer(blocks as ContentBlock[]).catch(() => 'promptRequired' as const);
      if (outcome === 'injected') {
        this.app.notify('agent/delivery', { sessionId: state.sessionId, steered: true });
        const end = await running.ended;
        if ('error' in end) throw new Error(`the turn this message went into failed: ${end.error.message}`);
        return { stopReason: end.stopReason, steered: true };
      }
    }
    // Otherwise one turn at a time: held, and run when the turn before ends,
    // in the order sent.
    if (running) this.app.notify('agent/delivery', { sessionId: state.sessionId, steered: false });
    const before = state.tail;
    let finished!: () => void;
    state.tail = new Promise<void>((resolve) => (finished = resolve));
    await before;
    if (this.sessions.get(state.sessionId) !== state) {
      finished();
      throw new Error(`session ${state.sessionId} closed before this message reached the agent`);
    }
    let sent = blocks as ContentBlock[];
    if (state.stopped) {
      state.stopped = false;
      sent = [{ type: 'text', text: STOPPED_NOTE }, ...sent];
    }
    let end!: (e: { stopReason: StopReason } | { error: Error }) => void;
    state.current = { ended: new Promise((resolve) => (end = resolve)), stopping: false };
    this.app.notify('agent/turn', { sessionId: state.sessionId, running: true });
    try {
      let stopReason: StopReason;
      if (state.kind === 'api') {
        stopReason = await state.session.prompt(sent);
      } else {
        // In-turn updates arrive only through the iterator (src/acp/session.ts
        // handleUpdate: an active turn swallows them); out-of-turn ones reach
        // onUpdate. Both are forwarded to the app as agent/update.
        const turn = state.session.prompt(sent);
        let next = await turn.next();
        while (!next.done) {
          this.forwardUpdate(state, next.value);
          next = await turn.next();
        }
        stopReason = next.value.stopReason as StopReason;
      }
      end({ stopReason });
      return { stopReason };
    } catch (err) {
      const e = err instanceof OpenRouterError ? new Error(err.message) : err instanceof Error ? err : new Error(String(err));
      end({ error: e });
      throw e;
    } finally {
      state.current = null;
      this.app.notify('agent/turn', { sessionId: state.sessionId, running: false });
      finished();
    }
  }

  private async setMode(p: Params) {
    const state = this.session(str(p, 'sessionId'));
    const modeId = str(p, 'modeId');
    if (state.kind === 'api') {
      if (!state.modes.availableModes.some((m) => m.id === modeId)) throw new InvalidParams(`params.modeId: unknown mode "${modeId}"`);
      state.session.setMode(modeId as EmbeddedMode);
      state.modes.currentModeId = modeId;
      return { modes: state.modes };
    }
    const modes = state.session.modes;
    if (modes === undefined || !modes.availableModes.some((m) => m.id === modeId)) throw new InvalidParams(`params.modeId: unknown mode "${modeId}"`);
    await state.session.setMode(modeId);
    return { modes: this.liveModes(state.session) ?? modes };
  }

  private async setConfigOption(p: Params) {
    const state = this.session(str(p, 'sessionId'));
    const id = str(p, 'id');
    const value = p.value;
    if (typeof value !== 'string' && typeof value !== 'boolean') throw new InvalidParams('params.value must be a string or boolean');
    if (state.kind === 'api') {
      const conn = this.connection(state.connectionId) as ApiConnection;
      try {
        if (id === 'model' && typeof value === 'string') state.session.setModel(value);
        else if (id === 'effort' && typeof value === 'string') state.session.setEffort(value as Effort);
        else throw new InvalidParams(`params.id: unknown config option "${id}"`);
      } catch (err) {
        if (err instanceof RangeError) throw new InvalidParams(`params.value: ${err.message}`);
        throw err;
      }
      state.configOptions = this.apiConfigOptions(conn, state);
      return { configOptions: state.configOptions };
    }
    const known = state.session.configOptions?.find((o) => o.id === id);
    if (known === undefined) throw new InvalidParams(`params.id: unknown config option "${id}"`);
    if (known.type === 'select' && typeof value === 'string' && !known.options.some((o) => o.value === value)) {
      throw new InvalidParams(`params.value: "${value}" is not an option of "${id}"`);
    }
    await state.session.setConfigOption(id, value);
    return { configOptions: state.session.configOptions ?? [] };
  }

  private async disconnect(connectionId: string): Promise<void> {
    const conn = this.connection(connectionId);
    for (const s of conn.sessions.values()) {
      s.session.cancel();
      this.sessions.delete(s.sessionId);
    }
    this.connections.delete(connectionId);
    if (conn.kind === 'acp') await conn.client.close();
  }

  private connection(id: string): Connection {
    const conn = this.connections.get(id);
    if (conn === undefined) throw new InvalidParams(`params.connectionId: unknown connection "${id}"`);
    return conn;
  }

  private session(id: string): SessionState {
    const s = this.sessions.get(id);
    if (s === undefined) throw new InvalidParams(`params.sessionId: unknown session "${id}"`);
    return s;
  }
}
