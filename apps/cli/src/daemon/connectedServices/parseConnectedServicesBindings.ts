/**
 * Connected services session bindings parser
 *
 * Spawn/session metadata includes non-secret binding decisions indicating which connected service
 * profile a session should use. This helper extracts the `(serviceId, profileId)` pairs that require
 * daemon-side credential resolution.
 */

import {
  ConnectedServiceIdSchema,
  ConnectedServiceBindingsV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceGroupMaterializedAssignmentV1,
  type ConnectedServiceGroupMemberAssignmentV1,
  type ConnectedServiceId,
} from '@happier-dev/protocol';

export type ConnectedServiceBindingSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      fallbackProfileId?: string;
      /** External named-start request (per_session_softmax groups only). */
      initialProfileId?: string;
      /** This session's own applied per-session member. */
      member?: ConnectedServiceGroupMemberAssignmentV1;
      /** This session's own pending (materialized, not yet adopted) per-session target. */
      materializedAssignment?: ConnectedServiceGroupMaterializedAssignmentV1;
    }>;

/** A session owns a per-session assignment once it has an applied or materialized member. */
export function isPerSessionOwnedGroupSelection(selection: ConnectedServiceBindingSelection): boolean {
  return selection.kind === 'group' && (selection.member !== undefined || selection.materializedAssignment !== undefined);
}

/** The member a per-session-owned session is materialized on: pending target first, then applied member. */
export function resolvePerSessionTargetProfileId(selection: ConnectedServiceBindingSelection): string | null {
  if (selection.kind !== 'group') return null;
  return selection.materializedAssignment?.profileId ?? selection.member?.profileId ?? null;
}

/** Raw-binding form of `resolvePerSessionTargetProfileId` for switch/materialization code that holds bindings. */
export function resolvePerSessionBindingTargetProfileId(binding: unknown): string | null {
  if (!binding || typeof binding !== 'object') return null;
  const record = binding as {
    selection?: unknown;
    materializedAssignment?: { profileId?: unknown } | null;
    member?: { profileId?: unknown } | null;
  };
  if (record.selection !== 'group') return null;
  const target = record.materializedAssignment?.profileId ?? record.member?.profileId;
  return typeof target === 'string' && target.trim().length > 0 ? target.trim() : null;
}

export type ConnectedServicesBindingsV1 = ConnectedServiceBindingsV1;

function readTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseConnectedServiceBindingSelections(raw: unknown): ConnectedServiceBindingSelection[] {
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(raw);
  if (!parsed.success) return [];
  const bindings = parsed.data.bindingsByServiceId;

  const out: ConnectedServiceBindingSelection[] = [];
  for (const [serviceIdRaw, bindingRaw] of Object.entries(bindings)) {
    const parsedId = ConnectedServiceIdSchema.safeParse(serviceIdRaw);
    if (!parsedId.success) continue;
    const source = bindingRaw.source;
    if (source !== 'connected') continue;
    const profileId = readTrimmedString(bindingRaw.profileId);
    const selection = readTrimmedString(bindingRaw.selection);
    if (selection === 'group') {
      const groupId = readTrimmedString(bindingRaw.groupId);
      if (!groupId) continue;
      const initialProfileId = bindingRaw.selection === 'group' ? readTrimmedString(bindingRaw.initialProfileId) : '';
      out.push({
        kind: 'group',
        serviceId: parsedId.data,
        groupId,
        ...(profileId ? { fallbackProfileId: profileId } : {}),
        ...(initialProfileId ? { initialProfileId } : {}),
        ...(bindingRaw.selection === 'group' && bindingRaw.member ? { member: bindingRaw.member } : {}),
        ...(bindingRaw.selection === 'group' && bindingRaw.materializedAssignment
          ? { materializedAssignment: bindingRaw.materializedAssignment }
          : {}),
      });
      continue;
    }
    if (!profileId) continue;
    out.push({ kind: 'profile', serviceId: parsedId.data, profileId });
  }
  return out;
}

export function parseConnectedServicesBindings(raw: unknown): Array<{ serviceId: ConnectedServiceId; profileId: string }> {
  return parseConnectedServiceBindingSelections(raw).flatMap((selection) => {
    if (selection.kind === 'profile') {
      return [{ serviceId: selection.serviceId, profileId: selection.profileId }];
    }
    return selection.fallbackProfileId
      ? [{ serviceId: selection.serviceId, profileId: selection.fallbackProfileId }]
      : [];
  });
}
