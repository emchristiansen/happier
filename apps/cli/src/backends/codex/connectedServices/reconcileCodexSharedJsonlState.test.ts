import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { reconcileCodexSharedJsonlState } from './reconcileCodexSharedJsonlState';

describe('reconcileCodexSharedJsonlState', () => {
  it('merges a home\'s own JSONL but never a symlinked entry pointing into another native store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-codex-jsonl-reconcile-'));
    const previousHome = join(dir, 'previous-home');
    const admittedSource = join(dir, 'admitted-source');
    const foreignSource = join(dir, 'foreign-source');
    for (const root of [previousHome, admittedSource, foreignSource]) await mkdir(root, { recursive: true });
    await writeFile(join(foreignSource, 'history.jsonl'), '{"session_id":"foreign","ts":1,"text":"foreign"}\n');
    await symlink(join(foreignSource, 'history.jsonl'), join(previousHome, 'history.jsonl'));
    await writeFile(join(previousHome, 'session_index.jsonl'), '{"id":"local","updated_at":"2026-01-01T00:00:00Z"}\n');

    await reconcileCodexSharedJsonlState({ previousCodexHome: previousHome, sourceCodexHome: admittedSource });

    await expect(readFile(join(admittedSource, 'history.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(admittedSource, 'session_index.jsonl'), 'utf8')).toContain('"id":"local"');
  });
});
