import { describe, expect, it } from 'vitest';

import type { PerSessionAssignmentRunner } from '../accountGroups/perSession/PerSessionAssignmentLedger';
import { projectProviderObservedAccountMetadata, resolveAdoptedPerSessionDecisionId } from './providerObservedAccountMetadata';
import { resolveProviderObservationProvenance } from './resolveProviderObservationProvenance';

// Ledger launch custody of decision `d-2` (the pending member-home target) in launcher pid 42.
const launches = new Map<string, PerSessionAssignmentRunner>([['d-2', { pid: 42, processInstanceFingerprint: 'fp-42' }]]);
const isDecisionLaunchedInRunner = (
  decisionId: string,
  runner: PerSessionAssignmentRunner,
  options?: Readonly<{ requireFingerprint?: boolean }>,
) => {
  const launched = launches.get(decisionId);
  if (!launched || launched.pid !== runner.pid) return false;
  if (options?.requireFingerprint) {
    return launched.processInstanceFingerprint !== undefined && launched.processInstanceFingerprint === runner.processInstanceFingerprint;
  }
  return !launched.processInstanceFingerprint || !runner.processInstanceFingerprint
    || launched.processInstanceFingerprint === runner.processInstanceFingerprint;
};
const currentRunner = { pid: 42, processInstanceFingerprint: 'fp-42' };

const metadata = {
  connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': {
    source: 'connected', selection: 'group', groupId: 'pool',
    member: { assignment: 'per_session', profileId: 'alpha', decisionId: 'd-1', reason: 'initial_sampled', appliedAtMs: 1 },
    materializedAssignment: { profileId: 'alpha', decisionId: 'd-2', reason: 'failover', fromProfileId: 'alpha', materializedAtMs: 300 },
  } } },
};

function project(resolution: ReturnType<typeof resolveProviderObservationProvenance>) {
  if (resolution.kind !== 'evidence') throw new Error(`expected evidence, got ${resolution.kind}`);
  const projected = projectProviderObservedAccountMetadata(metadata, {
    serviceId: 'claude-subscription', groupId: 'pool', profileId: 'alpha', observedAtMs: 400, provenance: resolution.provenance,
  });
  return resolveAdoptedPerSessionDecisionId(metadata, projected, 'claude-subscription');
}

describe('provider observation provenance', () => {
  it('rejects a delayed report from a replaced runner of the same native session (R15-STALE-PROOF-02)', () => {
    expect(resolveProviderObservationProvenance({
      tracked: currentRunner, runnerPid: 41, launchHome: 'member', isDecisionLaunchedInRunner,
    })).toEqual({ kind: 'not_current_runner' });
  });

  it('adopts the pending target only from the runner its launch custody names', () => {
    expect(project(resolveProviderObservationProvenance({
      tracked: currentRunner, runnerPid: 42, launchHome: 'member', isDecisionLaunchedInRunner,
    }))).toBe('d-2');
  });

  it('accepts a wrapper child reporting as the session runner, with the launcher as launch identity', () => {
    expect(project(resolveProviderObservationProvenance({
      tracked: { ...currentRunner, sessionRunnerPid: 77 }, runnerPid: 77, launchHome: 'member', isDecisionLaunchedInRunner,
    }))).toBe('d-2');
  });

  it('does not adopt from the current runner when the target was launched elsewhere (same member, earlier launch)', () => {
    expect(project(resolveProviderObservationProvenance({
      tracked: { pid: 43 }, runnerPid: 43, launchHome: 'member', isDecisionLaunchedInRunner,
    }))).toBeNull();
  });

  it('treats a report without provenance (older runner build) as account evidence only', () => {
    const resolution = resolveProviderObservationProvenance({
      tracked: currentRunner, runnerPid: undefined, launchHome: undefined, isDecisionLaunchedInRunner,
    });
    expect(resolution).toEqual({ kind: 'evidence', provenance: null });
    expect(project(resolution)).toBeNull();
    expect(project(resolveProviderObservationProvenance({
      tracked: currentRunner, runnerPid: 42, launchHome: undefined, isDecisionLaunchedInRunner,
    }))).toBeNull();
  });

  // R16-WRAPPER-02: after a daemon restart the reattached tracker names the wrapper's reporter child;
  // launch custody names the wrapper, the child's live parent.
  describe('a wrapper child reattached from its marker', () => {
    const reattached = { pid: 77, processInstanceFingerprint: 'fp-77' };
    const resolve = (parent: PerSessionAssignmentRunner | null) => resolveProviderObservationProvenance({
      tracked: reattached, runnerPid: 77, launchHome: 'member', isDecisionLaunchedInRunner, readParentProcess: () => parent,
    });

    it('adopts through its live parent when that parent is exactly the launch custody names', () => {
      expect(project(resolve({ pid: 42, processInstanceFingerprint: 'fp-42' }))).toBe('d-2');
    });

    it.each([
      ['a reused parent pid with another process instance', { pid: 42, processInstanceFingerprint: 'fp-reused' }],
      ['a parent without a process instance', { pid: 42 }],
      ['an unrelated parent', { pid: 50, processInstanceFingerprint: 'fp-50' }],
      ['no readable parent', null],
    ] as const)('does not adopt through %s', (_label, parent) => {
      expect(project(resolve(parent))).toBeNull();
    });
  });
});

