import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageState } from '@/sync/store/types';

async function importFresh() {
    vi.resetModules();
    return await import('./pendingSetupIntent');
}

async function activateServerAccount(serverUrl: string, accountId: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

    const server = upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    const scope = createServerAccountScope(server.id, accountId);
    expect(scope).not.toBeNull();
    registerStorageStateReader(() => ({ profileScope: scope } as unknown as StorageState));
}

async function activateServerWithoutAccount(serverUrl: string) {
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

    upsertAndActivateServer({
        serverUrl,
        source: 'manual',
        scope: 'device',
        replaceEquivalentStoredUrl: true,
    });
    registerStorageStateReader(() => ({ profileScope: null } as unknown as StorageState));
}

describe('pendingSetupIntent', () => {
    afterEach(async () => {
        const { clearPendingSetupIntent } = await importFresh();
        clearPendingSetupIntent();
        vi.restoreAllMocks();
    });

    it('round-trips and clears a pending setup intent payload', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerAccount('https://relay.example.test', 'account-a');
        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();

        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('round-trips a pending setup intent before an account scope exists', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerWithoutAccount('https://relay.example.test');
        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();

        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('keeps an unauthenticated pending setup intent readable after account scope appears', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerWithoutAccount('https://relay.example.test');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test/',
        });

        await activateServerAccount('https://relay.example.test', 'account-a');

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.example.test',
        });

        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('reads a marker persisted as dismissed by an older build as no intent at all', async () => {
        // The phase was removed because nothing ever distinguished it from absence; a record an
        // older build wrote must therefore read as absence rather than as an unknown state.
        const { fromRecord } = await import('./pendingSetupIntent.shared');

        expect(fromRecord({
            branch: 'thisComputer',
            phase: 'dismissed',
            relayUrl: 'https://relay.example.test',
            createdAtMs: Date.now(),
        })).toBeNull();
    });

    it('round-trips a remote machine resume intent', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerAccount('https://relay.remote.example.test', 'account-a');
        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test/',
            machineId: 'machine-remote-1',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://relay.remote.example.test',
            machineId: 'machine-remote-1',
        });

        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('keeps setup intent payloads isolated by active server', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerAccount('https://setup-a.example.test', 'account-a');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-a.example.test',
        });

        await activateServerAccount('https://setup-b.example.test', 'account-a');
        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-b.example.test',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-b.example.test',
        });

        await activateServerAccount('https://setup-a.example.test', 'account-a');
        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-a.example.test',
        });
    });

    it('keeps setup intent payloads isolated by active account on the same server', async () => {
        const { clearPendingSetupIntent, getPendingSetupIntent, setPendingSetupIntent } = await importFresh();

        await activateServerAccount('https://shared.example.test', 'account-a');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
        });

        await activateServerAccount('https://shared.example.test', 'account-b');
        clearPendingSetupIntent();
        expect(getPendingSetupIntent()).toBeNull();
        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
            machineId: 'machine-b',
        });

        expect(getPendingSetupIntent()).toEqual({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
            machineId: 'machine-b',
        });

        await activateServerAccount('https://shared.example.test', 'account-a');
        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://shared.example.test',
        });
    });

    it('absorbs a host-derived scoped setup intent into an identity scope', async () => {
        const {
            getPendingSetupIntent,
            migratePendingSetupIntentScopes,
            setPendingSetupIntent,
        } = await importFresh();
        const { createServerAccountScope } = await import('@/sync/domains/scope/serverAccountScope');
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        const { registerStorageStateReader } = await import('@/sync/domains/state/storageStateReaderBridge');

        await activateServerAccount('https://identity-setup.example.test', 'account-a');
        setPendingSetupIntent({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://identity-setup.example.test',
        });

        setServerProfileIdentityForUrl('https://identity-setup.example.test', 'srv_identity_setup');
        const legacyScope = createServerAccountScope('identity-setup.example.test', 'account-a');
        const identityScope = createServerAccountScope('srv_identity_setup', 'account-a');
        expect(legacyScope).not.toBeNull();
        expect(identityScope).not.toBeNull();
        registerStorageStateReader(() => ({ profileScope: identityScope } as unknown as StorageState));

        migratePendingSetupIntentScopes(identityScope!, [legacyScope!]);

        expect(getPendingSetupIntent()).toEqual({
            branch: 'thisComputer',
            phase: 'awaiting_auth',
            relayUrl: 'https://identity-setup.example.test',
        });
        registerStorageStateReader(() => ({ profileScope: legacyScope } as unknown as StorageState));
        expect(getPendingSetupIntent()).toBeNull();
    });
});
