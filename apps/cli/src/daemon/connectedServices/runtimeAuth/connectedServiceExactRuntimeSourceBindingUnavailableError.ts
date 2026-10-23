/**
 * A member of a registered runtime binding that keeps it from being an exact source tuple.
 * `group_generation_absent`: a group is bound without a valid (non-negative integer) generation.
 * `group_id_absent`: a valid generation is bound without a group.
 */
export type RegisteredRuntimeAuthFailureSourceBindingDeficiency =
  | 'profile_id_blank'
  | 'credential_revision_absent'
  | 'group_generation_absent'
  | 'group_id_absent';

/**
 * Why an exact runtime-auth failure report could not be checked against the registered runtime
 * binding. Identifier values are the registered values as stored, before trimming. The credential
 * revision is an opaque server-issued revision label (`csr_…`), not credential material.
 *
 * Neither the connected-service runtime registry nor TrackedSession records when an entry was
 * registered or a runner spawned, so the detail carries no such time.
 */
export type ConnectedServiceExactRuntimeSourceBindingUnavailableDetail =
  | Readonly<{
      kind: 'registered_binding_resolver_unavailable';
      serviceId: string;
    }>
  | Readonly<{
      kind: 'registered_binding_absent';
      reason: 'session_unregistered' | 'service_unbound';
      serviceId: string;
      registeredServiceIds: ReadonlyArray<string>;
    }>
  | Readonly<{
      kind: 'registered_binding_not_exact';
      serviceId: string;
      deficiencies: ReadonlyArray<RegisteredRuntimeAuthFailureSourceBindingDeficiency>;
      profileId: string;
      groupId: string | null;
      generation: number | null;
      credentialRevisionPresent: boolean;
      credentialRevision: string | null;
    }>;

const EXACT_RUNTIME_SOURCE_BINDING_UNAVAILABLE_MESSAGE =
  'connected-service exact runtime source binding temporarily unavailable';

/**
 * Carries structured rejection detail for the exact registered-binding check. The message is the
 * one external log watchers count, and `name` is deliberately left as the inherited `Error` so
 * existing error diagnostics stay byte-identical; only the added `detail` field is new.
 */
export class ConnectedServiceExactRuntimeSourceBindingUnavailableError extends Error {
  readonly detail: ConnectedServiceExactRuntimeSourceBindingUnavailableDetail;

  constructor(detail: ConnectedServiceExactRuntimeSourceBindingUnavailableDetail) {
    super(EXACT_RUNTIME_SOURCE_BINDING_UNAVAILABLE_MESSAGE);
    this.detail = detail;
  }
}

export function readConnectedServiceExactRuntimeSourceBindingUnavailableDetail(
  error: unknown,
): ConnectedServiceExactRuntimeSourceBindingUnavailableDetail | null {
  return error instanceof ConnectedServiceExactRuntimeSourceBindingUnavailableError ? error.detail : null;
}
