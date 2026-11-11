import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';
import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import { decideConnectedServiceRecovery } from './ConnectedServiceRecoveryPolicy';

const baseIssue = {
  serviceId: 'openai-codex',
  profileId: 'primary',
  groupId: 'pool',
  resetsAtMs: null,
  retryAfterMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error' as const,
};

describe('connected service recovery invariant guard', () => {
  it('keeps the deleted credential_unusable pool-switch classifier out of production recovery owners', async () => {
    const productionOwners = await Promise.all([
      readFile(new URL('./ConnectedServiceRecoveryPolicy.ts', import.meta.url), 'utf8'),
      readFile(new URL('../resolveConnectedServiceAuthForSpawn.ts', import.meta.url), 'utf8'),
      readFile(new URL('./handleConnectedServiceRuntimeAuthFailureForSession.ts', import.meta.url), 'utf8'),
    ]);

    for (const source of productionOwners) {
      expect(source).not.toContain('credential_unusable');
    }
  });

  it('routes credential failures to a healthy pool fallback while direct profiles still reconnect', () => {
    for (const kind of ['auth_expired', 'refresh_failed', 'permission_denied'] as const) {
      expect(decideConnectedServiceRecovery({
        actor: 'automatic',
        issue: { kind, ...baseIssue },
        selection: {
          kind: 'group',
          serviceId: 'openai-codex',
          groupId: 'pool',
          activeProfileId: 'primary',
        },
        credentialHealth: { liveEvidence: 'auth_failed' },
        credentialRefresh: { status: 'not_refreshable' },
        groupCandidate: {
          status: 'selected',
          profileId: 'backup',
          applyMode: 'restart_rematerialize',
        },
      })).toMatchObject({
        action: 'switch_account',
        serviceId: 'openai-codex',
        groupId: 'pool',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: kind,
      });

      expect(decideConnectedServiceRecovery({
        actor: 'automatic',
        issue: { kind, ...baseIssue, groupId: null },
        selection: {
          kind: 'profile',
          serviceId: 'openai-codex',
          profileId: 'primary',
        },
        credentialHealth: { liveEvidence: 'auth_failed' },
      })).toMatchObject({
        action: 'reconnect_required',
        profileId: 'primary',
        reason: kind,
      });
    }

  });

  it('keeps spawn needs-reauth out of the pool switch coordinator', async () => {
    const now = 1_000_000;
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-spawn-auth-guard-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-spawn-auth-server-'));
    const activeRecord = buildConnectedServiceCredentialRecord({
      now,
      serviceId: 'openai-codex',
      profileId: 'primary',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access-placeholder',
        refreshToken: 'refresh-placeholder',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: 'acct_primary',
        providerEmail: null,
      },
    });
    const switchBeforeTurn = vi.fn(async () => ({
      status: 'switched' as const,
      activeProfileId: 'backup',
      generation: 2,
    }));
    const api = {
      getAccountEncryptionMode: vi.fn(async () => 'plain' as const),
      getConnectedServiceCredentialPlain: vi.fn(async () => ({
        content: { t: 'plain' as const, v: activeRecord },
      })),
      getConnectedServiceAuthGroup: vi.fn(async () => ({
        v: 1,
        serviceId: 'openai-codex',
        groupId: 'pool',
        displayName: null,
        activeProfileId: 'primary',
        generation: 1,
        policy: {
          v: 1,
          strategy: 'priority',
          autoSwitch: true,
          switchOn: {
            usageLimit: true,
            authExpired: true,
            accountChanged: true,
            refreshFailure: true,
          },
        },
        state: { v: 1 },
        members: [
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'pool',
            profileId: 'primary',
            enabled: true,
            priority: 1,
            state: { v: 1 },
            createdAt: 1,
            updatedAt: 1,
          },
          {
            v: 1,
            serviceId: 'openai-codex',
            groupId: 'pool',
            profileId: 'backup',
            enabled: true,
            priority: 2,
            state: { v: 1 },
            createdAt: 2,
            updatedAt: 2,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      })),
      readConnectedServiceCredentialHealth: vi.fn(async () => ({
        kind: 'found' as const,
        status: 'needs_reauth' as const,
        health: null,
      })),
    } as unknown as ApiClient;
    const credentials: Credentials = {
      token: 'happy-token',
      encryption: { type: 'legacy', secret: randomBytes(32) },
    };

    await expect(resolveConnectedServiceAuthForSpawn({
      agentId: 'codex',
      connectedServicesBindingsRaw: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': {
            source: 'connected',
            selection: 'group',
            groupId: 'pool',
            profileId: 'primary',
          },
        },
      },
      materializationKey: 'session-credential-guard',
      activeServerDir,
      baseDir,
      credentials,
      api,
      nowMs: () => now,
      sessionId: 'session-credential-guard',
      authGroupSwitchCoordinator: { switchBeforeTurn },
    })).rejects.toMatchObject({
      name: 'ConnectedServiceSpawnCredentialRefreshError',
      kind: 'reconnect_required',
      serviceId: 'openai-codex',
      profileId: 'primary',
    });

    expect(switchBeforeTurn).not.toHaveBeenCalled();
  });
});
