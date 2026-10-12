import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';

const childProcessMocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    execFile: childProcessMocks.execFile,
    spawnSync: childProcessMocks.spawnSync,
  };
});

import {
  createWindowsProtectedAclBoundary,
  createWindowsProtectedAclBoundarySync,
  type WindowsProtectedAclCommandRunnerSync,
} from './windowsProtectedAcl';

describe('Windows protected ACL boundary', () => {
  afterEach(() => {
    childProcessMocks.execFile.mockReset();
    childProcessMocks.spawnSync.mockReset();
    vi.unstubAllEnvs();
  });

  it('uses the same native System32 command map through the asynchronous boundary', async () => {
    vi.stubEnv('SystemRoot', 'C:\\WINDOWS');
    vi.stubEnv('PATH', 'C:\\Program Files\\Git\\usr\\bin;C:\\WINDOWS\\System32');
    childProcessMocks.execFile.mockImplementation((...rawArgs) => {
      const [command, , , callback] = rawArgs as [
        string,
        readonly string[],
        unknown,
        (error: null, stdout: string, stderr: string) => void,
      ];
      const normalizedCommand = command.toLowerCase();
      if (normalizedCommand.endsWith('\\whoami.exe')) {
        callback(null, '"USER","S-1-5-21-123"', '');
      } else if (normalizedCommand.endsWith('\\icacls.exe')) {
        callback(null, 'processed', '');
      } else {
        callback(null, JSON.stringify({
          ownerSid: 'S-1-5-21-123',
          protected: true,
          reparsePoint: false,
          rules: [
            { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
            { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
          ],
        }), '');
      }
    });

    await createWindowsProtectedAclBoundary().applyAndVerify({
      path: 'C:\\Users\\user\\private.json',
      kind: 'file',
    });

    expect(childProcessMocks.execFile.mock.calls.map(([command]) => command)).toEqual([
      'C:\\WINDOWS\\System32\\whoami.exe',
      'C:\\WINDOWS\\System32\\icacls.exe',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
  });

  it('uses native System32 ACL commands even when Git tools shadow whoami on PATH', () => {
    vi.stubEnv('SystemRoot', 'C:\\WINDOWS');
    vi.stubEnv('PATH', 'C:\\Program Files\\Git\\usr\\bin;C:\\WINDOWS\\System32');
    childProcessMocks.spawnSync.mockImplementation((command) => {
      const normalizedCommand = String(command).toLowerCase();
      if (normalizedCommand.endsWith('\\whoami.exe')) {
        return { status: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
      }
      if (normalizedCommand.endsWith('\\icacls.exe')) {
        return { status: 0, stdout: 'processed', stderr: '' };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          ownerSid: 'S-1-5-21-123',
          protected: true,
          reparsePoint: false,
          rules: [
            { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
            { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
          ],
        }),
        stderr: '',
      };
    });

    createWindowsProtectedAclBoundarySync().applyAndVerify({
      path: 'C:\\Users\\user\\private.json',
      kind: 'file',
    });

    expect(childProcessMocks.spawnSync.mock.calls.map(([command]) => command)).toEqual([
      'C:\\WINDOWS\\System32\\whoami.exe',
      'C:\\WINDOWS\\System32\\icacls.exe',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    ]);
  });

  it('fails explicitly when the Windows system root is unavailable', () => {
    const previousSystemRoot = process.env.SystemRoot;
    const previousWindir = process.env.WINDIR;
    delete process.env.SystemRoot;
    delete process.env.WINDIR;
    try {
      expect(() => createWindowsProtectedAclBoundarySync().verify({
        path: 'C:\\Users\\user\\private.json',
        kind: 'file',
      })).toThrow(/SystemRoot.*WINDIR/u);
      expect(childProcessMocks.spawnSync).not.toHaveBeenCalled();
    } finally {
      if (previousSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = previousSystemRoot;
      if (previousWindir === undefined) delete process.env.WINDIR;
      else process.env.WINDIR = previousWindir;
    }
  });

  it('applies and verifies current-user and SYSTEM-only ACLs through one command owner', () => {
    const runCommand = vi.fn<WindowsProtectedAclCommandRunnerSync>((command) => {
      if (command === 'whoami.exe') {
        return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
      }
      if (command === 'icacls.exe') {
        return { exitCode: 0, stdout: 'processed', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          ownerSid: 'S-1-5-21-123',
          protected: true,
          reparsePoint: false,
          rules: [
            { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
            { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
          ],
        }),
        stderr: '',
      };
    });
    const boundary = createWindowsProtectedAclBoundarySync({ runCommand });

    boundary.applyAndVerify({ path: 'C:\\Users\\user\\private.json', kind: 'file' });

    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      'whoami.exe',
      'icacls.exe',
      'powershell.exe',
      'powershell.exe',
    ]);
    expect(runCommand.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(['/setowner', '*S-1-5-21-123']));
    const applyCommand = runCommand.mock.calls[2]?.[1] ?? [];
    expect(applyCommand[3]).toContain('SetSecurityDescriptorSddlForm');
    expect(applyCommand).toEqual(expect.arrayContaining(['S-1-5-21-123', 'S-1-5-18', 'file']));
  });

  it('replaces unrelated explicit grants when applying a protected directory ACL', async () => {
    const expectedRules = [
      { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
      { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
    ];
    let rules = [...expectedRules, { sid: 'S-1-5-32-545', type: 'Allow', inherited: false, rights: 'Read' }];
    const runCommand = vi.fn(async (command: string, args: readonly string[]) => {
      if (command === 'whoami.exe') return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
      if (command === 'icacls.exe') return { exitCode: 0, stdout: 'processed', stderr: '' };
      if (args[3]?.includes('SetSecurityDescriptorSddlForm')) {
        expect(args[3]).toContain('Set-Acl');
        expect(args).toContain('directory');
        rules = expectedRules;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ownerSid: 'S-1-5-21-123', protected: true, reparsePoint: false, rules }),
        stderr: '',
      };
    });

    await createWindowsProtectedAclBoundary({ runCommand }).applyAndVerify({
      path: 'C:\\Users\\user\\private',
      kind: 'directory',
    });
    expect(rules).toEqual(expectedRules);
  });

  it('replaces unrelated explicit grants through the synchronous boundary too', () => {
    const expectedRules = [
      { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
      { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
    ];
    let rules = [...expectedRules, { sid: 'S-1-5-32-545', type: 'Allow', inherited: false, rights: 'Read' }];
    const runCommand = vi.fn<WindowsProtectedAclCommandRunnerSync>((command, args) => {
      if (command === 'whoami.exe') return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
      if (command === 'icacls.exe') return { exitCode: 0, stdout: 'processed', stderr: '' };
      if (args[3]?.includes('SetSecurityDescriptorSddlForm')) {
        expect(args[3]).toContain('Set-Acl');
        expect(args).toContain('file');
        rules = expectedRules;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ ownerSid: 'S-1-5-21-123', protected: true, reparsePoint: false, rules }),
        stderr: '',
      };
    });

    createWindowsProtectedAclBoundarySync({ runCommand }).applyAndVerify({
      path: 'C:\\Users\\user\\private.json',
      kind: 'file',
    });
    expect(rules).toEqual(expectedRules);
  });

  it('identifies the rejected path and access rules when verification cannot prove the DACL', () => {
    const path = 'C:\\Users\\user\\private.json';
    const extraRule = { sid: 'S-1-5-32-545', type: 'Allow', inherited: false, rights: 'Read' };
    const boundary = createWindowsProtectedAclBoundarySync({
      runCommand(command) {
        if (command === 'whoami.exe') return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ownerSid: 'S-1-5-21-123',
            protected: true,
            reparsePoint: false,
            rules: [
              { sid: 'S-1-5-21-123', type: 'Allow', inherited: false, rights: 'FullControl' },
              { sid: 'S-1-5-18', type: 'Allow', inherited: false, rights: 'FullControl' },
              extraRule,
            ],
          }),
          stderr: '',
        };
      },
    });

    let message = '';
    try {
      boundary.verify({ path, kind: 'file' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(JSON.stringify(path));
    expect(message).toContain(JSON.stringify(extraRule));
  });

  it.runIf(process.platform === 'win32')('removes a real explicit Users grant before accepting a protected directory', async () => {
    const { execFile } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    childProcessMocks.execFile.mockImplementation(execFile);
    const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
    if (!systemRoot) throw new Error('Windows system root is unavailable');
    const root = await mkdtemp(join(tmpdir(), 'happier-acl-'));
    const boundary = createWindowsProtectedAclBoundary();
    try {
      await boundary.applyAndVerify({ path: root, kind: 'directory' });
      await promisify(execFile)(win32.join(systemRoot, 'System32', 'icacls.exe'), [
        root, '/grant', '*S-1-5-32-545:R',
      ]);
      await expect(boundary.verify({ path: root, kind: 'directory' })).rejects.toThrow(/ACL entries/u);
      await boundary.applyAndVerify({ path: root, kind: 'directory' });
      await expect(boundary.verify({ path: root, kind: 'directory' })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when verification reports an inherited ACL', () => {
    const boundary = createWindowsProtectedAclBoundarySync({
      runCommand(command) {
        if (command === 'whoami.exe') {
          return { exitCode: 0, stdout: '"USER","S-1-5-21-123"', stderr: '' };
        }
        if (command === 'icacls.exe') return { exitCode: 0, stdout: '', stderr: '' };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ownerSid: 'S-1-5-21-123',
            protected: false,
            reparsePoint: false,
            rules: [],
          }),
          stderr: '',
        };
      },
    });

    expect(() => boundary.applyAndVerify({ path: 'C:\\unsafe.json', kind: 'file' })).toThrow(/inherits ACL/u);
  });

  it('reports command, exit code, and bounded stderr without exposing stdout', () => {
    const longStderr = `Access denied. ${'x'.repeat(600)}`;
    const boundary = createWindowsProtectedAclBoundarySync({
      runCommand() {
        return { exitCode: 7, stdout: 'sensitive-user-output', stderr: longStderr };
      },
    });

    let message = '';
    try {
      boundary.verify({ path: 'C:\\unsafe.json', kind: 'file' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/whoami\.exe.*exit 7.*Access denied\./u);
    expect(message).toContain('…');
    expect(message).not.toContain('x'.repeat(513));
    expect(message).not.toContain('sensitive-user-output');
  });
});
