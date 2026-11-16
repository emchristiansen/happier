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
  isDecisionLaunchedInRunner: (
    decisionId: string,
    runner: PerSessionAssignmentRunner,
    options?: Readonly<{ requireFingerprint?: boolean }>,
  ) => boolean;
  /**
   * The live parent process of `pid` with its instance fingerprint, or null. A runner started by a
   * wrapper is tracked by the reporter child's pid once reattached from its marker; its launch custody
   * names the wrapper, its parent.
   */
  readParentProcess?: (pid: number) => PerSessionAssignmentRunner | null;
}>): ProviderObservationProvenanceResolution {
  if (input.runnerPid === undefined) return { kind: 'evidence', provenance: null };
  if (input.runnerPid !== input.tracked.pid && input.runnerPid !== input.tracked.sessionRunnerPid) {
    return { kind: 'not_current_runner' };
  }
  if (!input.launchHome) return { kind: 'evidence', provenance: null };
  // Launch custody records the launcher process the daemon tracks, never a wrapper's child.
  const launcher = readTrackedLauncherIdentity(input.tracked);
  const runnerPid = input.runnerPid;
  return {
    kind: 'evidence',
    provenance: {
      launchHome: input.launchHome,
      isDecisionLaunchedInRunner: (decisionId) => {
        if (launcher !== null && input.isDecisionLaunchedInRunner(decisionId, launcher)) return true;
        // The current runner's own parent, matched by exact process instance (never by pid alone), is
        // the wrapper launch that custody recorded for this decision.
        const parent = input.readParentProcess?.(runnerPid) ?? null;
        return parent !== null && parent.processInstanceFingerprint !== undefined
          && input.isDecisionLaunchedInRunner(decisionId, parent, { requireFingerprint: true });
      },
    },
  };
}
