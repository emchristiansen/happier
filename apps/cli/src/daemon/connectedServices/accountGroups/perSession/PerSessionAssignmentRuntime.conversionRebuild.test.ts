import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createConnectedServiceMaterializationIdentity } from '../../materialize/createConnectedServiceMaterializationIdentity';
import { PerSessionAssignmentLedger } from './PerSessionAssignmentLedger';
import { PerSessionAssignmentRuntime, type PerSessionProvedSharedConversion } from './PerSessionAssignmentRuntime';
import { collectPerSessionLiveDecisions, collectPerSessionLiveSubjectIds } from './collectPerSessionLiveDecisions';

// R20-CONVERSION-REBUILD-01 (reviewer probe reviewerConversionTick.test.ts, adopted and extended).
const convertedRunner = { pid: 222, processInstanceFingerprint: 'fp-222' };
const oldRunner = { pid: 111, processInstanceFingerprint: 'fp-111' };

async function scenario(options: Readonly<{ readback: boolean; oldCarrier: 'none' | 'before' | 'after' }>) {
  const identity = createConnectedServiceMaterializationIdentity();
  const ledger = new PerSessionAssignmentLedger(join(await mkdtemp(join(tmpdir(), 'per-session-conversion-')), 'ledger.json'));
  await ledger.recordProposal({
    decisionId: 'd1', sessionId: identity.id, serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', nowMs: 1,
    proposal: {
      decisionId: 'd1', proposalRevision: 1, profileId: 'alpha', reason: 'initial_sampled', fromProfileId: null,
      temperature: 1.5, offsetPercent: 10, probability: 0.4, decidedAtMs: 1, custody: 'reserved', observedReservationRevision: 1,
    },
  });
  await ledger.markApplied('d1', 2);
  const memberHomeMetadata = {
    connectedServiceMaterializationIdentityV1: identity,
    connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': {
      source: 'connected', selection: 'group', groupId: 'pool',
      member: { assignment: 'per_session', profileId: 'alpha', decisionId: 'd1', reason: 'initial_sampled', appliedAtMs: 2 },
    } } },
  };
  // The converted runner's local metadata lags: it still lists the previous member.
  const converted = { ...convertedRunner, happySessionId: 's', happySessionMetadataFromLocalWebhook: memberHomeMetadata as Record<string, unknown> };
  const old = { ...oldRunner, happySessionId: 's', happySessionMetadataFromLocalWebhook: memberHomeMetadata as Record<string, unknown> };
  const tracked = options.oldCarrier === 'none' ? [converted] : options.oldCarrier === 'before' ? [old, converted] : [converted, old];
  const conversion: PerSessionProvedSharedConversion = {
    subjectId: identity.id, serviceId: 'claude-subscription', groupId: 'pool', retiresDecisionsDecidedAtOrBeforeMs: 10, convertedRunner,
  };
  const operations: string[] = [];
  const runtime = new PerSessionAssignmentRuntime({
    ledger, ownerMachineId: 'm', nowMs: () => 100,
    listLiveDecisions: () => collectPerSessionLiveDecisions(tracked),
    listLiveSubjectIds: () => collectPerSessionLiveSubjectIds(tracked),
    probeRunnerPresence: async () => 'present',
    ...(options.readback ? { listProvedSharedConversions: () => [conversion] } : {}),
    reservationApi: {
      deleteAssignmentReservation: async (p) => { operations.push(`DELETE ${p.decisionId}`); return { kind: 'ok', reservationRevision: 2, deleted: true }; },
      putAssignmentReservation: async (p) => {
        operations.push(`PUT ${p.decisionId} ${p.body.state}`);
        return { kind: 'reserved', outcome: 'updated', reservationRevision: 3, reservation: { decisionId: p.decisionId, ...p.body, createdAtMs: 1 } };
      },
      listAssignmentReservations: async () => ({ kind: 'ok', reservationRevision: 3, reservations: [] }),
    },
  });
  const refreshConvertedMetadata = () => {
    converted.happySessionMetadataFromLocalWebhook = {
      connectedServiceMaterializationIdentityV1: identity,
      connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': {
        source: 'connected', selection: 'group', groupId: 'pool', appliedProfileId: 'beta',
      } } },
    };
  };
  return { runtime, ledger, operations, conversion, refreshConvertedMetadata };
}

describe('conversion settlement and the renewal tick', () => {
  it.each([false, true])('never rebuilds or renews the converted runner\'s retired lagging decision (conversion readback %s)', async (readback) => {
    const s = await scenario({ readback, oldCarrier: 'none' });
    await s.runtime.settleProvedSharedConversion(s.conversion);
    expect(s.ledger.get('d1') ?? null).toBeNull();
    await s.runtime.tick();
    await s.runtime.tick();
    s.refreshConvertedMetadata();
    await s.runtime.tick();
    expect(s.operations).toEqual(['DELETE d1']);
    expect(s.ledger.get('d1') ?? null).toBeNull();
  });

  it.each(['before', 'after'] as const)('keeps custody while an independent old member-home runner still carries it (listed %s)', async (oldCarrier) => {
    const s = await scenario({ readback: true, oldCarrier });
    await s.runtime.settleProvedSharedConversion(s.conversion);
    await s.runtime.tick();
    expect(s.ledger.get('d1')).toMatchObject({ decisionId: 'd1', state: 'applied' });
    expect(s.operations).not.toContain('DELETE d1');
    expect(s.operations).toContain('PUT d1 applied');
  });

  it('rebuilds a lost entry with the binding\'s own record time, not the tick time', async () => {
    const s = await scenario({ readback: false, oldCarrier: 'before' });
    await s.ledger.remove('d1');
    await s.runtime.tick();
    expect(s.ledger.get('d1')?.proposal.decidedAtMs).toBe(2);
  });
});
