import { mkdir, mkdtemp, readFile, readlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord, type AccountSettings } from '@happier-dev/protocol';

import { removeTempDir } from '@/testkit/fs/tempDir';
import { DEFAULT_MANIFEST_NAME } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import { resolveConfiguredClaudeConfigDir } from '../utils/resolveConfiguredClaudeConfigDir';
import { claudeNativeSourceEnv, claudeNativeSourceFromEnv } from './claudeHomeNativeSource';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';
import { materializeClaudeConnectedServiceSelection } from './materializeClaudeConnectedServiceSelection';
import { resolveClaudeRootConfigPathCandidates } from './materializeClaudeWorkspaceTrust';
import { resolveClaudeConnectedServiceStableConfigDir } from './resolveClaudeConnectedServiceStableAuthDir';

/**
 * How a Claude home's admitted native source composes: a group home reading through a member home
 * that is its own source, and a recorded default-layout source replayed for every home operand the
 * Claude reader uses. Real materializer, sync, manifest and readers; synthetic sources and records.
 */
const linkedIsolated = {
  connectedServicesProviderStateSharingSettingsV1: {
    v: 1,
    defaults: { configMode: 'linked', stateMode: 'isolated' },
    byAgentId: {},
  },
} as unknown as AccountSettings;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => removeTempDir(root)));
});

function record(profileId: string, accessToken: string) {
  return buildConnectedServiceCredentialRecord({
    now: 2_000_000_000_000,
    serviceId: 'claude-subscription',
    profileId,
    kind: 'oauth',
    expiresAt: 2_000_003_600_000,
    oauth: {
      accessToken,
      refreshToken: `${accessToken}-refresh`,
      idToken: null,
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: null,
      providerEmail: null,
    },
  });
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'happier-claude-source-composition-'));
  roots.push(dir);
  const activeServerDir = join(dir, 'server');
  for (const name of ['A', 'B']) {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, 'settings.json'), JSON.stringify({ source: name, cleanupPeriodDays: 99999 }));
  }
  const group = (activeProfileId: string, generation: number) => ({
    kind: 'group' as const,
    serviceId: 'claude-subscription' as const,
    groupId: 'g',
    activeProfileId,
    fallbackProfileId: activeProfileId,
    generation,
    credentialRevision: null,
  });
  const home = (profileId: string, selection: unknown = { kind: 'profile', profileId }) => resolveClaudeConnectedServiceStableConfigDir({
    activeServerDir,
    serviceId: 'claude-subscription',
    fallbackProfileId: profileId,
    selection: selection as Parameters<typeof resolveClaudeConnectedServiceStableConfigDir>[0]['selection'],
  })!;
  /** A caller whose own CLAUDE_CONFIG_DIR is `configDir` materializes `profileId` (or a group). */
  const materialize = (
    profileId: string,
    configDir: string,
    selection: unknown = { kind: 'profile', profileId },
    options: Readonly<{ authority?: 'caller_env' | 'recorded'; previousClaudeConfigDir?: string }> = {},
  ) =>
    materializeClaudeConnectedServiceSelection({
      activeServerDir,
      serviceId: 'claude-subscription',
      record: record(profileId, `${profileId}-access-${Math.random()}`),
      fallbackProfileId: profileId,
      selection: selection as Parameters<typeof materializeClaudeConnectedServiceSelection>[0]['selection'],
      processEnv: { HOME: join(dir, 'home'), CLAUDE_CONFIG_DIR: configDir },
      nativeSourceAuthority: options.authority ?? 'caller_env',
      ...(options.previousClaudeConfigDir ? { previousClaudeConfigDir: options.previousClaudeConfigDir } : {}),
      accountSettings: linkedIsolated,
      sessionDirectory: join(dir, 'work'),
    });
  const observe = async (claudeConfigDir: string) => ({
    settings: JSON.parse(await readFile(join(claudeConfigDir, 'settings.json'), 'utf8')),
    link: resolve(claudeConfigDir, await readlink(join(claudeConfigDir, 'settings.json'))),
    manifest: await readFile(join(claudeConfigDir, DEFAULT_MANIFEST_NAME), 'utf8'),
    credentials: await readFile(join(claudeConfigDir, '.credentials.json'), 'utf8'),
  });
  return { dir, group, home, materialize, observe };
}

describe('Claude group homes take their source from their member home only when the group admits it', () => {
  it('refuses a self-source member whose own origin differs from the group\'s, leaving the group untouched', async () => {
    const f = await fixture();
    await f.materialize('b', join(f.dir, 'B'), f.group('b', 1));
    await f.materialize('a', join(f.dir, 'A'));
    const groupHome = f.home('a', f.group('a', 2));
    const before = await f.observe(groupHome);
    expect(before.settings.source).toBe('B');

    // The caller names member `a`'s own managed home: it is its own source, whose origin is A.
    await expect(f.materialize('a', f.home('a'), f.group('a', 2)))
      .rejects.toMatchObject({ code: 'connected_service_native_source_conflict' });
    expect(await f.observe(groupHome)).toEqual(before);
  });

  it('control: an explicit source A for a group recorded from B is refused', async () => {
    const f = await fixture();
    await f.materialize('b', join(f.dir, 'B'), f.group('b', 1));
    await f.materialize('a', join(f.dir, 'A'));
    await expect(f.materialize('a', join(f.dir, 'A'), f.group('a', 2)))
      .rejects.toMatchObject({ code: 'connected_service_native_source_conflict' });
  });

  it('control: a self-source member whose origin is the group\'s keeps the group on that origin', async () => {
    const f = await fixture();
    await f.materialize('a', join(f.dir, 'A'), f.group('a', 1));
    const groupHome = f.home('a', f.group('a', 2));
    const before = await f.observe(groupHome);

    await f.materialize('a', f.home('a'), f.group('a', 2));
    const after = await f.observe(groupHome);
    expect(after.settings).toEqual({ source: 'A', cleanupPeriodDays: 99999 });
    expect(JSON.parse(after.manifest).nativeSourceEnv).toEqual(JSON.parse(before.manifest).nativeSourceEnv);
  });

  it('control: a self-source profile keeps its own configuration and record', async () => {
    const f = await fixture();
    await f.materialize('a', join(f.dir, 'A'));
    const before = await f.observe(f.home('a'));
    await f.materialize('a', f.home('a'));
    const after = await f.observe(f.home('a'));
    expect(after.settings).toEqual(before.settings);
    expect(JSON.parse(after.manifest).nativeSourceEnv).toEqual(JSON.parse(before.manifest).nativeSourceEnv);
  });
});

describe('a credential-only member never admits its group home', () => {
  /** Member `a` produced from A, then made legacy (its source record removed). */
  async function legacyMember(f: Awaited<ReturnType<typeof fixture>>) {
    await f.materialize('a', join(f.dir, 'A'));
    const member = f.home('a');
    const manifestPath = join(member, DEFAULT_MANIFEST_NAME);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    delete manifest.nativeSourceEnv;
    await writeFile(manifestPath, JSON.stringify(manifest));
    return member;
  }
  const readOrNull = async (path: string) => await readFile(path, 'utf8').catch(() => null);

  it.each([
    ['a malformed group home', 'malformed', false, 'connected_service_native_source_invalid'],
    ['a malformed group home, with a distinct previous home', 'malformed', true, 'connected_service_native_source_invalid'],
    ['a never-produced group home', 'absent', false, 'connected_service_native_source_unrecorded'],
    ['a never-produced group home, with a distinct previous home', 'absent', true, 'connected_service_native_source_unrecorded'],
  ] as const)('refuses %s before any credential changes', async (_label, groupState, withPrevious, code) => {
    const f = await fixture();
    const member = await legacyMember(f);
    await f.materialize('previous', join(f.dir, 'A'));
    const groupHome = f.home('a', f.group('a', 1));
    if (groupState === 'malformed') {
      await mkdir(groupHome, { recursive: true });
      await writeFile(join(groupHome, DEFAULT_MANIFEST_NAME), 'malformed');
    }
    const memberBefore = await readFile(join(member, '.credentials.json'), 'utf8');
    const groupBefore = await readOrNull(join(groupHome, '.credentials.json'));

    await expect(f.materialize('a', join(f.dir, 'B'), f.group('a', 1), {
      authority: 'recorded',
      ...(withPrevious ? { previousClaudeConfigDir: f.home('previous') } : {}),
    })).rejects.toMatchObject({ code });
    expect(await readFile(join(member, '.credentials.json'), 'utf8')).toBe(memberBefore);
    expect(await readOrNull(join(groupHome, '.credentials.json'))).toBe(groupBefore);
  });

  it('control: a legacy member into a legacy group home stays credential-only', async () => {
    const f = await fixture();
    await f.materialize('a', join(f.dir, 'A'), f.group('a', 1));
    const groupHome = f.home('a', f.group('a', 1));
    const member = f.home('a');
    for (const home of [member, groupHome]) {
      const manifestPath = join(home, DEFAULT_MANIFEST_NAME);
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      delete manifest.nativeSourceEnv;
      await writeFile(manifestPath, JSON.stringify(manifest));
    }
    const linkBefore = await readlink(join(groupHome, 'settings.json'));
    const credentialsBefore = await readFile(join(groupHome, '.credentials.json'), 'utf8');

    await f.materialize('a', join(f.dir, 'B'), f.group('a', 1), { authority: 'recorded' });
    expect(await readlink(join(groupHome, 'settings.json'))).toBe(linkBefore);
    expect(JSON.parse(await readFile(join(groupHome, DEFAULT_MANIFEST_NAME), 'utf8')).nativeSourceEnv).toBeUndefined();
    expect(await readFile(join(groupHome, '.credentials.json'), 'utf8')).not.toBe(credentialsBefore);
  });
});

describe('a self-source member carries its recorded origin into the group\'s scope check', () => {
  it('replays a group produced from a permitted HOME/.claude through the member home itself', async () => {
    const f = await fixture();
    const source = join(f.dir, 'home', '.claude');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'settings.json'), JSON.stringify({ source: 'A', cleanupPeriodDays: 99999 }));
    await f.materialize('a', source, f.group('a', 1));
    const before = await f.observe(f.home('a', f.group('a', 1)));

    const result = await f.materialize('a', f.home('a'), f.group('a', 2));
    expect(result?.diagnostics).toEqual([]);
    const after = await f.observe(f.home('a', f.group('a', 2)));
    expect(after.settings).toEqual(before.settings);
    expect(JSON.parse(after.manifest).nativeSourceEnv).toEqual(JSON.parse(before.manifest).nativeSourceEnv);
  });

  it('control: a self-source member whose origin is an unrelated ambient home is still refused', async () => {
    const f = await fixture();
    // The member records B as its origin, but its settings link was repointed into the ambient HOME/.claude.
    await f.materialize('a', join(f.dir, 'B'));
    const ambient = join(f.dir, 'home', '.claude');
    await mkdir(ambient, { recursive: true });
    await writeFile(join(ambient, 'settings.json'), JSON.stringify({ source: 'ambient' }));
    const memberSettings = join(f.home('a'), 'settings.json');
    const { rm, symlink } = await import('node:fs/promises');
    await rm(memberSettings);
    await symlink(join(ambient, 'settings.json'), memberSettings);

    const result = await f.materialize('a', f.home('a'), f.group('a', 1));
    expect(result?.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'claude_configuration_source_outside_permitted_scope' }),
    ]));
  });
});

describe('a recorded Claude source replays every home operand the reader uses', () => {
  function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    try {
      return run();
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  }

  it.each(['win32', 'linux'] as const)('%s: a default-layout source A is read from A whatever the rematerializer\'s USERPROFILE and HOME', (platform) => {
    withPlatform(platform, () => {
      const caller = { HOME: '/synthetic/A', USERPROFILE: '/synthetic/A' };
      const daemon = { HOME: '/synthetic/B', USERPROFILE: '/synthetic/B' };
      const admitted = claudeNativeSourceFromEnv(caller);
      const replay = claudeNativeSourceEnv(admitted, daemon);
      expect(resolveConfiguredClaudeConfigDir({ env: replay })).toBe(resolveConfiguredClaudeConfigDir({ env: caller }));
      expect(resolveClaudeRootConfigPathCandidates(replay)).toEqual(resolveClaudeRootConfigPathCandidates(caller));
    });
  });

  it('win32: an explicit config dir replays the config dir and its home', () => {
    withPlatform('win32', () => {
      const caller = { HOME: '/synthetic/A', USERPROFILE: '/synthetic/A', CLAUDE_CONFIG_DIR: '/synthetic/A-config' };
      const replay = claudeNativeSourceEnv(claudeNativeSourceFromEnv(caller), { HOME: '/synthetic/B', USERPROFILE: '/synthetic/B' });
      expect(resolveConfiguredClaudeConfigDir({ env: replay })).toBe('/synthetic/A-config');
      expect(claudeNativeSourceFromEnv(replay)).toEqual(claudeNativeSourceFromEnv(caller));
    });
  });
});
