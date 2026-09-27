// The client side of the ACP handshake and the prompt turn: initialize +
// version negotiation, session creation, sending a prompt and surfacing the
// agent's streamed `session/update` notifications as an async iterator that
// ends on a stop reason, and mid-turn cancellation. Built entirely on
// transport.ts's generic request()/notify()/onRequest()/onNotification() --
// no framing or JSON-RPC envelope logic lives here, only ACP method names,
// param shapes (protocol.ts), and turn/permission bookkeeping.
//
// Five design decisions worth calling out because they are load-bearing for
// specific test assertions (points 1-4) or for a real (if untested-by-mock)
// agent behavior (point 5), not just style:
//
// 1. **`prompt()` sends the request eagerly, synchronously, before ever
//    returning the async generator to the caller.** It is NOT a lazy
//    `async function*` that only sends on first `.next()`. cancellation.test.ts's
//    permission-cancellation case calls `session.prompt(...)` and then
//    awaits an out-of-band signal (the injected policy callback having been
//    invoked) *without ever calling `.next()`* before calling
//    `session.cancel()` -- so the wire request, and the bookkeeping cancel()
//    depends on, must already exist the instant prompt() returns. The
//    generator returned by prompt() only *drains* an already-in-flight turn.
//
// 2. **Every `session/update` notification for a turn is queued and
//    strictly drained before the turn's terminal outcome (result or error)
//    is ever surfaced.** This is what makes "the one update sent before a
//    mid-turn crash still arrives" (errors.test.ts) and "an update sent
//    between session/cancel and the eventual cancelled response still
//    arrives" (cancellation.test.ts, acp-protocol.md #14.1's "SHOULD still
//    accept...updates received after sending session/cancel") both true
//    without racing: pushUpdate() calls happen synchronously from inside
//    transport's notification dispatch, while the turn's settle() only ever
//    runs from a `.then()` on the request promise -- a microtask that by
//    definition cannot run until the synchronous dispatch of every line
//    that arrived before the response line (in the same chunk or an
//    earlier one) has already finished. See TurnState below.
//
// 3. **The client answers a pending `session/request_permission` with the
//    `cancelled` outcome itself, on cancel() -- it never waits on the
//    injected policy callback to do it.** acp-protocol.md #14.1: "The
//    Client MUST respond to all pending session/request_permission requests
//    with the cancelled outcome," stated as the client's own unconditional
//    obligation. cancellation.test.ts proves this by handing cancel() a
//    policy callback that never resolves at all.
//
// 4. **connect() does NOT await the transport's teardown before rejecting**
//    on a version mismatch or a failed initialize -- it starts close() and
//    rejects immediately. lifecycle.test.ts's protocol-mismatch case
//    asserts the agent process is still alive immediately after connect()'s
//    promise settles (a "sanity check" that it really started) and only
//    THEN polls for it to exit within a further 2s -- which is only
//    possible if connect()'s rejection isn't gated on the subprocess having
//    already exited. transport.close() itself is documented never to
//    reject, so firing it without awaiting is safe.
//
// 5. **`session/update` notifications are not all turn-scoped.** Four of
//    #8's eleven variants (available_commands_update, session_info_update,
//    current_mode_update, config_option_update) are agent-unilateral --
//    #18 says the slash-command catalog "may [be] resend[ent]... at any
//    time" -- and a real agent can and does emit them immediately after
//    session/new, before any prompt() call exists to queue them into.
//    AcpSessionImpl buffers such updates and/or hands them to onUpdate()
//    (see its own doc comment) instead of dropping them; connect() below
//    additionally buffers by sessionId (`pendingSessionUpdates`) for the
//    narrower race where such an update arrives before newSession()'s
//    `await` has even returned to register the session at all -- dispatch()
//    processes every line in one stdout chunk synchronously and in order,
//    but the code that runs *after* an `await` only resumes as a later
//    microtask, so an update in the same chunk as the session/new response
//    it follows can reach this module's notification router before
//    newSession() has had a chance to call `sessions.set(...)`.

import { AcpTransport, type RequestId } from './transport.js';
import {
  DEFAULT_CLIENT_INFO,
  PROTOCOL_VERSION,
  type AgentCapabilities,
  type AuthMethod,
  type ClientCapabilities,
  type ContentBlock,
  type Implementation,
  type InitializeResult,
  type McpServer,
  type NewSessionParams,
  type PromptInput,
  type PromptTurnResult,
  type ProtocolVersion,
  type RequestPermissionOutcome,
  type RequestPermissionParams,
  type SessionId,
  type SessionConfigOption,
  type SessionMode,
  type SessionModeState,
  type SessionUpdate,
  type TerminalAuthLaunch,
} from './protocol.js';

// ---- public surface --------------------------------------------------------

/**
 * The injectable permission policy. Called once per `session/request_permission`
 * the agent sends (acp-protocol.md #11.1) -- the client must route it here,
 * never auto-approve, and must actually wait for (and use) whatever this
 * returns, unless cancel() intervenes first (see file header, point 3).
 */
export type PermissionRequestHandler = (
  params: RequestPermissionParams,
) => RequestPermissionOutcome | Promise<RequestPermissionOutcome>;

export interface ConnectOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  onPermissionRequest: PermissionRequestHandler;
  /** Overrides DEFAULT_CLIENT_INFO if given; sent as `clientInfo` on `initialize` (#4.1). */
  clientInfo?: Implementation;
  /**
   * The only capability a caller may switch on. `fs` and `terminal` stay
   * `false` whatever is passed here -- this client implements neither -- and
   * with the field omitted the `initialize` frame is byte-identical to what
   * it always was (no `auth` key). See ClientCapabilities.auth.
   */
  clientCapabilities?: { auth?: { terminal?: boolean } };
  /**
   * Extension notifications (#19: method names beginning with `_`), which
   * this client otherwise ignores. claude-agent-acp reports sign-in state
   * as `_auth/status_update` (docs/research/claude-adapter-auth.md §3), and
   * a host that offers a Sign-in button needs to see it. Called with the
   * raw method and params; never awaited, exceptions swallowed.
   */
  onExtNotification?: (method: string, params: unknown) => void;
  /**
   * Optional ceiling on how long connect() waits for the agent's `initialize`
   * response before giving up. `undefined` (the default) preserves the
   * original behavior of waiting indefinitely -- nothing here times out
   * unless a caller opts in. A hang here is indistinguishable on the wire
   * from an agent that is merely slow to start, so there is no spec-derived
   * number to default to; this is deliberately scoped to `initialize` only
   * (not a general per-request timeout) since a stuck handshake, with no
   * client to call close() on yet, is the one failure a caller has no other
   * way to detect or recover from. On expiry, connect() rejects and tears
   * down the subprocess exactly as it does for any other connect()-time
   * failure (see file header, point 4).
   */
  initializeTimeoutMs?: number;
}

/** `ms === undefined` returns `p` completely unwrapped -- no timer, no altered behavior -- which is what keeps ConnectOptions.initializeTimeoutMs strictly opt-in. */
function withOptionalTimeout<T>(p: Promise<T>, ms: number | undefined, makeError: () => Error): Promise<T> {
  if (ms === undefined) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export interface AcpSession {
  readonly sessionId: SessionId;
  /**
   * Sends one prompt turn (#7) and returns an async iterator: each
   * `.next()` yields one `session/update` payload in wire order, and the
   * iterator's own return value (only reachable via the generator protocol's
   * `return`, e.g. by manually driving `.next()` -- a bare `for await` loop
   * discards it) is the turn's final PromptTurnResult. Rejects instead of
   * completing if the turn itself fails (JSON-RPC error, malformed data, or
   * the agent process dying mid-turn).
   */
  prompt(input: PromptInput): AsyncGenerator<SessionUpdate, PromptTurnResult, void>;
  /**
   * Cancels the in-flight turn, if any (a harmless no-op otherwise):
   * notifies the agent (#14.1) and immediately answers any outstanding
   * `session/request_permission` for this session with the cancelled
   * outcome (see file header, point 3). Does not itself wait for the
   * agent's eventual `stopReason: "cancelled"` response -- keep draining
   * the iterator for that.
   */
  cancel(): void;
  /**
   * Puts a message into the turn that is running rather than queuing it
   * behind: the agent reads it at its next step. The `_session/steering`
   * extension, which claude-agent-acp advertises as
   * `InitializeResponse._meta.steering.supported`; sent with
   * `idleBehavior: "promptRequired"`, so an agent with no turn running
   * answers `promptRequired` and does nothing -- the message is then the
   * caller's to send as an ordinary prompt. Rejects without sending when
   * the agent did not advertise the extension (`AcpClient.steering`).
   */
  steer(input: PromptInput): Promise<'injected' | 'promptRequired'>;
  /**
   * Registers the handler for `session/update` notifications that arrive
   * with no prompt turn in flight to queue them into -- see file header,
   * point 5. Real examples: the slash-command catalog (#18) or the
   * session's own title (#6.6) changing outside of anything a `prompt()`
   * call is draining. At most one handler is kept (a later call replaces an
   * earlier one, matching transport.ts's onRequest/onNotification
   * convention); anything that arrived before any handler was ever
   * registered is delivered, in order, the moment one is.
   */
  onUpdate(listener: (update: SessionUpdate) => void): void;
  /**
   * The `modes` block the agent reported at session setup (#17.1), or
   * undefined if it reported none. Read-only snapshot of what was
   * advertised; `currentModeId` below is the live value.
   */
  readonly modes: SessionModeState | undefined;
  /**
   * The mode currently in effect, tracked across both ways it can change:
   * a successful setMode(), and the agent switching unilaterally via
   * `current_mode_update` (#17.1 permits both). Undefined when the agent
   * reported no modes.
   *
   * Worth reading before trusting a permission callback. A real agent
   * inherits this from its host's configuration, and in a mode like `auto`
   * it decides permissions itself and never sends
   * `session/request_permission` -- so an unread mode makes
   * onPermissionRequest look like a control when it is not wired to
   * anything.
   */
  readonly currentModeId: string | undefined;
  /**
   * Switches the session's mode (#17.1). Rejects without sending anything
   * if the agent reported no modes, or if `modeId` is not one it
   * advertised -- both are caller bugs detectable locally.
   */
  setMode(modeId: string): Promise<void>;
  /**
   * Session Config Options (#17.2), or undefined if the agent reported
   * none. Kept current across both ways the agent can change it: the full
   * state returned by setConfigOption(), and the `config_option_update`
   * notification.
   *
   * PRECEDENCE (#17.2): when an agent reports both this and `modes`, the
   * spec says a client supporting config options "SHOULD use configOptions
   * exclusively and ignore modes" -- modes is the fallback for agents that
   * have not migrated. Both are surfaced here rather than one being hidden,
   * because a caller may still need the fallback; `supportsConfigOptions`
   * says which one to trust.
   */
  readonly configOptions: SessionConfigOption[] | undefined;
  /** True when the agent reported `configOptions`, i.e. when #17.2 supersedes `modes` for this session. */
  readonly supportsConfigOptions: boolean;
  /**
   * Sets one config option (#17.2) and adopts the agent's response.
   *
   * That response carries the WHOLE option list, not just the option that
   * changed -- the spec's stated reason being that changing one option may
   * change others ("if changing the model affects available reasoning
   * options"). This replaces local state from it wholesale rather than
   * patching the single field, since a patch would silently desync on
   * every dependent change.
   *
   * Rejects without sending anything if the agent reported no config
   * options, if `configId` names none of them, or if a select option was
   * given a value it does not offer.
   */
  setConfigOption(configId: string, value: string | boolean): Promise<void>;
}

export interface AcpClient {
  readonly protocolVersion: ProtocolVersion;
  /** Frozen: see parseAuthMethods. authenticate()'s #5.3 guard resolves ids against this, so it must not be editable from outside. */
  readonly authMethods: readonly AuthMethod[];
  readonly agentInfo: Implementation | undefined;
  readonly agentCapabilities: AgentCapabilities;
  /** The agent takes `_session/steering` (see AcpSession.steer): `_meta.steering.supported` in its initialize result. */
  readonly steering: boolean;
  newSession(params: NewSessionParams): Promise<AcpSession>;
  /**
   * Protocol-driven authentication (#5.2): sends `authenticate` with
   * `{methodId}` and resolves on the empty-object result. `methodId` must
   * name a **default (`agent`-type)** entry of `authMethods`.
   *
   * Rejects without sending anything for an id the agent never advertised,
   * and -- the case that matters -- for a `type: "terminal"` id, which
   * #5.3 says a client MUST NOT put in an `authenticate` request. Both are
   * caller bugs detectable locally, and a terminal id in particular routes
   * a credential-bearing request down a flow the agent never offered, so
   * neither is worth a round trip to discover.
   */
  authenticate(methodId: string, meta?: Record<string, unknown>): Promise<void>;
  /**
   * Ends the authenticated state (#5.4). Rejects without sending anything
   * unless `agentCapabilities.auth.logout` was advertised at initialize.
   *
   * Per #5.4 the fate of already-running sessions is explicitly undefined
   * -- agents "may terminate them, keep them running, or return
   * auth_required errors" -- so this deliberately does not touch the
   * `sessions` map. Expect -32000 on any in-flight session afterwards and
   * re-authenticate; this client cannot know which agents do which.
   */
  logout(): Promise<void>;
  /**
   * Resolves #5.3 steps 1-2 for a `type: "terminal"` auth method: the
   * command from **this client's own** launch configuration (the spec is
   * explicit that "the descriptor cannot provide a command"), the method's
   * `args` appended to the base args, and its `env` merged over the base
   * environment.
   *
   * Pure: it launches nothing. Steps 3-4 -- presenting the terminal and
   * reconnecting -- are the host's, since neither can be done from a
   * transport client without a UI. Throws for an unknown or non-terminal
   * method id.
   */
  terminalAuthLaunch(methodId: string): TerminalAuthLaunch;
  /** Ends the connection and reaps the agent subprocess. Idempotent; never rejects. */
  close(): Promise<void>;
}

/**
 * Spawns the agent, performs `initialize` and version negotiation (#4), and
 * resolves with a ready-to-use client. Rejects (without hanging, and
 * without leaking the subprocess -- see file header, point 4) if the agent
 * exits before answering, sends unparseable data, or negotiates a
 * `protocolVersion` this client does not support (#4.3: "the Client SHOULD
 * close the connection").
 */
export async function connect(options: ConnectOptions): Promise<AcpClient> {
  const transport = new AcpTransport({ command: options.command, args: options.args, env: options.env, cwd: options.cwd });
  const sessions = new Map<SessionId, AcpSessionImpl>();
  // sessionId -> updates that arrived for it before newSession() finished
  // registering it in `sessions` -- see file header, point 5. Flushed (and
  // its entry removed) by newSession() itself the moment it registers that
  // sessionId; an id that never gets registered (e.g. a stray/unrelated
  // notification, framing.test.ts's "fragmented" case) simply sits here
  // harmlessly for the life of the connection rather than being routed
  // anywhere.
  const pendingSessionUpdates = new Map<SessionId, SessionUpdate[]>();

  transport.onNotification((method, params) => {
    if (method.startsWith('_') && options.onExtNotification !== undefined) {
      try {
        options.onExtNotification(method, params);
      } catch {
        /* a host listener must not break the router */
      }
      return;
    }
    if (method !== 'session/update') return; // unrecognized notifications: ignore, per #19 ("implementations SHOULD ignore" unknown notifications -- unlike unknown requests, which get -32601 below)
    const payload = params as { sessionId?: unknown; update?: unknown };
    if (typeof payload.sessionId !== 'string' || typeof payload.update !== 'object' || payload.update === null) return;
    const update = payload.update as SessionUpdate;
    const session = sessions.get(payload.sessionId);
    if (session) {
      session.handleUpdate(update);
      return;
    }
    // Not registered (yet, or ever) -- buffer by sessionId rather than the
    // prior behavior of silently discarding it via optional chaining.
    let queued = pendingSessionUpdates.get(payload.sessionId);
    if (!queued) {
      queued = [];
      pendingSessionUpdates.set(payload.sessionId, queued);
    }
    queued.push(update);
  });

  transport.onRequest((method, params, id) => {
    if (method === 'session/request_permission') {
      const payload = params as Partial<RequestPermissionParams> | undefined;
      if (!payload || typeof payload.sessionId !== 'string' || !Array.isArray(payload.options) || typeof payload.toolCall !== 'object' || payload.toolCall === null) {
        transport.respondError(id, { code: -32602, message: 'invalid params for session/request_permission' });
        return;
      }
      const session = sessions.get(payload.sessionId);
      if (!session) {
        transport.respondError(id, { code: -32602, message: `session/request_permission for unknown session ${payload.sessionId}` });
        return;
      }
      session.handlePermissionRequest(payload as RequestPermissionParams, id, options.onPermissionRequest);
      return;
    }
    // #19: an unrecognized *request* MUST get a response, never be silently
    // dropped -- this client advertises no fs/*/terminal/*/elicitation
    // capabilities (see protocol.ts's scope note), so a spec-compliant
    // agent should never send one, but a well-behaved peer answers anyway
    // rather than leaving the agent's request hanging forever.
    transport.respondError(id, { code: -32601, message: `method not found: ${method}` });
  });

  try {
    const raw = (await withOptionalTimeout(
      transport.request('initialize', buildInitializeParams(options.clientInfo, options.clientCapabilities)),
      options.initializeTimeoutMs,
      () => new Error(`initialize did not respond within ${options.initializeTimeoutMs}ms`),
    )) as InitializeResult;
    if (raw.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `agent negotiated protocol version ${raw.protocolVersion}, but this client only supports version ${PROTOCOL_VERSION} (acp-protocol.md #4.3: "the Client SHOULD close the connection and inform the user")`,
      );
    }
    return new AcpClientImpl(
      transport,
      sessions,
      pendingSessionUpdates,
      {
        protocolVersion: raw.protocolVersion,
        authMethods: parseAuthMethods(raw.authMethods),
        agentInfo: raw.agentInfo ?? undefined,
        agentCapabilities: normalizeAgentCapabilities(raw.agentCapabilities),
        steering: (raw as { _meta?: { steering?: { supported?: unknown } } })._meta?.steering?.supported === true,
      },
      {
        command: options.command,
        args: options.args ?? [],
        // Same merge transport.ts spawns with, so a #5.3 relaunch
        // reproduces this connection rather than a bare subset of it.
        env: { ...(process.env as Record<string, string>), ...(options.env ?? {}) },
        cwd: options.cwd,
      },
    );
  } catch (err) {
    // Fire-and-forget: see file header, point 4. transport.close() is
    // documented to never reject, so this cannot produce an unhandled
    // rejection.
    void transport.close();
    throw err;
  }
}

function buildInitializeParams(
  clientInfo: Implementation | undefined,
  requested: ConnectOptions['clientCapabilities'],
): { protocolVersion: ProtocolVersion; clientCapabilities: ClientCapabilities; clientInfo: Implementation } {
  // Explicit `false`s, not an omitted object: this client implements none
  // of fs/*, terminal/*, and must not let the agent infer otherwise
  // (lifecycle.test.ts asserts on exactly this). `auth` is added only when
  // asked for, so the default frame is unchanged.
  const clientCapabilities: ClientCapabilities = { fs: { readTextFile: false, writeTextFile: false }, terminal: false };
  if (requested?.auth !== undefined && typeof requested.auth.terminal === 'boolean') {
    clientCapabilities.auth = { terminal: requested.auth.terminal };
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities,
    clientInfo: clientInfo ?? DEFAULT_CLIENT_INFO,
  };
}

/**
 * Validates the initialize response's `authMethods` (#5.1) instead of
 * casting it, for the reason parseModeState and the sessionId guard exist:
 * a cast hands callers half-formed objects, and here it is load-bearing --
 * authenticate()'s #5.3 MUST-NOT guard decides whether a credential-bearing
 * request goes out by matching an id against these entries, so junk in this
 * array is junk in a security check. Entries lacking a string `id` or
 * `name` are dropped rather than repaired: #5.1 requires both, and a method
 * we cannot name is one no caller could sensibly select.
 *
 * Frozen, not merely copied. The property is `readonly`, which stops
 * reassignment and nothing else -- the array itself stayed mutable, so a
 * caller could retype a terminal method as an agent one and make the guard
 * answer differently. Freezing costs a caller only the need to copy before
 * sorting, and buys a guarantee the guard can rely on.
 */
function parseAuthMethods(raw: unknown): readonly AuthMethod[] {
  if (!Array.isArray(raw)) return Object.freeze([] as AuthMethod[]);
  const parsed = raw.filter((m): m is AuthMethod => {
    if (typeof m !== 'object' || m === null) return false;
    const method = m as AuthMethod;
    return typeof method.id === 'string' && typeof method.name === 'string';
  });
  for (const method of parsed) Object.freeze(method);
  return Object.freeze(parsed);
}

/**
 * Reads #17.2's optional `configOptions` list. Validated rather than cast,
 * for the same reason parseModeState is: a half-formed entry would surface
 * as a SessionConfigOption whose `options` array is undefined, and every
 * caller iterates it. Entries are passed through whole so an agent's extra
 * spec-legal fields (`_meta`, #3) survive -- claude-agent-acp 0.75.1 puts
 * `_meta.kind` on each choice.
 */
function parseConfigOptions(raw: unknown): SessionConfigOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parsed = raw.filter((o): o is SessionConfigOption => {
    if (typeof o !== 'object' || o === null) return false;
    const opt = o as SessionConfigOption;
    if (typeof opt.id !== 'string') return false;
    if (opt.type === 'select') return Array.isArray(opt.options);
    return opt.type === 'boolean';
  });
  return parsed;
}

/**
 * Reads #17.1's optional `modes` block off a session/new result. Validated
 * rather than cast: `modes` is optional-or-null on the wire, and a
 * half-formed block would otherwise surface as a SessionModeState whose
 * availableModes is undefined, which every caller would then iterate.
 */
function parseModeState(raw: unknown): SessionModeState | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const { currentModeId, availableModes } = raw as { currentModeId?: unknown; availableModes?: unknown };
  if (typeof currentModeId !== 'string' || !Array.isArray(availableModes)) return undefined;
  return {
    currentModeId,
    // Pass each entry through rather than rebuilding it, so an agent's
    // extra spec-legal fields (`_meta`, #3) survive -- claude-agent-acp
    // 0.75.1 puts a `_meta.kind` on every mode.
    availableModes: availableModes.filter(
      (m): m is SessionMode => typeof m === 'object' && m !== null && typeof (m as SessionMode).id === 'string',
    ),
  };
}

/** Applies every #4.4 default and flattens the wire's presence-typed fields to booleans (see protocol.ts's AgentCapabilities doc comment). */
function normalizeAgentCapabilities(raw: InitializeResult['agentCapabilities']): AgentCapabilities {
  const sessionCaps = raw?.sessionCapabilities;
  return {
    loadSession: raw?.loadSession ?? false,
    promptCapabilities: {
      image: raw?.promptCapabilities?.image ?? false,
      audio: raw?.promptCapabilities?.audio ?? false,
      embeddedContext: raw?.promptCapabilities?.embeddedContext ?? false,
    },
    mcpCapabilities: {
      http: raw?.mcpCapabilities?.http ?? false,
      sse: raw?.mcpCapabilities?.sse ?? false,
    },
    sessionCapabilities: {
      resume: isSupported(sessionCaps?.resume),
      close: isSupported(sessionCaps?.close),
      delete: isSupported(sessionCaps?.delete),
      list: isSupported(sessionCaps?.list),
      additionalDirectories: isSupported(sessionCaps?.additionalDirectories),
      fork: isSupported(sessionCaps?.fork),
      subagents: isSupported(sessionCaps?.subagents),
    },
    auth: { logout: isSupported(raw?.auth?.logout) },
  };
}

/**
 * Reads one #4.4 presence-typed capability field.
 *
 * The convention is omit-or-null for unsupported and `{}` for supported, so
 * a bare presence check is nearly right. It is wrong in one direction that
 * matters: an agent spelling the field as a literal `false` -- off-spec, but
 * the obvious thing to write, and cost-free to tolerate -- is PRESENT, and a
 * `!= null` check therefore reports every capability it explicitly denied as
 * supported. Inverted and silent, and no observed agent produces it, so
 * nothing would have caught it in the field.
 *
 * `true` is accepted for the same reason, from the other side.
 */
function isSupported(value: unknown): boolean {
  return value != null && value !== false;
}

// ---- turn bookkeeping -------------------------------------------------------
//
// A small push queue plus a one-shot settlement, shared between whatever
// pushes updates/settles the turn (the transport's notification handler,
// and the `.then()` on the underlying session/prompt request) and whatever
// drains it (the async generator prompt() returns). See file header point 2
// for why ordering is safe without any explicit locking.

type TurnOutcome = { ok: true; result: PromptTurnResult } | { ok: false; error: Error };
type TurnStep = { kind: 'update'; update: SessionUpdate } | { kind: 'done'; outcome: TurnOutcome };

class TurnState {
  private readonly queue: SessionUpdate[] = [];
  private outcome: TurnOutcome | undefined;
  private waiter: (() => void) | undefined;

  pushUpdate(update: SessionUpdate): void {
    this.queue.push(update);
    this.wake();
  }

  /** First settle wins; a stray double-settle (there should never be one) is silently ignored rather than corrupting an already-delivered outcome. */
  settle(outcome: TurnOutcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  /** Resolves to the next queued update, or the terminal outcome once the queue is empty and the turn has settled -- queued updates always win, however late they arrive relative to settle(). */
  async next(): Promise<TurnStep> {
    for (;;) {
      if (this.queue.length > 0) {
        return { kind: 'update', update: this.queue.shift()! };
      }
      if (this.outcome) {
        return { kind: 'done', outcome: this.outcome };
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function normalizePromptInput(input: PromptInput): ContentBlock[] {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input;
}

/** #7.2: promptCapabilities gate what THIS CLIENT may send, never what an agent may emit (that asymmetry is #23 item 6). Checked at send time, before the request goes out. */
function assertPromptBlocksAllowed(blocks: ContentBlock[], caps: AgentCapabilities['promptCapabilities']): void {
  for (const block of blocks) {
    if (block.type === 'image' && !caps.image) {
      throw new Error('cannot send an image content block: the agent did not advertise promptCapabilities.image (acp-protocol.md #7.2)');
    }
    if (block.type === 'audio' && !caps.audio) {
      throw new Error('cannot send an audio content block: the agent did not advertise promptCapabilities.audio (acp-protocol.md #7.2)');
    }
    if (block.type === 'resource' && !caps.embeddedContext) {
      throw new Error('cannot send an embedded resource content block: the agent did not advertise promptCapabilities.embeddedContext (acp-protocol.md #7.2)');
    }
  }
}

// ---- session ----------------------------------------------------------------

class AcpSessionImpl implements AcpSession {
  readonly sessionId: SessionId;
  private readonly transport: AcpTransport;
  private readonly promptCapabilities: AgentCapabilities['promptCapabilities'];
  private readonly steering: boolean;
  private activeTurn: TurnState | undefined;
  private readonly pendingPermissions = new Map<RequestId, { cancel: () => void }>();
  // Out-of-turn `session/update`s (file header, point 5), held until
  // onUpdate() registers a listener to flush them into. Unbounded on
  // purpose: the four variants that ever land here (available_commands_
  // update, session_info_update, current_mode_update, config_option_update)
  // are small, infrequent, agent-unilateral control-plane messages, not the
  // high-volume agent_message_chunk stream -- that one is always turn-scoped
  // and drained via prompt()'s generator instead, never through this path.
  private readonly outOfTurnUpdates: SessionUpdate[] = [];
  private updateListener: ((update: SessionUpdate) => void) | undefined;
  readonly modes: SessionModeState | undefined;
  currentModeId: string | undefined;
  configOptions: SessionConfigOption[] | undefined;

  get supportsConfigOptions(): boolean {
    return this.configOptions !== undefined;
  }

  constructor(
    sessionId: SessionId,
    transport: AcpTransport,
    promptCapabilities: AgentCapabilities['promptCapabilities'],
    modes: SessionModeState | undefined,
    configOptions: SessionConfigOption[] | undefined,
    steering = false,
  ) {
    this.sessionId = sessionId;
    this.transport = transport;
    this.promptCapabilities = promptCapabilities;
    this.steering = steering;
    this.modes = modes;
    this.currentModeId = modes?.currentModeId;
    this.configOptions = configOptions;
  }

  /** #17.2; see the AcpSession interface for why the whole response is adopted. */
  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    const options = this.configOptions;
    if (!options) {
      throw new Error('setConfigOption: the agent reported no config options for this session (acp-protocol.md #17.2)');
    }
    const option = options.find((o) => o.id === configId);
    if (!option) {
      const known = options.map((o) => o.id).join(', ') || '<none>';
      throw new Error(`setConfigOption: no config option with id "${configId}" (available: ${known}) (acp-protocol.md #17.2)`);
    }
    if (option.type === 'select' && !option.options.some((c) => c.value === value)) {
      const offered = option.options.map((c) => c.value).join(', ');
      throw new Error(`setConfigOption: "${String(value)}" is not one of the values "${configId}" offers (${offered}) (acp-protocol.md #17.2)`);
    }
    const params: { sessionId: SessionId; configId: string; value: string | boolean; type?: 'boolean' } = {
      sessionId: this.sessionId,
      configId,
      value,
    };
    // #17.2's boolean variant sends `type` alongside the value. This client
    // never advertises the capability that lets an agent offer one, so this
    // only fires for a non-compliant agent -- kept correct rather than
    // unreachable-by-assumption.
    if (option.type === 'boolean') params.type = 'boolean';

    const result = (await this.transport.request('session/set_config_option', params)) as { configOptions?: unknown };
    const next = parseConfigOptions(result?.configOptions);
    // Only replace on a well-formed full state. An agent that answers with
    // something unparseable leaves the last known-good state in place --
    // preferable to blanking it, since this is what callers read to decide
    // whether the agent asks permission at all.
    if (next) this.configOptions = next;
  }

  /** #17.1; see the AcpSession interface for why both refusals are local. */
  async setMode(modeId: string): Promise<void> {
    if (!this.modes) {
      throw new Error(
        `setMode: the agent reported no modes for this session, so session/set_mode does not apply (acp-protocol.md #17.1)`,
      );
    }
    if (!this.modes.availableModes.some((m) => m.id === modeId)) {
      const known = this.modes.availableModes.map((m) => m.id).join(', ') || '<none>';
      throw new Error(`setMode: "${modeId}" is not one of the modes this agent advertised (${known}) (acp-protocol.md #17.1)`);
    }
    await this.transport.request('session/set_mode', { sessionId: this.sessionId, modeId });
    // The agent normally confirms with a current_mode_update too, but #17.1
    // does not require it -- the empty result is the acknowledgement, so
    // don't leave the tracked mode stale waiting for a notification that
    // may never come. A later notification simply re-sets the same value.
    this.currentModeId = modeId;
  }

  prompt(input: PromptInput): AsyncGenerator<SessionUpdate, PromptTurnResult, void> {
    if (this.activeTurn) {
      throw new Error(`session ${this.sessionId} already has a prompt turn in flight`);
    }
    const blocks = normalizePromptInput(input);
    assertPromptBlocksAllowed(blocks, this.promptCapabilities);

    // Eager, synchronous send -- see file header, point 1. Everything from
    // here down to `return this.drainTurn(turn)` runs before prompt()
    // returns to the caller; only the *draining* is lazy.
    const turn = new TurnState();
    this.activeTurn = turn;
    (this.transport.request('session/prompt', { sessionId: this.sessionId, prompt: blocks }) as Promise<PromptTurnResult>).then(
      (result) => turn.settle({ ok: true, result }),
      (err: unknown) => turn.settle({ ok: false, error: toError(err) }),
    );

    return this.drainTurn(turn);
  }

  private async *drainTurn(turn: TurnState): AsyncGenerator<SessionUpdate, PromptTurnResult, void> {
    try {
      for (;;) {
        const step = await turn.next();
        if (step.kind === 'update') {
          yield step.update;
          continue;
        }
        if (!step.outcome.ok) throw step.outcome.error;
        return step.outcome.result;
      }
    } finally {
      if (this.activeTurn === turn) this.activeTurn = undefined;
    }
  }

  async steer(input: PromptInput): Promise<'injected' | 'promptRequired'> {
    if (!this.steering) throw new Error(`session ${this.sessionId}: the agent did not advertise _session/steering`);
    const blocks = normalizePromptInput(input);
    assertPromptBlocksAllowed(blocks, this.promptCapabilities);
    const result = (await this.transport.request('_session/steering', {
      sessionId: this.sessionId,
      prompt: blocks,
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    })) as { outcome?: unknown };
    if (result?.outcome === 'injected' || result?.outcome === 'promptRequired') return result.outcome;
    throw new Error(`_session/steering: unexpected outcome ${JSON.stringify(result?.outcome)}`);
  }

  cancel(): void {
    if (!this.activeTurn) return;
    this.transport.notify('session/cancel', { sessionId: this.sessionId });
    // #14.1, unconditionally the client's own obligation -- see file header
    // point 3. Snapshot to an array first: cancel() below mutates
    // pendingPermissions (each entry deletes itself once answered), and
    // iterating a Map while deleting the in-progress entry is well-defined
    // but not worth relying on here.
    for (const pending of [...this.pendingPermissions.values()]) pending.cancel();
  }

  /**
   * Called by connect()'s central `session/update` router. Routed by
   * priority: an in-flight turn's queue always wins (matches every existing
   * turn-draining behavior exactly as before); failing that, a registered
   * onUpdate() listener; failing that, buffered for whenever one is
   * eventually registered (file header, point 5) -- never silently dropped.
   */
  handleUpdate(update: SessionUpdate): void {
    // Tracked before routing, so the mode stays correct regardless of which
    // of the three destinations below this update takes -- a
    // current_mode_update is exactly the kind that arrives out of turn.
    if (update.sessionUpdate === 'config_option_update') {
      // Full replacement, never a merge (#8, #17.2).
      const next = parseConfigOptions(update.configOptions);
      if (next) this.configOptions = next;
    }
    if (update.sessionUpdate === 'current_mode_update') {
      // Either spelling: the spec names this field two ways and neither is
      // marked as the error. See CurrentModeUpdate in protocol.ts.
      const next = update.currentModeId ?? update.modeId;
      if (typeof next === 'string' && next.length > 0) this.currentModeId = next;
    }
    if (this.activeTurn) {
      this.activeTurn.pushUpdate(update);
      return;
    }
    if (this.updateListener) {
      this.updateListener(update);
      return;
    }
    this.outOfTurnUpdates.push(update);
  }

  onUpdate(listener: (update: SessionUpdate) => void): void {
    this.updateListener = listener;
    if (this.outOfTurnUpdates.length === 0) return;
    const queued = this.outOfTurnUpdates.splice(0);
    for (const update of queued) listener(update);
  }

  /**
   * Answers one agent-initiated `session/request_permission`. Registers a
   * cancel handle *synchronously*, before ever invoking the (possibly slow,
   * possibly never-resolving) policy callback, so cancel() can always find
   * and answer it immediately regardless of what that callback is doing.
   * `respondOnce` guards against answering the same request twice, whether
   * cancel() wins the race or the policy callback eventually does.
   */
  handlePermissionRequest(params: RequestPermissionParams, id: RequestId, handler: PermissionRequestHandler): void {
    let settled = false;
    const respondOnce = (outcome: RequestPermissionOutcome): void => {
      if (settled) return;
      settled = true;
      this.pendingPermissions.delete(id);
      this.transport.respond(id, { outcome });
    };
    this.pendingPermissions.set(id, { cancel: () => respondOnce({ outcome: 'cancelled' }) });

    Promise.resolve()
      .then(() => handler(params))
      .then(respondOnce)
      .catch((err: unknown) => {
        if (settled) return;
        settled = true;
        this.pendingPermissions.delete(id);
        this.transport.respondError(id, { code: -32603, message: `onPermissionRequest threw: ${toError(err).message}` });
      });
  }
}

// ---- client -------------------------------------------------------------

interface NormalizedInitInfo {
  protocolVersion: ProtocolVersion;
  authMethods: readonly AuthMethod[];
  agentInfo: Implementation | undefined;
  agentCapabilities: AgentCapabilities;
  steering: boolean;
}

/**
 * The connection's own launch configuration, retained solely so
 * terminalAuthLaunch() can satisfy #5.3's "the Client derives the command
 * from its own Agent configuration". Mirrors what transport.ts actually
 * spawned, env merge included, so a relaunch reproduces this connection.
 */
interface BaseLaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string | undefined;
}

class AcpClientImpl implements AcpClient {
  readonly protocolVersion: ProtocolVersion;
  readonly authMethods: readonly AuthMethod[];
  readonly agentInfo: Implementation | undefined;
  readonly agentCapabilities: AgentCapabilities;
  readonly steering: boolean;
  private readonly transport: AcpTransport;
  private readonly sessions: Map<SessionId, AcpSessionImpl>;
  private readonly pendingSessionUpdates: Map<SessionId, SessionUpdate[]>;
  private readonly launch: BaseLaunchConfig;

  constructor(
    transport: AcpTransport,
    sessions: Map<SessionId, AcpSessionImpl>,
    pendingSessionUpdates: Map<SessionId, SessionUpdate[]>,
    init: NormalizedInitInfo,
    launch: BaseLaunchConfig,
  ) {
    this.transport = transport;
    this.sessions = sessions;
    this.pendingSessionUpdates = pendingSessionUpdates;
    this.launch = launch;
    this.protocolVersion = init.protocolVersion;
    this.authMethods = init.authMethods;
    this.agentInfo = init.agentInfo;
    this.agentCapabilities = init.agentCapabilities;
    this.steering = init.steering;
  }

  /** #5.2; see the AcpClient interface for why both refusals are local. */
  async authenticate(methodId: string, meta?: Record<string, unknown>): Promise<void> {
    const method = this.authMethods.find((m) => m.id === methodId);
    if (!method) {
      const known = this.authMethods.map((m) => m.id).join(', ') || '<none>';
      throw new Error(
        `authenticate: the agent did not advertise an auth method with id "${methodId}" (advertised: ${known}) (acp-protocol.md #5.1)`,
      );
    }
    if (method.type === 'terminal') {
      throw new Error(
        `authenticate: "${methodId}" is a terminal-type auth method; acp-protocol.md #5.3 says the Client MUST NOT send an authenticate request for it -- use terminalAuthLaunch("${methodId}") and run that flow instead`,
      );
    }
    // #5.2's success result is an empty object carrying nothing to read.
    // `_meta` (#3) carries what a method asked the client for, such as a key.
    await this.transport.request('authenticate', meta ? { methodId, _meta: meta } : { methodId });
  }

  /** #5.4. */
  async logout(): Promise<void> {
    if (!this.agentCapabilities.auth.logout) {
      throw new Error(
        'logout: the agent did not advertise agentCapabilities.auth.logout at initialize (acp-protocol.md #5.4 says to call it only if it did)',
      );
    }
    // Empty object, not omitted: #5.4 shows `"params": {}` on the wire.
    await this.transport.request('logout', {});
  }

  /** #5.3 steps 1-2 only -- a description, never a launch. */
  terminalAuthLaunch(methodId: string): TerminalAuthLaunch {
    const method = this.authMethods.find((m) => m.id === methodId);
    if (!method) {
      throw new Error(`terminalAuthLaunch: no auth method with id "${methodId}" was advertised (acp-protocol.md #5.1)`);
    }
    if (method.type !== 'terminal') {
      throw new Error(
        `terminalAuthLaunch: "${methodId}" is an agent-type auth method, which has no terminal launch configuration -- call authenticate("${methodId}") instead (acp-protocol.md #5.2)`,
      );
    }
    return {
      command: this.launch.command,
      // "Appends the method's args" (#5.3 step 2) -- appended to the base
      // args, never substituted for them, or the relaunch would lose
      // whatever selects the agent program in the first place.
      args: [...this.launch.args, ...(method.args ?? [])],
      env: { ...this.launch.env, ...(method.env ?? {}) },
      cwd: this.launch.cwd,
    };
  }

  async newSession(params: NewSessionParams): Promise<AcpSession> {
    if (params.additionalDirectories && !this.agentCapabilities.sessionCapabilities.additionalDirectories) {
      throw new Error('newSession: additionalDirectories was set but the agent did not advertise sessionCapabilities.additionalDirectories (acp-protocol.md #6.7)');
    }
    const wireParams: { cwd: string; mcpServers: McpServer[]; additionalDirectories?: string[] } = {
      cwd: params.cwd,
      // Required on the wire, never omitted, even when the caller left it
      // out (#6.1; framing.test.ts asserts this exact default).
      mcpServers: params.mcpServers ?? [],
    };
    if (params.additionalDirectories) wireParams.additionalDirectories = params.additionalDirectories;

    const result = (await this.transport.request('session/new', wireParams)) as { sessionId?: unknown };
    const sessionId = result?.sessionId;
    // #6.1's result is `{sessionId: string}`; an agent that omits it, or
    // names the field differently, must fail loudly here rather than hand
    // back a session whose id is `undefined` -- that value would otherwise
    // poison `sessions` (keyed by it) and go out on every subsequent
    // session/prompt as a *missing* `sessionId` property on the wire
    // (JSON.stringify drops an undefined value silently), which is worse
    // than a thrown error: it looks like a malformed request from a
    // perfectly healthy client.
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(`session/new: expected a non-empty string "sessionId" in the result, got ${JSON.stringify(sessionId)} (acp-protocol.md #6.1)`);
    }
    const session = new AcpSessionImpl(
      sessionId,
      this.transport,
      this.agentCapabilities.promptCapabilities,
      parseModeState((result as { modes?: unknown }).modes),
      parseConfigOptions((result as { configOptions?: unknown }).configOptions),
      this.steering,
    );
    this.sessions.set(sessionId, session);
    // Flush anything that arrived for this exact sessionId before this
    // `await` returned -- see file header, point 5.
    const queued = this.pendingSessionUpdates.get(sessionId);
    if (queued) {
      this.pendingSessionUpdates.delete(sessionId);
      for (const update of queued) session.handleUpdate(update);
    }
    return session;
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}
