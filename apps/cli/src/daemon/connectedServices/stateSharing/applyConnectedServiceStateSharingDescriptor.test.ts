import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ConnectedServiceStateSharingDescriptor } from '@/backends/types';
import { describe, expect, it } from 'vitest';

import { applyConnectedServiceStateSharingDescriptor } from './applyConnectedServiceStateSharingDescriptor';

function createDescriptor(params: Readonly<{
  configEntries?: ConnectedServiceStateSharingDescriptor['config']['entries'];
  stateEntries?: ConnectedServiceStateSharingDescriptor['state']['entries'];
}> = {}): ConnectedServiceStateSharingDescriptor {
  return {
    providerId: 'codex',
    providerSupportStatus: 'supported',
    config: {
      supported: true,
      modes: ['linked', 'copied', 'isolated'],
      entries: params.configEntries ?? [],
    },
    state: {
      supported: true,
      modes: ['shared', 'isolated'],
      entries: params.stateEntries ?? [],
      symlinkUnavailableDegradePolicy: 'degrade_to_isolated',
    },
    authIsolation: {
      mode: 'materialized_home',
      secretEntries: ['auth.json'],
    },
  };
}

describe('applyConnectedServiceStateSharingDescriptor', () => {
  it('materializes descriptor entries and emits extended manifest metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(join(sourceRoot, 'config.toml'), 'model = "gpt-5.3-codex"\n');
      await writeFile(join(sourceRoot, 'session_index.jsonl'), '{"id":"source"}\n');

      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'config.toml', mode: 'linked_or_copied' }],
          stateEntries: [{ path: 'session_index.jsonl', mode: 'linked' }],
        }),
        nativeSourceContext: {
          sourceRoot,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'copied',
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        cwd: root,
      });

      await expect(readFile(join(targetRoot, 'config.toml'), 'utf8')).resolves.toBe('model = "gpt-5.3-codex"\n');
      await expect(readFile(join(targetRoot, 'session_index.jsonl'), 'utf8')).resolves.toBe('{"id":"source"}\n');
      expect(result.envOverrides).toEqual({});
      expect(result.diagnostics).toEqual([]);
      expect(result.manifest).toMatchObject({
        v: 1,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        configEntries: ['config.toml'],
        stateEntries: ['session_index.jsonl'],
        sessionFileMappings: [],
        diagnostics: [],
      });
      expect(result.manifest.lastSyncAtMs).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails fast in dev builds when native source root is nested under target root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-invariant-'));
    const targetRoot = join(root, 'target');
    const nestedSource = join(targetRoot, 'native-source');
    try {
      await mkdir(nestedSource, { recursive: true });
      await writeFile(join(nestedSource, 'config.toml'), 'model = "nested"\n');

      await expect(applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'config.toml', mode: 'copied' }],
        }),
        nativeSourceContext: {
          sourceRoot: nestedSource,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'copied',
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        cwd: root,
      })).rejects.toThrow('nativeSourceContext.sourceRoot must not be nested under target.targetMaterializedRoot');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows migration reads under target root only through explicit existing-materialized allowlists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-migration-'));
    const targetRoot = join(root, 'target');
    const legacySource = join(targetRoot, 'legacy-source');
    try {
      await mkdir(legacySource, { recursive: true });
      await writeFile(join(legacySource, 'config.toml'), 'model = "legacy"\n');

      await expect(applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'config.toml', mode: 'copied' }],
        }),
        nativeSourceContext: {
          sourceRoot: legacySource,
          sourceEnv: {},
        },
        existingMaterializedStateContext: {
          previousMaterializedRoot: targetRoot,
          allowedRelativePaths: ['legacy-source'],
          expiresAfterRelease: '2026.06',
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'copied',
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        cwd: root,
      })).resolves.toMatchObject({
        manifest: expect.objectContaining({
          configEntries: ['config.toml'],
        }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('applies declarative rewrite_toml transform and force_copied mode for config entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-transform-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(
        join(sourceRoot, 'config.toml'),
        [
          'model = "gpt-5.3-codex"',
          'model_context_window = 9223372036854775807',
          'cli_auth_credentials_store = "keyring"',
          '',
          '[features]',
          'multi_agent = true',
          '',
        ].join('\n'),
      );

      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: {
          ...createDescriptor({
            configEntries: [{ path: 'config.toml', mode: 'force_copied' }],
          }),
          transforms: [
            {
              entry: 'config.toml',
              kind: 'rewrite_toml',
              spec: {
                setStringValues: {
                  cli_auth_credentials_store: 'file',
                },
              },
            },
          ],
        },
        nativeSourceContext: {
          sourceRoot,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'linked',
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        cwd: root,
      });

      expect(result.manifest.configEntries).toEqual(['config.toml']);
      const stat = await lstat(join(targetRoot, 'config.toml'));
      expect(stat.isSymbolicLink()).toBe(false);
      const transformed = await readFile(join(targetRoot, 'config.toml'), 'utf8');
      expect(transformed).toContain('cli_auth_credentials_store = "file"');
      expect(transformed).toContain('model_context_window = 9223372036854775807');
      expect(transformed).not.toContain('cli_auth_credentials_store = "keyring"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('preserves imported session files when linked state source is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-import-preserve-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    const legacyImportRoot = join(root, 'legacy');
    const sessionFileName = '2026-05-21T00-00-00-000Z_pi-session-1.jsonl';
    try {
      await mkdir(sourceRoot, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await mkdir(legacyImportRoot, { recursive: true });
      await writeFile(join(legacyImportRoot, sessionFileName), '{"id":"pi-session-1"}\n');

      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          stateEntries: [{ path: 'sessions/--tmp-project--', mode: 'linked' }],
        }),
        nativeSourceContext: {
          sourceRoot,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'isolated',
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        cwd: '/tmp/project',
        preserveDestinationWhenStateSourceMissing: (entryName: string) => entryName === 'sessions/--tmp-project--',
        sessionImportRoots: [
          {
            sourceRoot: legacyImportRoot,
            destinationRoot: join(targetRoot, 'sessions', '--tmp-project--'),
            includeFile: (relativePath: string) => relativePath.toLowerCase().endsWith('.jsonl'),
          },
        ],
        resolveVendorResumeIdFromImportedFile: () => 'pi-session-1',
      });

      await expect(
        readFile(join(targetRoot, 'sessions', '--tmp-project--', sessionFileName), 'utf8'),
      ).resolves.toBe('{"id":"pi-session-1"}\n');
      expect(result.manifest.stateEntries).toEqual([]);
      expect(result.manifest.sessionFileMappings).toEqual([
        expect.objectContaining({
          vendorResumeId: 'pi-session-1',
          destinationPath: join(targetRoot, 'sessions', '--tmp-project--', sessionFileName),
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('copies config directories while skipping dangling symlinks inside them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-state-sharing-descriptor-dangling-'));
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    const sharedSkillsRoot = join(root, 'shared-skills');
    try {
      await mkdir(join(sourceRoot, 'skills'), { recursive: true });
      await mkdir(sharedSkillsRoot, { recursive: true });
      await mkdir(targetRoot, { recursive: true });
      await writeFile(join(sharedSkillsRoot, 'reviewer.md'), '# Reviewer\n');
      await symlink(join(sharedSkillsRoot, 'reviewer.md'), join(sourceRoot, 'skills', 'reviewer.md'));
      await symlink(join(root, 'missing-skill.md'), join(sourceRoot, 'skills', 'missing.md'));

      const result = await applyConnectedServiceStateSharingDescriptor({
        descriptor: createDescriptor({
          configEntries: [{ path: 'skills', mode: 'copied' }],
        }),
        nativeSourceContext: {
          sourceRoot,
          sourceEnv: {},
        },
        target: {
          targetMaterializedRoot: targetRoot,
          targetMaterializedEnv: {},
        },
        configMode: 'copied',
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        cwd: root,
      });

      expect(result.manifest.configEntries).toEqual(['skills']);
      await expect(readFile(join(targetRoot, 'skills', 'reviewer.md'), 'utf8')).resolves.toBe('# Reviewer\n');
      await expect(lstat(join(targetRoot, 'skills', 'reviewer.md'))).resolves.toMatchObject({
        isSymbolicLink: expect.any(Function),
      });
      expect((await lstat(join(targetRoot, 'skills', 'reviewer.md'))).isSymbolicLink()).toBe(false);
      await expect(lstat(join(targetRoot, 'skills', 'missing.md'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
