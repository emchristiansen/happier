import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { deleteConnectedServiceHomeCredentials } from '../credentials/deleteConnectedServiceHomeCredentials';

import { createAdoptedExecutionRunRootCleanup } from './createAdoptedExecutionRunRootCleanup';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';

describe('createAdoptedExecutionRunRootCleanup', () => {
  it('accepts only a strict descendant of the canonical materialization base', async () => {
    const retireRoot = vi.fn(async () => undefined);
    const expectedRoot = resolveConnectedServiceMaterializedRootDir({
      baseDir: '/managed/materialized',
      agentId: 'codex',
      materializationKey: 'execution_run:one',
    });
    expect(createAdoptedExecutionRunRootCleanup({
      materializationBaseDir: '/managed/materialized',
      materializedRoot: expectedRoot,
      agentId: 'codex',
      materializationKey: 'execution_run:one',
      retireRoot,
    })).not.toBeNull();
    expect(createAdoptedExecutionRunRootCleanup({
      materializationBaseDir: '/managed/materialized',
      materializedRoot: '/managed/materialized',
      agentId: 'codex',
      materializationKey: 'execution_run:one',
      retireRoot,
    })).toBeNull();
    expect(createAdoptedExecutionRunRootCleanup({
      materializationBaseDir: '/managed/materialized',
      materializedRoot: '/managed/materialized-sibling/run-one',
      agentId: 'codex',
      materializationKey: 'execution_run:one',
      retireRoot,
    })).toBeNull();
    expect(createAdoptedExecutionRunRootCleanup({
      materializationBaseDir: '/managed/materialized',
      materializedRoot: '/managed/materialized/../outside',
      agentId: 'codex',
      materializationKey: 'execution_run:one',
      retireRoot,
    })).toBeNull();
    expect(createAdoptedExecutionRunRootCleanup({
      materializationBaseDir: '/managed/materialized',
      materializedRoot: '/managed/materialized/another-run/codex',
      agentId: 'codex',
      materializationKey: 'execution_run:one',
      retireRoot,
    })).toBeNull();
  });

  it('revokes an adopted ephemeral Run credential without deleting its transcript', async () => {
    const base = await mkdtemp(join(tmpdir(), 'happier-adopted-history-'));
    try {
      const root = resolveConnectedServiceMaterializedRootDir({ baseDir: base, agentId: 'codex', materializationKey: 'execution_run:one' });
      await mkdir(join(root, 'codex-home', 'sessions'), { recursive: true });
      await writeFile(join(root, 'codex-home', 'auth.json'), 'synthetic Run credential');
      await writeFile(join(root, 'codex-home', 'sessions', 'session.jsonl'), 'distinct Run history\n');
      const cleanup = createAdoptedExecutionRunRootCleanup({
        materializationBaseDir: base, materializedRoot: root, agentId: 'codex',
        materializationKey: 'execution_run:one', retentionPolicy: 'ephemeral',
        retireRoot: async (rootDir) => await deleteConnectedServiceHomeCredentials({ rootDir, agentId: 'codex', kind: 'materialized_home' }),
      });
      await cleanup?.();
      expect(await readFile(join(root, 'codex-home', 'sessions', 'session.jsonl'), 'utf8')).toBe('distinct Run history\n');
      await expect(stat(join(root, 'codex-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it('does not follow a symlinked canonical parent outside the materialization base', async () => {
    const sandbox = await mkdtemp(join(tmpdir(), 'happier-adopted-root-'));
    try {
      const base = join(sandbox, 'managed');
      const outside = join(sandbox, 'outside');
      const expectedRoot = resolveConnectedServiceMaterializedRootDir({
        baseDir: base,
        agentId: 'codex',
        materializationKey: 'execution_run:one',
      });
      await mkdir(base, { recursive: true });
      await mkdir(join(outside, 'codex'), { recursive: true });
      await symlink(outside, dirname(expectedRoot), 'dir');
      const retireRoot = vi.fn(async () => undefined);
      const cleanup = createAdoptedExecutionRunRootCleanup({
        materializationBaseDir: base,
        materializedRoot: expectedRoot,
        agentId: 'codex',
        materializationKey: 'execution_run:one',
        retentionPolicy: 'ephemeral',
        retireRoot,
      });

      await cleanup?.();

      expect(retireRoot).not.toHaveBeenCalled();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
