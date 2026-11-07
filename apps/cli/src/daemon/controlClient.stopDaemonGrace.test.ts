import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDirSync, removeTempDirSync } from '@/testkit/fs/tempDir';

vi.mock('@/daemon/doctor', () => ({
  findHappyProcessByPid: async () => ({ type: 'daemon' as const }),
}));

describe('stopDaemon: graceful wait before force kill', () => {
  let envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_DAEMON_HTTP_TIMEOUT',
    'HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS',
  ]);

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    envScope.restore();
    envScope = createEnvKeyScope([
      'HAPPIER_HOME_DIR',
      'HAPPIER_DAEMON_HTTP_TIMEOUT',
      'HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS',
    ]);
  });

  it('uses HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS to avoid force killing during slow shutdown', async () => {
    const homeDir = createTempDirSync('happier-cli-daemon-stop-grace-');
    envScope.patch({
      HAPPIER_HOME_DIR: homeDir,
      HAPPIER_DAEMON_HTTP_TIMEOUT: '1000',
      HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS: '5000',
    });

    const daemonPid = 12345;
    const daemonPort = 43210;

    let alive = true;
    const realKill = process.kill.bind(process);

    try {
      vi.resetModules();

      let stopDaemonFetchResolve: (() => void) | null = null;
      const stopDaemonFetchCalled = new Promise<void>((resolve) => {
        stopDaemonFetchResolve = resolve;
      });

      let fetchCallCount = 0;
      const fetchMock = vi.fn(async (input: any, _init?: any) => {
        fetchCallCount += 1;
        if (fetchCallCount === 2) stopDaemonFetchResolve?.();

        const url = new URL(typeof input === 'string' ? input : input.url);
        if (url.hostname !== '127.0.0.1') {
          throw new Error(`Unexpected fetch hostname: ${url.hostname}`);
        }
        if (Number(url.port) !== daemonPort) {
          throw new Error(`Unexpected fetch port: ${url.port}`);
        }
        if (url.pathname === '/ping') {
          if (!alive) throw Object.assign(new Error('Control closed'), { cause: { code: 'ECONNREFUSED' } });
          return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
        }
        if (url.pathname !== '/stop') {
          throw new Error(`Unexpected fetch path: ${url.pathname}`);
        }

        return new Response(JSON.stringify({ status: 'stopping' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const [{ configuration }, controlClient] = await Promise.all([
        import('@/configuration'),
        import('./controlClient'),
      ]);
      const { stopDaemon, stopDaemonHttp } = controlClient;
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-05T00:00:00.000Z'));
      expect(process.env.HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS).toBe('5000');

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: any) => {
        if (pid !== daemonPid) {
          return realKill(pid as any, signal as any);
        }

        if (signal === 0) {
          if (!alive) {
            throw Object.assign(new Error('process does not exist'), { code: 'ESRCH' });
          }
          return undefined as any;
        }

        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          alive = false;
          return undefined as any;
        }

        return undefined as any;
      }) as any);

      mkdirSync(dirname(configuration.daemonStateFile), { recursive: true });
      writeFileSync(
        configuration.daemonStateFile,
        JSON.stringify(
          {
            pid: daemonPid,
            httpPort: daemonPort,
            startedAt: Date.now(),
            startedWithCliVersion: '0.0.0-test',
            controlToken: 'token-123',
          },
          null,
          2,
        ),
        'utf-8',
      );

      const { existsSync } = await import('node:fs');
      expect(existsSync(configuration.daemonStateFile)).toBe(true);

      const {
        readDaemonState,
        writeConnectedServiceBrokerState,
        writeDaemonState,
      } = await import('@/persistence');
      const persisted = await readDaemonState();
      expect(persisted?.pid).toBe(daemonPid);

      expect(typeof AbortSignal.timeout).toBe('function');
      expect(AbortSignal.timeout(1)).toBeInstanceOf(AbortSignal);

      // Sanity: confirm the HTTP stop path actually hits fetch (otherwise the test could pass vacuously).
      await stopDaemonHttp();
      expect(fetchMock).toHaveBeenCalled();

      setTimeout(() => {
        alive = false;
        writeDaemonState({
          pid: daemonPid + 1,
          httpPort: daemonPort + 1,
          startedAt: Date.now() + 1,
          startedWithCliVersion: '0.0.0-test',
          runtimeId: 'runtime-successor',
          controlToken: 'successor-control-token',
        });
        writeConnectedServiceBrokerState({
          httpPort: daemonPort + 1,
          connectedServiceBrokerRefreshToken: 'successor-broker-capability',
        });
      }, 3000);

      const stopPromise = stopDaemon();
      await stopDaemonFetchCalled;
      await vi.advanceTimersByTimeAsync(3100);
      expect(alive).toBe(false);
      await stopPromise;

      expect(fetchMock).toHaveBeenCalled();
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(readFileSync(configuration.daemonStateFile, 'utf8'))).toMatchObject({
        pid: daemonPid + 1,
        runtimeId: 'runtime-successor',
      });
      expect(JSON.parse(readFileSync(configuration.connectedServiceBrokerStateFile, 'utf8'))).toEqual({
        httpPort: daemonPort + 1,
        connectedServiceBrokerRefreshToken: 'successor-broker-capability',
      });

      const forceSignals = killSpy.mock.calls
        .map(([, signal]) => signal)
        .filter((signal) => signal === 'SIGTERM' || signal === 'SIGKILL');
      expect(forceSignals).toEqual([]);
    } finally {
      removeTempDirSync(homeDir);
    }
  });

});
