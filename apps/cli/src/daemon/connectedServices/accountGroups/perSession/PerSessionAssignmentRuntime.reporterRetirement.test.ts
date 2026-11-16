import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PerSessionAssignmentLedger, type PerSessionAssignmentRunner } from './PerSessionAssignmentLedger';
import { PerSessionAssignmentRuntime } from './PerSessionAssignmentRuntime';

// R20-REPORTER-RETIRE-01 (reviewer probe reviewerReporterCustody.test.ts, adopted and extended): a
// wrapper launch's exact bound reporter child is a live witness of the launch; the wrapper's absence
// alone never retires the decision.
const wrapper = { pid: 42, processInstanceFingerprint: 'fp-42' };
const reporter = { pid: 77, processInstanceFingerprint: 'fp-77' };

async function boundLedgerPath(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'per-session-reporter-retire-')), 'ledger.json');
  const ledger = new PerSessionAssignmentLedger(path);
  await ledger.recordProposal({
    decisionId: 'd', sessionId: 's', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', nowMs: 1,
    proposal: {
      decisionId: 'd', proposalRevision: 1, profileId: 'alpha', reason: 'initial_sampled', fromProfileId: null,
      temperature: 1.5, offsetPercent: 10, probability: 0.4, decidedAtMs: 1, custody: 'reserved', observedReservationRevision: 1,
    },
  });
  await ledger.recordSpawnCustody({ spawnDecisionIds: ['d'], launchedDecisionIds: ['d'], runner: wrapper, nowMs: 2 });
  await ledger.recordLaunchedReporter({ launcher: wrapper, reporter, nowMs: 3 });
  return path;
}

function runtimeOn(path: string, present: (runner: PerSessionAssignmentRunner) => boolean) {
  const probes: number[] = [];
  const ledger = new PerSessionAssignmentLedger(path);
  const runtime = new PerSessionAssignmentRuntime({
    ledger, ownerMachineId: 'm', reservationApi: null, nowMs: () => 100,
    listLiveDecisions: () => [], listLiveSubjectIds: () => new Set(),
    probeRunnerPresence: async (runner) => { probes.push(runner.pid); return present(runner) ? 'present' : 'absent'; },
  });
  return { runtime, ledger, probes };
}

describe('per-session retirement with a bound wrapper reporter', () => {
  it.each(['tick', 'offline-ended-wrapper'] as const)('keeps the decision through %s while the exact bound reporter is present', async (mode) => {
    const path = await boundLedgerPath();
    const { runtime, ledger } = runtimeOn(path, (runner) => runner.pid !== wrapper.pid);
    expect(runtime.isDecisionLaunchedInRunner('d', reporter)).toBe(true);
    if (mode === 'tick') await runtime.tick(); else await runtime.releaseForEndedRunnerPids([wrapper.pid]);
    expect(ledger.get('d')).not.toBeNull();
    expect(runtime.isDecisionLaunchedInRunner('d', reporter)).toBe(true);
  });

  it('retires the decision on the tick once the wrapper and its reporter are both proved absent', async () => {
    const { runtime, ledger, probes } = runtimeOn(await boundLedgerPath(), () => false);
    await runtime.tick();
    expect(probes).toEqual([wrapper.pid, reporter.pid]);
    expect(ledger.get('d') ?? null).toBeNull();
  });

  it('retires the decision when the reporter pid now belongs to another process instance (reused pid)', async () => {
    // The production probe reports a fingerprint mismatch as absent; the reporter is gone.
    const { runtime, ledger } = runtimeOn(await boundLedgerPath(), (runner) => runner.pid === reporter.pid && runner.processInstanceFingerprint === 'fp-other');
    await runtime.tick();
    expect(ledger.get('d') ?? null).toBeNull();
  });

  it('retires offline when the reporter pid also ended, and leaves a surviving reporter to the tick', async () => {
    const both = runtimeOn(await boundLedgerPath(), () => false);
    await both.runtime.releaseForEndedRunnerPids([wrapper.pid, reporter.pid]);
    expect(both.ledger.get('d') ?? null).toBeNull();
    const wrapperOnly = runtimeOn(await boundLedgerPath(), () => false);
    await wrapperOnly.runtime.releaseForEndedRunnerPids([wrapper.pid]);
    expect(wrapperOnly.ledger.get('d')).not.toBeNull();
    await wrapperOnly.runtime.tick();
    expect(wrapperOnly.ledger.get('d') ?? null).toBeNull();
  });
});
