import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { ConnectedServiceAuthGroupPolicyV1Schema } from '@happier-dev/protocol';

import { createConnectedServiceMemberHoldStore } from '../accountGroups/holds/connectedServiceMemberHolds';
import { PerSessionAssignmentLedger } from '../accountGroups/perSession/PerSessionAssignmentLedger';
import { PerSessionFailoverCoordinator } from '../accountGroups/perSession/PerSessionFailoverCoordinator';
import { switchSessionConnectedServiceAuth } from '../sessionAuthSwitch/switchSessionConnectedServiceAuth';
import {
  ConnectedServiceSessionAuthSwitchLockRegistry,
  createConnectedServiceSessionAuthSwitchCore,
} from './connectedServiceSessionAuthSwitchCore';
import { handleConnectedServiceRuntimeAuthFailureForSession } from './handleConnectedServiceRuntimeAuthFailureForSession';

/**
 * Real runtime-auth intake → per-session coordinator/decision/ledger → real switch FSM and lock
 * registry, with the daemon's per-session apply mapping (HPI-21, HPI-22). Process, provider and
 * continuity boundaries are synthetic: no child is launched; `restart` records where the FSM itself
 * restarts and `outer-restart` where the canonical recovery owner requests the deferred restart.
 */
const serviceId = 'claude-subscription' as const;
const NOW = 1_000_000;

async function recover(options: Readonly<{ trigger: 'automatic_runtime_failure' | 'manual'; holdDuringReservation?: boolean }>) {
  const dir = await mkdtemp(join(tmpdir(), 'per-session-recovery-application-'));
  const holds = createConnectedServiceMemberHoldStore({ filePath: join(dir, 'holds.json') });
  const ledger = new PerSessionAssignmentLedger(join(dir, 'ledger.json'));
  const group: any = {
    v: 1, serviceId, groupId: 'g', activeProfileId: 'a', generation: 1, runtimeStateRevision: 0, state: { v: 1 },
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ strategy: 'per_session_softmax', autoSwitch: true }),
    members: ['a', 'b'].map((profileId, index) => ({
      v: 1, serviceId, groupId: 'g', profileId, enabled: true, priority: index, state: { v: 1 }, createdAt: index, updatedAt: index,
    })),
    createdAt: 1, updatedAt: 1,
  };
  const member = { assignment: 'per_session', profileId: 'a', decisionId: 'applied-a', reason: 'initial_sampled', appliedAtMs: 1 } as const;
  const tracked: any = {
    pid: 123, happySessionId: 's', vendorResumeId: 'native-fixture', startedBy: 'daemon',
    spawnOptions: {
      existingSessionId: 's', resume: 'native-fixture', directory: dir, backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      connectedServices: { v: 1, bindingsByServiceId: { [serviceId]: { source: 'connected', selection: 'group', groupId: 'g', member } } },
    },
  };
  const effects: string[] = [];
  const api: any = {
    getConnectedServiceAuthGroup: async () => group,
    readConnectedServiceCredentialHealth: async () => ({ kind: 'found', status: 'connected', health: null }),
  };
  const core = createConnectedServiceSessionAuthSwitchCore({ locks: new ConnectedServiceSessionAuthSwitchLockRegistry() });
  const coordinator = new PerSessionFailoverCoordinator({
    loadGroup: async () => group,
    buildState: async () => ({
      ...group,
      lastSwitchAt: null,
      lastSwitchReason: null,
      members: group.members.map((entry: any) => ({ ...entry, createdAtMs: entry.createdAt })),
      memberStatesByProfileId: new Map(['a', 'b'].map((profileId) => [profileId, { quotaSnapshot: { capturedAtMs: NOW - 1, effectiveRemainingPercent: 60 } }])),
      memberHolds: await holds.readForService(serviceId),
    }),
    recordFailure: async () => {},
    switchSharedGroup: async () => { throw new Error('unexpected shared switch'); },
    readSessionBinding: () => ({ subjectId: 's', currentProfileId: 'a', member }),
    // The daemon's per-session apply argument mapping onto the real switch FSM.
    applyAssignment: async (assignment) => await switchSessionConnectedServiceAuth({
      core,
      getChildren: () => [tracked],
      api,
      switchReason: options.trigger,
      groupSwitchTriggerReason: 'usage_limit',
      executionPolicy: { allowRestartResume: true, allowContinuation: true, source: 'runtime' },
      postSwitchVerificationMode: { kind: 'disabled_for_test_only', reason: 'no vendor child in this fixture' },
      resolveContinuity: async () => ({ mode: 'restart_rematerialize' }),
      restartSession: async () => { effects.push('restart'); },
      persistSessionBindings: async () => { effects.push('persist'); },
      hotApply: async () => ({ ok: true }),
      registerHotApplyTargets: () => {},
      emitSessionEvent: () => {},
      request: { sessionId: 's', agentId: 'claude', bindings: { v: 1, bindingsByServiceId: { [serviceId]: assignment.binding } } },
    } as any),
    ledger,
    releaseUnappliedDecision: async (decisionId) => { await ledger.remove(decisionId); },
    ownerMachineId: 'm',
    nowMs: () => NOW,
    deadlineMs: 30_000,
    quotaFreshnessMs: 300_000,
    uniformSample: () => 0,
    reservationApi: {
      listAssignmentReservations: async () => ({ kind: 'ok', reservationRevision: 0, reservations: [] }),
      putAssignmentReservation: async (put: any) => {
        // A hold written while the reservation is acknowledged (after the decision's state read).
        if (options.holdDuringReservation) {
          await holds.set({ serviceId, profileId: put.body.profileId, reason: 'unavailable', source: 'fixture', heldAtMs: NOW, lifetime: { kind: 'until_released' } });
        }
        return { kind: 'reserved', reservationRevision: 1, reservation: { decisionId: put.decisionId, ...put.body, createdAtMs: NOW } };
      },
      deleteAssignmentReservation: async () => ({ kind: 'ok', reservationRevision: 2, deleted: true }),
    } as any,
  });
  const result = await handleConnectedServiceRuntimeAuthFailureForSession({
    getChildren: () => [tracked],
    sessionId: 's',
    switchesThisTurn: 0,
    switchCoordinator: coordinator,
    restartSession: async () => { effects.push('outer-restart'); },
    classification: {
      kind: 'usage_limit', serviceId, profileId: 'a', groupId: 'g', resetsAtMs: null, planType: null, rateLimits: null, source: 'provider_runtime_marker',
    },
  } as any);
  return { result, effects, ledger };
}

describe('per-session recovery application through the real intake and switch FSM', () => {
  it('requests the deferred restart through the recovery owner after an automatic switch persists the target (HPI-21)', async () => {
    const { result, effects, ledger } = await recover({ trigger: 'automatic_runtime_failure' });
    expect(result).toMatchObject({ status: 'switch_attempted', result: { status: 'switched', activeProfileId: 'b', mode: 'spawn_next_turn' } });
    expect(effects).toEqual(['persist', 'outer-restart']);
    expect(ledger.list().map((entry) => entry.proposal.profileId)).toEqual(['b']);
  });

  it('control: a manual-trigger switch restarts inside the FSM', async () => {
    const { result, effects } = await recover({ trigger: 'manual' });
    expect(result).toMatchObject({ result: { status: 'switched', mode: 'restart_resume' } });
    expect(effects).toEqual(['persist', 'restart']);
  });

  it('refuses a target held after the draw before any persistence and releases its decision (HPI-22)', async () => {
    const { result, effects, ledger } = await recover({ trigger: 'automatic_runtime_failure', holdDuringReservation: true });
    expect(effects).toEqual([]);
    expect(result).not.toMatchObject({ result: { status: 'switched' } });
    expect(ledger.list()).toHaveLength(0);
  });
});
