// R19-WRAPPER-PRODUCER-01: the lineage is bound from the actual session webhook, with the reporter's
// process discovery (marker work) still pending, both when the tracked fingerprint is still missing
// and when it is still the wrapper's. Then the wrapper exits, the reporter is reparented, the ledger is
// reloaded, and the reporter's own identity adopts its launched decision. Real processes, real /proc.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readLinuxProcProcessInstanceFingerprintSync, readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import type { TrackedSession } from '@/daemon/types';
import { spawnInlineNodeParentWithChild, waitForProcessExit } from '@/testkit/process/spawn';

import { createOnHappySessionWebhook } from '../../../sessions/onHappySessionWebhook';
import { bindWrapperReporterLineage } from './bindWrapperReporterLineage';
import { PerSessionAssignmentLedger } from './PerSessionAssignmentLedger';
import { PerSessionAssignmentRuntime } from './PerSessionAssignmentRuntime';
import { readLiveParentProcessSync } from './readLiveParentProcessSync';

function metadataFor(pid: number): Metadata {
  return {
    path: '/tmp', host: 'test-host', homeDir: '/tmp/home', happyHomeDir: configuration.happyHomeDir,
    happyLibDir: '/tmp/lib', happyToolsDir: '/tmp/tools', hostPid: pid, startedBy: 'daemon', machineId: 'machine-test',
  };
}

function runtimeOn(ledger: PerSessionAssignmentLedger) {
  return new PerSessionAssignmentRuntime({
    ledger, ownerMachineId: 'm1', nowMs: () => 100, reservationApi: {} as never,
    listLiveDecisions: () => [], listLiveSubjectIds: () => new Set(), probeRunnerPresence: async () => 'present',
  });
}

describe.runIf(process.platform === 'linux')('wrapper reporter lineage from the session webhook (R19-WRAPPER-PRODUCER-01)', () => {
  it.each([
    ['the tracked fingerprint is still missing', 'missing'],
    ['the tracked fingerprint is still the wrapper\'s', 'wrapper'],
  ] as const)('binds the reporter\'s own instance when %s, and it adopts after the wrapper exits', async (_label, trackedFingerprint) => {
    const { parent: wrapper, childPid } = await spawnInlineNodeParentWithChild();
    const wrapperPid = wrapper.pid!;
    try {
      const wrapperInstance = readProcessInstanceFingerprintSync(wrapperPid)!;
      const childInstance = readProcessInstanceFingerprintSync(childPid)!;
      const path = join(await mkdtemp(join(tmpdir(), 'per-session-webhook-')), 'per-session-assignments.json');
      const ledger = new PerSessionAssignmentLedger(path);
      await ledger.recordProposal({ decisionId: 'd', sessionId: 's', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', nowMs: 1, proposal: {
        decisionId: 'd', proposalRevision: 1, profileId: 'alpha', reason: 'initial_sampled', fromProfileId: null,
        temperature: 1.5, offsetPercent: 10, probability: 0.5, decidedAtMs: 1, custody: 'reserved', observedReservationRevision: 1,
      } });
      await ledger.recordSpawnCustody({ spawnDecisionIds: ['d'], launchedDecisionIds: ['d'], runner: { pid: wrapperPid, processInstanceFingerprint: wrapperInstance }, nowMs: 2 });
      const runtime = runtimeOn(ledger);

      const tracked: TrackedSession = {
        pid: wrapperPid, startedBy: 'daemon',
        ...(trackedFingerprint === 'wrapper' ? { processInstanceFingerprint: wrapperInstance } : {}),
      };
      const sessions = new Map([[wrapperPid, tracked]]);
      const awaiters = new Map<number, (session: TrackedSession) => void>([[wrapperPid, () => {}]]);
      let lineage: Promise<void> = Promise.resolve();
      const report = createOnHappySessionWebhook({
        pidToTrackedSession: sessions, pidToAwaiter: awaiters,
        // Process discovery (marker work) never completes during this test.
        findHappyProcessByPidFn: () => new Promise(() => {}), writeSessionMarkerFn: async () => {},
        getParentPidFn: (pid) => (pid === childPid ? wrapperPid : null),
        onTrackedSessionReported: (reported) => {
          // The daemon's own callback body (startDaemon onTrackedSessionReported).
          const reporterPid = reported.sessionRunnerPid;
          if (typeof reporterPid === 'number' && reporterPid !== reported.pid) {
            lineage = bindWrapperReporterLineage({
              reporterPid,
              readProcessInstance: (pid) => readLinuxProcProcessInstanceFingerprintSync(pid),
              readParentProcess: (pid) => readLiveParentProcessSync(pid),
              record: (input) => runtime.recordWrapperReporter(input),
            });
          }
        },
      });
      await report('session-1', metadataFor(childPid));
      await lineage;
      expect(tracked.sessionRunnerPid).toBe(childPid);
      expect(tracked.processInstanceFingerprint === childInstance).toBe(false);
      expect(ledger.get('d')?.launchedReporter).toEqual({ pid: childPid, processInstanceFingerprint: childInstance });

      wrapper.kill('SIGKILL');
      await waitForProcessExit(wrapperPid, { timeoutMs: 2_000 });
      for (let attempt = 0; attempt < 100 && readLiveParentProcessSync(childPid)?.pid === wrapperPid; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(readLiveParentProcessSync(childPid)?.pid).not.toBe(wrapperPid);
      const restarted = runtimeOn(new PerSessionAssignmentLedger(path));
      expect(restarted.isDecisionLaunchedInRunner('d', { pid: childPid, processInstanceFingerprint: childInstance })).toBe(true);
      expect(restarted.isDecisionLaunchedInRunner('d', { pid: childPid, processInstanceFingerprint: wrapperInstance })).toBe(false);
      expect(restarted.isDecisionLaunchedInRunner('d', { pid: process.pid, processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid)! })).toBe(false);
    } finally {
      try { process.kill(childPid, 'SIGKILL'); } catch { /* gone */ }
      try { wrapper.kill('SIGKILL'); } catch { /* gone */ }
      await waitForProcessExit(childPid, { timeoutMs: 2_000 });
    }
  }, 20_000);
});
