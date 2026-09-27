// agent-protocol.md §5, first two bullets: `agents/list` against a local fake
// ACP registry and `agents/install` / `agents/uninstall` against a local fake
// npm registry, driving the real npm. Written from docs/research/
// agent-protocol.md §1 (+ sidecar-protocol.md §1–§3 for framing and error
// rows) by a context that has not seen src/sidecar/agent*.ts or src/agents/.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import test, { after } from 'node:test';

import {
  FAKE_PACKAGE,
  FAKE_VERSION,
  REGISTRY_ENTRIES,
  buildFakePackage,
  resolveNpmCli,
  startAcpRegistry,
  startNpmRegistry,
} from './fake-registries.ts';
import { TIMEOUT, isJsonRpcLine, makeTmpDir, spawnSidecar, sweepSidecars, type RpcMessage, type Sidecar } from './helpers.ts';

// spawnSidecar copies process.env into the child, which is the only channel
// helpers.ts offers; §1 reads APE_NPM_CLI from the sidecar's env, and npm
// reads npm_config_* from its own. The cache and userconfig point at temp
// paths so the developer's ~/.npm and ~/.npmrc are neither read nor touched.
const NPM_ISOLATION = makeTmpDir('ape-npm-isolation-');
writeFileSync(join(NPM_ISOLATION, 'npmrc'), '');
process.env.APE_NPM_CLI = resolveNpmCli();
process.env.npm_config_cache = join(NPM_ISOLATION, 'cache');
process.env.npm_config_userconfig = join(NPM_ISOLATION, 'npmrc');
process.env.npm_config_update_notifier = 'false';

const acp = await startAcpRegistry();
const npm = await startNpmRegistry(buildFakePackage());
after(async () => { sweepSidecars(); await acp.close(); await npm.close(); });

const INSTALL_TIMEOUT = 60_000;
const OPENROUTER = { id: 'openrouter', kind: 'api', name: 'OpenRouter', description: 'Any model, one API key', version: null, installed: true, installedVersion: null, distribution: null, installable: false };
const ACP_IDS = ['fake-npx', 'fake-binary', 'fake-uvx', 'fake-suffixed', 'fake-missing']; // registry order, malformed skipped

interface Provider { id: string; kind: string; name: string; description: string; version: string | null; installed: boolean; installedVersion: string | null; distribution: string | null; installable: boolean }
interface ListResult { providers: Provider[]; registry: { fetchedAt: string | null; url: string; error: string | null } }
interface Progress { id: string; stream: string; line: string }

function expectError(res: RpcMessage, code: number, label: string): { message: string; data?: unknown } {
  assert.ok(res.error, `${label}: expected an error response, got ${JSON.stringify(res)}`);
  assert.ok(!('result' in res), `${label}: an error response carries no result`);
  assert.equal(res.error.code, code, `${label}: ${res.error.message}`);
  assert.ok(res.error.message.length > 0, `${label}: message must be human-readable`);
  return res.error;
}
async function list(s: Sidecar, id: string | number, dataDir: string, extra: Record<string, unknown> = {}): Promise<ListResult> {
  const res = await s.request(id, 'agents/list', { dataDir, registryUrl: acp.url, ...extra });
  assert.ok(!res.error, `agents/list ${id}: ${JSON.stringify(res.error)}`);
  return res.result as ListResult;
}
function acpProviders(r: ListResult): Provider[] { return r.providers.filter((p) => p.kind === 'acp'); }
function progressFor(s: Sidecar, id: string): Progress[] {
  return s.lines.filter((l) => l.json?.method === 'agents/progress').map((l) => l.json!.params as Progress).filter((p) => p.id === id);
}
/** Populates <dataDir>/registry.json so agents/install (which takes no registryUrl) has entries to read. */
async function primed(s: Sidecar, dataDir: string): Promise<void> { await list(s, 'prime', dataDir); }

test('agents/list: the built-in openrouter provider is first and shaped per §1', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  const r = await list(s, 1, makeTmpDir());
  assert.deepEqual(r.providers[0], OPENROUTER);
  assert.deepEqual(r.providers.filter((p) => p.kind === 'api'), [OPENROUTER], '§1 lists exactly one built-in api provider');
  assert.equal(await s.end(), 0);
});

test('agents/list maps registry entries by distribution and skips the malformed one', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  const r = await list(s, 1, makeTmpDir());
  assert.deepEqual(acpProviders(r).map((p) => p.id), ACP_IDS);
  assert.ok(!r.providers.some((p) => p.id === REGISTRY_ENTRIES.malformed.id), 'no distribution -> skipped');
  const byId = new Map(r.providers.map((p) => [p.id, p]));
  const common = { kind: 'acp', installed: false, installedVersion: null };
  const e = REGISTRY_ENTRIES;
  assert.deepEqual(byId.get('fake-npx'), { ...common, id: e.npx.id, name: e.npx.name, description: e.npx.description, version: FAKE_VERSION, distribution: 'npx', installable: true });
  // A binary agent installs where the registry has a build for this machine (the fake has macOS and Linux x64).
  const built = ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64'].includes(`${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch}`);
  assert.deepEqual(byId.get('fake-binary'), { ...common, id: e.binary.id, name: e.binary.name, description: e.binary.description, version: e.binary.version, distribution: 'binary', installable: built });
  assert.deepEqual(byId.get('fake-uvx'), { ...common, id: e.uvx.id, name: e.uvx.name, description: e.uvx.description, version: e.uvx.version, distribution: 'uvx', installable: false });
  assert.deepEqual(byId.get('fake-suffixed'), { ...common, id: e.suffixed.id, name: e.suffixed.name, description: e.suffixed.description, version: e.suffixed.version, distribution: 'npx', installable: true });
  assert.equal(typeof r.registry.fetchedAt, 'string', 'fetchedAt after a live fetch');
  assert.equal(r.registry.url, acp.url);
  assert.equal(r.registry.error, null);
  assert.equal(await s.end(), 0);
});

test('agents/list writes <dataDir>/registry.json, serves the next call from it, and refetches on refresh: true', { timeout: TIMEOUT }, async () => {
  const dataDir = makeTmpDir();
  const cachePath = join(dataDir, 'registry.json');
  const s = spawnSidecar();
  await s.ready;
  const before = acp.requests();
  const first = await list(s, 1, dataDir);
  assert.equal(acp.requests(), before + 1, 'no cache -> one GET');
  assert.ok(existsSync(cachePath), 'cache written after the first call');
  assert.doesNotThrow(() => JSON.parse(readFileSync(cachePath, 'utf8')), 'cache is JSON');
  const second = await list(s, 2, dataDir);
  assert.equal(acp.requests(), before + 1, 'a fresh cache (< 1 h) is used without hitting the server');
  assert.deepEqual(second.providers, first.providers);
  const third = await list(s, 3, dataDir, { refresh: true });
  assert.equal(acp.requests(), before + 2, 'refresh: true re-fetches');
  assert.deepEqual(third.providers, first.providers);
  assert.equal(third.registry.error, null);
  assert.equal(await s.end(), 0);
});

test('agents/list on a 500 with a cache present: providers from the cache, registry.error is a string', { timeout: TIMEOUT }, async () => {
  const dataDir = makeTmpDir();
  const s = spawnSidecar();
  await s.ready;
  const warm = await list(s, 1, dataDir);
  acp.setMode('fail');
  try {
    const r = await list(s, 2, dataDir, { refresh: true });
    assert.deepEqual(r.providers, warm.providers, 'cached entries still listed');
    assert.equal(typeof r.registry.error, 'string');
    assert.ok(r.registry.error!.length > 0);
    assert.equal(r.registry.url, acp.url);
  } finally {
    acp.setMode('ok');
  }
  assert.equal(await s.end(), 0);
});

test('agents/list with the server down and no cache lists only the built-ins and sets registry.error', { timeout: TIMEOUT }, async () => {
  const down = await startAcpRegistry();
  await down.close(); // the URL is now a refused connection
  const s = spawnSidecar();
  await s.ready;
  const res = await s.request(1, 'agents/list', { dataDir: makeTmpDir(), registryUrl: down.url });
  assert.ok(!res.error, `a fetch failure is reported in the result, not as an RPC error: ${JSON.stringify(res.error)}`);
  const r = res.result as ListResult;
  assert.deepEqual(r.providers, [OPENROUTER]);
  assert.equal(r.registry.fetchedAt, null);
  assert.equal(r.registry.url, down.url);
  assert.equal(typeof r.registry.error, 'string');
  assert.equal(await s.end(), 0);
});

test('agents/list, agents/install and agents/uninstall validate params with -32602 naming the field (§3)', { timeout: TIMEOUT }, async () => {
  const s = spawnSidecar();
  await s.ready;
  assert.match(expectError(await s.request(1, 'agents/list', {}), -32602, 'list without dataDir').message, /\bdataDir\b/);
  assert.match(expectError(await s.request(2, 'agents/install', { dataDir: makeTmpDir() }), -32602, 'install without id').message, /\bid\b/);
  assert.match(expectError(await s.request(3, 'agents/install', { id: 'fake-npx' }), -32602, 'install without dataDir').message, /\bdataDir\b/);
  assert.match(expectError(await s.request(4, 'agents/uninstall', { dataDir: makeTmpDir() }), -32602, 'uninstall without id').message, /\bid\b/);
  // An id is a directory name under dataDir: ".." made uninstall delete dataDir itself.
  const dataDir = makeTmpDir();
  mkdirSync(join(dataDir, 'npx'), { recursive: true });
  for (const [n, id] of ['..', '../..', 'a/b', '/etc'].entries()) {
    assert.match(expectError(await s.request(10 + n, 'agents/uninstall', { dataDir, id }), -32602, `uninstall ${id}`).message, /not an agent id/);
  }
  assert.ok(existsSync(join(dataDir, 'npx')), 'nothing under dataDir was touched');
  assert.equal(await s.end(), 0);
});

test('agents/install for fake-npx: result, prefix layout, progress lines, then agents/list shows it installed', { timeout: INSTALL_TIMEOUT }, async () => {
  const dataDir = makeTmpDir();
  const s = spawnSidecar();
  await s.ready;
  await primed(s, dataDir);
  const seen = npm.requests.length;
  const res = await s.request('inst', 'agents/install', { dataDir, id: 'fake-npx', npm: { registry: npm.url } });
  assert.ok(!res.error, `install failed: ${JSON.stringify(res.error)}\nstderr:\n${s.stderr()}`);
  const r = res.result as { id: string; package: string; version: string; bin: string };
  assert.deepEqual({ id: r.id, package: r.package, version: r.version }, { id: 'fake-npx', package: FAKE_PACKAGE, version: FAKE_VERSION });
  const prefix = join(dataDir, 'npx', 'fake-npx');
  assert.ok(isAbsolute(r.bin), `bin is absolute: ${r.bin}`);
  assert.ok(r.bin.endsWith(join('node_modules', FAKE_PACKAGE, 'index.js')), `bin resolves the package's bin entry: ${r.bin}`);
  assert.ok(r.bin.startsWith(prefix + '/'), `bin lives under the id's prefix: ${r.bin}`);
  assert.ok(existsSync(r.bin));
  const installedPkg = JSON.parse(readFileSync(join(prefix, 'node_modules', FAKE_PACKAGE, 'package.json'), 'utf8')) as { version: string };
  assert.equal(installedPkg.version, FAKE_VERSION, 'the registry version was pinned');
  assert.deepEqual(npm.requests.slice(seen), ['GET /fake-agent', `GET /fake-agent/-/fake-agent-${FAKE_VERSION}.tgz`], '--registry pointed npm at the fake');

  const progress = progressFor(s, 'fake-npx');
  assert.ok(progress.length >= 1, 'at least one agents/progress notification');
  for (const p of progress) {
    assert.ok(p.stream === 'stdout' || p.stream === 'stderr', `stream: ${p.stream}`);
    assert.equal(typeof p.line, 'string');
  }
  assert.ok(progress.some((p) => p.stream === 'stdout' && /added 1 package/.test(p.line)), `npm's own stdout is forwarded: ${JSON.stringify(progress)}`);
  const responseAt = s.lines.findIndex((l) => l.json?.id === 'inst');
  const lastProgressAt = s.lines.map((l, i) => (l.json?.method === 'agents/progress' ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(lastProgressAt < responseAt, 'progress precedes the response');
  assert.ok(s.lines.every(isJsonRpcLine), `npm output leaked onto stdout:\n${s.lines.filter((l) => !isJsonRpcLine(l)).map((l) => l.raw).join('\n')}`);

  const listing = await list(s, 'after', dataDir);
  const byId = new Map(listing.providers.map((p) => [p.id, p]));
  assert.equal(byId.get('fake-npx')!.installed, true);
  assert.equal(byId.get('fake-npx')!.installedVersion, FAKE_VERSION);
  for (const id of ACP_IDS.filter((x) => x !== 'fake-npx')) assert.deepEqual([byId.get(id)!.installed, byId.get(id)!.installedVersion], [false, null], id);
  assert.equal(await s.end(), 0);
});

test('agents/install refuses a uvx distribution with -32602 and touches nothing (binary ones install: agents-binary.test.ts)', { timeout: TIMEOUT }, async () => {
  const dataDir = makeTmpDir();
  const s = spawnSidecar();
  await s.ready;
  await primed(s, dataDir);
  const seen = npm.requests.length;
  for (const id of ['fake-uvx']) {
    expectError(await s.request(id, 'agents/install', { dataDir, id, npm: { registry: npm.url } }), -32602, id);
    assert.ok(!existsSync(join(dataDir, 'npx', id)), `${id}: no prefix created`);
    assert.equal(progressFor(s, id).length, 0, `${id}: npm never ran`);
  }
  assert.equal(npm.requests.length, seen, 'the npm registry was never contacted');
  assert.equal(await s.end(), 0);
});

test('agents/install for an id absent from the registry fails with -32602 or -32000', { timeout: TIMEOUT }, async () => {
  const dataDir = makeTmpDir();
  const s = spawnSidecar();
  await s.ready;
  await primed(s, dataDir);
  const res = await s.request(1, 'agents/install', { dataDir, id: 'no-such-agent', npm: { registry: npm.url } });
  // §1 pins only the non-npx case (-32602). An unknown id is either a bad
  // param value (§3 -32602) or an engine throw (§3 -32000); both are honest
  // readings of the contract, so either is accepted -- but never success.
  assert.ok(res.error, `expected an error, got ${JSON.stringify(res)}`);
  assert.ok([-32602, -32000].includes(res.error.code), `code ${res.error.code}: ${res.error.message}`);
  assert.ok(res.error.message.length > 0);
  assert.ok(!existsSync(join(dataDir, 'npx', 'no-such-agent')));
  assert.equal(await s.end(), 0);
});

test('agents/install is -32000 with npm\'s last stderr line when the packument 404s', { timeout: INSTALL_TIMEOUT }, async () => {
  const dataDir = makeTmpDir();
  const s = spawnSidecar();
  await s.ready;
  await primed(s, dataDir);
  const res = await s.request(1, 'agents/install', { dataDir, id: 'fake-missing', npm: { registry: npm.url } });
  const err = expectError(res, -32000, 'packument 404');
  assert.ok(npm.requests.includes('GET /fake-missing-agent'), 'npm asked the fake registry for the packument');
  const stderrLines = progressFor(s, 'fake-missing').filter((p) => p.stream === 'stderr' && p.line.trim().length > 0);
  assert.ok(stderrLines.length >= 1, 'npm\'s error output was forwarded as stderr progress');
  assert.ok(err.message.includes(stderrLines[stderrLines.length - 1].line), `message carries the last stderr line:\n${err.message}\nvs\n${stderrLines[stderrLines.length - 1].line}`);
  assert.equal(typeof (err.data as { name?: unknown } | undefined)?.name, 'string', '§3: data.name is the error class name');
  assert.ok(s.lines.every(isJsonRpcLine));
  assert.equal(await s.end(), 0);
});

test('agents/uninstall: false before install, true after (prefix gone), false again', { timeout: INSTALL_TIMEOUT }, async () => {
  const dataDir = makeTmpDir();
  const prefix = join(dataDir, 'npx', 'fake-npx');
  const s = spawnSidecar();
  await s.ready;
  await primed(s, dataDir);
  assert.deepEqual((await s.request(1, 'agents/uninstall', { dataDir, id: 'fake-npx' })).result, { id: 'fake-npx', removed: false });
  const inst = await s.request(2, 'agents/install', { dataDir, id: 'fake-npx', npm: { registry: npm.url } });
  assert.ok(!inst.error, `install failed: ${JSON.stringify(inst.error)}`);
  assert.ok(existsSync(join(prefix, 'node_modules', FAKE_PACKAGE)));
  assert.deepEqual((await s.request(3, 'agents/uninstall', { dataDir, id: 'fake-npx' })).result, { id: 'fake-npx', removed: true });
  assert.ok(!existsSync(prefix), 'the whole <dataDir>/npx/<id> prefix is removed');
  assert.deepEqual((await s.request(4, 'agents/uninstall', { dataDir, id: 'fake-npx' })).result, { id: 'fake-npx', removed: false });
  const listing = await list(s, 5, dataDir);
  const p = listing.providers.find((x) => x.id === 'fake-npx')!;
  assert.deepEqual([p.installed, p.installedVersion], [false, null], 'list reflects the removal');
  assert.equal(await s.end(), 0);
});

test('agents/install over an older install of the same agent updates it in place: the picker\'s Update', { timeout: INSTALL_TIMEOUT }, async () => {
  // An agent is installed at an exact version and nothing moves it after
  // that; the picker's "Update to x" is this call over the existing prefix.
  // Seeded by hand as an older copy, so the one fake package can stand in
  // for "the registry has moved on".
  const dataDir = makeTmpDir();
  const prefix = join(dataDir, 'npx', 'fake-npx');
  const old = join(prefix, 'node_modules', FAKE_PACKAGE);
  mkdirSync(old, { recursive: true });
  writeFileSync(join(prefix, 'package.json'), `${JSON.stringify({ dependencies: { [FAKE_PACKAGE]: '0.9.0' } })}\n`);
  writeFileSync(join(old, 'package.json'), `${JSON.stringify({ name: FAKE_PACKAGE, version: '0.9.0', bin: { [FAKE_PACKAGE]: 'index.js' } })}\n`);
  writeFileSync(join(old, 'index.js'), 'console.log("old")\n');
  const s = spawnSidecar();
  await s.ready;
  const before = (await list(s, 'before', dataDir)).providers.find((p) => p.id === 'fake-npx')!;
  assert.deepEqual([before.installed, before.installedVersion, before.version], [true, '0.9.0', FAKE_VERSION], 'installed, older than the registry');

  const res = await s.request('upd', 'agents/install', { dataDir, id: 'fake-npx', npm: { registry: npm.url } });
  assert.ok(!res.error, `update failed: ${JSON.stringify(res.error)}\nstderr:\n${s.stderr()}`);
  const after = (await list(s, 'after', dataDir)).providers.find((p) => p.id === 'fake-npx')!;
  assert.equal(after.installedVersion, FAKE_VERSION, 'the same prefix now holds the registry version');
  assert.equal(JSON.parse(readFileSync(join(prefix, 'package.json'), 'utf8')).dependencies[FAKE_PACKAGE], FAKE_VERSION, 'and pins it exactly');
  assert.equal(await s.end(), 0);
});
