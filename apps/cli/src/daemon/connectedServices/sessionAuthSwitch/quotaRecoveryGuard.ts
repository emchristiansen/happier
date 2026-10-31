import { isDeepStrictEqual } from 'node:util';

import { ConnectedServiceBindingsV1Schema, type ConnectedServiceId, type ConnectedServiceBindingsV1 } from '@happier-dev/protocol';
import type { CatalogAgentId } from '@/backends/types';
import type { TrackedSession } from '@/daemon/types';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import type { NativeProviderTurnSource } from '../connectedServiceTurnLifecycleContract';
import { resolveTrackedConnectedServiceVendorResumeId } from './resolveTrackedConnectedServiceSwitchContinuityContext';

export type QuotaRecoveryExpectedSource = Readonly<{
  sessionId: string;
  agentId: CatalogAgentId;
  nativeId: string;
  pid: number;
  processInstanceFingerprint: string;
  serviceId: ConnectedServiceId;
  profileId: string;
  failureAttemptId: string;
  failureArmedAtMs: number;
  nativePublisherIncarnationId: string;
  nativeObservationSequence: string;
  failureObservedAtMs: number;
}>;

export type QuotaRecoveryFailureSource = Readonly<{
  nativeProviderSource: NativeProviderTurnSource;
  kind: string; serviceId: string; profileId: string | null;
  attemptId: string | null; armedAtMs: number | null; observedAtMs: number;
}>;

export type QuotaRecoveryGuard = Readonly<{
  assertCurrent(): void;
  assertBindings(bindings: ConnectedServiceBindingsV1): void;
  acceptAccountChange(next: SpawnSessionOptions): void;
  preservesOptionsForNativeCompletion(next: SpawnSessionOptions): boolean;
}>;

function withoutAccountSelection(options: SpawnSessionOptions) {
  const { connectedServices: _bindings, connectedServicesUpdatedAt: _updated,
    connectedServiceMaterializationIdentityV1: _materialization,
    environmentVariables, ...preserved } = options;
  const environment = { ...environmentVariables };
  delete environment[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  return { ...preserved, environmentVariables: environment };
}

function childSelections(options: SpawnSessionOptions, serviceId: string) {
  const raw = options.environmentVariables?.[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
  const selections: unknown = raw === undefined ? [] : JSON.parse(raw);
  if (!Array.isArray(selections) || selections.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('quota_recovery_account_environment_unsupported');
  }
  const selected = selections.filter((item) => item.serviceId === serviceId);
  if (selected.length > 1) throw new Error('quota_recovery_account_environment_unsupported');
  return { selected: selected[0], others: selections.filter((item) => item.serviceId !== serviceId) };
}

/** The live daemon owns these readers; no external reconstruction of spawn options is used. */
export function createQuotaRecoveryGuard(input: Readonly<{
  expected: QuotaRecoveryExpectedSource;
  destinationProfileId: string;
  getChildren(): ReadonlyArray<TrackedSession>;
  readRecoveryIntents(): ReadonlyArray<RuntimeAuthRecoveryIntent>;
  readFailureSource(): QuotaRecoveryFailureSource | null;
  isTurnInFlight(): boolean;
}>): QuotaRecoveryGuard {
  const expected = input.expected;
  const candidates = input.getChildren().filter((child) => child.happySessionId === expected.sessionId);
  const original = candidates.length === 1 ? candidates[0] : undefined;
  // A non-cloneable tracked input is an explicit unsupported preservation case, never absence.
  let expectedOptions = original?.spawnOptions ? structuredClone(original.spawnOptions) : null;
  const assertCurrent = () => {
      const children = input.getChildren().filter((child) => child.happySessionId === expected.sessionId);
      const current = children.length === 1 ? children[0] : undefined;
      const intents = input.readRecoveryIntents().filter((intent) => (
        intent.sessionId === expected.sessionId && intent.serviceId === expected.serviceId
        && intent.profileId === expected.profileId && ['waiting', 'checking', 'exhausted'].includes(intent.status)
      ));
      const failure = intents.length === 1 ? intents[0] : undefined;
      const witness = input.readFailureSource();
      if (
        !original || !expectedOptions || current !== original
        || current.pid !== expected.pid
        || !expected.processInstanceFingerprint
        || current.processInstanceFingerprint !== expected.processInstanceFingerprint
        || !expected.nativeId
        || (Boolean(expectedOptions.resume) && expectedOptions.resume !== expected.nativeId)
        || resolveTrackedConnectedServiceVendorResumeId({ agentId: expected.agentId, tracked: current }) !== expected.nativeId
        || current.stopRequestedAtMs !== undefined
        || input.isTurnInFlight()
        || !isDeepStrictEqual(current.spawnOptions, expectedOptions)
        || !witness || witness.kind !== 'usage_limit'
        || witness.serviceId !== expected.serviceId || witness.profileId !== expected.profileId
        || witness.attemptId !== expected.failureAttemptId || witness.armedAtMs !== expected.failureArmedAtMs
        || witness.observedAtMs !== expected.failureObservedAtMs
        || witness.nativeProviderSource.nativeId !== expected.nativeId
        || witness.nativeProviderSource.pid !== (current.sessionRunnerPid ?? current.pid)
        || witness.nativeProviderSource.publisherIncarnationId !== current.publisherIncarnationId
        || witness.nativeProviderSource.publisherIncarnationId !== expected.nativePublisherIncarnationId
        || witness.nativeProviderSource.sequence !== expected.nativeObservationSequence
        || !failure || !expected.failureAttemptId
        || failure.attemptId !== expected.failureAttemptId
        || failure.armedAtMs !== expected.failureArmedAtMs
        || !['waiting', 'checking', 'exhausted'].includes(failure.status)
        || failure.profileId !== expected.profileId
        || failure.classification.kind !== 'usage_limit'
        || failure.classification.serviceId !== expected.serviceId
        || failure.classification.profileId !== expected.profileId
        || !['structured_provider_error', 'stable_provider_message', 'provider_runtime_marker']
          .includes(failure.classification.source)
      ) {
        throw new Error('quota_recovery_current_source_changed');
      }
  };
  const assertBindings = (next: ConnectedServiceBindingsV1) => {
    const before = ConnectedServiceBindingsV1Schema.safeParse(expectedOptions?.connectedServices).data;
    const previous = before?.bindingsByServiceId[expected.serviceId];
    const bindings = structuredClone(before);
    if (
      !bindings || previous?.source !== 'connected' || previous.selection === 'group'
      || previous.profileId !== expected.profileId
      || !input.destinationProfileId || input.destinationProfileId === expected.profileId
    ) throw new Error('quota_recovery_account_selection_unsupported');
    bindings.bindingsByServiceId[expected.serviceId] = {
      source: 'connected', selection: 'profile', profileId: input.destinationProfileId,
    };
    if (!isDeepStrictEqual(next, bindings)) {
      throw new Error('quota_recovery_non_account_options_changed');
    }
  };
  return {
    assertCurrent,
    assertBindings,
    preservesOptionsForNativeCompletion(next) {
      const continuityOptions = (options: SpawnSessionOptions) => {
        // These identify the new launch or its account materialization, not a
        // change to the conversation, permissions or still-owned inputs.
        const { spawnNonce: _nonce, sessionId: _newId, existingSessionId: _existingId,
          resume: _resume, connectedServiceMaterializationIdentityV1: _materialization, ...retained } = options;
        return retained;
      };
      return expectedOptions !== null && isDeepStrictEqual(continuityOptions(next), continuityOptions(expectedOptions));
    },
    acceptAccountChange(next) {
      assertCurrent();
      const before = expectedOptions!;
      const bindings = ConnectedServiceBindingsV1Schema.parse(next.connectedServices);
      assertBindings(bindings);
      if (!isDeepStrictEqual(withoutAccountSelection(before), withoutAccountSelection(next))) {
        throw new Error('quota_recovery_non_account_options_changed');
      }
      const previousEnvironment = childSelections(before, expected.serviceId);
      const nextEnvironment = childSelections(next, expected.serviceId);
      if (!isDeepStrictEqual(previousEnvironment.others, nextEnvironment.others)
        || nextEnvironment.selected?.kind !== 'profile'
        || nextEnvironment.selected.profileId !== input.destinationProfileId) {
        throw new Error('quota_recovery_non_account_environment_changed');
      }
      expectedOptions = structuredClone(next);
    },
  };
}
