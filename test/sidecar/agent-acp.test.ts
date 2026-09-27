// agent-protocol.md §2 (sessions), §3 (the reverse direction) and §5 bullet 3
// for ACP providers, driven over the built sidecar with the hand-laid mock
// provider from agent-helpers.ts. Written from the spec by a context that
// has not seen src/sidecar/agent*.ts, src/agents/ or src/agent/. Login and
// auth status live in agent-login.test.ts.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { SCENARIOS, UPDATE_KINDS_SEQUENCE } from '../acp/scenarios.ts';
import {
  agentPid, agentReceived, agentSessionIds, answerError, answerRequest, connectMock, expectError, isNotification,
  layoutMockProvider, MOCK_PROVIDER_ID, mockFiles, notificationParams, pidIsAlive, primeRegistry, readMockLog, shimArgvs, updatesFor, waitForExit, waitForLine,
  type ConnectSession,
} from './agent-helpers.ts';
import { TIMEOUT, isJsonRpcLine, spawnSidecar, sweepSidecars, type Sidecar } from './helpers.ts';

after(sweepSidecars);

/** mock-agent.ts's MODE_STATE ids, in its order. */
const MODE_IDS = ['default', 'auto', 'plan'];

async function sidecarWithMock(): Promise<{ s: Sidecar; dataDir: string }> {
  const { dataDir } = layoutMockProvider();
  const s = spawnSidecar();
  await s.ready;
  await primeRegistry(s, dataDir);
  return { s, dataDir };
}
const text = (t: string) => [{ type: 'text', text: t }];
const sessionOf = (session: ConnectSession | null): ConnectSession => {
  assert.ok(session, 'session must be non-null');
  return session;
};

test('agent/connect (ACP): §2 response shape, auth.terminal advertised, no set_mode when the agent reports no modes', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const { result, files } = await connectMock(s, dataDir, SCENARIOS.HAPPY_PATH, { cwd: dataDir, extraArgs: ['--extra-flag'] });
  assert.equal(typeof result.connectionId, 'string');
  assert.ok(result.connectionId.length > 0);
  assert.equal(result.provider, 'mock');
  assert.equal(result.kind, 'acp');
  assert.deepEqual(result.agent, { name: 'acp-mock-agent', version: '0.0.0-test' });
  assert.equal(result.authStatus, null, 'no _auth/status_update was ever sent');
  assert.deepEqual(result.authMethods, []);
  assert.equal(result.authRequired, false);
  const session = sessionOf(result.session);
  const { sessionId, ...rest } = session;
  assert.equal(typeof sessionId, 'string');
  assert.deepEqual(rest, { modes: null, configOptions: null, commands: [] });

  const frames = agentReceived(files.logFile);
  assert.equal(frames[0]?.method, 'initialize');
  const caps = frames[0].params?.clientCapabilities as { auth?: { terminal?: unknown } };
  assert.equal(caps?.auth?.terminal, true, '§2: spawned with clientCapabilities: { auth: { terminal: true } }');
  assert.equal(frames[1]?.method, 'session/new');
  assert.equal(frames[1].params?.cwd, dataDir, 'newSession({ cwd }) carries the course folder');
  assert.equal(frames.filter((f) => f.method === 'session/set_mode').length, 0, 'no modes reported -> no set_mode');
  assert.deepEqual(shimArgvs(files.argvFile), [['--extra-flag']], 'spawned as node <bin> <registry args> <extraArgs> (registry args: [])');

  const status = await s.request('st', 'agent/status', { connectionId: result.connectionId });
  assert.deepEqual(status.result, { connectionId: result.connectionId, provider: 'mock', kind: 'acp', authStatus: null, authMethods: [], sessions: [sessionId] });
  assert.equal(await s.end(), 0);
});

test('agent/connect pins setMode("default") when modes exist, and reports modes/configOptions (§2)', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const modes = await connectMock(s, dataDir, SCENARIOS.SESSION_MODES);
  const session = sessionOf(modes.result.session);
  assert.deepEqual(session.modes?.availableModes.map((m) => m.id), MODE_IDS);
  assert.equal(session.modes?.currentModeId, 'default', 'the pinned mode is what the app is told, not the agent\'s pre-pin "auto"');
  const frames = agentReceived(modes.files.logFile).map((f) => f.method);
  assert.deepEqual(frames.slice(0, 3), ['initialize', 'session/new', 'session/set_mode'], 'set_mode follows session/new');
  const setMode = agentReceived(modes.files.logFile).find((f) => f.method === 'session/set_mode');
  assert.deepEqual(setMode?.params, { sessionId: agentSessionIds(modes.files.logFile)[0], modeId: 'default' });

  const cfg = await connectMock(s, dataDir, SCENARIOS.CONFIG_OPTIONS);
  const cfgSession = sessionOf(cfg.result.session);
  assert.deepEqual(cfgSession.configOptions?.map((o) => o.id), ['mode', 'model']);
  assert.ok(cfgSession.modes, 'modes are reported alongside configOptions when the agent sends both');
  assert.ok(agentReceived(cfg.files.logFile).some((f) => f.method === 'session/set_mode'));
  assert.notEqual(cfg.result.connectionId, modes.result.connectionId);
  assert.equal(await s.end(), 0);
});

test('agent/connect validation: missing fields -> -32602 naming the field; not installed -> -32000', { timeout: TIMEOUT }, async () => {
  const { dataDir } = layoutMockProvider({ installed: false });
  const s = spawnSidecar();
  await s.ready;
  await primeRegistry(s, dataDir, false);
  assert.match(expectError(await s.request(1, 'agent/connect', { provider: 'mock', cwd: dataDir }), -32602, 'no dataDir').message, /dataDir/);
  assert.match(expectError(await s.request(2, 'agent/connect', { provider: 'mock', dataDir }), -32602, 'no cwd').message, /\bcwd\b/);
  assert.match(expectError(await s.request(3, 'agent/connect', { dataDir, cwd: dataDir }), -32602, 'no provider').message, /provider/);
  assert.match(expectError(await s.request(4, 'agent/connect', { provider: 'mock', dataDir, cwd: dataDir }), -32000, 'not installed').message, /not installed/i);
  expectError(await s.request(5, 'agent/status', { connectionId: 'no-such-connection' }), -32602, 'unknown connectionId');
  expectError(await s.request(6, 'agent/prompt', { sessionId: 'no-such-session', blocks: text('x') }), -32602, 'unknown sessionId');
  assert.equal(s.child.exitCode, null, 'the process survives every one of these');
  assert.equal(await s.end(), 0);
});

test('authRequired: session/new failing with auth_required keeps the connection open, with authMethods (§2)', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  for (const scenario of [SCENARIOS.AUTH_REQUIRED_SESSION, SCENARIOS.AUTH_AGENT] as const) {
    const { result, files } = await connectMock(s, dataDir, scenario);
    assert.equal(result.session, null, `${scenario}: session is null`);
    assert.equal(result.authRequired, true, `${scenario}: authRequired`);
    assert.equal(result.authMethods[0]?.id, 'agent-login', `${scenario}: authMethods from initialize`);
    assert.equal(result.authMethods[0]?.name, 'Agent login');
    const status = await s.request(`st-${scenario}`, 'agent/status', { connectionId: result.connectionId });
    assert.deepEqual((status.result as { sessions: unknown }).sessions, [], `${scenario}: connection still listed, with no sessions`);
    assert.ok(pidIsAlive(agentPid(files.pidFile)), `${scenario}: the agent process is kept for agent/login`);
    // agent-type login on the kept connection: authenticate goes to the agent and lifts the gate
    const login = await s.request(`login-${scenario}`, 'agent/login', { connectionId: result.connectionId, methodId: 'agent-login' });
    assert.equal(login.error, undefined, JSON.stringify(login.error));
    const r = login.result as { methodId: string; exitCode: unknown; authenticated: boolean; session?: ConnectSession | null };
    assert.equal(r.methodId, 'agent-login');
    assert.equal(r.exitCode, null, 'agent-type: exitCode null');
    assert.equal(r.authenticated, true);
    assert.deepEqual(agentReceived(files.logFile).find((f) => f.method === 'authenticate')?.params, { methodId: 'agent-login' });
    // Signed in, the session the connect could not open is opened: without it the
    // app had a sign-in that worked and said it had failed (codex, cline, copilot).
    assert.equal(typeof r.session?.sessionId, 'string', `${scenario}: a session once signed in`);
  }
  assert.equal(await s.end(), 0);
});

test('where the agent takes steering, a prompt mid-turn goes into the running turn; after Stop the next prompt says so (§2)', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const { result, files } = await connectMock(s, dataDir, SCENARIOS.STEER_HANG);
  const sid = sessionOf(result.session).sessionId;
  const sent = () => agentReceived(files.logFile);
  const texts = () => updatesFor(s, sid).map((u) => (u.content as { text: string }).text);

  const first = s.request('s1', 'agent/prompt', { sessionId: sid, blocks: text('go') });
  await waitForLine(s, (m) => isNotification(m, 'agent/update') && (m.params as { sessionId: string }).sessionId === sid, 'first update of the running turn');
  let settled = false;
  const steered = s.request('s2', 'agent/prompt', { sessionId: sid, blocks: text('the slides miss some competencies') }).then((r) => ((settled = true), r));
  await waitForLine(s, () => texts().includes('steered: the slides miss some competencies'), 'the steered message reaches the running turn');
  assert.equal(sent().filter((f) => f.method === 'session/prompt').length, 1, 'no second turn: it went into the first');
  assert.equal(sent().filter((f) => f.method === '_session/steering').length, 1);
  assert.equal(settled, false, 'a steered prompt answers when the turn it joined ends');
  // agent/delivery is sent once the agent has acknowledged the steer, which
  // can come after the agent's own echo of it: wait for it, do not race it.
  await waitForLine(s, (m) => isNotification(m, 'agent/delivery'), 'the app is told where it went');
  assert.deepEqual(notificationParams(s, 'agent/delivery'), [{ sessionId: sid, steered: true }], 'the app is told where it went');

  assert.deepEqual((await s.request('c1', 'agent/cancel', { sessionId: sid })).result, {});
  assert.deepEqual((await first).result, { stopReason: 'cancelled' });
  assert.deepEqual((await steered).result, { stopReason: 'cancelled', steered: true }, "the turn's own end, marked steered");

  // The next prompt after Stop tells the agent, ahead of the person's words.
  const after = s.request('s3', 'agent/prompt', { sessionId: sid, blocks: text('work?') });
  await waitForLine(s, () => sent().filter((f) => f.method === 'session/prompt').length === 2 && texts().filter((t) => t === 'Starting work...').length === 2, 'the next turn starts');
  const [note, ...rest] = (sent().filter((f) => f.method === 'session/prompt')[1]!.params as { prompt: Array<{ type: string; text: string }> }).prompt;
  assert.match(note!.text, /pressed Stop.*Do not resume/s);
  assert.deepEqual(rest, text('work?'));
  assert.deepEqual((await s.request('c2', 'agent/cancel', { sessionId: sid })).result, {});
  assert.deepEqual((await after).result, { stopReason: 'cancelled' });
  assert.equal(await s.end(), 0);
});

test('agent/prompt relays every update kind as agent/update in order; a second prompt mid-turn is held and runs next (§2)', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const { result, files } = await connectMock(s, dataDir, SCENARIOS.UPDATE_KINDS);
  const { sessionId } = sessionOf(result.session);
  const blocks = [...text('Review the deck'), { type: 'resource_link', uri: `file://${dataDir}/deck.json`, name: 'deck.json', mimeType: 'application/json' }];
  const res = await s.request('p1', 'agent/prompt', { sessionId, blocks });
  assert.deepEqual(res, { jsonrpc: '2.0', id: 'p1', result: { stopReason: 'end_turn' } });
  assert.deepEqual(updatesFor(s, sessionId), UPDATE_KINDS_SEQUENCE, 'ACP\'s exact shapes, one each, in wire order');
  for (const p of notificationParams(s, 'agent/update')) assert.deepEqual(Object.keys(p).sort(), ['sessionId', 'update']);
  const prompt = agentReceived(files.logFile).find((f) => f.method === 'session/prompt');
  assert.deepEqual(prompt?.params, { sessionId: agentSessionIds(files.logFile)[0], prompt: blocks }, 'blocks pass through as the ACP prompt');

  // one turn at a time, on a turn that only ends on cancel: a second prompt
  // is held until the first ends, then reaches the agent -- never refused
  const hang = await connectMock(s, dataDir, SCENARIOS.CANCEL_HANG);
  const hangSid = sessionOf(hang.result.session).sessionId;
  const turnsOf = () => notificationParams(s, 'agent/turn').filter((p) => p.sessionId === hangSid).map((p) => p.running);
  const first = s.request('h1', 'agent/prompt', { sessionId: hangSid, blocks: text('go') });
  await waitForLine(s, (m) => isNotification(m, 'agent/update') && (m.params as { sessionId: string }).sessionId === hangSid, 'first update of the hanging turn');
  const second = s.request('h2', 'agent/prompt', { sessionId: hangSid, blocks: text('again') });
  const prompts = () => agentReceived(hang.files.logFile).filter((f) => f.method === 'session/prompt');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(prompts().length, 1, 'the second prompt waits while the first turn runs');
  assert.deepEqual(turnsOf(), [true]);
  assert.deepEqual(notificationParams(s, 'agent/delivery').filter((p) => p.sessionId === hangSid), [{ sessionId: hangSid, steered: false }], 'the app is told it is held');
  assert.deepEqual((await s.request('c1', 'agent/cancel', { sessionId: hangSid })).result, {});
  assert.deepEqual((await first).result, { stopReason: 'cancelled' }, 'the in-flight prompt resolves cancelled');
  assert.ok(agentReceived(hang.files.logFile).some((f) => f.method === 'session/cancel' && f.params?.sessionId === agentSessionIds(hang.files.logFile)[0]), 'session/cancel reached the agent');
  await waitForLine(s, (m) => isNotification(m, 'agent/update') && (m.params as { sessionId: string }).sessionId === hangSid && updatesFor(s, hangSid).length === 3, 'the held turn\'s first update');
  assert.equal(prompts().length, 2, 'the held prompt reached the agent once the first turn ended');
  const [note, ...held] = (prompts()[1]!.params as { prompt: Array<{ type: string; text: string }> }).prompt;
  assert.match(note!.text, /pressed Stop/, 'the agent is told Stop ended its last turn');
  assert.deepEqual(held, text('again'), 'the held message, as sent');
  assert.deepEqual((await s.request('c1b', 'agent/cancel', { sessionId: hangSid })).result, {});
  assert.deepEqual((await second).result, { stopReason: 'cancelled' });
  assert.deepEqual(turnsOf(), [true, false, true, false], 'agent/turn brackets each turn');
  assert.deepEqual(updatesFor(s, hangSid).map((u) => (u.content as { text: string }).text), ['Starting work...', 'Cleaning up...', 'Starting work...', 'Cleaning up...'], 'updates sent after cancel are still relayed');
  assert.deepEqual((await s.request('c2', 'agent/cancel', { sessionId: hangSid })).result, {}, 'cancel with no turn in flight is a harmless {}');
  assert.ok(s.lines.every(isJsonRpcLine), 'stdout carries only JSON-RPC lines');
  assert.equal(await s.end(), 0);
});

async function permissionRoundTrip(answer: (s: Sidecar, id: number) => Promise<void>) {
  const { s, dataDir } = await sidecarWithMock();
  const { result, files } = await connectMock(s, dataDir, SCENARIOS.TOOL_PERMISSION);
  const { sessionId } = sessionOf(result.session);
  const prompt = s.request('p1', 'agent/prompt', { sessionId, blocks: text('edit the config') });
  const { msg } = await waitForLine(s, (m) => m.method === 'agent/requestPermission', 'agent/requestPermission');
  assert.equal(typeof msg.id, 'number', '§3: reverse-request ids are numbers');
  assert.equal(msg.jsonrpc, '2.0');
  const sent = readMockLog(files.logFile, 'send').find((f) => f.method === 'session/request_permission');
  assert.ok(sent?.params, 'sanity: the agent sent session/request_permission');
  assert.deepEqual(msg.params, { sessionId, toolCall: sent.params.toolCall, options: sent.params.options }, 'the agent\'s toolCall/options verbatim, under the app\'s sessionId');
  await answer(s, msg.id as number);
  const res = await prompt;
  const reply = agentReceived(files.logFile).find((f) => f.id === sent.id);
  assert.ok(reply, 'the agent received a response to its permission request');
  return { s, res, reply, statuses: updatesFor(s, sessionId).filter((u) => u.toolCallId).map((u) => u.status) };
}

test('agent/requestPermission: a selected option reaches the agent exactly as answered (§3)', { timeout: TIMEOUT }, async () => {
  const { s, res, reply, statuses } = await permissionRoundTrip((s, id) => answerRequest(s, id, { outcome: { outcome: 'selected', optionId: 'allow-once' } }));
  assert.deepEqual(reply.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
  assert.deepEqual(res.result, { stopReason: 'end_turn' });
  assert.deepEqual(statuses, ['pending', 'in_progress', 'completed']);
  assert.equal(await s.end(), 0);
});

test('agent/requestPermission: a cancelled outcome is relayed as cancelled (§3)', { timeout: TIMEOUT }, async () => {
  const { s, res, reply, statuses } = await permissionRoundTrip((s, id) => answerRequest(s, id, { outcome: { outcome: 'cancelled' } }));
  assert.deepEqual(reply.result, { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(res.result, { stopReason: 'cancelled' });
  assert.deepEqual(statuses, ['pending', 'failed']);
  assert.equal(await s.end(), 0);
});

test('agent/requestPermission: an error response from the app denies -- the agent sees the cancelled outcome (§3)', { timeout: TIMEOUT }, async () => {
  const { s, res, reply } = await permissionRoundTrip((s, id) => answerError(s, id, { code: -32000, message: 'the app declined to answer' }));
  assert.equal(reply.error, undefined, 'a denial is an ACP outcome, not an error relayed to the agent');
  assert.deepEqual(reply.result, { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(res.result, { stopReason: 'cancelled' });
  assert.equal(await s.end(), 0);
});

test('agent/setMode and agent/setConfigOption pass through with §2 shapes; unknown ids are -32602', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const modes = await connectMock(s, dataDir, SCENARIOS.SESSION_MODES);
  const sid = sessionOf(modes.result.session).sessionId;
  const set = await s.request('m1', 'agent/setMode', { sessionId: sid, modeId: 'plan' });
  assert.equal(set.error, undefined, JSON.stringify(set.error));
  const state = (set.result as { modes: { currentModeId: string; availableModes: Array<{ id: string }> } }).modes;
  assert.equal(state.currentModeId, 'plan');
  assert.deepEqual(state.availableModes.map((m) => m.id), MODE_IDS);
  assert.deepEqual(Object.keys(set.result as object), ['modes']);
  const sent = agentReceived(modes.files.logFile).filter((f) => f.method === 'session/set_mode').map((f) => f.params);
  assert.deepEqual(sent, [{ sessionId: agentSessionIds(modes.files.logFile)[0], modeId: 'default' }, { sessionId: agentSessionIds(modes.files.logFile)[0], modeId: 'plan' }]);
  expectError(await s.request('m2', 'agent/setMode', { sessionId: sid, modeId: 'no-such-mode' }), -32602, 'unknown modeId');
  expectError(await s.request('m3', 'agent/setMode', { sessionId: sid }), -32602, 'missing modeId');
  expectError(await s.request('m4', 'agent/setConfigOption', { sessionId: sid, id: 'model', value: 'opus' }), -32602, 'the agent reported no configOptions');

  const cfg = await connectMock(s, dataDir, SCENARIOS.CONFIG_OPTIONS);
  const csid = sessionOf(cfg.result.session).sessionId;
  const opt = await s.request('o1', 'agent/setConfigOption', { sessionId: csid, id: 'mode', value: 'plan' });
  assert.equal(opt.error, undefined, JSON.stringify(opt.error));
  const options = (opt.result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions;
  assert.deepEqual(Object.keys(opt.result as object), ['configOptions']);
  assert.equal(options.find((o) => o.id === 'mode')?.currentValue, 'plan');
  assert.equal(options.find((o) => o.id === 'model')?.currentValue, 'opus', 'the full state comes back, dependent change included (#17.2)');
  const cfgSent = agentReceived(cfg.files.logFile).find((f) => f.method === 'session/set_config_option');
  assert.deepEqual(cfgSent?.params, { sessionId: agentSessionIds(cfg.files.logFile)[0], configId: 'mode', value: 'plan' });
  expectError(await s.request('o2', 'agent/setConfigOption', { sessionId: csid, id: 'nope', value: 'x' }), -32602, 'unknown config id');
  expectError(await s.request('o3', 'agent/setConfigOption', { sessionId: csid, id: 'model', value: 'haiku' }), -32602, 'value not offered');
  assert.equal(await s.end(), 0);
});

test('two connections to one provider are isolated; disconnect reaps its child; shutdown reaps the rest (§2, §5)', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const a = await connectMock(s, dataDir, SCENARIOS.HAPPY_PATH);
  const b = await connectMock(s, dataDir, SCENARIOS.HAPPY_PATH);
  const sidA = sessionOf(a.result.session).sessionId;
  const sidB = sessionOf(b.result.session).sessionId;
  assert.notEqual(a.result.connectionId, b.result.connectionId);
  assert.notEqual(sidA, sidB, 'the mock issues the same agent id in every process; the sidecar\'s ids must still differ');
  const [ra, rb] = await Promise.all([
    s.request('pa', 'agent/prompt', { sessionId: sidA, blocks: text('alpha') }),
    s.request('pb', 'agent/prompt', { sessionId: sidB, blocks: text('beta') }),
  ]);
  assert.deepEqual(ra.result, { stopReason: 'end_turn' });
  assert.deepEqual(rb.result, { stopReason: 'end_turn' });
  const textOf = (u: Record<string, unknown>) => (u.content as { text?: string } | undefined)?.text;
  assert.deepEqual(updatesFor(s, sidA).map(textOf).filter(Boolean), ['Echo turn 1: alpha']);
  assert.deepEqual(updatesFor(s, sidB).map(textOf).filter(Boolean), ['Echo turn 1: beta']);
  assert.equal(agentReceived(a.files.logFile).filter((f) => f.method === 'session/prompt').length, 1, 'connection A saw only its own prompt');
  assert.deepEqual(((await s.request('sa', 'agent/status', { connectionId: a.result.connectionId })).result as { sessions: string[] }).sessions, [sidA]);
  assert.deepEqual(((await s.request('sb', 'agent/status', { connectionId: b.result.connectionId })).result as { sessions: string[] }).sessions, [sidB]);

  const pidA = agentPid(a.files.pidFile);
  const pidB = agentPid(b.files.pidFile);
  assert.notEqual(pidA, pidB);
  assert.deepEqual((await s.request('da', 'agent/disconnect', { connectionId: a.result.connectionId })).result, {});
  assert.ok(await waitForExit(pidA), `agent A (pid ${pidA}) must be reaped by agent/disconnect`);
  assert.ok(pidIsAlive(pidB), 'agent B is untouched');
  expectError(await s.request('sa3', 'agent/status', { connectionId: a.result.connectionId }), -32602, 'a disconnected connection is gone');
  expectError(await s.request('pa2', 'agent/prompt', { sessionId: sidA, blocks: text('x') }), -32602, 'its sessions are gone too');
  assert.deepEqual((await s.request('shutdown', 'sidecar/shutdown')).result, {});
  assert.equal(await s.exit, 0);
  assert.ok(await waitForExit(pidB), `agent B (pid ${pidB}) must be reaped by sidecar/shutdown`);
  assert.ok(s.lines.every(isJsonRpcLine), `non-JSON-RPC stdout line:\n${s.lines.map((l) => l.raw).join('\n')}`);
});

test('EOF on stdin reaps every agent (§2 disconnect "and EOF")', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const { files } = await connectMock(s, dataDir, SCENARIOS.HAPPY_PATH);
  const pid = agentPid(files.pidFile);
  assert.equal(await s.end(), 0);
  assert.ok(await waitForExit(pid), `agent pid ${pid} must not outlive the sidecar`);
});

test('agent/connect to an agent whose modes have no "default" succeeds, and pins nothing (§2)', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const { result, files } = await connectMock(s, dataDir, SCENARIOS.MODES_NO_DEFAULT);
  assert.equal(sessionOf(result.session).modes?.currentModeId, 'suggest', "the agent's own mode stands");
  assert.equal(agentReceived(files.logFile).filter((f) => f.method === 'session/set_mode').length, 0, 'no set_mode for a mode the agent does not offer');
  assert.equal(await s.end(), 0);
});

test('a connect that fails after the agent started does not leave the agent running (§2)', { timeout: TIMEOUT }, async () => {
  const { s, dataDir } = await sidecarWithMock();
  const files = mockFiles(SCENARIOS.SESSION_NEW_FAILS);
  const res = await s.request('connect-fails', 'agent/connect', { provider: MOCK_PROVIDER_ID, dataDir, cwd: dataDir, env: files.env });
  assert.ok(res.error, 'the connect fails');
  assert.match(res.error.message, /workspace could not be opened/);
  const pid = agentPid(files.pidFile);
  assert.ok(await waitForExit(pid), `agent pid ${pid} is closed with the failed connect, not left for the sidecar's exit`);
  assert.equal(await s.end(), 0);
});
