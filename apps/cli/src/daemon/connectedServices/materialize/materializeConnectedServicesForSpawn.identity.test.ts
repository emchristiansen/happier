import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { materializeConnectedServicesForSpawn } from './materializeConnectedServicesForSpawn';
import { HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY } from '../connectedServiceChildEnvironment';
import { resolveConnectedServiceHomeDir } from '../homes/resolveConnectedServiceHomeDir';

describe('materializeConnectedServicesForSpawn materialization identity', () => {
  it('adopts only the resumed rollout on an isolated account-change without copying unrelated account state', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-codex-account-resume-'));
    const activeServerDir = join(baseDir, 'server');
    const nativeHome = join(baseDir, 'native');
    const previousHome = join(resolveConnectedServiceHomeDir({
      activeServerDir, serviceId: 'openai-codex', profileId: 'old', agentId: 'codex',
    }), 'codex-home');
    await mkdir(join(previousHome, 'sessions'), { recursive: true });
    await mkdir(join(nativeHome, 'sessions'), { recursive: true });
    const vendorResumeId = '11111111-2222-4333-8444-555555555555';
    const rolloutName = `rollout-2026-10-12T10-00-00-${vendorResumeId}.jsonl`;
    await writeFile(join(previousHome, 'sessions', rolloutName), 'private-history\n');
    await writeFile(join(previousHome, 'sessions', 'unrelated.jsonl'), 'unrelated conversation\n');
    await mkdir(join(previousHome, 'archived_sessions'), { recursive: true });
    await writeFile(join(previousHome, 'archived_sessions', 'unrelated.jsonl'), 'unrelated archive\n');
    await mkdir(join(previousHome, 'memories'), { recursive: true });
    await writeFile(join(previousHome, 'memories', 'private.md'), 'unrelated memory\n');
    await writeFile(join(previousHome, 'history.jsonl'), '{"text":"unrelated prompt"}\n');
    await writeFile(join(previousHome, 'auth.json'), 'old-auth');
    await writeFile(join(nativeHome, 'sessions', 'native.jsonl'), 'native-history\n');
    const record = buildConnectedServiceCredentialRecord({
      now: 10, serviceId: 'openai-codex', profileId: 'next', kind: 'oauth', expiresAt: null,
      oauth: { accessToken: 'next-access', refreshToken: 'next-refresh', idToken: 'next-id',
        scope: null, tokenType: null, providerAccountId: 'next-account', providerEmail: null },
    });
    const result = await materializeConnectedServicesForSpawn({
      agentId: 'codex', materializationKey: 'resume-account-change', activeServerDir, baseDir,
      vendorResumeId,
      recordsByServiceId: new Map([['openai-codex', record]]),
      processEnv: { CODEX_HOME: nativeHome, HOME: baseDir },
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: { byAgentId: { codex: { stateMode: 'isolated' } } } },
      existingSessionMetadata: { agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: {
        home: 'connectedService', homePath: previousHome, connectedServiceId: 'openai-codex',
        connectedServiceProfileId: 'old',
      } } },
    });
    await expect(readFile(join(result!.env.CODEX_HOME!, 'sessions', rolloutName), 'utf8')).resolves.toBe('private-history\n');
    for (const path of ['sessions/unrelated.jsonl', 'archived_sessions/unrelated.jsonl', 'memories/private.md', 'history.jsonl']) {
      await expect(stat(join(result!.env.CODEX_HOME!, path))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(stat(join(result!.env.CODEX_HOME!, 'sessions', 'native.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(result!.env.CODEX_HOME!, 'auth.json'), 'utf8')).resolves.toContain('next-access');
    await expect(readFile(join(previousHome, 'sessions', rolloutName), 'utf8')).resolves.toBe('private-history\n');
    await expect(readFile(join(previousHome, 'memories', 'private.md'), 'utf8')).resolves.toBe('unrelated memory\n');
    const fresh = await materializeConnectedServicesForSpawn({
      agentId: 'codex', materializationKey: 'fresh-account-change', activeServerDir, baseDir,
      recordsByServiceId: new Map([['openai-codex', { ...record, profileId: 'fresh' }]]),
      processEnv: { CODEX_HOME: nativeHome, HOME: baseDir },
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: { byAgentId: { codex: { stateMode: 'isolated' } } } },
      existingSessionMetadata: { agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: {
        home: 'connectedService', homePath: previousHome, connectedServiceId: 'openai-codex', connectedServiceProfileId: 'old',
      } } },
    });
    await expect(stat(join(fresh!.env.CODEX_HOME!, 'sessions', rolloutName))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(fresh!.env.CODEX_HOME!, 'memories', 'private.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await materializeConnectedServicesForSpawn({
      agentId: 'codex', materializationKey: 'reject-native-state-hint', activeServerDir, baseDir,
      recordsByServiceId: new Map([['openai-codex', record]]),
      processEnv: { CODEX_HOME: nativeHome, HOME: baseDir },
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: { byAgentId: { codex: { stateMode: 'isolated' } } } },
      existingSessionMetadata: { agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: {
        home: 'connectedService', homePath: nativeHome, connectedServiceId: 'openai-codex', connectedServiceProfileId: 'old',
      } } },
    });
    await expect(stat(join(result!.env.CODEX_HOME!, 'sessions', 'native.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('keeps Claude discovery in a disposable home rather than the selected durable account home', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-claude-probe-'));
    const activeServerDir = join(baseDir, 'server');
    const record = buildConnectedServiceCredentialRecord({
      now: 10, serviceId: 'anthropic', profileId: 'work', kind: 'token',
      token: { token: 'sk-ant-test', providerAccountId: null, providerEmail: null },
    });
    const probeParams = { materializationPurpose: 'probe' as const,
      connectedServiceMaterializationIdentityV1: { v: 1 as const, id: 'csm_claude_probe', createdAtMs: 1 },
      agentId: 'claude' as const, materializationKey: 'probe', activeServerDir, baseDir,
      recordsByServiceId: new Map([['anthropic' as const, record]]), processEnv: { HOME: baseDir },
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: { byAgentId: { claude: { stateMode: 'isolated' as const } } } },
    };
    const probe = await materializeConnectedServicesForSpawn(probeParams);
    expect(probe!.env.CLAUDE_CONFIG_DIR).toBe(join(baseDir, 'csm_claude_probe', 'claude', 'claude-config'));
    expect(probe!.materializationRoot).toBe(join(baseDir, 'csm_claude_probe', 'claude'));
    probe!.cleanupMaterializationRoot();
  });
  it('uses the stable materialization identity instead of the transient spawn key for provider-local auth homes', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-identity-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-identity-'));
    const record = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'anthropic',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'sk-ant-test',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const identity = {
      v: 1,
      id: 'csm_stable_pi_1',
      createdAtMs: 123,
    } as const;
    const params = {
      agentId: 'pi',
      materializationKey: 'spawn-transient-1',
      connectedServiceMaterializationIdentityV1: identity,
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['anthropic', record]]),
    } satisfies Parameters<typeof materializeConnectedServicesForSpawn>[0] & {
      connectedServiceMaterializationIdentityV1: typeof identity;
    };

    const result = await materializeConnectedServicesForSpawn(params);

    expect(result).not.toBeNull();
    expect(result!.env.PI_CODING_AGENT_DIR).toBe(
      join(baseDir, identity.id, 'pi', 'pi-agent-dir'),
    );
    await expect(readFile(join(result!.env.PI_CODING_AGENT_DIR, 'auth.json'), 'utf8')).resolves.toContain('sk-ant-test');
  });

  it('reuses the account home across Codex sessions and never releases durable state with session cleanup', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-codex-identity-'));
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-connected-services-server-codex-identity-'));
    const sourceCodexHome = await mkdtemp(join(tmpdir(), 'happier-source-codex-home-codex-identity-'));
    await writeFile(join(sourceCodexHome, 'config.toml'), 'model = "gpt-5.2-codex"\n');
    await mkdir(join(sourceCodexHome, 'sessions'), { recursive: true });
    await writeFile(join(sourceCodexHome, 'sessions', 'rollout-source.jsonl'), '{}\n');

    const firstRecord = buildConnectedServiceCredentialRecord({
      now: 10,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access-one',
        refreshToken: 'refresh-one',
        idToken: 'id-one',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });
    const secondRecord = buildConnectedServiceCredentialRecord({
      now: 20,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      expiresAt: null,
      oauth: {
        accessToken: 'access-two',
        refreshToken: 'refresh-two',
        idToken: 'id-two',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
    });

    const firstIdentity = { v: 1, id: 'csm_codex_one', createdAtMs: 1 } as const;
    const secondIdentity = { v: 1, id: 'csm_codex_two', createdAtMs: 2 } as const;

    let releaseFirst: (() => Promise<void>) | undefined;
    const first = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'transient-one',
      connectedServiceMaterializationIdentityV1: firstIdentity,
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', firstRecord]]),
      onCleanup: (cleanup) => { releaseFirst = cleanup; },
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        HOME: tmpdir(),
      },
    });
    const second = await materializeConnectedServicesForSpawn({
      agentId: 'codex',
      materializationKey: 'transient-two',
      connectedServiceMaterializationIdentityV1: secondIdentity,
      activeServerDir,
      baseDir,
      recordsByServiceId: new Map([['openai-codex', secondRecord]]),
      processEnv: {
        CODEX_HOME: sourceCodexHome,
        HOME: tmpdir(),
      },
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    const accountRoot = resolveConnectedServiceHomeDir({ activeServerDir, serviceId: 'openai-codex', profileId: 'work', agentId: 'codex' });
    expect(first!.env.CODEX_HOME).toBe(join(accountRoot, 'codex-home'));
    expect(second!.env.CODEX_HOME).toBe(first!.env.CODEX_HOME);
    expect(first!.materializationRoot).toBe(accountRoot);
    expect(second!.materializationRoot).toBe(accountRoot);
    expect(first!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(
      accountRoot,
    );
    expect(second!.env[HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT_ENV_KEY]).toBe(
      accountRoot,
    );

    const firstAuth = JSON.parse(await readFile(join(first!.env.CODEX_HOME!, 'auth.json'), 'utf8'));
    const secondAuth = JSON.parse(await readFile(join(second!.env.CODEX_HOME!, 'auth.json'), 'utf8'));
    expect(firstAuth.refresh_token).toBe('refresh-two');
    expect(secondAuth.refresh_token).toBe('refresh-two');
    await expect(readFile(join(first!.env.CODEX_HOME!, 'sessions', 'rollout-source.jsonl'), 'utf8')).resolves.toBe('{}\n');
    await expect(readFile(join(second!.env.CODEX_HOME!, 'sessions', 'rollout-source.jsonl'), 'utf8')).resolves.toBe('{}\n');
    await writeFile(join(first!.env.CODEX_HOME!, 'private-provider-state'), 'keep');
    first!.cleanupMaterializationRoot();
    await releaseFirst?.();
    await expect(readFile(join(second!.env.CODEX_HOME!, 'private-provider-state'), 'utf8')).resolves.toBe('keep');
    const probe = await materializeConnectedServicesForSpawn({
      ...paramsForProbe(secondRecord),
      activeServerDir,
      baseDir,
      processEnv: { CODEX_HOME: sourceCodexHome, HOME: tmpdir() },
    });
    expect(probe!.env.CODEX_HOME).not.toBe(second!.env.CODEX_HOME);
    await expect(stat(join(probe!.env.CODEX_HOME!, 'sessions', 'rollout-source.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' });
    probe!.cleanupMaterializationRoot();
    await expect(readFile(join(second!.env.CODEX_HOME!, 'private-provider-state'), 'utf8')).resolves.toBe('keep');

    if (secondRecord.kind !== 'oauth') throw new Error('Expected OAuth fixture');
    const isolatedRecord = buildConnectedServiceCredentialRecord({ ...secondRecord, now: 30, profileId: 'private', oauth: { ...secondRecord.oauth, raw: null } });
    const oldIdentity = { v: 1, id: 'csm_legacy_private', createdAtMs: 1 } as const;
    const oldHome = join(baseDir, oldIdentity.id, 'codex', 'codex-home');
    await mkdir(join(oldHome, 'sessions'), { recursive: true });
    await mkdir(join(oldHome, 'memories'), { recursive: true });
    await writeFile(join(oldHome, 'sessions', 'private.jsonl'), 'private-history\n');
    await writeFile(join(oldHome, 'memories', 'memory.md'), 'private-memory');
    const resumed = await materializeConnectedServicesForSpawn({
      agentId: 'codex', materializationKey: 'resume-old', connectedServiceMaterializationIdentityV1: oldIdentity,
      activeServerDir, baseDir, recordsByServiceId: new Map([['openai-codex', isolatedRecord]]),
      processEnv: { CODEX_HOME: sourceCodexHome, HOME: tmpdir() },
      accountSettings: { connectedServicesProviderStateSharingSettingsV1: { byAgentId: { codex: { stateMode: 'isolated' } } } },
    });
    expect(resumed!.env.CODEX_HOME).not.toBe(oldHome);
    await expect(readFile(join(resumed!.env.CODEX_HOME!, 'sessions', 'private.jsonl'), 'utf8')).resolves.toBe('private-history\n');
    await expect(readFile(join(resumed!.env.CODEX_HOME!, 'memories', 'memory.md'), 'utf8')).resolves.toBe('private-memory');
    // The old root remains recoverable until the resume owner has established continuity.
    await expect(readFile(join(oldHome, 'sessions', 'private.jsonl'), 'utf8')).resolves.toBe('private-history\n');
  });
});

function paramsForProbe(record: ReturnType<typeof buildConnectedServiceCredentialRecord>) {
  return {
    agentId: 'codex',
    materializationKey: 'catalog-probe',
    materializationPurpose: 'probe',
    recordsByServiceId: new Map([['openai-codex' as const, record]]),
    accountSettings: {
      connectedServicesProviderStateSharingSettingsV1: { byAgentId: { codex: { stateMode: 'isolated' } } },
    },
  } as const;
}
