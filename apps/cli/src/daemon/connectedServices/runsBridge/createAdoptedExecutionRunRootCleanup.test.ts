import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createAdoptedExecutionRunRootCleanup } from './createAdoptedExecutionRunRootCleanup';
import { resolveConnectedServiceMaterializedRootDir } from '../materialize/resolveConnectedServiceMaterializedRootDir';

describe('createAdoptedExecutionRunRootCleanup', () => {
  it('accepts only a strict descendant of the canonical materialization base', async () => {
    const removeRoot = vi.fn(async () => undefined);
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
      removeRoot,
    })).not.toBeNull();
    expect(createAdoptedExecutionRunRootCleanup({
      materializationBaseDir: '/managed/materialized',
      materializedRoot: '/managed/materialized',
      agentId: 'codex',
      materializationKey: 'execution_run:one',
      removeRoot,
    })).toBeNull();
    expect(createAdoptedExecutionRunRootCleanup({
      materializationBaseDir: '/managed/materialized',
      materializedRoot: '/managed/materialized-sibling/run-one',
      agentId: 'codex',
      materializationKey: 'execution_run:one',
      removeRoot,
    })).toBeNull();
    expect(createAdoptedExecutionRunRootCleanup({
      materializationBaseDir: '/managed/materialized',
      materializedRoot: '/managed/materialized/../outside',
      agentId: 'codex',
      materializationKey: 'execution_run:one',
      removeRoot,
    })).toBeNull();
    expect(createAdoptedExecutionRunRootCleanup({
      materializationBaseDir: '/managed/materialized',
      materializedRoot: '/managed/materialized/another-run/codex',
      agentId: 'codex',
      materializationKey: 'execution_run:one',
      removeRoot,
    })).toBeNull();
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
      const removeRoot = vi.fn(async () => undefined);
      const cleanup = createAdoptedExecutionRunRootCleanup({
        materializationBaseDir: base,
        materializedRoot: expectedRoot,
        agentId: 'codex',
        materializationKey: 'execution_run:one',
        retentionPolicy: 'ephemeral',
        removeRoot,
      });

      await cleanup?.();

      expect(removeRoot).not.toHaveBeenCalled();
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
