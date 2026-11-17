import { chmod, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isConnectedServiceHomeEntryLinkedToSource } from './connectedServiceHomeEntrySync';

describe('isConnectedServiceHomeEntryLinkedToSource', () => {
  it('recognizes a link to the admitted source and never follows a link into another root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-home-entry-link-'));
    const admittedSource = join(dir, 'admitted-source');
    const excludedSource = join(dir, 'excluded-source');
    const home = join(dir, 'home');
    for (const root of [admittedSource, excludedSource, home]) await mkdir(root, { recursive: true });
    await writeFile(join(admittedSource, 'AGENTS.md'), '# admitted\n');
    await writeFile(join(excludedSource, 'AGENTS.md'), '# excluded\n');
    await symlink(join(admittedSource, 'AGENTS.md'), join(home, 'linked.md'));
    await symlink(join(excludedSource, 'AGENTS.md'), join(home, 'foreign.md'));
    await chmod(excludedSource, 0o000);
    try {
      expect(await isConnectedServiceHomeEntryLinkedToSource(join(admittedSource, 'AGENTS.md'), join(home, 'linked.md'))).toBe(true);
      expect(await isConnectedServiceHomeEntryLinkedToSource(join(admittedSource, 'AGENTS.md'), join(home, 'foreign.md'))).toBe(false);
    } finally {
      await chmod(excludedSource, 0o755);
    }
  });
});
