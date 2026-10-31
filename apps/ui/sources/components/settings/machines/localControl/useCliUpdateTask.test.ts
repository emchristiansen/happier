import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import type { SystemTaskBridgeListenerSet } from '@/components/systemTasks/types';
import { createSystemTaskRunner } from '@/components/systemTasks/createSystemTaskRunner';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';

import { describeCliUpdateFailure, useCliUpdateTask } from './useCliUpdateTask';
import { buildLocalDaemonServiceSystemTaskSpec } from './buildLocalDaemonServiceSystemTaskSpec';
import { readUnseenUpdateCompletions } from '@/updates/updateCompletions';

describe('describeCliUpdateFailure', () => {
    it('names why the update did not finish rather than one sentence for every failure (R17)', () => {
        expect(describeCliUpdateFailure({ code: 'cli_not_managed' })).toBe('machine.thisComputer.cliNotManaged');
        expect(describeCliUpdateFailure({ code: 'cli_acquisition_downloading_failed' })).toBe('setupSurface.acquisitionDownloadFailed');
        expect(describeCliUpdateFailure({ code: 'cli_update_rolled_back' })).toBe('updates.row.rolledBackLocal');
        expect(describeCliUpdateFailure({ code: 'cli_update_smoke_failed' })).toBe('updates.row.smokeFailed');
        expect(describeCliUpdateFailure({ code: 'cli_update_failed' })).toBe('machine.thisComputer.cliUpdateFailed');
        expect(describeCliUpdateFailure({ code: 'cli_command_failed' })).toBe('machine.thisComputer.cliUpdateFailed');
    });
});

describe('useCliUpdateTask (one CLI-update action for every surface, S-10)', () => {
    it('settles an immediately failed task and keeps the named failure visible', async () => {
        const runner = createSystemTaskRunner({ bridge: {
            async start() { return 'immediate-cli-failure'; },
            async subscribe(taskId, callbacks) {
                callbacks.onResult({ protocolVersion: 1, taskId, ok: false,
                    error: { code: 'cli_update_smoke_failed', message: 'The staged executable could not run.' },
                });
                return () => {};
            },
            async cancel() {},
            async respond() {},
        } });
        const hook = await renderHook(() => useCliUpdateTask({ runner }));
        await act(async () => { await hook.getCurrent().start(); });
        expect(hook.getCurrent().running).toBe(false);
        expect(hook.getCurrent().errorMessage).toBe('updates.row.smokeFailed');
        await hook.unmount();
    });
    it('uses the initiating batch task target and attributes its completion to that account after navigation', async () => {
        const scope = { serverId: 'local-batch-original-server', accountId: 'local-batch-original-account' };
        const spec = buildLocalDaemonServiceSystemTaskSpec('cli.update.v1', { relayUrl: 'https://original.example.test' });
        let started: unknown;
        let listener: SystemTaskBridgeListenerSet | undefined;
        const runner = createSystemTaskRunner({ bridge: {
            async start(input) { started = input; return 'captured-cli-update'; },
            async subscribe(_taskId, callbacks) { listener = callbacks; return () => {}; },
            async cancel() {},
            async respond() {},
        } });
        const initiating = await renderHook(() => useCliUpdateTask({ runner }));
        const start = initiating.getCurrent().start;
        await initiating.unmount();
        let settled = Promise.resolve();
        await act(async () => { settled = start({ scope, spec, machineId: 'original-machine' }); });
        expect(started).toEqual(spec);
        await act(async () => {
            listener?.onResult({ protocolVersion: 1, taskId: 'captured-cli-update', ok: true, data: {} });
            await settled;
        });
        expect(readUnseenUpdateCompletions(scope).get('original-machine:happier-cli')).toBe('done');
    });
    it('Home and Settings observe the same run: one start, one re-read, both see it running and finished', async () => {
        const inspect = vi.spyOn(desktopSetupCoordinator, 'inspect').mockResolvedValue({ status: 'pending' } as never);
        const starts: string[] = [];
        const listenersByTask = new Map<string, SystemTaskBridgeListenerSet>();
        // The desktop system-task bridge is the boundary; the runner above it is real.
        const runner = createSystemTaskRunner({
            bridge: {
                async start(spec) {
                    const taskId = `task_${starts.length + 1}`;
                    starts.push(spec.kind);
                    return taskId;
                },
                async subscribe(taskId, listeners) {
                    listenersByTask.set(taskId, listeners);
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        const homeSucceeded = vi.fn();
        const settingsSucceeded = vi.fn();

        const home = await renderHook(() => useCliUpdateTask({ runner, onSucceeded: homeSucceeded }));
        const settings = await renderHook(() => useCliUpdateTask({ runner, onSucceeded: settingsSucceeded }));

        let settled = Promise.resolve();
        await act(async () => { settled = home.getCurrent().start(); });
        await flushHookEffects();
        expect(settings.getCurrent()?.running).toBe(true);

        // A press on the other surface while it runs starts nothing new.
        await act(async () => { await settings.getCurrent()?.start(); });
        expect(starts).toEqual(['cli.update.v1']);

        await act(async () => {
            listenersByTask.get('task_1')?.onResult({ protocolVersion: 1, taskId: 'task_1', ok: true, data: {} });
            await settled;
        });
        await flushHookEffects();

        expect(home.getCurrent()?.running).toBe(false);
        expect(settings.getCurrent()?.running).toBe(false);
        expect(inspect).toHaveBeenCalledTimes(1);
        expect(inspect).toHaveBeenCalledWith({ fresh: true });
        expect(homeSucceeded).toHaveBeenCalledTimes(1);
        expect(settingsSucceeded).toHaveBeenCalledTimes(1);
        inspect.mockRestore();
    });

    it('another update already running is shown as in progress, never as an error (K5 cli_update_in_progress)', async () => {
        let refreshing = true;
        const inspect = vi.spyOn(desktopSetupCoordinator, 'inspect').mockResolvedValue({ status: 'pending' } as never);
        const readRefreshing = vi.spyOn(desktopSetupCoordinator, 'readInspectionRefreshing').mockImplementation(() => refreshing);
        const listenersByTask = new Map<string, SystemTaskBridgeListenerSet>();
        const runner = createSystemTaskRunner({
            bridge: {
                async start() { return 'task_busy'; },
                async subscribe(taskId, listeners) { listenersByTask.set(taskId, listeners); return () => {}; },
                async cancel() {},
                async respond() {},
            },
        });
        const hook = await renderHook(() => useCliUpdateTask({ runner }));
        let settled = Promise.resolve();
        await act(async () => { settled = hook.getCurrent().start(); });
        await act(async () => {
            listenersByTask.get('task_busy')?.onResult({
                protocolVersion: 1, taskId: 'task_busy', ok: false, error: { code: 'cli_update_in_progress', message: 'busy' },
            });
            await settled;
        });
        await flushHookEffects();
        expect(hook.getCurrent()?.errorMessage).toBeNull();
        expect(hook.getCurrent()?.running).toBe(true);
        expect(inspect).toHaveBeenCalledWith({ fresh: true });
        inspect.mockRestore();
        readRefreshing.mockRestore();
        refreshing = false;
    });
});
