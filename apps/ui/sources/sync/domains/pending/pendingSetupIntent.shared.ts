/**
 * Where a setup intent stands. There is no `dismissed`: discarding an intent CLEARS it, because no
 * reader ever distinguished a dismissed marker from no marker at all — both mean "this person is
 * not in the middle of connecting a computer". A record persisted with that phase by an older
 * build reads as absent, which is the same answer it already produced.
 */
export type PendingSetupIntentPhase = 'pre_auth' | 'awaiting_auth' | 'post_auth';

export type PendingSetupIntent =
    | Readonly<{
        branch: 'thisComputer';
        phase: PendingSetupIntentPhase;
        relayUrl: string | null;
    }>
    | Readonly<{
        branch: 'remoteMachine';
        phase: 'awaiting_auth' | 'post_auth';
        relayUrl: string | null;
        machineId: string | null;
    }>;

type PendingSetupIntentRecord =
    | Readonly<{
        branch: 'thisComputer';
        phase: PendingSetupIntentPhase;
        relayUrl: string | null;
        createdAtMs: number;
    }>
    | Readonly<{
        branch: 'remoteMachine';
        phase: 'awaiting_auth' | 'post_auth';
        relayUrl: string | null;
        machineId: string | null;
        createdAtMs: number;
    }>;

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function readTtlFromEnv(): number {
    const raw = String(process.env.EXPO_PUBLIC_PENDING_SETUP_INTENT_TTL_MS ?? '').trim();
    if (!raw) return DEFAULT_TTL_MS;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_TTL_MS;
    return Math.floor(value);
}

const ttlMs = readTtlFromEnv();
const pendingSetupIntentListeners = new Set<() => void>();
let cachedSerializedRecord: string | null = null;
let cachedSerializedRecordSnapshot: PendingSetupIntent | null = null;

/** Notifies subscribers that a writer changed the persisted intent (both storage variants call it). */
export function subscribePendingSetupIntent(listener: () => void): () => void {
    pendingSetupIntentListeners.add(listener);
    return () => {
        pendingSetupIntentListeners.delete(listener);
    };
}

export function emitPendingSetupIntentChanged(): void {
    for (const listener of Array.from(pendingSetupIntentListeners)) {
        listener();
    }
}

/**
 * Parses a serialized record into a referentially stable snapshot: the same bytes yield the same
 * object, so `useSyncExternalStore` readers do not re-render on every read.
 */
export function fromSerializedRecord(serialized: string | null | undefined): PendingSetupIntent | null {
    if (!serialized) {
        cachedSerializedRecord = null;
        cachedSerializedRecordSnapshot = null;
        return null;
    }
    if (serialized === cachedSerializedRecord && cachedSerializedRecordSnapshot) {
        return cachedSerializedRecordSnapshot;
    }
    let parsed: PendingSetupIntent | null;
    try {
        parsed = fromRecord(JSON.parse(serialized) as unknown);
    } catch {
        parsed = null;
    }
    cachedSerializedRecord = parsed ? serialized : null;
    cachedSerializedRecordSnapshot = parsed;
    return parsed;
}

function normalizeRelayUrl(raw: string | null | undefined): string | null {
    const value = String(raw ?? '').trim().replace(/\/+$/, '');
    return value ? value : null;
}

function normalizeMachineId(raw: string | null | undefined): string | null {
    const value = String(raw ?? '').trim();
    return value ? value : null;
}

export function toRecord(value: PendingSetupIntent): PendingSetupIntentRecord | null {
    if (value?.branch === 'thisComputer') {
        if (value.phase !== 'pre_auth' && value.phase !== 'awaiting_auth' && value.phase !== 'post_auth') {
            return null;
        }
        return {
            branch: 'thisComputer',
            phase: value.phase,
            relayUrl: normalizeRelayUrl(value.relayUrl),
            createdAtMs: Date.now(),
        };
    }
    if (value?.branch === 'remoteMachine') {
        if (value.phase !== 'awaiting_auth' && value.phase !== 'post_auth') {
            return null;
        }
        return {
            branch: 'remoteMachine',
            phase: value.phase,
            relayUrl: normalizeRelayUrl(value.relayUrl),
            machineId: normalizeMachineId(value.machineId),
            createdAtMs: Date.now(),
        };
    }
    return null;
}

export function fromRecord(value: unknown): PendingSetupIntent | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const createdAtMs = Number(record.createdAtMs ?? 0);
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
    if (Date.now() - createdAtMs > ttlMs) return null;
    if (record.branch === 'thisComputer') {
        if (record.phase !== 'pre_auth' && record.phase !== 'awaiting_auth' && record.phase !== 'post_auth') {
            return null;
        }
        return {
            branch: 'thisComputer',
            phase: record.phase,
            relayUrl: normalizeRelayUrl(record.relayUrl as string | null | undefined),
        };
    }
    if (record.branch === 'remoteMachine') {
        if (record.phase !== 'awaiting_auth' && record.phase !== 'post_auth') {
            return null;
        }
        return {
            branch: 'remoteMachine',
            phase: record.phase,
            relayUrl: normalizeRelayUrl(record.relayUrl as string | null | undefined),
            machineId: normalizeMachineId(record.machineId as string | null | undefined),
        };
    }
    return null;
}
