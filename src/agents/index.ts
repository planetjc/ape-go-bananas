// Provider management -- docs/research/agent-protocol.md §1. Copies Zed's
// mechanism (docs/research/agent-install-and-auth.md §4): read the public
// ACP registry, install an entry's npm package into a per-agent prefix under
// the app's data directory with the sidecar's own Node, and spawn it from
// there. Nothing here knows what an agent says; it only puts one on disk.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const DEFAULT_REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const REGISTRY_MAX_AGE_MS = 60 * 60 * 1000;

export type Distribution = 'npx' | 'binary' | 'uvx';

export interface Provider {
  id: string;
  kind: 'acp' | 'api';
  name: string;
  description: string;
  version: string | null;
  installed: boolean;
  installedVersion: string | null;
  distribution: Distribution | null;
  installable: boolean;
}

/** One platform's build of a binary-distributed agent: an archive to unpack, and the command in it. */
export interface BinaryTarget {
  archive: string;
  cmd: string;
  args: string[];
  env: Record<string, string>;
  sha256?: string;
}

/** One registry entry, kept whole so `agent/connect` can read its npx args/env. */
export interface RegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  distribution: Distribution;
  npx?: { package: string; args: string[]; env: Record<string, string> };
  /** By platform key -- `darwin-aarch64`, `windows-x86_64` (platformKey). */
  binary?: Record<string, BinaryTarget>;
}

/** This machine as the registry names platforms: `darwin-aarch64`, `linux-x86_64`, `windows-x86_64`. */
export function platformKey(platform: string = process.platform, arch: string = process.arch): string {
  const os = platform === 'win32' ? 'windows' : platform;
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : arch;
  return `${os}-${cpu}`;
}

/** The build of `entry` for this machine, when it is binary-distributed and has one. */
export function binaryTarget(entry: RegistryEntry, key: string = platformKey()): BinaryTarget | null {
  return entry.distribution === 'binary' ? (entry.binary?.[key] ?? null) : null;
}

export interface RegistryState {
  fetchedAt: string | null;
  url: string;
  error: string | null;
  entries: RegistryEntry[];
}

export const BUILT_IN_PROVIDERS: Provider[] = [
  {
    id: 'openrouter',
    kind: 'api',
    name: 'OpenRouter',
    description: 'Any model, one API key',
    version: null,
    installed: true,
    installedVersion: null,
    distribution: null,
    installable: false,
  },
];

export function isBuiltIn(id: string): boolean {
  return BUILT_IN_PROVIDERS.some((p) => p.id === id);
}

interface RegistryCache {
  fetchedAt: string;
  url: string;
  entries: RegistryEntry[];
}

function cachePath(dataDir: string): string {
  return join(dataDir, 'registry.json');
}

/** Strict mapping per §1: an entry without id/name/distribution is skipped, and only the one distribution key present is recorded. */
function parseRegistry(raw: unknown): RegistryEntry[] {
  const list = Array.isArray(raw) ? raw : (raw as { agents?: unknown })?.agents;
  if (!Array.isArray(list)) return [];
  const entries: RegistryEntry[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    const dist = e.distribution;
    if (typeof e.id !== 'string' || !isAgentId(e.id) || typeof e.name !== 'string' || typeof dist !== 'object' || dist === null) continue;
    const kind = (['npx', 'binary', 'uvx'] as const).find((k) => k in (dist as object));
    if (kind === undefined) continue;
    const entry: RegistryEntry = {
      id: e.id,
      name: e.name,
      description: typeof e.description === 'string' ? e.description : '',
      version: typeof e.version === 'string' ? e.version : '',
      distribution: kind,
    };
    if (kind === 'npx') {
      const npx = (dist as { npx: Record<string, unknown> }).npx;
      if (typeof npx?.package !== 'string') continue;
      entry.npx = {
        package: npx.package,
        args: Array.isArray(npx.args) ? npx.args.filter((a): a is string => typeof a === 'string') : [],
        env: typeof npx.env === 'object' && npx.env !== null ? (npx.env as Record<string, string>) : {},
      };
    } else if (kind === 'binary') {
      // Each platform's archive and the command inside it; one that names neither is left out.
      const targets: Record<string, BinaryTarget> = {};
      for (const [key, raw] of Object.entries((dist as { binary: Record<string, unknown> }).binary ?? {})) {
        const t = raw as Record<string, unknown>;
        if (typeof t?.archive !== 'string' || typeof t.cmd !== 'string' || !/^https:\/\//.test(t.archive)) continue;
        targets[key] = {
          archive: t.archive,
          cmd: t.cmd,
          args: Array.isArray(t.args) ? t.args.filter((a): a is string => typeof a === 'string') : [],
          env: typeof t.env === 'object' && t.env !== null ? (t.env as Record<string, string>) : {},
          ...(typeof t.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(t.sha256) ? { sha256: t.sha256.toLowerCase() } : {}),
        };
      }
      entry.binary = targets;
    }
    entries.push(entry);
  }
  return entries;
}

function readCache(dataDir: string): RegistryCache | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(dataDir), 'utf8')) as Partial<RegistryCache>;
    if (typeof parsed.fetchedAt !== 'string' || !Array.isArray(parsed.entries)) return null;
    return { fetchedAt: parsed.fetchedAt, url: typeof parsed.url === 'string' ? parsed.url : '', entries: parsed.entries as RegistryEntry[] };
  } catch {
    return null;
  }
}

export async function loadRegistry(
  dataDir: string,
  opts: { registryUrl?: string; refresh?: boolean; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<RegistryState> {
  const now = opts.now ?? Date.now;
  const cached = readCache(dataDir);
  // A call that names no URL means "the registry this data dir already
  // uses" -- agents/install carries none (§1) and must find the entries
  // agents/list just cached, whichever registry they came from.
  const url = opts.registryUrl ?? (cached?.url || DEFAULT_REGISTRY_URL);
  const fresh = cached !== null && cached.url === url && now() - Date.parse(cached.fetchedAt) < REGISTRY_MAX_AGE_MS;
  if (fresh && !opts.refresh) {
    return { fetchedAt: cached.fetchedAt, url, error: null, entries: cached.entries };
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`registry ${url} answered HTTP ${res.status}`);
    const entries = parseRegistry(await res.json());
    const fetchedAt = new Date(now()).toISOString();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cachePath(dataDir), `${JSON.stringify({ fetchedAt, url, entries } satisfies RegistryCache, null, 2)}\n`);
    return { fetchedAt, url, error: null, entries };
  } catch (err) {
    const error = (err as Error).message;
    if (cached !== null) return { fetchedAt: cached.fetchedAt, url, error, entries: cached.entries };
    return { fetchedAt: null, url, error, entries: [] };
  }
}

// ---- on-disk layout -------------------------------------------------------

/**
 * An agent id becomes a directory name under the data dir, and it comes from
 * the public registry or the caller: `..` as an id made uninstall a
 * recursive delete of the data dir itself. A registry id is a plain name.
 */
export function isAgentId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) && !id.includes('..');
}

export function prefixFor(dataDir: string, id: string): string {
  if (!isAgentId(id)) throw new RangeError(`not an agent id: ${JSON.stringify(id)}`);
  return join(dataDir, 'npx', id);
}

/** The name npm installs a package under: `@scope/name@1.2.3` -> `@scope/name`. */
export function packageName(spec: string): string {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
}

function readInstalledPackageJson(dataDir: string, entry: RegistryEntry): { dir: string; json: Record<string, unknown> } | null {
  if (entry.npx === undefined) return null;
  const dir = join(prefixFor(dataDir, entry.id), 'node_modules', packageName(entry.npx.package));
  try {
    return { dir, json: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown> };
  } catch {
    return null;
  }
}

export function installedVersion(dataDir: string, entry: RegistryEntry): string | null {
  if (entry.distribution === 'binary') return readBinaryInstall(dataDir, entry)?.version ?? null;
  const pkg = readInstalledPackageJson(dataDir, entry);
  return pkg !== null && typeof pkg.json.version === 'string' ? pkg.json.version : null;
}

/**
 * §1 agents/install: the program to run. A binary agent's is its command in
 * the unpacked archive. An npx agent's is the sole `bin` entry -- or the one
 * file several names point at (@kilocode/cli has `kilo` and `kilocode`), or
 * the entry named after the agent's id, or after the package's unscoped name.
 */
export function resolveBin(dataDir: string, entry: RegistryEntry): string | null {
  if (entry.distribution === 'binary') return readBinaryInstall(dataDir, entry)?.cmd ?? null;
  const pkg = readInstalledPackageJson(dataDir, entry);
  if (pkg === null) return null;
  const bin = pkg.json.bin;
  const unscoped = basename(packageName(entry.npx!.package));
  let rel: string | undefined;
  if (typeof bin === 'string') rel = bin;
  else if (typeof bin === 'object' && bin !== null) {
    const names = bin as Record<string, string>;
    const files = new Set(Object.values(names).map((f) => resolve(pkg.dir, f)));
    rel = files.size === 1 ? Object.values(names)[0] : (names[entry.id] ?? names[unscoped]);
  }
  return rel === undefined ? null : resolve(pkg.dir, rel);
}

/**
 * How to run an agent's program. A JavaScript entry runs on this Node -- the
 * one the app ships, since the person may have none -- and anything else as
 * itself: grok and droid install a native executable as their bin, and
 * `node <a Mach-O file>` is a syntax error on the first byte.
 */
export function launchFor(bin: string): { command: string; args: string[] } {
  const onNode = { command: process.execPath, args: [bin] };
  if (/\.[cm]?js$/i.test(bin)) return onNode;
  const head = Buffer.alloc(64);
  let n = 0;
  try {
    const fd = openSync(bin, 'r');
    try {
      n = readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return onNode;
  }
  const text = head.subarray(0, n).toString('latin1');
  if (text.startsWith('#!')) return /\bnode\b/.test(text.slice(2).split('\n')[0]!) ? onNode : { command: bin, args: [] };
  const magic = n >= 4 ? head.readUInt32BE(0) : 0;
  const native =
    [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic) || // Mach-O, and a universal one
    magic === 0x7f454c46 || // ELF
    (n >= 2 && head[0] === 0x4d && head[1] === 0x5a); // PE: MZ
  return native ? { command: bin, args: [] } : onNode;
}

export function toProvider(dataDir: string, entry: RegistryEntry): Provider {
  const version = installedVersion(dataDir, entry);
  return {
    id: entry.id,
    kind: 'acp',
    name: entry.name,
    description: entry.description,
    version: entry.version || null,
    installed: version !== null,
    installedVersion: version,
    distribution: entry.distribution,
    installable: entry.distribution === 'npx' || binaryTarget(entry) !== null,
  };
}

// ---- npm ------------------------------------------------------------------

/** §1: APE_NPM_CLI, else the npm-cli.js beside this Node, else `npm` on PATH. Returns argv[0..] to prepend to npm's own args. */
export function npmCommand(): { command: string; args: string[] } {
  const override = process.env.APE_NPM_CLI;
  if (override) return { command: process.execPath, args: [override] };
  const beside = join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (existsSync(beside)) return { command: process.execPath, args: [beside] };
  return { command: 'npm', args: [] };
}

export interface InstallResult {
  id: string;
  package: string;
  version: string;
  bin: string;
}

export function installAgent(
  dataDir: string,
  entry: RegistryEntry,
  opts: { registry?: string; onProgress?: (stream: 'stdout' | 'stderr', line: string) => void; fetchImpl?: typeof fetch } = {},
): Promise<InstallResult> {
  if (entry.distribution === 'binary') return installBinary(dataDir, entry, opts);
  if (entry.npx === undefined) return Promise.reject(new RangeError(`${entry.id}: distribution is ${entry.distribution}, only npx and binary entries can be installed`));
  const prefix = prefixFor(dataDir, entry.id);
  mkdirSync(prefix, { recursive: true });
  const spec = entry.npx.package.includes('@', 1) || entry.version === '' ? entry.npx.package : `${entry.npx.package}@${entry.version}`;
  const npm = npmCommand();
  const args = [...npm.args, 'install', '--prefix', prefix, '--save-exact', '--no-audit', '--no-fund', '--no-package-lock'];
  const registry = opts.registry ?? process.env.APE_NPM_REGISTRY;
  if (registry) args.push('--registry', registry);
  args.push(spec);

  return new Promise<InstallResult>((resolvePromise, reject) => {
    const child = spawn(npm.command, args, { cwd: prefix, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, npm_config_update_notifier: 'false' } });
    let lastErr = '';
    const pump = (stream: 'stdout' | 'stderr') => {
      let buf = '';
      child[stream]!.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        let i: number;
        while ((i = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line.trim() === '') continue;
          if (stream === 'stderr') lastErr = line;
          opts.onProgress?.(stream, line);
        }
      });
      child[stream]!.on('end', () => {
        if (buf.trim() !== '') opts.onProgress?.(stream, buf);
        if (stream === 'stderr' && buf.trim() !== '') lastErr = buf.trim();
      });
    };
    pump('stdout');
    pump('stderr');
    child.on('error', (err) => reject(new Error(`npm failed to start: ${err.message}`)));
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`npm install ${spec} exited ${code}${lastErr ? `: ${lastErr}` : ''}`));
        return;
      }
      const version = installedVersion(dataDir, entry);
      const bin = resolveBin(dataDir, entry);
      if (version === null || bin === null) {
        reject(new Error(`npm install ${spec} finished but ${packageName(entry.npx!.package)} has no package.json/bin under ${prefix}`));
        return;
      }
      resolvePromise({ id: entry.id, package: packageName(entry.npx!.package), version, bin });
    });
  });
}

export function uninstallAgent(dataDir: string, id: string): boolean {
  let removed = false;
  for (const dir of [prefixFor(dataDir, id), binaryPrefixFor(dataDir, id)]) {
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    removed = true;
  }
  return removed;
}

// ---- binary agents ----------------------------------------------------------
//
// The registry's other half: an archive per platform with the agent's own
// program in it (Cursor, OpenCode, Goose, Google's Antigravity). Downloaded
// with this process's fetch, checked against the registry's sha256 when it
// gives one, unpacked with the system's tar -- bsdtar on macOS and Windows
// reads .zip, .tar.gz and .tar.bz2 alike; Linux's GNU tar does not read .zip,
// so unzip does that there -- into `<dataDir>/bin/<id>/<version>/`, and a
// record beside it says which version and which command.

export function binaryPrefixFor(dataDir: string, id: string): string {
  if (!isAgentId(id)) throw new RangeError(`not an agent id: ${JSON.stringify(id)}`);
  return join(dataDir, 'bin', id);
}

interface BinaryInstall {
  version: string;
  cmd: string;
  args: string[];
  env: Record<string, string>;
}

function readBinaryInstall(dataDir: string, entry: RegistryEntry): BinaryInstall | null {
  try {
    const rec = JSON.parse(readFileSync(join(binaryPrefixFor(dataDir, entry.id), 'installed.json'), 'utf8')) as Partial<BinaryInstall>;
    if (typeof rec.version !== 'string' || typeof rec.cmd !== 'string' || !existsSync(rec.cmd)) return null;
    return { version: rec.version, cmd: rec.cmd, args: Array.isArray(rec.args) ? rec.args : [], env: typeof rec.env === 'object' && rec.env !== null ? rec.env : {} };
  } catch {
    return null;
  }
}

/** The args and env a binary agent was installed with: its platform's, from the registry at the time. */
export function binaryLaunch(dataDir: string, entry: RegistryEntry): { args: string[]; env: Record<string, string> } | null {
  const rec = readBinaryInstall(dataDir, entry);
  return rec ? { args: rec.args, env: rec.env } : null;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr!.on('data', (c: Buffer) => (err = (err + c.toString('utf8')).slice(-400)));
    child.on('error', (e) => reject(new Error(`${command} failed to start: ${e.message}`)));
    child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${command} exited ${code}${err.trim() ? `: ${err.trim()}` : ''}`))));
  });
}

async function installBinary(
  dataDir: string,
  entry: RegistryEntry,
  opts: { onProgress?: (stream: 'stdout' | 'stderr', line: string) => void; fetchImpl?: typeof fetch },
): Promise<InstallResult> {
  const key = platformKey();
  const target = binaryTarget(entry, key);
  if (target === null) throw new RangeError(`${entry.id}: the registry has no build for ${key}`);
  const say = (line: string) => opts.onProgress?.('stdout', line);
  const prefix = binaryPrefixFor(dataDir, entry.id);
  const version = entry.version || 'current';
  const dir = join(prefix, version.replace(/[^A-Za-z0-9._-]/g, '_'));
  // Beside the agent's folder, not in it: that folder is cleared before this one takes its place.
  const staging = join(dataDir, 'bin', `.${entry.id}.partial`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  say(`downloading ${target.archive}`);
  const res = await (opts.fetchImpl ?? fetch)(target.archive, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!res.ok) throw new Error(`download ${target.archive} answered HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  say(`downloaded ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
  if (target.sha256) {
    const got = createHash('sha256').update(bytes).digest('hex');
    if (got !== target.sha256) throw new Error(`download ${target.archive} does not match the registry's sha256 (got ${got})`);
    say('checksum matches the registry');
  }
  const name = basename(new URL(target.archive).pathname) || 'archive';
  const archive = join(staging, `.${name}`);
  writeFileSync(archive, bytes);
  say(`unpacking ${name}`);
  if (/\.zip$/i.test(name) && process.platform === 'linux') await run('unzip', ['-q', '-o', archive, '-d', staging], staging);
  else await run('tar', ['-xf', archive, '-C', staging], staging);
  rmSync(archive, { force: true });

  // The command is named relative to the archive's root; it must stay inside it.
  const cmd = resolve(staging, target.cmd);
  if (!cmd.startsWith(resolve(staging) + sep)) throw new Error(`${entry.id}: the registry's cmd ${target.cmd} leaves the archive`);
  if (!existsSync(cmd)) throw new Error(`${entry.id}: ${target.cmd} is not in ${name}`);
  if (process.platform !== 'win32') chmodSync(cmd, 0o755);

  // Swapped in whole: an agent is never left half-unpacked, and the old version goes.
  rmSync(prefix, { recursive: true, force: true });
  mkdirSync(prefix, { recursive: true });
  renameSync(staging, dir);
  const installed = join(dir, cmd.slice(resolve(staging).length + 1));
  writeFileSync(join(prefix, 'installed.json'), `${JSON.stringify({ version, cmd: installed, args: target.args, env: target.env } satisfies BinaryInstall, null, 2)}\n`);
  say(`installed ${entry.id} ${version}`);
  return { id: entry.id, package: entry.id, version, bin: installed };
}
