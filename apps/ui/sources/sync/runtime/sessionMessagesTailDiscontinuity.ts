/**
 * Tail-reset discontinuity state for a session's MAIN message chain.
 *
 * `tail_reset_latest_page` catch-up (see `applyMessageCatchUpDecision`) merges only the
 * newest page on top of whatever was already materialized. When the previously loaded
 * prefix does not touch the new island, the loaded set becomes non-contiguous — a state
 * the single monotone-min `beforeSeq` cursor cannot represent (live defect 2026-07-12:
 * scroll-up paged below the OLD prefix while the gap stayed missing forever).
 *
 * This record makes the discontinuity explicit:
 * - `walkCursor` is the older-fetch cursor of the hole-fill walk. Everything at or above
 *   it is contiguous with the live tail; it is also the transcript's display floor so the
 *   stale prefix is never glued onto the tail.
 * - `prefixMaxSeq` is the top of the pre-gap contiguous prefix. When the walk reaches it,
 *   the discontinuity closes and the preserved monotone-min cursor resumes (it still
 *   points below the prefix — no skipped range, no redundant refetch).
 *
 * Stacked resets (another large gap while a hole is still open) keep the DEEPEST prefix:
 * the walk restarts from the newest island and must bridge all the way down. Intermediate
 * islands are re-covered by the walk via the seq-merge dedupe.
 *
 * Opaque sources use the same record lifecycle with their existing older-page cursor.
 * Raw source IDs certify overlap; materialized IDs only locate the connected display
 * suffix, since several source rows can be absorbed into one rendered message.
 */
export type SequenceSessionMessagesTailDiscontinuity = Readonly<{
    kind: 'seq';
    prefixMaxSeq: number;
    walkCursor: number;
}>;

export type OpaqueSessionMessagesTailDiscontinuity = Readonly<{
    kind: 'opaque';
    /** Raw source witnesses, never reducer/display identities. */
    prefixMessageIds: readonly string[];
    prefixMaterializedMessageIds: readonly string[];
    walkCursor: string | null;
    boundaryMessageIds: readonly string[];
}>;

export type SessionMessagesTailDiscontinuity = SequenceSessionMessagesTailDiscontinuity | OpaqueSessionMessagesTailDiscontinuity;

/** Display-only projection of the same gap; cursors remain owned by Sync. */
export type SessionMessagesTailBoundary =
    | Readonly<{ kind: 'seq'; seq: number }>
    | Readonly<{ kind: 'messageIds'; messageIds: readonly string[] }>;

function normalizeSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
    return Math.trunc(value);
}

export function openTailDiscontinuityFromSnapshot(params: Readonly<{
    prev: SequenceSessionMessagesTailDiscontinuity | null;
    prefixMaxSeq: number;
    snapshotMinSeq: number;
}>): SequenceSessionMessagesTailDiscontinuity | null {
    const prefixMaxSeq = normalizeSeq(params.prefixMaxSeq);
    const snapshotMinSeq = normalizeSeq(params.snapshotMinSeq);
    // No prior materialized content: the snapshot IS the contiguous suffix.
    if (prefixMaxSeq == null || snapshotMinSeq == null) return params.prev;
    // Contiguous or overlapping snapshot: nothing new opens; an already-open walk keeps
    // its state (a snapshot at the island head does not bridge the existing hole).
    if (snapshotMinSeq <= prefixMaxSeq + 1) return params.prev;

    return {
        kind: 'seq',
        prefixMaxSeq: params.prev ? params.prev.prefixMaxSeq : prefixMaxSeq,
        walkCursor: snapshotMinSeq,
    };
}

export function applyTailDiscontinuityOlderPage(params: Readonly<{
    prev: SequenceSessionMessagesTailDiscontinuity;
    pageMinSeq: number | null;
    nextBeforeSeq: number | null;
}>): SequenceSessionMessagesTailDiscontinuity | null {
    const pageMinSeq = normalizeSeq(params.pageMinSeq);
    const nextBeforeSeq = normalizeSeq(params.nextBeforeSeq);
    // Empty terminal page: nothing exists below the walk cursor any more (server-side
    // truncation or purge). The hole cannot be filled, so close the NETWORK walk. The
    // caller intentionally retains the canonical discontinuity record and its last
    // contiguous display floor; network exhaustion is not evidence that a stale
    // materialized prefix became contiguous.
    if (pageMinSeq == null && nextBeforeSeq == null) return null;

    const candidate = Math.min(pageMinSeq ?? Number.POSITIVE_INFINITY, nextBeforeSeq ?? Number.POSITIVE_INFINITY);
    const walkCursor = Math.min(params.prev.walkCursor, candidate);
    if (walkCursor <= params.prev.prefixMaxSeq + 1) return null;
    if (walkCursor === params.prev.walkCursor) return params.prev;
    return { kind: 'seq', prefixMaxSeq: params.prev.prefixMaxSeq, walkCursor };
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
    const ids = new Set(left);
    return right.some((id) => ids.has(id));
}

function islandBoundaryIds(prefixIds: readonly string[], pageIds: readonly string[]): readonly string[] {
    const prefix = new Set(prefixIds);
    return [...new Set(pageIds)].filter((id) => !prefix.has(id));
}

export function openTailDiscontinuityFromOpaqueSnapshot(params: Readonly<{
    prev: OpaqueSessionMessagesTailDiscontinuity | null;
    prefixMessageIds: readonly string[];
    prefixMaterializedMessageIds: readonly string[];
    snapshotMessageIds: readonly string[];
    snapshotMaterializedMessageIds: readonly string[];
    nextCursor: string | null;
}>): OpaqueSessionMessagesTailDiscontinuity | null {
    const prefixMessageIds = params.prev?.prefixMessageIds ?? params.prefixMessageIds;
    if (intersects(prefixMessageIds, params.snapshotMessageIds)) return null;
    // Overlap with the currently accepted island does not restart an older open walk.
    if (intersects(params.prefixMessageIds, params.snapshotMessageIds)) return params.prev;
    if (prefixMessageIds.length === 0 || params.snapshotMessageIds.length === 0) return params.prev;
    const prefixMaterializedMessageIds = params.prev?.prefixMaterializedMessageIds ?? params.prefixMaterializedMessageIds;
    return {
        kind: 'opaque',
        prefixMessageIds,
        prefixMaterializedMessageIds,
        walkCursor: params.nextCursor,
        // A rewritten tool result can update a prefix row without bridging the source hole.
        boundaryMessageIds: islandBoundaryIds(prefixMaterializedMessageIds, params.snapshotMaterializedMessageIds),
    };
}

export function applyTailDiscontinuityOpaqueOlderPage(params: Readonly<{
    prev: OpaqueSessionMessagesTailDiscontinuity;
    pageMessageIds: readonly string[];
    pageMaterializedMessageIds: readonly string[];
    nextCursor: string | null;
}>): OpaqueSessionMessagesTailDiscontinuity | null {
    if (intersects(params.prev.prefixMessageIds, params.pageMessageIds)) return null;
    if (params.nextCursor === params.prev.walkCursor) return params.prev;
    const candidates = islandBoundaryIds(params.prev.prefixMaterializedMessageIds, params.pageMaterializedMessageIds);
    const unchangedBoundary = candidates.length === 0 || (candidates.length === params.prev.boundaryMessageIds.length
        && candidates.every((id, index) => id === params.prev.boundaryMessageIds[index]));
    const boundaryMessageIds = unchangedBoundary ? params.prev.boundaryMessageIds : candidates;
    // Terminal exhaustion stops the existing network pager, but leaves the display gap truthful.
    return { ...params.prev, walkCursor: params.nextCursor, boundaryMessageIds };
}

/** Accepted forward rows can make an invisible island visible, but cannot bridge its source hole. */
export function applyTailDiscontinuityOpaqueForwardPage(params: Readonly<{
    prev: OpaqueSessionMessagesTailDiscontinuity;
    pageMaterializedMessageIds: readonly string[];
}>): OpaqueSessionMessagesTailDiscontinuity {
    if (params.prev.boundaryMessageIds.length > 0) return params.prev;
    const boundaryMessageIds = islandBoundaryIds(params.prev.prefixMaterializedMessageIds, params.pageMaterializedMessageIds);
    return boundaryMessageIds.length === 0 ? params.prev : { ...params.prev, boundaryMessageIds };
}
