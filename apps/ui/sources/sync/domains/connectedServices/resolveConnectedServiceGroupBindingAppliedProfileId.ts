import { ConnectedServiceGroupMemberAssignmentV1Schema, type ConnectedServiceGroupMemberAssignmentV1 } from '@happier-dev/protocol';

/** The session's own applied per-session member, when the binding carries a valid one. */
export function readConnectedServiceGroupBindingMember(binding: unknown): ConnectedServiceGroupMemberAssignmentV1 | null {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return null;
    const parsed = ConnectedServiceGroupMemberAssignmentV1Schema.safeParse((binding as Record<string, unknown>).member);
    return parsed.success ? parsed.data : null;
}

/**
 * Applied (adopted) serving identity of a group binding: the session's own per-session member, else the
 * shared-pool runtime `appliedProfileId`. Pending or materialized targets are never adoption evidence.
 * Returns '' when no applied identity is proved.
 */
export function resolveConnectedServiceGroupBindingAppliedProfileId(binding: unknown): string {
    const member = readConnectedServiceGroupBindingMember(binding);
    if (member) return member.profileId.trim();
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return '';
    const applied = (binding as Record<string, unknown>).appliedProfileId;
    return typeof applied === 'string' ? applied.trim() : '';
}
