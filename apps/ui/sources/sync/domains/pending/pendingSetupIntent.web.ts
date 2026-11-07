import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { serverAccountScopedStorageKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { readStorageScopeFromEnv, scopedStorageId } from '@/utils/system/storageScope';
import { emitPendingSetupIntentChanged, fromRecord, fromSerializedRecord, toRecord, type PendingSetupIntent } from './pendingSetupIntent.shared';
import {
    getActivePendingServerUrl,
    isPendingServerUrlActive,
    normalizePendingServerUrl,
    pendingServerScopedKey,
} from './pendingServerScopedKeys';

const STORAGE_KEY = scopedStorageId('pending-setup-intent-record', readStorageScopeFromEnv());
const STORAGE_KEY_PREFIX = scopedStorageId('pending-setup-intent-record:v2', readStorageScopeFromEnv());
const STORAGE_KEY_SERVER_PREFIX = scopedStorageId('pending-setup-intent-record:server:v1', readStorageScopeFromEnv());

function resolveIntentServerUrl(value: PendingSetupIntent): string | null {
    return normalizePendingServerUrl(value.relayUrl) ?? getActivePendingServerUrl();
}

function resolveActiveServerScopedKey(): string | null {
    const activeServerUrl = getActivePendingServerUrl();
    return activeServerUrl ? pendingServerScopedKey(STORAGE_KEY_SERVER_PREFIX, activeServerUrl) : null;
}

function getStorage(): Storage | null {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
}

function readRecord(storage: Storage, key: string): PendingSetupIntent | null {
    try {
        const raw = storage.getItem(key);
        if (!raw) return null;
        const record = fromSerializedRecord(raw);
        if (!record) {
            storage.removeItem(key);
            return null;
        }
        return record;
    } catch {
        storage.removeItem(key);
        return null;
    }
}

export function setPendingSetupIntent(value: PendingSetupIntent): void {
    const storage = getStorage();
    if (!storage) return;
    const activeScope = getActiveServerAccountScope();
    const serverUrl = resolveIntentServerUrl(value);
    if (!serverUrl || !isPendingServerUrlActive(serverUrl)) return;
    const record = toRecord({ ...value, relayUrl: normalizePendingServerUrl(value.relayUrl) ?? serverUrl });
    if (!record) return;
    try {
        if (activeScope) {
            storage.setItem(serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, activeScope), JSON.stringify(record));
            const serverScopedKey = resolveActiveServerScopedKey();
            if (serverScopedKey) storage.removeItem(serverScopedKey);
        } else {
            storage.setItem(pendingServerScopedKey(STORAGE_KEY_SERVER_PREFIX, serverUrl), JSON.stringify(record));
        }
    } catch {
        // ignore storage failures
    }
    emitPendingSetupIntentChanged();
}

export function getPendingSetupIntent(): PendingSetupIntent | null {
    const storage = getStorage();
    if (!storage) return null;
    const activeScope = getActiveServerAccountScope();
    if (activeScope) {
        const record = readRecord(storage, serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, activeScope));
        if (record) return record;
    }
    const serverScopedKey = resolveActiveServerScopedKey();
    return serverScopedKey ? readRecord(storage, serverScopedKey) : null;
}

export function clearPendingSetupIntent(): void {
    const storage = getStorage();
    if (!storage) return;
    try {
        const activeScope = getActiveServerAccountScope();
        if (activeScope) {
            storage.removeItem(serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, activeScope));
        }
        const serverScopedKey = resolveActiveServerScopedKey();
        if (serverScopedKey) {
            storage.removeItem(serverScopedKey);
        }
        const raw = storage.getItem(STORAGE_KEY);
        if (raw) {
            const record = fromRecord(JSON.parse(raw) as unknown);
            if (!record || !record.relayUrl || isPendingServerUrlActive(record.relayUrl)) {
                storage.removeItem(STORAGE_KEY);
            }
        }
    } catch {
        // ignore storage failures
    }
    emitPendingSetupIntentChanged();
}

export function migratePendingSetupIntentScopes(
    scope: ServerAccountScope,
    legacyScopes: readonly ServerAccountScope[],
): void {
    const storage = getStorage();
    if (!storage) return;
    const canonicalKey = serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, scope);
    let hasCanonicalRecord = readRecord(storage, canonicalKey) !== null;
    for (const legacyScope of legacyScopes) {
        if (legacyScope.serverId === scope.serverId && legacyScope.accountId === scope.accountId) continue;
        const legacyKey = serverAccountScopedStorageKey(STORAGE_KEY_PREFIX, legacyScope);
        const legacyRecord = readRecord(storage, legacyKey);
        if (!hasCanonicalRecord && legacyRecord) {
            const record = toRecord(legacyRecord);
            if (record) {
                try {
                    storage.setItem(canonicalKey, JSON.stringify(record));
                    hasCanonicalRecord = true;
                } catch {
                    // ignore storage failures
                }
            }
        }
        try {
            storage.removeItem(legacyKey);
        } catch {
            // ignore storage failures
        }
    }
}
