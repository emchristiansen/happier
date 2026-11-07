import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SpawnOptions } from 'node:child_process';
import { createTmuxMockChildProcess, type TmuxSpawnCall } from './tmux.spawnMock.testkit';

const { spawnMock, getLastSpawnCall, setLastSpawnCall } = vi.hoisted(() => {
    let lastSpawnCall: TmuxSpawnCall | null = null;
    return {
        spawnMock: vi.fn(),
        getLastSpawnCall: () => lastSpawnCall,
        setLastSpawnCall: (call: TmuxSpawnCall) => {
            lastSpawnCall = call;
        },
    };
});

vi.mock('child_process', () => ({
    spawn: spawnMock,
}));

describe('TmuxUtilities tmux client argv', () => {
    beforeEach(() => {
        spawnMock.mockReset();
        spawnMock.mockImplementation((command: string, args: readonly string[], options: SpawnOptions) => {
            setLastSpawnCall({
                command,
                args: [...args],
                options,
            });
            return createTmuxMockChildProcess();
        });
    });

    it('uses -S <socketPath> by default when configured', async () => {
        vi.resetModules();
        const { TmuxUtilities } = await import('@/integrations/tmux');

        const socketPath = '/tmp/happier-cli-tmux-test.sock';
        const utils = new TmuxUtilities('happy', undefined, socketPath);
        await utils.executeTmuxCommand(['list-sessions']);

        const call = getLastSpawnCall();
        expect(call).not.toBeNull();
        expect(call!.command).toBe('tmux');
        expect(call!.args).toEqual(expect.arrayContaining(['-S', socketPath]));
    });

    it('always runs tmux as a UTF-8 client (-u) so -P/-F/list output is never sanitized', async () => {
        // Without -u, tmux derives the client's UTF-8 flag from TMUX/LC_ALL/LC_CTYPE/LANG and
        // otherwise rewrites every control or non-ASCII byte in printed output as `_`, which
        // breaks the TAB-separated formats parsed by spawnInTmux, cursor and session lookups.
        vi.resetModules();
        const { TmuxUtilities } = await import('@/integrations/tmux');

        const withoutSocket = new TmuxUtilities('happy');
        await withoutSocket.executeTmuxCommand(['list-sessions']);
        expect(getLastSpawnCall()!.args).toEqual(['-u', 'list-sessions']);

        const socketPath = '/tmp/happier-cli-tmux-test.sock';
        const withSocket = new TmuxUtilities('happy', undefined, socketPath);
        await withSocket.executeTmuxCommand(['send-keys', 'hello']);
        expect(getLastSpawnCall()!.args).toEqual(['-u', '-S', socketPath, 'send-keys', '-t', 'happy', 'hello']);
    });

    it('places the default -t target before positional operands so commands with a message operand accept it', async () => {
        // `display-message -p <format> -t <target>` is rejected by tmux ("too many arguments") because the
        // target flag lands after the positional format; the cursor probe silently returned null forever.
        vi.resetModules();
        const { TmuxUtilities } = await import('@/integrations/tmux');

        const utils = new TmuxUtilities('happy');
        await utils.executeTmuxCommand(['display-message', '-p', '#{cursor_x}\t#{cursor_y}'], '@22');
        expect(getLastSpawnCall()!.args).toEqual(['-u', 'display-message', '-t', '@22', '-p', '#{cursor_x}\t#{cursor_y}']);

        await utils.executeTmuxCommand(['capture-pane', '-p', '-e'], 'sess', 'win', '1');
        expect(getLastSpawnCall()!.args).toEqual(['-u', 'capture-pane', '-t', 'sess:win.1', '-p', '-e']);
    });
});
