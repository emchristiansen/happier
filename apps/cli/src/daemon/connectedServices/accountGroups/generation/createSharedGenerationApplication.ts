import type {
  ConnectedServiceCredentialRecordV1,
  ConnectedServiceCredentialRevisionV1,
  ConnectedServiceId,
} from '@happier-dev/protocol';

import { logger } from '@/ui/logger';

import type { ConnectedServiceCredentialLifecycleDescriptor } from '../../credentials/lifecycleTypes';
import type { ConnectedServiceGroupMutationTarget } from '../../credentials/createConnectedServiceGroupMutationCurrentnessValidator';
import type { ConnectedServiceSharedGenerationMutationCurrentness } from '../../credentials/lifecycleTypes';
import {
  resolveConnectedServiceMemberHoldAdmission,
  resolveConnectedServiceMemberHoldApplicationRefusal,
  type ConnectedServiceMemberHoldView,
} from '../holds/connectedServiceMemberHolds';
import type { GroupGenerationAppliedEvent } from '../../runtimeAuth/runtimeAuthAttemptAccountJoin';
import { mapCommittedGenerationApplyResult } from './mapCommittedGenerationApplyResult';
import type { ConnectedServiceAuthGroupGenerationConsumer } from './ConnectedServiceAuthGroupGenerationConsumer';

type ConsumerDeps = ConstructorParameters<typeof ConnectedServiceAuthGroupGenerationConsumer>[0];
type SharedApply = NonNullable<ConsumerDeps['applySharedGenerationApplication']>;

/**
 * The daemon's shared-surface application effect (Claude `shared_group_auth_surface`): resolve the
 * committed target's credential, then materialize it through the provider descriptor. Canonical
 * member holds are re-read AFTER the awaited credential resolution, immediately before the
 * protected materialization, so a hold written while the target was being prepared still wins
 * (the consumer's earlier admission alone could be stale). Only a fresh user action bypasses holds.
 *
 * Every attempted rewrite of the shared surface is reported to `recordGroupGenerationApplied`: all
 * sessions of the group run with the surface, so it bounds every earlier application of the group.
 */
export function createSharedGenerationApplication(deps: Readonly<{
  activeServerDir: string;
  resolveDescriptor: (ownerId: string) => Promise<Pick<ConnectedServiceCredentialLifecycleDescriptor, 'applySharedGenerationApplication'>>;
  resolveTargetCredential: (target: Readonly<{ serviceId: ConnectedServiceId; profileId: string }>) => Promise<Readonly<{
    credentialRevision: ConnectedServiceCredentialRevisionV1 | null;
    record: ConnectedServiceCredentialRecordV1;
  }> | null>;
  validateCurrentness: (target: ConnectedServiceGroupMutationTarget) => Promise<ConnectedServiceSharedGenerationMutationCurrentness>;
  readMemberHolds: (serviceId: ConnectedServiceId) => Promise<ConnectedServiceMemberHoldView>;
  nowMs: () => number;
  /** Evidence only: must not throw or block the application. */
  recordGroupGenerationApplied?: (event: GroupGenerationAppliedEvent) => void;
}>): SharedApply {
  return async (input) => {
    const target = input.committedGeneration.decisionCommittedTarget;
    const descriptor = await deps.resolveDescriptor(input.applicationOwnerId);
    if (!descriptor.applySharedGenerationApplication) {
      return { reconciliationDisposition: 'failed', errorCode: 'shared_generation_application_unavailable' };
    }
    const resolved = await deps.resolveTargetCredential({ serviceId: target.serviceId, profileId: target.profileId }).catch(() => {
      logger.warn('[DAEMON RUN] Shared account application credential read failed', {
        serviceId: target.serviceId, profileId: target.profileId, errorCode: 'credential_revision_read_failed',
      });
      return null;
    });
    if (!resolved || resolved.credentialRevision === null) {
      return { reconciliationDisposition: 'failed', errorCode: 'credential_revision_missing' };
    }
    if (resolveConnectedServiceMemberHoldAdmission(input.executionAuthority) === 'enforce') {
      const refusal = resolveConnectedServiceMemberHoldApplicationRefusal({
        view: await deps.readMemberHolds(target.serviceId),
        profileId: target.profileId,
        nowMs: deps.nowMs(),
      });
      if (refusal) return { reconciliationDisposition: 'failed', errorCode: refusal.errorCode };
    }
    const credentialRevision = resolved.credentialRevision;
    const startedAtMs = deps.nowMs();
    const proof = await descriptor.applySharedGenerationApplication({
      activeServerDir: deps.activeServerDir,
      serviceId: target.serviceId,
      groupId: target.groupId,
      profileId: target.profileId,
      generation: target.generation,
      credentialRevision,
      record: resolved.record,
      validateCurrentBeforeMutation: async () => await deps.validateCurrentness({
        serviceId: target.serviceId,
        groupId: target.groupId,
        profileId: target.profileId,
        generation: target.generation,
        credentialRevision,
      }),
    }).catch(() => {
      logger.warn('[DAEMON RUN] Shared account application failed', {
        serviceId: target.serviceId, profileId: target.profileId, errorCode: 'shared_generation_application_unavailable',
      });
      return { status: 'unavailable' as const };
    });
    deps.recordGroupGenerationApplied?.({
      v: 1,
      kind: 'group_generation_applied',
      sessionId: input.representativeSessionId,
      serviceId: target.serviceId,
      groupId: target.groupId,
      generation: target.generation,
      profileId: target.profileId,
      startedAtMs,
      outcome: proof.status === 'verified' && proof.credentialRevision === credentialRevision
        ? 'verified'
        : proof.status === 'superseded_after_apply' || proof.status === 'unavailable' ? proof.status : 'unverified',
      persistedAtMs: deps.nowMs(),
    });
    if (proof.status === 'superseded_after_apply') {
      return mapCommittedGenerationApplyResult({
        committedGeneration: input.committedGeneration,
        result: {
          status: 'superseded_after_apply',
          activeProfileId: proof.activeProfileId,
          generation: proof.generation,
          credentialRevision: proof.credentialRevision,
        },
      });
    }
    if (proof.status !== 'verified' || proof.credentialRevision !== credentialRevision) {
      return { reconciliationDisposition: 'failed', errorCode: 'shared_generation_application_unverified' };
    }
    return {
      reconciliationDisposition: 'converged',
      errorCode: null,
      providerAdoptedTarget: {
        ...target,
        credentialRevision,
        proof: {
          ...proof,
          status: 'verified',
        },
      },
    };
  };
}
