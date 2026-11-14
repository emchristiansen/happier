import {
  CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELD_FORBIDDEN_ERROR,
  CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS,
  findConnectedServiceInternalAssignmentFields,
  stripConnectedServiceInternalAssignmentFields,
  stripConnectedServicePerSessionAssignmentFields,
} from '@happier-dev/protocol';

/**
 * External-input boundary for per-session assignment state (spec A.1). Only the daemon writes a
 * session's `member`/`materializedAssignment`/decision IDs; callers may supply `initialProfileId`.
 */
export type ConnectedServiceInternalAssignmentInputRejection = Readonly<{
  errorCode: typeof CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELD_FORBIDDEN_ERROR;
  fields: ReadonlyArray<string>;
  message: string;
}>;

/** Rejects caller-supplied internal assignment fields; null when the input carries none. */
export function rejectConnectedServiceInternalAssignmentInput(input: unknown): ConnectedServiceInternalAssignmentInputRejection | null {
  const fields = findConnectedServiceInternalAssignmentFields(input);
  if (fields.length === 0) return null;
  return {
    errorCode: CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELD_FORBIDDEN_ERROR,
    fields,
    message: `${CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELD_FORBIDDEN_ERROR}: ${fields.join(', ')}`,
  };
}

/**
 * The group/source a child, fork or stored default inherits, without the parent's per-session
 * request and assignment (spec A.1): the inheritor makes its own decision and reservation.
 * The protocol owns the single field inventory; this is that helper under its CLI name.
 */
export const stripConnectedServicePerSessionAssignmentForInheritance = stripConnectedServicePerSessionAssignmentFields;

/** Removes caller-supplied internal assignment state from a resume request, keeping `initialProfileId`. */
export const stripConnectedServiceCallerAssignmentForResume = stripConnectedServiceInternalAssignmentFields;

/**
 * Resume of an existing session keeps only that session's own pending/applied assignment
 * (spec A.1): caller-supplied internal fields are always removed first, then the persisted record's
 * own fields are restored for a binding that still names the same service and group. Absent, empty
 * or different-group persisted state restores nothing. Spawn then revalidates the member before use.
 */
export function restoreConnectedServicePerSessionAssignmentFromPersisted<T>(bindings: T, persistedConnectedServices: unknown): T {
  const withoutCaller = stripConnectedServiceInternalAssignmentFields(bindings);
  if (!withoutCaller || typeof withoutCaller !== 'object') return withoutCaller;
  if (!persistedConnectedServices || typeof persistedConnectedServices !== 'object') return withoutCaller;
  const record = withoutCaller as Record<string, unknown>;
  const byServiceId = record.bindingsByServiceId as Record<string, Record<string, unknown> | undefined> | undefined;
  const persistedByServiceId = (persistedConnectedServices as Record<string, unknown>).bindingsByServiceId as
    Record<string, Record<string, unknown> | undefined> | undefined;
  if (!byServiceId || typeof byServiceId !== 'object' || !persistedByServiceId || typeof persistedByServiceId !== 'object') return withoutCaller;
  let changed = false;
  const next: Record<string, unknown> = { ...byServiceId };
  for (const [serviceId, binding] of Object.entries(byServiceId)) {
    const persisted = persistedByServiceId[serviceId];
    if (!binding || !persisted || binding.selection !== 'group' || persisted.selection !== 'group') continue;
    if (binding.groupId !== persisted.groupId) continue;
    const own = Object.fromEntries(CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS
      .filter((field) => persisted[field] !== undefined)
      .map((field) => [field, persisted[field]]));
    if (Object.keys(own).length === 0) continue;
    next[serviceId] = { ...binding, ...own };
    changed = true;
  }
  return changed ? ({ ...record, bindingsByServiceId: next } as T) : withoutCaller;
}
