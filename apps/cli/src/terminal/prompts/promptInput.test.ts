import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

const createInterfaceMock = vi.hoisted(() => vi.fn());
const openSyncMock = vi.hoisted(() => vi.fn<(...args: Parameters<typeof import('node:fs').openSync>) => number>(() => { throw new Error('No controlling terminal'); }));
const closeSyncMock = vi.hoisted(() => vi.fn());
const ttyReadStreamMock = vi.hoisted(() => vi.fn());
const ttyWriteStreamMock = vi.hoisted(() => vi.fn());
const fsWriteStreamMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:fs')>(),
    openSync: openSyncMock, closeSync: closeSyncMock, createWriteStream: fsWriteStreamMock,
}));
vi.mock('node:tty', () => ({ ReadStream: ttyReadStreamMock, WriteStream: ttyWriteStreamMock }));

vi.mock('node:readline', async (importOriginal) => ({
    ...await importOriginal<typeof import('node:readline')>(),
    createInterface: createInterfaceMock,
}));

import { isInteractiveTerminal, promptInput, promptSecretInput, resolveInteractiveTerminal } from './promptInput';

describe('promptInput independent terminal input', () => {
  it('keeps terminal raw input for a secret when Windows stdout is redirected', async () => {
    const actual = await vi.importActual<typeof import('node:readline')>('node:readline');
    createInterfaceMock.mockImplementation(actual.createInterface);
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(enabled: boolean) { this.isRaw = enabled; return this; } });
    const output = Object.assign(new PassThrough(), { isTTY: false });
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout')!;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'stdin', { configurable: true, value: input });
    Object.defineProperty(process, 'stdout', { configurable: true, value: output });
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    let outcome: string | undefined;

    const pending = promptSecretInput('Credential: ').then((value) => { outcome = value; });
    try {
      expect(input.isRaw).toBe(true);
      input.write('entered-secret\n');
      await pending;
      expect(outcome).toBe('entered-secret');
      expect(input.isRaw).toBe(false);
      expect(input.destroyed).toBe(false);
      expect(output.destroyed).toBe(false);
    } finally {
      input.write('cleanup\n');
      await pending;
      input.destroy(); output.destroy();
      Object.defineProperty(process, 'stdin', stdinDescriptor);
      Object.defineProperty(process, 'stdout', stdoutDescriptor);
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });


  it('releases owned terminal input when readline construction fails', async () => {
    const previousStdout = process.stdout.isTTY;
    process.stdout.isTTY = true;
    const input = new PassThrough();
    openSyncMock.mockReturnValueOnce(40);
    ttyReadStreamMock.mockReturnValue(input);
    createInterfaceMock.mockImplementationOnce(() => { throw new Error('Readline construction failed'); });
    try {
      await expect(promptInput('Choose: ')).rejects.toThrow('Readline construction failed');
      expect(input.destroyed).toBe(true);
    } finally {
      input.destroy();
      process.stdout.isTTY = previousStdout;
      openSyncMock.mockReset().mockImplementation(() => { throw new Error('No controlling terminal'); });
      ttyReadStreamMock.mockReset();
    }
  });

  it.each([true, false])('reads fresh controlling-terminal input through real readline with terminal stdout=%s when fresh TTY output is unsupported', async (stdoutIsTTY) => {
    const actual = await vi.importActual<typeof import('node:readline')>('node:readline');
    createInterfaceMock.mockImplementation(actual.createInterface);
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const stdout = Object.assign(new PassThrough(), { isTTY: stdoutIsTTY, columns: 100, rows: 30 });
    const ownedOutput = Object.assign(new PassThrough(), { columns: 100, rows: 30 });
    fsWriteStreamMock.mockReturnValue(ownedOutput);
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout')!;
    Object.defineProperty(process, 'stdin', { configurable: true, value: stdin });
    Object.defineProperty(process, 'stdout', { configurable: true, value: stdout });
    openSyncMock.mockReturnValueOnce(40);
    if (!stdoutIsTTY) openSyncMock.mockReturnValueOnce(41);
    ttyReadStreamMock.mockReturnValue(input);
    ttyWriteStreamMock.mockImplementation(() => { throw Object.assign(new Error('Unsupported TTY output'), { code: 'EINVAL' }); });
    let outcome: string | undefined;
    const pending = promptInput('Prompt: ').then((value) => { outcome = value; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      input.write('from-controlling-terminal\n');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(outcome).toBe('from-controlling-terminal');
      expect(input.destroyed).toBe(true);
      expect(stdin.destroyed).toBe(false);
      expect(stdout.destroyed).toBe(false);
      expect(stdout.writableEnded).toBe(false);
      if (!stdoutIsTTY) expect(ownedOutput.destroyed).toBe(true);
    } finally {
      stdin.write('cleanup\n');
      input.write('cleanup\n');
      await pending;
      stdin.destroy();
      stdout.destroy();
      ownedOutput.destroy();
      input.destroy();
      Object.defineProperty(process, 'stdin', stdinDescriptor);
      Object.defineProperty(process, 'stdout', stdoutDescriptor);
      openSyncMock.mockReset().mockImplementation(() => { throw new Error('No controlling terminal'); });
      ttyReadStreamMock.mockReset();
      ttyWriteStreamMock.mockReset();
    }
  });

});

describe('promptInput animated cancellation', () => {
    it('rejects Ctrl-C as an abort and removes prompt listeners', async () => {
        const previousStdin = process.stdin.isTTY;
        const previousStdout = process.stdout.isTTY;
        process.stdin.isTTY = true;
        process.stdout.isTTY = true;
        const initialKeypressListeners = process.stdin.listenerCount('keypress');
        const rl = Object.assign(new EventEmitter(), {
            question: vi.fn(),
            close: vi.fn(),
            getCursorPos: vi.fn(() => ({ rows: 0, cols: 0 })),
            setPrompt: vi.fn(),
            prompt: vi.fn(),
            write: vi.fn(),
        });
        createInterfaceMock.mockReturnValue(rl);

        try {
            const result = promptInput('Choose: ', { animation: { animate: false, render: () => 'Choose: ' } });
            rl.emit('SIGINT');

            await expect(result).rejects.toMatchObject({ name: 'AbortError' });
            expect(rl.listenerCount('SIGINT')).toBe(0);
            expect(rl.listenerCount('close')).toBe(0);
            expect(process.stdin.listenerCount('keypress')).toBe(initialKeypressListeners);
        } finally {
            process.stdin.isTTY = previousStdin;
            process.stdout.isTTY = previousStdout;
        }
    });
});

describe('promptInput animated cadence', () => {
    it('redraws at the cadence the animation asks for at each moment', async () => {
        vi.useFakeTimers();
        const previousStdin = process.stdin.isTTY;
        const previousStdout = process.stdout.isTTY;
        process.stdin.isTTY = true;
        process.stdout.isTTY = true;
        let answer: ((value: string) => void) | null = null;
        const rl = Object.assign(new EventEmitter(), {
            question: vi.fn((_prompt: string, resolve: (value: string) => void) => { answer = resolve; }),
            close: vi.fn(),
            getCursorPos: vi.fn(() => ({ rows: 0, cols: 0 })),
            setPrompt: vi.fn(),
            prompt: vi.fn(),
            write: vi.fn(),
        });
        createInterfaceMock.mockReturnValue(rl);
        try {
            const result = promptInput('Choose: ', {
                animation: {
                    // Fast while the picture moves a lot, calm once it only breathes.
                    intervalMs: (elapsedSeconds) => (elapsedSeconds < 1 ? 50 : 250),
                    render: (seconds) => `frame ${seconds}`,
                },
            });
            await vi.advanceTimersByTimeAsync(1000);
            const fast = rl.setPrompt.mock.calls.length;
            await vi.advanceTimersByTimeAsync(1000);
            const calm = rl.setPrompt.mock.calls.length - fast;
            expect(fast).toBeGreaterThanOrEqual(15);
            expect(calm).toBeLessThanOrEqual(5);
            expect(calm).toBeGreaterThan(0);
            answer!('a');
            await expect(result).resolves.toBe('a');
            const afterAnswer = rl.setPrompt.mock.calls.length;
            await vi.advanceTimersByTimeAsync(1000);
            expect(rl.setPrompt.mock.calls).toHaveLength(afterAnswer);
        } finally {
            vi.useRealTimers();
            process.stdin.isTTY = previousStdin;
            process.stdout.isTTY = previousStdout;
        }
    });
});

describe('resolveInteractiveTerminal', () => {
    it('is interactive when stdin and stdout are both TTYs', () => {
        const hasControllingTty = vi.fn(() => false);

        expect(resolveInteractiveTerminal({
            stdinIsTty: true,
            stdoutIsTty: true,
            platform: 'darwin',
            hasControllingTty,
        })).toBe(true);

        // The cheap check answers it; no need to probe the device.
        expect(hasControllingTty).not.toHaveBeenCalled();
    });

    it('is interactive when stdin is a spent pipe but a controlling terminal is attached', () => {
        // This is the `curl -fsSL … | bash -s -- --run <cmd>` case: the installer
        // hands the CLI an exhausted pipe on stdin, but the user is still sitting
        // at a terminal. `promptInput` already prompts through a freshly-opened
        // /dev/tty here, so refusing to prompt at all is the bug.
        expect(resolveInteractiveTerminal({
            stdinIsTty: false,
            stdoutIsTty: true,
            platform: 'linux',
            hasControllingTty: () => true,
        })).toBe(true);
    });

    it('is interactive when stdout is redirected but a controlling terminal is attached', () => {
        // `happier … > out.txt` still prompts, because the prompt is written to
        // /dev/tty rather than to the redirected stdout.
        expect(resolveInteractiveTerminal({
            stdinIsTty: true,
            stdoutIsTty: false,
            platform: 'darwin',
            hasControllingTty: () => true,
        })).toBe(true);
    });

    it('is not interactive when there is no TTY and no controlling terminal', () => {
        // CI: /dev/tty may exist as a device node but cannot be opened.
        expect(resolveInteractiveTerminal({
            stdinIsTty: false,
            stdoutIsTty: false,
            platform: 'linux',
            hasControllingTty: () => false,
        })).toBe(false);
    });

    it('does not probe for a controlling terminal on Windows', () => {
        const hasControllingTty = vi.fn(() => true);

        expect(resolveInteractiveTerminal({
            stdinIsTty: false,
            stdoutIsTty: true,
            platform: 'win32',
            hasControllingTty,
        })).toBe(false);
        expect(hasControllingTty).not.toHaveBeenCalled();
    });
});

describe('isInteractiveTerminal — a caller saying nobody is watching', () => {
    const previousEnv = process.env.HAPPIER_NONINTERACTIVE;
    const previousStdin = process.stdin.isTTY;
    const previousStdout = process.stdout.isTTY;

    afterEach(() => {
        if (previousEnv === undefined) delete process.env.HAPPIER_NONINTERACTIVE;
        else process.env.HAPPIER_NONINTERACTIVE = previousEnv;
        process.stdin.isTTY = previousStdin;
        process.stdout.isTTY = previousStdout;
    });

    function pretendBothTtys(): void {
        process.stdin.isTTY = true;
        process.stdout.isTTY = true;
    }

    it('refuses to prompt under HAPPIER_NONINTERACTIVE=1 even with a terminal on both ends', () => {
        // The whole point: the terminal is still there. An installer, or
        // `happier setup --yes`, has said that nobody is sitting at it — so a
        // command that asks a question is a command that hangs.
        pretendBothTtys();
        process.env.HAPPIER_NONINTERACTIVE = '1';

        expect(isInteractiveTerminal()).toBe(false);
    });

    it('prompts with the same terminal once nothing claims the run is unattended', () => {
        pretendBothTtys();
        delete process.env.HAPPIER_NONINTERACTIVE;

        expect(isInteractiveTerminal()).toBe(true);
    });

    it('reads only the value the installers set, not any value at all', () => {
        pretendBothTtys();
        process.env.HAPPIER_NONINTERACTIVE = '0';

        expect(isInteractiveTerminal()).toBe(true);
    });
});
