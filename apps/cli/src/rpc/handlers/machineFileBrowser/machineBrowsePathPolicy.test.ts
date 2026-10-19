import { listMachineBrowseDirectory } from './listMachineBrowseDirectory';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateMachineBrowsePath } from './machineBrowsePathPolicy';

describe('validateMachineBrowsePath', () => {
  it('accepts absolute paths within the discovered roots', () => {
    expect(validateMachineBrowsePath({
      targetPath: '/Users/leeroy',
      roots: [{ id: '/', label: '/', path: '/' }],
      platform: 'darwin',
    })).toEqual({
      valid: true,
      resolvedPath: '/Users/leeroy',
    });
  });

  it('rejects relative paths and paths outside allowed windows roots', () => {
    expect(validateMachineBrowsePath({
      targetPath: 'relative/path',
      roots: [{ id: '/', label: '/', path: '/' }],
      platform: 'darwin',
    })).toMatchObject({ valid: false });

    expect(validateMachineBrowsePath({
      targetPath: 'D:\\work',
      roots: [{ id: 'C:\\', label: 'C:', path: 'C:\\' }],
      platform: 'win32',
    })).toMatchObject({ valid: false });
  });

  it('accepts absolute Windows paths when the injected platform is win32', () => {
    expect(validateMachineBrowsePath({
      targetPath: 'C:\\Users\\alice\\repo',
      roots: [{ id: 'C:\\', label: 'C:', path: 'C:\\' }],
      platform: 'win32',
    })).toEqual({
      valid: true,
      resolvedPath: 'C:\\Users\\alice\\repo',
    });
  });

  it('does not realpath Windows paths through the host filesystem when the injected platform is win32', () => {
    const previousCwd = process.cwd();
    const workspace = mkdtempSync(join(tmpdir(), 'happier-machine-browse-windows-'));
    const fakeWindowsPathOnHost = join(workspace, 'C:\\Users\\alice\\repo');
    mkdirSync(fakeWindowsPathOnHost, { recursive: true });

    try {
      process.chdir(workspace);

      expect(validateMachineBrowsePath({
        targetPath: 'C:\\Users\\alice\\repo',
        roots: [{ id: 'C:\\', label: 'C:', path: 'C:\\' }],
        platform: 'win32',
      })).toEqual({
        valid: true,
        resolvedPath: 'C:\\Users\\alice\\repo',
      });
    } finally {
      process.chdir(previousCwd);
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('rejects symlinked directories that escape an allowed root', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-machine-browse-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'happier-machine-browse-outside-'));

    try {
      const root = join(workspace, 'root');
      const linkPath = join(root, 'escape');
      mkdirSync(root, { recursive: true });
      symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

      expect(validateMachineBrowsePath({
        targetPath: linkPath,
        roots: [{ id: 'root', label: 'Root', path: root }],
      })).toMatchObject({ valid: false });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});


describe('dedicated private native domain machine browser boundary', () => {
  it('refuses the actual machine browser through aliases and missing descendants, preserving ordinary neighbors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-private-machine-browser-'));
    try {
      const privateDomain = join(root, 'private');
      const ordinary = join(root, 'ordinary');
      mkdirSync(privateDomain);
      mkdirSync(ordinary);
      writeFileSync(join(privateDomain, '.muninn-private-native-domain'), 'restriction');
      writeFileSync(join(privateDomain, 'private-outcome.bin'), Buffer.from([0, 255, 10]));
      writeFileSync(join(ordinary, 'ordinary.txt'), 'ordinary original bytes');
      symlinkSync(privateDomain, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
      const roots = [{ id: root, label: root, path: root }];
      const result = await listMachineBrowseDirectory({ raw: { path: privateDomain }, roots, maxEntries: 100, statConcurrency: 1 });
      expect(result.ok).toBe(false);
      for (const targetPath of [privateDomain, join(root, 'alias', 'missing', 'future')]) {
        expect(validateMachineBrowsePath({ targetPath, roots }).valid).toBe(false);
      }
      const allowed = await listMachineBrowseDirectory({ raw: { path: ordinary }, roots, maxEntries: 100, statConcurrency: 1 });
      expect(allowed).toMatchObject({ ok: true, entries: [{ name: 'ordinary.txt' }] });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
