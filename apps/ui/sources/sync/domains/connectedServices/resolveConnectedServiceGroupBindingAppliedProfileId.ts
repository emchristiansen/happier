import {
    ConnectedServiceGroupMaterializedAssignmentV1Schema,
    ConnectedServiceGroupMemberAssignmentV1Schema,
    type ConnectedServiceGroupMaterializedAssignmentV1,
    type ConnectedServiceGroupMemberAssignmentV1,
} from '@happier-dev/protocol';

/** The session's own applied per-session member, when the binding carries a valid one. */
export function readConnectedServiceGroupBindingMember(binding: unknown): ConnectedServiceGroupMemberAssignmentV1 | null {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
    const parsed = ConnectedServiceGroupMemberAssignmentV1Schema.safeParse((binding as Record<string, unknown>).member);
    return parsed.success ? parsed.data : null;
}

/** The session's pending per-session target (materialized, not yet adopted), when the binding carries a valid one. */
export function readConnectedServiceGroupBindingMaterializedAssignment(
    binding: unknown,
): ConnectedServiceGroupMaterializedAssignmentV1 | null {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
    const parsed = ConnectedServiceGroupMaterializedAssignmentV1Schema.safeParse(
        (binding as Record<string, unknown>).materializedAssignment,
    );
    return parsed.success ? parsed.data : null;
}

/**
 * Serving identity of a group binding (spec A.4/T19):
 * - `per_session_applied`: the session's own adopted member serves; a pending failover target may exist.
 * - `per_session_pending`: a first spawn was materialized onto a target that is not yet adopted. Nothing
 *   serves yet; neither the target nor the shared pool pointer may be presented as the serving account.
 * - `shared`: no per-session state; the shared pool's runtime `appliedProfileId` (if any) serves.
 */
export type ConnectedServiceGroupBindingServingState =
    | Readonly<{ kind: 'per_session_applied'; profileId: string; pendingProfileId: string | null }>
    | Readonly<{ kind: 'per_session_pending'; pendingProfileId: string }>
    | Readonly<{ kind: 'shared'; appliedProfileId: string | null }>;

export function resolveConnectedServiceGroupBindingServingState(binding: unknown): ConnectedServiceGroupBindingServingState {
    const member = readConnectedServiceGroupBindingMember(binding);
    const materialized = readConnectedServiceGroupBindingMaterializedAssignment(binding);
    if (member) {
        const profileId = member.profileId.trim();
        const pendingProfileId = materialized?.profileId.trim() ?? '';
        return {
            kind: 'per_session_applied',
            profileId,
            pendingProfileId: pendingProfileId && pendingProfileId !== profileId ? pendingProfileId : null,
        };
    }
    if (materialized) return { kind: 'per_session_pending', pendingProfileId: materialized.profileId.trim() };
    const applied = binding && typeof binding === 'object' && !Array.isArray(binding)
        ? (binding as Record<string, unknown>).appliedProfileId
        : undefined;
    const appliedProfileId = typeof applied === 'string' ? applied.trim() : '';
    return { kind: 'shared', appliedProfileId: appliedProfileId || null };
}

/**
 * Applied (adopted) serving identity of a group binding: the session's own per-session member, else the
 * shared-pool runtime `appliedProfileId`. Pending or materialized targets are never adoption evidence.
 * Returns '' when no applied identity is proved.
 */
export function resolveConnectedServiceGroupBindingAppliedProfileId(binding: unknown): string {
    const state = resolveConnectedServiceGroupBindingServingState(binding);
    if (state.kind === 'per_session_applied') return state.profileId;
    if (state.kind === 'shared') return state.appliedProfileId ?? '';
    return '';
}
