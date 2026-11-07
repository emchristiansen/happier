import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectedServiceStateSharingDescriptor } from '@/backends/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

const descriptor: ConnectedServiceStateSharingDescriptor = {
  providerId: 'claude',
  providerSupportStatus: 'supported',
  config: { supported: true, modes: ['linked', 'copied', 'isolated'], entries: [] },
  state: {
    supported: true,
    modes: ['shared', 'isolated'],
    entries: [{ path: 'projects', mode: 'linked' }],
    symlinkUnavailableDegradePolicy: 'block_continuity',
  },
  authIsolation: { mode: 'materialized_home', secretEntries: [] },
};

function createRenameError(code: string): NodeJS.ErrnoException {
  const error = new Error(`injected ${code} destination race`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

async function applyDescriptor(params: Readonly<{
  root: string;
  sourceRoot: string;
  targetRoot: string;
}>): Promise<void> {
  const { applyConnectedServiceStateSharingDescriptor } = await import('./applyConnectedServiceStateSharingDescriptor');
  await applyConnectedServiceStateSharingDescriptor({
    descriptor,
    nativeSourceContext: { sourceRoot: params.sourceRoot, sourceEnv: {} },
    target: { targetMaterializedRoot: params.targetRoot, targetMaterializedEnv: {} },
    configMode: 'isolated',
    requestedStateMode: 'shared',
    effectiveStateMode: 'shared',
    cwd: params.root,
  });
}

describe('applyConnectedServiceStateSharingDescriptor destination races', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:fs/promises');
    vi.resetModules();
  });

  it('blocks continuity when required state symlinks are unavailable without replacing private state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-link-unavailable-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(join(sourceRoot, 'projects'), { recursive: true });
      await writeFile(join(sourceRoot, 'projects', 'source.jsonl'), '{"id":"source"}\n');
      await mkdir(join(targetRoot, 'projects'), { recursive: true });
      await writeFile(join(targetRoot, 'projects', 'private.jsonl'), '{"id":"private"}\n');
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          symlink: async () => {
            const error = new Error('symlink unavailable') as NodeJS.ErrnoException;
            error.code = 'EPERM';
            throw error;
          },
        };
      });

      await expect(applyDescriptor({ root, sourceRoot, targetRoot })).rejects.toMatchObject({
        code: 'state_symlink_unavailable',
      });
      await expect(readFile(join(targetRoot, 'projects', 'private.jsonl'), 'utf8')).resolves.toBe('{"id":"private"}\n');
      await expect(readFile(join(sourceRoot, 'projects', 'source.jsonl'), 'utf8')).resolves.toBe('{"id":"source"}\n');
      expect((await readdir(targetRoot)).some((name) => name.includes('.happier-link-'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refreshes owned linked-config fallback copies without accumulating private backups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-config-fallback-repeat-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(join(sourceRoot, 'settings.json'), 'source-one');
      await writeFile(join(targetRoot, 'settings.json'), 'private-original');
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return { ...actual, symlink: async () => { throw createRenameError('EPERM'); } };
      });
      const { applyConnectedServiceStateSharingDescriptor: apply } = await import('./applyConnectedServiceStateSharingDescriptor');
      const input = {
        descriptor: { ...descriptor, config: { ...descriptor.config, entries: [{ path: 'settings.json', mode: 'linked' as const }] } },
        nativeSourceContext: { sourceRoot, sourceEnv: {} },
        target: { targetMaterializedRoot: targetRoot, targetMaterializedEnv: {} },
        configMode: 'linked', requestedStateMode: 'isolated', effectiveStateMode: 'isolated', cwd: root,
      } as const;
      const first = await apply(input);
      const privateBackups = (await readdir(targetRoot)).filter(name => name.startsWith('settings.json.local-'));
      expect(privateBackups).toHaveLength(1);
      const before = await lstat(join(targetRoot, 'settings.json'));
      await apply({ ...input, existingManifest: first.manifest });
      expect((await lstat(join(targetRoot, 'settings.json'))).ino).toBe(before.ino);
      await writeFile(join(sourceRoot, 'settings.json'), 'source-two');
      await apply({ ...input, existingManifest: first.manifest });
      expect((await readdir(targetRoot)).filter(name => name.startsWith('settings.json.local-'))).toEqual(privateBackups);
      await expect(readFile(join(targetRoot, privateBackups[0]!), 'utf8')).resolves.toBe('private-original');
      await expect(readFile(join(targetRoot, 'settings.json'), 'utf8')).resolves.toBe('source-two');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['EISDIR', 'ENOTEMPTY', 'EEXIST', 'EPERM'] as const)(
    'preserves provider-created content and retries the same prepared link after %s',
    async (raceCode) => {
      const root = await mkdtemp(join(tmpdir(), 'happier-state-link-race-'));
      const sourceRoot = join(root, 'source');
      const targetRoot = join(root, 'target');
      const targetProjects = join(targetRoot, 'projects');
      const promotionSources: string[] = [];

      try {
        await mkdir(join(sourceRoot, 'projects'), { recursive: true });
        await writeFile(join(sourceRoot, 'projects', 'session.jsonl'), '{"type":"assistant"}\n');
        await mkdir(targetRoot, { recursive: true });

        vi.doMock('node:fs/promises', async () => {
          const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
          let injectedDestinationRace = false;
          return {
            ...actual,
            rename: vi.fn(async (sourcePath: string, destinationPath: string) => {
              if (sourcePath.includes('projects.happier-link-') && destinationPath === targetProjects) {
                promotionSources.push(sourcePath);
                if (!injectedDestinationRace) {
                  injectedDestinationRace = true;
                  await actual.mkdir(targetProjects, { recursive: true });
                  await actual.writeFile(join(targetProjects, 'provider-created.txt'), raceCode);
                  throw createRenameError(raceCode);
                }
              }
              return await actual.rename(sourcePath, destinationPath);
            }),
          };
        });

        await applyDescriptor({ root, sourceRoot, targetRoot });

        expect(promotionSources).toHaveLength(2);
        expect(new Set(promotionSources).size).toBe(1);
        expect((await lstat(targetProjects)).isSymbolicLink()).toBe(true);
        await expect(readFile(join(targetProjects, 'session.jsonl'), 'utf8')).resolves.toBe('{"type":"assistant"}\n');
        const preservedEntries = (await readdir(targetRoot)).filter((name) => name.startsWith('projects.local-'));
        expect(preservedEntries).toHaveLength(1);
        await expect(readFile(join(targetRoot, preservedEntries[0]!, 'provider-created.txt'), 'utf8')).resolves.toBe(raceCode);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('throws after exactly three destination races and removes the prepared temporary link', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const root = await mkdtemp(join(tmpdir(), 'happier-state-link-race-exhausted-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    const targetProjects = join(targetRoot, 'projects');
    const promotionSources: string[] = [];
    const terminalError = createRenameError('EEXIST');

    try {
      await mkdir(join(sourceRoot, 'projects'), { recursive: true });
      await writeFile(join(sourceRoot, 'projects', 'session.jsonl'), '{}\n');
      await mkdir(targetRoot, { recursive: true });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          rename: vi.fn(async (sourcePath: string, destinationPath: string) => {
            if (sourcePath.includes('projects.happier-link-') && destinationPath === targetProjects) {
              promotionSources.push(sourcePath);
              await actual.mkdir(targetProjects, { recursive: true });
              await actual.writeFile(join(targetProjects, `provider-${promotionSources.length}.txt`), 'preserve me');
              if (promotionSources.length === 3) throw terminalError;
              throw createRenameError('EEXIST');
            }
            return await actual.rename(sourcePath, destinationPath);
          }),
        };
      });

      await expect(applyDescriptor({ root, sourceRoot, targetRoot })).rejects.toBe(terminalError);
      expect(promotionSources).toHaveLength(3);
      expect(new Set(promotionSources).size).toBe(1);
      const targetEntries = await readdir(targetRoot);
      expect(targetEntries.some((name) => name.includes('.happier-link-'))).toBe(false);
      expect(targetEntries.filter((name) => name.startsWith('projects.local-'))).toHaveLength(2);
      await expect(readFile(join(targetProjects, 'provider-3.txt'), 'utf8')).resolves.toBe('preserve me');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('propagates a non-race rename error without retrying and removes the temporary link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-link-race-nonretry-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    const targetProjects = join(targetRoot, 'projects');
    const promotionSources: string[] = [];
    const permissionError = createRenameError('EACCES');

    try {
      await mkdir(join(sourceRoot, 'projects'), { recursive: true });
      await writeFile(join(sourceRoot, 'projects', 'session.jsonl'), '{}\n');
      await mkdir(targetRoot, { recursive: true });

      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
        return {
          ...actual,
          rename: vi.fn(async (sourcePath: string, destinationPath: string) => {
            if (sourcePath.includes('projects.happier-link-') && destinationPath === targetProjects) {
              promotionSources.push(sourcePath);
              throw permissionError;
            }
            return await actual.rename(sourcePath, destinationPath);
          }),
        };
      });

      await expect(applyDescriptor({ root, sourceRoot, targetRoot })).rejects.toBe(permissionError);
      expect(promotionSources).toHaveLength(1);
      expect((await readdir(targetRoot)).some((name) => name.includes('.happier-link-'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
