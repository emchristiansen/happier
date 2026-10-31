import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import {
    claimTerminalReaderLease, releaseTerminalReaderLease, subscribeTerminalReaderLeaseAvailability,
} from '@/components/sessions/terminal/terminalReaderLeaseRegistry';
import {
    readTerminalSurfaceState, replaceTerminalSurfaceState, subscribeTerminalSurfaceState,
} from '@/components/sessions/terminal/terminalSurfaceStateCache';
import type { DaemonTerminalEnsureResponse, DaemonTerminalCloseResponse } from '@happier-dev/protocol';

const rpc = vi.hoisted(() => ({
    machineTerminalEnsure: vi.fn(), machineTerminalRestart: vi.fn(),
    machineTerminalStreamRead: vi.fn(), machineTerminalClose: vi.fn(),
    machineTerminalInput: vi.fn(), machineTerminalResize: vi.fn(),
}));
vi.mock('@/sync/ops/machineTerminal', () => rpc);

let useMachineTerminalSession: typeof import('./useMachineTerminalSession')['useMachineTerminalSession'];
beforeAll(async () => {
    const boundary = await import('@/sync/ops/machineTerminal');
    for (const name of Object.keys(rpc) as (keyof typeof rpc)[]) {
        expect(boundary[name]).toBe(rpc[name]);
        expect(vi.isMockFunction(boundary[name])).toBe(true);
    }
    ({ useMachineTerminalSession } = await import('./useMachineTerminalSession'));
});

let serial = 0;
function options(overrides: Partial<Parameters<typeof useMachineTerminalSession>[0]> = {}) {
    return {
        machineId: 'machine-1', cwd: '/repo', machineReachable: true,
        machineRpcTargetAvailable: true, terminalKey: `terminal-lifetime-test-${++serial}`,
        terminalRef: { current: null }, ...overrides,
    };
}
async function mount(params = options()) {
    const hook = await renderHook((current) => useMachineTerminalSession(current), { initialProps: params });
    await act(async () => hook.getCurrent().onReady(80, 24));
    await flushHookEffects();
    return hook;
}
const fresh = (terminalId: string): DaemonTerminalEnsureResponse => ({ ok: true, terminalId, reused: false });
async function resolveEnsure(deferred: ReturnType<typeof createDeferred<DaemonTerminalEnsureResponse>>, value: DaemonTerminalEnsureResponse) {
    await act(async () => deferred.resolve(value));
    await flushHookEffects();
}

beforeEach(() => {
    Object.values(rpc).forEach((mock) => mock.mockReset());
    rpc.machineTerminalEnsure.mockResolvedValue(fresh('terminal-1'));
    rpc.machineTerminalRestart.mockResolvedValue(fresh('terminal-2'));
    // A held read is a local transport boundary, not an idle polling loop.
    rpc.machineTerminalStreamRead.mockImplementation(() => new Promise(() => {}));
    rpc.machineTerminalClose.mockResolvedValue({ ok: true });
    rpc.machineTerminalInput.mockResolvedValue({ ok: true });
    rpc.machineTerminalResize.mockResolvedValue({ ok: true });
});

describe('useMachineTerminalSession shared reader controls', () => {
    it('keeps the stable terminal key on a typed session-attach request', async () => {
        const params = options({ terminalKey: `session-attach-${++serial}`, cwd: null, launch: { kind: 'session_attach', sessionId: 'session-1' } });
        const hook = await mount(params);
        expect(rpc.machineTerminalEnsure).toHaveBeenCalledWith('machine-1', expect.objectContaining({ terminalKey: params.terminalKey, launch: params.launch }));
        await hook.unmount();
        expect(rpc.machineTerminalClose).not.toHaveBeenCalled();
    });

    it('releases the reader lease after an early validation error so another pane can connect', async () => {
        const params = options();
        const failed = await mount({ ...params, machineId: null });
        expect(failed.getCurrent().error).toBe('terminal_missing_machine_target');
        const next = await mount(params);
        expect(rpc.machineTerminalEnsure).toHaveBeenCalledTimes(1);
        await failed.unmount(); await next.unmount();
    });

    it('releases the reader lease after a fatal RPC failure so another pane can retry', async () => {
        const params = options();
        rpc.machineTerminalEnsure.mockRejectedValueOnce(new Error('rpc exploded'));
        const failed = await mount(params);
        expect(failed.getCurrent().error).toBe('rpc exploded');
        const next = await mount(params);
        expect(rpc.machineTerminalEnsure).toHaveBeenCalledTimes(2);
        await failed.unmount(); await next.unmount();
    });

    it.each([
        { name: 'done', result: { ok: true, terminalId: 'terminal-1', events: [], nextCursor: 0, done: true } },
        { name: 'exit', result: { ok: true, terminalId: 'terminal-1', events: [{ t: 'exit', exitCode: 0 }], nextCursor: 0, done: false } },
        { name: 'fatal stream error', result: { ok: false, errorCode: 'terminal_session_missing' } },
    ])('releases the reader lease after $name so another pane can reconnect', async ({ result }) => {
        const params = options();
        rpc.machineTerminalStreamRead.mockResolvedValueOnce(result);
        const first = await mount(params);
        // done with no events follows the real short idle delay.
        if (result.ok && result.events?.length === 0) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)); });
        const next = await mount(params);
        expect(rpc.machineTerminalEnsure).toHaveBeenCalledTimes(2);
        await first.unmount(); await next.unmount();
    });
});

describe('owned authentication terminal lifetime', () => {
    it.each(['ensure', 'restart'] as const)('closes a fresh held %s result after disposal without reading or publishing it', async (operation) => {
        const params = options({ closeOnUnmount: true });
        const pending = createDeferred<DaemonTerminalEnsureResponse>();
        if (operation === 'ensure') rpc.machineTerminalEnsure.mockReturnValueOnce(pending.promise);
        const hook = await mount(params);
        if (operation === 'restart') {
            rpc.machineTerminalRestart.mockReturnValueOnce(pending.promise);
            await act(async () => hook.getCurrent().requestRestart());
        }
        const reads = rpc.machineTerminalStreamRead.mock.calls.length;
        const published: unknown[] = [];
        const unsubscribe = subscribeTerminalSurfaceState(params.terminalKey, (state) => published.push(state));
        await hook.unmount();
        await resolveEnsure(pending, fresh('late-owned'));
        expect(rpc.machineTerminalClose).toHaveBeenCalledWith('machine-1', { terminalId: 'late-owned' });
        expect(rpc.machineTerminalClose.mock.calls.filter((call) => call[1].terminalId === 'late-owned')).toHaveLength(1);
        expect(rpc.machineTerminalStreamRead).toHaveBeenCalledTimes(reads);
        expect(published).toEqual([]);
        unsubscribe();
    });

    it.each([undefined, false])('keeps a late shared result borrowed when closeOnUnmount is %s', async (closeOnUnmount) => {
        const pending = createDeferred<DaemonTerminalEnsureResponse>();
        rpc.machineTerminalEnsure.mockReturnValueOnce(pending.promise);
        const params = options({ closeOnUnmount });
        const hook = await mount(params);
        await hook.unmount(); await resolveEnsure(pending, fresh('shared-late'));
        expect(rpc.machineTerminalClose).not.toHaveBeenCalled();
        expect(rpc.machineTerminalEnsure.mock.calls[0][1].terminalKey).toBe(params.terminalKey);
    });

    it('never acquires close ownership for session_attach even with the flag', async () => {
        const hook = await mount(options({ closeOnUnmount: true, launch: { kind: 'session_attach', sessionId: 'shared-session' } }));
        await hook.unmount();
        expect(rpc.machineTerminalClose).not.toHaveBeenCalled();
    });

    it('keeps ordinary connection effect replacement inside the same owner lifetime', async () => {
        const pending = createDeferred<DaemonTerminalEnsureResponse>();
        rpc.machineTerminalEnsure.mockReturnValueOnce(pending.promise).mockResolvedValue({ ok: true, terminalId: 'terminal-1', reused: true });
        const params = options({ closeOnUnmount: true });
        const hook = await mount(params);
        await hook.rerender({ ...params, cwd: '/other' });
        await resolveEnsure(pending, fresh('terminal-1'));
        expect(rpc.machineTerminalClose).not.toHaveBeenCalled();
        expect(readTerminalSurfaceState(params.terminalKey)?.terminalId).toBe('terminal-1');
        await hook.unmount();
        expect(rpc.machineTerminalClose).toHaveBeenCalledExactlyOnceWith('machine-1', { terminalId: 'terminal-1' });
    });

    it('settles fresh ownership after a reused response from an ordinary replacement and disposal', async () => {
        const pending = createDeferred<DaemonTerminalEnsureResponse>();
        rpc.machineTerminalEnsure.mockReturnValueOnce(pending.promise)
            .mockResolvedValue({ ok: true, terminalId: 'same-private-terminal', reused: true });
        const params = options({ closeOnUnmount: true });
        const hook = await mount(params);
        await hook.rerender({ ...params, cwd: '/replacement' });
        expect(readTerminalSurfaceState(params.terminalKey)?.terminalId).toBe('same-private-terminal');
        await hook.unmount();
        expect(rpc.machineTerminalClose).not.toHaveBeenCalled();
        await resolveEnsure(pending, fresh('same-private-terminal'));
        expect(rpc.machineTerminalClose).toHaveBeenCalledExactlyOnceWith('machine-1', { terminalId: 'same-private-terminal' });
    });

    it.each(['refused', 'rejected'])('does not close a late %s acquisition', async (failure) => {
        const pending = createDeferred<DaemonTerminalEnsureResponse>();
        rpc.machineTerminalEnsure.mockReturnValueOnce(pending.promise);
        const hook = await mount(options({ closeOnUnmount: true }));
        await hook.unmount();
        await act(async () => {
            if (failure === 'refused') pending.resolve({ ok: false, errorCode: 'terminal_disabled', error: 'fixture refusal' });
            else pending.reject(new Error('offline fixture'));
        });
        await flushHookEffects();
        expect(rpc.machineTerminalClose).not.toHaveBeenCalled();
        expect(rpc.machineTerminalEnsure).toHaveBeenCalledTimes(1);
    });

    it('closes a bound positively owned ID once on normal unmount', async () => {
        const hook = await mount(options({ closeOnUnmount: true }));
        await hook.unmount();
        expect(rpc.machineTerminalClose).toHaveBeenCalledExactlyOnceWith('machine-1', { terminalId: 'terminal-1' });
    });

    it('settles an old machine response against its captured lifetime without replacing the new cache', async () => {
        const pending = createDeferred<DaemonTerminalEnsureResponse>();
        rpc.machineTerminalEnsure.mockReturnValueOnce(pending.promise).mockResolvedValue(fresh('new-terminal'));
        const old = options({ closeOnUnmount: true });
        const next = options({ closeOnUnmount: true, machineId: 'machine-2' });
        const hook = await mount(old);
        await hook.rerender(next);
        await resolveEnsure(pending, fresh('old-terminal'));
        expect(rpc.machineTerminalClose).toHaveBeenCalledWith('machine-1', { terminalId: 'old-terminal' });
        expect(readTerminalSurfaceState(next.terminalKey)?.terminalId).toBe('new-terminal');
        expect(rpc.machineTerminalClose).not.toHaveBeenCalledWith('machine-2', expect.anything());
        await hook.unmount();
    });

    it('reserves disposal before synchronous release listeners and through close completion', async () => {
        const params = options({ closeOnUnmount: true });
        const closing = createDeferred<DaemonTerminalCloseResponse>();
        rpc.machineTerminalClose.mockReturnValueOnce(closing.promise);
        const hook = await mount(params);
        const successor = Symbol('successor');
        const observations: boolean[] = [];
        const unsubscribe = subscribeTerminalReaderLeaseAvailability(params.terminalKey, () => {
            observations.push(claimTerminalReaderLease(params.terminalKey, successor));
        });
        await hook.unmount();
        expect(observations).toEqual([false]);
        expect(claimTerminalReaderLease(params.terminalKey, successor)).toBe(false);
        await act(async () => closing.resolve({ ok: true }));
        await flushHookEffects();
        unsubscribe();
        releaseTerminalReaderLease(params.terminalKey, successor);
    });

    it('preserves a newer actual lease and cache adopted through the real subscription', async () => {
        const params = options({ closeOnUnmount: true });
        // A finished reader releases the lease, while its original owner remains mounted.
        rpc.machineTerminalStreamRead.mockResolvedValueOnce({ ok: true, events: [{ t: 'exit', exitCode: 0 }], nextCursor: 0, done: true });
        const first = await mount(params);
        rpc.machineTerminalEnsure.mockResolvedValue({ ok: true, terminalId: 'successor-terminal', reused: true });
        const successor = await mount({ ...params, closeOnUnmount: false });
        expect(readTerminalSurfaceState(params.terminalKey)?.terminalId).toBe('successor-terminal');
        const cache = readTerminalSurfaceState(params.terminalKey);
        await first.unmount();
        expect(rpc.machineTerminalClose).not.toHaveBeenCalled();
        expect(readTerminalSurfaceState(params.terminalKey)).toEqual(cache);
        expect(successor.getCurrent().status).toBe('connected');
        await successor.unmount();
    });

    it('does not claim a canceled reused result with unknown provenance', async () => {
        const pending = createDeferred<DaemonTerminalEnsureResponse>();
        rpc.machineTerminalEnsure.mockReturnValueOnce(pending.promise);
        const hook = await mount(options({ closeOnUnmount: true }));
        await hook.unmount();
        await resolveEnsure(pending, { ok: true, terminalId: 'borrowed', reused: true });
        expect(rpc.machineTerminalClose).not.toHaveBeenCalled();
    });

    it('does not overwrite a newer cached surface when an old held result settles', async () => {
        const pending = createDeferred<DaemonTerminalEnsureResponse>();
        rpc.machineTerminalEnsure.mockReturnValueOnce(pending.promise);
        const params = options({ closeOnUnmount: true });
        const first = await mount(params);
        const newer = { terminalId: 'newer-cached', cursor: 42, output: 'newer output', detectedUrl: null };
        await act(async () => { replaceTerminalSurfaceState(params.terminalKey, newer); });
        await first.unmount(); await resolveEnsure(pending, fresh('old-late'));
        expect(readTerminalSurfaceState(params.terminalKey)).toEqual(newer);
        expect(rpc.machineTerminalClose).not.toHaveBeenCalled();
    });

    it.each(['rejected', 'refused'])('keeps %s close incomplete and refuses same-key handoff without a retry', async (failure) => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        if (failure === 'rejected') rpc.machineTerminalClose.mockRejectedValueOnce(new Error('fixture close unavailable'));
        else rpc.machineTerminalClose.mockResolvedValueOnce({ ok: false, errorCode: 'terminal_session_missing' });
        const params = options({ closeOnUnmount: true });
        const hook = await mount(params);
        await hook.unmount(); await flushHookEffects();
        const successor = Symbol('cannot-own-incomplete');
        expect(claimTerminalReaderLease(params.terminalKey, successor)).toBe(false);
        expect(rpc.machineTerminalClose).toHaveBeenCalledTimes(1);
        warning.mockRestore();
        releaseTerminalReaderLease(params.terminalKey, successor);
    });
});
