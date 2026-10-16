import { describe, expect, it, vi } from 'vitest';

import { startConnectedServiceRefreshLoop } from './startConnectedServiceRefreshLoop';
import { logger } from '@/ui/logger';
import { startConnectedServiceRefreshStartup } from '../startup/refreshStartup';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import type { ApiClient } from '@/api/api';
import packageJson from '../../../../package.json';

describe('startConnectedServiceRefreshLoop', () => {
    it('disposes observations when initial target registration fails and preserves the original error', () => {
        const file = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const registry = new ConnectedServiceRuntimeRegistry();
        const originalError = new Error('initial registration failed');
        try {
            expect(() => startConnectedServiceRefreshStartup({
                env: {}, api: {} as ApiClient,
                credentials: { token: 'unused', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
                runtimeRegistry: registry, machineId: 'machine-test', runtimeId: 'runtime-test', activeServerDir: '/unused', baseDir: '/unused',
                parseBooleanEnv: (_raw, fallback) => fallback, resolvePositiveIntEnv: (_raw, fallback) => fallback,
                accountSettingsProvider: () => null, onCredentialHealthNotification: () => {}, onTickError: vi.fn(),
                registerCurrentTargets: () => { throw originalError; },
            })).toThrow(originalError);
            file.mockClear();
            registry.registerTarget({ pid: 124, agentId: 'codex', materializationKey: 'registered-after-failure',
                connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } } } });
            expect(file).not.toHaveBeenCalled();
        } finally {
            file.mockRestore();
        }
    });

    it('writes pending and lifecycle observations only to the file sink, even if that sink fails', async () => {
        vi.useFakeTimers();
        const file = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const info = vi.spyOn(logger, 'info');
        const warn = vi.spyOn(logger, 'warn');
        let finish!: () => void;
        const pending = new Promise<void>((resolve) => { finish = resolve; });
        const coordinator = { tickOnce: vi.fn(() => pending) };
        const handle = startConnectedServiceRefreshLoop({ enabled: true, tickMs: 10, coordinator, onTickError: vi.fn() });
        try {
            await vi.advanceTimersByTimeAsync(20);
            expect(file).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: 'skipped', reason: 'in_flight', elapsedMs: 20 }));
            file.mockImplementation(() => { throw new Error('file sink unavailable'); });
            handle?.pause();
            handle?.resume();
            finish();
            await vi.advanceTimersByTimeAsync(10);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(2);
            expect(info).not.toHaveBeenCalled();
            expect(warn).not.toHaveBeenCalled();
        } finally {
            handle?.stop();
            file.mockRestore(); info.mockRestore(); warn.mockRestore();
            vi.useRealTimers();
        }
    });

    it.each([true, false])('records startup provenance with a failing sink and disposes registration observations (enabled=%s)', async (enabled) => {
        vi.useFakeTimers();
        const file = vi.spyOn(logger, 'infoFile').mockImplementation(() => { throw new Error('file sink unavailable'); });
        // Empty registry requires no network calls; the API boundary must remain unused.
        const api = {} as ApiClient;
        const registry = new ConnectedServiceRuntimeRegistry();
        const startup = startConnectedServiceRefreshStartup({
            env: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: String(enabled),
                HAPPIER_CONNECTED_SERVICES_REFRESH_TICK_MS: '15000', HAPPIER_CONNECTED_SERVICES_REFRESH_WINDOW_MS: '45000',
                HAPPIER_CONNECTED_SERVICES_REFRESH_LEASE_MS: '20000', HAPPIER_CONNECTED_SERVICES_REFRESH_LEASE_CONTENTION_WAIT_MAX_MS: '1234',
                PRIVATE_TOKEN: 'startup-secret-must-not-be-logged' },
            api, credentials: { token: 'credential-secret-must-not-be-logged', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            runtimeRegistry: registry, machineId: 'machine-test', runtimeId: 'runtime-test', activeServerDir: '/unused', baseDir: '/unused',
            parseBooleanEnv: (raw, fallback) => raw === undefined ? fallback : raw === 'true',
            resolvePositiveIntEnv: (raw, fallback) => raw === undefined ? fallback : Number(raw),
            accountSettingsProvider: () => null, onCredentialHealthNotification: () => {}, registerCurrentTargets: () => {}, onTickError: vi.fn(),
        });
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(file).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
                event: 'startup', enabled, cliVersion: packageJson.version, executablePath: process.execPath,
                entrypoint: process.argv[1] ?? null, runtimeVersion: process.version, pid: process.pid, runtimeId: 'runtime-test',
                runtimeName: 'node', nodeCompatibilityVersion: process.version, isEmbeddedBundle: false,
                ...(enabled ? { tickMs: 15000, refreshWindowMs: 45000, refreshLeaseMs: 20000, leaseContentionWaitMaxMs: 1234 } : {}),
            }));
            if (enabled) expect(file).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: 'tick_started', targetCount: 0, bindingCount: 0 }));
            const emitted = JSON.stringify(file.mock.calls);
            expect(emitted).not.toContain('startup-secret-must-not-be-logged');
            expect(emitted).not.toContain('credential-secret-must-not-be-logged');
            if (enabled) {
                registry.registerTarget({ pid: 123, agentId: 'codex', materializationKey: 'registered-during-startup',
                    connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } } } });
                expect(file).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ event: 'target_registered', pid: 123 }));
            }
            startup.loopHandle?.stop();
            file.mockClear();
            registry.registerTarget({ pid: 124, agentId: 'codex', materializationKey: 'registered-after-stop',
                connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: { 'openai-codex': { source: 'connected', profileId: 'work' } } } });
            expect(file).not.toHaveBeenCalled();
        } finally {
            startup.loopHandle?.stop();
            file.mockRestore(); vi.useRealTimers();
        }
    });

    it('runs an initial reconcile without waiting for the first interval', async () => {
        vi.useFakeTimers();
        try {
            const coordinator = {
                tickOnce: vi.fn(async () => {}),
            };

            const handle = startConnectedServiceRefreshLoop({
                enabled: true,
                tickMs: 60_000,
                coordinator,
                onTickError: vi.fn(),
            });

            expect(handle).not.toBeNull();
            await Promise.resolve();
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);

            handle?.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('runs refresh ticks on the configured interval', async () => {
        vi.useFakeTimers();
        try {
            const coordinator = {
                tickOnce: vi.fn(async () => {}),
            };

            const handle = startConnectedServiceRefreshLoop({
                enabled: true,
                tickMs: 50,
                coordinator,
                onTickError: vi.fn(),
            });

            expect(handle).not.toBeNull();
            await vi.advanceTimersByTimeAsync(50);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(2);

            handle?.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('pauses ticks until resume() is called', async () => {
        vi.useFakeTimers();
        try {
            const coordinator = {
                tickOnce: vi.fn(async () => {}),
            };

            const handle = startConnectedServiceRefreshLoop({
                enabled: true,
                tickMs: 50,
                coordinator,
                onTickError: vi.fn(),
            });

            await Promise.resolve();
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);

            handle?.pause();
            await vi.advanceTimersByTimeAsync(150);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);

            handle?.resume();
            await vi.advanceTimersByTimeAsync(50);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(2);

            handle?.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('backs off repeated refresh attempts while the server is unavailable', async () => {
        vi.useFakeTimers();
        try {
            const coordinator = {
                tickOnce: vi.fn(async () => {
                    throw new Error('server unavailable');
                }),
            };
            const onTickError = vi.fn();

            const handle = startConnectedServiceRefreshLoop({
                enabled: true,
                tickMs: 50,
                coordinator,
                onTickError,
            });

            await vi.advanceTimersByTimeAsync(50);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);
            expect(onTickError).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(1000);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(4000);
            expect(coordinator.tickOnce).toHaveBeenCalledTimes(2);

            handle?.stop();
        } finally {
            vi.useRealTimers();
        }
    });
});
