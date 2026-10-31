import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, renderSettingsView } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

// Bootstrap/native are boundaries; the coordinator, parser, runner, command, hook and row stay real.
const bridge = vi.hoisted(() => ({
    nextId: 0, mode: 'at-login' as 'at-login' | 'on-demand' | null,
    defaultMode: 'at-login' as 'at-login' | 'on-demand' | null,
    defaultInstalled: true, pinned: false, complete: true, userOwned: false, failed: false,
    writes: [] as unknown[],
}));
installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});
vi.mock('@/utils/platform/tauri', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/tauri')>(), isTauriDesktop: () => true,
}));
vi.mock('@/components/systemTasks/systemTasksRuntime', async () => {
    const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
    const runner = createSystemTaskRunner({ bridge: {
        async start(spec) {
            if (spec.kind === 'daemon.service.autostart.set.v1') {
                bridge.writes.push(spec.params);
                const params = spec.params as { autostart: 'at-login' | 'on-demand' };
                bridge.mode = bridge.defaultMode = params.autostart;
            }
            return `${++bridge.nextId}:${spec.kind}`;
        },
        async subscribe(taskId, listeners) {
            queueMicrotask(() => listeners.onResult(bridge.failed
                ? { protocolVersion: 1, taskId, ok: false, error: { code: 'cli_spawn_failed', message: 'boom' } }
                : { protocolVersion: 1, taskId, ok: true, data: {
                    acquisition: { command: '/managed/happier', provenance: 'managed' },
                    server: { serverUrl: 'https://relay.example.test' },
                    auth: { credentialState: 'valid', validatedAccountId: 'acct_app', machineId: 'machine-1' },
                    service: { installed: bridge.defaultInstalled, running: bridge.defaultInstalled, autostart: bridge.defaultMode, targetMode: 'default-following' },
                    managedServiceAutostart: bridge.mode,
                    pinnedServices: { complete: bridge.complete, services: bridge.pinned ? [{
                        acquisition: { command: '/managed/happier', provenance: 'managed' },
                        server: { serverUrl: 'https://pin.example.test' },
                        service: { installed: true, running: false, autostart: bridge.mode ?? 'on-demand', targetMode: 'pinned' },
                        managedBy: bridge.userOwned ? null : 'desktop',
                    }] : [], unreadable: [] },
                    serviceRows: [
                        ...(bridge.defaultInstalled ? [{ relayUrl: 'https://relay.example.test', state: 'connected', appManaged: true, serving: 'default-following', actions: ['restart', 'stop'] }] : []),
                        ...(bridge.pinned ? [{ relayUrl: 'https://pin.example.test', state: 'offline', appManaged: !bridge.userOwned, serving: 'pinned', actions: bridge.userOwned ? [] : ['start'] }] : []),
                    ],
                } }));
            return () => {};
        },
        async cancel() {}, async respond() {},
    } });
    return { getSystemTasksRunner: () => runner };
});

import { desktopSetupCoordinator } from '@/setup/desktopSetupCoordinator';
import { DesktopSettingsSection } from './DesktopSettingsSection';
import { useDesktopBackgroundServiceAutostart } from './useDesktopBackgroundServiceAutostart';

async function refresh() {
    await act(async () => { await desktopSetupCoordinator.inspect({ fresh: true }); });
}

describe('useDesktopBackgroundServiceAutostart', () => {
    beforeEach(async () => {
        bridge.mode = bridge.defaultMode = 'at-login';
        bridge.defaultInstalled = bridge.complete = true;
        bridge.pinned = bridge.userOwned = bridge.failed = false;
        bridge.writes = [];
        await refresh();
    });

    it('follows the shared observation when another reader refreshes it', async () => {
        const hook = await renderHook(useDesktopBackgroundServiceAutostart);
        expect(hook.getCurrent().mode).toBe('at-login');
        bridge.mode = bridge.defaultMode = 'on-demand';
        await refresh();
        expect(hook.getCurrent().mode).toBe('on-demand');
        await hook.unmount();
    });

    it('presents a managed pin-only installation through the real hook and Settings row (A15-01/A15-05)', async () => {
        bridge.defaultInstalled = false;
        bridge.defaultMode = 'on-demand';
        bridge.pinned = true;
        await refresh();
        const hook = await renderHook(useDesktopBackgroundServiceAutostart);
        expect(hook.getCurrent()).toMatchObject({ installed: true, mode: 'at-login' });
        const screen = await renderSettingsView(<DesktopSettingsSection />);
        const row = screen.findAll((node) => node.props.title === 'settingsDesktop.backgroundServiceTitle')[0];
        expect(row?.props.subtitle).toBe('settingsDesktop.backgroundServiceSubtitle');
        expect(row?.props.rightElement.props.disabled).toBe(false);
        await hook.unmount();
    });

    it('keeps mixed managed modes unknown instead of using the default mode', async () => {
        bridge.pinned = true;
        bridge.mode = null;
        await refresh();
        const hook = await renderHook(useDesktopBackgroundServiceAutostart);
        expect(hook.getCurrent()).toMatchObject({ installed: true, mode: null });
        await hook.unmount();
    });

    it('distinguishes an empty managed inventory from an incomplete one and a user-owned pin', async () => {
        bridge.defaultInstalled = false;
        bridge.mode = null;
        bridge.pinned = bridge.userOwned = true;
        await refresh();
        const hook = await renderHook(useDesktopBackgroundServiceAutostart);
        expect(hook.getCurrent().installed).toBe(false);
        bridge.complete = false;
        await refresh();
        expect(hook.getCurrent().installed).toBeNull();
        await hook.unmount();
    });

    it('writes through the real service command and refreshes the shared observation', async () => {
        const hook = await renderHook(useDesktopBackgroundServiceAutostart);
        await act(async () => { await hook.getCurrent().setMode('on-demand'); });
        await vi.waitFor(() => expect(hook.getCurrent().mode).toBe('on-demand'));
        expect(bridge.writes).toEqual([expect.objectContaining({ autostart: 'on-demand' })]);
        await hook.unmount();
    });

    it('reports a failed read instead of a mode nobody proved', async () => {
        bridge.failed = true;
        await refresh();
        const hook = await renderHook(useDesktopBackgroundServiceAutostart);
        expect(hook.getCurrent()).toMatchObject({ mode: null, installed: null, error: 'boom' });
        await hook.unmount();
    });
});
