import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installMachinesSettingsCommonModuleMocks } from '@/components/settings/machines/machinesSettingsTestHelpers';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

installMachinesSettingsCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Platform: {
                OS: 'web',
                select: (options: Record<string, unknown>) => options?.web ?? options?.default,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
        });
    },
});

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title, footer }: { children?: React.ReactNode; title?: React.ReactNode; footer?: React.ReactNode }) =>
        React.createElement('Group', { title, footer }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: Record<string, unknown>) => React.createElement('Item', props),
}));

const LOCAL_PARAMS = {
    target: { kind: 'local' },
    surface: 'desktop.ui',
    mode: 'user',
    // The app's release ring: local tasks acquire the managed CLI from it.
    channel: 'stable',
};

async function createHarness() {
    const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
    const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

    let nextTaskId = 1;
    const listeners = new Map<string, {
        onEvent: (payload: unknown) => void;
        onResult: (payload: unknown) => void;
    }>();
    const starts: Array<{ kind: string; params: unknown }> = [];

    const runner = createSystemTaskRunner({
        bridge: {
            async start(spec) {
                const parsed = SystemTaskSpecSchema.parse(spec);
                starts.push({ kind: parsed.kind, params: parsed.params });
                return `task_${nextTaskId++}:${parsed.kind}`;
            },
            async subscribe(taskId, listenerSet) {
                listeners.set(taskId, listenerSet);
                return () => {
                    listeners.delete(taskId);
                };
            },
            async cancel() {},
            async respond() {},
        },
    });

    const { LocalCliPathExposureSection } = await import('./LocalCliPathExposureSection');
    const screen = await renderScreen(React.createElement(LocalCliPathExposureSection, { runner }));

    return {
        screen,
        starts,
        async resolve(taskId: string, data: Record<string, unknown>) {
            await renderer.act(async () => {
                listeners.get(taskId)?.onResult({ protocolVersion: 1, taskId, ok: true, data });
            });
        },
        async fail(taskId: string, message: string) {
            await renderer.act(async () => {
                listeners.get(taskId)?.onResult({
                    protocolVersion: 1,
                    taskId,
                    ok: false,
                    error: { code: 'cli_path_exposure_failed', message },
                });
            });
        },
    };
}

describe('LocalCliPathExposureSection', () => {
    it('starts the ensure task from the add row and shows the returned reload hint', async () => {
        const harness = await createHarness();

        expect(harness.starts).toEqual([]);
        await harness.screen.pressByTestIdAsync('settings.localCliPath.add');

        expect(harness.starts).toEqual([{ kind: 'cli.pathExposure.ensure.v1', params: LOCAL_PARAMS }]);

        await harness.resolve('task_1:cli.pathExposure.ensure.v1', {
            changed: true,
            shellReloadHint: 'Open a new terminal, or run: source "/home/me/.zshrc"',
            failure: null,
        });

        expect(harness.screen.findByTestId('settings.localCliPath.status')?.props.subtitle)
            .toBe('Open a new terminal, or run: source "/home/me/.zshrc"');
    });

    it('reports an already-present entry without claiming a change', async () => {
        const harness = await createHarness();

        await harness.screen.pressByTestIdAsync('settings.localCliPath.add');
        await harness.resolve('task_1:cli.pathExposure.ensure.v1', { changed: false, shellReloadHint: null, failure: null });

        expect(harness.screen.findByTestId('settings.localCliPath.status')?.props.subtitle).toBe('machine.cliPath.alreadyPresent');
    });

    it('says which other happier already answers in the terminal when nothing was added (R17/R6)', async () => {
        const harness = await createHarness();
        await harness.screen.pressByTestIdAsync('settings.localCliPath.add');
        await harness.resolve('task_1:cli.pathExposure.ensure.v1', {
            changed: false,
            shellReloadHint: null,
            failure: null,
            existingCommand: '/opt/homebrew/bin/happier',
        });

        const subtitle = String(harness.screen.findByTestId('settings.localCliPath.status')?.props.subtitle ?? '');
        expect(subtitle).toContain('machine.cliPath.existingCommand');
        expect(subtitle).toContain('/opt/homebrew/bin/happier');
    });

    it('starts the remove task from the remove row and reports what was removed', async () => {
        const harness = await createHarness();

        await harness.screen.pressByTestIdAsync('settings.localCliPath.remove');

        expect(harness.starts).toEqual([{ kind: 'cli.pathExposure.remove.v1', params: LOCAL_PARAMS }]);

        await harness.resolve('task_1:cli.pathExposure.remove.v1', { removed: true, failure: null });
        expect(harness.screen.findByTestId('settings.localCliPath.status')?.props.subtitle).toBe('machine.cliPath.removed');

        await harness.screen.pressByTestIdAsync('settings.localCliPath.remove');
        await harness.resolve('task_2:cli.pathExposure.remove.v1', { removed: false, failure: null });
        expect(harness.screen.findByTestId('settings.localCliPath.status')?.props.subtitle).toBe('machine.cliPath.nothingToRemove');
    });

    it('surfaces a task failure message and keeps both actions available', async () => {
        const harness = await createHarness();

        await harness.screen.pressByTestIdAsync('settings.localCliPath.add');
        await harness.fail('task_1:cli.pathExposure.ensure.v1', 'Could not update shell profile /home/me/.profile: EACCES');

        expect(harness.screen.findByTestId('settings.localCliPath.status')?.props.subtitle)
            .toBe('Could not update shell profile /home/me/.profile: EACCES');
        expect(harness.screen.findByTestId('settings.localCliPath.add')?.props.disabled).toBe(false);
        expect(harness.screen.findByTestId('settings.localCliPath.remove')?.props.disabled).toBe(false);
    });
});
