import { beforeEach, describe, expect, it, vi } from 'vitest';

import axios from 'axios';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { ApiClient } from './api';
import { logger } from '@/ui/logger';
import { resetServerEndpointFailureLogSamplingForTests } from './client/serverEndpointFailureLog';
import type { Credentials } from '@/persistence';

const { mockPost, mockGet, mockPatch } = vi.hoisted(() => ({
  mockPost: vi.fn(),
  mockGet: vi.fn(),
  mockPatch: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { post: mockPost, get: mockGet, patch: mockPatch, isAxiosError: vi.fn(() => true) },
  isAxiosError: vi.fn(() => true),
}));

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('./configuration', () => ({
  configuration: {
    serverUrl: 'https://api.example.com',
  },
}));

function createTestCredentials(): Credentials {
  return {
    token: 'happy-token',
    encryption: { type: 'legacy', secret: new Uint8Array(32) },
  };
}

function createAxiosResponseError(params: Readonly<{
  status: number;
  data?: unknown;
  headers?: Record<string, string>;
}>): Error & {
  response: {
    status: number;
    data: unknown;
    headers: Record<string, string>;
  };
} {
  const error = new Error(`Request failed with status ${params.status}`) as Error & {
    response: {
      status: number;
      data: unknown;
      headers: Record<string, string>;
    };
  };
  error.response = {
    status: params.status,
    data: params.data ?? { error: 'request_failed' },
    headers: params.headers ?? {},
  };
  return error;
}

describe('ApiClient connected services v3 credentials', () => {
  beforeEach(() => {
    mockPost.mockReset();
    mockGet.mockReset();
    mockPatch.mockReset();
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
  });

  it('posts plaintext credentials to the v3 connected services endpoint', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true, credentialRevision: 'csr_1234567890123456789012' } });

    const api = await ApiClient.create(createTestCredentials());
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(typeof (api as unknown as { registerConnectedServiceCredentialPlain?: unknown }).registerConnectedServiceCredentialPlain).toBe('function');
    await (api as unknown as {
      registerConnectedServiceCredentialPlain(params: {
        serviceId: 'openai-codex';
        profileId: string;
        content: { t: 'plain'; v: typeof record };
      }): Promise<void>;
    }).registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/credential'),
      expect.objectContaining({
        content: { t: 'plain', v: record },
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer happy-token',
        }),
      }),
    );

    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('plain-access-token');
    expect(serializedLogs).not.toContain('plain-refresh-token');
  });

  it('serializes an explicit expect-absent credential revision guard', async () => {
    mockPost.mockResolvedValue({ status: 200, data: { success: true, credentialRevision: 'csr_1234567890123456789012' } });

    const api = await ApiClient.create(createTestCredentials());
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: { token: 'plain-token', providerAccountId: null, providerEmail: null },
    });

    await api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
      expectedCredentialRevision: null,
    });

    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/credential'),
      expect.objectContaining({ expectedCredentialRevision: null }),
      expect.any(Object),
    );
  });

  it('preserves a definite credential write rejection as a sanitized status error', async () => {
    mockPost.mockRejectedValueOnce(createAxiosResponseError({
      status: 400,
      data: { error: 'invalid_request' },
    }));
    const api = await ApiClient.create(createTestCredentials());
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'token',
      token: { token: 'plain-token', providerAccountId: null, providerEmail: null },
    });

    await expect(api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
      expectedCredentialRevision: null,
    })).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('rejects noncanonical mutation responses instead of trusting route-divergent profile metadata', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
        profileId: 'other-profile',
      },
    });

    const api = await ApiClient.create(createTestCredentials());
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await expect(api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    })).rejects.toThrow('Invalid connected service credential mutation response');

    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
    const serializedLogs = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(serializedLogs).not.toContain('plain-access-token');
    expect(serializedLogs).not.toContain('plain-refresh-token');
  });

  it('samples transient plaintext credential registration failures without error-labeled logs', async () => {
    mockPost.mockRejectedValue(createAxiosResponseError({
      status: 503,
      data: { error: 'server_unavailable' },
      headers: { 'retry-after': '3' },
    }));

    const api = await ApiClient.create(createTestCredentials());
    const record = buildConnectedServiceCredentialRecord({
      now: 1_000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'plain-access-token',
        refreshToken: 'plain-refresh-token',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    await expect(api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    })).rejects.toThrow('Failed to register connected service credential');
    await expect(api.registerConnectedServiceCredentialPlain({
      serviceId: 'openai-codex',
      profileId: 'work',
      content: { t: 'plain', v: record },
    })).rejects.toThrow('Failed to register connected service credential');

    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).toBe(
      '[API] Failed to register connected service credential temporarily unavailable; will retry or recover when the server is ready.',
    );
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect(vi.mocked(logger.debug).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'server_error',
        retryable: true,
        statusCode: 503,
        retryAfterMs: 3_000,
      },
    });
    const serializedLogs = JSON.stringify(vi.mocked(logger.debug).mock.calls);
    expect(serializedLogs).not.toContain('plain-access-token');
    expect(serializedLogs).not.toContain('plain-refresh-token');
  });

  it('uses the canonical v3 refresh lease endpoint', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: {
        acquired: true,
        leaseUntil: 1234,
        ownerId: 'machine-1:daemon-a',
        credentialRevision: 'csr_abcdefghijklmnopqrstuv',
      },
    });

    const api = await ApiClient.create(createTestCredentials());
    const leaseApi = api as unknown as {
      acquireConnectedServiceRefreshLease(params: {
        serviceId: 'openai-codex';
        profileId: string;
        machineId: string;
        ownerId?: string;
        leaseMs: number;
      }): Promise<{ acquired: boolean; leaseUntil: number; ownerId: string; credentialRevision: string }>;
    };
    const lease = await leaseApi.acquireConnectedServiceRefreshLease({
      serviceId: 'openai-codex',
      profileId: 'work',
      machineId: 'machine-1',
      ownerId: 'machine-1:daemon-a',
      leaseMs: 10_000,
    });

    expect(lease).toEqual({
      acquired: true,
      leaseUntil: 1234,
      ownerId: 'machine-1:daemon-a',
      credentialRevision: 'csr_abcdefghijklmnopqrstuv',
    });
    expect(axios.post).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/refresh-lease'),
      { machineId: 'machine-1', ownerId: 'machine-1:daemon-a', leaseMs: 10_000 },
      expect.any(Object),
    );
  });

  it('fences refresh lease acquisition and returns the authoritative credential revision', async () => {
    mockPost.mockResolvedValue({
      status: 200,
      data: { acquired: true, leaseUntil: 2_000, ownerId: 'machine-a:daemon-a:attempt-a', credentialRevision: 'csr_1234567890123456789012' },
    });
    const api = await ApiClient.create(createTestCredentials());

    await expect(api.acquireConnectedServiceRefreshLease({
      serviceId: 'openai-codex',
      profileId: 'work',
      machineId: 'machine-a',
      ownerId: 'machine-a:daemon-a:attempt-a',
      leaseMs: 1_000,
      expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv',
    })).resolves.toEqual({
      acquired: true,
      leaseUntil: 2_000,
      ownerId: 'machine-a:daemon-a:attempt-a',
      credentialRevision: 'csr_1234567890123456789012',
    });

    expect(mockPost).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/refresh-lease'),
      expect.objectContaining({ expectedCredentialRevision: 'csr_abcdefghijklmnopqrstuv' }),
      expect.any(Object),
    );
  });

  it('posts normalized credential health without credential secrets', async () => {
    mockPatch.mockResolvedValue({ status: 200, data: { success: true, credentialRevision: 'csr_1234567890123456789012' } });

    const api = await ApiClient.create(createTestCredentials());
    await api.updateConnectedServiceCredentialHealth({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'invalid_grant',
        lastRefreshFailureAt: 1234,
      },
    });

    expect(axios.patch).toHaveBeenCalledWith(
      expect.stringContaining('/v3/connect/openai-codex/profiles/work/credential/health'),
      expect.objectContaining({
        health: expect.objectContaining({
          reconnectRequired: true,
          lastRefreshFailureKind: 'invalid_grant',
        }),
      }),
      expect.any(Object),
    );
    expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('refresh-token');
  });

  it('samples transient credential health update failures without error-labeled logs', async () => {
    mockPatch.mockRejectedValue(createAxiosResponseError({
      status: 429,
      data: { error: 'rate_limited' },
      headers: { 'retry-after': '4' },
    }));

    const api = await ApiClient.create(createTestCredentials());

    await expect(api.updateConnectedServiceCredentialHealth({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'network_error',
        lastRefreshFailureAt: 1234,
      },
    })).rejects.toThrow('Failed to update connected service credential health');
    await expect(api.updateConnectedServiceCredentialHealth({
      serviceId: 'openai-codex',
      profileId: 'work',
      health: {
        v: 1,
        status: 'needs_reauth',
        reconnectRequired: true,
        lastRefreshFailureKind: 'network_error',
        lastRefreshFailureAt: 1234,
      },
    })).rejects.toThrow('Failed to update connected service credential health');

    expect(vi.mocked(logger.debug)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).toBe(
      '[API] Failed to update connected service credential health temporarily unavailable; will retry or recover when the server is ready.',
    );
    expect(vi.mocked(logger.debug).mock.calls[0]?.[0]).not.toContain('[ERROR]');
    expect(vi.mocked(logger.debug).mock.calls[0]?.[1]).toMatchObject({
      classification: {
        kind: 'rate_limited',
        retryable: true,
        statusCode: 429,
        retryAfterMs: 4_000,
      },
    });
  });

  it('reads one profile\'s credential health from its exact-profile route, never the service-wide list', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: {
        profileId: 'work',
        status: 'needs_reauth',
        health: { v: 1, status: 'needs_reauth', reconnectRequired: true, lastRefreshFailureKind: 'invalid_grant' },
      },
    });

    const api = await ApiClient.create(createTestCredentials());
    const result = await api.readConnectedServiceCredentialHealth({ serviceId: 'claude-subscription', profileId: 'work' });

    expect(result).toEqual({
      kind: 'found',
      status: 'needs_reauth',
      health: { v: 1, status: 'needs_reauth', reconnectRequired: true, lastRefreshFailureKind: 'invalid_grant' },
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0]?.[0]).toMatch(/\/v3\/connect\/claude-subscription\/profiles\/work\/credential\/health$/);
  });

  it('reports a profile the server does not have as not found', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({ status: 404, data: { error: 'connect_credential_not_found' } }));

    const api = await ApiClient.create(createTestCredentials());
    await expect(api.readConnectedServiceCredentialHealth({ serviceId: 'claude-subscription', profileId: 'gone' }))
      .resolves.toEqual({ kind: 'not_found' });
  });

  it('fails closed with a typed error when the server lacks the exact-profile health route', async () => {
    mockGet.mockRejectedValue(createAxiosResponseError({
      status: 404,
      data: { message: 'Route GET:/v3/connect/claude-subscription/profiles/work/credential/health not found', error: 'Not Found', statusCode: 404 },
    }));

    const api = await ApiClient.create(createTestCredentials());
    await expect(api.readConnectedServiceCredentialHealth({ serviceId: 'claude-subscription', profileId: 'work' }))
      .rejects.toMatchObject({ code: 'connected_service_credential_health_read_unavailable' });
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('rejects a health response for a different profile', async () => {
    mockGet.mockResolvedValue({ status: 200, data: { profileId: 'other', status: 'connected', health: null } });

    const api = await ApiClient.create(createTestCredentials());
    await expect(api.readConnectedServiceCredentialHealth({ serviceId: 'claude-subscription', profileId: 'work' }))
      .rejects.toThrow('Invalid connected service credential health response');
  });

  it('keeps the canonical status when a newer server sends a health shape this client does not know', async () => {
    mockGet.mockResolvedValue({
      status: 200,
      data: { profileId: 'work', status: 'refresh_failed_retryable', health: { v: 1, status: 'refresh_failed_retryable', lastRefreshFailureKind: 'future_kind' } },
    });

    const api = await ApiClient.create(createTestCredentials());
    await expect(api.readConnectedServiceCredentialHealth({ serviceId: 'claude-subscription', profileId: 'work' }))
      .resolves.toEqual({ kind: 'found', status: 'refresh_failed_retryable', health: null, healthUnrecognised: true });
  });
});
