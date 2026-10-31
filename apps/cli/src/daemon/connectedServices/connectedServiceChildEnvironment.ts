import {
  ConnectedServiceBindingsV1Schema,
  ConnectedServiceCredentialRevisionV1Schema,
  type ConnectedServiceBindingSelectionV1,
  type ConnectedServiceId,
  type ConnectedServiceCredentialRevisionV1,
  type ConnectedServiceProfileId,
} from '@happier-dev/protocol';

export const HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY = 'HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON';
export const HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY =
  'HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON';
export const HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY =
  'HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT';

export type ConnectedServiceChildSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
      credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    }>;

type ConnectedServiceSerializableSelection =
  | Readonly<{
      kind: 'profile';
      serviceId: ConnectedServiceId;
      profileId: string;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    }>
  | Readonly<{
      kind: 'group';
      serviceId: ConnectedServiceId;
      groupId: string;
      activeProfileId: string;
      fallbackProfileId: string;
      generation: number;
      credentialRevision?: ConnectedServiceCredentialRevisionV1 | null;
    }>;

export type ConnectedServiceRuntimeAuthContext = Readonly<{
  serviceId: ConnectedServiceId;
  profileId: string | null;
  groupId: string | null;
}>;

export type ConnectedServiceRuntimeAuthMetadataSession = Readonly<{
  getMetadataSnapshot?: () => unknown;
}>;

function readRecord(value: unknown): Record<string, unknown> | null {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readGeneration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function readCredentialRevision(value: unknown): ConnectedServiceCredentialRevisionV1 | null {
  const parsed = ConnectedServiceCredentialRevisionV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function serializeConnectedServiceChildSelections(
  selectionsByServiceId: ReadonlyMap<ConnectedServiceId, ConnectedServiceSerializableSelection> | undefined,
): string | null {
  if (!selectionsByServiceId || selectionsByServiceId.size === 0) return null;
  const selections: ConnectedServiceChildSelection[] = [];
  for (const selection of selectionsByServiceId.values()) {
    if (selection.kind === 'profile') {
      selections.push({
        kind: 'profile',
        serviceId: selection.serviceId,
        profileId: selection.profileId,
        credentialRevision: selection.credentialRevision ?? null,
      });
      continue;
    }
    selections.push({
      kind: 'group',
      serviceId: selection.serviceId,
      groupId: selection.groupId,
      activeProfileId: selection.activeProfileId,
      fallbackProfileId: selection.fallbackProfileId,
      generation: selection.generation,
      credentialRevision: selection.credentialRevision ?? null,
    });
  }
  return selections.length > 0 ? JSON.stringify(selections) : null;
}

export function readConnectedServiceChildSelectionsFromEnv(
  env: Pick<NodeJS.ProcessEnv, string>,
): ConnectedServiceChildSelection[] {
  const raw = env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const selections: ConnectedServiceChildSelection[] = [];
  for (const item of parsed) {
    const record = readRecord(item);
    if (!record) continue;
    const kind = record.kind;
    const serviceId = readString(record.serviceId) as ConnectedServiceId;
    if (!serviceId) continue;
    if (kind === 'profile') {
      const profileId = readString(record.profileId);
      if (!profileId) continue;
      selections.push({
        kind: 'profile',
        serviceId,
        profileId,
        credentialRevision: readCredentialRevision(record.credentialRevision),
      });
      continue;
    }
    if (kind === 'group') {
      const groupId = readString(record.groupId);
      const activeProfileId = readString(record.activeProfileId);
      const fallbackProfileId = readString(record.fallbackProfileId);
      if (!groupId || !activeProfileId || !fallbackProfileId) continue;
      selections.push({
        kind: 'group',
        serviceId,
        groupId,
        activeProfileId,
        fallbackProfileId,
        generation: readGeneration(record.generation),
        credentialRevision: readCredentialRevision(record.credentialRevision),
      });
    }
  }
  return selections;
}

export function serializeConnectedServiceMaterializedEnvKeys(
  env: Readonly<Record<string, string>>,
): string | null {
  const keys = Object.keys(env)
    .map((key) => key.trim())
    .filter(Boolean);
  return keys.length > 0 ? JSON.stringify(Array.from(new Set(keys)).sort()) : null;
}

export function readConnectedServiceMaterializedEnvKeysFromEnv(
  env: Pick<NodeJS.ProcessEnv, string>,
): string[] {
  const raw = env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return Array.from(new Set(parsed
    .filter((key): key is string => typeof key === 'string')
    .map((key) => key.trim())
    .filter(Boolean)));
}

/**
 * Removes Connected Service authority inherited from a parent runtime before
 * composing a distinct child runtime. The materialized-key marker is the
 * canonical provider-agnostic inventory of credential/config environment
 * owned by that parent selection; the control markers are removed with it so
 * a child cannot reinterpret the parent's selection as its own.
 *
 * A child with an explicit Connected Service selection receives its freshly
 * materialized overlay later. Native children keep unrelated ambient values,
 * including their genuine native credentials.
 */
export function stripInheritedConnectedServiceEnvironment(
  env: Pick<NodeJS.ProcessEnv, string>,
): Record<string, string> {
  const inheritedKeys = new Set<string>([
    ...readConnectedServiceMaterializedEnvKeysFromEnv(env),
    HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
    HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY,
  ]);
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && !inheritedKeys.has(key)) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

export function findConnectedServiceChildSelection(
  env: Pick<NodeJS.ProcessEnv, string>,
  serviceId: ConnectedServiceId,
): ConnectedServiceChildSelection | null {
  return readConnectedServiceChildSelectionsFromEnv(env).find((selection) => selection.serviceId === serviceId) ?? null;
}

export function resolveConnectedServiceRuntimeAuthContextFromSelection(
  selection: unknown,
  fallbackServiceId: ConnectedServiceId,
): ConnectedServiceRuntimeAuthContext {
  const record = readRecord(selection);
  const serviceId = (readString(record?.serviceId) || fallbackServiceId) as ConnectedServiceId;
  if (record?.kind === 'group') {
    return {
      serviceId,
      profileId: readString(record.activeProfileId) || null,
      groupId: readString(record.groupId) || null,
    };
  }
  if (record?.kind === 'profile') {
    return {
      serviceId,
      profileId: readString(record.profileId) || null,
      groupId: null,
    };
  }
  return {
    serviceId,
    profileId: readString(record?.profileId) || readString(record?.activeProfileId) || null,
    groupId: readString(record?.groupId) || null,
  };
}

export function resolveConnectedServiceRuntimeAuthContextFromEnv(
  env: Pick<NodeJS.ProcessEnv, string>,
  serviceId: ConnectedServiceId,
): ConnectedServiceRuntimeAuthContext {
  return resolveConnectedServiceRuntimeAuthContextFromSelection(
    findConnectedServiceChildSelection(env, serviceId),
    serviceId,
  );
}

export function findConnectedServiceBindingSelectionFromSessionMetadata(
  session: ConnectedServiceRuntimeAuthMetadataSession,
  serviceId: ConnectedServiceId,
): ConnectedServiceBindingSelectionV1 | null {
  const metadata = typeof session.getMetadataSnapshot === 'function' ? session.getMetadataSnapshot() : null;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;

  const rawBindings = (metadata as Record<string, unknown>).connectedServices;
  const parsed = ConnectedServiceBindingsV1Schema.safeParse(rawBindings);
  if (!parsed.success) return null;

  return parsed.data.bindingsByServiceId[serviceId] ?? null;
}

export function resolveConnectedServiceRuntimeAuthContextFromSessionMetadata(
  session: ConnectedServiceRuntimeAuthMetadataSession,
  serviceId: ConnectedServiceId,
): ConnectedServiceRuntimeAuthContext {
  const binding = findConnectedServiceBindingSelectionFromSessionMetadata(session, serviceId);
  if (!binding || binding.source !== 'connected') {
    return { serviceId, profileId: null, groupId: null };
  }

  if (binding.selection === 'group') {
    return {
      serviceId,
      profileId: binding.profileId ?? null,
      groupId: binding.groupId,
    };
  }

  return {
    serviceId,
    profileId: binding.profileId as ConnectedServiceProfileId,
    groupId: null,
  };
}
