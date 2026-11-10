import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AxiosError } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildConnectedServiceCredentialRecord,
  ConnectedServiceAuthGroupPolicyV1Schema,
} from '@happier-dev/protocol';

import type { ApiClient } from '@/api/api';
import { ConnectedServiceCredentialHealthReadUnavailableError } from '@/api/connectedServices/connectedServiceCredentialApi';
import type { Credentials } from '@/persistence';

import { resolveConnectedServiceAuthForSpawn } from '../resolveConnectedServiceAuthForSpawn';
import { ConnectedServiceRefreshCoordinator } from './ConnectedServiceRefreshCoordinator';
import { computeConnectedServiceAccessTokenFingerprint } from './credentialFreshness/tokenFingerprint';

const NOW = 2_000_000_000_000;
const SERVICE_ID = 'claude-subscription' as const;
const credentials = {
  token: 'synthetic',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
} satisfies Credentials;

type BHealth =
  | 'connected'
  | 'needs_reauth'
  | 'not_found'
  | 'unsupported'
  | 'malformed'
  | 'transport'
  | 'missing_reader';

async function readBHealth(mode: BHealth) {
  switch (mode) {
    case 'connected': return { kind: 'found' as const, status: 'connected' as const, health: null };
    case 'needs_reauth': return { kind: 'found' as const, status: 'needs_reauth' as const, health: null };
    case 'not_found': return { kind: 'not_found' as const };
    case 'unsupported': throw new ConnectedServiceCredentialHealthReadUnavailableError(SERVICE_ID, 'B');
    case 'malformed': throw new Error('Invalid connected service credential health response');
    case 'transport': throw new AxiosError('socket hang up', 'ECONNRESET');
    case 'missing_reader': throw new Error('unreachable: the reader is removed before B is read');
  }
}

/**
 * Real public spawn resolver, then the real refresh coordinator's forced bridge retry. The session
 * is spawned on group member A; the server's canonical group then advances to member B, so
 * distribution canonicalizes the registered target from A to B before rematerializing it. A's
 * exact health is connected throughout; only B's varies. Server state and HTTP are synthetic.
 */
async function forcedRetryAfterCanonicalAdvance(params: Readonly<{
  bShape: 'token' | 'oauth';
  bHealth: BHealth;
  advanceGroup?: boolean;
}>) {
  const dir = await mkdtemp(join(tmpdir(), 'happier-canonical-rematerialization-health-'));
  const source = join(dir, 'source');
  await mkdir(source, { recursive: true });
  const processEnv = { HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: source };
  let active: 'A' | 'B' = 'A';
  let generation = 1;
  let phase: 'spawn' | 'refresh' = 'spawn';
  const bHealthReads: string[] = [];
  const record = (profileId: 'A' | 'B') => profileId === 'B' && params.bShape === 'token'
    ? buildConnectedServiceCredentialRecord({
        now: NOW,
        serviceId: SERVICE_ID,
        profileId,
        kind: 'token',
        token: { token: 'synthetic-B-setup', providerAccountId: 'B', providerEmail: null },
      })
    : buildConnectedServiceCredentialRecord({
        now: NOW,
        serviceId: SERVICE_ID,
        profileId,
        kind: 'oauth',
        expiresAt: NOW + 3_600_000,
        oauth: {
          accessToken: `synthetic-current-${profileId}`,
          refreshToken: `synthetic-refresh-${profileId}`,
          idToken: null,
          scope: 'user:inference user:profile user:sessions:claude_code',
          tokenType: 'Bearer',
          providerAccountId: profileId,
          providerEmail: null,
        },
      });
  const group = () => ({
    v: 1,
    serviceId: SERVICE_ID,
    groupId: 'g',
    displayName: null,
    activeProfileId: active,
    generation,
    runtimeStateRevision: 0,
    policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({ autoSwitch: true, strategy: 'priority' }),
    state: { v: 1 },
    members: (['A', 'B'] as const).map((profileId, index) => ({
      v: 1, serviceId: SERVICE_ID, groupId: 'g', profileId, priority: index + 1, enabled: true,
      state: { v: 1 }, createdAt: 1, updatedAt: 1,
    })),
    createdAt: 1,
    updatedAt: 1,
  });
  const updateHealth = vi.fn(async () => {});
  const api: Record<string, unknown> = {
    getAccountEncryptionMode: async () => 'plain',
    getConnectedServiceCredentialPlain: async (input: { profileId: 'A' | 'B' }) => ({
      content: { t: 'plain', v: record(input.profileId) },
    }),
    readConnectedServiceCredentialHealth: async (input: { profileId: string }) => {
      if (input.profileId === 'A') {
        // A's health is read as connected by the bridge; the reader then disappears for B.
        if (params.bHealth === 'missing_reader' && phase === 'refresh') delete api.readConnectedServiceCredentialHealth;
        return { kind: 'found' as const, status: 'connected' as const, health: null };
      }
      bHealthReads.push(phase);
      return await readBHealth(params.bHealth);
    },
    getConnectedServiceAuthGroup: async () => group(),
    updateConnectedServiceCredentialHealth: updateHealth,
  };
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
  });
  const bindings = {
    v: 1,
    bindingsByServiceId: { [SERVICE_ID]: { source: 'connected', selection: 'group', groupId: 'g', profileId: 'A' } },
  };
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

  if (params.advanceGroup !== false) {
    active = 'B';
    generation = 2;
  }
  phase = 'refresh';
  const outcome = await coordinator.refreshClaudeSubscriptionTokensForBridge({
    sessionId: 'session',
    forceRefresh: true,
    failingAccessTokenFingerprint: computeConnectedServiceAccessTokenFingerprint('synthetic-predecessor-A'),
  }).then(
    (response) => ({ kind: 'returned' as const, response }),
    (error: unknown) => ({ kind: 'refused' as const, error }),
  );
  const after = await readFile(targetFile, 'utf8');
  return { before, after, outcome, bHealthReads, updateHealth };
}

describe('ConnectedServiceRefreshCoordinator canonical group rematerialization health', () => {
  const providerFetch = vi.fn(async () => {
    throw new Error('no provider request is permitted');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    providerFetch.mockClear();
  });

  it.each(['not_found', 'unsupported', 'malformed', 'transport', 'missing_reader', 'needs_reauth'] as const)(
    'does not write a newly canonical setup-token member whose exact health is %s',
    async (bHealth) => {
      vi.stubGlobal('fetch', providerFetch);

      const { before, after, outcome, bHealthReads } = await forcedRetryAfterCanonicalAdvance({ bShape: 'token', bHealth });

      expect(before).toContain('synthetic-current-A');
      expect(after).not.toContain('synthetic-B-setup');
      expect(after).toBe(before);
      if (bHealth !== 'missing_reader') expect(bHealthReads).toEqual(['refresh']);
      // The forced adoption returns only the already-checked current A token, never B's.
      if (outcome.kind === 'returned') expect(JSON.stringify(outcome.response)).not.toContain('synthetic-B-setup');
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it('writes a newly canonical setup-token member whose exact health is connected', async () => {
    vi.stubGlobal('fetch', providerFetch);

    const { after, bHealthReads } = await forcedRetryAfterCanonicalAdvance({ bShape: 'token', bHealth: 'connected' });

    expect(bHealthReads).toEqual(['refresh']);
    expect(after).toContain('synthetic-B-setup');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([
    { bHealth: 'connected' as const, written: true },
    { bHealth: 'needs_reauth' as const, written: false },
  ])('gates a newly canonical OAuth member on its exact health ($bHealth)', async ({ bHealth, written }) => {
    vi.stubGlobal('fetch', providerFetch);

    const { after } = await forcedRetryAfterCanonicalAdvance({ bShape: 'oauth', bHealth });

    expect(after.includes('synthetic-current-B')).toBe(written);
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it('keeps forced predecessor adoption of the unchanged current member without reading another health', async () => {
    vi.stubGlobal('fetch', providerFetch);

    const { after, outcome, bHealthReads } = await forcedRetryAfterCanonicalAdvance({
      bShape: 'token',
      bHealth: 'not_found',
      advanceGroup: false,
    });

    expect(outcome.kind).toBe('returned');
    expect(after).toContain('synthetic-current-A');
    expect(bHealthReads).toEqual([]);
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
