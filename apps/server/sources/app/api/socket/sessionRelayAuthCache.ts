import type { Socket } from "socket.io";

import type { ClientConnection } from "@/app/events/eventPayloadTypes";
import { checkSessionAccess, requireAccessLevel } from "@/app/share/accessControl";
import { getSessionParticipantUserIds } from "@/app/share/sessionParticipants";
import {
    hasCurrentSessionScopedMachineAccess,
    resolveSessionScopedMachinePublishBinding,
} from "./sessionScopedBinding";

/**
 * TTL cache for session-scoped machine socket authorization.
 *
 * High-rate ephemeral relays (`transcript-stream-segment{,-delta}`, `execution-run-updated`) arrive
 * at up to 25Hz per session, and the publisher liveness heartbeat (`session-alive`) arrives every
 * 2-15s per session. The facts they must verify (machine access key exists, sender owns the
 * session with edit access, participant fan-out list) were already proven at socket handshake and
 * change rarely, so re-proving them with 3 DB round-trips per event is pure overhead.
 *
 * Positive resolutions are cached per (userId, sessionId, machineId) binding for a short TTL
 * (mirroring `activityCache` in `@/app/presence/sessionCache`). Negative resolutions are never
 * cached. Server-owned write paths that change these facts invalidate eagerly:
 * - session share create/update/revoke (`shareRoutes.ts`) → `invalidateSessionRelayAuthorizationForSession`
 * - machine revoke deleting its access keys (`machinesRoutes.ts`) → `invalidateSessionRelayAuthorizationForMachine`
 * - session delete (`deleteOwnedSession.ts`) → `invalidateSessionRelayAuthorizationForSession`
 *
 * Every invalidation runs in `afterTx`, after the revoking write commits. A resolution whose reads
 * started before that commit may have read the pre-revocation state, so a cache-wide invalidation
 * count is captured when a resolution starts reading. A resolution crossed by any invalidation is
 * neither returned nor stored: it is resolved once more (its reads then start after the commit and
 * see it), and if that retry is crossed as well the call is denied without caching. So a revocation
 * cannot be undone by a read that straddled it, for this call or for the TTL.
 *
 * A cached grant is reused until `SESSION_RELAY_AUTH_CACHE_TTL_MS` after the resolution that stored
 * it started reading (wall clock).
 *
 * In multi-process deployments the eager invalidation is process-local; the TTL bounds staleness to
 * `SESSION_RELAY_AUTH_CACHE_TTL_MS`, the same guarantee `activityCache` already provides for
 * `session-alive`. Relay authorization is only cached for sockets whose handshake proof succeeded.
 */
export const SESSION_RELAY_AUTH_CACHE_TTL_MS = 30_000;

type SessionRelayAuthCacheEntry = Readonly<{
    validUntil: number;
    sessionId: string;
    machineId: string;
    participantUserIds: readonly string[];
}>;

const relayAuthCache = new Map<string, SessionRelayAuthCacheEntry>();

// Cache-wide count of invalidations. It fences resolutions, not stored entries (invalidation deletes
// those directly). Cache-wide rather than per key so the fence needs no bookkeeping that could miss a
// key; invalidations are rare (share changes, session delete, machine revoke), and a crossed
// resolution only costs one more verification.
let relayAuthInvalidations = 0;

// One resolution plus one retry. A call crossed by invalidations on every attempt is denied.
const RELAY_AUTH_RESOLUTION_ATTEMPTS = 2;

type RelayAuthResolution = Readonly<{ participantUserIds: readonly string[] | null; crossedByInvalidation: boolean }>;

async function resolveSessionScopedMachineBinding(params: Readonly<{
    accountId: string;
    machineId: string;
    sessionId: string;
}>): Promise<RelayAuthResolution> {
    const invalidationsAtStart = relayAuthInvalidations;
    const crossed = () => relayAuthInvalidations !== invalidationsAtStart;

    if (!await hasCurrentSessionScopedMachineAccess({
        accountId: params.accountId,
        machineId: params.machineId,
        sessionId: params.sessionId,
    })) {
        return { participantUserIds: null, crossedByInvalidation: crossed() };
    }

    const access = await checkSessionAccess(params.accountId, params.sessionId);
    if (!access || !requireAccessLevel(access, "edit") || !access.isOwner) {
        return { participantUserIds: null, crossedByInvalidation: crossed() };
    }

    const participantUserIds = await getSessionParticipantUserIds({ sessionId: params.sessionId });
    if (participantUserIds.length === 0) {
        return { participantUserIds: null, crossedByInvalidation: crossed() };
    }
    return { participantUserIds, crossedByInvalidation: crossed() };
}

function createRelayAuthCacheKey(userId: string, sessionId: string, machineId: string): string {
    return `${userId}\u0000${sessionId}\u0000${machineId}`;
}

function pruneExpiredRelayAuthEntries(nowMs: number): void {
    for (const [key, entry] of relayAuthCache) {
        if (entry.validUntil <= nowMs) {
            relayAuthCache.delete(key);
        }
    }
}

/**
 * Authorize a session-scoped socket to publish relay events for `sessionId` and resolve the
 * participant user ids to fan out to. Returns `null` when publishing is not allowed.
 *
 * The in-memory binding proof is checked on every call; the DB-backed facts (access key presence,
 * owner+edit access, participant list) are resolved once per TTL window per binding.
 */
export async function authorizeSessionRelayPublish(params: Readonly<{
    socket: Socket;
    connection: ClientConnection;
    userId: string;
    sessionId: string;
}>): Promise<readonly string[] | null> {
    const binding = resolveSessionScopedMachinePublishBinding({
        socket: params.socket,
        connection: params.connection,
        sessionId: params.sessionId,
    });
    if (!binding) {
        return null;
    }

    return await authorizeSessionScopedMachineBinding({
        accountId: params.userId,
        machineId: binding.machineId,
        sessionId: binding.sessionId,
    });
}

/**
 * Authorize an already-bound session-scoped machine binding and resolve its participant fan-out
 * list. Returns `null` when the binding is no longer authorized.
 *
 * This is the DB-backed half of `authorizeSessionRelayPublish`, shared with the publisher liveness
 * heartbeat, which proves the same binding from an in-memory registration rather than from a socket.
 */
export async function authorizeSessionScopedMachineBinding(params: Readonly<{
    accountId: string;
    machineId: string;
    sessionId: string;
}>): Promise<readonly string[] | null> {
    const cacheKey = createRelayAuthCacheKey(params.accountId, params.sessionId, params.machineId);
    const nowMs = Date.now();
    const cached = relayAuthCache.get(cacheKey);
    if (cached && cached.validUntil > nowMs) {
        return cached.participantUserIds;
    }
    pruneExpiredRelayAuthEntries(nowMs);

    for (let attempt = 1; attempt <= RELAY_AUTH_RESOLUTION_ATTEMPTS; attempt += 1) {
        const startedAtMs = Date.now();
        const resolution = await resolveSessionScopedMachineBinding(params);
        // A crossed resolution may hold pre-invalidation facts, positive or negative: resolve again.
        if (resolution.crossedByInvalidation) continue;
        if (resolution.participantUserIds === null) return null;
        relayAuthCache.set(cacheKey, {
            validUntil: startedAtMs + SESSION_RELAY_AUTH_CACHE_TTL_MS,
            sessionId: params.sessionId,
            machineId: params.machineId,
            participantUserIds: resolution.participantUserIds,
        });
        return resolution.participantUserIds;
    }
    return null;
}

/** Drop cached relay authorizations for a session (share change, session delete). */
export function invalidateSessionRelayAuthorizationForSession(sessionId: string): void {
    relayAuthInvalidations += 1;
    for (const [key, entry] of relayAuthCache) {
        if (entry.sessionId === sessionId) {
            relayAuthCache.delete(key);
        }
    }
}

/** Drop cached relay authorizations for a machine (machine revoke deletes its access keys). */
export function invalidateSessionRelayAuthorizationForMachine(machineId: string): void {
    relayAuthInvalidations += 1;
    for (const [key, entry] of relayAuthCache) {
        if (entry.machineId === machineId) {
            relayAuthCache.delete(key);
        }
    }
}

/** Reset all cached relay authorizations (tests, shutdown). */
export function clearSessionRelayAuthorizationCache(): void {
    relayAuthInvalidations += 1;
    relayAuthCache.clear();
}
