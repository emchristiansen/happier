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

import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from './accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { ConnectedServiceRefreshCoordinator } from './refresh/ConnectedServiceRefreshCoordinator';
import { resolveConnectedServiceAuthForSpawn } from './resolveConnectedServiceAuthForSpawn';
import { createDaemonConnectedServiceAuthGroupSwitchCoordinator } from './runtimeAuth/createDaemonConnectedServiceAuthGroupSwitchCoordinator';

const NOW = 2_000_000_000_000;
const SERVICE_ID = 'claude-subscription' as const;
const credentials = {
  token: 'synthetic',
  encryption: { type: 'legacy', secret: new Uint8Array(32).fill(3) },
} satisfies Credentials;

type HealthMode =
  | 'connected'
  | 'not_found'
  | 'unsupported'
  | 'malformed'
  | 'transport'
  | 'missing_reader';

function memberRecord(profileId: 'A' | 'B', shape: 'oauth' | 'token') {
  if (profileId === 'B' && shape === 'token') {
    return buildConnectedServiceCredentialRecord({
      now: NOW,
      serviceId: SERVICE_ID,
      profileId,
      kind: 'token',
      token: { token: 'synthetic-setup-B', providerAccountId: 'synthetic-B', providerEmail: null },
    });
  }
  return buildConnectedServiceCredentialRecord({
    now: NOW,
    serviceId: SERVICE_ID,
    profileId,
    kind: 'oauth',
    expiresAt: NOW + 3_600_000,
    oauth: {
      accessToken: `synthetic-${profileId}`,
      refreshToken: `synthetic-refresh-${profileId}`,
      idToken: null,
      // A lacks the Claude Code scope, so its real materializer refuses and the group moves to B.
      scope: profileId === 'A' ? 'user:inference' : 'user:inference user:profile user:sessions:claude_code',
      tokenType: 'Bearer',
      providerAccountId: `synthetic-${profileId}`,
      providerEmail: null,
    },
  });
}

async function readBHealth(mode: HealthMode) {
  switch (mode) {
    case 'connected': return { kind: 'found' as const, status: 'connected' as const, health: null };
    case 'not_found': return { kind: 'not_found' as const };
    case 'unsupported': throw new ConnectedServiceCredentialHealthReadUnavailableError(SERVICE_ID, 'B');
    case 'malformed': throw new Error('Invalid connected service credential health response');
    case 'transport': throw new AxiosError('socket hang up', 'ECONNRESET');
    case 'missing_reader': throw new Error('unreachable: the reader is removed before B is read');
  }
}

/**
 * Real spawn resolver, group-switch coordinator and refresh coordinator. Member A passes health but
 * its real Claude materializer refuses; recording that failure makes B the group's authoritative
 * active member, and the retry then materializes B. Server storage and the provider are synthetic.
 */
async function resolveAfterGroupRetry(shape: 'oauth' | 'token', mode: HealthMode) {
  const dir = await mkdtemp(join(tmpdir(), 'happier-spawn-group-retry-health-'));
  const permittedSource = join(dir, 'permitted-source');
  await mkdir(permittedSource, { recursive: true });
  const processEnv = { HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: permittedSource };
  let active: 'A' | 'B' = 'A';
  let generation = 1;
  const healthReads: string[] = [];
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
  const api: Record<string, unknown> = {
    getConnectedServiceAuthGroup: async () => group(),
    getAccountEncryptionMode: async () => 'plain',
    getConnectedServiceCredentialPlain: async (input: { profileId: 'A' | 'B' }) => ({
      content: { t: 'plain', v: memberRecord(input.profileId, shape) },
    }),
    readConnectedServiceCredentialHealth: async (input: { profileId: string }) => {
      healthReads.push(input.profileId);
      if (input.profileId === 'A') return { kind: 'found' as const, status: 'connected' as const, health: null };
      return await readBHealth(mode);
    },
    updateConnectedServiceCredentialHealth: async () => {
      // Recording A's materialization failure makes B authoritative.
      active = 'B';
      generation = 2;
      if (mode === 'missing_reader') delete api.readConnectedServiceCredentialHealth;
    },
    updateConnectedServiceAuthGroupRuntimeState: async () => group(),
    updateConnectedServiceAuthGroupActiveProfile: async () => {
      throw new Error('the authoritative selection is already current');
    },
  };
  const prepareCandidateForSwitch = vi.fn(async () => {
    throw new Error('candidate preparation is not reached for an already-current generation');
  });
  const authGroupSwitchCoordinator = createDaemonConnectedServiceAuthGroupSwitchCoordinator({
    api: api as unknown as ApiClient,
    runtimeQuotaSnapshots: new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore(),
    quotaFreshnessMs: 60_000,
    nowMs: () => NOW,
    resolveCurrentCredentialRevision: async () => null,
    // Production wiring: before a spawn there is no session to restart.
    restartSession: async () => {},
    prepareCandidateForSwitch,
  } as unknown as Parameters<typeof createDaemonConnectedServiceAuthGroupSwitchCoordinator>[0]);
  const credentialRefreshService = new ConnectedServiceRefreshCoordinator({
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

  const outcome = await resolveConnectedServiceAuthForSpawn({
    agentId: 'claude',
    credentialRefreshService,
    connectedServicesBindingsRaw: {
      v: 1,
      bindingsByServiceId: { [SERVICE_ID]: { source: 'connected', selection: 'group', groupId: 'g', profileId: 'A' } },
    },
    materializationKey: 'retry',
    activeServerDir: join(dir, 'server'),
    baseDir: join(dir, 'base'),
    credentials,
    api: api as unknown as ApiClient,
    nowMs: () => NOW,
    processEnv,
    authGroupSwitchCoordinator,
  } as unknown as Parameters<typeof resolveConnectedServiceAuthForSpawn>[0]).then(
    (auth) => ({ kind: 'resolved' as const, auth }),
    (error: unknown) => ({ kind: 'refused' as const, error }),
  );

  const groupCredentialFile = join(
    dir, 'server', 'daemon', 'connected-services', 'homes', SERVICE_ID, '__groups', 'g', 'claude', 'claude-config', '.credentials.json',
  );
  const groupCredential = await readFile(groupCredentialFile, 'utf8').catch(() => null);
  return { outcome, groupCredential, healthReads, prepareCandidateForSwitch };
}

describe('resolveConnectedServiceAuthForSpawn group materialization retry', () => {
  const providerFetch = vi.fn(async () => {
    throw new Error('no provider request is permitted');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    providerFetch.mockClear();
  });

  it.each(['not_found', 'unsupported', 'malformed', 'transport', 'missing_reader'] as const)(
    'refuses a newly selected setup-token member whose exact health is %s, without writing or returning it',
    async (mode) => {
      vi.stubGlobal('fetch', providerFetch);

      const { outcome, groupCredential, healthReads, prepareCandidateForSwitch } = await resolveAfterGroupRetry('token', mode);

      expect(outcome.kind).toBe('refused');
      expect(groupCredential ?? '').not.toContain('synthetic-setup-B');
      if (mode !== 'missing_reader') expect(healthReads).toContain('B');
      expect(prepareCandidateForSwitch).not.toHaveBeenCalled();
      expect(providerFetch).not.toHaveBeenCalled();
    },
  );

  it('materializes a newly selected setup-token member whose exact health is connected', async () => {
    vi.stubGlobal('fetch', providerFetch);

    const { outcome, groupCredential, healthReads } = await resolveAfterGroupRetry('token', 'connected');

    expect(outcome.kind).toBe('resolved');
    expect(healthReads).toContain('B');
    expect(groupCredential).toContain('synthetic-setup-B');
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'connected' as const, expected: 'resolved' as const },
    { mode: 'not_found' as const, expected: 'refused' as const },
  ])('gates a newly selected OAuth member on its exact health ($mode)', async ({ mode, expected }) => {
    vi.stubGlobal('fetch', providerFetch);

    const { outcome, groupCredential } = await resolveAfterGroupRetry('oauth', mode);

    expect(outcome.kind).toBe(expected);
    if (expected === 'resolved') expect(groupCredential).toContain('synthetic-B');
    else expect(groupCredential ?? '').not.toContain('synthetic-B');
    expect(providerFetch).not.toHaveBeenCalled();
  });
});
