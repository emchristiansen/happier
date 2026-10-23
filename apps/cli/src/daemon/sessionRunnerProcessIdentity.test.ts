import { describe, expect, it } from 'vitest';

import {
  classifySessionRunnerProcessPresence,
  storedProcessIdentityProvesPidReuse,
  storedProcessIdentityMatchesCurrentIdentity,
} from './sessionRunnerProcessIdentity';

const STORED_PROC_FINGERPRINT = 'linux-proc:4200';
// The same living pid, read through the `ps` fallback after a /proc read failed.
const CURRENT_PS_FINGERPRINT = 'linux-ps:Mon Oct 20 10:00:00 2026';

describe('session runner process identity', () => {
  it('uses the process-instance fingerprint, not command drift, as PID generation proof', () => {
    expect(storedProcessIdentityProvesPidReuse({
      storedProcessInstanceFingerprint: 'darwin-ps:Mon Aug 12 01:53:03 2026',
      currentIdentity: {
        kind: 'happy',
        processCommandHash: 'b'.repeat(64),
        processInstanceFingerprint: 'darwin-ps:Mon Aug 12 01:53:03 2026',
      },
    })).toBe(false);

    expect(storedProcessIdentityMatchesCurrentIdentity({
      storedProcessCommandHash: 'a'.repeat(64),
      storedProcessInstanceFingerprint: 'darwin-ps:Mon Aug 12 01:53:03 2026',
      currentIdentity: {
        kind: 'happy',
        processCommandHash: 'b'.repeat(64),
        processInstanceFingerprint: 'darwin-ps:Mon Aug 12 01:53:03 2026',
      },
    })).toBe(true);
  });

  it('proves PID reuse only when both stored and observed process instances differ', () => {
    expect(storedProcessIdentityProvesPidReuse({
      storedProcessInstanceFingerprint: 'linux-proc:100',
      currentIdentity: {
        kind: 'not_happy',
        processInstanceFingerprint: 'linux-proc:200',
      },
    })).toBe(true);

    expect(storedProcessIdentityProvesPidReuse({
      storedProcessInstanceFingerprint: undefined,
      currentIdentity: { kind: 'not_happy', processInstanceFingerprint: 'linux-proc:200' },
    })).toBe(false);
  });

  it('keeps legacy command hashes strict for positive identity matching', () => {
    expect(storedProcessIdentityMatchesCurrentIdentity({
      storedProcessCommandHash: 'a'.repeat(64),
      storedProcessInstanceFingerprint: undefined,
      currentIdentity: { kind: 'happy', processCommandHash: 'a'.repeat(64) },
    })).toBe(true);
    expect(storedProcessIdentityMatchesCurrentIdentity({
      storedProcessCommandHash: 'a'.repeat(64),
      storedProcessInstanceFingerprint: undefined,
      currentIdentity: { kind: 'happy', processCommandHash: 'b'.repeat(64) },
    })).toBe(false);
  });

  it('classifies a same-scheme fingerprint mismatch as absent', () => {
    for (const runState of ['servable', 'stopped'] as const) {
      expect(classifySessionRunnerProcessPresence({
        runState,
        storedProcessCommandHash: 'a'.repeat(64),
        storedProcessInstanceFingerprint: STORED_PROC_FINGERPRINT,
        currentIdentity: { kind: 'happy', processCommandHash: 'a'.repeat(64), processInstanceFingerprint: 'linux-proc:4300' },
      }), runState).toBe('absent');
    }
  });

  it('does not treat a cross-scheme fingerprint mismatch as PID reuse', () => {
    expect(storedProcessIdentityProvesPidReuse({
      storedProcessInstanceFingerprint: STORED_PROC_FINGERPRINT,
      currentIdentity: { kind: 'happy', processCommandHash: 'a'.repeat(64), processInstanceFingerprint: CURRENT_PS_FINGERPRINT },
    })).toBe(false);
  });

  it('fences a stopped runner whose fingerprint was read under a different scheme', () => {
    expect(classifySessionRunnerProcessPresence({
      runState: 'stopped',
      storedProcessCommandHash: 'a'.repeat(64),
      storedProcessInstanceFingerprint: STORED_PROC_FINGERPRINT,
      currentIdentity: { kind: 'happy', processCommandHash: 'a'.repeat(64), processInstanceFingerprint: CURRENT_PS_FINGERPRINT },
    })).toBe('unknown');
  });

  it('keeps a running runner whose fingerprint was read under a different scheme present', () => {
    expect(classifySessionRunnerProcessPresence({
      runState: 'servable',
      storedProcessCommandHash: 'a'.repeat(64),
      storedProcessInstanceFingerprint: STORED_PROC_FINGERPRINT,
      currentIdentity: { kind: 'happy', processCommandHash: 'a'.repeat(64), processInstanceFingerprint: CURRENT_PS_FINGERPRINT },
    })).toBe('present');
  });
});
