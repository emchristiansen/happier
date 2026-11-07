import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { waitForHttpReady, reserveEphemeralPort } from '@/testkit/http/portUtils';
import { waitForProcessExit } from '@/testkit/process/spawn';
import {
  spawnStoppableHttpDaemon,
  spawnSleepyDetachedProcess,
  withConfiguredDaemonTestHome,
  writeDaemonSettingsFixture,
  writeDaemonStateFixture,
} from '@/daemon/testkit/fakeDaemonLifecycle.testkit';

import { handleDaemonCliCommand } from './daemon';

describe('happier daemon --all', () => {
  it('stops daemons for all saved servers and reclaims their exact departed publication', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as any);

    try {
      await withConfiguredDaemonTestHome(
        {
          prefix: 'happier-daemon-all-',
          env: {
            HAPPIER_DAEMON_HTTP_TIMEOUT: '750',
          },
        },
        async ({ homeDir }) => {
          await writeDaemonSettingsFixture(homeDir);

          const port = await reserveEphemeralPort();
          const daemon = spawnStoppableHttpDaemon(port);
          expect(await waitForHttpReady(port, { timeoutMs: 2_000 })).toBe(true);

          const statePath = await writeDaemonStateFixture(homeDir, 'company', {
            pid: daemon.pid,
            httpPort: port,
          });
          expect(existsSync(statePath)).toBe(true);

          try {
            await expect(
              handleDaemonCliCommand({ args: ['daemon', 'stop', '--all'], rawArgv: [], terminalRuntime: null }),
            ).rejects.toThrow('process.exit(0)');

            expect(await waitForProcessExit(daemon.pid, { timeoutMs: 3_000 })).toBe(true);
            expect(existsSync(statePath)).toBe(false);
          } finally {
            await daemon.kill();
          }
        },
      );
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('preserves a successor publication that replaces the stopped owner', async () => {
    await withConfiguredDaemonTestHome({ prefix: 'happier-daemon-all-successor-' }, async ({ homeDir }) => {
      await writeDaemonSettingsFixture(homeDir);
      const port = await reserveEphemeralPort();
      const predecessor = spawnSleepyDetachedProcess();
      const statePath = await writeDaemonStateFixture(homeDir, 'company', {
        pid: predecessor.pid, httpPort: port, controlToken: 'predecessor-token',
      });
      const successorRaw = JSON.stringify({
        pid: process.pid, httpPort: 47891, startedAt: 1_754_000_000_000,
        startedWithCliVersion: '0.0.0-successor', controlToken: 'successor-token',
      }) + '\n';
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
        if (String(url).endsWith('/ping')) throw Object.assign(new Error('Control closed'), { cause: { code: 'ECONNREFUSED' } });
        process.kill(predecessor.pid, 'SIGTERM');
        writeFileSync(statePath, successorRaw, 'utf-8');
        return new Response(JSON.stringify({ ok: true }));
      });
      try {
        await expect(handleDaemonCliCommand({ args: ['daemon', 'stop', '--all'], rawArgv: [], terminalRuntime: null }))
          .rejects.toMatchObject({ code: 'daemon_stop_incomplete', reason: 'graceful_stop_unconfirmed', pid: process.pid });
        expect(await waitForProcessExit(predecessor.pid, { timeoutMs: 3_000 })).toBe(true);
        expect(readFileSync(statePath, 'utf-8')).toBe(successorRaw);
      } finally {
        fetchSpy.mockRestore();
        await predecessor.kill();
      }
    });
  });
});
