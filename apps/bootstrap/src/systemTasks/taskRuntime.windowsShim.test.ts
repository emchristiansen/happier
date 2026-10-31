import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// Spawning is the OS process boundary; the invocation it is handed is the logic under test.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

import { runCommandCapture } from './taskRuntime.js';

function fakeChild(stdout = '') {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', stdout);
    child.emit('close', 0, null);
  });
  return child;
}

describe('runCommandCapture on Windows (R12)', () => {
  const realPlatform = process.platform;
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    spawnMock.mockReset();
  });

  it('runs an npm command shim (happier.cmd) through cmd.exe, which Node refuses to spawn directly', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnMock.mockImplementation(() => fakeChild());

    await runCommandCapture({
      command: 'C:\\Users\\me\\AppData\\Roaming\\npm\\happier.cmd',
      args: ['--version'],
      env: { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    });

    const [command, args, options] = spawnMock.mock.calls[0] ?? [];
    expect(String(command).toLowerCase()).toContain('cmd.exe');
    expect((args as string[]).join(' ')).toContain('happier.cmd');
    expect(options).toMatchObject({ windowsVerbatimArguments: true, windowsHide: true });
  });

  it('keeps native CLI status probes hidden without changing captured JSON output', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    spawnMock.mockImplementation(() => fakeChild('{"ok":true}'));

    const result = await runCommandCapture({ command: 'C:\\happier\\happier.exe', args: ['daemon', 'service', 'status', '--json'] });
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('{"ok":true}');
  });

  it('spawns anything else exactly as before', async () => {
    spawnMock.mockImplementation(() => fakeChild());

    await runCommandCapture({ command: '/usr/local/bin/happier', args: ['--version'], env: {} });

    expect(spawnMock.mock.calls[0]?.[0]).toBe('/usr/local/bin/happier');
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['--version']);
  });
});
