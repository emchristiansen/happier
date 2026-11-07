import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliTestLaunchSpec } from '../process/cliLaunchSpec';

// Launch-spec production (snapshot generations) is the boundary a borrowed spec must not cross;
// its own per-call freshness is covered by the J078 resolver tests.
const cliLaunchSpecMock = vi.hoisted(() => ({ resolveCliTestLaunchSpec: vi.fn(), generation: 0 }));
vi.mock('../process/cliLaunchSpec', async (original) => ({
  ...(await original<typeof import('../process/cliLaunchSpec')>()),
  resolveCliTestLaunchSpec: cliLaunchSpecMock.resolveCliTestLaunchSpec,
}));

// Child processes are the boundary: record the exact spawn request and answer like the CLI would.
type SpawnRequest = Readonly<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }>;
const spawnRecorder = vi.hoisted(() => ({ requests: [] as SpawnRequest[] }));
vi.mock('../process/spawnProcess', () => ({
  spawnLoggedProcess: (params: SpawnRequest & { stdoutPath: string; stderrPath: string }) => {
    spawnRecorder.requests.push({ command: params.command, args: [...params.args], cwd: params.cwd, env: { ...params.env } });
    writeFileSync(params.stdoutPath, 'https://127.0.0.1:4011/terminal/connect#key=test-key\n', 'utf8');
    writeFileSync(params.stderrPath, '', 'utf8');
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, pid: undefined });
    return {
      child,
      stdoutPath: params.stdoutPath,
      stderrPath: params.stderrPath,
      stop: async () => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      },
    };
  },
  runLoggedCommand: async (params: SpawnRequest & { stdoutPath: string }) => {
    spawnRecorder.requests.push({ command: params.command, args: [...params.args], cwd: params.cwd, env: { ...params.env } });
    writeFileSync(params.stdoutPath, `${JSON.stringify({ ok: true, kind: 'probe' })}\n`, 'utf8');
  },
}));

// Ownership leases live under the shared repository root; observe them instead of writing there.
const leaseMock = vi.hoisted(() => ({ sweep: vi.fn(async () => {}), register: vi.fn(async () => {}) }));
vi.mock('../process/processOwnershipLease', async (original) => ({
  ...(await original<typeof import('../process/processOwnershipLease')>()),
  inspectOwnedProcess: () => ({ ok: true, startTime: 'fixture-owner-start' }),
  sweepProcessOwnershipLeases: leaseMock.sweep,
  registerProcessOwnershipLease: leaseMock.register,
}));

import {
  resolveCliTerminalConnectLaunchSpec,
  startCliAuthLoginForTerminalConnect,
  type PreparedCliTerminalConnectLaunchSpec,
} from './cliTerminalConnect';
import { resolveCliJsonLaunchSpec, runCliJson, type PreparedCliJsonLaunchSpec } from './cliJson';

function nextGeneration(testDir: string): CliTestLaunchSpec {
  cliLaunchSpecMock.generation += 1;
  const generationDir = resolve(testDir, `cli-dist-generation-${cliLaunchSpecMock.generation}`);
  return {
    command: process.execPath,
    args: ['--preserve-symlinks', '--import', 'tsx-hook', resolve(generationDir, 'src', 'index.ts')],
    cwd: generationDir,
    env: { TSX_TSCONFIG_PATH: resolve(generationDir, 'tsconfig.json') },
  };
}

afterEach(() => {
  cliLaunchSpecMock.resolveCliTestLaunchSpec.mockReset();
  leaseMock.sweep.mockClear();
  leaseMock.register.mockClear();
  spawnRecorder.requests = [];
});

async function withTestDir<T>(run: (testDir: string) => Promise<T>): Promise<T> {
  const testDir = await mkdtemp(join(tmpdir(), 'happier-ui-e2e-borrowed-spec-'));
  try {
    return await run(testDir);
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

const SOURCE_ENV = { HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' } as const;
// Ambient selection that sanitizeCliTestEnv strips for both resolution and spawn.
const AMBIENT_ENV = { HAPPIER_ACTIVE_SERVER_ID: 'ambient', HAPPIER_TEST_ENV_PROBE: 'kept' } as const;

describe('startCliAuthLoginForTerminalConnect borrowed launch spec', () => {
  const login = (testDir: string, env: NodeJS.ProcessEnv, preparedCliLaunchSpec?: PreparedCliTerminalConnectLaunchSpec) =>
    startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir: resolve(testDir, 'cli-home'),
      serverUrl: 'http://127.0.0.1:4011',
      webappUrl: 'http://127.0.0.1:19006',
      env,
      ...(preparedCliLaunchSpec ? { preparedCliLaunchSpec } : {}),
    });

  it('resolves exactly what the helper resolves, and a borrowed spec spawns identically without resolving', async () => {
    await withTestDir(async (testDir) => {
      const env = { ...SOURCE_ENV, ...AMBIENT_ENV };
      const spec = nextGeneration(testDir);
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValue(spec);

      await (await login(testDir, env)).stop();
      const prepared = await resolveCliTerminalConnectLaunchSpec({ testDir, env });
      const [helperCall, prepareCall] = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls;
      expect(prepareCall).toEqual(helperCall);
      expect(helperCall?.[0]?.env?.HAPPIER_ACTIVE_SERVER_ID).toBeUndefined();
      expect(prepared).toMatchObject({ kind: 'cli-terminal-connect', testDir: resolve(testDir), cliSourceEntrypointRequested: true, spec });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockClear();
      leaseMock.sweep.mockClear();
      leaseMock.register.mockClear();
      await (await login(testDir, env, prepared)).stop();

      expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).not.toHaveBeenCalled();
      const [resolvedSpawn, borrowedSpawn] = spawnRecorder.requests;
      expect(resolvedSpawn).toMatchObject({
        command: spec.command,
        args: [...spec.args, 'auth', 'login', '--force', '--no-open', '--method', 'web'],
        env: expect.objectContaining({ ...spec.env, HAPPIER_TEST_ENV_PROBE: 'kept' }),
      });
      expect(borrowedSpawn).toEqual(resolvedSpawn);
      expect(leaseMock.sweep).toHaveBeenCalledTimes(1);
      expect(leaseMock.register).toHaveBeenCalledTimes(1);
    });
  });

  it('resolves a fresh generation for every launch without a borrowed spec', async () => {
    await withTestDir(async (testDir) => {
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockImplementation(async () => nextGeneration(testDir));

      await (await login(testDir, {})).stop();
      await (await login(testDir, {})).stop();

      expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).toHaveBeenCalledTimes(2);
      const [first, second] = spawnRecorder.requests.map((request) => request.env?.TSX_TSCONFIG_PATH);
      expect(first).toBeTruthy();
      expect(second).not.toBe(first);
    });
  });

  it.each([
    { label: 'a different testDir', message: /was resolved for testDir=/, env: {}, otherTestDir: true, kind: undefined },
    { label: 'a different entrypoint mode', message: /cliSourceEntrypoint=false but this launch has .*cliSourceEntrypoint=true/, env: { ...SOURCE_ENV }, otherTestDir: false, kind: undefined },
    { label: 'a spec from another helper', message: /must come from resolveCliTerminalConnectLaunchSpec/, env: {}, otherTestDir: false, kind: 'cli-json' },
  ])('rejects a borrowed spec for $label before any side effect', async ({ message, env, otherTestDir, kind }) => {
    await withTestDir(async (testDir) => {
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce(nextGeneration(testDir));
      const resolved = await resolveCliTerminalConnectLaunchSpec({ testDir, env: {} });
      const prepared = (kind ? { ...resolved, kind } : resolved) as PreparedCliTerminalConnectLaunchSpec;
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockClear();

      await expect(login(otherTestDir ? resolve(testDir, 'other-test') : testDir, env, prepared)).rejects.toThrow(message);

      expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).not.toHaveBeenCalled();
      expect(leaseMock.sweep).not.toHaveBeenCalled();
      expect(spawnRecorder.requests).toEqual([]);
    });
  });
});

describe('runCliJson borrowed launch spec', () => {
  const runJson = (
    testDir: string,
    env: NodeJS.ProcessEnv,
    extra: Pick<Parameters<typeof runCliJson>[0], 'launchOptions' | 'preparedCliLaunchSpec'> = {},
  ) =>
    runCliJson({
      testDir,
      cliHomeDir: resolve(testDir, 'cli-home'),
      serverUrl: 'http://127.0.0.1:4011',
      webappUrl: 'http://127.0.0.1:19006',
      env,
      label: 'probe',
      args: ['session', 'send', 'session-id', 'message', '--json'],
      ...extra,
    });

  it('resolves exactly what the helper resolves, and repeated borrowed runs spawn identically without resolving', async () => {
    await withTestDir(async (testDir) => {
      const env = { ...SOURCE_ENV, ...AMBIENT_ENV };
      const spec = nextGeneration(testDir);
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValue(spec);

      await runJson(testDir, env);
      const prepared = await resolveCliJsonLaunchSpec({ testDir, env });
      const [helperCall, prepareCall] = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls;
      expect(prepareCall).toEqual(helperCall);
      expect(prepared).toMatchObject({ kind: 'cli-json', testDir: resolve(testDir), cliSourceEntrypointRequested: true, spec });

      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockClear();
      await expect(runJson(testDir, env, { preparedCliLaunchSpec: prepared })).resolves.toEqual({ ok: true, kind: 'probe' });
      await runJson(testDir, env, { preparedCliLaunchSpec: prepared });

      expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).not.toHaveBeenCalled();
      const [resolvedSpawn, ...borrowedSpawns] = spawnRecorder.requests;
      expect(resolvedSpawn).toMatchObject({
        command: spec.command,
        args: [...spec.args, 'session', 'send', 'session-id', 'message', '--json'],
        env: expect.objectContaining({ ...spec.env, HAPPIER_TEST_ENV_PROBE: 'kept' }),
      });
      expect(resolvedSpawn?.env?.HAPPIER_ACTIVE_SERVER_ID).toBeUndefined();
      expect(borrowedSpawns).toEqual([resolvedSpawn, resolvedSpawn]);
    });
  });

  it('keeps the resolve options a borrowed spec was prepared with', async () => {
    await withTestDir(async (testDir) => {
      const launchOptions = { preferSourceEntrypoint: true, skipSourceFreshnessCheck: true };
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValue(nextGeneration(testDir));

      await runJson(testDir, {}, { launchOptions });
      await resolveCliJsonLaunchSpec({ testDir, env: {}, launchOptions });

      const [helperCall, prepareCall] = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls;
      expect(helperCall?.[1]).toMatchObject(launchOptions);
      expect(prepareCall).toEqual(helperCall);
    });
  });

  it('resolves a fresh generation for every run without a borrowed spec', async () => {
    await withTestDir(async (testDir) => {
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockImplementation(async () => nextGeneration(testDir));

      await runJson(testDir, {});
      await runJson(testDir, {});

      expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).toHaveBeenCalledTimes(2);
      const [first, second] = spawnRecorder.requests.map((request) => request.env?.TSX_TSCONFIG_PATH);
      expect(first).toBeTruthy();
      expect(second).not.toBe(first);
    });
  });

  it('allows the spawn-only skipSharedDepsBuild option with a borrowed spec', async () => {
    await withTestDir(async (testDir) => {
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce(nextGeneration(testDir));
      const prepared = await resolveCliJsonLaunchSpec({ testDir, env: {} });

      await runJson(testDir, {}, { preparedCliLaunchSpec: prepared, launchOptions: { skipSharedDepsBuild: true } });

      expect(spawnRecorder.requests[0]?.env?.HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD).toBe('1');
    });
  });

  it.each<{ label: string; message: RegExp; env: NodeJS.ProcessEnv; extra: (prepared: PreparedCliJsonLaunchSpec) => Pick<Parameters<typeof runCliJson>[0], 'launchOptions' | 'preparedCliLaunchSpec'> }>([
    {
      label: 'launchOptions.preferSourceEntrypoint',
      message: /cannot be combined with launchOptions\.preferSourceEntrypoint/,
      env: {},
      extra: (prepared) => ({ preparedCliLaunchSpec: prepared, launchOptions: { preferSourceEntrypoint: true } }),
    },
    {
      label: 'launchOptions.skipSourceFreshnessCheck',
      message: /cannot be combined with launchOptions\.skipSourceFreshnessCheck/,
      env: {},
      extra: (prepared) => ({ preparedCliLaunchSpec: prepared, launchOptions: { skipSourceFreshnessCheck: false } }),
    },
    {
      label: 'a different entrypoint mode',
      message: /cliSourceEntrypoint=false but this run has .*cliSourceEntrypoint=true/,
      env: { ...SOURCE_ENV },
      extra: (prepared) => ({ preparedCliLaunchSpec: prepared }),
    },
    {
      label: 'a spec from another helper',
      message: /must come from resolveCliJsonLaunchSpec/,
      env: {},
      extra: (prepared) => ({ preparedCliLaunchSpec: { ...prepared, kind: 'cli-terminal-connect' } as unknown as PreparedCliJsonLaunchSpec }),
    },
  ])('rejects a borrowed spec combined with $label before running', async ({ message, env, extra }) => {
    await withTestDir(async (testDir) => {
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce(nextGeneration(testDir));
      const prepared = await resolveCliJsonLaunchSpec({ testDir, env: {} });
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockClear();

      await expect(runJson(testDir, env, extra(prepared))).rejects.toThrow(message);

      expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).not.toHaveBeenCalled();
      expect(spawnRecorder.requests).toEqual([]);
    });
  });
});
