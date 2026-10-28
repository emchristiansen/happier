import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
  HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY,
  HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY,
} from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { logger } from '@/ui/logger';

import { createClaudeConnectedServicesMaterializer } from './createClaudeConnectedServicesMaterializer';
import {
  buildClaudeConnectedServiceHomeProvenance,
  resolveClaudeConnectedServiceHomeProvenancePath,
} from './claudeConnectedServiceHomeProvenance';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { resolveClaudeCodeMacOsKeychainServiceName } from './nativeAuth/claudeCodeMacOsKeychain';
import { syncClaudeConnectedServiceHome } from './syncClaudeConnectedServiceHome';

const { spawnSpy } = vi.hoisted(() => ({
  spawnSpy: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnSpy,
  };
});

const REALISTIC_ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');
const REALISTIC_EXPIRES_AT_MS = REALISTIC_ISSUED_AT_MS + 60 * 60 * 1000;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

function buildClaudeSubscriptionRecord(params: Readonly<{
  accessToken?: string;
  refreshToken?: string;
  now?: number;
  expiresAt?: number;
}> = {}) {
  return buildConnectedServiceCredentialRecord({
    now: params.now ?? REALISTIC_ISSUED_AT_MS,
    serviceId: 'claude-subscription',
    profileId: 'oauth-profile',
    kind: 'oauth',
    expiresAt: params.expiresAt ?? REALISTIC_EXPIRES_AT_MS,
    oauth: {
      accessToken: params.accessToken ?? 'selected-access-placeholder',
      refreshToken: params.refreshToken ?? 'selected-refresh-placeholder',
      idToken: null,
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: null,
      providerEmail: null,
    },
  });
}

describe('createClaudeConnectedServicesMaterializer', () => {
  const securityInputs: string[] = [];

  beforeEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    }
  });

  afterEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
    spawnSpy.mockReset();
    securityInputs.length = 0;
  });

  function mockSecurityProcess(result: Readonly<{ status: number | null; stdout?: string; stderr?: string }>) {
    const child = new EventEmitter() as EventEmitter & {
      stdin: Writable;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        securityInputs.push(String(chunk));
        callback();
      },
    });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', result.status);
    });
    return child;
  }

  function mockSecuritySpawn(
    resolve: (args: readonly string[]) => Readonly<{ status: number | null; stdout?: string; stderr?: string }>,
  ): void {
    spawnSpy.mockImplementation((_command: string, args: readonly string[]) => mockSecurityProcess(resolve(args)));
  }

  it('strips ambient Claude credentials and writes selected OAuth as native Claude Code credentials', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    await writeFile(
      join(sourceClaudeConfigDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'ambient-access-placeholder',
          refreshToken: 'ambient-refresh-placeholder',
          expiresAt: 1000,
          scopes: ['user:inference'],
        },
      }),
    );
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const expectedProfileClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(expectedProfileClaudeConfigDir);
    expect(result!.targetMaterializedRoot).toBe(expectedProfileClaudeConfigDir);
    expect(result!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(result!.env.CLAUDE_CODE_SETUP_TOKEN).toBeUndefined();
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_ENV_KEY]).toBeUndefined();
    expect(result!.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]).toBeUndefined();
    expect(result!.diagnostics ?? []).toEqual([]);

    const credential = JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('selected-access-placeholder');
    expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
    expect(credential.claudeAiOauth.accessToken).not.toBe('ambient-access-placeholder');
    expect(credential.claudeAiOauth.scopes).toContain('user:sessions:claude_code');
    expect(credential.claudeAiOauth.expiresAt).toBe(REALISTIC_EXPIRES_AT_MS);
    expect(credential.claudeAiOauth.expiresAt).toBeGreaterThan(1_000_000_000_000);
    await expect(readFile(join(result!.env.CLAUDE_CONFIG_DIR!, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
  });

  it('projects user-accepted Claude workspace trust without copying credentials or per-project approvals', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'happier-claude-trusted-project-'));
    const projectDir = join(projectRoot, 'repo');
    const otherProjectDir = join(projectRoot, 'other');
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    await mkdir(projectDir, { recursive: true });
    await mkdir(otherProjectDir, { recursive: true });
    await writeFile(
      join(homeDir, '.claude.json'),
      `${JSON.stringify({
        oauthAccount: { accessToken: 'ambient-root-access-must-not-copy' },
        projects: {
          [projectDir]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
            hasClaudeMdExternalIncludesApproved: true,
            allowedTools: ['Bash(*)'],
            mcpServers: {
              local: { command: 'secret-local-command' },
            },
            enabledMcpjsonServers: ['local'],
            lastCost: 123,
          },
          [otherProjectDir]: {
            hasTrustDialogAccepted: true,
            hasCompletedProjectOnboarding: true,
          },
        },
      })}\n`,
    );
    const record = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: homeDir,
      },
      sessionDirectory: projectDir,
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const targetConfig = JSON.parse(await readFile(join(result!.env.CLAUDE_CONFIG_DIR!, '.claude.json'), 'utf8'));
    expect(targetConfig.oauthAccount).toBeUndefined();
    expect(targetConfig.projects).toEqual({
      [projectDir]: {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
  });

  it('materializes a Claude subscription group selection into the shared group home', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      selectionsByServiceId: new Map([['claude-subscription', {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'claude-team',
        activeProfileId: 'oauth-profile',
        fallbackProfileId: 'fallback-profile',
        generation: 7,
        record,
        policy: null,
      }]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const expectedGroupClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'claude-team',
      'claude',
      'claude-config',
    );
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(expectedGroupClaudeConfigDir);
    expect(result!.targetMaterializedRoot).toBe(expectedGroupClaudeConfigDir);
    const credential = JSON.parse(await readFile(join(expectedGroupClaudeConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('selected-access-placeholder');
  });

  it('does not let a superseded spawn selection mutate the shared Claude group home', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-superseded-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-superseded-root-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-superseded-source-'));
    const record = buildClaudeSubscriptionRecord();
    const validateGroupMutationCurrentness = vi.fn(async () => ({ current: false as const }));

    const result = await createClaudeConnectedServicesMaterializer()({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      selectionsByServiceId: new Map([['claude-subscription', {
        kind: 'group',
        serviceId: 'claude-subscription',
        groupId: 'claude-team',
        activeProfileId: 'oauth-profile',
        fallbackProfileId: 'fallback-profile',
        generation: 7,
        credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
        record,
        policy: null,
      }]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
      validateGroupMutationCurrentness,
      cleanupRoot: () => {},
    });

    const expectedGroupClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      '__groups',
      'claude-team',
      'claude',
      'claude-config',
    );
    expect(validateGroupMutationCurrentness).toHaveBeenCalledWith({
      serviceId: 'claude-subscription',
      groupId: 'claude-team',
      profileId: 'oauth-profile',
      generation: 7,
      credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS',
    });
    expect(result?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'claude_connected_service_generation_superseded',
        severity: 'blocking',
      }),
    ]));
    await expect(readFile(join(expectedGroupClaudeConfigDir, '.credentials.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('materializes macOS credentials without creating a derived keychain item', async () => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    }
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password') return { status: 44, stderr: 'missing keychain entry' };
      return { status: 0 };
    });
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const result = await createClaudeConnectedServicesMaterializer()({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: homeDir,
        USER: 'tester',
      },
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const expectedClaudeConfigDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    expect(spawnSpy.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === 'add-generic-password')).toBe(false);
    expect(securityInputs).toEqual([]);
    expect(spawnSpy.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === 'dump-keychain')).toBe(false);
    expect(spawnSpy.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === 'delete-generic-password')).toBe(false);
    const provenance = JSON.parse(
      await readFile(resolveClaudeConnectedServiceHomeProvenancePath(expectedClaudeConfigDir), 'utf8'),
    );
    expect(provenance).not.toHaveProperty('macOsKeychainCredential');
  });

  it('skips a stable credential-file rewrite when the derived keychain item is missing', async () => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    }
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password') return { status: 44, stderr: 'missing keychain entry' };
      if (args[0] === 'dump-keychain') return { status: 0, stdout: '' };
      return { status: 0 };
    });
    const loggerDebugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    try {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
      const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
      const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
      const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
      await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
      const record = buildClaudeSubscriptionRecord();
      const materializer = createClaudeConnectedServicesMaterializer();
      const materialize = async () => await materializer({
        agentId: 'claude',
        activeServerDir,
        rootDir,
        recordsByServiceId: new Map([['claude-subscription', record]]),
        selectionsByServiceId: new Map([['claude-subscription', {
          kind: 'group',
          serviceId: 'claude-subscription',
          groupId: 'claude-team',
          activeProfileId: 'oauth-profile',
          fallbackProfileId: 'fallback-profile',
          generation: 7,
          record,
          policy: null,
        }]]),
        processEnv: {
          CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
          HOME: homeDir,
          USER: 'tester',
        },
        cleanupRoot: () => {},
      });

      await expect(materialize()).resolves.not.toBeNull();
      loggerDebugSpy.mockClear();
      spawnSpy.mockClear();
      securityInputs.length = 0;

      const second = await materialize();

      expect(second).not.toBeNull();
      const credentialWriteEvents = loggerDebugSpy.mock.calls.filter(([, metadata]) => {
        const event = metadata as { event?: unknown; decision?: unknown } | undefined;
        return event?.event === 'claude_code_credential_file_decision'
          && event.decision === 'write';
      });
      expect(credentialWriteEvents).toHaveLength(0);
      expect(spawnSpy.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === 'add-generic-password')).toBe(false);
      expect(spawnSpy.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === 'dump-keychain')).toBe(false);
    } finally {
      loggerDebugSpy.mockRestore();
    }
  });

  it('deletes every Happier-managed derived keychain item for the account (live or legacy) while protecting the global login and other accounts', async () => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    }
    vi.useFakeTimers();
    try {
      const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-machine-home-'));
      const activeServerDir = join(
        homeDir,
        '.happier',
        'stacks',
        'stack-a',
        'cli',
        'servers',
        'server-a',
      );
      const siblingServerDir = join(
        homeDir,
        '.happier',
        'stacks',
        'stack-b',
        'cli',
        'servers',
        'server-b',
      );
      const siblingClaudeConfigDir = join(
        siblingServerDir,
        'daemon',
        'connected-services',
        'homes',
        'claude-subscription',
        'sibling-profile',
        'claude',
        'claude-config',
      );
      const customHomeClaudeConfigDir = join(
        homeDir,
        'custom-happier',
        'servers',
        'server-custom',
        'daemon',
        'connected-services',
        'homes',
        'claude-subscription',
        'custom-profile',
        'claude',
        'claude-config',
      );
      await mkdir(activeServerDir, { recursive: true });
      await mkdir(siblingClaudeConfigDir, { recursive: true });
      await mkdir(customHomeClaudeConfigDir, { recursive: true });
      const siblingService = resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: siblingClaudeConfigDir,
        homeDir,
      });
      const customHomeService = resolveClaudeCodeMacOsKeychainServiceName({
        claudeConfigDir: customHomeClaudeConfigDir,
        homeDir,
      });
      const staleService = 'Claude Code-credentials-1111aaaa';
      const dumpOutput = (account: string, service: string) => [
        'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
        'class: "genp"',
        'attributes:',
        `    "acct"<blob>="${account}"`,
        `    "svce"<blob>="${service}"`,
      ].join('\n');
      const otherAccountService = 'Claude Code-credentials-99998888';
      mockSecuritySpawn((args) => {
        if (args[0] === 'find-generic-password') return { status: 44, stderr: 'missing keychain entry' };
        if (args[0] === 'dump-keychain') {
          return {
            status: 0,
            stdout: [
              dumpOutput('tester', siblingService),
              dumpOutput('tester', customHomeService),
              dumpOutput('tester', staleService),
              // The user's global login and other-account residue (e.g. happier-test-user) are protected.
              dumpOutput('tester', 'Claude Code-credentials'),
              dumpOutput('happier-test-user', otherAccountService),
            ].join('\n'),
          };
        }
        return { status: 0 };
      });
      const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
      const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
      await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');

      await expect(createClaudeConnectedServicesMaterializer()({
        agentId: 'claude',
        activeServerDir,
        rootDir,
        recordsByServiceId: new Map([['claude-subscription', buildClaudeSubscriptionRecord()]]),
        processEnv: {
          CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
          HOME: homeDir,
          HAPPIER_HOME_DIR: '~/custom-happier',
          USER: 'tester',
        },
        cleanupRoot: () => {},
      })).resolves.not.toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);

      const deletedServices = spawnSpy.mock.calls
        .map((call) => call[1] as readonly string[])
        .filter((args) => args[0] === 'delete-generic-password')
        .map((args) => args[args.indexOf('-s') + 1]);
      expect(deletedServices).toContain(staleService);
      // Live sibling / custom-home managed items are obsolete cruft under the file-only design and are
      // now removed too (nothing reads a derived item, so liveness no longer protects it).
      expect(deletedServices).toContain(siblingService);
      expect(deletedServices).toContain(customHomeService);
      // The user's global login and other-account items are never touched.
      expect(deletedServices).not.toContain('Claude Code-credentials');
      expect(deletedServices).not.toContain(otherAccountService);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rewrites the credential file when the materialized credential fingerprint changes', async () => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'darwin' });
    }
    mockSecuritySpawn((args) => {
      if (args[0] === 'find-generic-password') return { status: 44, stderr: 'keychain item is not readable by this process' };
      return { status: 0 };
    });
    const loggerDebugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    try {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
      const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
      const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
      const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
      await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
      const firstRecord = buildClaudeSubscriptionRecord({
        accessToken: 'selected-access-v1-placeholder',
        refreshToken: 'selected-refresh-v1-placeholder',
      });
      const secondRecord = buildClaudeSubscriptionRecord({
        accessToken: 'selected-access-v2-placeholder',
        refreshToken: 'selected-refresh-v2-placeholder',
        now: REALISTIC_ISSUED_AT_MS + 1,
      });
      const materializer = createClaudeConnectedServicesMaterializer();

      const first = await materializer({
        agentId: 'claude',
        activeServerDir,
        rootDir,
        recordsByServiceId: new Map([['claude-subscription', firstRecord]]),
        processEnv: {
          CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
          HOME: homeDir,
          USER: 'tester',
        },
        cleanupRoot: () => {},
      });
      expect(first).not.toBeNull();
      const firstProvenance = JSON.parse(
        await readFile(resolveClaudeConnectedServiceHomeProvenancePath(first!.env.CLAUDE_CONFIG_DIR!), 'utf8'),
      );
      loggerDebugSpy.mockClear();
      spawnSpy.mockClear();

      const second = await materializer({
        agentId: 'claude',
        activeServerDir,
        rootDir,
        recordsByServiceId: new Map([['claude-subscription', secondRecord]]),
        processEnv: {
          CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
          HOME: homeDir,
          USER: 'tester',
        },
        cleanupRoot: () => {},
      });

      expect(second).not.toBeNull();
      const credentialWriteEvents = loggerDebugSpy.mock.calls.filter(([, metadata]) => {
        const event = metadata as { event?: unknown; decision?: unknown } | undefined;
        return event?.event === 'claude_code_credential_file_decision'
          && event.decision === 'write';
      });
      expect(credentialWriteEvents.length).toBeGreaterThan(0);
      const credential = JSON.parse(await readFile(join(second!.env.CLAUDE_CONFIG_DIR!, '.credentials.json'), 'utf8'));
      expect(credential.claudeAiOauth.accessToken).toBe('selected-access-v2-placeholder');
      const secondProvenance = JSON.parse(
        await readFile(resolveClaudeConnectedServiceHomeProvenancePath(second!.env.CLAUDE_CONFIG_DIR!), 'utf8'),
      );
      expect(secondProvenance.credentialFingerprint).not.toBe(firstProvenance.credentialFingerprint);
      expect(spawnSpy.mock.calls.some(([, args]) => Array.isArray(args) && args[0] === 'add-generic-password')).toBe(false);
    } finally {
      loggerDebugSpy.mockRestore();
    }
  });

  it('preserves the previous stable native credential file when rematerialization fails closed', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    const materializer = createClaudeConnectedServicesMaterializer();
    const validRecord = buildConnectedServiceCredentialRecord({
      now: 1000,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: 2000,
      oauth: {
        accessToken: 'stable-access-placeholder',
        refreshToken: 'stable-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    const invalidRecord = buildConnectedServiceCredentialRecord({
      now: 1100,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: 2100,
      oauth: {
        accessToken: 'invalid-access-placeholder',
        refreshToken: 'invalid-refresh-placeholder',
        idToken: null,
        scope: 'user:inference user:profile',
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const first = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', validRecord]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
      cleanupRoot: () => {},
    });
    expect(first).not.toBeNull();
    const credentialPath = join(first!.env.CLAUDE_CONFIG_DIR!, '.credentials.json');
    expect(await readFile(credentialPath, 'utf8')).toContain('stable-access-placeholder');

    const second = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', invalidRecord]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: tmpdir(),
      },
      cleanupRoot: () => {},
    });

    expect(second).not.toBeNull();
    expect(second!.diagnostics).toContainEqual(expect.objectContaining({
      code: 'claude_subscription_missing_claude_code_scope',
      severity: 'blocking',
    }));
    const preservedCredential = JSON.parse(await readFile(credentialPath, 'utf8'));
    expect(preservedCredential.claudeAiOauth.accessToken).toBe('stable-access-placeholder');
    expect(preservedCredential.claudeAiOauth).not.toHaveProperty('refreshToken');
  });

  it('re-materializes an existing stable profile home from the real Claude source env instead of self-sourcing stale target state', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    const existingTargetDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    await mkdir(existingTargetDir, { recursive: true });
    await writeFile(join(existingTargetDir, '.claude.json'), `${JSON.stringify({
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
        },
      },
    })}\n`);
    await writeFile(join(existingTargetDir, 'settings.json'), '{"theme":"stale-target"}\n');
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'probe@example.test',
        displayName: 'Probe User',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    })}\n`);
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: homeDir,
      },
      sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const targetConfig = JSON.parse(await readFile(join(existingTargetDir, '.claude.json'), 'utf8'));
    expect(targetConfig).not.toHaveProperty('oauthAccount');
    expect(targetConfig.projects).toEqual({
      '/Users/leeroy/Documents/Development/happier/remote-dev': {
        hasTrustDialogAccepted: true,
        hasCompletedProjectOnboarding: true,
      },
    });
    await expect(readFile(join(existingTargetDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
  });

  it('refreshes an existing stable profile home from the current native Claude config when provenance matches', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    const existingTargetDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    await mkdir(existingTargetDir, { recursive: true });
    await writeFile(join(existingTargetDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'target@example.test',
        displayName: 'Target Home',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
        },
      },
    })}\n`);
    await writeFile(join(existingTargetDir, 'settings.json'), '{"theme":"target"}\n');
    await writeFile(join(existingTargetDir, 'provider-state-marker.txt'), 'keep-provider-owned-state\n');
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'source@example.test',
        displayName: 'Source Home',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    })}\n`);
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    await writeFile(join(existingTargetDir, '.happier-claude-connected-service-home.json'), `${JSON.stringify(
      buildClaudeConnectedServiceHomeProvenance({
        record,
        selectionDescriptor: {
          kind: 'profile',
          serviceId: 'claude-subscription',
          profileId: 'oauth-profile',
        },
      }),
    )}\n`);

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: homeDir,
      },
      sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    await expect(readFile(join(existingTargetDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
    const targetConfig = JSON.parse(await readFile(join(existingTargetDir, '.claude.json'), 'utf8'));
    expect(targetConfig).not.toHaveProperty('oauthAccount');
    const credential = JSON.parse(await readFile(join(existingTargetDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('selected-access-placeholder');
    await expect(readFile(join(existingTargetDir, 'provider-state-marker.txt'), 'utf8')).resolves.toBe(
      'keep-provider-owned-state\n',
    );
  });

  it('does not trust an existing target oauthAccount when the selected Claude record has no stable identity', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const sourceClaudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-source-config-'));
    const existingTargetDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    await mkdir(existingTargetDir, { recursive: true });
    await writeFile(join(existingTargetDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'stale@example.test',
        displayName: 'Stale Target',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
        },
      },
    })}\n`);
    await writeFile(join(existingTargetDir, 'settings.json'), '{"theme":"stale-target"}\n');
    await writeFile(join(sourceClaudeConfigDir, 'settings.json'), '{"theme":"source"}\n');
    await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'fresh@example.test',
        displayName: 'Fresh Source',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    })}\n`);
    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        CLAUDE_CONFIG_DIR: sourceClaudeConfigDir,
        HOME: homeDir,
      },
      sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const targetConfig = JSON.parse(await readFile(join(existingTargetDir, '.claude.json'), 'utf8'));
    expect(targetConfig).not.toHaveProperty('oauthAccount');
    await expect(readFile(join(existingTargetDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"source"}\n');
  });

  it('falls back to the real HOME-based Claude source when the ambient CLAUDE_CONFIG_DIR already points at the managed target home', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-root-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-materializer-home-'));
    const homeClaudeConfigDir = join(homeDir, '.claude');
    const existingTargetDir = join(
      activeServerDir,
      'daemon',
      'connected-services',
      'homes',
      'claude-subscription',
      'oauth-profile',
      'claude',
      'claude-config',
    );
    await mkdir(homeClaudeConfigDir, { recursive: true });
    await mkdir(existingTargetDir, { recursive: true });
    await writeFile(join(homeClaudeConfigDir, 'settings.json'), '{"theme":"home-source"}\n');
    await writeFile(join(homeDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'home@example.test',
        displayName: 'Home Source',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    })}\n`);
    await writeFile(join(existingTargetDir, '.claude.json'), `${JSON.stringify({
      oauthAccount: {
        emailAddress: 'stale-target@example.test',
        displayName: 'Stale Managed Target',
        accessToken: 'must-not-copy',
      },
      projects: {
        '/Users/leeroy/Documents/Development/happier/remote-dev': {
          hasTrustDialogAccepted: true,
        },
      },
    })}\n`);
    await writeFile(join(existingTargetDir, 'settings.json'), '{"theme":"stale-target"}\n');

    const record = buildConnectedServiceCredentialRecord({
      now: REALISTIC_ISSUED_AT_MS,
      serviceId: 'claude-subscription',
      profileId: 'oauth-profile',
      kind: 'oauth',
      expiresAt: REALISTIC_EXPIRES_AT_MS,
      oauth: {
        accessToken: 'selected-access-placeholder',
        refreshToken: 'selected-refresh-placeholder',
        idToken: null,
        scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
        tokenType: 'Bearer',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    const materializer = createClaudeConnectedServicesMaterializer();
    const result = await materializer({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', record]]),
      processEnv: {
        HOME: homeDir,
        CLAUDE_CONFIG_DIR: existingTargetDir,
      },
      sessionDirectory: '/Users/leeroy/Documents/Development/happier/remote-dev',
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    await expect(readFile(join(existingTargetDir, 'settings.json'), 'utf8')).resolves.toBe('{"theme":"home-source"}\n');
    const targetConfig = JSON.parse(await readFile(join(existingTargetDir, '.claude.json'), 'utf8'));
    expect(targetConfig).not.toHaveProperty('oauthAccount');
  });

  it('preserves credentials when the source and target Claude config dirs are the same', async () => {
    const claudeConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-same-config-'));
    await writeFile(
      join(claudeConfigDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'same-dir-access-placeholder',
          refreshToken: 'same-dir-refresh-placeholder',
          expiresAt: 1000,
          scopes: ['user:inference'],
        },
      }),
    );

    await expect(syncClaudeConnectedServiceHome({
      sourceEnv: {
        CLAUDE_CONFIG_DIR: claudeConfigDir,
        HOME: tmpdir(),
      },
      targetDir: claudeConfigDir,
    })).resolves.toEqual({
      providerId: 'claude',
      requestedStateMode: 'shared',
      effectiveStateMode: 'shared',
      diagnostics: [],
    });

    const credential = JSON.parse(await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('same-dir-access-placeholder');
    expect(credential.claudeAiOauth.refreshToken).toBe('same-dir-refresh-placeholder');
  });
});
