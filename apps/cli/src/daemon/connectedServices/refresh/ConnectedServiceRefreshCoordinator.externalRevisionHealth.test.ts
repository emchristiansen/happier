import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AxiosError } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { ConnectedServiceCredentialHealthReadUnavailableError } from '@/api/connectedServices/connectedServiceCredentialApi';
import type { Credentials } from '@/persistence';

import {
  reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget,
  reconcileConnectedServiceDirectCredentialRevisions,
} from '../accountGroups/generation/reconcileConnectedServiceAuthGroupGenerations';
import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import {
  ConnectedServiceExternalCredentialUpdateRefusedError,
  ConnectedServiceRefreshCoordinator,
} from './ConnectedServiceRefreshCoordinator';
import { computeConnectedServiceAccessTokenFingerprint } from './credentialFreshness/tokenFingerprint';

const NOW = 2_000_000_000_000;
const SERVICE_ID = 'claude-subscription' as const;
const credentials = {
  token: 'synthetic',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(5) },
} satisfies Credentials;

type Health =
  | 'connected'
  | 'needs_reauth'
  | 'not_found'
  | 'unsupported'
  | 'malformed'
  | 'transport'
  | 'missing_reader';

async function readHealth(mode: Health) {
  switch (mode) {
    case 'connected': return { kind: 'found' as const, status: 'connected' as const, health: null };
    case 'needs_reauth': return { kind: 'found' as const, status: 'needs_reauth' as const, health: null };
    case 'not_found': return { kind: 'not_found' as const };
    case 'unsupported': throw new ConnectedServiceCredentialHealthReadUnavailableError(SERVICE_ID, 'A');
    case 'malformed': throw new Error('Invalid connected service credential health response');
    case 'transport': throw new AxiosError('socket hang up', 'ECONNRESET');
    case 'missing_reader': throw new Error('unreachable: the reader is removed before the update');
  }
}

type Producer = 'delta' | 'registration';

/**
 * Real public spawn on direct profile A, registration with the real refresh coordinator, then an
 * external projected revision for A applied through one of the two production direct-revision
 * reconcilers into the real `handleExternalCredentialUpdate`. Server state and HTTP are synthetic;
 * the projected replacement for A is a setup token, so no later refresh could check its health.
 */
async function applyExternalRevision(params: Readonly<{ producer: Producer; health: Health; boundary?: 'present' | 'absent' }>) {
  const dir = await mkdtemp(join(tmpdir(), 'happier-external-revision-health-'));
  const source = join(dir, 'source');
  await mkdir(source, { recursive: true });
  const processEnv = { HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: source };
  let phase: 'spawn' | 'update' = 'spawn';
  let health: Health = params.health;
  const updateHealthReads: string[] = [];
  const record = () => phase === 'update'
    ? buildConnectedServiceCredentialRecord({
        now: NOW,
        serviceId: SERVICE_ID,
        profileId: 'A',
        kind: 'token',
        token: { token: 'synthetic-replacement-A', providerAccountId: 'A', providerEmail: null },
      })
    : buildConnectedServiceCredentialRecord({
        now: NOW,
        serviceId: SERVICE_ID,
        profileId: 'A',
        kind: 'oauth',
        expiresAt: NOW + 3_600_000,
        oauth: {
          accessToken: 'synthetic-current-A',
          refreshToken: 'synthetic-refresh-A',
          idToken: null,
          scope: 'user:inference user:profile user:sessions:claude_code',
          tokenType: 'Bearer',
          providerAccountId: 'A',
          providerEmail: null,
        },
      });
  const readCredentialHealth = async () => {
    if (phase === 'spawn') return { kind: 'found' as const, status: 'connected' as const, health: null };
    updateHealthReads.push(health);
    return await readHealth(health);
  };
  const api: Record<string, unknown> = {
    getAccountEncryptionMode: async () => 'plain',
    getConnectedServiceCredentialPlain: async () => ({ content: { t: 'plain', v: record() } }),
    readConnectedServiceCredentialHealth: readCredentialHealth,
    updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
  };
  const onAuthUpdated = vi.fn(async (_update: unknown) => {});
  const coordinator = new ConnectedServiceRefreshCoordinator({
    api: api as unknown as ApiClient,
    credentials,
    machineIdProvider: () => 'synthetic-machine',
    activeServerDir: join(dir, 'server'),
    baseDir: join(dir, 'base'),
    refreshWindowMs: 60_000,
    refreshLeaseMs: 30_000,
    now: () => NOW,
    processEnv,
    onAuthUpdated,
  });
  const bindings = { v: 1, bindingsByServiceId: { [SERVICE_ID]: { source: 'connected', profileId: 'A' } } };
  const auth = await resolveConnectedServiceAuthForSpawn({
    agentId: 'claude',
    credentialRefreshService: coordinator,
    connectedServicesBindingsRaw: bindings,
    materializationKey: 'session',
    activeServerDir: join(dir, 'server'),
    baseDir: join(dir, 'base'),
    credentials,
    api: api as unknown as ApiClient,
    nowMs: () => NOW,
    processEnv,
  } as unknown as Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]);
  const targetFile = join(auth!.env.CLAUDE_CONFIG_DIR!, '.credentials.json');
  const before = await readFile(targetFile, 'utf8');
  coordinator.registerSpawnTarget({
    pid: 11,
    agentId: 'claude',
    sessionId: 'session',
    materializationKey: 'session',
    connectedServicesBindingsRaw: bindings,
    connectedServiceSelectionsEnv: auth!.env,
  } as unknown as Parameters<typeof coordinator.registerSpawnTarget>[0]);

  phase = 'update';
  if (params.health === 'missing_reader') delete api.readConnectedServiceCredentialHealth;
  const boundary = params.boundary === 'absent'
    ? { status: 'absent' as const }
    : {
        status: 'present' as const,
        revisionSemantics: 'revisioned' as const,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      };
  const runtimeTarget = {
    sessionId: 'session',
    agentId: 'claude',
    connectedServicesBindingsRaw: bindings,
    activeBindings: [{
      serviceId: SERVICE_ID,
      groupId: null,
      profileId: 'A',
      generation: null,
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
    }],
  };
  const applyLiveCredentialBoundary = async (input: Parameters<typeof coordinator.handleExternalCredentialUpdate>[0]) => {
    await coordinator.handleExternalCredentialUpdate(input);
  };
  const reconcile = async () => params.producer === 'delta'
    ? await reconcileConnectedServiceDirectCredentialRevisions({
        credentialBoundaries: [{ serviceId: SERVICE_ID, profileId: 'A', boundary }],
        listRuntimeTargets: () => [runtimeTarget],
        isCurrentRuntimeTarget: () => true,
        applyLiveCredentialBoundary,
        executionAuthority: 'passive_projection',
      } as unknown as Parameters<typeof reconcileConnectedServiceDirectCredentialRevisions>[0])
    : await reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget({
        target: runtimeTarget,
        resolveCredentialBoundary: () => boundary,
        applyLiveCredentialBoundary,
        executionAuthority: 'passive_projection',
        isCurrent: () => true,
      } as unknown as Parameters<typeof reconcileConnectedServiceDirectCredentialRevisionForRuntimeTarget>[0]);
  const outcome = await reconcile().then(
    (result) => ({ kind: 'applied' as const, result }),
    (error: unknown) => ({ kind: 'refused' as const, error }),
  );
  const after = await readFile(targetFile, 'utf8');
  const retryAfterHealthRecovers = async () => {
    health = 'connected';
    api.readConnectedServiceCredentialHealth = readCredentialHealth;
    const result = await reconcile();
    return { result, after: await readFile(targetFile, 'utf8') };
  };
  return { before, after, outcome, updateHealthReads, onAuthUpdated, retryAfterHealthRecovers };
}

/**
 * Control for the legitimate known-health path: the provider bridge reads A's exact health
 * (reconnect required by a predecessor's failure), then a forced retry adopts the current token,
 * which is newer than the failing one, and distributes it. Its read health is the evidence for
 * that distribution, so A's health is read once and the current credential is still written.
 */
async function forcedAdoptionUnderReconnectRequiredHealth() {
  const dir = await mkdtemp(join(tmpdir(), 'happier-known-health-adoption-'));
  const source = join(dir, 'source');
  await mkdir(source, { recursive: true });
  const processEnv = { HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: source };
  let phase: 'spawn' | 'bridge' = 'spawn';
  const bridgeHealthReads: string[] = [];
  const record = buildConnectedServiceCredentialRecord({
    now: NOW,
    serviceId: SERVICE_ID,
    profileId: 'A',
    kind: 'oauth',
    expiresAt: NOW + 3_600_000,
    oauth: {
      accessToken: 'synthetic-current-A',
      refreshToken: 'synthetic-refresh-A',
      idToken: null,
      scope: 'user:inference user:profile user:sessions:claude_code',
      tokenType: 'Bearer',
      providerAccountId: 'A',
      providerEmail: null,
    },
  });
  const api: Record<string, unknown> = {
    getAccountEncryptionMode: async () => 'plain',
    getConnectedServiceCredentialPlain: async () => ({ content: { t: 'plain', v: record } }),
    readConnectedServiceCredentialHealth: async () => {
      if (phase === 'spawn') return { kind: 'found' as const, status: 'connected' as const, health: null };
      bridgeHealthReads.push('needs_reauth');
      return { kind: 'found' as const, status: 'needs_reauth' as const, health: null };
    },
    updateConnectedServiceCredentialHealth: vi.fn(async () => {}),
  };
  const onAuthUpdated = vi.fn(async (_update: unknown) => {});
  const coordinator = new ConnectedServiceRefreshCoordinator({
    api: api as unknown as ApiClient,
    credentials,
    machineIdProvider: () => 'synthetic-machine',
    activeServerDir: join(dir, 'server'),
    baseDir: join(dir, 'base'),
    refreshWindowMs: 60_000,
    refreshLeaseMs: 30_000,
    now: () => NOW,
    processEnv,
    onAuthUpdated,
  });
  const bindings = { v: 1, bindingsByServiceId: { [SERVICE_ID]: { source: 'connected', profileId: 'A' } } };
  const auth = await resolveConnectedServiceAuthForSpawn({
    agentId: 'claude',
    credentialRefreshService: coordinator,
    connectedServicesBindingsRaw: bindings,
    materializationKey: 'session',
    activeServerDir: join(dir, 'server'),
    baseDir: join(dir, 'base'),
    credentials,
    api: api as unknown as ApiClient,
    nowMs: () => NOW,
    processEnv,
  } as unknown as Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]);
  coordinator.registerSpawnTarget({
    pid: 11,
    agentId: 'claude',
    sessionId: 'session',
    materializationKey: 'session',
    connectedServicesBindingsRaw: bindings,
    connectedServiceSelectionsEnv: auth!.env,
  } as unknown as Parameters<typeof coordinator.registerSpawnTarget>[0]);
  phase = 'bridge';
  const response = await coordinator.refreshClaudeSubscriptionTokensForBridge({
    sessionId: 'session',
    forceRefresh: true,
    failingAccessTokenFingerprint: computeConnectedServiceAccessTokenFingerprint('synthetic-predecessor-A'),
  });
  const after = await readFile(join(auth!.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8');
  return { response, after, bridgeHealthReads, onAuthUpdated };
}

describe('ConnectedServiceRefreshCoordinator external credential revision health', () => {
  const providerFetch = vi.fn(async () => {
    throw new Error('no provider request is permitted');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    providerFetch.mockClear();
  });

  it('keeps known-health forced adoption of a newer current token, using its read health', async () => {
    vi.stubGlobal('fetch', providerFetch);

    const { response, after, bridgeHealthReads, onAuthUpdated } = await forcedAdoptionUnderReconnectRequiredHealth();

    expect(response.accessToken).toBe('synthetic-current-A');
    expect(bridgeHealthReads).toEqual(['needs_reauth']);
    expect(after).toContain('synthetic-current-A');
    expect(onAuthUpdated).toHaveBeenCalledTimes(1);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  describe.each(['delta', 'registration'] as const)('through the %s reconciler', (producer) => {
    it.each(['not_found', 'unsupported', 'malformed', 'transport', 'missing_reader', 'needs_reauth'] as const)(
      'refuses a projected replacement whose exact health is %s, without acknowledging it',
      async (health) => {
        vi.stubGlobal('fetch', providerFetch);

        const { before, after, outcome, updateHealthReads, onAuthUpdated, retryAfterHealthRecovers } =
          await applyExternalRevision({ producer, health });

        expect(before).toContain('synthetic-current-A');
        expect(after).toBe(before);
        expect(outcome.kind).toBe('refused');
        if (outcome.kind === 'refused') {
          expect(outcome.error).toBeInstanceOf(ConnectedServiceExternalCredentialUpdateRefusedError);
          expect((outcome.error as ConnectedServiceExternalCredentialUpdateRefusedError).failures[0]?.diagnostic.code)
            .toBe(health === 'needs_reauth'
              ? 'connected_service_credential_health_reconnect_required'
              : 'connected_service_credential_health_unavailable');
        }
        if (health !== 'missing_reader') expect(updateHealthReads).toEqual([health]);
        expect(onAuthUpdated).not.toHaveBeenCalled();
        expect(providerFetch).not.toHaveBeenCalled();

        // The refusal left the revision unapplied, so the same projection applies once health recovers.
        const retry = await retryAfterHealthRecovers();
        expect(retry.result.appliedBindingCount).toBe(1);
        expect(retry.after).toContain('synthetic-replacement-A');
        expect(onAuthUpdated).toHaveBeenCalledTimes(1);
      },
    );

    it('applies a projected replacement after reading connected health', async () => {
      vi.stubGlobal('fetch', providerFetch);

      const { after, outcome, updateHealthReads, onAuthUpdated } = await applyExternalRevision({ producer, health: 'connected' });

      expect(updateHealthReads).toEqual(['connected']);
      expect(outcome.kind).toBe('applied');
      if (outcome.kind === 'applied') {
        expect(outcome.result.appliedBindingCount).toBe(1);
        if (producer === 'delta') expect(outcome.result).toMatchObject({ acknowledgeable: true });
      }
      expect(after).toContain('synthetic-replacement-A');
      expect(onAuthUpdated).toHaveBeenCalledTimes(1);
      expect(onAuthUpdated.mock.calls[0]![0]).toMatchObject({ mutation: 'replaced', trigger: 'reconnect_propagation' });
      expect(providerFetch).not.toHaveBeenCalled();
    });

    it('still propagates a deleted credential without reading health', async () => {
      vi.stubGlobal('fetch', providerFetch);

      const { before, after, outcome, updateHealthReads, onAuthUpdated } =
        await applyExternalRevision({ producer, health: 'needs_reauth', boundary: 'absent' });

      expect(outcome.kind).toBe('applied');
      expect(updateHealthReads).toEqual([]);
      expect(after).toBe(before);
      expect(onAuthUpdated).toHaveBeenCalledTimes(1);
      expect(onAuthUpdated.mock.calls[0]![0]).toMatchObject({ mutation: 'deleted', credentialRevision: null });
      expect(providerFetch).not.toHaveBeenCalled();
    });
  });
});
