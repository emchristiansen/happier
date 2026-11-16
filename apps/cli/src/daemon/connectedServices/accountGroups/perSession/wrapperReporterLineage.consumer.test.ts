// R20-LINEAGE-CONSUMER-01: reviewer probes (t_9323428b reviewerLineage.test.ts), adopted unchanged as maintained tests.
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readLinuxProcProcessInstanceFingerprintSync as fingerprint } from '@happier-dev/cli-common/processInstance';
import { bindWrapperReporterLineage } from './bindWrapperReporterLineage';
import { PerSessionAssignmentLedger } from './PerSessionAssignmentLedger';
import { PerSessionAssignmentRuntime } from './PerSessionAssignmentRuntime';
import { readLiveParentProcessSync } from './readLiveParentProcessSync';
import { createOnHappySessionWebhook } from '../../../sessions/onHappySessionWebhook';
import { resolveProviderObservationProvenance } from '../../sessionAuthSwitch/resolveProviderObservationProvenance';
import { projectProviderObservedAccountMetadata, resolveAdoptedPerSessionDecisionId } from '../../sessionAuthSwitch/providerObservedAccountMetadata';
import type { TrackedSession } from '@/daemon/types';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';

async function fixture(launcher = { pid: 42, processInstanceFingerprint: 'linux-proc:500' }) {
  const path = join(await mkdtemp(join(tmpdir(), 'review-lineage-')), 'ledger.json');
  const ledger = new PerSessionAssignmentLedger(path);
  await ledger.recordProposal({ decisionId: 'd', sessionId: 's', serviceId: 'claude-subscription', groupId: 'pool', origin: 'spawn', nowMs: 1, proposal: {
    decisionId: 'd', proposalRevision: 1, profileId: 'alpha', reason: 'initial_sampled', fromProfileId: null,
    temperature: 1.5, offsetPercent: 10, probability: 0.5, decidedAtMs: 1, custody: 'reserved', observedReservationRevision: 1,
  } });
  await ledger.recordSpawnCustody({ spawnDecisionIds: ['d'], launchedDecisionIds: ['d'], runner: launcher, nowMs: 2 });
  const runtime = new PerSessionAssignmentRuntime({ ledger, ownerMachineId: 'm1', nowMs: () => 100, reservationApi: {} as never,
    listLiveDecisions: () => [], listLiveSubjectIds: () => new Set(), probeRunnerPresence: async () => 'present' });
  return { ledger, runtime, path };
}

describe('independent producer and consumer lineage probes', () => {
  it('changed reporter incarnation cannot enter the real durable ledger', async () => {
    const { ledger, runtime, path } = await fixture();
    const reads = ['linux-proc:900', 'linux-proc:901'];
    await bindWrapperReporterLineage({ reporterPid: 77, readProcessInstance: () => reads.shift()!,
      readParentProcess: () => ({ pid: 42, processInstanceFingerprint: 'linux-proc:500' }), record: (x) => runtime.recordWrapperReporter(x) });
    expect(ledger.get('d')?.launchedReporter).toBeUndefined();
    expect(new PerSessionAssignmentLedger(path).get('d')?.launchedReporter).toBeUndefined();
  });
  it.each([
    { pid: 43, processInstanceFingerprint: 'linux-proc:500' },
    { pid: 42, processInstanceFingerprint: 'linux-proc:501' },
  ])('foreign/reused parent is refused by ledger: %j', async (parent) => {
    const { ledger, runtime } = await fixture();
    await bindWrapperReporterLineage({ reporterPid: 77, readProcessInstance: () => 'linux-proc:900', readParentProcess: () => parent,
      record: (x) => runtime.recordWrapperReporter(x) });
    expect(ledger.get('d')?.launchedReporter).toBeUndefined();
    expect(runtime.isDecisionLaunchedInRunner('d', { pid: 77, processInstanceFingerprint: 'linux-proc:900' }, { requireFingerprint: true })).toBe(false);
  });
  it('later launch invalidates reporter in durable storage', async () => {
    const { ledger, runtime, path } = await fixture();
    await bindWrapperReporterLineage({ reporterPid: 77, readProcessInstance: () => 'linux-proc:900',
      readParentProcess: () => ({ pid: 42, processInstanceFingerprint: 'linux-proc:500' }), record: (x) => runtime.recordWrapperReporter(x) });
    expect(runtime.isDecisionLaunchedInRunner('d', { pid: 77, processInstanceFingerprint: 'linux-proc:900' })).toBe(true);
    await ledger.recordLaunchedRunner(['d'], { pid: 88, processInstanceFingerprint: 'linux-proc:1000' }, 200);
    expect(new PerSessionAssignmentLedger(path).get('d')?.launchedReporter).toBeUndefined();
    expect(runtime.isDecisionLaunchedInRunner('d', { pid: 77, processInstanceFingerprint: 'linux-proc:900' })).toBe(false);
  });
  it.runIf(process.platform === 'linux')('stale tracked reporter PID cannot let a foreign-parent process adopt via the wrapper shortcut', async () => {
    const wrapper = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 40)); // distinguish start ticks as well as PIDs
    const foreign = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    try {
      const wrapperRunner = { pid: wrapper.pid!, processInstanceFingerprint: fingerprint(wrapper.pid!)! };
      const { ledger, runtime } = await fixture(wrapperRunner);
      // Emulate the exact stale tracking state left when an earlier wrapper child died and its PID
      // was recycled for this real foreign child. No kernel PID recycling is forced.
      const tracked: TrackedSession = { pid: wrapper.pid!, sessionRunnerPid: foreign.pid!, processInstanceFingerprint: 'linux-proc:0', startedBy: 'daemon' };
      let lineage = Promise.resolve();
      const report = createOnHappySessionWebhook({ pidToTrackedSession: new Map([[wrapper.pid!, tracked]]), pidToAwaiter: new Map(),
        findHappyProcessByPidFn: () => new Promise(() => {}), writeSessionMarkerFn: async () => {},
        onTrackedSessionReported: (t) => { lineage = bindWrapperReporterLineage({ reporterPid: t.sessionRunnerPid!, readProcessInstance: fingerprint,
          readParentProcess: readLiveParentProcessSync, record: (x) => runtime.recordWrapperReporter(x) }); } });
      await report('session-1', { path: '/tmp', host: 'test', homeDir: '/tmp', happyHomeDir: configuration.happyHomeDir,
        happyLibDir: '/tmp', happyToolsDir: '/tmp', hostPid: foreign.pid!, startedBy: 'daemon', machineId: 'm1' } as Metadata);
      await lineage;
      expect(readLiveParentProcessSync(foreign.pid!)?.pid).not.toBe(wrapper.pid);
      expect(ledger.get('d')?.launchedReporter).toBeUndefined();
      const resolution = resolveProviderObservationProvenance({ tracked, runnerPid: foreign.pid!, launchHome: 'member',
        isDecisionLaunchedInRunner: (d, r, o) => runtime.isDecisionLaunchedInRunner(d, r, o), readParentProcess: readLiveParentProcessSync });
      const metadata = { connectedServices: { v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'group', groupId: 'pool',
        materializedAssignment: { profileId: 'alpha', decisionId: 'd', reason: 'initial_sampled', materializedAtMs: 1 } } } } };
      const projected = projectProviderObservedAccountMetadata(metadata, { serviceId: 'claude-subscription', groupId: 'pool', profileId: 'alpha', observedAtMs: 5,
        provenance: resolution.kind === 'evidence' ? resolution.provenance : null });
      const adopted = resolveAdoptedPerSessionDecisionId(metadata, projected, 'claude-subscription');
      const exactForeign = resolveProviderObservationProvenance({ tracked: { pid: foreign.pid!, processInstanceFingerprint: fingerprint(foreign.pid!)! }, runnerPid: foreign.pid!, launchHome: 'member',
        isDecisionLaunchedInRunner: (d, r, o) => runtime.isDecisionLaunchedInRunner(d, r, o), readParentProcess: readLiveParentProcessSync });
      expect(exactForeign.kind === 'evidence' && exactForeign.provenance?.isDecisionLaunchedInRunner('d')).toBe(false);
      // Even completion of marker discovery cannot repair this consumer shortcut: with split PIDs,
      // readTrackedLauncherIdentity omits the reporter fingerprint regardless of its correctness.
      tracked.processInstanceFingerprint = fingerprint(foreign.pid!)!;
      const freshFingerprint = resolveProviderObservationProvenance({ tracked, runnerPid: foreign.pid!, launchHome: 'member',
        isDecisionLaunchedInRunner: (d, r, o) => runtime.isDecisionLaunchedInRunner(d, r, o), readParentProcess: readLiveParentProcessSync });
      const stillProvesDecision = freshFingerprint.kind === 'evidence' && freshFingerprint.provenance?.isDecisionLaunchedInRunner('d');
      console.log(JSON.stringify({ wrapperRunner, foreignPid: foreign.pid, foreignInstance: fingerprint(foreign.pid!), foreignParent: readLiveParentProcessSync(foreign.pid!), tracked, boundReporter: ledger.get('d')?.launchedReporter ?? null, adopted, stillProvesDecision }));
      expect(adopted).toBeNull();
    } finally { wrapper.kill('SIGKILL'); foreign.kill('SIGKILL'); }
  });
});
