import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import {
  OPEN_CODE_BROKER_PLUGIN_VERSION,
  OPEN_CODE_BROKER_SELECTIONS_ENV,
  buildOpenCodeBrokerMarker,
  parseOpenCodeBrokerSelections,
} from '@/backends/opencode/brokerPlugin';

import { createOpenCodeConnectedServicesMaterializer } from './createOpenCodeConnectedServicesMaterializer';

describe('createOpenCodeConnectedServicesMaterializer', () => {
  it('brokers the SELECTED Claude subscription group profile (Bearer broker, not x-api-key)', async () => {
    const now = Date.now();
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-opencode-active-server-'));
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-opencode-base-'));
    const rootDir = join(baseDir, 'launch', 'opencode');
    const defaultProfile = buildConnectedServiceCredentialRecord({
      now, serviceId: 'claude-subscription', profileId: 'default-profile', kind: 'token',
      token: { token: 'sk-ant-oat01-default', providerAccountId: null, providerEmail: null },
    });
    const selectedProfile = buildConnectedServiceCredentialRecord({
      now, serviceId: 'claude-subscription', profileId: 'selected-profile', kind: 'token',
      token: { token: 'sk-ant-oat01-selected', providerAccountId: null, providerEmail: null },
    });
    const materializer = createOpenCodeConnectedServicesMaterializer();

    const result = await materializer({
      nativeSourceAuthority: 'caller_env',
      agentId: 'opencode',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', defaultProfile]]),
      selectionsByServiceId: new Map([[
        'claude-subscription',
        { kind: 'group', serviceId: 'claude-subscription', groupId: 'team-claude', activeProfileId: 'selected-profile', fallbackProfileId: 'fallback-profile', generation: 3, record: selectedProfile, policy: { v: 1, strategy: 'priority' } },
      ]]),
      cleanupRoot: async () => {},
    });

    expect(JSON.parse(result?.env.OPENCODE_AUTH_CONTENT ?? '{}')).toEqual({
      anthropic: { type: 'api', key: buildOpenCodeBrokerMarker('anthropic', OPEN_CODE_BROKER_PLUGIN_VERSION) },
    });
    // The selected profile (not the default) drives the broker refresh selection.
    expect(parseOpenCodeBrokerSelections(result?.env[OPEN_CODE_BROKER_SELECTIONS_ENV]).anthropic).toMatchObject({
      serviceId: 'claude-subscription',
      profileId: 'selected-profile',
    });
    expect(JSON.stringify(result?.env)).not.toContain('sk-ant-oat01-selected');
    expect(result?.env.XDG_DATA_HOME).toBeUndefined();
  });

  it('brokers Claude subscription setup tokens through the broker (NOT a raw x-api-key)', async () => {
    const now = Date.now();
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-opencode-active-server-'));
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-opencode-base-'));
    const rootDir = join(baseDir, 'launch', 'opencode');
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now, serviceId: 'claude-subscription', profileId: 'claude-pro', kind: 'token',
      token: { token: 'sk-ant-oat01-pro', providerAccountId: null, providerEmail: null },
    });
    const materializer = createOpenCodeConnectedServicesMaterializer();

    const result = await materializer({
      nativeSourceAuthority: 'caller_env',
      agentId: 'opencode',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', claudeSubscription]]),
      selectionsByServiceId: new Map(),
      cleanupRoot: async () => {},
    });

    expect(JSON.parse(result?.env.OPENCODE_AUTH_CONTENT ?? '{}')).toEqual({
      anthropic: { type: 'api', key: buildOpenCodeBrokerMarker('anthropic', OPEN_CODE_BROKER_PLUGIN_VERSION) },
    });
    expect(JSON.stringify(result?.env)).not.toContain('sk-ant-oat01-pro');
    expect(result?.env.XDG_DATA_HOME).toBeUndefined();
  });

  it('accepts and brokers Claude subscription OAuth (UNBLOCKED per user decision)', async () => {
    const now = Date.now();
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-opencode-active-server-'));
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-opencode-base-'));
    const rootDir = join(baseDir, 'launch', 'opencode');
    const claudeSubscription = buildConnectedServiceCredentialRecord({
      now, serviceId: 'claude-subscription', profileId: 'claude-oauth', kind: 'oauth', expiresAt: now + 60_000,
      oauth: { accessToken: 'claude-access', refreshToken: 'claude-refresh', idToken: null, scope: null, tokenType: null, providerAccountId: 'claude-account', providerEmail: 'claude@example.com' },
    });
    const materializer = createOpenCodeConnectedServicesMaterializer();

    const result = await materializer({
      nativeSourceAuthority: 'caller_env',
      agentId: 'opencode',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', claudeSubscription]]),
      selectionsByServiceId: new Map(),
      cleanupRoot: async () => {},
    });

    expect(JSON.parse(result?.env.OPENCODE_AUTH_CONTENT ?? '{}')).toEqual({
      anthropic: { type: 'api', key: buildOpenCodeBrokerMarker('anthropic', OPEN_CODE_BROKER_PLUGIN_VERSION) },
    });
    expect(JSON.stringify(result?.env)).not.toContain('claude-refresh');
  });
});
