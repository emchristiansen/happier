import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { encodeBase64 } from '@/encryption/base64';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { Encryption } from '@/sync/encryption/encryption';
import { resetScopedMachineDataKeyCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';

import { createMachineFixture, createServerFetchWithReachabilityProbe, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { clearCachedMachineDoctorSnapshot, readCachedMachineDoctorSnapshot, writeCachedMachineDoctorSnapshot } from './cache/machineDoctorSnapshotCache';

const createSocket = vi.hoisted(() => vi.fn());
const getCredentials = vi.hoisted(() => vi.fn());
const createEncryption = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient', () => ({
    createEphemeralServerSocketClient: (...args: unknown[]) => createSocket(...args),
}));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/auth/storage/tokenStorage')>(),
    TokenStorage: { getCredentialsForServerUrl: (...args: unknown[]) => getCredentials(...args) },
}));
vi.mock('@/auth/encryption/createEncryptionFromAuthCredentials', () => ({
    createEncryptionFromAuthCredentials: (...args: unknown[]) => createEncryption(...args),
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key) => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-updates', () => ({
    isEnabled: false,
    updateId: null,
    createdAt: null,
    channel: null,
    runtimeVersion: null,
    isEmbeddedLaunch: true,
    useUpdates: () => ({}),
}));

afterEach(() => {
    standardCleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    createSocket.mockReset();
    getCredentials.mockReset();
    createEncryption.mockReset();
    resetScopedMachineDataKeyCacheForTests();
    storage.setState(storage.getInitialState(), true);
});

describe('SystemStatusView daemon attribution', () => {
    it.each(['other server', 'active server', 'missing target credentials'] as const)(
        'collects diagnostics with the selected machine server scope: %s', async (scenario) => {
            const active = upsertAndActivateServer({ serverUrl: 'https://diagnostics-a.example.test' });
            const other = upsertServerProfile({ serverUrl: 'https://diagnostics-b.example.test' });
            const target = scenario === 'active server' ? active : other;
            const machine = createMachineFixture({ id: 'diagnostics-machine', activeAt: Date.now() });
            const snapshot = {
                capturedAt: new Date().toISOString(),
                server: { activeServerId: target.id, serverUrl: target.serverUrl, publicServerUrl: target.serverUrl, webappUrl: target.serverUrl },
                accountId: 'diagnostics-account',
                settings: { activeServerId: target.id, servers: [], knownAccountIds: ['diagnostics-account'] },
            };
            clearCachedMachineDoctorSnapshot({ serverId: active.id, machineId: machine.id });
            clearCachedMachineDoctorSnapshot({ serverId: other.id, machineId: machine.id });
            storage.setState({
                isDataReady: true,
                machines: { [machine.id]: machine },
                machineListByServerId: { [target.id]: [machine] },
                machineListStatusByServerId: { [target.id]: 'idle' },
            });
            const activeRpc = vi.spyOn(apiSocket, 'machineRPC').mockImplementation(async () => {
                if (scenario === 'active server') return { doctorSnapshot: snapshot };
                throw new Error('Machine encryption not found on the active server');
            });
            getCredentials.mockResolvedValue(scenario === 'missing target credentials' ? null : { token: 'target-token', secret: 'target-secret' });
            createEncryption.mockResolvedValue(Encryption.createWithoutKeyMaterial());
            const plain = (value: unknown) => encodeBase64(new TextEncoder().encode(JSON.stringify({ t: 'plain', v: value })), 'base64');
            vi.stubGlobal('fetch', vi.fn(createServerFetchWithReachabilityProbe(async (input) => ({
                ok: true,
                json: async () => String(input).includes('/v1/account/encryption')
                    ? { mode: 'plain', updatedAt: 1 }
                    : [{ id: machine.id, dataEncryptionKey: plain(null) }],
            }))));
            const emitWithAck = vi.fn(async () => ({ ok: true, result: { doctorSnapshot: snapshot } }));
            const disconnect = vi.fn();
            createSocket.mockResolvedValue({ timeout: () => ({ emitWithAck }), disconnect });
            const { SystemStatusView } = await import('./SystemStatusView');
            const screen = await renderScreen(<SystemStatusView />);
            const machineRow = screen.find((row) => row.props.title === machine.metadata?.host && typeof row.props.onLongPress === 'function');
            await act(async () => {
                machineRow!.props.onLongPress();
                await vi.waitFor(() => {
                    if (scenario === 'missing target credentials') expect(getCredentials).toHaveBeenCalled();
                    else expect(readCachedMachineDoctorSnapshot({ serverId: target.id, machineId: machine.id })?.snapshot).toEqual(snapshot);
                });
            });
            expect(getActiveServerSnapshot().serverId).toBe(active.id);
            if (scenario === 'missing target credentials') {
                expect(readCachedMachineDoctorSnapshot({ serverId: target.id, machineId: machine.id })).toBeNull();
                expect(screen.getTextContent()).toContain('systemStatus.machine.fetchDoctorSnapshot.invalid');
                expect(createSocket).not.toHaveBeenCalled();
                expect(activeRpc).not.toHaveBeenCalled();
            } else {
                expect(screen.getTextContent()).toContain('systemStatus.machine.daemonAttribution');
                if (scenario === 'other server') {
                    expect(createSocket).toHaveBeenCalledWith(expect.objectContaining({ serverUrl: other.serverUrl, token: 'target-token', timeoutMs: 4_000 }));
                    expect(emitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.CALL, expect.objectContaining({ method: `${machine.id}:${RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS}`, params: {} }));
                    expect(disconnect).toHaveBeenCalled();
                    expect(activeRpc).not.toHaveBeenCalled();
                    expect(readCachedMachineDoctorSnapshot({ serverId: active.id, machineId: machine.id })).toBeNull();
                } else {
                    expect(activeRpc).toHaveBeenCalledWith(machine.id, RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, {}, expect.objectContaining({ timeoutMs: 4_000 }));
                    expect(createSocket).not.toHaveBeenCalled();
                }
            }
        },
    );

    it.each([
        ['root trailing slash', 'https://relay.example.com/', 'https://relay.example.com', 'account-1', false],
        ['default port and host casing', 'https://RELAY.example.com:443/', 'https://relay.example.com', 'account-1', false],
        ['path trailing slash', 'https://relay.example.com/relay/', 'https://relay.example.com/relay', 'account-1', false],
        ['loopback spelling', 'http://localhost:3005/relay', 'http://127.0.0.1:3005/relay/', 'account-1', false],
        ['different host', 'https://relay.example.com/', 'https://other.example.com', 'account-1', true],
        ['different path', 'https://relay.example.com/one', 'https://relay.example.com/two', 'account-1', true],
        ['different scheme', 'https://relay.example.com/', 'http://relay.example.com', 'account-1', true],
        ['different port', 'https://relay.example.com/', 'https://relay.example.com:8443', 'account-1', true],
        ['different account', 'https://relay.example.com/', 'https://relay.example.com', 'account-2', true],
        ['invalid URL', 'https://relay.example.com/', 'https://[invalid', 'account-1', true],
        ['invalid URL with different account', 'https://relay.example.com/', 'https://[invalid', 'account-2', true],
    ])('%s', async (_name, activeUrl, daemonUrl, daemonAccountId, mismatch) => {
        const server = upsertAndActivateServer({ serverUrl: activeUrl });
        // Keep the cached-attribution path real without issuing a machine RPC on mount.
        const machine = createMachineFixture({ active: false, activeAt: 0 });
        storage.setState({
            isDataReady: true,
            profile: { ...storage.getState().profile, id: 'account-1' },
            machines: { [machine.id]: machine },
            machineListByServerId: { [server.id]: [machine] },
            machineListStatusByServerId: { [server.id]: 'idle' },
        });
        writeCachedMachineDoctorSnapshot({
            serverId: server.id,
            machineId: machine.id,
            cachedAt: Date.now(),
            snapshot: {
                capturedAt: new Date().toISOString(),
                server: { activeServerId: server.id, serverUrl: daemonUrl, publicServerUrl: daemonUrl, webappUrl: daemonUrl },
                accountId: daemonAccountId,
                settings: { activeServerId: server.id, servers: [], knownAccountIds: [daemonAccountId] },
            },
        });

        const { SystemStatusView } = await import('./SystemStatusView');
        const screen = await renderScreen(<SystemStatusView />);
        const content = screen.getTextContent();
        expect(content).toContain('systemStatus.machine.daemonAttribution');
        expect(content.includes('systemStatus.mismatch')).toBe(mismatch);
    });
});
