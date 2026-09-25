import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import { syncClaudeConnectedServiceHome } from './syncClaudeConnectedServiceHome';
import { verifyResumeReachableClaude } from './verifyResumeReachableClaude';

const PROJECT_DIR_NAME = '-Users-leeroy-Documents-Development-happier-remote-dev';
const VENDOR_RESUME_ID = '4b9434a8-b115-4363-851a-f39fff76a94b';

async function makeSelfSourceHome(): Promise<Readonly<{ homeDir: string; targetDir: string; ambientDir: string }>> {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-home-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-target-'));
  const ambientDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-ambient-'));
  return { homeDir, targetDir, ambientDir };
}

async function setFileMtime(path: string, atMs: number): Promise<void> {
  const seconds = atMs / 1000;
  await utimes(path, seconds, seconds);
}

describe('syncClaudeConnectedServiceHome self-source sharing-policy reconciliation', () => {
  it('converts an isolated self-source projects dir into a shared-store link when sharing is toggled on', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const isolatedProjectDir = join(targetDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(isolatedProjectDir, { recursive: true });
    await writeFile(join(isolatedProjectDir, `${VENDOR_RESUME_ID}.jsonl`), '{"type":"assistant","text":"isolated era session"}\n');

    const result = await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
    });

    expect(result.requestedStateMode).toBe('shared');
    expect(result.effectiveStateMode).toBe('shared');

    const projectsStat = await lstat(join(targetDir, 'projects'));
    expect(projectsStat.isSymbolicLink()).toBe(true);
    await expect(realpath(join(targetDir, 'projects'))).resolves.toBe(await realpath(join(ambientDir, 'projects')));

    // The isolated-era session file is preserved into the shared store and stays reachable through the link.
    await expect(
      readFile(join(ambientDir, 'projects', PROJECT_DIR_NAME, `${VENDOR_RESUME_ID}.jsonl`), 'utf8'),
    ).resolves.toContain('isolated era session');
    await expect(verifyResumeReachableClaude({
      vendorResumeId: VENDOR_RESUME_ID,
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
    })).resolves.toMatchObject({ ok: true });

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    expect(manifest.requestedStateMode).toBe('shared');
    expect(manifest.effectiveStateMode).toBe('shared');
    expect(manifest.stateEntries).toContain('projects');
  });

  it('detaches the shared projects link into an isolated dir when sharing is toggled off', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const ambientProjectDir = join(ambientDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(ambientProjectDir, { recursive: true });
    await writeFile(join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`), '{"type":"assistant","text":"shared era session"}\n');
    await symlink(join(ambientDir, 'projects'), join(targetDir, 'projects'), 'dir');

    const result = await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'isolated' },
      ambientStateSourceDir: ambientDir,
    });

    expect(result.requestedStateMode).toBe('isolated');
    expect(result.effectiveStateMode).toBe('isolated');

    const projectsStat = await lstat(join(targetDir, 'projects'));
    expect(projectsStat.isSymbolicLink()).toBe(false);
    expect(projectsStat.isDirectory()).toBe(true);
    await expect(readdir(join(targetDir, 'projects'))).resolves.toEqual([]);

    // Ambient sessions stay in the ambient store untouched — nothing is deleted by the detach.
    await expect(
      readFile(join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`), 'utf8'),
    ).resolves.toContain('shared era session');

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    expect(manifest.requestedStateMode).toBe('isolated');
    expect(manifest.effectiveStateMode).toBe('isolated');
    expect(manifest.stateEntries).toEqual([]);
  });
});

describe('syncClaudeConnectedServiceHome candidate session import reconciliation', () => {
  it('keeps the newest canonical jsonl and removes stale conflict copies instead of leaving divergent imports', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const ambientProjectDir = join(ambientDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(ambientProjectDir, { recursive: true });
    const canonicalPath = join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(canonicalPath, '{"type":"assistant","text":"canonical newest content"}\n');
    const staleConflictPath = join(ambientProjectDir, `${VENDOR_RESUME_ID}.happier-import-deadbeef0000.jsonl`);
    await writeFile(staleConflictPath, '{"type":"assistant","text":"frozen import"}\n');
    await setFileMtime(staleConflictPath, Date.now() - 60 * 60 * 1000);
    await symlink(join(ambientDir, 'projects'), join(targetDir, 'projects'), 'dir');

    const previousHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-previous-'));
    const candidateDir = join(previousHomeDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(candidateDir, { recursive: true });
    const candidatePath = join(candidateDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(candidatePath, '{"type":"assistant","text":"older divergent source"}\n');
    await setFileMtime(candidatePath, Date.now() - 30 * 60 * 1000);

    await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
      vendorResumeId: VENDOR_RESUME_ID,
      candidatePersistedSessionFile: candidatePath,
    });

    // Canonical newest content wins; no conflict copy remains for the resume id.
    await expect(readFile(canonicalPath, 'utf8')).resolves.toContain('canonical newest content');
    const entries = await readdir(ambientProjectDir);
    expect(entries.filter((entry) => entry.includes('.happier-import-'))).toEqual([]);

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    const mapping = manifest.sessionFileMappings.find((item) => item.vendorResumeId === VENDOR_RESUME_ID);
    expect(mapping?.destinationPath.endsWith(`${VENDOR_RESUME_ID}.jsonl`)).toBe(true);
    expect(mapping?.destinationPath.includes('.happier-import-')).toBe(false);
  });

  it('promotes a newer candidate session file over a stale canonical copy', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const ambientProjectDir = join(ambientDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(ambientProjectDir, { recursive: true });
    const canonicalPath = join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(canonicalPath, '{"type":"assistant","text":"stale canonical"}\n');
    await setFileMtime(canonicalPath, Date.now() - 60 * 60 * 1000);
    await symlink(join(ambientDir, 'projects'), join(targetDir, 'projects'), 'dir');

    const previousHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-previous-'));
    const candidateDir = join(previousHomeDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(candidateDir, { recursive: true });
    const candidatePath = join(candidateDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(candidatePath, '{"type":"assistant","text":"newer real session"}\n');

    await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
      vendorResumeId: VENDOR_RESUME_ID,
      candidatePersistedSessionFile: candidatePath,
    });

    await expect(readFile(canonicalPath, 'utf8')).resolves.toContain('newer real session');
    const entries = await readdir(ambientProjectDir);
    expect(entries.filter((entry) => entry.includes('.happier-import-'))).toEqual([]);

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    const mapping = manifest.sessionFileMappings.find((item) => item.vendorResumeId === VENDOR_RESUME_ID);
    expect(mapping?.destinationPath).toBe(canonicalPath);
  });
});

describe('syncClaudeConnectedServiceHome global guidance', () => {
  async function makeGuidanceFixture(): Promise<Readonly<{
    homeDir: string;
    sourceDir: string;
    targetDir: string;
    workspaceDir: string;
  }>> {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-home-'));
    const sourceDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-target-'));
    const workspaceDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-workspace-'));
    await writeFile(join(sourceDir, 'settings.json'), '{"theme":"dark"}\n');
    await writeFile(join(workspaceDir, 'CLAUDE.md'), '# Workspace guidance\n');
    await mkdir(join(workspaceDir, '.claude'), { recursive: true });
    await writeFile(join(workspaceDir, '.claude', 'CLAUDE.md'), '# Workspace dot-claude guidance\n');
    return { homeDir, sourceDir, targetDir, workspaceDir };
  }

  it('links the native CLAUDE.md while other config entries stay copied, and never materializes workspace guidance', async () => {
    const { homeDir, sourceDir, targetDir, workspaceDir } = await makeGuidanceFixture();
    await writeFile(join(sourceDir, 'CLAUDE.md'), '# Global guidance\n');

    await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      targetDir,
      sessionDirectory: workspaceDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'isolated' },
    });

    expect((await lstat(join(targetDir, 'CLAUDE.md'))).isSymbolicLink()).toBe(true);
    await expect(readlink(join(targetDir, 'CLAUDE.md'))).resolves.toBe(join(sourceDir, 'CLAUDE.md'));
    await expect(readFile(join(targetDir, 'CLAUDE.md'), 'utf8')).resolves.toBe('# Global guidance\n');
    expect((await lstat(join(targetDir, 'settings.json'))).isSymbolicLink()).toBe(false);
    await expect(lstat(join(targetDir, '.claude'))).rejects.toThrow();
    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    expect(manifest.configEntries).toContain('CLAUDE.md');
  });

  it('materializes no global guidance when config sharing is isolated', async () => {
    const { homeDir, sourceDir, targetDir, workspaceDir } = await makeGuidanceFixture();
    await writeFile(join(sourceDir, 'CLAUDE.md'), '# Global guidance\n');

    await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      targetDir,
      sessionDirectory: workspaceDir,
      sharingPolicyOverride: { configMode: 'isolated', stateMode: 'isolated' },
    });

    await expect(lstat(join(targetDir, 'CLAUDE.md'))).rejects.toThrow();
  });

  it('creates no dangling guidance link when the native config dir has no CLAUDE.md', async () => {
    const { homeDir, sourceDir, targetDir, workspaceDir } = await makeGuidanceFixture();

    await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: sourceDir },
      targetDir,
      sessionDirectory: workspaceDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'isolated' },
    });

    await expect(lstat(join(targetDir, 'CLAUDE.md'))).rejects.toThrow();
  });
});
