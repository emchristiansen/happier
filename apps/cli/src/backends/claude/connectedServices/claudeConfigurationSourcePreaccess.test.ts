import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createClaudeConnectedServicesMaterializer } from './createClaudeConnectedServicesMaterializer';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';

/**
 * Every path argument reaching the filesystem boundary, with the operation, recorded before the real
 * call runs. A swallowed read error still records its path, so "never accessed" is observable.
 */
const { accessedPaths, accessedOperations, traceFsModule } = vi.hoisted(() => {
  const recorded: string[] = [];
  const operations: Array<Readonly<{ operation: string; path: string }>> = [];
  const tracedFunctionNames = [
    'access', 'accessSync', 'appendFile', 'chmod', 'chmodSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
    'createReadStream', 'existsSync', 'link', 'linkSync', 'lstat', 'lstatSync', 'mkdir', 'mkdirSync', 'open',
    'openSync', 'opendir', 'readFile', 'readFileSync', 'readdir', 'readdirSync', 'readlink', 'readlinkSync',
    'realpath', 'realpathSync', 'rename', 'renameSync', 'rm', 'rmSync', 'stat', 'statSync', 'symlink',
    'symlinkSync', 'unlink', 'unlinkSync', 'utimes', 'writeFile', 'writeFileSync',
  ];
  const trace = <T extends Record<string, unknown>>(actual: T): T => {
    const traced: Record<string, unknown> = { ...actual };
    for (const name of tracedFunctionNames) {
      const original = actual[name];
      if (typeof original !== 'function') continue;
      traced[name] = function tracedFsCall(this: unknown, ...args: unknown[]) {
        for (const arg of args.slice(0, 2)) {
          const path = typeof arg === 'string' ? arg : arg instanceof URL ? arg.pathname : null;
          if (path === null) continue;
          recorded.push(path);
          operations.push({ operation: name, path });
        }
        return (original as (...callArgs: unknown[]) => unknown).apply(this, args);
      };
    }
    return traced as T;
  };
  return { accessedPaths: recorded, accessedOperations: operations, traceFsModule: trace };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const traced = traceFsModule(actual);
  return { ...traced, default: traced };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown> & { promises: Record<string, unknown> }>();
  const traced = traceFsModule(actual);
  const tracedPromises = traceFsModule(actual.promises);
  return { ...traced, promises: tracedPromises, default: { ...traced, promises: tracedPromises } };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      throw new Error('materialization must not start a provider process');
    }),
  };
});

const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');
const ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');

function syntheticSelectedRecord() {
  return buildConnectedServiceCredentialRecord({
    now: ISSUED_AT_MS,
    serviceId: 'claude-subscription',
    profileId: 'selected-profile',
    kind: 'oauth',
    expiresAt: ISSUED_AT_MS + 60 * 60 * 1000,
    oauth: {
      accessToken: 'synthetic-selected-access',
      refreshToken: 'synthetic-selected-refresh',
      idToken: null,
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: null,
      providerEmail: null,
    },
  });
}

function managedTargetDir(activeServerDir: string): string {
  return join(activeServerDir, 'daemon', 'connected-services', 'homes', 'claude-subscription', 'selected-profile', 'claude', 'claude-config');
}

function pathsUnder(root: string): string[] {
  const resolvedRoot = resolve(root);
  return accessedPaths.filter((path) => {
    const resolvedPath = resolve(path);
    return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
  });
}

function isUnder(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${sep}`);
}

/**
 * Filesystem operations under an excluded HOME other than permitted identity metadata: a single
 * `realpath` of exactly `HOME/.claude.json` or `HOME/.claude`, which establishes what the source
 * must not resolve to without opening, listing or hashing anything. Every other operation, on those
 * paths or anywhere else under HOME, is reported.
 */
function homeAccessesBeyondIdentityMetadata(homeDir: string): Array<Readonly<{ operation: string; path: string }>> {
  const identityPaths = new Set([resolve(homeDir, '.claude.json'), resolve(homeDir, '.claude')]);
  return accessedOperations.filter((access) =>
    isUnder(access.path, homeDir)
    && !(access.operation === 'realpath' && identityPaths.has(resolve(access.path))));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

/**
 * An excluded ambient HOME: a native root config that would trust the session directory and
 * carry another account's identity, plus a native config dir with settings and transcripts.
 */
async function createExcludedAmbientHome(projectDir: string): Promise<string> {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-excluded-home-'));
  await mkdir(join(homeDir, '.claude', 'projects'), { recursive: true });
  await writeJson(join(homeDir, '.claude.json'), {
    hasCompletedOnboarding: true,
    oauthAccount: { emailAddress: 'excluded@example.test', accountUuid: 'excluded-account' },
    projects: { [projectDir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  });
  await writeJson(join(homeDir, '.claude', '.claude.json'), {
    projects: { [projectDir]: { hasTrustDialogAccepted: true } },
  });
  await writeJson(join(homeDir, '.claude', 'settings.json'), { theme: 'excluded-home' });
  return homeDir;
}

async function readTargetRootConfig(targetDir: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(join(targetDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

describe('Claude connected-service configuration source pre-access contract', () => {
  beforeEach(() => {
    accessedPaths.length = 0;
    accessedOperations.length = 0;
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', { ...ORIGINAL_PLATFORM_DESCRIPTOR, value: 'linux' });
    }
  });

  afterEach(() => {
    if (ORIGINAL_PLATFORM_DESCRIPTOR) {
      Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
    }
  });

  it('reads trust only from the explicit config dir and never touches the ambient HOME', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-root-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
    const permittedConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-permitted-'));
    const homeDir = await createExcludedAmbientHome(projectDir);
    await writeJson(join(permittedConfigDir, '.claude.json'), {
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    });

    accessedPaths.length = 0;
    accessedOperations.length = 0;
    const result = await createClaudeConnectedServicesMaterializer()({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', syntheticSelectedRecord()]]),
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: permittedConfigDir },
      sessionDirectory: projectDir,
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    expect(pathsUnder(permittedConfigDir).length).toBeGreaterThan(0);
    expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
    const targetConfig = await readTargetRootConfig(result!.env.CLAUDE_CONFIG_DIR!);
    expect(targetConfig?.projects).toEqual({ [projectDir]: { hasTrustDialogAccepted: true } });
    expect(targetConfig).not.toHaveProperty('oauthAccount');
  });

  it('preserves an explicit config dir that declines trust instead of consulting the ambient HOME', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-root-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
    const permittedConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-permitted-'));
    const homeDir = await createExcludedAmbientHome(projectDir);
    await writeJson(join(permittedConfigDir, '.claude.json'), {
      projects: { [projectDir]: { hasTrustDialogAccepted: false } },
    });

    accessedPaths.length = 0;
    accessedOperations.length = 0;
    const result = await createClaudeConnectedServicesMaterializer()({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', syntheticSelectedRecord()]]),
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: permittedConfigDir },
      sessionDirectory: projectDir,
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
    const targetConfig = await readTargetRootConfig(result!.env.CLAUDE_CONFIG_DIR!);
    expect((targetConfig?.projects as Record<string, unknown> | undefined)?.[projectDir]).toBeUndefined();
  });

  it('does not synthesize trust when the explicit config dir is silent about the session directory', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-root-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
    const permittedConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-permitted-'));
    const homeDir = await createExcludedAmbientHome(projectDir);

    accessedPaths.length = 0;
    accessedOperations.length = 0;
    const result = await createClaudeConnectedServicesMaterializer()({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', syntheticSelectedRecord()]]),
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: permittedConfigDir },
      sessionDirectory: projectDir,
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
    const targetConfig = await readTargetRootConfig(result!.env.CLAUDE_CONFIG_DIR!);
    expect((targetConfig?.projects as Record<string, unknown> | undefined)?.[projectDir]).toBeUndefined();
  });

  it('fails closed without reading the ambient HOME when the configured dir is the managed target home', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-root-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
    const homeDir = await createExcludedAmbientHome(projectDir);
    const targetDir = managedTargetDir(activeServerDir);
    await mkdir(targetDir, { recursive: true });
    await writeJson(join(targetDir, '.claude.json'), {
      projects: { [projectDir]: { hasTrustDialogAccepted: false } },
    });

    accessedPaths.length = 0;
    accessedOperations.length = 0;
    const result = await createClaudeConnectedServicesMaterializer()({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', syntheticSelectedRecord()]]),
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      sessionDirectory: projectDir,
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
    // Default shared session state has no permitted native store to share with.
    expect(result!.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'claude_shared_state_link_unavailable', severity: 'blocking' }),
    ]));
    // The managed home keeps its own explicit distrust; nothing is projected over it.
    const targetConfig = await readTargetRootConfig(targetDir);
    expect((targetConfig?.projects as Record<string, unknown>)[projectDir]).toEqual({ hasTrustDialogAccepted: false });
    expect(targetConfig).not.toHaveProperty('oauthAccount');
  });

  it('materializes an isolated managed home without reading the ambient HOME when the configured dir is the managed target home', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-root-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
    const homeDir = await createExcludedAmbientHome(projectDir);
    const targetDir = managedTargetDir(activeServerDir);

    accessedPaths.length = 0;
    accessedOperations.length = 0;
    const result = await createClaudeConnectedServicesMaterializer()({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', syntheticSelectedRecord()]]),
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      accountSettings: {
        connectedServicesProviderStateSharingSettingsV1: {
          v: 1,
          defaults: { configMode: 'linked', stateMode: 'isolated' },
        },
      },
      sessionDirectory: projectDir,
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
    expect((result!.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'blocking')).toEqual([]);
    expect(result!.env.CLAUDE_CONFIG_DIR).toBe(targetDir);
    const targetConfig = await readTargetRootConfig(targetDir);
    expect((targetConfig?.projects as Record<string, unknown> | undefined)?.[projectDir]).toBeUndefined();
    expect(targetConfig).not.toHaveProperty('oauthAccount');
  });

  it('uses an explicit HAPPIER_CLAUDE_CONFIG_DIR when CLAUDE_CONFIG_DIR points at a managed home', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-root-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
    const permittedConfigDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-permitted-'));
    const homeDir = await createExcludedAmbientHome(projectDir);
    const targetDir = managedTargetDir(activeServerDir);
    await writeJson(join(permittedConfigDir, '.claude.json'), {
      projects: { [projectDir]: { hasTrustDialogAccepted: true } },
    });
    await writeJson(join(permittedConfigDir, 'settings.json'), { theme: 'permitted' });

    accessedPaths.length = 0;
    accessedOperations.length = 0;
    const result = await createClaudeConnectedServicesMaterializer()({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', syntheticSelectedRecord()]]),
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir, HAPPIER_CLAUDE_CONFIG_DIR: permittedConfigDir },
      sessionDirectory: projectDir,
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
    expect((result!.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'blocking')).toEqual([]);
    const targetConfig = await readTargetRootConfig(targetDir);
    expect(targetConfig?.projects).toEqual({ [projectDir]: { hasTrustDialogAccepted: true } });
    expect(JSON.parse(await readFile(join(targetDir, 'settings.json'), 'utf8'))).toMatchObject({ theme: 'permitted' });
  });

  it('keeps the native HOME layout as the source identity when no config dir override is set', async () => {
    const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
    const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-root-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
    const nativeHomeDir = await createExcludedAmbientHome(projectDir);

    accessedPaths.length = 0;
    accessedOperations.length = 0;
    const result = await createClaudeConnectedServicesMaterializer()({
      agentId: 'claude',
      activeServerDir,
      rootDir,
      recordsByServiceId: new Map([['claude-subscription', syntheticSelectedRecord()]]),
      processEnv: { HOME: nativeHomeDir },
      sessionDirectory: projectDir,
      cleanupRoot: () => {},
    });

    expect(result).not.toBeNull();
    const targetConfig = await readTargetRootConfig(result!.env.CLAUDE_CONFIG_DIR!);
    expect(targetConfig?.projects).toEqual({
      [projectDir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    });
    expect(targetConfig).not.toHaveProperty('oauthAccount');
  });

  describe('source identity is established before any source content is read', () => {
    async function materializeFrom(params: Readonly<{
      activeServerDir: string;
      processEnv: NodeJS.ProcessEnv;
      projectDir: string;
      group?: boolean;
    }>) {
      const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-root-'));
      const record = syntheticSelectedRecord();
      return await createClaudeConnectedServicesMaterializer()({
        agentId: 'claude',
        activeServerDir: params.activeServerDir,
        rootDir,
        recordsByServiceId: new Map([['claude-subscription', record]]),
        ...(params.group
          ? {
              selectionsByServiceId: new Map([['claude-subscription', {
                kind: 'group' as const,
                serviceId: 'claude-subscription' as const,
                groupId: 'claude-team',
                activeProfileId: 'selected-profile',
                fallbackProfileId: 'fallback-profile',
                generation: 3,
                record,
                policy: null,
              }]]),
            }
          : {}),
        processEnv: params.processEnv,
        sessionDirectory: params.projectDir,
        cleanupRoot: () => {},
      });
    }

    function expectSourceScopeRefusal(
      result: Awaited<ReturnType<typeof materializeFrom>>,
      expected: Readonly<{ entryName: string; reason: string }>,
    ): void {
      expect(result).not.toBeNull();
      expect(result!.diagnostics).toEqual([expect.objectContaining({
        code: 'claude_configuration_source_outside_permitted_scope',
        severity: 'blocking',
        ...expected,
      })]);
    }

    /** An unselected managed account home carrying sentinel configuration that must never be imported. */
    async function createUnselectedManagedHome(activeServerDir: string, projectDir: string): Promise<string> {
      const otherHome = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'claude-subscription', 'other-profile', 'claude', 'claude-config');
      await mkdir(otherHome, { recursive: true });
      await writeJson(join(otherHome, '.claude.json'), {
        projects: { [projectDir]: { hasTrustDialogAccepted: true } },
      });
      await writeJson(join(otherHome, 'settings.json'), { theme: 'excluded-managed-sentinel' });
      return otherHome;
    }

    it('refuses a source root config linked into the excluded ambient HOME without importing it', async () => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
      const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
      const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-source-'));
      const homeDir = await createExcludedAmbientHome(projectDir);
      await symlink(join(homeDir, '.claude.json'), join(sourceDir, '.claude.json'));

      accessedOperations.length = 0;
      const result = await materializeFrom({
        activeServerDir,
        projectDir,
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      });

      expectSourceScopeRefusal(result, { entryName: '.claude.json', reason: 'resolves_to_ambient_home_config' });
      expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
      expect(await readTargetRootConfig(managedTargetDir(activeServerDir))).toBeNull();
      await expect(readFile(join(managedTargetDir(activeServerDir), '.credentials.json'), 'utf8')).rejects.toThrow();
    });

    it('refuses a source settings file linked into the excluded ambient HOME without importing it', async () => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
      const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
      const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-source-'));
      const homeDir = await createExcludedAmbientHome(projectDir);
      await writeJson(join(sourceDir, '.claude.json'), { projects: {} });
      await symlink(join(homeDir, '.claude', 'settings.json'), join(sourceDir, 'settings.json'));

      accessedOperations.length = 0;
      const result = await materializeFrom({
        activeServerDir,
        projectDir,
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      });

      expectSourceScopeRefusal(result, { entryName: 'settings.json', reason: 'resolves_to_ambient_home_config' });
      expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
      await expect(readFile(join(managedTargetDir(activeServerDir), 'settings.json'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(managedTargetDir(activeServerDir), '.credentials.json'), 'utf8')).rejects.toThrow();
    });

    it('refuses a configured dir that aliases another managed account home', async () => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
      const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
      const homeDir = await createExcludedAmbientHome(projectDir);
      const otherHome = await createUnselectedManagedHome(activeServerDir, projectDir);
      const aliasParent = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-alias-'));
      await symlink(join(otherHome, '..'), join(aliasParent, 'claude'));

      accessedOperations.length = 0;
      const result = await materializeFrom({
        activeServerDir,
        projectDir,
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: join(aliasParent, 'claude', 'claude-config') },
      });

      expectSourceScopeRefusal(result, { entryName: '.', reason: 'resolves_to_managed_home' });
      expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
      expect(accessedOperations.filter((access) => access.operation === 'readFile' && isUnder(access.path, aliasParent))).toEqual([]);
      await expect(readFile(join(managedTargetDir(activeServerDir), 'settings.json'), 'utf8')).rejects.toThrow();
    });

    it('refuses links into an unselected managed home even when the configured dir encloses the managed tree', async () => {
      const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-enclosing-source-'));
      const activeServerDir = join(sourceDir, 'server');
      const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
      const homeDir = await createExcludedAmbientHome(projectDir);
      const otherHome = await createUnselectedManagedHome(activeServerDir, projectDir);
      await symlink(join(otherHome, '.claude.json'), join(sourceDir, '.claude.json'));
      await symlink(join(otherHome, 'settings.json'), join(sourceDir, 'settings.json'));

      accessedOperations.length = 0;
      const result = await materializeFrom({
        activeServerDir,
        projectDir,
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      });

      expectSourceScopeRefusal(result, { entryName: '.claude.json', reason: 'resolves_to_managed_home' });
      const contentReads = accessedOperations.filter((access) =>
        (access.operation === 'readFile' || access.operation === 'open' || access.operation === 'copyFile' || access.operation === 'cp')
        && (isUnder(access.path, otherHome) || resolve(access.path) === resolve(sourceDir, '.claude.json') || resolve(access.path) === resolve(sourceDir, 'settings.json')));
      expect(contentReads).toEqual([]);
      await expect(readFile(join(managedTargetDir(activeServerDir), 'settings.json'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(managedTargetDir(activeServerDir), '.credentials.json'), 'utf8')).rejects.toThrow();
    });

    it.each([
      { name: 'an ordinary child', childName: 'nested' },
      { name: 'a legal child named with leading dots', childName: '..nested' },
    ])('refuses a source settings link into $name of the excluded ambient Claude dir without importing it', async ({ childName }) => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
      const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
      const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-source-'));
      const homeDir = await createExcludedAmbientHome(projectDir);
      const excludedChild = join(homeDir, '.claude', childName);
      await mkdir(excludedChild, { recursive: true });
      await writeJson(join(excludedChild, 'settings.json'), { theme: 'excluded-dotdot-sentinel', cleanupPeriodDays: 321 });
      await writeJson(join(sourceDir, '.claude.json'), { projects: {} });
      await symlink(join(excludedChild, 'settings.json'), join(sourceDir, 'settings.json'));

      accessedOperations.length = 0;
      const result = await materializeFrom({
        activeServerDir,
        projectDir,
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      });

      expectSourceScopeRefusal(result, { entryName: 'settings.json', reason: 'resolves_to_ambient_home_config' });
      expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
      const targetDir = managedTargetDir(activeServerDir);
      await expect(readFile(join(targetDir, 'settings.json'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(targetDir, '.credentials.json'), 'utf8')).rejects.toThrow();
    });

    it('refuses a source settings link into a dot-prefixed directory of an unselected managed home', async () => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
      const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
      const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-source-'));
      const homeDir = await createExcludedAmbientHome(projectDir);
      const excludedChild = join(activeServerDir, 'daemon', 'connected-services', 'homes', '..other-service');
      await mkdir(excludedChild, { recursive: true });
      await writeJson(join(excludedChild, 'settings.json'), { theme: 'excluded-managed-dotdot-sentinel' });
      await symlink(join(excludedChild, 'settings.json'), join(sourceDir, 'settings.json'));

      const result = await materializeFrom({
        activeServerDir,
        projectDir,
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      });

      expectSourceScopeRefusal(result, { entryName: 'settings.json', reason: 'resolves_to_managed_home' });
      const targetDir = managedTargetDir(activeServerDir);
      await expect(readFile(join(targetDir, 'settings.json'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(targetDir, '.credentials.json'), 'utf8')).rejects.toThrow();
    });

    it('keeps a source settings link into an ordinary dotfiles checkout', async () => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
      const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
      const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-source-'));
      const dotfilesDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-dotfiles-'));
      const homeDir = await createExcludedAmbientHome(projectDir);
      await writeJson(join(dotfilesDir, 'settings.json'), { theme: 'dotfiles' });
      await writeJson(join(sourceDir, '.claude.json'), { projects: { [projectDir]: { hasTrustDialogAccepted: true } } });
      await symlink(join(dotfilesDir, 'settings.json'), join(sourceDir, 'settings.json'));

      accessedOperations.length = 0;
      const result = await materializeFrom({
        activeServerDir,
        projectDir,
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      });

      expect(result).not.toBeNull();
      expect((result!.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'blocking')).toEqual([]);
      expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
      const targetDir = managedTargetDir(activeServerDir);
      expect(JSON.parse(await readFile(join(targetDir, 'settings.json'), 'utf8'))).toMatchObject({ theme: 'dotfiles' });
      expect((await readTargetRootConfig(targetDir))?.projects).toEqual({ [projectDir]: { hasTrustDialogAccepted: true } });
    });

    it.each([
      { name: 'the native HOME layout', explicitNativeDefault: false },
      { name: 'an explicit native-default config dir', explicitNativeDefault: true },
    ])('composes a group from a member materialized from $name, keeping its permitted native links', async ({ explicitNativeDefault }) => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
      const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
      const nativeHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-native-home-'));
      await mkdir(join(nativeHomeDir, '.claude', 'projects'), { recursive: true });
      await writeJson(join(nativeHomeDir, '.claude', '.claude.json'), { projects: { [projectDir]: { hasTrustDialogAccepted: true } } });
      await writeJson(join(nativeHomeDir, '.claude.json'), { projects: { [projectDir]: { hasTrustDialogAccepted: true } } });
      await writeJson(join(nativeHomeDir, '.claude', 'settings.json'), { theme: 'native' });

      const result = await materializeFrom({
        activeServerDir,
        projectDir,
        group: true,
        processEnv: explicitNativeDefault
          ? { HOME: nativeHomeDir, CLAUDE_CONFIG_DIR: join(nativeHomeDir, '.claude') }
          : { HOME: nativeHomeDir },
      });

      expect(result).not.toBeNull();
      expect((result!.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'blocking')).toEqual([]);
      const groupDir = join(activeServerDir, 'daemon', 'connected-services', 'homes', 'claude-subscription', '__groups', 'claude-team', 'claude', 'claude-config');
      expect(result!.env.CLAUDE_CONFIG_DIR).toBe(groupDir);
      expect(JSON.parse(await readFile(join(groupDir, 'settings.json'), 'utf8'))).toMatchObject({ theme: 'native' });
      const credential = JSON.parse(await readFile(join(groupDir, '.credentials.json'), 'utf8'));
      expect(credential.claudeAiOauth.accessToken).toBe('synthetic-selected-access');
    });

    it('still refuses a group whose configured source links into an unselected managed home', async () => {
      const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
      const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
      const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-source-'));
      const homeDir = await createExcludedAmbientHome(projectDir);
      const otherHome = await createUnselectedManagedHome(activeServerDir, projectDir);
      await symlink(join(otherHome, 'settings.json'), join(sourceDir, 'settings.json'));

      const result = await materializeFrom({
        activeServerDir,
        projectDir,
        group: true,
        processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      });

      expectSourceScopeRefusal(result, { entryName: 'settings.json', reason: 'resolves_to_managed_home' });
      const memberDir = managedTargetDir(activeServerDir);
      await expect(readFile(join(memberDir, 'settings.json'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(memberDir, '.credentials.json'), 'utf8')).rejects.toThrow();
    });

    it.each([undefined, true])(
      'revokes reused target trust when the explicit source now distrusts the directory (source onboarding %s)',
      async (hasCompletedOnboarding) => {
        const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-server-'));
        const projectDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-project-'));
        const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-preaccess-source-'));
        const homeDir = await createExcludedAmbientHome(projectDir);
        const targetDir = managedTargetDir(activeServerDir);
        await mkdir(targetDir, { recursive: true });
        await writeJson(join(targetDir, '.claude.json'), {
          projects: { [projectDir]: { hasTrustDialogAccepted: true, allowedTools: ['Bash(ls)'], history: [{ display: 'kept' }] } },
        });
        await writeJson(join(sourceDir, '.claude.json'), {
          ...(hasCompletedOnboarding === undefined ? {} : { hasCompletedOnboarding }),
          projects: { [projectDir]: { hasTrustDialogAccepted: false } },
        });

        accessedOperations.length = 0;
        const result = await materializeFrom({
          activeServerDir,
          projectDir,
          processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
        });

        expect(result).not.toBeNull();
        expect(homeAccessesBeyondIdentityMetadata(homeDir)).toEqual([]);
        const targetConfig = await readTargetRootConfig(targetDir);
        expect((targetConfig?.projects as Record<string, unknown>)[projectDir]).toEqual({
          hasTrustDialogAccepted: false,
          allowedTools: ['Bash(ls)'],
          history: [{ display: 'kept' }],
        });
      },
    );
  });
});
