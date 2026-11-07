import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot, setActiveServer, upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createServerFetchWithReachabilityProbe } from '@/dev/testkit/mocks/serverFetch';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { ConnectedServiceImportView } from './ConnectedServiceImportView';

const machineRpc = vi.hoisted(() => vi.fn());
const alert = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key) => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { alert } }).module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: { serviceId: 'openai-codex', profileId: 'native-work' },
}).module);

describe('native login import machine flow', () => {
    const initialState = storage.getState();
    const originalServerId = getActiveServerSnapshot().serverId;
    let testServerId = '';
    beforeEach(async () => {
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED', 'true');
        machineRpc.mockReset();
        alert.mockClear();
        resetServerFeaturesClientForTests();
        const features = FeaturesResponseSchema.parse(createRootLayoutFeaturesResponse({
            features: { connectedServices: { enabled: true } },
        }));
        const fetchBoundary = vi.fn(createServerFetchWithReachabilityProbe(async () => new Response(JSON.stringify(features), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        })));
        vi.stubGlobal('fetch', fetchBoundary);
        setRuntimeFetch(fetchBoundary as typeof fetch);
        testServerId = upsertAndActivateServer({ serverUrl: 'https://native-import.example.test', name: 'Native import test' }).id;
        const { serverId } = getActiveServerSnapshot();
        const machine = createMachineFixture({ id: 'import-machine', activeAt: Date.now() });
        storage.setState({
            isDataReady: true,
            profileScope: { serverId, accountId: 'account-import' },
            settings: { ...initialState.settings, experiments: true, featureToggles: { ...initialState.settings.featureToggles, connectedServices: true } },
            machines: { [machine.id]: machine },
            machineListByServerId: { [serverId]: [machine] },
        });
        const snapshot = await getServerFeaturesSnapshot({ force: true });
        if (snapshot.status !== 'ready') {
            throw new Error(JSON.stringify({ snapshot, server: getActiveServerSnapshot(), requests: fetchBoundary.mock.calls.map(([url]) => String(url)) }));
        }
    });
    afterEach(() => {
        standardCleanup();
        storage.setState(initialState);
        if (testServerId) removeServerProfile(testServerId);
        if (originalServerId) setActiveServer({ serverId: originalServerId });
        vi.unstubAllGlobals();
        resetRuntimeFetch();
        vi.unstubAllEnvs();
        resetServerFeaturesClientForTests();
    });

    it('discovers only after machine selection and preserves choices when native credentials are unavailable', async () => {
        machineRpc.mockResolvedValueOnce({ ok: true, op: 'discover', sources: [{ id: 'native', label: 'Codex login' }] });
        machineRpc.mockResolvedValueOnce({ ok: false, errorCode: 'credentials_unavailable', error: 'Login unavailable.' });
        const screen = await renderScreen(<ConnectedServiceImportView />);
        expect(machineRpc).not.toHaveBeenCalled();
        await act(async () => { screen.findByType(DropdownMenu).props.onSelect('import-machine'); });
        await act(async () => { await vi.waitFor(() => expect(screen.findHostByTestId('connectedServices.import.source:native')).not.toBeNull()); });
        expect(screen.findHostByTestId('connectedServices.import.source:native')?.props.accessibilityState?.checked).toBe(true);
        expect(screen.findHostByTestId('connectedServices.import.submit')?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('connectedServices.import.submit');
        await act(async () => { await vi.waitFor(() => expect(alert).toHaveBeenCalledWith('common.error', 'connectedServices.importAccounts.credentialsUnavailable')); });
        expect(machineRpc.mock.calls.at(-1)?.[0].payload).toMatchObject({ op: 'import', source: 'native' });
        expect(screen.findHostByTestId('connectedServices.import.source:native')).not.toBeNull();
        expect(screen.findHostByTestId('connectedServices.import.submit')?.props.disabled).not.toBe(true);
        await act(async () => screen.tree.unmount());
    });

    it('prevents a second import when the daemon cannot determine whether storage committed', async () => {
        machineRpc.mockResolvedValueOnce({ ok: true, op: 'discover', sources: [{ id: 'native', label: 'Codex login' }] });
        machineRpc.mockResolvedValueOnce({ ok: false, errorCode: 'storage_result_unknown', error: 'Result unknown.' });
        const screen = await renderScreen(<ConnectedServiceImportView />);
        await act(async () => { screen.findByType(DropdownMenu).props.onSelect('import-machine'); });
        await act(async () => { await vi.waitFor(() => expect(screen.findHostByTestId('connectedServices.import.source:native')).not.toBeNull()); });
        expect(screen.findHostByTestId('connectedServices.import.submit')?.props.disabled).not.toBe(true);
        await screen.pressByTestIdAsync('connectedServices.import.submit');
        await act(async () => { await vi.waitFor(() => expect(alert, JSON.stringify(machineRpc.mock.calls)).toHaveBeenCalled()); });
        expect(screen.findHostByTestId('connectedServices.import.submit')?.props.disabled).toBe(true);
        expect(screen.findHostByTestId('connectedServices.import.refresh')).not.toBeNull();
        await act(async () => screen.tree.unmount());
    });
});
