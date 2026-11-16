// R16-WRAPPER-02 with real processes: a wrapper W launches the session-runner child C. The daemon
// binds C to W's launch while W is C's live parent. W then exits and C is reparented; the surviving
// C's own member-home report must still adopt its decision, through the real ledger (reloaded), the
// real /proc parent reader, the provenance resolver and the metadata projection.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readProcessInstanceFingerprintSync } from '@happier-dev/cli-common/processInstance';
import { afterEach, describe, expect, it } from 'vitest';

import { projectProviderObservedAccountMetadata, resolveAdoptedPerSessionDecisionId } from '../../sessionAuthSwitch/providerObservedAccountMetadata';
import { resolveProviderObservationProvenance } from '../../sessionAuthSwitch/resolveProviderObservationProvenance';
import { PerSessionAssignmentLedger } from './PerSessionAssignmentLedger';
import { PerSessionAssignmentRuntime } from './PerSessionAssignmentRuntime';
import { readLiveParentProcessSync } from './readLiveParentProcessSync';

const metadata = { connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': {
  source: 'connected', selection: 'group', groupId: 'pool',
  materializedAssignment: { profileId: 'alpha', decisionId: 'd', reason: 'initial_sampled', materializedAtMs: 1 },
} } } };

function runtimeOn(ledger: PerSessionAssignmentLedger) {
  return new PerSessionAssignmentRuntime({
    ledger, ownerMachineId: 'm1', nowMs: () => 100,
    reservationApi: {} as never,
    listLiveDecisions: () => [], listLiveSubjectIds: () => new Set(), probeRunnerPresence: async () => 'present',
  });
}

async function waitUntil(condition: () => boolean, label: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out: ${label}`);
}

const spawned: ChildProcess[] = [];
const extraPids: number[] = [];
afterEach(() => {
  for (const child of spawned.splice(0)) child.kill('SIGKILL');
  for (const pid of extraPids.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
});

describe.runIf(process.platform === 'linux')('wrapper reporter lineage with real processes (R16-WRAPPER-02)', () => {
  it('the original reporter adopts after its wrapper exits; a foreign process does not', async () => {
    const wrapper = spawn(process.execPath, ['-e', [
      "const { spawn } = require('node:child_process');",
      "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      'process.stdout.write(String(c.pid) + "\\n");',
      'setTimeout(() => {}, 60000);',
    ].join('\n')], { stdio: ['ignore', 'pipe', 'ignore'] });
    spawned.push(wrapper);
    const reporterPid = await new Promise<number>((resolve) => wrapper.stdout!.once('data', (chunk) => resolve(Number(String(chunk).trim()))));
    extraPids.push(reporterPid);
    const wrapperRunner = { pid: wrapper.pid!, processInstanceFingerprint: readProcessInstanceFingerprintSync(wrapper.pid!)! };
    const reporterRunner = { pid: reporterPid, processInstanceFingerprint: readProcessInstanceFingerprintSync(reporterPid)! };
    expect(wrapperRunner.processInstanceFingerprint).toMatch(/^linux-proc:/u);

    const path = join(await mkdtemp(join(tmpdir(), 'per-session-wrapper-')), 'per-session-assignments.json');
    const ledger = new PerSessionAssignmentLedger(path);
    await ledger.recordProposal({ decisionId: 'd', sessionId: 's', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', nowMs: 1, proposal: {
      decisionId: 'd', proposalRevision: 1, profileId: 'alpha', reason: 'initial_sampled', fromProfileId: null,
      temperature: 1.5, offsetPercent: 10, probability: 0.5, decidedAtMs: 1, custody: 'reserved', observedReservationRevision: 1,
    } });
    await ledger.recordSpawnCustody({ spawnDecisionIds: ['d'], launchedDecisionIds: ['d'], runner: wrapperRunner, nowMs: 2 });
    // The reporter's webhook, while the wrapper is its live parent.
    await runtimeOn(ledger).recordWrapperReporter({ reporter: reporterRunner, parent: readLiveParentProcessSync(reporterPid) });

    wrapper.kill('SIGKILL');
    await waitUntil(() => readLiveParentProcessSync(reporterPid)?.pid !== wrapperRunner.pid, 'reporter reparented');
    expect(readProcessInstanceFingerprintSync(reporterPid)).toBe(reporterRunner.processInstanceFingerprint);

    const restarted = runtimeOn(new PerSessionAssignmentLedger(path));
    const adoptedBy = (runnerPid: number, tracked: { pid: number; processInstanceFingerprint?: string }) => {
      const resolution = resolveProviderObservationProvenance({
        tracked, runnerPid, launchHome: 'member',
        isDecisionLaunchedInRunner: (decisionId, runner, options) => restarted.isDecisionLaunchedInRunner(decisionId, runner, options),
        readParentProcess: (pid) => readLiveParentProcessSync(pid),
      });
      if (resolution.kind !== 'evidence') return null;
      const projected = projectProviderObservedAccountMetadata(metadata, {
        serviceId: 'claude-subscription', groupId: 'pool', profileId: 'alpha', observedAtMs: 5, provenance: resolution.provenance,
      });
      return resolveAdoptedPerSessionDecisionId(metadata, projected, 'claude-subscription');
    };
    // The daemon reattached the reporter from its marker: it tracks the reporter itself.
    expect(adoptedBy(reporterPid, reporterRunner)).toBe('d');
    expect(adoptedBy(process.pid, { pid: process.pid, processInstanceFingerprint: readProcessInstanceFingerprintSync(process.pid)! })).toBeNull();
  }, 20_000);
});
