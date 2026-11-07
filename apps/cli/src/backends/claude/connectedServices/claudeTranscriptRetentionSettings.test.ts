import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { syncClaudeConnectedServiceHome } from './syncClaudeConnectedServiceHome';
import { CLAUDE_HOME_TRANSCRIPT_RETENTION_CLEANUP_PERIOD_DAYS as RETAIN } from './claudeTranscriptRetentionSettings';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(sourceSettings: string | null) {
  const root = await mkdtemp(join(tmpdir(), 'happier-claude-retention-settings-'));
  roots.push(root);
  const source = join(root, 'native-claude');
  const target = join(root, 'materialized', 'claude-config');
  await mkdir(join(source, 'projects'), { recursive: true });
  if (sourceSettings !== null) await writeFile(join(source, 'settings.json'), sourceSettings);
  const sync = async (configMode: 'linked' | 'copied' | 'isolated') => await syncClaudeConnectedServiceHome({
    sourceEnv: { HOME: root, CLAUDE_CONFIG_DIR: source },
    targetDir: target,
    sharingPolicyOverride: { configMode, stateMode: 'shared' },
  });
  const readTarget = async () => JSON.parse(await readFile(join(target, 'settings.json'), 'utf8')) as Record<string, unknown>;
  return { root, source, target, sync, readTarget };
}

describe('materialized Claude home transcript retention default', () => {
  it.each(['linked', 'copied', 'isolated'] as const)('provides a non-expiring default for a %s home whose source has no settings.json', async (configMode) => {
    const { source, target, sync, readTarget } = await fixture(null);
    await sync(configMode);
    expect((await lstat(join(target, 'settings.json'))).isFile()).toBe(true);
    expect(await readTarget()).toEqual({ cleanupPeriodDays: RETAIN });
    await expect(lstat(join(source, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Resynchronization is stable and still never writes the source.
    await sync(configMode);
    expect(await readTarget()).toEqual({ cleanupPeriodDays: RETAIN });
    await expect(lstat(join(source, 'settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['linked', 'copied'] as const)('adds the default to %s source settings without mutating the source home', async (configMode) => {
    const { source, target, sync, readTarget } = await fixture('{"theme":"dark"}');
    await sync(configMode);
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(false);
    expect(await readTarget()).toEqual({ theme: 'dark', cleanupPeriodDays: RETAIN });
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');
    // Later source edits still reach the home at its next materialization.
    await writeFile(join(source, 'settings.json'), '{"theme":"light"}');
    await sync(configMode);
    expect(await readTarget()).toEqual({ theme: 'light', cleanupPeriodDays: RETAIN });
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe('{"theme":"light"}');
  });

  it('keeps a user-provided cleanup period and the linked settings contract', async () => {
    const { source, target, sync, readTarget } = await fixture('{"cleanupPeriodDays":45}');
    await sync('linked');
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(true);
    expect(await realpath(join(target, 'settings.json'))).toBe(await realpath(join(source, 'settings.json')));
    expect(await readTarget()).toEqual({ cleanupPeriodDays: 45 });
    await sync('copied');
    expect((await lstat(join(target, 'settings.json'))).isFile()).toBe(true);
    expect(await readTarget()).toEqual({ cleanupPeriodDays: 45 });
  });

  it('restores the link once the source decides retention itself', async () => {
    const { source, target, sync, readTarget } = await fixture('{"theme":"dark"}');
    await sync('linked');
    expect(await readTarget()).toEqual({ theme: 'dark', cleanupPeriodDays: RETAIN });
    await writeFile(join(source, 'settings.json'), '{"theme":"dark","cleanupPeriodDays":3650}');
    await sync('linked');
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(true);
    expect(await readTarget()).toEqual({ theme: 'dark', cleanupPeriodDays: 3650 });
  });

  it('adds the default to private isolated settings and keeps an explicit private value', async () => {
    const { target, sync, readTarget } = await fixture('{"theme":"dark","cleanupPeriodDays":1}');
    await sync('isolated');
    // Isolated configuration inherits nothing from the source, including its cleanup period.
    expect(await readTarget()).toEqual({ cleanupPeriodDays: RETAIN });
    await writeFile(join(target, 'settings.json'), '{"theme":"private"}');
    await sync('isolated');
    expect(await readTarget()).toEqual({ theme: 'private', cleanupPeriodDays: RETAIN });
    await writeFile(join(target, 'settings.json'), '{"theme":"private","cleanupPeriodDays":7}');
    await sync('isolated');
    expect(await readTarget()).toEqual({ theme: 'private', cleanupPeriodDays: 7 });
  });

  it('leaves a settings link that belongs to another home to that owner', async () => {
    const { root, target, sync } = await fixture(null);
    const foreign = join(root, 'another-home', 'settings.json');
    await mkdir(join(root, 'another-home'), { recursive: true });
    await writeFile(foreign, '{"theme":"other"}');
    await mkdir(target, { recursive: true });
    await symlink(foreign, join(target, 'settings.json'));
    await sync('linked');
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(true);
    expect(await readFile(foreign, 'utf8')).toBe('{"theme":"other"}');
  });

  it('leaves unparseable source settings to their owner', async () => {
    const { source, target, sync } = await fixture('{not json');
    await sync('linked');
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(true);
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe('{not json');
  });
});

describe('materialized Claude settings projection never aliases the native settings inode', () => {
  // A managed settings entry can already be a hardlink to the native file (link fallback or an
  // older layout). Adding the default must detach that private projection, not write through it.
  it.each(['linked', 'copied'] as const)('detaches a hardlinked %s projection before adding the default', async (configMode) => {
    const { source, target, sync, readTarget } = await fixture('{"theme":"dark","cleanupPeriodDays":45}');
    await sync(configMode);
    await unlink(join(target, 'settings.json'));
    await link(join(source, 'settings.json'), join(target, 'settings.json'));
    await writeFile(join(source, 'settings.json'), '{"theme":"light"}');
    const nativeBefore = await stat(join(source, 'settings.json'));

    await sync(configMode);

    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe('{"theme":"light"}');
    const [nativeAfter, projection] = await Promise.all([stat(join(source, 'settings.json')), lstat(join(target, 'settings.json'))]);
    expect(nativeAfter.ino).toBe(nativeBefore.ino);
    expect(nativeAfter.nlink).toBe(1);
    expect(projection.isFile()).toBe(true);
    expect(projection.ino).not.toBe(nativeAfter.ino);
    expect(await readTarget()).toEqual({ theme: 'light', cleanupPeriodDays: RETAIN });
    // Resynchronization keeps the private projection detached and the native bytes unchanged.
    await sync(configMode);
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe('{"theme":"light"}');
    expect((await lstat(join(target, 'settings.json'))).ino).not.toBe(nativeAfter.ino);
  });

  it('keeps a hardlinked projection of explicit native settings as the user-owned link', async () => {
    const { source, target, sync, readTarget } = await fixture('{"theme":"dark","cleanupPeriodDays":45}');
    await sync('linked');
    await unlink(join(target, 'settings.json'));
    await link(join(source, 'settings.json'), join(target, 'settings.json'));
    await sync('linked');
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe('{"theme":"dark","cleanupPeriodDays":45}');
    expect(await readTarget()).toEqual({ theme: 'dark', cleanupPeriodDays: 45 });
  });

  it('replaces a symlinked projection instead of writing through it', async () => {
    const { source, target, sync, readTarget } = await fixture('{"theme":"dark","cleanupPeriodDays":45}');
    await sync('linked');
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(true);
    await writeFile(join(source, 'settings.json'), '{"theme":"light"}');
    await sync('linked');
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe('{"theme":"light"}');
    expect((await lstat(join(target, 'settings.json'))).isSymbolicLink()).toBe(false);
    expect(await readTarget()).toEqual({ theme: 'light', cleanupPeriodDays: RETAIN });
  });

  it('does not write through a hardlinked private settings file under isolated configuration', async () => {
    const { source, target, sync, readTarget } = await fixture('{"theme":"light"}');
    await sync('isolated');
    await unlink(join(target, 'settings.json'));
    await link(join(source, 'settings.json'), join(target, 'settings.json'));
    await sync('isolated');
    expect(await readFile(join(source, 'settings.json'), 'utf8')).toBe('{"theme":"light"}');
    expect((await lstat(join(target, 'settings.json'))).ino).not.toBe((await stat(join(source, 'settings.json'))).ino);
    expect(await readTarget()).toEqual({ theme: 'light', cleanupPeriodDays: RETAIN });
  });
});
