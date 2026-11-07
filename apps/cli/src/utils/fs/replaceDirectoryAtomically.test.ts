import { mkdir, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { replaceDirectoryAtomically } from './replaceDirectoryAtomically';

const fsBoundary = vi.hoisted(() => ({
  rename: vi.fn<typeof import('node:fs/promises').rename>(),
  rm: vi.fn<typeof import('node:fs/promises').rm>(),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsBoundary.rename.mockImplementation(actual.rename);
  fsBoundary.rm.mockImplementation(actual.rm);
  return { ...actual, rename: fsBoundary.rename, rm: fsBoundary.rm };
});
beforeEach(async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  fsBoundary.rename.mockReset().mockImplementation(actual.rename);
  fsBoundary.rm.mockReset().mockImplementation(actual.rm);
});
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'codex-home-promotion-'));
  roots.push(root);
  const targetDir = join(root, 'target');
  const stagedDir = join(root, 'stage');
  await mkdir(join(targetDir, 'codex-home', 'tmp', 'arg0'), { recursive: true });
  await mkdir(join(stagedDir, 'codex-home'), { recursive: true });
  await writeFile(join(targetDir, 'codex-home', 'tmp', 'arg0', '.lock'), 'held synthetic lock');
  await writeFile(join(targetDir, 'codex-home', 'owned'), 'old owned data');
  await writeFile(join(targetDir, 'codex-home', 'provided'), 'old provided data');
  await writeFile(join(stagedDir, 'codex-home', 'provided'), 'new provided data');
  return { root, targetDir, stagedDir };
}

describe('atomic home promotion runtime custody', () => {
  it.each([false, true])('retains distinct histories when home retirement follows promotion or rollback (%s)', async (rejectPromotion) => {
    const { root, targetDir, stagedDir } = await fixture();
    await writeFile(join(targetDir, 'codex-home', 'history.jsonl'), 'old distinct history\n');
    await writeFile(join(targetDir, 'codex-home', 'auth.json'), 'synthetic old credential');
    await writeFile(join(stagedDir, 'codex-home', 'history.jsonl'), 'new distinct history\n');
    await writeFile(join(stagedDir, 'codex-home', 'auth.json'), 'synthetic new credential');
    const params = {
      stagedDir, targetDir,
      // A materialization caller retires credentials; history is not disposable state.
      retireDirectory: async (directory: string) => {
        await rm(join(directory, 'codex-home', 'auth.json'), { force: true });
      },
      afterPromote: async () => {
        if (rejectPromotion) throw new Error('synthetic history promotion rejection');
      },
    };
    if (rejectPromotion) {
      await expect(replaceDirectoryAtomically(params)).rejects.toThrow('synthetic history promotion rejection');
    } else {
      await replaceDirectoryAtomically(params);
    }
    const retainedHistories: string[] = [];
    for (const directory of await readdir(root)) {
      try {
        retainedHistories.push(await readFile(join(root, directory, 'codex-home', 'history.jsonl'), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (directory !== 'target') {
        await expect(stat(join(root, directory, 'codex-home', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      }
    }
    expect(retainedHistories).toEqual(expect.arrayContaining(['old distinct history\n', 'new distinct history\n']));
    await expect(readFile(join(targetDir, 'codex-home', 'history.jsonl'), 'utf8')).resolves.toBe(
      rejectPromotion ? 'old distinct history\n' : 'new distinct history\n',
    );
  });

  it.each([false, true])('retains both homes when credential retirement throws after promotion or rollback (%s)', async (rejectPromotion) => {
    const { root, targetDir, stagedDir } = await fixture();
    await writeFile(join(targetDir, 'history.jsonl'), 'old distinct history');
    await writeFile(join(stagedDir, 'history.jsonl'), 'new distinct history');
    await expect(replaceDirectoryAtomically({
      stagedDir, targetDir,
      afterPromote: async () => { if (rejectPromotion) throw new Error('synthetic promotion rejection'); },
      retireDirectory: async () => { throw new Error('synthetic credential retirement failure'); },
    })).rejects.toThrow();
    const histories = await Promise.all((await readdir(root)).map((entry) => readFile(join(root, entry, 'history.jsonl'), 'utf8')));
    expect(histories.sort()).toEqual(['new distinct history', 'old distinct history']);
    expect(await readFile(join(targetDir, 'history.jsonl'), 'utf8')).toBe(rejectPromotion ? 'old distinct history' : 'new distinct history');
  });

  it.each([false, true])('claims both possible retained siblings before anything moves (rejected promotion: %s)', async (rejectPromotion) => {
    const { root, targetDir, stagedDir } = await fixture();
    await writeFile(join(targetDir, 'history.jsonl'), 'old distinct history');
    await writeFile(join(stagedDir, 'history.jsonl'), 'new distinct history');
    const claims: Array<{ retired: string; canonical: string; identityHistory: string; stagedInPlace: boolean; retiredExisted: boolean }> = [];
    const released: string[] = [];
    const retired: string[] = [];
    const run = replaceDirectoryAtomically({
      stagedDir, targetDir,
      afterPromote: async () => { if (rejectPromotion) throw new Error('synthetic promotion rejection'); },
      claimRetiredDirectory: async ({ retired: retiredDir, canonical, identity }) => {
        claims.push({
          retired: retiredDir, canonical,
          identityHistory: await readFile(join(identity, 'history.jsonl'), 'utf8'),
          stagedInPlace: await stat(stagedDir).then(() => true, () => false),
          retiredExisted: await stat(retiredDir).then(() => true, () => false),
        });
      },
      releaseRetiredDirectoryClaim: async (directory) => { released.push(directory); },
      retireDirectory: async (directory) => { retired.push(directory); },
    });
    if (rejectPromotion) await expect(run).rejects.toThrow('synthetic promotion rejection');
    else await run;
    // The `.previous-*` claim binds the current target; the `.rejected-*` claim binds the staged
    // directory that a rollback would rename there. Both precede every rename.
    expect(claims.map((claim) => ({ kind: claim.retired.slice(targetDir.length, targetDir.length + '.previous-'.length), history: claim.identityHistory })))
      .toEqual([{ kind: '.previous-', history: 'old distinct history' }, { kind: '.rejected-', history: 'new distinct history' }]);
    expect(claims.every((claim) => claim.canonical === targetDir && claim.stagedInPlace && !claim.retiredExisted)).toBe(true);
    const [previousClaim, rejectedClaim] = claims;
    expect(retired).toEqual([rejectPromotion ? rejectedClaim!.retired : previousClaim!.retired]);
    expect(released).toEqual(rejectPromotion ? [] : [rejectedClaim!.retired]);
    expect(await readFile(join(targetDir, 'history.jsonl'), 'utf8')).toBe(rejectPromotion ? 'old distinct history' : 'new distinct history');
    // Exactly the canonical target and one retained sibling remain; nothing was deleted.
    expect(await readdir(root)).toHaveLength(2);
  });

  it('aborts before any rename when the rejected-sibling claim fails', async () => {
    const { root, targetDir, stagedDir } = await fixture();
    await writeFile(join(targetDir, 'history.jsonl'), 'old distinct history');
    await writeFile(join(stagedDir, 'history.jsonl'), 'new distinct history');
    let promoted = false;
    await expect(replaceDirectoryAtomically({
      stagedDir, targetDir,
      afterPromote: async () => { promoted = true; },
      claimRetiredDirectory: async ({ retired }) => { if (retired.includes('.rejected-')) throw new Error('synthetic custody claim failure'); },
      retireDirectory: async () => {},
    })).rejects.toThrow('synthetic custody claim failure');
    expect(promoted).toBe(false);
    expect(await readFile(join(targetDir, 'history.jsonl'), 'utf8')).toBe('old distinct history');
    expect(await readFile(join(stagedDir, 'history.jsonl'), 'utf8')).toBe('new distinct history');
    expect((await readdir(root)).sort()).toEqual(['stage', 'target']);
  });

  it('keeps a valid promotion when releasing the unused rejected claim fails', async () => {
    const { targetDir, stagedDir } = await fixture();
    await writeFile(join(stagedDir, 'history.jsonl'), 'new distinct history');
    await replaceDirectoryAtomically({
      stagedDir, targetDir,
      claimRetiredDirectory: async () => {},
      releaseRetiredDirectoryClaim: async () => { throw new Error('synthetic release failure'); },
      retireDirectory: async () => {},
    });
    expect(await readFile(join(targetDir, 'history.jsonl'), 'utf8')).toBe('new distinct history');
  });

  it('does not create an unowned retained sibling when the custody claim fails', async () => {
    const { root, targetDir, stagedDir } = await fixture();
    await writeFile(join(targetDir, 'history.jsonl'), 'old distinct history');
    const retired: string[] = [];
    await expect(replaceDirectoryAtomically({
      stagedDir, targetDir,
      claimRetiredDirectory: async () => { throw new Error('synthetic custody claim failure'); },
      retireDirectory: async (directory) => { retired.push(directory); },
    })).rejects.toThrow('synthetic custody claim failure');
    expect(retired).toEqual([]);
    expect(await readFile(join(targetDir, 'history.jsonl'), 'utf8')).toBe('old distinct history');
    expect((await readdir(root)).sort()).toEqual(['stage', 'target']);
  });

  it('renames unprovided runtime entries, retaining a held file identity and staged/owned decisions', async () => {
    const { targetDir, stagedDir } = await fixture();
    const lockPath = join(targetDir, 'codex-home', 'tmp', 'arg0', '.lock');
    const held = await open(lockPath, 'r');
    try {
      const before = await held.stat();
      const params = { stagedDir, targetDir, preserveUnprovidedEntries: [{ root: 'codex-home', exclude: ['owned'] }] };
      await replaceDirectoryAtomically(params);
      const after = await stat(lockPath);
      expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
      expect(await readFile(join(targetDir, 'codex-home', 'provided'), 'utf8')).toBe('new provided data');
      await expect(stat(join(targetDir, 'codex-home', 'owned'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await held.close(); }
  });

  it('returns carried entries before restoring the old root if post-promotion validation fails', async () => {
    const { root, targetDir, stagedDir } = await fixture();
    const lockPath = join(targetDir, 'codex-home', 'tmp', 'arg0', '.lock');
    const before = await stat(lockPath);
    const params = {
      stagedDir, targetDir, preserveUnprovidedEntries: [{ root: 'codex-home', exclude: ['owned'] }],
      afterPromote: async () => { expect((await stat(lockPath)).ino).toBe(before.ino); throw new Error('synthetic promotion rejection'); },
    };
    await expect(replaceDirectoryAtomically(params)).rejects.toThrow('synthetic promotion rejection');
    expect((await stat(lockPath)).ino).toBe(before.ino);
    expect(await readFile(join(targetDir, 'codex-home', 'provided'), 'utf8')).toBe('old provided data');
    expect(await readdir(root)).toEqual(['target']);
  });

  it('restores the old target and carried lock if default backup removal fails', async () => {
    const { root, targetDir, stagedDir } = await fixture();
    const lockPath = join(targetDir, 'codex-home', 'tmp', 'arg0', '.lock');
    const held = await open(lockPath, 'r');
    const failure = new Error('synthetic default backup removal failure');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let rejectedBackup = false;
    fsBoundary.rm.mockImplementation(async (path, options) => {
      // Only the first backup deletion fails; rollback and fixture cleanup use real fs.
      if (!rejectedBackup && String(path).startsWith(`${targetDir}.previous-`)) {
        rejectedBackup = true;
        throw failure;
      }
      await actual.rm(path, options);
    });
    try {
      const before = await held.stat();
      await expect(replaceDirectoryAtomically({
        stagedDir, targetDir, preserveUnprovidedEntries: [{ root: 'codex-home', exclude: ['owned'] }],
      })).rejects.toBe(failure);
      expect(rejectedBackup).toBe(true);
      expect(await readFile(join(targetDir, 'codex-home', 'provided'), 'utf8')).toBe('old provided data');
      expect(await readFile(join(targetDir, 'codex-home', 'owned'), 'utf8')).toBe('old owned data');
      const restored = await stat(lockPath);
      expect([restored.dev, restored.ino]).toEqual([before.dev, before.ino]);
      expect(await readdir(root)).toEqual(['target']);
    } finally { await held.close(); }
  });

  it('merges an unprovided runtime directory recreated after promotion without replacing staged names', async () => {
    const { targetDir, stagedDir } = await fixture();
    const { rename } = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const oldLock = await stat(join(targetDir, 'codex-home', 'tmp', 'arg0', '.lock'));
    fsBoundary.rename.mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (source === stagedDir && destination === targetDir) {
        await mkdir(join(targetDir, 'codex-home', 'tmp'), { recursive: true });
        await writeFile(join(targetDir, 'codex-home', 'tmp', 'new-runtime-entry'), 'new runtime data');
      }
    });
    await replaceDirectoryAtomically({ stagedDir, targetDir, preserveUnprovidedEntries: [{ root: 'codex-home', exclude: ['owned'] }] });
    expect((await stat(join(targetDir, 'codex-home', 'tmp', 'arg0', '.lock'))).ino).toBe(oldLock.ino);
    expect(await readFile(join(targetDir, 'codex-home', 'tmp', 'new-runtime-entry'), 'utf8')).toBe('new runtime data');
    expect(await readFile(join(targetDir, 'codex-home', 'provided'), 'utf8')).toBe('new provided data');
  });

  it('does not preserve runtime entries for callers that do not opt in', async () => {
    const { targetDir, stagedDir } = await fixture();
    await replaceDirectoryAtomically({ stagedDir, targetDir });
    await expect(stat(join(targetDir, 'codex-home', 'tmp'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
