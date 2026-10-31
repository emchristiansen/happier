import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const openSyncMock = vi.hoisted(() => vi.fn<(...args: Parameters<typeof import('node:fs').openSync>) => number>(() => { throw new Error('No controlling terminal'); }));
const ttyReadStreamMock = vi.hoisted(() => vi.fn());

// Real readline stays active; only the OS-owned descriptor and terminal boundaries are substituted.
vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  existsSync: () => true, openSync: openSyncMock, closeSync: vi.fn(),
}));
vi.mock('node:tty', () => ({ ReadStream: ttyReadStreamMock, WriteStream: vi.fn() }));

const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout')!;

afterEach(() => {
  Object.defineProperty(process, 'stdin', stdinDescriptor);
  Object.defineProperty(process, 'stdout', stdoutDescriptor);
  openSyncMock.mockReset().mockImplementation(() => { throw new Error('No controlling terminal'); });
  ttyReadStreamMock.mockReset();
});

describe('promptSecret', () => {
  it('reads a secret from independent terminal input, hides it, and preserves borrowed stdio', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
    Object.defineProperty(process, 'stdout', { configurable: true, value: stdout });
    openSyncMock.mockReturnValueOnce(40);
    ttyReadStreamMock.mockReturnValue(input);
    const writes: string[] = [];
    stdout.on('data', (chunk: Buffer) => writes.push(chunk.toString()));
    const { promptSecret } = await import('./promptSecret');
    let outcome: string | undefined;
    const pending = promptSecret('Credential: ').then((value) => { outcome = value; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write('entered-secret\n');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toBe('entered-secret');
      expect(writes.join('')).toContain('Credential: ');
      expect(writes.join('')).not.toContain('entered-secret');
      expect(input.destroyed).toBe(true);
      expect(stdin.destroyed).toBe(false);
      expect(stdout.destroyed).toBe(false);
      expect(stdout.writableEnded).toBe(false);
    } finally {
      stdin.write('cleanup\n');
      input.write('cleanup\n');
      await pending;
      stdin.destroy(); stdout.destroy(); input.destroy();
    }
  });

  it.each(['Ctrl-C', 'EOF'] as const)('keeps public cancellation behavior for %s on independent terminal input', async (action) => {
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 100, rows: 30 });
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
    Object.defineProperty(process, 'stdout', { configurable: true, value: stdout });
    openSyncMock.mockReturnValueOnce(40);
    ttyReadStreamMock.mockReturnValue(input);
    const { promptSecret } = await import('./promptSecret');
    try {
      const pending = promptSecret('Credential: ');
      const rejection = expect(pending).rejects.toThrow('Cancelled.');
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write(action === 'Ctrl-C' ? '\x03' : '\x04');
      await rejection;
      expect(input.destroyed).toBe(true);
      expect(stdin.destroyed).toBe(false);
      expect(stdout.destroyed).toBe(false);
    } finally {
      stdin.destroy(); stdout.destroy(); input.destroy();
    }
  });

  it('rejects unattended input before opening readline', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: false });
    const stdout = Object.assign(new PassThrough(), { isTTY: false });
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
    Object.defineProperty(process, 'stdout', { configurable: true, value: stdout });
    const { promptSecret } = await import('./promptSecret');
    try {
      await expect(promptSecret('Credential: ')).rejects.toThrow('requires an interactive terminal');
      expect(ttyReadStreamMock).not.toHaveBeenCalled();
    } finally {
      stdin.destroy(); stdout.destroy();
    }
  });
});
