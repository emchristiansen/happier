import { beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveDaemonStateCandidatePaths } from './ownership/daemonOwnershipPaths';
import { configuration } from '@/configuration';
import { waitForProcessExit } from '@/testkit/process/spawn';
import { reserveEphemeralPort, waitForHttpReady } from '@/testkit/http/portUtils';
import { spawnSleepyDetachedProcess, spawnStoppableHttpDaemon, withConfiguredDaemonTestHome, writeDaemonStateFixture } from './testkit/fakeDaemonLifecycle.testkit';

let controlClient: typeof import('./controlClient');
let multiDaemon: typeof import('./multiDaemon');
let daemonCommand: typeof import('@/cli/commands/daemon');
beforeAll(async () => {
  [controlClient, multiDaemon, daemonCommand] = await Promise.all([import('./controlClient'), import('./multiDaemon'), import('@/cli/commands/daemon')]);
}, 300_000);

// The HTTP service and child are real. Only the caller's PID namespace is an OS boundary fixture.
describe('confirmed stop across a hidden daemon PID namespace', () => {


  it.each(['state', 'lock'] as const)('ignores an unchanged stale %s sibling after a hidden owner stops', async (kind) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-stale-sibling-' }, async ({ homeDir }) => {
      const exited = spawnSleepyDetachedProcess();
      expect(await exited.kill()).toBe(true);
      const legacyPath = resolveDaemonStateCandidatePaths({ serverDir: dirname(configuration.daemonStateFile), preferredRing: configuration.publicReleaseRing }).find(path => path !== configuration.daemonStateFile)!;
      if (kind === 'state') {
        await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: exited.pid, httpPort: 43123 });
        renameSync(configuration.daemonStateFile, legacyPath);
      }
      writeFileSync(`${legacyPath}.lock`, String(exited.pid));
      const oldLock = readFileSync(`${legacyPath}.lock`, 'utf8');
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', lockFile: configuration.daemonLockFile, stateFile: configuration.daemonStateFile });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        await expect(multiDaemon.stopAllDaemonsBestEffort()).resolves.toEqual({ status: 'stopped', stoppedCount: 1 });
        expect(readFileSync(`${legacyPath}.lock`, 'utf8')).toBe(oldLock);
        if (kind === 'state') expect(existsSync(legacyPath)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it.each([
    ['single', false], ['single', true], ['all', false], ['all', true],
  ] as const)('%s stop reports a genuinely exited published owner absent (stale lock: %s)', async (mode, staleLock) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-published-exited-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', ...(staleLock ? { lockFile: configuration.daemonLockFile } : {}) });
      const statePath = await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        expect(await child.kill()).toBe(true);
        await expect(mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort()).resolves.toEqual({ status: 'not_running' });
        expect(existsSync(statePath)).toBe(true);
      } finally {
        await child.kill();
      }
    });
  });
  it.each(['single', 'all'] as const)('%s stop cannot confirm hidden exit without an observed lifecycle lock', async (mode) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-no-lock-', env: { HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS: '0' } }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token' });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        await expect(mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: child.pid });
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it('keeps a successor startup lock fail-closed in the observed hidden publication scope', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-successor-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const successor = spawnSleepyDetachedProcess(['/repo/dist/index.mjs', 'daemon', 'start-sync']);
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', lockFile: configuration.daemonLockFile, stateFile: configuration.daemonStateFile, successorLockPid: successor.pid });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid || pid === successor.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        await expect(multiDaemon.stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: successor.pid });
        expect(readFileSync(configuration.daemonLockFile, 'utf8')).toBe(String(successor.pid));
        expect(realKill(successor.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
        await successor.kill();
      }
    });
  });
  it.each(['single', 'all'] as const)('%s stop keeps unreadable authenticated liveness incomplete', async (mode) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-ping-failure-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 500, { controlToken: 'owned-token', pingStatus: 500, lockFile: configuration.daemonLockFile });
      const statePath = await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        expect(await controlClient.inspectDaemonRunningStateAndCleanupStaleState()).toMatchObject({ status: 'starting', state: { pid: child.pid } });
        if (mode === 'single') {
          expect(await multiDaemon.readDaemonStateForServerId(configuration.activeServerId)).toMatchObject({ presence: 'unverified' });
          expect((await multiDaemon.listDaemonStatusesForAllKnownServers()).find(entry => entry.serverId === configuration.activeServerId)?.daemon).toMatchObject({ presence: 'unverified', staleStateFile: false });
        }
        if (mode === 'single') {
          const lines: string[] = [];
          const print = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
          const exit = vi.spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`exit:${code}`); });
          try {
            await expect(daemonCommand.handleDaemonCliCommand({ args: ['daemon', 'status', '--all'], rawArgv: [], terminalRuntime: null })).rejects.toThrow('exit:0');
            expect(lines.some(line => line.includes('Daemon: unverified'))).toBe(true);
          } finally {
            print.mockRestore();
            exit.mockRestore();
          }
        }
        await expect(mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: child.pid });
        expect(existsSync(statePath)).toBe(true);
        expect(realKill(child.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it.each([['single', 200], ['all', 200], ['single', 500], ['all', 500]] as const)('%s stop waits for lifecycle lock release after control closes (ping %s)', async (mode, pingStatus) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-lock-retained-', env: { HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS: '250' } }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', lockFile: configuration.daemonLockFile, stateFile: configuration.daemonStateFile, retainLockAfterControlClose: true, pingStatus });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        await expect(mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort()).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: child.pid });
        expect(existsSync(configuration.daemonLockFile)).toBe(true);
        expect(realKill(child.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it.each(['single', 'all'] as const)('%s stop refuses to report absence when authenticated control refuses shutdown', async (mode) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-refusal-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 500, { controlToken: 'owned-token', lockFile: configuration.daemonLockFile, stateFile: configuration.daemonStateFile });
      const statePath = await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const originalState = readFileSync(statePath, 'utf8');
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        if (mode === 'single') {
          expect(await multiDaemon.readDaemonStateForServerId(configuration.activeServerId)).toMatchObject({ running: true, state: { pid: child.pid } });
          expect((await multiDaemon.listDaemonStatusesForAllKnownServers()).find((entry) => entry.daemon.pid === child.pid)?.daemon.running).toBe(true);
        }
        const stop = mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort();
        await expect(stop).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: child.pid });
        expect(readFileSync(statePath, 'utf8')).toBe(originalState);
        expect(realKill(child.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it.each(['single', 'all'] as const)('%s stop verifies authenticated control ceased after accepted shutdown', async (mode) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-accepted-' }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', lockFile: configuration.daemonLockFile, stateFile: configuration.daemonStateFile });
      await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        const stop = mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort();
        await expect(stop).resolves.toEqual(mode === 'single' ? { status: 'stopped', method: 'graceful' } : { status: 'stopped', stoppedCount: 1 });
        vi.restoreAllMocks();
        expect(await waitForProcessExit(child.pid, { timeoutMs: 2_000 })).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });

  it.each(['single', 'all'] as const)('%s stop fails when an accepted shutdown keeps authenticated control live', async (mode) => {
    await withConfiguredDaemonTestHome({ prefix: 'daemon-hidden-unconfirmed-', env: { HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS: '0' } }, async ({ homeDir }) => {
      const port = await reserveEphemeralPort();
      const child = spawnStoppableHttpDaemon(port, 200, { controlToken: 'owned-token', exitOnStop: false, lockFile: configuration.daemonLockFile });
      const statePath = await writeDaemonStateFixture(homeDir, configuration.activeServerId, { pid: child.pid, httpPort: port, controlToken: 'owned-token' });
      const realKill = process.kill.bind(process);
      try {
        expect(await waitForHttpReady(port)).toBe(true);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
          if (pid === child.pid) throw Object.assign(new Error('PID hidden from caller'), { code: 'ESRCH' });
          return realKill(pid, signal);
        });
        const stop = mode === 'single' ? controlClient.stopDaemon() : multiDaemon.stopAllDaemonsBestEffort();
        await expect(stop).rejects.toMatchObject({ code: 'daemon_stop_incomplete', pid: child.pid });
        expect(existsSync(statePath)).toBe(true);
        expect(realKill(child.pid, 0)).toBe(true);
      } finally {
        vi.restoreAllMocks();
        await child.kill();
      }
    });
  });
});
