import { isDeepStrictEqual } from 'node:util';

import { ConnectedServiceBindingsV1Schema, type SessionConnectedServiceAuthSwitchRpcParams } from '@happier-dev/protocol';
import type { TrackedSession } from '@/daemon/types';
import { AGENTS } from '@/backends/catalog';
import { resolveTrackedSessionCatalogAgentId } from '@/daemon/sessions/resolveTrackedSessionCatalogAgentId';
import type { RuntimeAuthRecoveryIntent } from '../runtimeAuth/RuntimeAuthRecoveryScheduler';
import type { ConnectedServiceSessionAuthSwitchCore } from '../runtimeAuth/connectedServiceSessionAuthSwitchCore';
import { createQuotaRecoveryGuard, type QuotaRecoveryGuard, type QuotaRecoveryFailureSource } from './quotaRecoveryGuard';
import { resolveTrackedConnectedServiceVendorResumeId } from './resolveTrackedConnectedServiceSwitchContinuityContext';
import type { SessionConnectedServiceAuthSwitchResult } from './switchSessionConnectedServiceAuth';
import type { NativeProviderTurnSource } from '../connectedServiceTurnLifecycleContract';
import { NativeProviderTurnSourceSchema } from '../connectedServiceTurnLifecycleContract';
import type { ConnectedServiceRuntimeFailureClassification } from '../runtimeAuth/types';

type Request = SessionConnectedServiceAuthSwitchRpcParams & {
  quotaRecovery: NonNullable<SessionConnectedServiceAuthSwitchRpcParams['quotaRecovery']>;
};
type Occurrence = {
  request: Request;
  stage: 'entered' | 'restart_requested' | 'launched' | 'hot_applied' | 'failed' | 'unknown';
  enteredAtMs: number;
  settledAtMs?: number;
  result?: SessionConnectedServiceAuthSwitchResult;
  preservesOptions?: QuotaRecoveryGuard['preservesOptionsForNativeCompletion'];
  commitPendingCompletion?: () => void;
  verification?: NativeProviderTurnSource & Readonly<{
    useful: true; kind: 'completion'; turnId: string; atMs: number;
  }>;
};

/** Reuses the auth-switch lock and live tracked owner. No process or account client lives here. */
export function createGuardedQuotaRecovery(input: Readonly<{
  core: ConnectedServiceSessionAuthSwitchCore;
  getChildren(): ReadonlyArray<TrackedSession>;
  readRecoveryIntents(sessionId: string): ReadonlyArray<RuntimeAuthRecoveryIntent>;
  isTurnInFlight(sessionId: string): boolean;
  nowMs(): number;
}>) {
  const occurrences = new Map<string, Occurrence>();
  const restartByPid = new Map<number, Occurrence>();
  const lastNativeObservation = new Map<string, NativeProviderTurnSource>();
  const failureSources = new Map<string, QuotaRecoveryFailureSource & { turnId: string | null; reportId?: string }>();
  const matchesCurrentNative = (sessionId: string, source: NativeProviderTurnSource) => {
    const children = input.getChildren().filter((child) => child.happySessionId === sessionId);
    const tracked = children.length === 1 ? children[0] : undefined;
    return tracked !== undefined && (tracked.sessionRunnerPid ?? tracked.pid) === source.pid
      && tracked.publisherIncarnationId === source.publisherIncarnationId
      && resolveTrackedConnectedServiceVendorResumeId({ agentId: resolveTrackedSessionCatalogAgentId(tracked), tracked }) === source.nativeId;
  };
  const acceptNativeObservation = (sessionId: string, source: NativeProviderTurnSource) => {
    if (!NativeProviderTurnSourceSchema.safeParse(source).success || !matchesCurrentNative(sessionId, source)) return false;
    const previous = lastNativeObservation.get(sessionId);
    if (previous?.publisherIncarnationId === source.publisherIncarnationId
      && BigInt(source.sequence) <= BigInt(previous.sequence)) return false;
    lastNativeObservation.set(sessionId, { ...source });
    return true;
  };
  const key = (sessionId: string, requestId: string) => JSON.stringify([sessionId, requestId]);
  const summarize = (record: Occurrence) => ({
    protocolVersion: 1 as const, sessionId: record.request.sessionId,
    requestId: record.request.quotaRecovery.requestId, nativeId: record.request.quotaRecovery.nativeId,
    stage: record.stage, enteredAtMs: record.enteredAtMs,
    ...(record.settledAtMs === undefined ? {} : { settledAtMs: record.settledAtMs }),
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.verification === undefined ? {} : { verification: record.verification }),
  });
  return {
    beginFailureSource(failure: Readonly<{
      sessionId: string; classification: Pick<ConnectedServiceRuntimeFailureClassification, 'kind' | 'serviceId' | 'profileId'>;
      nativeProviderSource?: NativeProviderTurnSource; reportId?: string;
    }>) {
      const source = failure.nativeProviderSource;
      if (!source || !matchesCurrentNative(failure.sessionId, source)) return;
      let witness = failureSources.get(failure.sessionId);
      const duplicate = witness && isDeepStrictEqual(witness.nativeProviderSource, source)
        && witness.reportId === failure.reportId && witness.kind === failure.classification.kind
        && witness.serviceId === failure.classification.serviceId && witness.profileId === failure.classification.profileId;
      if (!duplicate) {
        if (!acceptNativeObservation(failure.sessionId, source)) return;
        const tracked = input.getChildren().find((child) => child.happySessionId === failure.sessionId)!;
        witness = { nativeProviderSource: { ...source }, kind: failure.classification.kind,
          serviceId: failure.classification.serviceId, profileId: failure.classification.profileId,
          attemptId: null, armedAtMs: null, observedAtMs: input.nowMs(),
          turnId: tracked.activeTurnId ?? null, reportId: failure.reportId };
        failureSources.set(failure.sessionId, witness);
      }
      const captured = witness!;
      // Capture before the intake awaits. A later start, terminal outcome or failure
      // can invalidate this record; its delayed acknowledgement must not resurrect it.
      return (attemptId?: string) => {
        if (failureSources.get(failure.sessionId) !== captured || !matchesCurrentNative(failure.sessionId, source)) return;
        const intents = input.readRecoveryIntents(failure.sessionId).filter((intent) => (
          intent.attemptId === attemptId && intent.serviceId === captured.serviceId && intent.profileId === captured.profileId
        ));
        if (intents.length !== 1) return;
        failureSources.set(failure.sessionId, Object.assign(captured, {
          attemptId: intents[0].attemptId, armedAtMs: intents[0].armedAtMs,
        }));
      };
    },
    prepareNativeCompletion(completion: Readonly<{
      sessionId: string; event: string; terminalStatus?: string; turnId?: string;
      nativeProviderSource?: NativeProviderTurnSource;
    }>): (() => void) | null {
      const source = completion.nativeProviderSource;
      if (!source) return null;
      const children = input.getChildren().filter((child) => child.happySessionId === completion.sessionId);
      const tracked = children.length === 1 ? children[0] : undefined;
      if (!tracked) return null;
      const terminal = completion.event === 'assistant_message_end';
      if (terminal && (!completion.turnId || tracked.activeTurnId !== completion.turnId)) return null;
      if (!acceptNativeObservation(completion.sessionId, source)) return null;
      const failure = failureSources.get(completion.sessionId);
      const ownFailedTurn = terminal && completion.terminalStatus === 'failed'
        && failure?.turnId !== null && failure?.turnId === completion.turnId;
      if (!ownFailedTurn) failureSources.delete(completion.sessionId);
      if (!terminal || completion.terminalStatus !== 'completed') return null;
      const matchesSource = () => {
        const current = input.getChildren().filter((child) => child.happySessionId === completion.sessionId);
        return current.length === 1 && current[0] === tracked
          && (tracked.sessionRunnerPid ?? tracked.pid) === source.pid
          && tracked.publisherIncarnationId === source.publisherIncarnationId
          && resolveTrackedConnectedServiceVendorResumeId({
            agentId: resolveTrackedSessionCatalogAgentId(tracked), tracked,
          }) === source.nativeId;
      };
      if (!matchesSource()) return null;
      const atMs = input.nowMs();
      const record = [...occurrences.values()].filter((candidate) => candidate.request.sessionId === completion.sessionId).at(-1);
      return () => {
        // Called only after the real marker owner acknowledges the exact turn. Recheck
        // publisher/native ownership across that awaited write before retaining proof.
        if (!matchesSource() || !isDeepStrictEqual(lastNativeObservation.get(completion.sessionId), source)) return;
        if (!record || record.request.quotaRecovery.nativeId !== source.nativeId || atMs <= record.enteredAtMs) return;
        if (record.request.quotaRecovery.nativePublisherIncarnationId === source.publisherIncarnationId
          && BigInt(source.sequence) <= BigInt(record.request.quotaRecovery.nativeObservationSequence)) return;
        if (tracked.spawnOptionsCustody !== 'accepted_live_launch'
          || !tracked.spawnOptions || !record.preservesOptions?.(tracked.spawnOptions)) return;
        const binding = ConnectedServiceBindingsV1Schema.safeParse(tracked.spawnOptions?.connectedServices).data
          ?.bindingsByServiceId[record.request.quotaRecovery.serviceId];
        const destination = record.request.bindings.bindingsByServiceId[record.request.quotaRecovery.serviceId];
        if (binding?.source !== 'connected' || destination?.source !== 'connected'
          || binding.profileId !== destination.profileId) return;
        const commitAcceptedCompletion = () => {
          if (!matchesSource() || tracked.spawnOptionsCustody !== 'accepted_live_launch'
            || !tracked.spawnOptions || !record.preservesOptions?.(tracked.spawnOptions)
            || (record.stage !== 'hot_applied' && record.stage !== 'launched')) return;
          record.verification = { ...source, useful: true, kind: 'completion', turnId: completion.turnId!, atMs };
        };
        // A real turn can finish before the HTTP acknowledgement. Keep that
        // exact evidence private until the account transition is accepted.
        record.commitPendingCompletion = commitAcceptedCompletion;
        commitAcceptedCompletion();
      };
    },
    inspect(sessionId: string, requestId?: string) {
      if (requestId !== undefined) {
        const record = occurrences.get(key(sessionId, requestId));
        return record ? { ok: true as const, occurrence: summarize(record) }
          : { ok: false as const, errorCode: 'quota_recovery_occurrence_unknown' };
      }
      const children = input.getChildren().filter((child) => child.happySessionId === sessionId);
      const tracked = children.length === 1 ? children[0] : undefined;
      if (!tracked?.spawnOptions || tracked.startedBy !== 'daemon' || tracked.reattachedFromDiskMarker === true
        || tracked.spawnOptionsCustody !== 'accepted_live_launch'
        || !tracked.processInstanceFingerprint || input.isTurnInFlight(sessionId)) {
        return { ok: false as const, errorCode: 'quota_recovery_source_unavailable' };
      }
      const agentId = resolveTrackedSessionCatalogAgentId(tracked);
      const serviceId = AGENTS[agentId]?.guardedQuotaRecoveryServiceId ?? null;
      const nativeId = resolveTrackedConnectedServiceVendorResumeId({ agentId, tracked });
      const bindings = ConnectedServiceBindingsV1Schema.safeParse(tracked.spawnOptions.connectedServices).data;
      const binding = serviceId ? bindings?.bindingsByServiceId[serviceId] : null;
      const failures = input.readRecoveryIntents(sessionId).filter((failure) => (
        failure.serviceId === serviceId && failure.profileId === (binding?.source === 'connected' ? binding.profileId : null)
        && failure.classification.kind === 'usage_limit'
        && ['waiting', 'checking', 'exhausted'].includes(failure.status)
      ));
      const failure = failures.length === 1 ? failures[0] : undefined;
      const witness = failureSources.get(sessionId);
      if (!serviceId || !nativeId || binding?.source !== 'connected' || binding.selection === 'group'
        || !failure?.attemptId || !witness || witness.kind !== 'usage_limit'
        || witness.serviceId !== serviceId || witness.profileId !== binding.profileId
        || witness.attemptId !== failure.attemptId || witness.armedAtMs !== failure.armedAtMs
        || !matchesCurrentNative(sessionId, witness.nativeProviderSource)) {
        return { ok: false as const, errorCode: 'quota_recovery_current_refusal_unavailable' };
      }
      // No option export is reconstructed from persisted metadata. The guarded transition
      // below captures and checks the complete live options inside this daemon instead.
      return { ok: true as const, protocolVersion: 1 as const, sessionId, agentId,
        source: { nativeId, pid: tracked.pid, processInstanceFingerprint: tracked.processInstanceFingerprint,
          serviceId, profileId: binding.profileId, failureAttemptId: failure.attemptId,
          failureArmedAtMs: failure.armedAtMs,
          nativePublisherIncarnationId: witness.nativeProviderSource.publisherIncarnationId,
          nativeObservationSequence: witness.nativeProviderSource.sequence,
          failureObservedAtMs: witness.observedAtMs },
        bindings,
        preservation: 'daemon_owned_tracked_options' as const };
    },
    async run(request: Request, execute: (guard: QuotaRecoveryGuard) => Promise<SessionConnectedServiceAuthSwitchResult>) {
      return await input.core.run({ sessionId: request.sessionId, reason: 'automatic_runtime_failure', execute: async () => {
        const occurrenceKey = key(request.sessionId, request.quotaRecovery.requestId);
        const previous = occurrences.get(occurrenceKey);
        if (previous) {
          if (!isDeepStrictEqual(previous.request, request)) {
            return { ok: false as const, errorCode: 'quota_recovery_request_id_conflict' };
          }
          return { ok: true as const, occurrence: summarize(previous) };
        }
        for (const retained of occurrences.values()) {
          if (retained.request.sessionId !== request.sessionId) continue;
          if (['entered', 'unknown', 'restart_requested', 'failed'].includes(retained.stage)
            || (retained.request.quotaRecovery.nativePublisherIncarnationId === request.quotaRecovery.nativePublisherIncarnationId
              && retained.request.quotaRecovery.nativeObservationSequence === request.quotaRecovery.nativeObservationSequence)) {
            return { ok: false as const, errorCode: 'quota_recovery_prior_occurrence_unreconciled' };
          }
        }
        const tracked = input.getChildren().find((child) => child.happySessionId === request.sessionId);
        const agentId = tracked ? resolveTrackedSessionCatalogAgentId(tracked) : null;
        if (!agentId || agentId !== request.agentId
          || AGENTS[agentId]?.guardedQuotaRecoveryServiceId !== request.quotaRecovery.serviceId) {
          return { ok: false as const, errorCode: 'quota_recovery_source_unavailable' };
        }
        const destination = request.bindings.bindingsByServiceId[request.quotaRecovery.serviceId];
        if (destination?.source !== 'connected' || destination.selection === 'group') {
          return { ok: false as const, errorCode: 'quota_recovery_account_selection_unsupported' };
        }
        const guard = createQuotaRecoveryGuard({
          expected: { ...request.quotaRecovery, sessionId: request.sessionId, agentId },
          destinationProfileId: destination.profileId,
          getChildren: input.getChildren,
          readRecoveryIntents: () => input.readRecoveryIntents(request.sessionId),
          readFailureSource: () => failureSources.get(request.sessionId) ?? null,
          isTurnInFlight: () => input.isTurnInFlight(request.sessionId),
        });
        guard.assertCurrent();
        guard.assertBindings(request.bindings);
        const record: Occurrence = { request: structuredClone(request), stage: 'entered', enteredAtMs: input.nowMs(),
          preservesOptions: guard.preservesOptionsForNativeCompletion };
        // The caller's shared durable journal precedes this request. This in-process receipt
        // permits read-only reconciliation; daemon loss returns UNKNOWN, never retry authority.
        occurrences.set(occurrenceKey, record);
        restartByPid.set(request.quotaRecovery.pid, record);
        try {
          record.result = await execute(guard);
          record.stage = record.stage === 'launched' ? 'launched' : record.result.ok
            ? record.result.action === 'restart_requested' ? 'restart_requested'
              : record.result.action === 'hot_applied' ? 'hot_applied' : 'unknown'
            : 'unknown';
          record.settledAtMs = input.nowMs();
          record.commitPendingCompletion?.();
          if (record.stage !== 'restart_requested') restartByPid.delete(request.quotaRecovery.pid);
          return { ok: true as const, occurrence: summarize(record) };
        } catch (error) {
          record.stage = 'unknown';
          record.settledAtMs = input.nowMs();
          throw error;
        }
      } });
    },
    restartForPid(pid: number) {
      const record = restartByPid.get(pid);
      return record ? { requestId: record.request.quotaRecovery.requestId,
        nativeId: record.request.quotaRecovery.nativeId } : null;
    },
    settleRestart(previousPid: number, next: TrackedSession | null) {
      const record = restartByPid.get(previousPid);
      if (!record || !next) return;
      const agentId = resolveTrackedSessionCatalogAgentId(next);
      if (next.happySessionId !== record.request.sessionId
        || resolveTrackedConnectedServiceVendorResumeId({ agentId, tracked: next }) !== record.request.quotaRecovery.nativeId) return;
      record.stage = 'launched';
      record.settledAtMs = input.nowMs();
      record.commitPendingCompletion?.();
      restartByPid.delete(previousPid);
    },
    failRestart(previousPid: number) {
      const record = restartByPid.get(previousPid);
      if (!record) return;
      record.stage = 'failed';
      record.settledAtMs = input.nowMs();
      restartByPid.delete(previousPid);
    },
  };
}
