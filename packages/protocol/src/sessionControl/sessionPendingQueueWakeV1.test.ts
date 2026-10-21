import { describe, expect, it } from 'vitest';

import {
  SessionPendingQueueLegacyMaterializeDeferredResponseV0Schema,
  SessionPendingQueueWakeCapabilityResponseV1Schema,
  SessionPendingQueueWakeRequestV1Schema,
  SessionPendingQueueWakeResponseV1Schema,
} from './sessionPendingQueueWakeV1.js';

describe('session pending queue wake wire contracts', () => {
  it('accepts only the frozen legacy deferred envelope', () => {
    const envelope = {
      ok: true,
      didMaterialize: false,
      result: { type: 'deferred', reason: 'runtime_upgrade_required' },
    };
    expect(SessionPendingQueueLegacyMaterializeDeferredResponseV0Schema.parse(envelope)).toEqual(envelope);
    expect(() => SessionPendingQueueLegacyMaterializeDeferredResponseV0Schema.parse({
      ...envelope,
      result: { type: 'wake_published' },
    })).toThrow();
  });

  it('keeps discovery and wake strict and unable to carry materializer inputs or results', () => {
    expect(SessionPendingQueueWakeCapabilityResponseV1Schema.parse({
      ok: true,
      capability: 'pending_queue_wake_v1',
      protocolVersion: 1,
      method: 'session.pendingQueue.wake.v1',
    })).toMatchObject({ ok: true, protocolVersion: 1 });
    expect(SessionPendingQueueWakeRequestV1Schema.parse({ protocolVersion: 1 })).toEqual({ protocolVersion: 1 });
    expect(SessionPendingQueueWakeRequestV1Schema.safeParse({
      protocolVersion: 1,
      selector: { kind: 'exact_target', localId: 'pending-local-1' },
      deliveryCommand: 'interrupt_and_send',
    }).success).toBe(false);
    expect(SessionPendingQueueWakeResponseV1Schema.parse({ ok: true, result: 'wake_published' })).toEqual({
      ok: true,
      result: 'wake_published',
    });
    expect(SessionPendingQueueWakeResponseV1Schema.safeParse({
      ok: true,
      result: 'wake_published',
      didMaterialize: false,
    }).success).toBe(false);
  });

  it('represents a terminating runner distinctly from an old runner', () => {
    const response = {
      ok: false as const,
      error: 'pending_materialization_wake_unavailable' as const,
      errorCode: 'runtime_terminating' as const,
    };
    expect(SessionPendingQueueWakeCapabilityResponseV1Schema.parse(response)).toEqual(response);
    expect(SessionPendingQueueWakeResponseV1Schema.parse(response)).toEqual(response);
  });

  it('represents a runner that lost its pending publisher status, with the reporting incarnation', () => {
    const response = {
      ok: false as const,
      error: 'pending_materialization_wake_unavailable' as const,
      errorCode: 'publisher_lost' as const,
      respondent: { machineId: 'machine-1', pid: 4242, processInstanceFingerprint: 'linux-proc:991' },
    };
    expect(SessionPendingQueueWakeCapabilityResponseV1Schema.parse(response)).toEqual(response);
    expect(SessionPendingQueueWakeResponseV1Schema.parse(response)).toEqual(response);
    // A runner that cannot identify itself still reports the loss; the daemon then cannot bind it.
    const { respondent: _respondent, ...unbound } = response;
    expect(SessionPendingQueueWakeCapabilityResponseV1Schema.parse(unbound)).toEqual(unbound);
  });

  it('rejects a partial or foreign-shaped reporting incarnation', () => {
    const base = {
      ok: false as const,
      error: 'pending_materialization_wake_unavailable' as const,
      errorCode: 'publisher_lost' as const,
    };
    for (const respondent of [
      { machineId: 'machine-1', pid: 4242 },
      { machineId: 'machine-1', processInstanceFingerprint: 'linux-proc:991' },
      { machineId: '', pid: 4242, processInstanceFingerprint: 'linux-proc:991' },
      { machineId: 'machine-1', pid: 0, processInstanceFingerprint: 'linux-proc:991' },
      { machineId: 'machine-1', pid: 4242, processInstanceFingerprint: 'linux-proc:991', home: '/x' },
    ]) {
      expect(SessionPendingQueueWakeCapabilityResponseV1Schema.safeParse({ ...base, respondent }).success).toBe(false);
    }
    // Only a terminal loss names its respondent.
    expect(SessionPendingQueueWakeCapabilityResponseV1Schema.safeParse({
      ...base,
      errorCode: 'runtime_terminating',
      respondent: { machineId: 'machine-1', pid: 4242, processInstanceFingerprint: 'linux-proc:991' },
    }).success).toBe(false);
  });

  it('represents a runner still recovering its publisher status distinctly from a lost one', () => {
    const response = {
      ok: false as const,
      error: 'pending_materialization_wake_unavailable' as const,
      errorCode: 'publisher_recovering' as const,
    };
    expect(SessionPendingQueueWakeCapabilityResponseV1Schema.parse(response)).toEqual(response);
    expect(SessionPendingQueueWakeResponseV1Schema.parse(response)).toEqual(response);
  });
});
