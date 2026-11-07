import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { ConnectedServiceIdSchema } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';

describe('commitConnectedServiceAccountSwitchSessionEvent', () => {
  let envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);

  afterEach(() => {
    envScope.restore();
    envScope = createEnvKeyScope(['HAPPIER_SERVER_URL']);
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('commits manual profile switches without requiring a group id', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-1',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-1', seq: 2, localId: 'local-1', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-1',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'anthropic',
        groupId: null,
        fromProfileId: 'old-profile',
        toProfileId: 'new-profile',
        reason: 'manual',
      },
    });

    const sessionUrl = new URL(String(getSpy.mock.calls[0]?.[0]));
    expect(sessionUrl.pathname).toBe('/v2/sessions/sess-1');
    expect(JSON.parse(sessionUrl.searchParams.get('happierConnectedServices') ?? 'null')).toEqual(ConnectedServiceIdSchema.options);
    expect(getSpy).toHaveBeenCalledWith(
      sessionUrl.href,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      }),
    );
    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-1\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch:anthropic:direct:/),
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                groupId: null,
                fromProfileId: 'old-profile',
                toProfileId: 'new-profile',
                reason: 'manual',
              }),
            }),
          }),
        }),
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
        }),
      }),
    );
  });

  it('skips same-profile connected-service account switch transcript events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-labels',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-labels', seq: 2, localId: 'local-labels', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-labels',
      listConnectedServiceProfiles: async () => ({
        serviceId: 'claude-subscription',
        profiles: [
          {
            profileId: 'batiplus',
            displayName: 'leeroy',
            status: 'connected',
            providerEmail: 'leeroy@example.test',
          },
        ],
      }),
      getConnectedServiceAuthGroup: async () => ({
        v: 1,
        serviceId: 'claude-subscription',
        groupId: 'claude',
        displayName: 'Claude pool',
        policy: { v: 1 },
        activeProfileId: 'batiplus',
        generation: 1,
        state: { v: 1, failureCount: 0 },
        createdAt: 1,
        updatedAt: 1,
        members: [],
      }),
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'claude-subscription',
        groupId: 'claude',
        fromProfileId: 'batiplus',
        toProfileId: 'batiplus',
        reason: 'manual',
      },
    });

    expect(getSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('does not persist provider account ids as public profile labels on transcript events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-private-provider-account',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-private-provider-account', seq: 2, localId: 'local-private-provider-account', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-private-provider-account',
      listConnectedServiceProfiles: async () => ({
        serviceId: 'openai-codex',
        profiles: [
          {
            profileId: 'primary',
            status: 'connected',
            providerEmail: null,
            providerAccountId: 'acct-provider-primary-secret',
          },
          {
            profileId: 'backup',
            status: 'connected',
            providerEmail: null,
            providerAccountId: 'acct-provider-backup-secret',
          },
        ],
      }),
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'usage_limit',
        generation: 9,
      },
    });

    const [, postedBody] = postSpy.mock.calls[0]!;
    expect(JSON.stringify(postedBody)).not.toContain('acct-provider-primary-secret');
    expect(JSON.stringify(postedBody)).not.toContain('acct-provider-backup-secret');
    expect(postedBody).toEqual(expect.objectContaining({
      content: expect.objectContaining({
        t: 'plain',
        v: expect.objectContaining({
          content: expect.objectContaining({
            data: expect.objectContaining({
              fromProfileId: 'primary',
              toProfileId: 'backup',
              fromProfileLabel: 'primary',
              toProfileLabel: 'backup',
            }),
          }),
        }),
      }),
    }));
  });

  it('commits connected-service account switch attempt diagnostics', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-attempt', seq: 2, localId: 'local-attempt', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-attempt',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: false,
        action: 'hot_applied',
        reason: 'manual',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'failed',
        outcomeAction: 'none',
        errorCode: 'post_switch_verification_failed',
        diagnostic: {
          code: 'post_switch_verification_failed',
          failurePhase: 'post_switch_verification',
          source: 'manual_auth_switch',
          serviceId: 'openai-codex',
          retryable: false,
          suggestedActions: ['reconnect_profile'],
        },
        groupGeneration: 7,
        sessionAdoption: 'failed',
        partialState: 'runtime_auth_partially_applied',
        verificationByServiceId: {
          'openai-codex': {
            status: 'weakly_verified',
            reason: 'provider_account_email_verified_without_account_id',
            providerAccountId: 'must-not-persist',
          },
        },
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-attempt\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch-attempt:/),
        attentionImpact: {
          affectsUnread: false,
          affectsMeaningfulActivity: false,
        },
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'connected-service-account-switch-attempt',
                ok: false,
                action: 'hot_applied',
                reason: 'manual',
                attemptedContinuityMode: 'hot_apply',
                outcome: 'failed',
                outcomeAction: 'none',
                errorCode: 'post_switch_verification_failed',
                diagnostic: {
                  code: 'post_switch_verification_failed',
                  failurePhase: 'post_switch_verification',
                  source: 'manual_auth_switch',
                  serviceId: 'openai-codex',
                  retryable: false,
                  suggestedActions: ['reconnect_profile'],
                },
                groupGeneration: 7,
                sessionAdoption: 'failed',
                partialState: 'runtime_auth_partially_applied',
                verificationByServiceId: {
                  'openai-codex': {
                    status: 'weakly_verified',
                    reason: 'provider_account_email_verified_without_account_id',
                  },
                },
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('preserves exact accepted verification proof in switch attempt events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-attempt', seq: 2, localId: 'local-attempt', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-attempt',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: true,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'succeeded',
        outcomeAction: 'hot_applied',
        errorCode: null,
        partialState: null,
        verificationByServiceId: {
          'openai-codex': {
            status: 'verified',
            providerAccountId: 'acct_bot',
            proofStrength: 'exact',
            source: 'applied_credential',
          },
        },
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-attempt\/messages$/),
      expect.objectContaining({
        attentionImpact: {
          affectsUnread: false,
          affectsMeaningfulActivity: false,
        },
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'connected-service-account-switch-attempt',
                ok: true,
                action: 'hot_applied',
                verificationByServiceId: {
                  'openai-codex': {
                    status: 'verified',
                    providerAccountId: 'acct_bot',
                    proofStrength: 'exact',
                    source: 'applied_credential',
                  },
                },
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('surfaces preemptive soft-threshold switch attempt transcript events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt-background',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-attempt', seq: 2, localId: 'local-attempt', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-attempt-background',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: true,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'succeeded',
        outcomeAction: 'hot_applied',
        errorCode: null,
        partialState: null,
        reason: 'soft_threshold',
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-attempt-background\/messages$/),
      expect.objectContaining({
        content: expect.objectContaining({
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({ type: 'connected-service-account-switch-attempt' }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('suppresses same-provider fanout switch attempt transcript events as background maintenance', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt-fanout',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-attempt', seq: 2, localId: 'local-attempt', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-attempt-fanout',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: true,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'succeeded',
        outcomeAction: 'hot_applied',
        errorCode: null,
        partialState: null,
        reason: 'same_provider_account_exhausted',
      },
    });

    expect(postSpy).not.toHaveBeenCalled();
  });

  it('drops exact switch verification proof details without identity material', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-attempt', seq: 2, localId: 'local-attempt', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-attempt',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: true,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'succeeded',
        outcomeAction: 'hot_applied',
        errorCode: null,
        partialState: null,
        verificationByServiceId: {
          'openai-codex': {
            status: 'verified',
            proofStrength: 'exact',
            source: 'applied_credential',
          },
        },
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-attempt\/messages$/),
      expect.objectContaining({
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'connected-service-account-switch-attempt',
                ok: true,
                action: 'hot_applied',
                verificationByServiceId: {
                  'openai-codex': {
                    status: 'verified',
                  },
                },
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('preserves exact shared-auth-surface switch verification proof details', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-attempt',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-attempt', seq: 2, localId: 'local-attempt', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-attempt',
      event: {
        type: 'connected_service_account_switch_attempt',
        ok: true,
        action: 'hot_applied',
        attemptedContinuityMode: 'hot_apply',
        outcome: 'succeeded',
        outcomeAction: 'hot_applied',
        errorCode: null,
        partialState: null,
        verificationByServiceId: {
          'claude-subscription': {
            status: 'verified',
            sharedAuthSurfaceId: 'claude-team',
            proofStrength: 'exact',
            source: 'runtime_identity_probe',
          },
        },
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-attempt\/messages$/),
      expect.objectContaining({
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'connected-service-account-switch-attempt',
                ok: true,
                action: 'hot_applied',
                verificationByServiceId: {
                  'claude-subscription': {
                    status: 'verified',
                    sharedAuthSurfaceId: 'claude-team',
                    proofStrength: 'exact',
                    source: 'runtime_identity_probe',
                  },
                },
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits provider state-sharing degraded diagnostics', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-degraded',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-degraded', seq: 2, localId: 'local-degraded', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-degraded',
      event: {
        type: 'provider_state_sharing_degraded',
        serviceId: 'anthropic',
        requestedStateMode: 'shared',
        effectiveStateMode: 'isolated',
        code: 'state_symlink_unavailable',
        entryName: 'sessions/--Users-alice-work-project--',
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-degraded\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^provider-state-sharing-degraded:anthropic:/),
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'provider-state-sharing-degraded',
                serviceId: 'anthropic',
                requestedStateMode: 'shared',
                effectiveStateMode: 'isolated',
                code: 'state_symlink_unavailable',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
    const [, postedBody] = postSpy.mock.calls[0]!;
    expect(JSON.stringify(postedBody)).not.toContain('Users-alice-work-project');
    expect(JSON.stringify(postedBody)).not.toContain('entryName');
  });

  it('surfaces preventive soft-threshold switches as transcript events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-2',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-2', seq: 2, localId: 'local-2', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-2',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'soft_threshold',
        generation: 4,
      },
    });

    expect(getSpy).toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-2\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch:openai-codex:codex-main:/),
      }),
      expect.any(Object),
    );
  });

  it('commits the actual switch mode from runtime auth events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-hot',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-hot', seq: 2, localId: 'local-hot', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-hot',
      event: {
        type: 'connected_service_account_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'manual',
        mode: 'hot_apply',
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-hot\/messages$/),
      expect.objectContaining({
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                mode: 'hot_apply',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('surfaces pre-turn auth-group soft-threshold switch coordinator events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-3',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-3', seq: 2, localId: 'local-3', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-3',
      event: {
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'soft_threshold',
        fromGeneration: 3,
        toGeneration: 4,
        resultStatus: 'switched',
        success: true,
        latencyMs: 12,
      },
    });

    expect(getSpy).toHaveBeenCalled();
    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-3\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch:openai-codex:codex-main:/),
      }),
      expect.any(Object),
    );
  });

  it('suppresses same-provider fanout switch coordinator events as background maintenance', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-fanout',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-fanout', seq: 2, localId: 'local-fanout', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-fanout',
      event: {
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'primary',
        toProfileId: 'backup',
        reason: 'same_provider_account_exhausted',
        fromGeneration: 3,
        toGeneration: 4,
        resultStatus: 'switched',
        success: true,
        latencyMs: 12,
      },
    });

    expect(getSpy).not.toHaveBeenCalled();
    expect(postSpy).not.toHaveBeenCalled();
  });

  it('commits auth-disabled switch coordinator events as auth-expired transcript events', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-4',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-4', seq: 2, localId: 'local-4', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-4',
      event: {
        type: 'connected_service_auth_group_switch',
        serviceId: 'openai-codex',
        groupId: 'codex-main',
        fromProfileId: 'disabled',
        toProfileId: 'backup',
        reason: 'account_disabled',
        fromGeneration: 7,
        toGeneration: 8,
        resultStatus: 'switched',
        success: true,
        latencyMs: 12,
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-4\/messages$/),
      expect.objectContaining({
        localId: 'connected-service-account-switch:openai-codex:codex-main:8',
        attentionImpact: {
          affectsUnread: false,
          affectsMeaningfulActivity: false,
        },
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                fromProfileId: 'disabled',
                toProfileId: 'backup',
                reason: 'auth_expired',
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('commits active-turn deferral observability events to transcript', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: {
          id: 'sess-deferral',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValueOnce({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-deferral', seq: 2, localId: 'local-deferral', createdAt: 2 },
      },
    });

    await commitConnectedServiceAccountSwitchSessionEvent({
      credentials: {
        token: 'token-1',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-deferral',
      event: {
        type: 'connected_service_account_switch_deferred',
        policy: 'defer_until_turn_boundary',
        awaitingBoundary: true,
        timeoutMs: 60_000,
      },
    });

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\/v2\/sessions\/sess-deferral\/messages$/),
      expect.objectContaining({
        localId: expect.stringMatching(/^connected-service-account-switch-deferral:defer_until_turn_boundary:/),
        attentionImpact: {
          affectsUnread: false,
          affectsMeaningfulActivity: false,
        },
        content: expect.objectContaining({
          t: 'plain',
          v: expect.objectContaining({
            content: expect.objectContaining({
              data: expect.objectContaining({
                type: 'connected-service-account-switch-deferral',
                policy: 'defer_until_turn_boundary',
                awaitingBoundary: true,
                timeoutMs: 60_000,
              }),
            }),
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it('uses deterministic semantic local ids for repeated maintenance event commits', async () => {
    process.env.HAPPIER_SERVER_URL = 'http://server.example.test';
    vi.resetModules();
    const { commitConnectedServiceAccountSwitchSessionEvent } = await import('./commitConnectedServiceAccountSwitchSessionEvent');

    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: {
        session: {
          id: 'sess-deterministic',
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
          active: true,
          activeAt: 1,
          encryptionMode: 'plain',
          metadata: '{}',
          metadataVersion: 1,
          agentState: null,
          agentStateVersion: 1,
          dataEncryptionKey: null,
        },
      },
    });
    const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
      status: 200,
      data: {
        didWrite: true,
        message: { id: 'msg-deterministic', seq: 2, localId: 'local-deterministic', createdAt: 2 },
      },
    });
    const credentials = {
      token: 'token-1',
      encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
    };
    const eventCases: ReadonlyArray<Readonly<{
      event: Readonly<Record<string, unknown>>;
      expectedPrefix: string;
    }>> = [
      {
        expectedPrefix: 'connected-service-account-switch:anthropic:direct:old-profile:new-profile:manual:restart_resume',
        event: {
          type: 'connected_service_account_switch',
          serviceId: 'anthropic',
          groupId: null,
          fromProfileId: 'old-profile',
          toProfileId: 'new-profile',
          reason: 'manual',
          mode: 'restart_resume',
        },
      },
      {
        expectedPrefix: 'connected-service-account-switch-deferral:defer_until_turn_boundary:awaiting_boundary:60000',
        event: {
          type: 'connected_service_account_switch_deferred',
          policy: 'defer_until_turn_boundary',
          awaitingBoundary: true,
          timeoutMs: 60_000,
        },
      },
      {
        expectedPrefix: 'connected-service-account-switch-deferral-completed:defer_until_turn_boundary:completed_at_boundary',
        event: {
          type: 'connected_service_account_switch_deferral_completed',
          policy: 'defer_until_turn_boundary',
          reason: 'completed_at_boundary',
        },
      },
      {
        expectedPrefix: 'connected-service-account-switch-deferral-superseded:defer_until_idle',
        event: {
          type: 'connected_service_account_switch_deferral_superseded',
          policy: 'defer_until_idle',
        },
      },
      {
        expectedPrefix: 'connected-service-account-switch-attempt:failed:hot_applied:manual:hot_apply:failed:none:post_switch_verification_failed',
        event: {
          type: 'connected_service_account_switch_attempt',
          ok: false,
          action: 'hot_applied',
          reason: 'manual',
          attemptedContinuityMode: 'hot_apply',
          outcome: 'failed',
          outcomeAction: 'none',
          errorCode: 'post_switch_verification_failed',
          partialState: 'runtime_auth_partially_applied',
        },
      },
      {
        expectedPrefix: 'provider-state-sharing-degraded:anthropic:shared:isolated:state_symlink_unavailable',
        event: {
          type: 'provider_state_sharing_degraded',
          serviceId: 'anthropic',
          requestedStateMode: 'shared',
          effectiveStateMode: 'isolated',
          code: 'state_symlink_unavailable',
          entryName: 'sessions/--Users-alice-work-project--',
        },
      },
    ];

    for (const { event, expectedPrefix } of eventCases) {
      postSpy.mockClear();
      await commitConnectedServiceAccountSwitchSessionEvent({
        credentials,
        sessionId: 'sess-deterministic',
        event,
      });
      await commitConnectedServiceAccountSwitchSessionEvent({
        credentials,
        sessionId: 'sess-deterministic',
        event,
      });

      expect(postSpy).toHaveBeenCalledTimes(2);
      const firstPayload = postSpy.mock.calls[0]?.[1] as Readonly<{ localId: string }>;
      const secondPayload = postSpy.mock.calls[1]?.[1] as Readonly<{ localId: string }>;
      expect(firstPayload.localId).toBe(secondPayload.localId);
      expect(firstPayload.localId).toBe(expectedPrefix);
    }
  });
});
