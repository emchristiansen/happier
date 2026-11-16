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
  /** The live process instance at `pid` (Linux `/proc`), or null when unknown. */
  readProcessInstance?: (pid: number) => string | null;
}>): ProviderObservationProvenanceResolution {
  if (input.runnerPid === undefined) return { kind: 'evidence', provenance: null };
  if (input.runnerPid !== input.tracked.pid && input.runnerPid !== input.tracked.sessionRunnerPid) {
    return { kind: 'not_current_runner' };
  }
  if (!input.launchHome) return { kind: 'evidence', provenance: null };
  const runnerPid = input.runnerPid;
  // The tracked launcher's own identity, used only when the report comes from that very process: launch
  // custody records exactly it. A split wrapper's reporter never inherits it: the tracked wrapper pid
  // proves nothing about the process now at the reporter pid, which may be a foreign incarnation of a
  // stale reporter pid (R20-LINEAGE-CONSUMER-01).
  const launcher = runnerPid === input.tracked.pid ? readTrackedLauncherIdentity(input.tracked) : null;
  return {
    kind: 'evidence',
    provenance: {
      launchHome: input.launchHome,
      isDecisionLaunchedInRunner: (decisionId) => {
        if (launcher !== null && input.isDecisionLaunchedInRunner(decisionId, launcher)) return true;
        // The reporting process by its own exact instance: its bound wrapper lineage or exact custody.
        const instance = input.readProcessInstance?.(runnerPid) ?? null;
        if (instance !== null && input.isDecisionLaunchedInRunner(
          decisionId, { pid: runnerPid, processInstanceFingerprint: instance }, { requireFingerprint: true },
        )) return true;
        // Its live parent, matched by exact process instance (never by pid alone), is the wrapper launch
        // that custody recorded for this decision.
        const parent = input.readParentProcess?.(runnerPid) ?? null;
        return parent !== null && parent.processInstanceFingerprint !== undefined
          && input.isDecisionLaunchedInRunner(decisionId, parent, { requireFingerprint: true });
      },
    },
  };
}
