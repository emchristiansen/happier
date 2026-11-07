import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CliTestLaunchSpec } from '../process/cliLaunchSpec';

// Launch-spec production (snapshot generations) is the boundary a borrowed spec must not cross;
// its own per-call freshness is covered by the J078 resolver tests.
const cliLaunchSpecMock = vi.hoisted(() => ({ resolveCliTestLaunchSpec: vi.fn() }));
vi.mock('../process/cliLaunchSpec', async (original) => ({
  ...(await original<typeof import('../process/cliLaunchSpec')>()),
  resolveCliTestLaunchSpec: cliLaunchSpecMock.resolveCliTestLaunchSpec,
}));

// The daemon child is real; the recorder only observes the exact spawn request.
type SpawnRequest = Readonly<{ command: string; args: string[]; cwd?: string; env?: NodeJS.ProcessEnv }>;
const spawnRecorder = vi.hoisted(() => ({ requests: [] as SpawnRequest[] }));
vi.mock('../process/spawnProcess', async (original) => {
  const actual = await original<typeof import('../process/spawnProcess')>();
  return {
    ...actual,
    spawnLoggedProcess: (params: Parameters<typeof actual.spawnLoggedProcess>[0]) => {
      spawnRecorder.requests.push({ command: params.command, args: [...params.args], cwd: params.cwd, env: { ...params.env } });
      return actual.spawnLoggedProcess(params);
    },
  };
});

// Ownership leases live under the shared repository root; observe them instead of writing there.
const leaseMock = vi.hoisted(() => ({ sweep: vi.fn(async () => {}), register: vi.fn(async () => {}) }));
vi.mock('../process/processOwnershipLease', async (original) => ({
  ...(await original<typeof import('../process/processOwnershipLease')>()),
  sweepProcessOwnershipLeases: leaseMock.sweep,
  registerProcessOwnershipLease: leaseMock.register,
}));

import {
  resolveTestDaemonCliLaunchSpec,
  startTestDaemon,
  type PreparedTestDaemonCliLaunchSpec,
  type StartedDaemon,
} from './daemon';

afterEach(() => {
  cliLaunchSpecMock.resolveCliTestLaunchSpec.mockReset();
  leaseMock.sweep.mockClear();
  leaseMock.register.mockClear();
  spawnRecorder.requests = [];
});

async function withFixture<T>(run: (fixture: { testDir: string; homeDir: string }) => Promise<T>): Promise<T> {
  const testDir = await mkdtemp(join(tmpdir(), 'happier-daemon-borrowed-spec-'));
  const homeDir = resolve(testDir, 'home');
  await mkdir(homeDir, { recursive: true });
  try {
    return await run({ testDir, homeDir });
  } finally {
    await rm(testDir, { recursive: true, force: true });
  }
}

let generationCounter = 0;

// Each call stands for one freshly published generation holding a daemon that writes its state.
async function writeGeneration(testDir: string, httpPort: number): Promise<CliTestLaunchSpec> {
  generationCounter += 1;
  const generationDir = resolve(testDir, `cli-dist-generation-${generationCounter}`);
  const entrypoint = resolve(generationDir, 'dist', 'index.mjs');
  await mkdir(resolve(generationDir, 'dist'), { recursive: true });
  await writeFile(entrypoint, [
    "import { writeFileSync } from 'node:fs';",
    "import { resolve } from 'node:path';",
    "const homeDir = process.env.HAPPIER_HOME_DIR;",
    "if (!homeDir) throw new Error('Missing HAPPIER_HOME_DIR');",
    `writeFileSync(resolve(homeDir, 'daemon.state.json'), JSON.stringify({ pid: process.pid, httpPort: ${httpPort}, controlToken: 'fixture' }), 'utf8');`,
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => {}, 1_000);",
  ].join('\n'), 'utf8');
  return { command: process.execPath, args: [entrypoint], cwd: generationDir, env: { FIXTURE_GENERATION: generationDir } };
}

async function stopQuietly(daemon: StartedDaemon | null): Promise<void> {
  if (daemon) await daemon.stop().catch(() => {});
}

const SOURCE_ENV = { HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1' } as const;

describe('startTestDaemon borrowed launch spec', () => {
  it.each([
    { label: 'dist entrypoint env', env: {} as NodeJS.ProcessEnv },
    { label: 'source entrypoint env', env: { ...SOURCE_ENV } as NodeJS.ProcessEnv },
  ])('resolveTestDaemonCliLaunchSpec resolves exactly what startTestDaemon resolves ($label)', async ({ env }) => {
    await withFixture(async ({ testDir, homeDir }) => {
      const spec = await writeGeneration(testDir, 32_301);
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValue(spec);

      const daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, env, startupTimeoutMs: 15_000 });
      await daemon.stop();
      const prepared = await resolveTestDaemonCliLaunchSpec({ testDir, env });

      const [startCall, prepareCall] = cliLaunchSpecMock.resolveCliTestLaunchSpec.mock.calls;
      expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).toHaveBeenCalledTimes(2);
      expect(prepareCall).toEqual(startCall);
      expect(prepared.spec).toEqual(spec);
      expect(prepared).toMatchObject({ kind: 'test-daemon', testDir: resolve(testDir), cliSourceEntrypointRequested: 'HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT' in env });
      expect(Object.isFrozen(prepared) && Object.isFrozen(prepared.spec) && Object.isFrozen(prepared.spec.args)).toBe(true);
    });
  });

  it('launches a borrowed spec without resolving, spawns exactly as the resolved spec, and restart() reuses that generation', async () => {
    await withFixture(async ({ testDir, homeDir }) => {
      const env = { ...SOURCE_ENV, HAPPIER_TEST_ENV_PROBE: 'kept' };
      const spec = await writeGeneration(testDir, 32_302);
      let daemon: StartedDaemon | null = null;
      try {
        cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce(spec);
        daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, env, startupTimeoutMs: 15_000 });
        await daemon.stop();
        daemon = null;
        const resolvedSpawn = spawnRecorder.requests[0];

        cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce(spec);
        const prepared = await resolveTestDaemonCliLaunchSpec({ testDir, env });
        cliLaunchSpecMock.resolveCliTestLaunchSpec.mockClear();
        leaseMock.sweep.mockClear();
        leaseMock.register.mockClear();

        daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, env, preparedCliLaunchSpec: prepared, startupTimeoutMs: 15_000 });
        const firstPid = daemon.state.pid;
        await daemon.proc.stop();
        daemon = await daemon.restart();

        expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).not.toHaveBeenCalled();
        const [borrowedSpawn, restartSpawn] = spawnRecorder.requests.slice(1);
        expect(spawnRecorder.requests).toHaveLength(3);
        expect(resolvedSpawn).toEqual({
          command: spec.command,
          args: [...spec.args, 'daemon', 'start-sync'],
          cwd: spec.cwd,
          env: expect.objectContaining({ ...spec.env, HAPPIER_TEST_ENV_PROBE: 'kept', HAPPIER_HOME_DIR: homeDir }),
        });
        expect(borrowedSpawn).toEqual(resolvedSpawn);
        expect(restartSpawn).toEqual(resolvedSpawn);
        expect(daemon.state.pid).not.toBe(firstPid);
        // Ownership is unchanged: every borrowed launch still sweeps and registers its lease.
        expect(leaseMock.sweep).toHaveBeenCalledTimes(2);
        expect(leaseMock.register).toHaveBeenCalledTimes(2);
      } finally {
        await stopQuietly(daemon);
      }
    });
  });

  it('resolves a fresh generation for every start and restart without a borrowed spec', async () => {
    await withFixture(async ({ testDir, homeDir }) => {
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockImplementation(async () => await writeGeneration(testDir, 32_303));
      let daemon: StartedDaemon | null = null;
      try {
        daemon = await startTestDaemon({ testDir, happyHomeDir: homeDir, env: {}, startupTimeoutMs: 15_000 });
        await daemon.proc.stop();
        daemon = await daemon.restart();

        expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).toHaveBeenCalledTimes(2);
        const [firstEntrypoint, restartEntrypoint] = spawnRecorder.requests.map((request) => request.args[0]);
        expect(spawnRecorder.requests).toHaveLength(2);
        expect(restartEntrypoint).not.toBe(firstEntrypoint);
      } finally {
        await stopQuietly(daemon);
      }
    });
  });

  it.each<{
    label: string;
    message: RegExp;
    launch: (prepared: PreparedTestDaemonCliLaunchSpec, fixture: { testDir: string; homeDir: string }) => Parameters<typeof startTestDaemon>[0];
  }>([
    {
      label: 'an explicit snapshotDir',
      message: /cannot be combined with snapshotDir/,
      launch: (prepared, { testDir, homeDir }) => ({ testDir, happyHomeDir: homeDir, env: {}, preparedCliLaunchSpec: prepared, snapshotDir: resolve(testDir, 'other') }),
    },
    {
      label: 'preparedDistSnapshotOnly',
      message: /cannot be combined with preparedDistSnapshotOnly/,
      launch: (prepared, { testDir, homeDir }) => ({ testDir, happyHomeDir: homeDir, env: {}, preparedCliLaunchSpec: prepared, preparedDistSnapshotOnly: false }),
    },
    {
      label: 'a different testDir',
      message: /was resolved for testDir=.*but this launch has testDir=/,
      launch: (prepared, { testDir, homeDir }) => ({ testDir: resolve(testDir, 'other-test'), happyHomeDir: homeDir, env: {}, preparedCliLaunchSpec: prepared }),
    },
    {
      label: 'a different entrypoint mode',
      message: /cliSourceEntrypoint=false but this launch has .*cliSourceEntrypoint=true/,
      launch: (prepared, { testDir, homeDir }) => ({ testDir, happyHomeDir: homeDir, env: { ...SOURCE_ENV }, preparedCliLaunchSpec: prepared }),
    },
    {
      label: 'a spec from another helper',
      message: /must come from resolveTestDaemonCliLaunchSpec/,
      launch: (prepared, { testDir, homeDir }) => ({
        testDir,
        happyHomeDir: homeDir,
        env: {},
        preparedCliLaunchSpec: { ...prepared, kind: 'cli-json' } as unknown as PreparedTestDaemonCliLaunchSpec,
      }),
    },
  ])('rejects a borrowed spec combined with $label before any side effect', async ({ launch, message }) => {
    await withFixture(async (fixture) => {
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockResolvedValueOnce(await writeGeneration(fixture.testDir, 32_304));
      const prepared = await resolveTestDaemonCliLaunchSpec({ testDir: fixture.testDir, env: {} });
      cliLaunchSpecMock.resolveCliTestLaunchSpec.mockClear();

      await expect(startTestDaemon(launch(prepared, fixture))).rejects.toThrow(message);

      expect(cliLaunchSpecMock.resolveCliTestLaunchSpec).not.toHaveBeenCalled();
      expect(leaseMock.sweep).not.toHaveBeenCalled();
      expect(spawnRecorder.requests).toEqual([]);
    });
  });
});
