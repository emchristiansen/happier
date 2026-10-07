import { describe, expect, it } from 'vitest';

import type { TrackedSession } from '@/daemon/types';

import { shouldRefreshSessionRunnerResumeIdentity } from './resolveRestartEligibility';

function trackedRunner(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    pid: 4242,
    happySessionId: 'sess-1',
    startedBy: 'daemon',
    processCommand:
      'node /Users/alice/.happier/cli-dev/versions/0.2.10/package-dist/index.mjs codex --happy-starting-mode remote --started-by daemon',
    processCommandHash: 'command-hash',
    vendorResumeId: undefined,
    spawnOptions: {
      directory: '/workspace',
      backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
    },
    ...overrides,
  };
}

describe('shouldRefreshSessionRunnerResumeIdentity', () => {
  it('selects only otherwise-eligible runners whose resume identity is actually absent', () => {
    expect(shouldRefreshSessionRunnerResumeIdentity(trackedRunner())).toBe(true);
    expect(shouldRefreshSessionRunnerResumeIdentity(trackedRunner({
      vendorResumeId: 'vendor-thread-1',
    }))).toBe(false);
    expect(shouldRefreshSessionRunnerResumeIdentity(trackedRunner({
      startedBy: 'happy directly - likely by user from terminal',
    }))).toBe(false);
  });
});
