// What makes more of the registry's agents run: an entry point that is not
// JavaScript runs as itself (grok and droid install a native program as
// their bin), a package that names one file twice still has a bin (kilo),
// and a binary-distributed agent -- Cursor, OpenCode, Goose -- is fetched,
// checked against the registry's sha256, unpacked and run from there.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { binaryLaunch, binaryTarget, installAgent, installedVersion, launchFor, platformKey, resolveBin, toProvider, uninstallAgent, type RegistryEntry } from '../../dist/agents/index.js';
import { makeTmpDir } from './helpers.ts';

test('platforms are named as the registry names them', () => {
  assert.equal(platformKey('darwin', 'arm64'), 'darwin-aarch64');
  assert.equal(platformKey('darwin', 'x64'), 'darwin-x86_64');
  assert.equal(platformKey('linux', 'x64'), 'linux-x86_64');
  assert.equal(platformKey('win32', 'x64'), 'windows-x86_64');
  assert.equal(platformKey('win32', 'arm64'), 'windows-aarch64');
});

test('an entry point runs on this Node when it is JavaScript, and as itself when it is a program of its own', () => {
  const dir = makeTmpDir();
  const file = (name: string, bytes: Buffer | string) => {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return p;
  };
  const node = (p: string) => ({ command: process.execPath, args: [p] });
  const self = (p: string) => ({ command: p, args: [] });
  const js = file('index.js', 'console.log(1)');
  assert.deepEqual(launchFor(js), node(js), 'a .js file');
  const shebang = file('cline', '#!/usr/bin/env node\nrequire("./x")');
  assert.deepEqual(launchFor(shebang), node(shebang), 'a node shebang: the app\'s own Node, not whatever is on PATH');
  const sh = file('run', '#!/bin/sh\nexec ./real "$@"');
  assert.deepEqual(launchFor(sh), self(sh), 'a shell script runs as itself');
  const macho = file('grok', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01]));
  assert.deepEqual(launchFor(macho), self(macho), 'a Mach-O program: grok, droid');
  const fat = file('uni', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]));
  assert.deepEqual(launchFor(fat), self(fat), 'a universal Mach-O');
  const elf = file('linux', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]));
  assert.deepEqual(launchFor(elf), self(elf), 'an ELF program');
  const pe = file('agent.exe', Buffer.from([0x4d, 0x5a, 0x90, 0]));
  assert.deepEqual(launchFor(pe), self(pe), 'a Windows program');
  const plain = file('entry', 'module.exports = 1');
  assert.deepEqual(launchFor(plain), node(plain), 'no shebang, no magic: JavaScript, as npm\'s own shims assume');
  assert.deepEqual(launchFor(join(dir, 'gone')), node(join(dir, 'gone')), 'unreadable: as before');
});

function npxEntry(id: string, pkg: string): RegistryEntry {
  return { id, name: id, description: '', version: '1.0.0', distribution: 'npx', npx: { package: `${pkg}@1.0.0`, args: [], env: {} } };
}

function layPackage(dataDir: string, id: string, pkg: string, bin: unknown): string {
  const dir = join(dataDir, 'npx', id, 'node_modules', ...pkg.split('/'));
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkg, version: '1.0.0', bin }));
  return dir;
}

test('a bin named twice for one file is that file; among several, the one named after the agent', () => {
  const dataDir = makeTmpDir();
  const kilo = layPackage(dataDir, 'kilo', '@kilocode/cli', { kilo: './bin/kilo', kilocode: 'bin/kilo' });
  assert.equal(resolveBin(dataDir, npxEntry('kilo', '@kilocode/cli')), join(kilo, 'bin', 'kilo'), '@kilocode/cli names one file twice');
  const two = layPackage(dataDir, 'tool', '@acme/cli', { helper: './bin/helper.js', tool: './bin/tool.js' });
  assert.equal(resolveBin(dataDir, npxEntry('tool', '@acme/cli')), join(two, 'bin', 'tool.js'), 'the one named after the agent');
  const none = layPackage(dataDir, 'other', '@acme/other', { a: './bin/a.js', b: './bin/b.js' });
  assert.ok(none);
  assert.equal(resolveBin(dataDir, npxEntry('other', '@acme/other')), null, 'no way to tell: none');
});

/** A .tar.gz with `agent` (a shell script) under `pkg/`, and its bytes' sha256. */
function makeArchive(tag: string): { bytes: Buffer; sha256: string } {
  const src = makeTmpDir();
  mkdirSync(join(src, 'pkg'));
  writeFileSync(join(src, 'pkg', 'agent'), `#!/bin/sh\necho ${tag}\n`);
  const tgz = join(makeTmpDir(), 'agent.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', src, 'pkg']);
  const bytes = readFileSync(tgz);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function binaryEntry(version: string, target: Partial<RegistryEntry['binary'] extends Record<string, infer T> | undefined ? T : never>): RegistryEntry {
  return {
    id: 'fake-bin',
    name: 'Fake binary',
    description: '',
    version,
    distribution: 'binary',
    binary: { [platformKey()]: { archive: 'https://downloads.example/agent.tar.gz', cmd: './pkg/agent', args: ['acp'], env: { A: '1' }, ...target } },
  };
}

const serving = (bytes: Buffer): typeof fetch => (async () => new Response(new Uint8Array(bytes))) as unknown as typeof fetch;

test('a binary agent is fetched, checked, unpacked and run from its folder; an update replaces it; uninstall takes it away', async () => {
  const dataDir = makeTmpDir();
  const v1 = makeArchive('one');
  const entry = binaryEntry('1.0.0', { sha256: v1.sha256 });
  assert.equal(binaryTarget(entry)?.cmd, './pkg/agent');
  assert.equal(toProvider(dataDir, entry).installable, true, 'installable: a build for this machine');
  assert.equal(toProvider(dataDir, { ...entry, binary: { 'plan9-mips': entry.binary![platformKey()]! } }).installable, false, 'no build for this machine: not installable');

  const lines: string[] = [];
  const r = await installAgent(dataDir, entry, { fetchImpl: serving(v1.bytes), onProgress: (_s, l) => lines.push(l) });
  assert.equal(r.version, '1.0.0');
  assert.equal(r.bin, join(dataDir, 'bin', 'fake-bin', '1.0.0', 'pkg', 'agent'));
  assert.ok(statSync(r.bin).mode & 0o100, 'executable');
  assert.equal(execFileSync(r.bin).toString().trim(), 'one', 'it runs');
  assert.equal(installedVersion(dataDir, entry), '1.0.0');
  assert.equal(resolveBin(dataDir, entry), r.bin);
  assert.deepEqual(binaryLaunch(dataDir, entry), { args: ['acp'], env: { A: '1' } }, 'its platform\'s args and env, for agent/connect');
  assert.ok(lines.some((l) => /checksum matches/.test(l)), 'says it checked');
  assert.ok(!existsSync(join(dataDir, 'bin', '.fake-bin.partial')), 'nothing left half-unpacked');

  const v2 = makeArchive('two');
  const r2 = await installAgent(dataDir, binaryEntry('2.0.0', { sha256: v2.sha256 }), { fetchImpl: serving(v2.bytes) });
  assert.equal(execFileSync(r2.bin).toString().trim(), 'two');
  assert.ok(!existsSync(join(dataDir, 'bin', 'fake-bin', '1.0.0')), 'the old version is gone');

  assert.equal(uninstallAgent(dataDir, 'fake-bin'), true);
  assert.equal(installedVersion(dataDir, entry), null);
  assert.equal(uninstallAgent(dataDir, 'fake-bin'), false);
});

test('a download that does not match the registry\'s sha256, or a cmd that leaves the archive, installs nothing', async () => {
  const dataDir = makeTmpDir();
  const good = makeArchive('good');
  await installAgent(dataDir, binaryEntry('1.0.0', { sha256: good.sha256 }), { fetchImpl: serving(good.bytes) });
  const bad = makeArchive('tampered');
  await assert.rejects(installAgent(dataDir, binaryEntry('2.0.0', { sha256: good.sha256 }), { fetchImpl: serving(bad.bytes) }), /does not match the registry's sha256/);
  assert.equal(installedVersion(dataDir, binaryEntry('1.0.0', {})), '1.0.0', 'the working install is untouched');
  await assert.rejects(installAgent(dataDir, binaryEntry('3.0.0', { cmd: '../../../etc/x' }), { fetchImpl: serving(good.bytes) }), /leaves the archive/);
  await assert.rejects(installAgent(dataDir, binaryEntry('4.0.0', { cmd: './pkg/missing' }), { fetchImpl: serving(good.bytes) }), /is not in agent\.tar\.gz/);
  const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(installAgent(dataDir, binaryEntry('5.0.0', {}), { fetchImpl: failing }), /HTTP 404/);
  assert.equal(installedVersion(dataDir, binaryEntry('1.0.0', {})), '1.0.0', 'and still untouched');
});
