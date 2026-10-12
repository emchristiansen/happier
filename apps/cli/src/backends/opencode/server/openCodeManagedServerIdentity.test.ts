import { describe, expect, it } from 'vitest';

import type { SharedManagedOpenCodeServerState } from './sharedManagedServer';
import {
  describeOpenCodeManagedServerIdentityForLog,
  isSameOpenCodeManagedServerGeneration,
  resolveOpenCodeManagedServerIdentity,
} from './openCodeManagedServerIdentity';

function baseV2State(overrides: Partial<SharedManagedOpenCodeServerState> = {}): SharedManagedOpenCodeServerState {
  return {
    v: 2,
    baseUrl: 'http://127.0.0.1:50842',
    pid: 12143,
    startedAtMs: 1_700_000_000_000,
    status: 'ready',
    launchEnvFingerprint: 'fp-account-a',
    ownerToken: 'owner-token-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    startTimeMs: 1_700_000_000_500,
    expectedCmdlineHash: 'cmdhash',
    activeServerDir: '/active/server/dir',
    daemonInstanceId: 'daemon-1',
    ...overrides,
  };
}

describe('resolveOpenCodeManagedServerIdentity', () => {
  it('normalizes shared state into an identity with a stable, deterministic generation key', () => {
    const state = baseV2State({ logPath: '/logs/opencode-managed-servers/a.log', apiGeneration: 'v2' });
    const identity = resolveOpenCodeManagedServerIdentity(state);

    expect(identity.baseUrl).toBe(state.baseUrl);
    expect(identity.pid).toBe(state.pid);
    expect(identity.startedAtMs).toBe(state.startedAtMs);
    expect(identity.launchEnvFingerprint).toBe(state.launchEnvFingerprint);
    expect(identity.ownerToken).toBe(state.ownerToken);
    expect(identity.startTimeMs).toBe(state.startTimeMs);
    expect(identity.activeServerDir).toBe(state.activeServerDir);
    expect(identity.daemonInstanceId).toBe(state.daemonInstanceId);
    expect(identity.logPath).toBe('/logs/opencode-managed-servers/a.log');
    expect(identity.apiGeneration).toBe('v2');
    expect(identity.generationKey).toMatch(/^[0-9a-f]{64}$/);

    // Deterministic for the same state.
    expect(resolveOpenCodeManagedServerIdentity(state).generationKey).toBe(identity.generationKey);
  });

  it('changes the generation key when the owner token changes (each managed start)', () => {
    const a = resolveOpenCodeManagedServerIdentity(baseV2State({ ownerToken: 'owner-A' }));
    const b = resolveOpenCodeManagedServerIdentity(baseV2State({ ownerToken: 'owner-B' }));
    expect(a.generationKey).not.toBe(b.generationKey);
    expect(isSameOpenCodeManagedServerGeneration(a, b)).toBe(false);
    expect(isSameOpenCodeManagedServerGeneration(a, a)).toBe(true);
  });

  it('changes the generation key when process identity (pid/startTimeMs/startedAtMs/baseUrl) changes', () => {
    const reference = resolveOpenCodeManagedServerIdentity(baseV2State());
    expect(resolveOpenCodeManagedServerIdentity(baseV2State({ pid: 99999 })).generationKey).not.toBe(reference.generationKey);
    expect(resolveOpenCodeManagedServerIdentity(baseV2State({ startTimeMs: 1 })).generationKey).not.toBe(reference.generationKey);
    expect(resolveOpenCodeManagedServerIdentity(baseV2State({ startedAtMs: 1 })).generationKey).not.toBe(reference.generationKey);
    expect(resolveOpenCodeManagedServerIdentity(baseV2State({ baseUrl: 'http://127.0.0.1:1' })).generationKey).not.toBe(reference.generationKey);
  });

  it('produces a deterministic, non-empty key for legacy state without an owner token (fallback)', () => {
    const legacy: SharedManagedOpenCodeServerState = {
      baseUrl: 'http://127.0.0.1:56332',
      pid: 66869,
      startedAtMs: 1_700_000_111_000,
      status: 'ready',
    };
    const identity = resolveOpenCodeManagedServerIdentity(legacy);
    expect(identity.ownerToken).toBeUndefined();
    expect(identity.generationKey).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveOpenCodeManagedServerIdentity(legacy).generationKey).toBe(identity.generationKey);

    const differentPid = resolveOpenCodeManagedServerIdentity({ ...legacy, pid: 1 });
    expect(differentPid.generationKey).not.toBe(identity.generationKey);
  });

  it('redacts the owner token in the log summary while keeping the generation key', () => {
    const identity = resolveOpenCodeManagedServerIdentity(baseV2State({
      ownerToken: 'super-secret-owner-token-value',
      logPath: '/logs/opencode-managed-servers/a.log',
    }));
    const summary = describeOpenCodeManagedServerIdentityForLog(identity);
    const serialized = JSON.stringify(summary);

    expect(serialized).not.toContain('super-secret-owner-token-value');
    expect(summary.generationKey).toBe(identity.generationKey.slice(0, 12));
    expect(summary.baseUrl).toBe(identity.baseUrl);
    expect(summary.pid).toBe(identity.pid);
    expect(summary.hasOwnerToken).toBe(true);
    expect(summary.logPath).toBe('/logs/opencode-managed-servers/a.log');
  });

  it('handles a null/absent identity in the log summary', () => {
    expect(describeOpenCodeManagedServerIdentityForLog(null)).toEqual({ present: false });
  });
});
