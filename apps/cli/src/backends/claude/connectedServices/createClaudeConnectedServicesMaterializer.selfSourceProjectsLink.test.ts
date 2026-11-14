import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createClaudeConnectedServicesMaterializer } from './createClaudeConnectedServicesMaterializer';
import { CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE } from './nativeAuth/claudeCodeCredentialScopes';

const ISSUED_AT_MS = Date.parse('2026-06-05T12:00:00.000Z');

function buildRecord() {
  return buildConnectedServiceCredentialRecord({
    now: ISSUED_AT_MS,
    serviceId: 'claude-subscription',
    profileId: 'oauth-profile',
    kind: 'oauth',
    expiresAt: ISSUED_AT_MS + 60 * 60 * 1000,
    oauth: {
      accessToken: 'fresh-access-placeholder',
      refreshToken: 'fresh-refresh-placeholder',
      idToken: null,
      scope: CLAUDE_CODE_RECOMMENDED_OAUTH_SCOPE,
      tokenType: 'Bearer',
      providerAccountId: null,
      providerEmail: null,
    },
  });
}

/**
 * A direct launch whose CLAUDE_CONFIG_DIR is the selected profile's own managed home (a self-source
 * home), as `happier claude --auth-json <profile>` does when started inside that home. The home was
 * produced earlier with its `projects` linked to a session store.
 */
async function setUp(linkTarget: (paths: Readonly<{ activeServerDir: string; storeDir: string }>) => string | null) {
  const activeServerDir = await mkdtemp(join(tmpdir(), 'happier-claude-self-link-server-'));
  const rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-self-link-root-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-self-link-home-'));
  const storeDir = await mkdtemp(join(tmpdir(), 'happier-claude-self-link-store-'));
  const homesRoot = join(activeServerDir, 'daemon', 'connected-services', 'homes');
  const targetDir = join(homesRoot, 'claude-subscription', 'oauth-profile', 'claude', 'claude-config');
  await mkdir(targetDir, { recursive: true });
  const storeProjects = join(storeDir, 'projects');
  const sessionFile = join(storeProjects, '-work', 'c7354b9f-9ad3-4169-82a9-8fa36734edb1.jsonl');
  await mkdir(join(storeProjects, '-work'), { recursive: true });
  await writeFile(sessionFile, '{"type":"user","uuid":"existing-history"}\n');
  const target = linkTarget({ activeServerDir, storeDir: storeProjects });
  if (target) await symlink(target, join(targetDir, 'projects'), 'dir');
  // A manifest from before sources were recorded: shared state, no nativeSourceEnv.
  await writeFile(join(targetDir, '.happier-state-sharing.json'), `${JSON.stringify({
    v: 1,
    requestedStateMode: 'shared',
    effectiveStateMode: 'shared',
    lastSyncAtMs: 1,
    configEntries: ['settings.json'],
    stateEntries: ['projects'],
    sessionFileMappings: [],
    diagnostics: [],
  })}\n`);
  const materialize = async () => await createClaudeConnectedServicesMaterializer()({
    nativeSourceAuthority: 'caller_env',
    agentId: 'claude',
    activeServerDir,
    rootDir,
    recordsByServiceId: new Map([['claude-subscription', buildRecord()]]),
    processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir, HAPPIER_CLAUDE_CONFIG_DIR: targetDir },
    sessionDirectory: '/work',
    cleanupRoot: () => {},
  });
  return { activeServerDir, homesRoot, targetDir, storeProjects, sessionFile, materialize };
}

const LINK_UNAVAILABLE = expect.objectContaining({ code: 'claude_shared_state_link_unavailable', severity: 'blocking' });

describe('self-source Claude home with an existing projects link', () => {
  it('keeps the link its producer made and publishes the selected credential', async () => {
    const env = await setUp(({ storeDir }) => storeDir);
    const linkBefore = await lstat(join(env.targetDir, 'projects'));

    const result = await env.materialize();

    expect(result).not.toBeNull();
    expect(result!.diagnostics).not.toContainEqual(LINK_UNAVAILABLE);
    expect((result!.diagnostics ?? []).filter((diagnostic) => diagnostic.severity === 'blocking')).toEqual([]);
    const linkAfter = await lstat(join(env.targetDir, 'projects'));
    expect(linkAfter.isSymbolicLink()).toBe(true);
    expect(linkAfter.ino).toBe(linkBefore.ino);
    expect(await readlink(join(env.targetDir, 'projects'))).toBe(env.storeProjects);
    expect(await readFile(env.sessionFile, 'utf8')).toBe('{"type":"user","uuid":"existing-history"}\n');
    const manifest = JSON.parse(await readFile(join(env.targetDir, '.happier-state-sharing.json'), 'utf8'));
    expect(manifest).toMatchObject({ requestedStateMode: 'shared', effectiveStateMode: 'shared', stateEntries: ['projects'], diagnostics: [] });
    const credential = JSON.parse(await readFile(join(env.targetDir, '.credentials.json'), 'utf8'));
    expect(credential.claudeAiOauth.accessToken).toBe('fresh-access-placeholder');
  });

  it('does not keep a link into another managed home', async () => {
    const env = await setUp(({ activeServerDir }) =>
      join(activeServerDir, 'daemon', 'connected-services', 'homes', 'claude-subscription', 'other-profile', 'claude', 'claude-config', 'projects'));
    await mkdir(join(env.homesRoot, 'claude-subscription', 'other-profile', 'claude', 'claude-config', 'projects'), { recursive: true });

    const result = await env.materialize();

    expect(result!.diagnostics).toContainEqual(LINK_UNAVAILABLE);
    expect((await lstat(join(env.targetDir, 'projects'))).isSymbolicLink()).toBe(true);
  });

  it('does not keep a dangling link', async () => {
    const env = await setUp(({ storeDir }) => join(storeDir, 'absent'));

    const result = await env.materialize();

    expect(result!.diagnostics).toContainEqual(LINK_UNAVAILABLE);
    expect(await readlink(join(env.targetDir, 'projects'))).toBe(join(env.storeProjects, 'absent'));
  });

  it('still creates no link when the home has none', async () => {
    const env = await setUp(() => null);

    const result = await env.materialize();

    expect(result!.diagnostics).toContainEqual(LINK_UNAVAILABLE);
    await expect(lstat(join(env.targetDir, 'projects'))).rejects.toThrow();
  });
});
