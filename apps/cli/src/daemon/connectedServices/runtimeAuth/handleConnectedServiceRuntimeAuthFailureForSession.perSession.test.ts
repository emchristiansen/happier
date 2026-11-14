import { describe, expect, it, vi } from 'vitest';

import type { TrackedSession } from '@/daemon/types';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '../connectedServiceChildEnvironment';
import { handleConnectedServiceRuntimeAuthFailureForSession } from './handleConnectedServiceRuntimeAuthFailureForSession';
import type { ConnectedServiceRuntimeFailureClassification } from './types';

/**
 * Spec A.4/A.5 (HPI-10, HPI-16): a per-session-owned session runs in its member's own home, so its
 * child selection is profile-kind, while recovery belongs to its logical group binding.
 */
const memberBinding = (overrides: Record<string, unknown> = {}) => ({
  v: 1,
  bindingsByServiceId: {
    'claude-subscription': {
      source: 'connected', selection: 'group', groupId: 'pool',
      member: { assignment: 'per_session', profileId: 'b', decisionId: 'spawn-1', reason: 'initial_sampled', appliedAtMs: 1 },
      ...overrides,
    },
  },
});

function trackedOnMemberHome(connectedServices: unknown): TrackedSession {
  return {
    startedBy: 'daemon',
    happySessionId: 'sess-owned',
    pid: 4242,
    spawnOptions: {
      directory: '/tmp/project',
      connectedServices: connectedServices as never,
      environmentVariables: {
        [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([
          { kind: 'profile', serviceId: 'claude-subscription', profileId: 'b', credentialRevision: null },
        ]),
      },
    },
  } as TrackedSession;
}

function classification(overrides: Partial<ConnectedServiceRuntimeFailureClassification> = {}): ConnectedServiceRuntimeFailureClassification {
  return {
    kind: 'usage_limit', serviceId: 'claude-subscription', profileId: 'b', groupId: null,
    resetsAtMs: null, retryAfterMs: null, planType: null, rateLimits: null, source: 'structured_provider_error',
    ...overrides,
  };
}

async function intake(tracked: TrackedSession, report: ConnectedServiceRuntimeFailureClassification) {
  const switchAfterClassifiedFailure = vi.fn(async () => ({
    status: 'switched' as const, activeProfileId: 'c', generation: 3, mode: 'restart_resume' as const,
  }));
  const result = await handleConnectedServiceRuntimeAuthFailureForSession({
    getChildren: () => [tracked],
    sessionId: tracked.happySessionId!,
    switchesThisTurn: 0,
    classification: report,
    switchCoordinator: { switchAfterClassifiedFailure } as never,
    restartSession: vi.fn(async () => {}),
    continueAfterRuntimeAuthSwitch: vi.fn(async () => {}),
    emitSessionEvent: vi.fn(),
  } as never);
  return { result, switchAfterClassifiedFailure };
}

describe('per-session recovery intake', () => {
  it('routes an attributed member-home usage limit to the group, not a direct-profile action (HPI-16)', async () => {
    const { result, switchAfterClassifiedFailure } = await intake(trackedOnMemberHome(memberBinding()), classification());
    expect(result).not.toMatchObject({ status: 'recovery_action_required' });
    expect(switchAfterClassifiedFailure).toHaveBeenCalledTimes(1);
    expect(switchAfterClassifiedFailure.mock.calls[0]![0]).toMatchObject({
      sessionId: 'sess-owned', serviceId: 'claude-subscription', groupId: 'pool', reason: 'usage_limit', observedProfileId: 'b',
    });
  });

  it('routes a failover-pending member-home session to the group as well', async () => {
    const tracked = trackedOnMemberHome(memberBinding({
      materializedAssignment: { profileId: 'c', decisionId: 'recovery-1', reason: 'failover', fromProfileId: 'b', materializedAtMs: 2 },
    }));
    const { switchAfterClassifiedFailure } = await intake(tracked, classification());
    expect(switchAfterClassifiedFailure).toHaveBeenCalledTimes(1);
  });

  it('moves a session off a revoked member through the group instead of requiring a reconnect (HPI-10)', async () => {
    const { result, switchAfterClassifiedFailure } = await intake(
      trackedOnMemberHome(memberBinding()),
      classification({ kind: 'account_disabled', groupId: 'pool', source: 'daemon_member_revocation', sourceKey: 'per_session_member_revoked:b' }),
    );
    expect(result).not.toMatchObject({ status: 'recovery_action_required' });
    expect(switchAfterClassifiedFailure).toHaveBeenCalledTimes(1);
    expect(switchAfterClassifiedFailure.mock.calls[0]![0]).toMatchObject({ groupId: 'pool', reason: 'account_disabled', observedProfileId: 'b' });
  });

  it('keeps a genuine direct-profile session on its direct-profile recovery', async () => {
    const tracked = trackedOnMemberHome({
      v: 1, bindingsByServiceId: { 'claude-subscription': { source: 'connected', selection: 'profile', profileId: 'b' } },
    });
    const usage = await intake(tracked, classification());
    expect(usage.switchAfterClassifiedFailure).not.toHaveBeenCalled();
    const disabled = await intake(tracked, classification({ kind: 'account_disabled' }));
    expect(disabled.switchAfterClassifiedFailure).not.toHaveBeenCalled();
    expect(disabled.result).toMatchObject({ status: 'recovery_action_required', action: { kind: 'reconnect_profile' } });
  });
});
