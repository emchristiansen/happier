import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StorageState } from '@/sync/store/types';

type StorageLike = {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
};

function createLocalStorage(): StorageLike {
    const map = new Map<string, string>();
    return {
        getItem: (key) => (map.has(key) ? map.get(key)! : null),
        setItem: (key, value) => {
            map.set(key, value);
        },
        removeItem: (key) => {
            map.delete(key);
        },
    };
}

async function importFreshWeb() {
    vi.resetModules();
    return await import('./pendingSetupIntent.web');
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

describe('pendingSetupIntent.web', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', createLocalStorage());
    });

    afterEach(async () => {
        const { clearPendingSetupIntent } = await importFreshWeb();
        clearPendingSetupIntent();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it.each([
        ['default', undefined, 24 * 60 * 60 * 1000],
        ['configured', '1000', 1000],
    ] as const)('expires a warmed setup intent after its %s TTL without changing persisted bytes', async (_label, configuredTtl, ttl) => {
        vi.stubEnv('EXPO_PUBLIC_PENDING_SETUP_INTENT_TTL_MS', configuredTtl);
        const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
        const createdAt = Date.now();
        const { clearPendingSetupIntent, setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();
        await activateServerAccount('https://setup-expiry.example.test', 'account-a');
        clearPendingSetupIntent();
        setPendingSetupIntent({
            branch: 'remoteMachine',
            phase: 'awaiting_auth',
            relayUrl: 'https://setup-expiry.example.test',
            machineId: 'machine-expiry',
        });

        now.mockReturnValue(createdAt + 1);
        const snapshot = getPendingSetupIntent();
        expect(snapshot).not.toBeNull();
        now.mockReturnValue(createdAt + ttl);
        expect(getPendingSetupIntent()).toBe(snapshot);

        now.mockReturnValue(createdAt + ttl + 1);
        expect(getPendingSetupIntent()).toBeNull();
        // Expiry removes the persisted record; moving the clock back cannot revive it.
        now.mockReturnValue(createdAt + 1);
        expect(getPendingSetupIntent()).toBeNull();
    });

    it('round-trips a pending setup intent payload on web', async () => {
        const { setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();

        await activateServerAccount('https://relay.example.test', 'account-a');
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
    });

    it('round-trips a pending setup intent before an account scope exists on web', async () => {
        const { clearPendingSetupIntent, setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();

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
    });

    it('keeps an unauthenticated pending setup intent readable after account scope appears on web', async () => {
        const { clearPendingSetupIntent, setPendingSetupIntent, getPendingSetupIntent } = await importFreshWeb();

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
    });

    it('keeps setup intent payloads isolated by active account on web', async () => {
        const { setPendingSetupIntent, getPendingSetupIntent, clearPendingSetupIntent } = await importFreshWeb();

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
});
