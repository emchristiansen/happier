import type {
  ConnectedServiceId,
  ConnectedServiceMaterializationIdentityV1,
} from '@happier-dev/protocol';

import type { ConnectedServiceResolvedSelection } from '../materialize/materializeConnectedServicesForSpawn';
import type { ResolvedConnectedServiceCredential } from '@/cloud/connectedServices/resolveConnectedServiceCredentials';
import { readConnectedServiceMaterializationIdentityV1 } from '../materialize/createConnectedServiceMaterializationIdentity';
import type { ConnectedServiceChildSelection } from '../connectedServiceChildEnvironment';
import type { SpawnTarget } from './refreshTypes';

/**
 * Resolve the materialization identity a refresh-driven rematerialization must target.
 *
 * The spawn registers `materializationKey = identity.id` (`csm_*`) and the session reads
 * `<baseDir>/<identity.id>/<agentId>`. `materializeConnectedServicesForSpawn` falls back to
 * `sha256(key)` when no identity object is supplied, so a rematerialization that drops the identity
 * writes fresh credentials into an ORPHAN root no session ever reads (RD-MAT-6). When the caller
 * did not register the typed identity, reconstruct it from a canonical `csm_*` key — only the `id`
 * drives root resolution; the timestamp is a sentinel for the schema and is never persisted.
 */
export function resolveSpawnTargetMaterializationIdentity(
  target: SpawnTarget,
): ConnectedServiceMaterializationIdentityV1 | null {
  if (target.connectedServiceMaterializationIdentityV1) {
    return target.connectedServiceMaterializationIdentityV1;
  }
  if (!target.materializationKey.startsWith('csm_')) return null;
  return readConnectedServiceMaterializationIdentityV1({
    v: 1,
    id: target.materializationKey,
    createdAtMs: 0,
  });
}

export function buildResolvedSelectionsForTarget(
  target: SpawnTarget,
  credentialsByServiceId: ReadonlyMap<ConnectedServiceId, ResolvedConnectedServiceCredential>,
): ReadonlyMap<ConnectedServiceId, ConnectedServiceResolvedSelection> {
  const selectionsByServiceId = new Map<ConnectedServiceId, ConnectedServiceResolvedSelection>();
  for (const selection of target.selectionsByServiceId.values()) {
    const credential = credentialsByServiceId.get(selection.serviceId);
    if (!credential) continue;
    const { record, credentialRevision } = credential;
    if (selection.kind === 'group') {
      selectionsByServiceId.set(selection.serviceId, {
        kind: 'group',
        serviceId: selection.serviceId,
        groupId: selection.groupId,
        activeProfileId: selection.activeProfileId,
        fallbackProfileId: selection.fallbackProfileId,
        generation: selection.generation,
        credentialRevision,
        record,
        policy: null,
      });
      continue;
    }
    selectionsByServiceId.set(selection.serviceId, {
      kind: 'profile',
      serviceId: selection.serviceId,
      profileId: selection.profileId,
      credentialRevision,
      record,
    });
  }
  return selectionsByServiceId;
}

/**
 * Rewrites a target's GROUP selections to the group's canonical current active profile and
 * generation before rematerialization. Returns null (fail closed — skip the target) when the
 * canonical state of any group selection cannot be read; profile selections pass through.
 */
export async function canonicalizeTargetSelectionsForRematerialization(input: Readonly<{
  target: SpawnTarget;
  resolveCanonicalGroupState: (group: Readonly<{
    serviceId: ConnectedServiceId;
    groupId: string;
  }>) => Promise<Readonly<{ activeProfileId: string | null; generation: number }> | null>;
}>): Promise<SpawnTarget | null> {
  let changed = false;
  const canonicalSelections = new Map<ConnectedServiceId, ConnectedServiceChildSelection>();
  const canonicalProfileIds = new Map<ConnectedServiceId, string>();
  for (const [serviceId, selection] of input.target.selectionsByServiceId) {
    if (selection.kind !== 'group') {
      canonicalSelections.set(serviceId, selection);
      continue;
    }
    const canonical = await input.resolveCanonicalGroupState({ serviceId, groupId: selection.groupId });
    if (!canonical?.activeProfileId) return null;
    canonicalProfileIds.set(serviceId, canonical.activeProfileId);
    if (
      canonical.activeProfileId === selection.activeProfileId
      && canonical.generation === selection.generation
    ) {
      canonicalSelections.set(serviceId, selection);
      continue;
    }
    changed = true;
    canonicalSelections.set(serviceId, {
      ...selection,
      activeProfileId: canonical.activeProfileId,
      generation: canonical.generation,
    });
  }
  if (!changed) return input.target;
  const canonicalBindings = input.target.bindings.map((binding) => {
    const canonicalProfileId = canonicalProfileIds.get(binding.serviceId);
    return canonicalProfileId && canonicalProfileId !== binding.profileId
      ? { ...binding, profileId: canonicalProfileId }
      : binding;
  });
  return {
    ...input.target,
    bindings: canonicalBindings,
    selectionsByServiceId: canonicalSelections,
  };
}
