import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { attachProcessSignalForwardingToChild } from './signalForwarding';

class FakeProc {
    platform: NodeJS.Platform;
    pid = 999;
    handlers = new Map<string, (() => void)[]>();
    off = vi.fn((event: string, handler: () => void) => {
        const list = this.handlers.get(event) ?? [];
        this.handlers.set(event, list.filter((h) => h !== handler));
    });
    kill = vi.fn();

    constructor(platform: NodeJS.Platform) {
        this.platform = platform;
    }

    on = vi.fn((event: string, handler: () => void) => {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
    });
}

class FakeChild extends EventEmitter {
    pid = 123;
    killed = false;
    kill = vi.fn();
}

describe('attachProcessSignalForwardingToChild', () => {
    it('removes process signal listeners when the child emits error', () => {
        const proc = new FakeProc('darwin');
        const child = new FakeChild() as any;

        attachProcessSignalForwardingToChild(child, proc as any);

        expect(proc.on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
        expect(proc.on).toHaveBeenCalledWith('SIGINT', expect.any(Function));
        expect(proc.on).toHaveBeenCalledWith('SIGHUP', expect.any(Function));

        child.emit('error', new Error('spawn failed'));

        expect(proc.off).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
        expect(proc.off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
        expect(proc.off).toHaveBeenCalledWith('SIGHUP', expect.any(Function));
    });

    it('does not register SIGHUP on Windows', () => {
        const proc = new FakeProc('win32');
        const child = new FakeChild() as any;

        attachProcessSignalForwardingToChild(child, proc as any);

        expect(proc.handlers.has('SIGHUP')).toBe(false);
    });

    it('forwards SIGINT to the child without swallowing the parent signal', () => {
        const proc = new FakeProc('darwin');
        const child = new FakeChild() as any;

        attachProcessSignalForwardingToChild(child, proc as any);

        const handler = (proc.handlers.get('SIGINT') ?? [])[0];
        expect(typeof handler).toBe('function');

        handler();

        expect(child.kill).toHaveBeenCalledWith('SIGINT');
        expect(proc.kill).toHaveBeenCalledWith(proc.pid, 'SIGINT');
        expect(proc.off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    });
    it('waits for owning cleanup before re-signaling, including repeated signals and child close', async () => {
        const proc = new FakeProc('darwin');
        const child = new FakeChild() as any;
        let release!: () => void;
        const cleanupDone = new Promise<void>((resolve) => { release = resolve; });
        const beforeParentExit = vi.fn(() => cleanupDone);
        attachProcessSignalForwardingToChild(child, proc as any, { beforeParentExit });

        proc.handlers.get('SIGTERM')![0]!();
        await Promise.resolve();
        child.emit('close', 0, null);
        proc.handlers.get('SIGHUP')![0]!();
        expect(beforeParentExit).toHaveBeenCalledTimes(1);
        expect(proc.kill).not.toHaveBeenCalled();
        expect(proc.off).not.toHaveBeenCalled();

        release();
        await vi.waitFor(() => expect(proc.kill).toHaveBeenCalledWith(proc.pid, 'SIGTERM'));
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(proc.handlers.get('SIGTERM')).toEqual([]);
    });

    it('preserves parent termination when owning cleanup rejects', async () => {
        const proc = new FakeProc('darwin');
        const child = new FakeChild() as any;
        attachProcessSignalForwardingToChild(child, proc as any, {
            beforeParentExit: async () => { throw new Error('cleanup failed'); },
        });
        proc.handlers.get('SIGTERM')![0]!();
        await vi.waitFor(() => expect(proc.kill).toHaveBeenCalledWith(proc.pid, 'SIGTERM'));
        expect(proc.handlers.get('SIGTERM')).toEqual([]);
    });

    it('keeps signals handled between child exit and completion of owning cleanup', async () => {
        const proc = new FakeProc('darwin');
        const child = new FakeChild() as any;
        let release!: () => void;
        const beforeParentExit = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
        attachProcessSignalForwardingToChild(child, proc as any, { beforeParentExit });
        child.emit('exit', 0, null);
        await Promise.resolve();
        expect(proc.handlers.get('SIGTERM')).toHaveLength(1);
        proc.handlers.get('SIGTERM')![0]!();
        expect(proc.kill).not.toHaveBeenCalled();
        release();
        await vi.waitFor(() => expect(proc.kill).toHaveBeenCalledWith(proc.pid, 'SIGTERM'));
        expect(beforeParentExit).toHaveBeenCalledTimes(1);
    });

});
