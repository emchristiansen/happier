import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient } from '@/api/api';
import { resetServerEndpointFailureLogSamplingForTests } from '@/api/client/serverEndpointFailureLog';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import type { Credentials } from '@/persistence';

import {
  classifyConnectQuotaRefreshState,
  connectQuotaExitCode,
  formatConnectQuotaResultJson,
  formatConnectQuotaResultLines,
  parseConnectQuotaArgs,
  runConnectQuotaOperation,
} from './connectQuotaRefresh';

/**
 * The real ApiClient against a synthetic server: axios answers by method and path the way the
 * server's routes do, so the client's route choice, auth header and response handling are what runs.
 */
const { mockGet, mockPost, mockFetch } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { get: mockGet, post: mockPost, isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError) },
  isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
}));

vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const credentials: Credentials = { token: 'account-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } };

function notFound(error: string) {
  return Object.assign(new Error('Request failed with status 404'), {
    isAxiosError: true,
    response: { status: 404, data: { error }, headers: {} },
  });
}

type Metadata = { fetchedAt: number; staleAfterMs: number; status: 'ok'; refreshRequestedAt?: number; refreshErrorAt?: number };

/**
 * One account on a synthetic server. Mode-gated quota routes answer 404 for the other mode, exactly
 * as the server's V2 (`readE2eeAccount`) and V3 (`readPlainAccount`) handlers do.
 */
function server(params: Readonly<{
  mode: 'e2ee' | 'plain' | 'unknown' | 'endpoint_404' | 'endpoint_500';
  profiles: Record<string, Readonly<{ status: string; metadata: Metadata | null }>>;
  requestedAt?: number;
}>) {
  const requests: string[] = [];
  const version = params.mode === 'e2ee' ? 'v2' : 'v3';
  const quotaPath = /\/(v[23])\/connect\/([^/]+)\/profiles\/([^/]+)\/quotas(\/refresh)?$/;
  mockGet.mockImplementation(async (url: string, config: { headers?: Record<string, string> }) => {
    expect(config.headers?.Authorization).toBe('Bearer account-token');
    const path = new URL(url).pathname;
    requests.push(`GET ${path}`);
    if (path === '/v1/account/encryption') {
      if (params.mode === 'unknown') return { status: 200, data: {} };
      if (params.mode === 'endpoint_404') throw notFound('Not Found');
      if (params.mode === 'endpoint_500') {
        throw Object.assign(new Error('boom'), { isAxiosError: true, response: { status: 500, data: {}, headers: {} } });
      }
      return { status: 200, data: { mode: params.mode, updatedAt: 1 } };
    }
    const health = path.match(/\/v3\/connect\/([^/]+)\/profiles\/([^/]+)\/credential\/health$/);
    if (health) {
      const profile = params.profiles[`${health[1]}/${health[2]}`];
      if (!profile) throw notFound('connect_credential_not_found');
      return { status: 200, data: { profileId: health[2], status: profile.status, health: null } };
    }
    const quota = path.match(quotaPath);
    if (quota && !quota[4]) {
      const profile = params.profiles[`${quota[2]}/${quota[3]}`];
      if (quota[1] !== version || !profile?.metadata) throw notFound('connect_quotas_not_found');
      return quota[1] === 'v2'
        ? { status: 200, data: { sealed: { format: 'account_scoped_v1', ciphertext: 'c2VhbGVk' }, metadata: profile.metadata } }
        : { status: 200, data: { content: { t: 'plain', v: plainSnapshot(quota[2], quota[3], profile.metadata) }, metadata: profile.metadata } };
    }
    throw new Error(`unexpected GET ${path}`);
  });
  mockPost.mockImplementation(async (url: string, _body: unknown, config: { headers?: Record<string, string> }) => {
    expect(config.headers?.Authorization).toBe('Bearer account-token');
    const path = new URL(url).pathname;
    requests.push(`POST ${path}`);
    const quota = path.match(quotaPath);
    if (!quota?.[4]) throw new Error(`unexpected POST ${path}`);
    const profile = params.profiles[`${quota[2]}/${quota[3]}`];
    if (quota[1] !== version || !profile?.metadata) throw notFound('connect_quotas_not_found');
    profile.metadata.refreshRequestedAt = params.requestedAt ?? 5_000;
    return { status: 200, data: { success: true } };
  });
  return { requests };
}

function plainSnapshot(serviceId: string, profileId: string, metadata: Metadata) {
  return {
    v: 1, serviceId, profileId, fetchedAt: metadata.fetchedAt, staleAfterMs: metadata.staleAfterMs,
    planLabel: null, accountLabel: null, meters: [],
  };
}

describe('connect quota-refresh / quota-status argument parsing', () => {
  it('selects one exact service and profile', () => {
    expect(parseConnectQuotaArgs('quota-refresh', ['--service', 'openai-codex', '--profile', 'work-2', '--json']))
      .toEqual({ operation: 'request', serviceId: 'openai-codex', profileId: 'work-2', json: true });
    expect(parseConnectQuotaArgs('quota-status', ['--profile', 'a', '--service', 'claude-subscription']))
      .toEqual({ operation: 'status', serviceId: 'claude-subscription', profileId: 'a', json: false });
  });

  it.each([
    [['--profile', 'a']],
    [['--service', 'openai-codex']],
    [['--service', 'openai-codex', '--profile']],
    [['--service', 'openai-codex', '--profile', '--json']],
    [['--service', 'openai-codex', '--profile', 'a', '--profile', 'b']],
    [['--service', 'openai-codex', '--profile', 'a', 'extra']],
    [['--service', 'openai-codex', '--profile', 'a', '--all']],
    [['--service', 'not-a-service', '--profile', 'a']],
    [['--service', 'openai-codex', '--profile', 'bad/id']],
  ])('refuses %j', (args) => {
    expect(() => parseConnectQuotaArgs('quota-refresh', args)).toThrow();
  });
});

describe('classifying a refresh request from the profile\'s own quota metadata', () => {
  const base = { fetchedAt: 1_000, staleAfterMs: 60_000, status: 'ok' as const };
  it.each([
    [null, 'quota_read_404'],
    [base, 'no_request'],
    [{ ...base, refreshRequestedAt: 2_000 }, 'pending'],
    [{ ...base, refreshRequestedAt: 2_000, refreshErrorAt: 1_500 }, 'pending'],
    [{ ...base, refreshRequestedAt: 2_000, refreshErrorAt: 2_500 }, 'failed'],
    [{ ...base, fetchedAt: 2_000, refreshRequestedAt: 2_000 }, 'fetched'],
    [{ ...base, fetchedAt: 3_000, refreshRequestedAt: 2_000, refreshErrorAt: 2_500 }, 'fetched'],
  ])('%j is %s', (metadata, kind) => {
    expect(classifyConnectQuotaRefreshState(metadata).kind).toBe(kind);
  });
});

describe('connect quota operations through the real ApiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetServerEndpointFailureLogSamplingForTests();
    resetServerFeaturesClientForTests();
    mockFetch.mockResolvedValue(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', mockFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  const metadata = (): Metadata => ({ fetchedAt: 1_000, staleAfterMs: 60_000, status: 'ok' });

  it('e2ee: requests through V2 and reads the request back as pending, never opening the sealed snapshot', async () => {
    const s = server({ mode: 'e2ee', profiles: { 'openai-codex/work': { status: 'connected', metadata: metadata() } } });
    const api = await ApiClient.create(credentials);
    const result = await runConnectQuotaOperation(api, { operation: 'request', serviceId: 'openai-codex', profileId: 'work' });
    expect(result).toMatchObject({
      outcome: 'requested', accountEncryptionMode: 'e2ee',
      credential: { kind: 'found', status: 'connected' },
      state: { kind: 'pending', metadata: { refreshRequestedAt: 5_000, fetchedAt: 1_000 } },
    });
    expect(connectQuotaExitCode(result)).toBe(0);
    expect(s.requests).toEqual([
      'GET /v1/account/encryption',
      'GET /v3/connect/openai-codex/profiles/work/credential/health',
      'POST /v2/connect/openai-codex/profiles/work/quotas/refresh',
      'GET /v2/connect/openai-codex/profiles/work/quotas',
    ]);
    const json = JSON.parse(formatConnectQuotaResultJson(
      { operation: 'request', serviceId: 'openai-codex', profileId: 'work', json: true }, result,
    ));
    expect(json).toMatchObject({ outcome: 'requested', state: 'pending', metadata: { refreshRequestedAtIso: new Date(5_000).toISOString() } });
    expect(JSON.stringify(json)).not.toContain('c2VhbGVk');
  });

  it('plain: requests through V3', async () => {
    const s = server({ mode: 'plain', profiles: { 'claude-subscription/a': { status: 'refresh_failed_retryable', metadata: metadata() } } });
    const api = await ApiClient.create(credentials);
    const result = await runConnectQuotaOperation(api, { operation: 'request', serviceId: 'claude-subscription', profileId: 'a' });
    expect(result).toMatchObject({ outcome: 'requested', accountEncryptionMode: 'plain', state: { kind: 'pending' } });
    expect(s.requests).toContain('POST /v3/connect/claude-subscription/profiles/a/quotas/refresh');
    expect(s.requests).toContain('GET /v3/connect/claude-subscription/profiles/a/quotas');
  });

  it('status reports a completed fetch after the request without writing anything', async () => {
    const s = server({ mode: 'e2ee', profiles: { 'openai-codex/work': { status: 'connected', metadata: { ...metadata(), fetchedAt: 9_000, refreshRequestedAt: 5_000 } } } });
    const api = await ApiClient.create(credentials);
    const result = await runConnectQuotaOperation(api, { operation: 'status', serviceId: 'openai-codex', profileId: 'work' });
    expect(result).toMatchObject({ outcome: 'status', state: { kind: 'fetched' } });
    expect(mockPost).not.toHaveBeenCalled();
    expect(s.requests.every((request) => !request.includes('/profiles?') && !request.endsWith('/profiles'))).toBe(true);
  });

  it('status reports a refresher failure recorded after the request', async () => {
    server({ mode: 'e2ee', profiles: { 'openai-codex/work': { status: 'connected', metadata: { ...metadata(), refreshRequestedAt: 5_000, refreshErrorAt: 6_000 } } } });
    const api = await ApiClient.create(credentials);
    const result = await runConnectQuotaOperation(api, { operation: 'status', serviceId: 'openai-codex', profileId: 'work' });
    expect(result).toMatchObject({ outcome: 'status', state: { kind: 'failed' } });
  });

  it.each([
    ['a malformed mode answer', 'unknown'],
    ['a 404 from the mode endpoint (never read as e2ee here)', 'endpoint_404'],
    ['a 500 from the mode endpoint', 'endpoint_500'],
  ] as const)('refuses, writing nothing, on %s', async (_label, mode) => {
    const s = server({ mode, profiles: { 'openai-codex/work': { status: 'connected', metadata: metadata() } } });
    const api = await ApiClient.create(credentials);
    const result = await runConnectQuotaOperation(api, { operation: 'request', serviceId: 'openai-codex', profileId: 'work' });
    expect(result).toEqual({ outcome: 'refused', reason: 'account_encryption_mode_unknown', credential: null });
    expect(connectQuotaExitCode(result)).toBe(2);
    expect(mockPost).not.toHaveBeenCalled();
    expect(s.requests).toEqual(['GET /v1/account/encryption']);
  });

  it('control: the compatibility reader still takes a mode-endpoint 404 as e2ee', async () => {
    server({ mode: 'endpoint_404', profiles: {} });
    const api = await ApiClient.create(credentials);
    await expect(api.getAccountEncryptionModeUncached()).resolves.toBe('e2ee');
  });

  it('refuses a needs_reauth credential, writing nothing', async () => {
    server({ mode: 'e2ee', profiles: { 'openai-codex/work': { status: 'needs_reauth', metadata: metadata() } } });
    const api = await ApiClient.create(credentials);
    const result = await runConnectQuotaOperation(api, { operation: 'request', serviceId: 'openai-codex', profileId: 'work' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'credential_not_usable', credential: { kind: 'found', status: 'needs_reauth' } });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('fails, writing nothing, when the credential health cannot be read', async () => {
    server({ mode: 'e2ee', profiles: { 'openai-codex/work': { status: 'not-a-status', metadata: metadata() } } });
    const api = await ApiClient.create(credentials);
    await expect(runConnectQuotaOperation(api, { operation: 'request', serviceId: 'openai-codex', profileId: 'work' }))
      .rejects.toThrow('Invalid connected service credential health response');
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('refuses a profile with no credential, writing nothing', async () => {
    server({ mode: 'e2ee', profiles: {} });
    const api = await ApiClient.create(credentials);
    const result = await runConnectQuotaOperation(api, { operation: 'request', serviceId: 'openai-codex', profileId: 'absent' });
    expect(result).toMatchObject({ outcome: 'refused', reason: 'credential_not_found' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('reports the refresh route\'s own connect_quotas_not_found as request_not_found, drawing no source conclusion', async () => {
    server({ mode: 'e2ee', profiles: { 'openai-codex/work': { status: 'connected', metadata: null } } });
    const api = await ApiClient.create(credentials);
    const args = { operation: 'request', serviceId: 'openai-codex', profileId: 'work', json: false } as const;
    const result = await runConnectQuotaOperation(api, args);
    expect(result).toEqual({ outcome: 'request_not_found', accountEncryptionMode: 'e2ee', credential: { kind: 'found', status: 'connected' } });
    expect(connectQuotaExitCode(result)).toBe(2);
    const lines = formatConnectQuotaResultLines(args, result).join('\n');
    expect(lines).toContain('answered connect_quotas_not_found (the account is not in that mode, or the profile has no quota source)');
    expect(lines).not.toContain('the server has no quota source for this profile');
  });

  it.each([
    ['a framework 404 for an absent route', { message: 'Route POST:/v2/connect/openai-codex/profiles/work/quotas/refresh not found', error: 'Not Found', statusCode: 404 }],
    ['a 404 with no body', undefined],
  ])('treats %s on the refresh route as an error, never as request_not_found', async (_label, data) => {
    server({ mode: 'e2ee', profiles: { 'openai-codex/work': { status: 'connected', metadata: metadata() } } });
    mockPost.mockRejectedValueOnce(Object.assign(new Error('Request failed with status 404'), {
      isAxiosError: true, response: { status: 404, data, headers: {} },
    }));
    const api = await ApiClient.create(credentials);
    await expect(runConnectQuotaOperation(api, { operation: 'request', serviceId: 'openai-codex', profileId: 'work' }))
      .rejects.toThrow('without connect_quotas_not_found from v2');
  });

  it('reports a 404 from the metadata read as quota_read_404, with no profile, source or route conclusion', async () => {
    server({ mode: 'e2ee', profiles: { 'openai-codex/work': { status: 'connected', metadata: null } } });
    const api = await ApiClient.create(credentials);
    const args = { operation: 'status', serviceId: 'openai-codex', profileId: 'work', json: true } as const;
    const result = await runConnectQuotaOperation(api, args);
    expect(result).toMatchObject({ outcome: 'status', state: { kind: 'quota_read_404' } });
    expect(connectQuotaExitCode(result)).toBe(0);
    expect(JSON.parse(formatConnectQuotaResultJson(args, result))).toMatchObject({ state: 'quota_read_404', metadata: null });
    const lines = formatConnectQuotaResultLines(args, result).join('\n');
    expect(lines).toContain('state quota_read_404');
    expect(lines).toContain('no profile, source or route conclusion follows');
    expect(lines).not.toMatch(/fetched|quota source/);
  });

  it('propagates a server failure instead of reporting a request', async () => {
    server({ mode: 'e2ee', profiles: { 'openai-codex/work': { status: 'connected', metadata: metadata() } } });
    mockPost.mockRejectedValueOnce(Object.assign(new Error('boom'), { isAxiosError: true, response: { status: 500, data: {}, headers: {} } }));
    const api = await ApiClient.create(credentials);
    await expect(runConnectQuotaOperation(api, { operation: 'request', serviceId: 'openai-codex', profileId: 'work' }))
      .rejects.toThrow('Failed to request connected service quota refresh');
  });

  it('treats a 200 without success as a protocol failure', async () => {
    server({ mode: 'e2ee', profiles: { 'openai-codex/work': { status: 'connected', metadata: metadata() } } });
    mockPost.mockResolvedValueOnce({ status: 200, data: {} });
    const api = await ApiClient.create(credentials);
    await expect(runConnectQuotaOperation(api, { operation: 'request', serviceId: 'openai-codex', profileId: 'work' }))
      .rejects.toThrow('without success');
  });
});
