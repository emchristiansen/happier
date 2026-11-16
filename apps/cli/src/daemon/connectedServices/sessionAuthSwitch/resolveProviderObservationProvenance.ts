import type { PerSessionAssignmentRunner } from '../accountGroups/perSession/PerSessionAssignmentLedger';
import { readTrackedLauncherIdentity } from '../accountGroups/perSession/readTrackedLauncherIdentity';
import type { ProviderObservedAccountProvenance } from './providerObservedAccountMetadata';

type TrackedRunnerLike = Readonly<{
  pid?: number;
  sessionRunnerPid?: number;
  processInstanceFingerprint?: string;
}>;

/**
 * What a provider-identity report may prove about the session's current runner:
 * - `not_current_runner`: the report names a process other than the tracked launcher or its reported
 *   session runner (a delayed report of a replaced runner, which keeps the native session id). It is
 *   rejected outright.
 * - `evidence`: account evidence, with provenance only when the report names the current runner and
 *   the home its launch materialized. Without provenance (an older runner build) the evidence never
 *   adopts or converts a per-session target.
 */
export type ProviderObservationProvenanceResolution =
  | Readonly<{ kind: 'not_current_runner' }>
  | Readonly<{ kind: 'evidence'; provenance: ProviderObservedAccountProvenance | null }>;

export function resolveProviderObservationProvenance(input: Readonly<{
  tracked: TrackedRunnerLike;
  runnerPid: number | undefined;
  launchHome: 'group' | 'member' | undefined;
  isDecisionLaunchedInRunner: (decisionId: string, runner: PerSessionAssignmentRunner) => boolean;
}>): ProviderObservationProvenanceResolution {
  if (input.runnerPid === undefined) return { kind: 'evidence', provenance: null };
  if (input.runnerPid !== input.tracked.pid && input.runnerPid !== input.tracked.sessionRunnerPid) {
    return { kind: 'not_current_runner' };
  }
  if (!input.launchHome) return { kind: 'evidence', provenance: null };
  // Launch custody records the launcher process the daemon tracks, never a wrapper's child.
  const launcher = readTrackedLauncherIdentity(input.tracked);
  return {
    kind: 'evidence',
    provenance: {
      launchHome: input.launchHome,
      isDecisionLaunchedInRunner: (decisionId) => launcher !== null && input.isDecisionLaunchedInRunner(decisionId, launcher),
    },
  };
}
