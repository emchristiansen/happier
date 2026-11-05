import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  accountSettingsParse,
  deriveAccountMachineKeyFromRecoverySecret,
  deriveSettingsSecretsKeyV1,
  encryptSecretStringV1,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { createExecutableShim } from '@/testkit/fs/executableShim';
import { removeTempDir } from '@/testkit/fs/tempDir';
import { dirname } from 'node:path';
import { parseSessionCreateSpawnOptions } from '@/cli/commands/session/create/parseSessionCreateSpawnOptions';
import { resolveSpawnChildEnvironment } from '@/daemon/spawn/resolveSpawnChildEnvironment';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { normalizeSessionAgentSpawnActionRequest } from './normalizeSessionAgentSpawnActionRequest';

const recoverySecret = new Uint8Array(32).fill(7);
const credentials: Credentials = { token: 'profile-env-fixture', encryption: { type: 'legacy', secret: recoverySecret } };
const profile = {
  id: 'hermes-fixture', name: 'Hermes fixture',
  compatibilityByTargetKey: { 'agent:claude': true },
  environmentVariables: [
    { name: 'PATH', value: '/hermes/bin:/usr/bin' },
    { name: 'HERMES_HOME', value: '${HOME}/hermes' },
    { name: 'HERMES_ROLE', value: 'researcher' },
    { name: 'HERMES_ENDPOINT', value: 'https://hermes.example.test' },
    { name: 'HERMES_PROJECT', value: 'fixture' },
    { name: 'HERMES_TEAM', value: 'team' },
    { name: 'HERMES_IDENTITY', value: 'identity' },
    { name: 'HERMES_CONTEXT', value: 'context' },
    { name: 'HERMES_COMMAND', value: 'hermes inspect' },
    { name: 'HERMES_WORKSPACE', value: '${HOME}/workspace' },
    { name: 'HERMES_EMPTY', value: '' },
    { name: 'HERMES_TEXT', value: '  full\ntext  ' },
  ],
};

function installSettings(extra: Record<string, unknown> = {}) {
  resetInMemoryAccountSettingsContextForTests();
  setActiveAccountSettingsSnapshot({
    source: 'network', settings: accountSettingsParse({ profiles: [profile], ...extra }),
    settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
    scopeKey: resolveAccountSettingsScopeKey(credentials),
  });
}

function normalize(argv: string[]) {
  return normalizeSessionAgentSpawnActionRequest({
    credentials, surface: 'cli',
    input: parseSessionCreateSpawnOptions(['--backend', 'claude', '--path', '/repo', ...argv]).actionInput,
    parentMetadata: null, currentSession: { machineId: 'target-machine' },
    resolveConnectedServicesDefaults: async () => null,
  });
}

describe('session create launch profile environment', () => {
  beforeEach(() => {
    resetInMemoryAccountSettingsContextForTests();
    vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
    installSettings();
  });
  afterEach(() => {
    resetInMemoryAccountSettingsContextForTests();
    vi.unstubAllEnvs();
  });

  it('delivers all profile bindings to the target and expands templates only there', async () => {
    vi.stubEnv('HOME', '/client-home');
    const result = await normalize(['--launch-profile', profile.id, '--env', 'HERMES_ROLE=operator']);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('normalization failed');
    const expected = Object.fromEntries(profile.environmentVariables.map(({ name, value }) => [name, value]));
    expect(result.createParams.environmentVariables).toEqual({ ...expected, HERMES_ROLE: 'operator' });
    const claudeCli = await createExecutableShim({ dirPrefix: 'profile-env-claude-', fileName: 'claude', contents: '#!/bin/sh\nexit 0\n' });
    onTestFinished(() => removeTempDir(dirname(claudeCli)));
    const child = await resolveSpawnChildEnvironment({
      options: {
        directory: result.createParams.directory,
        backendTarget: result.createParams.backendTarget,
        profileId: result.createParams.profileId,
        environmentVariables: result.createParams.environmentVariables,
      },
      profileEnvironmentVariables: result.createParams.environmentVariables ?? {},
      // Built-in spawns are admitted only when the provider CLI resolves (upstream e628d944).
      daemonSpawnHooks: null, processEnv: { HOME: '/target-home', HAPPIER_CLAUDE_PATH: claudeCli },
      logDebug: () => {}, logInfo: () => {}, logWarn: () => {},
    });
    expect(child.ok).toBe(true);
    if (!child.ok) throw new Error('environment assembly failed');
    expect(child.extraEnvForChild).toMatchObject({
      ...expected, HERMES_ROLE: 'operator', HERMES_HOME: '/target-home/hermes',
      HERMES_WORKSPACE: '/target-home/workspace', HAPPIER_SESSION_PROFILE_ID: profile.id,
    });
  });

  it('decrypts saved profile bindings without expanding templates on the client, and lets explicit env win', async () => {
    const encryptedValue = encryptSecretStringV1('synthetic-saved-value',
      deriveSettingsSecretsKeyV1(deriveAccountMachineKeyFromRecoverySecret(recoverySecret)),
      (length) => new Uint8Array(length).fill(3));
    installSettings({
      profiles: [{ ...profile,
        envVarRequirements: [{ name: 'PROVIDER_TOKEN', kind: 'secret', required: true }],
        environmentVariables: [{ name: 'ANTHROPIC_AUTH_TOKEN', value: '${PROVIDER_TOKEN}' }],
      }],
      secrets: [{ id: 'saved', name: 'Fixture', kind: 'apiKey',
        encryptedValue: { _isSecretValue: true, encryptedValue }, createdAt: 0, updatedAt: 0 }],
      secretBindingsByProfileId: { [profile.id]: { PROVIDER_TOKEN: 'saved' } },
    });
    vi.stubEnv('PROVIDER_TOKEN', 'client-value-must-not-travel');
    const saved = await normalize(['--launch-profile', profile.id]);
    expect(saved.ok && saved.createParams.environmentVariables).toEqual({
      ANTHROPIC_AUTH_TOKEN: '${PROVIDER_TOKEN}', PROVIDER_TOKEN: 'synthetic-saved-value',
    });
    const overridden = await normalize(['--launch-profile', profile.id, '--env', 'PROVIDER_TOKEN=explicit']);
    expect(overridden.ok && overridden.createParams.environmentVariables).toEqual({
      ANTHROPIC_AUTH_TOKEN: '${PROVIDER_TOKEN}', PROVIDER_TOKEN: 'explicit',
    });
  });

  it.each(['missing-profile', 'incompatible'])('rejects an unavailable or incompatible selected profile: %s', async (id) => {
    installSettings({ profiles: [{ ...profile, id: 'incompatible', compatibilityByTargetKey: { 'agent:claude': false } }] });
    await expect(normalize(['--launch-profile', id])).rejects.toThrow(/profile/i);
  });

  it('keeps inherited profile identity without reapplying its environment, and leaves profile-free env alone', async () => {
    const inherited = await normalizeSessionAgentSpawnActionRequest({
      credentials, surface: 'cli', input: { path: '/repo', agentId: 'claude' },
      parentMetadata: { profileId: profile.id }, currentSession: { machineId: 'target-machine' },
      resolveConnectedServicesDefaults: async () => null,
    });
    expect(inherited.ok && inherited.createParams.profileId).toBe(profile.id);
    expect(inherited.ok && inherited.createParams.environmentVariables).toBeUndefined();
    const explicit = await normalize(['--env', 'ONLY_EXPLICIT=kept']);
    expect(explicit.ok && explicit.createParams.environmentVariables).toEqual({ ONLY_EXPLICIT: 'kept' });
  });
});
