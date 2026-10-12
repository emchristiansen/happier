import { ApprovalRequestV1Schema, type ApprovalRequestV1 } from '@happier-dev/protocol';

import type { DecryptedArtifact } from './artifactTypes';
import { normalizeSessionListKeyParts } from '../session/listing/sessionListKeyNormalization';

export type OpenApprovalArtifactForSession = Readonly<{
    artifact: DecryptedArtifact;
    approval: ApprovalRequestV1;
}>;

const CREATED_BY_SURFACES = new Set<ApprovalRequestV1['createdBy']['surface']>([
    'voice',
    'session_agent',
    'mcp',
    'cli',
    'system',
]);

/** The canonical admission decision for approval artifacts shown by Inbox. */
export function isOpenApprovalInboxArtifact(artifact: DecryptedArtifact): boolean {
    return artifact.header?.kind === 'approval_request.v1'
        && artifact.header.approvalStatus === 'open';
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function readTimestampMs(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.trunc(value)
        : 0;
}

function addNormalizedSessionId(ids: Set<string>, value: unknown): void {
    const sessionId = readString(value);
    if (sessionId) ids.add(sessionId);
}

function collectSessionIdsFromUnknownArray(ids: Set<string>, value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
        addNormalizedSessionId(ids, entry);
    }
}

function parseApprovalRequestBody(body: unknown): ApprovalRequestV1 | null {
    if (typeof body !== 'string') return null;

    try {
        const parsed = JSON.parse(body);
        const result = ApprovalRequestV1Schema.safeParse(parsed);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

function collectApprovalLinkedSessionIds(
    artifact: DecryptedArtifact,
    approval?: ApprovalRequestV1 | null,
): Set<string> {
    const ids = new Set<string>();
    addNormalizedSessionId(ids, artifact.header?.sessionId);
    collectSessionIdsFromUnknownArray(ids, artifact.sessions);
    collectSessionIdsFromUnknownArray(ids, artifact.header?.sessions);
    addNormalizedSessionId(ids, approval?.createdBy.sessionId);
    return ids;
}

export function readApprovalServerId(
    artifact: DecryptedArtifact,
    approval?: ApprovalRequestV1 | null,
): string {
    return readString(approval?.serverId) || readString(artifact.header?.serverId);
}

function buildOpenApprovalSessionIdentity(sessionId: string, serverId: string): string {
    return normalizeSessionListKeyParts(serverId, sessionId).sessionKey ?? sessionId;
}

function isApprovalLinkedToSession(artifact: DecryptedArtifact, sessionId: string): boolean {
    return collectApprovalLinkedSessionIds(artifact).has(sessionId);
}

function readCreatedBySurface(value: unknown): ApprovalRequestV1['createdBy']['surface'] | null {
    const surface = readString(value);
    return CREATED_BY_SURFACES.has(surface as ApprovalRequestV1['createdBy']['surface'])
        ? surface as ApprovalRequestV1['createdBy']['surface']
        : null;
}

function createHeaderBackedApprovalRequest(
    artifact: DecryptedArtifact,
    sessionId: string,
): ApprovalRequestV1 | null {
    const actionId = readString(artifact.header?.actionId);
    const summary =
        readString(artifact.header?.approvalSummary)
        || readString(artifact.header?.summary)
        || readString(artifact.title)
        || readString(artifact.header?.title)
        || actionId;
    if (!actionId || !summary) return null;

    const headerCreatedBy = artifact.header?.createdBy;
    const headerCreatedBySurface = headerCreatedBy && typeof headerCreatedBy === 'object'
        ? readCreatedBySurface((headerCreatedBy as { surface?: unknown }).surface)
        : null;
    const surface = headerCreatedBySurface
        ?? readCreatedBySurface(artifact.header?.requestedSurface)
        ?? 'session_agent';
    const headerCreatedBySessionId = headerCreatedBy && typeof headerCreatedBy === 'object'
        ? readString((headerCreatedBy as { sessionId?: unknown }).sessionId)
        : '';
    const createdBy = {
        surface,
        ...(headerCreatedBySessionId || sessionId ? { sessionId: headerCreatedBySessionId || sessionId } : {}),
    };
    const requestedSurface = readString(artifact.header?.requestedSurface);
    const candidate = {
        v: 1,
        status: 'open',
        createdAtMs: readTimestampMs(artifact.createdAt),
        updatedAtMs: readTimestampMs(artifact.updatedAt),
        createdBy,
        ...(requestedSurface ? { requestedSurface } : {}),
        actionId,
        actionArgs: artifact.header?.actionArgs ?? {},
        summary,
        ...(typeof artifact.header?.approvalPreview !== 'undefined' ? { preview: artifact.header.approvalPreview } : {}),
    } as const;
    const result = ApprovalRequestV1Schema.safeParse(candidate);
    return result.success ? result.data : null;
}

export function listOpenApprovalArtifactsForSession(
    artifacts: readonly DecryptedArtifact[],
    sessionId: string,
): readonly OpenApprovalArtifactForSession[] {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return [];

    return artifacts.flatMap((artifact): OpenApprovalArtifactForSession[] => {
        if (!isOpenApprovalInboxArtifact(artifact)) return [];
        if (!isApprovalLinkedToSession(artifact, normalizedSessionId)) return [];

        const approval = artifact.body == null
            ? createHeaderBackedApprovalRequest(artifact, normalizedSessionId)
            : parseApprovalRequestBody(artifact.body);
        if (!approval || approval.status !== 'open') return [];

        return [{ artifact, approval }];
    });
}

export function collectOpenApprovalSessionIds(
    artifacts: readonly DecryptedArtifact[],
): ReadonlySet<string> {
    const ids = new Set<string>();

    for (const artifact of artifacts) {
        if (!isOpenApprovalInboxArtifact(artifact)) continue;

        const approval = artifact.body == null ? null : parseApprovalRequestBody(artifact.body);
        if (artifact.body != null && approval?.status !== 'open') continue;
        const serverId = readApprovalServerId(artifact, approval);

        for (const sessionId of collectApprovalLinkedSessionIds(artifact, approval)) {
            ids.add(buildOpenApprovalSessionIdentity(sessionId, serverId));
        }
    }

    return ids;
}
