import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import type { HappyProcessInfo } from '../doctor';
import type { TrackedSession } from '../types';

const discovery = vi.hoisted(() => ({ processes: [] as HappyProcessInfo[] }));

// Supply the OS inventory without scanning the host. Reattachment, runtime/home ownership,
// command hashing and the marker reader/writer all remain real.
vi.mock('../doctor', () => ({
  findAllHappyProcesses: async () => discovery.processes,
  findHappyProcessByPid: async (pid: number) => discovery.processes.find((processInfo) => processInfo.pid === pid) ?? null,
}));
vi.mock('@happier-dev/cli-common/processInstance', async (importOriginal) => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/processInstance')>(),
  readProcessInstanceFingerprintSync: (pid: number) => `fixture:${pid}`,
}));

describe('markerless recovery home ownership', () => {
  const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID']);
  let happyHomeDir: string;
  let runtimeRoot: string;

  beforeEach(async () => {
    happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-markerless-home-'));
    envScope.patch({
      HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED: '1',
      HAPPIER_ACTIVE_SERVER_ID: 'fixture-relay', HAPPIER_SERVER_URL: 'https://relay.example.test',
      HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID: undefined,
    });
    vi.resetModules();
    discovery.processes = [];
    runtimeRoot = (await import('@/projectPath')).projectPath();
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal !== 0) throw new Error('Only fixture liveness probes are allowed');
      return true;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    envScope.restore();
    await rm(happyHomeDir, { recursive: true, force: true });
  });

  function runner(pid: number, homeDir?: string, root = runtimeRoot): HappyProcessInfo {
    return {
      pid,
      command: `node ${root}/dist/index.mjs claude --happy-starting-mode remote --started-by daemon --existing-session session-${pid}`,
      type: 'daemon-spawned-session',
      cwd: happyHomeDir,
      ...(homeDir === undefined ? {} : { daemonOwnershipEnvironmentVariables: {
        HAPPIER_HOME_DIR: homeDir, HAPPIER_ACTIVE_SERVER_ID: 'fixture-relay', HAPPIER_SERVER_URL: 'https://relay.example.test',
      } }),
    };
  }

  async function recover() {
    const { reattachTrackedSessionsFromMarkers } = await import('./reattachFromMarkers');
    const { listSessionMarkers } = await import('../sessionRegistry');
    const tracked = new Map<number, TrackedSession>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession: tracked });
    return { tracked, result, markers: await listSessionMarkers() };
  }

  it('recovers the matching home without adopting or writing a marker for a same-install foreign home', async () => {
    discovery.processes = [runner(91001, `${happyHomeDir}/`), runner(91002, `${happyHomeDir}-foreign`)];

    const { tracked, result, markers } = await recover();

    expect([...tracked.keys()]).toEqual([91001]);
    expect(tracked.get(91001)).toMatchObject({ startedBy: 'daemon', reattachedFromDiskMarker: true });
    expect(result.recoveredLiveSessionIds).toEqual(['session-91001']);
    expect(markers.map((marker) => marker.pid)).toEqual([91001]);
    expect(markers[0]?.happyHomeDir).toBe(happyHomeDir);
  });

  it.each([undefined, '', '   '])('does not infer home ownership from a runtime path when the live home is %j', async (homeDir) => {
    discovery.processes = [runner(91003, homeDir)];

    const { tracked, result, markers } = await recover();

    expect(tracked.size).toBe(0);
    expect(result.recoveredLiveSessionIds).toBeUndefined();
    expect(markers).toEqual([]);
  });

  it('does not let an incomplete local marker override a foreign live home', async () => {
    const { writeSessionMarker } = await import('../sessionRegistry');
    await writeSessionMarker({ pid: 91004, happySessionId: 'session-91004', startedBy: 'daemon' });
    discovery.processes = [runner(91004, `${happyHomeDir}-foreign`)];

    const { tracked, markers } = await recover();

    expect(tracked.size).toBe(0);
    expect(markers).toHaveLength(1);
    expect(markers[0]?.processCommandHash).toBeUndefined();
    expect(markers[0]?.processInstanceFingerprint).toBeUndefined();
  });

  it('retains incomplete-marker takeover from a previous runtime when the live home matches', async () => {
    const { writeSessionMarker } = await import('../sessionRegistry');
    await writeSessionMarker({ pid: 91005, happySessionId: 'session-91005', startedBy: 'daemon' });
    discovery.processes = [runner(91005, happyHomeDir, '/previous-install')];

    const { tracked, markers } = await recover();

    expect([...tracked.keys()]).toEqual([91005]);
    expect(markers[0]?.processCommandHash).toMatch(/^[a-f0-9]{64}$/);
    expect(markers[0]?.processInstanceFingerprint).toBe('fixture:91005');
  });

  it('keeps the runtime-root requirement for an otherwise matching markerless home', async () => {
    discovery.processes = [runner(91006, happyHomeDir, '/other-install')];

    const { tracked, markers } = await recover();

    expect(tracked.size).toBe(0);
    expect(markers).toEqual([]);
  });

  it('preserves complete-marker adoption without an explicit live home', async () => {
    const processInfo = runner(91007);
    const { hashProcessCommand, writeSessionMarker } = await import('../sessionRegistry');
    await writeSessionMarker({
      pid: processInfo.pid,
      happySessionId: 'session-91007',
      startedBy: 'daemon',
      processCommandHash: hashProcessCommand(processInfo.command),
    });
    discovery.processes = [processInfo];

    const { tracked, result } = await recover();

    expect([...tracked.keys()]).toEqual([91007]);
    expect(result.recoveredLiveSessionIds).toEqual(['session-91007']);
  });
});
