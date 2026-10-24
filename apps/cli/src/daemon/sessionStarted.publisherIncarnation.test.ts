import { afterEach, describe, expect, it, vi } from 'vitest';

import { getRunnerPublisherIncarnationId } from '@/api/session/publisherIncarnation';
import type { Metadata } from '@/api/types';
import { reloadConfiguration } from '@/configuration';
import { clearDaemonStateForTests, writeDaemonState } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { notifyDaemonSessionStarted } from './controlClient';
import { createDaemonControlApp } from './controlServer';
import { createOnHappySessionWebhook } from './sessions/onHappySessionWebhook';
import type { TrackedSession } from './types';

describe('runner publisher incarnation reaches the daemon through /session-started', () => {
    let envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
    let tmpHomeDir: string | null = null;

    afterEach(async () => {
        vi.restoreAllMocks();
        await clearDaemonStateForTests();
        envScope.restore();
        envScope = createEnvKeyScope(['HAPPIER_HOME_DIR']);
        reloadConfiguration();
        if (tmpHomeDir) {
            await removeTempDir(tmpHomeDir);
            tmpHomeDir = null;
        }
    });

    it('records the reporting runner incarnation on the tracked session the daemon will later report as exited', async () => {
        const tracked: TrackedSession = { pid: 99995, startedBy: 'daemon' };
        const onHappySessionWebhook = createOnHappySessionWebhook({
            pidToTrackedSession: new Map([[tracked.pid, tracked]]),
            pidToAwaiter: new Map([[tracked.pid, vi.fn()]]),
            findHappyProcessByPidFn: async () => null,
            writeSessionMarkerFn: vi.fn(async () => {}),
        });
        const app = createDaemonControlApp({
            getChildren: () => [tracked],
            machineId: 'machine-1',
            stopSession: vi.fn(async () => ({ status: 'stopped' as const })),
            spawnSession: vi.fn(async () => ({
                type: 'error' as const,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'unused',
            })),
            requestShutdown: vi.fn(),
            onHappySessionWebhook,
            controlToken: 'control-token',
        });

        try {
            await app.listen({ port: 0, host: '127.0.0.1' });
            const address = app.server.address();
            if (!address || typeof address === 'string') throw new Error('Expected a bound control server');
            tmpHomeDir = await createTempDir('happier-session-started-incarnation-');
            envScope.patch({ HAPPIER_HOME_DIR: tmpHomeDir });
            reloadConfiguration();
            writeDaemonState({
                pid: process.pid,
                httpPort: address.port,
                startedAt: Date.now(),
                startedWithCliVersion: 'test',
                controlToken: 'control-token',
            });

            const result = await notifyDaemonSessionStarted('session-incarnation', {
                path: '/test/path',
                host: 'test-host',
                homeDir: '/test/home',
                happyHomeDir: '',
                happyLibDir: '/test/happy-lib',
                happyToolsDir: '/test/happy-tools',
                hostPid: tracked.pid,
                startedBy: 'daemon',
                machineId: 'machine-1',
            } satisfies Metadata);

            expect(result).toEqual({ status: 'ok' });
            expect(tracked.happySessionId).toBe('session-incarnation');
            expect(tracked.publisherIncarnationId).toBe(getRunnerPublisherIncarnationId());
        } finally {
            await app.close();
        }
    });
});
