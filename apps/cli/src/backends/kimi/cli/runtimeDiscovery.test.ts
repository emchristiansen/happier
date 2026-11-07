import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  classifyKimiInitialize,
  classifyKimiProbe,
  discoverKimiRuntimeCandidates,
  requireCurrentKimiRuntime,
  selectKimiRuntimeCandidate,
} from './runtimeDiscovery';

function readFixture(name: string): unknown {
  const line = readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}.initialize.ndjson`, import.meta.url)), 'utf8').trim();
  return (JSON.parse(line) as { result?: unknown }).result;
}

function writeFixtureExecutable(command: string, fixture: string): string {
  writeFileSync(command, `#!${process.execPath}
const readline = require('node:readline');
if (process.env.HAPPIER_KIMI_FIXTURE_ENV !== 'forwarded') process.exit(2);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: ${JSON.stringify(readFixture(fixture))} }) + '\\n');
});
`, 'utf8');
  chmodSync(command, 0o755);
  return command;
}

describe('Kimi ACP runtime discovery', () => {
  it('classifies the current runtime only from close/delete/fork plus SSE capabilities', () => {
    expect(classifyKimiInitialize(readFixture('current'))).toBe('current');
  });

  it('recognizes the pinned legacy capability shape independently of its higher semver', () => {
    expect(classifyKimiInitialize(readFixture('legacy'))).toBe('legacy');
  });

  it('keeps malformed and timed-out probes unknown', () => {
    expect(classifyKimiInitialize(readFixture('malformed'))).toBe('unknown');
    expect(classifyKimiProbe({ ok: false, checkedAt: 1, error: { message: 'timed out' } })).toBe('unknown');
  });

  it('prefers a current candidate over an earlier legacy candidate without comparing versions', () => {
    expect(selectKimiRuntimeCandidate([
      { source: 'system', command: '/legacy/kimi', kind: 'legacy' },
      { source: 'system', command: '/current-lower-semver/kimi', kind: 'current' },
    ])).toEqual({ source: 'system', command: '/current-lower-semver/kimi', kind: 'current' });
  });

  it('performs a real NDJSON initialize exchange for every PATH candidate and selects current', async () => {
    if (process.platform === 'win32') return;
    const root = join(tmpdir(), `happier-kimi-classifier-${process.pid}-${Date.now()}`);
    const legacyDir = join(root, 'legacy');
    const currentDir = join(root, 'current');
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(currentDir, { recursive: true });
    try {
      const legacy = writeFixtureExecutable(join(legacyDir, 'kimi'), 'legacy');
      const current = writeFixtureExecutable(join(currentDir, 'kimi'), 'current');
      const processEnv = { ...process.env, PATH: `${legacyDir}${delimiter}${currentDir}`, HOME: root, HAPPIER_KIMI_FIXTURE_ENV: 'forwarded' };
      const candidates = await discoverKimiRuntimeCandidates({ processEnv, cwd: root, probeTimeoutMs: 2_000 });

      expect(candidates.map(({ command, kind }) => ({ command, kind }))).toEqual([
        { command: legacy, kind: 'legacy' },
        { command: current, kind: 'current' },
      ]);
      await expect(requireCurrentKimiRuntime({ processEnv, cwd: root, probeTimeoutMs: 2_000 }))
        .resolves.toMatchObject({ command: current, kind: 'current' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('classifies an explicit legacy override and fails with manual migration guidance', async () => {
    if (process.platform === 'win32') return;
    const root = join(tmpdir(), `happier-kimi-explicit-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const explicit = join(root, 'legacy-kimi');
    writeFixtureExecutable(explicit, 'legacy');
    const currentDir = join(root, 'current');
    mkdirSync(currentDir);
    writeFixtureExecutable(join(currentDir, 'kimi'), 'current');
    try {
      await expect(requireCurrentKimiRuntime({
        processEnv: { ...process.env, PATH: currentDir, HOME: root, HAPPIER_KIMI_PATH: explicit, HAPPIER_KIMI_FIXTURE_ENV: 'forwarded' },
        cwd: root,
        probeTimeoutMs: 2_000,
      })).rejects.toThrow(/Legacy kimi-cli.*`kimi migrate` manually.*never runs migration/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['exit', 'timeout'] as const)('fails closed on an explicit %s candidate', async (failure) => {
    if (process.platform === 'win32') return;
    const root = join(tmpdir(), `happier-kimi-${failure}-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const command = join(root, 'kimi');
    writeFileSync(command, `#!${process.execPath}\n${failure === 'exit' ? 'process.exit(7);' : 'process.stdin.resume();'}\n`);
    chmodSync(command, 0o755);
    try {
      await expect(requireCurrentKimiRuntime({
        processEnv: { ...process.env, HAPPIER_KIMI_PATH: command }, cwd: root, probeTimeoutMs: 150,
      })).rejects.toThrow(/Could not identify the Kimi runtime/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
