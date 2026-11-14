import {
  CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELD_FORBIDDEN_ERROR,
  CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS,
  findConnectedServiceInternalAssignmentFields,
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

const STRIPPED_FOR_INHERITANCE: ReadonlySet<string> = new Set([...CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS, 'initialProfileId']);

/**
 * The group/source a child, fork or stored default inherits, without the parent's per-session
 * request and assignment (spec A.1): the inheritor makes its own decision and reservation.
 * Accepts a V1 envelope or bare record and returns the same shape; other values pass through.
 */
export function stripConnectedServicePerSessionAssignmentForInheritance<T>(input: T): T {
  if (!input || typeof input !== 'object') return input;
  const record = input as Record<string, unknown>;
  const isEnvelope = !!record.bindingsByServiceId && typeof record.bindingsByServiceId === 'object';
  const byServiceId = (isEnvelope ? record.bindingsByServiceId : record) as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [serviceId, binding] of Object.entries(byServiceId)) {
    if (!binding || typeof binding !== 'object') {
      next[serviceId] = binding;
      continue;
    }
    const kept = Object.fromEntries(Object.entries(binding).filter(([field]) => !STRIPPED_FOR_INHERITANCE.has(field)));
    if (Object.keys(kept).length !== Object.keys(binding).length) changed = true;
    next[serviceId] = kept;
  }
  if (!changed) return input;
  return (isEnvelope ? { ...record, bindingsByServiceId: next } : next) as T;
}

/**
 * Resume of an existing session keeps only that session's own pending/applied assignment
 * (spec A.1): its persisted metadata is the source, never the caller. Applies to bindings that
 * still name the same group; spawn then revalidates the member before using it.
 */
export function restoreConnectedServicePerSessionAssignmentFromPersisted<T>(bindings: T, persistedConnectedServices: unknown): T {
  if (!bindings || typeof bindings !== 'object') return bindings;
  if (!persistedConnectedServices || typeof persistedConnectedServices !== 'object') return bindings;
  const record = bindings as Record<string, unknown>;
  const byServiceId = record.bindingsByServiceId as Record<string, Record<string, unknown> | undefined> | undefined;
  const persistedByServiceId = (persistedConnectedServices as Record<string, unknown>).bindingsByServiceId as
    Record<string, Record<string, unknown> | undefined> | undefined;
  if (!byServiceId || typeof byServiceId !== 'object' || !persistedByServiceId || typeof persistedByServiceId !== 'object') return bindings;
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
    const withoutCaller = Object.fromEntries(Object.entries(binding)
      .filter(([field]) => !(CONNECTED_SERVICE_INTERNAL_ASSIGNMENT_FIELDS as readonly string[]).includes(field)));
    next[serviceId] = { ...withoutCaller, ...own };
    changed = true;
  }
  return changed ? ({ ...record, bindingsByServiceId: next } as T) : bindings;
}
