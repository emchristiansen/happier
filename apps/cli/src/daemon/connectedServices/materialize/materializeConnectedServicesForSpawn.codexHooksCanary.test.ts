import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';
import { parse } from 'smol-toml';
import { expect, it } from 'vitest';

import { logger } from '@/ui/logger';

import { readConnectedServiceStateSharingManifest } from '../stateSharing/connectedServiceStateSharingManifest';
import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import { resolveConnectedServiceMaterializedRootDir } from './resolveConnectedServiceMaterializedRootDir';

const firstHooks = '{"hooks":{"Stop":[]}}\n';
const secondHooks = '{"hooks":{"SessionStart":[]}}\n';

it('reports malformed native TOML without exposing config content or replacing the promoted home', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-invalid-config-'));
  try {
    const sourceHome = join(root, 'native');
    await mkdir(sourceHome, { recursive: true });
    await writeFile(join(sourceHome, 'config.toml'), 'model = "fixture"\n');
    await writeFile(join(sourceHome, 'hooks.json'), firstHooks);
    const record = buildConnectedServiceCredentialRecord({
      now: 10, serviceId: 'openai-codex', profileId: 'synthetic', kind: 'oauth', expiresAt: null,
      oauth: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: 'synthetic-id',
        scope: null, tokenType: null, providerAccountId: 'synthetic-account', providerEmail: null },
    });
    const materialize = async () => await materializeConnectedServicesForSpawn({
      agentId: 'codex', materializationKey: 'invalid-config', activeServerDir: join(root, 'server'), baseDir: join(root, 'profiles'),
      recordsByServiceId: new Map([['openai-codex', record]]),
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'linked', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
      } },
      processEnv: { CODEX_HOME: sourceHome, HOME: root },
    });
    const first = await materialize();
    const home = first!.env.CODEX_HOME!;
    const invalidPath = join(sourceHome, 'config.toml');
    const malformed = 'fixture_secret = "synthetic-sensitive-config"\n[broken\n';
    await writeFile(invalidPath, malformed);
    const priorConfig = await readFile(join(home, 'config.toml'), 'utf8');
    const error = await materialize().then(() => null, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    const reported = inspect(error, { depth: 5 });
    expect(reported).toContain(invalidPath);
    expect(reported).toMatch(/line \d+, column \d+/);
    expect(reported).toContain('TomlError');
    expect(reported).not.toContain('synthetic-sensitive-config');
    await expect(readFile(join(home, 'config.toml'), 'utf8')).resolves.toBe(priorConfig);
    await expect(readFile(join(home, 'hooks.json'), 'utf8')).resolves.toBe(firstHooks);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([true, false])('rebuilds malformed profile TOML and permits later spawns when native config exists: %s', async (nativeConfigExists) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-profile-recovery-'));
  try {
    const sourceHome = join(root, 'native');
    await mkdir(sourceHome, { recursive: true });
    if (nativeConfigExists) await writeFile(join(sourceHome, 'config.toml'), 'model = "native"\n');
    await writeFile(join(sourceHome, 'hooks.json'), firstHooks);
    const record = buildConnectedServiceCredentialRecord({
      now: 10, serviceId: 'openai-codex', profileId: 'synthetic', kind: 'oauth', expiresAt: null,
      oauth: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', idToken: 'synthetic-id',
        scope: null, tokenType: null, providerAccountId: 'synthetic-account', providerEmail: null },
    });
    const materialize = () => materializeConnectedServicesForSpawn({
      agentId: 'codex', materializationKey: 'profile-recovery', activeServerDir: join(root, 'server'), baseDir: join(root, 'profiles'),
      recordsByServiceId: new Map([['openai-codex', record]]),
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: {
        v: 1, defaults: { configMode: 'linked', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
      } },
      processEnv: { CODEX_HOME: sourceHome, HOME: root },
    });
    const first = await materialize();
    const home = first!.env.CODEX_HOME!;
    const configPath = join(home, 'config.toml');
    await writeFile(configPath, 'fixture_secret = "synthetic-sensitive-config"\n[broken\n');

    const recovered = await materialize();
    expect(recovered?.env.CODEX_HOME).toBe(home);
    const rebuilt = parse(await readFile(configPath, 'utf8'));
    expect(rebuilt.cli_auth_credentials_store).toBe('file');
    expect(rebuilt.model).toBe(nativeConfigExists ? 'native' : undefined);
    expect(rebuilt.fixture_secret).toBeUndefined();
    logger.flushSync();
    const diagnostic = await readFile(logger.getLogPath(), 'utf8');
    expect(diagnostic).toContain(configPath);
    expect(diagnostic).toMatch(/line \d+, column \d+/);
    expect(diagnostic).not.toContain('synthetic-sensitive-config');
    await expect(readFile(join(home, 'hooks.json'), 'utf8')).resolves.toBe(firstHooks);

    const hookId = `${join(home, 'hooks.json')}:stop:0:0`;
    const trustedHash = `sha256:${'b'.repeat(64)}`;
    await writeFile(configPath, `${await readFile(configPath, 'utf8')}\n[hooks.state.${JSON.stringify(hookId)}]\nenabled = false\ntrusted_hash = "${trustedHash}"\n`);
    expect((await materialize())?.env.CODEX_HOME).toBe(home);
    expect(parse(await readFile(configPath, 'utf8'))).toMatchObject({
      cli_auth_credentials_store: 'file',
      hooks: { state: { [hookId]: { enabled: false, trusted_hash: trustedHash } } },
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('migrates linked hooks and preserves profile hook state through repeated staged materialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-codex-hooks-canary-'));
  const sourceHome = join(root, 'source-codex-home');
  const baseDir = join(root, 'materialized');
  const activeServerDir = join(root, 'server');
  const materializationKey = 'synthetic-codex-hooks-canary';
  const materializationRoot = resolveConnectedServiceMaterializedRootDir({
    baseDir,
    agentId: 'codex',
    materializationKey,
  });
  const targetHome = join(materializationRoot, 'codex-home');
  const sourceHooksPath = join(sourceHome, 'hooks.json');
  const targetHooksPath = join(targetHome, 'hooks.json');
  const record = buildConnectedServiceCredentialRecord({
    now: 10,
    serviceId: 'openai-codex',
    profileId: 'synthetic',
    kind: 'oauth',
    expiresAt: null,
    oauth: {
      accessToken: 'synthetic-access',
      refreshToken: 'synthetic-refresh',
      idToken: 'synthetic-id',
      scope: null,
      tokenType: null,
      providerAccountId: 'synthetic-account',
      providerEmail: null,
    },
  });

  try {
    await mkdir(sourceHome, { recursive: true });
    await mkdir(targetHome, { recursive: true });
    await mkdir(activeServerDir, { recursive: true });
    await writeFile(sourceHooksPath, firstHooks);
    await symlink(sourceHooksPath, targetHooksPath, 'file');
    await writeFile(join(targetHome, '.happier-state-sharing.json'), JSON.stringify({
      v: 1,
      requestedStateMode: 'isolated',
      effectiveStateMode: 'isolated',
      configEntries: ['hooks.json'],
      stateEntries: [],
    }));
    expect((await lstat(targetHooksPath)).isSymbolicLink()).toBe(true);

    const accountSettings = {
      connectedServicesProviderStateSharingSettingsV1: {
        v: 1,
        defaults: { configMode: 'linked', stateMode: 'isolated' },
        byAgentId: { codex: { configMode: 'linked', stateMode: 'isolated' } },
        acknowledgedRisksByAgentId: {},
      },
    };
    const materialize = async () => await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey,
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      accountSettings,
      processEnv: { CODEX_HOME: sourceHome, HOME: root },
    });
    const first = await materialize();
    expect(first?.env.CODEX_HOME).toBe(targetHome);
    expect((await lstat(targetHooksPath)).isFile()).toBe(true);
    expect((await lstat(targetHooksPath)).isSymbolicLink()).toBe(false);
    await expect(readFile(targetHooksPath, 'utf8')).resolves.toBe(firstHooks);
    expect((await readConnectedServiceStateSharingManifest(targetHome)).configEntries).toContain('hooks.json');
    const hookId = `${targetHooksPath}:stop:0:0`;
    const trustedHash = `sha256:${'a'.repeat(64)}`;
    await writeFile(join(targetHome, 'config.toml'),
      `[hooks.state.${JSON.stringify(hookId)}]\nenabled = false\ntrusted_hash = "${trustedHash}"\n`);

    await writeFile(sourceHooksPath, secondHooks);
    await expect(readFile(targetHooksPath, 'utf8')).resolves.toBe(firstHooks);
    const second = await materialize();
    expect(second?.env.CODEX_HOME).toBe(targetHome);
    expect((await lstat(targetHooksPath)).isFile()).toBe(true);
    expect((await lstat(targetHooksPath)).isSymbolicLink()).toBe(false);
    await expect(readFile(targetHooksPath, 'utf8')).resolves.toBe(secondHooks);
    const config = parse(await readFile(join(targetHome, 'config.toml'), 'utf8'));
    expect(config).toMatchObject({
      cli_auth_credentials_store: 'file',
      hooks: { state: { [hookId]: { enabled: false, trusted_hash: trustedHash } } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
