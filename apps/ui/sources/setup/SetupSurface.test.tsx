import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TASK_PROTOCOL_VERSION, type SystemTaskEvent } from '@happier-dev/protocol';

import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { renderScreen } from '@/dev/testkit';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    });
});

const hostVisibleState = vi.hoisted(() => ({ visible: true }));
vi.mock('@/hooks/ui/useIsHostVisible', () => ({
    useIsHostVisible: () => hostVisibleState.visible,
}));

const reducedMotionState = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/hooks/ui/useReducedMotionPreference', () => ({
    useReducedMotionPreference: () => reducedMotionState.enabled,
}));

const taskIpc = vi.hoisted(() => ({ listeners: new Map<string, (payload: unknown) => void>() }));
vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => false,
    invokeTauri: async (command: string) => {
        if (command === 'start_system_task') return { taskId: 'warmup' };
        if (command === 'get_system_task_snapshot') return { events: [], result: null };
        throw new Error(`Unexpected desktop command: ${command}`);
    },
    listenTauriEvent: async (name: string, callback: (payload: unknown) => void) => {
        taskIpc.listeners.set(name, callback);
        return () => taskIpc.listeners.delete(name);
    },
}));

vi.mock('@/components/navigation/shell/desktopChrome/useResolvedDesktopWindowControls', () => ({
    useResolvedDesktopWindowControls: () => null,
}));

import { SETUP_SURFACE_EXIT_MS, SetupSurface } from './SetupSurface';
import { SETUP_STAGES, type SetupLocalFacts } from './setupStageModel';

const RELAY = 'relay.example.test';

function facts(overrides: Partial<SetupLocalFacts> = {}): SetupLocalFacts {
    return { relayDisplayName: RELAY, entry: 'setup', startFailure: null, ...overrides };
}

/** Node mocks that can take focus, so "focus moved once" is observable rather than inferred. */
function focusTrackingNodeMocks() {
    const focused: string[] = [];
    return {
        focused,
        createNodeMock: (element: React.ReactElement) => ({
            focus: () => {
                focused.push(String((element.props as { testID?: unknown } | undefined)?.testID ?? ''));
            },
        }),
    };
}

function progress(stepId: string, tsMs: number): SystemTaskEvent {
    return { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', tsMs, type: 'progress', stepId, message: stepId };
}

function runState(overrides: Partial<SystemTaskRunState> = {}): SystemTaskRunState {
    const events = overrides.events ?? [];
    const latest = events[events.length - 1] ?? null;
    return {
        taskId: 'task_1',
        status: 'running',
        currentStepId: latest?.stepId ?? null,
        latestMessage: latest?.message ?? null,
        awaitingInput: false,
        cancelRequested: false,
        events,
        result: null,
        ...overrides,
    };
}

const FAILED = runState({
    status: 'failed',
    events: [progress('setup.thisComputer.installService', 240)],
    result: {
        protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
        taskId: 'task_1',
        ok: false,
        error: { code: 'service_install_blocked', message: 'systemd user bus unavailable' },
    },
});

const SUCCEEDED = runState({
    status: 'succeeded',
    events: [progress('setup.thisComputer.startService', 240)],
    result: { protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION, taskId: 'task_1', ok: true, data: { machineId: 'm' } },
});

function textOf(node: { props: { children?: unknown } } | null): string {
    if (!node) return '';
    const children = node.props.children;
    return Array.isArray(children) ? children.join('') : String(children ?? '');
}

beforeEach(() => {
    reducedMotionState.enabled = false;
    hostVisibleState.visible = true;
});

describe('SetupSurface actions (R7)', () => {
    it('replays warmup bytes in the mounted leaf without rerendering its host or completing setup', async () => {
        vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
        reducedMotionState.enabled = true;
        const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
        const { DesktopSetupTaskSurface } = await import('./DesktopSetupTaskSurface');
        const runner = getSystemTasksRunner();
        const taskId = await runner.start({ protocolVersion: 1, kind: 'daemon.service.status.v1', params: {} });
        const emit = (tsMs: number, data: SystemTaskEvent['data']) => taskIpc.listeners.get(`systemTasks://task/${taskId}/event`)?.({
            protocolVersion: 1, taskId, tsMs, type: 'cli.acquisition.progress', stepId: 'setup.thisComputer.ensureCli', data,
        });
        emit(1, { phase: 'downloading', receivedBytes: 1024 });
        let hostRenders = 0;
        function Host() {
            hostRenders++;
            return <DesktopSetupTaskSurface inspectionTaskId={taskId} run={null} facts={facts({ entry: 'checking' })} />;
        }
        try {
            const screen = await renderScreen(<Host />);
            expect(textOf(screen.findByTestId('setup-surface:download-progress'))).toContain('"received":"1.0 KB"');
            const initialRenders = hostRenders;
            await act(async () => { emit(2, { phase: 'downloading', receivedBytes: 2048, totalBytes: 4096 }); });
            expect(textOf(screen.findByTestId('setup-surface:download-progress'))).toContain('"total":"4.0 KB"');
            expect(hostRenders).toBe(initialRenders);
            await act(async () => { emit(3, { phase: 'unpacking' }); });
            expect(screen.findByTestId('setup-surface:download-progress')).toBeNull();
            expect(textOf(screen.findByTestId('setup-surface:status'))).toBe('setupSurface.acquisitionUnpackingStatus');
            await act(async () => {
                taskIpc.listeners.get(`systemTasks://task/${taskId}/result`)?.({ protocolVersion: 1, taskId, ok: true });
            });
            expect(screen.findByTestId('setup-surface:checking')).not.toBeNull();
            expect(screen.findByTestId('setup-surface:mark')?.props.accessibilityLabel).toContain('"step":1');
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('shows real transfer bytes separately from phase announcements and clears them after failure', async () => {
        reducedMotionState.enabled = true;
        const active = runState({ events: [{ ...progress('setup.thisComputer.ensureCli', 1), type: 'cli.acquisition.progress', data: { phase: 'downloading', receivedBytes: 1024 } }] });
        const screen = await renderScreen(<SetupSurface run={active} facts={facts({ entry: 'checking' })} />);
        expect(textOf(screen.findByTestId('setup-surface:status'))).toBe('setupSurface.acquisitionDownloadingStatus');
        expect(textOf(screen.findByTestId('setup-surface:download-progress'))).toContain('"received":"1.0 KB"');
        expect(screen.findByTestId('setup-surface:live')?.findAllByProps({ testID: 'setup-surface:download-progress' })).toHaveLength(0);
        await screen.update(<SetupSurface run={{ ...active, status: 'failed', result: { protocolVersion: 1, taskId: 'task_1', ok: false, error: { code: 'cli_acquisition_downloading_failed', message: 'connection interrupted' } } }} facts={facts({ entry: 'checking' })} />);
        expect(screen.findByTestId('setup-surface:download-progress')).toBeNull();
        expect(screen.findByTestId('setup-surface:blocked')).not.toBeNull();
    });

    it('renders no action in ordinary progress states', async () => {
        for (const stepId of ['setup.thisComputer.ensureCli', 'setup.thisComputer.configureRelay', 'setup.thisComputer.installService', 'setup.thisComputer.restartService']) {
            const screen = await renderScreen(
                <SetupSurface
                    run={runState({ events: [progress(stepId, 10)] })}
                    facts={facts()}

                    onRetry={() => {}}
                />,
            );
            expect(screen.findByTestId('setup-surface:retry')).toBeNull();
            expect(screen.findByTestId('setup-surface:details')).toBeNull();
            expect(screen.findByTestId('setup-surface:working')).not.toBeNull();
        }
    });

    it('renders no action while checking or verifying, and never reaches a success state', async () => {
        const checking = await renderScreen(
            <SetupSurface run={null} facts={facts({ entry: 'checking' })} onRetry={() => {}} />,
        );
        expect(checking.findByTestId('setup-surface:checking')).not.toBeNull();
        expect(checking.findByTestId('setup-surface:retry')).toBeNull();

        // Task success opens the verify stage. The host swaps in the shell the moment readiness is
        // proven, so there is no state in which this surface congratulates anyone.
        const verifying = await renderScreen(
            <SetupSurface run={SUCCEEDED} facts={facts()} onRetry={() => {}} />,
        );
        expect(verifying.findByTestId('setup-surface:working')).not.toBeNull();
        expect(verifying.findByTestId('setup-surface:complete')).toBeNull();
        expect(verifying.findByTestId('setup-surface:retry')).toBeNull();
        expect(verifying.findByTestId('setup-surface:details')).toBeNull();
    });

    it('offers retry and details only when blocked, each reachable by keyboard', async () => {
        const onRetry = vi.fn();
        const screen = await renderScreen(
            <SetupSurface run={FAILED} facts={facts()} onRetry={onRetry} />,
        );

        expect(screen.findByTestId('setup-surface:blocked')).not.toBeNull();
        for (const id of ['setup-surface:retry', 'setup-surface:details']) {
            const node = screen.findByTestId(id);
            expect(node).not.toBeNull();
            // Pressables reach the keyboard as buttons: a role and a name, never a bare view.
            expect(node?.props.accessibilityRole).toBe('button');
            expect(typeof node?.props.accessibilityLabel).toBe('string');
            expect(node?.props.accessibilityLabel.length).toBeGreaterThan(0);
        }

        screen.pressByTestId('setup-surface:retry');
        expect(onRetry).toHaveBeenCalledTimes(1);

        // Details discloses the EXISTING diagnostics card, unchanged.
        expect(screen.findByTestId('system-task-progress-card')).toBeNull();
        await screen.pressByTestIdAsync('setup-surface:details');
        expect(screen.findByTestId('system-task-progress-card')).not.toBeNull();
        expect(screen.findByTestId('system-task-progress-status-failed')).not.toBeNull();
    });
});

describe('SetupSurface ways out of a blocked state (U4/R17)', () => {
    it('offers a calm way to continue without this computer beside Retry', async () => {
        const onContinueWithout = vi.fn();
        const screen = await renderScreen(
            <SetupSurface run={FAILED} facts={facts()} onRetry={() => {}} onContinueWithout={onContinueWithout} />,
        );

        const node = screen.findByTestId('setup-surface:continue-without');
        expect(node?.props.accessibilityRole).toBe('button');
        screen.pressByTestId('setup-surface:continue-without');
        expect(onContinueWithout).toHaveBeenCalledTimes(1);
    });

    it('never offers it while setup is still working', async () => {
        const screen = await renderScreen(
            <SetupSurface run={runState({ events: [progress('setup.thisComputer.configureRelay', 10)] })} facts={facts()} onRetry={() => {}} onContinueWithout={() => {}} />,
        );
        expect(screen.findByTestId('setup-surface:continue-without')).toBeNull();
    });

    it('offers Update, not Retry, when the command line is older than setup needs', async () => {
        const onUpdateCli = vi.fn();
        const outdated = runState({
            status: 'failed',
            result: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1',
                ok: false,
                error: { code: 'cli_below_setup_floor', message: 'happier 0.2.1 is below 0.2.9' },
            },
        });
        const screen = await renderScreen(
            <SetupSurface run={outdated} facts={facts()} onRetry={() => {}} onUpdateCli={onUpdateCli} />,
        );

        expect(screen.findByTestId('setup-surface:retry')).toBeNull();
        screen.pressByTestId('setup-surface:update-cli');
        expect(onUpdateCli).toHaveBeenCalledTimes(1);
    });

    it('says why the update did not finish in the one status sentence, keeping Update as the one action (R17)', async () => {
        const outdated = runState({
            status: 'failed',
            result: {
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1',
                ok: false,
                error: { code: 'cli_below_setup_floor', message: 'happier 0.2.1 is below 0.2.9' },
            },
        });
        const screen = await renderScreen(
            <SetupSurface
                run={outdated}
                facts={facts({ cliUpdateFailure: 'machine.thisComputer.cliUpdateRestartNotConverged' })}

                onRetry={() => {}}
                onUpdateCli={() => {}}
            />,
        );

        expect(textOf(screen.findByTestId('setup-surface:status'))).toBe('machine.thisComputer.cliUpdateRestartNotConverged');
        expect(screen.findByTestId('setup-surface:update-cli')).not.toBeNull();
        expect(screen.findByTestId('setup-surface:retry')).toBeNull();
    });

    it('keeps the byte counter on tabular numerals so it does not jitter as it updates (U14)', async () => {
        const downloading = runState({
            events: [{
                protocolVersion: SYSTEM_TASK_PROTOCOL_VERSION,
                taskId: 'task_1',
                tsMs: 1,
                type: 'cli.acquisition.progress',
                stepId: 'setup.thisComputer.ensureCli',
                data: { phase: 'downloading', receivedBytes: 1024, totalBytes: 4096 },
            }],
        });
        const screen = await renderScreen(<SetupSurface run={downloading} facts={facts({ entry: 'checking' })} />);
        const counter = screen.findByTestId('setup-surface:download-progress');
        const style = [counter?.props.style].flat(Infinity) as Array<Record<string, unknown> | undefined>;
        expect(style.some((entry) => Array.isArray(entry?.fontVariant) && (entry?.fontVariant as string[]).includes('tabular-nums'))).toBe(true);
    });
});

describe('SetupSurface over the Home content (R11)', () => {
    it('is the blurred veil over the area its host gives it, with the column anchored and centred', async () => {
        const run = runState({ events: [progress('setup.thisComputer.configureRelay', 120)] });
        const screen = await renderScreen(<SetupSurface run={run} facts={facts()} />);

        // The host (the Home route) sizes it, so it covers the Home content and nothing else.
        const veil = screen.findByTestId('setup-surface:veil');
        expect(veil).not.toBeNull();
        const veilStyle = Object.assign({}, ...[veil?.props.style].flat().filter(Boolean));
        expect(veilStyle.position).toBe('absolute');
        expect(screen.findByTestId('setup-surface:veilGlass')).not.toBeNull();

        // The installer-style composition: one centred column the mark anchors, not a card.
        const column = screen.root.findAll((node) => {
            const style = Object.assign({}, ...[node.props.style].flat().filter(Boolean));
            return style.maxWidth === 420;
        })[0];
        const columnStyle = Object.assign({}, ...[column?.props.style].flat().filter(Boolean));
        expect(columnStyle.alignItems).toBe('center');
        expect(columnStyle.borderWidth).toBeUndefined();
        const scroller = screen.findByTestId('setup-surface:working');
        const content = Object.assign({}, ...[scroller?.props.contentContainerStyle].flat().filter(Boolean));
        expect(content.paddingTop).toBeGreaterThan(0);
    });
});

describe('SetupSurface accessibility (INV3)', () => {
    it('announces the operation in a live region and the step position on the mark, never a percentage', async () => {
        const screen = await renderScreen(
            <SetupSurface
                run={runState({ events: [progress('setup.thisComputer.configureRelay', 120)] })}
                facts={facts()}

            />,
        );

        const live = screen.findByTestId('setup-surface:live');
        expect(live?.props.accessibilityLiveRegion).toBe('polite');
        const status = textOf(screen.findByTestId('setup-surface:status'));
        expect(status).toContain('setupSurface.stageConnectStatus');
        expect(status).toContain(RELAY);
        expect(status).not.toMatch(/%|percent/i);

        const mark = screen.findByTestId('setup-surface:mark');
        expect(mark?.props.accessibilityRole).toBe('image');
        expect(mark?.props.accessibilityLabel).toBe(`setupSurface.stepOfTotal:${JSON.stringify({ step: 2, total: SETUP_STAGES.length })}`);
        expect(mark?.props.accessibilityLabel).not.toMatch(/%|percent/i);

        expect(screen.findByTestId('setup-surface:title')?.props.accessibilityRole).toBe('header');
    });

    it('keeps the raw executor text out of the headline and behind Details', async () => {
        const screen = await renderScreen(
            <SetupSurface run={FAILED} facts={facts()} onRetry={() => {}} />,
        );

        const status = textOf(screen.findByTestId('setup-surface:status'));
        expect(status).toBe('setupSurface.blockedServiceConflictStatus');
        expect(status).not.toContain('systemd');
        expect(screen.findByTestId('setup-surface:diagnostic')).toBeNull();

        await screen.pressByTestIdAsync('setup-surface:details');
        expect(textOf(screen.findByTestId('setup-surface:diagnostic'))).toBe('systemd user bus unavailable');
    });

    it('renders the changing sentence through the app text primitive, so in-app font scaling reaches it', async () => {
        const screen = await renderScreen(
            <SetupSurface
                run={runState({ events: [progress('setup.thisComputer.configureRelay', 120)] })}
                facts={facts()}

            />,
        );

        // The title already scales; the sentence must come out of the same primitive rather than a
        // bare animated text node, which bypasses `uiFontScale` entirely.
        expect(screen.findByTestId('setup-surface:status')?.type)
            .toBe(screen.findByTestId('setup-surface:title')?.type);
    });

    it('never opens a Details card that reports "Done" under "Setup stopped"', async () => {
        // A proof failure names itself and carries no diagnostic: the run behind it SUCCEEDED, so
        // the generic card would say the task is done while the headline says setup stopped.
        const screen = await renderScreen(
            <SetupSurface
                run={SUCCEEDED}
                facts={facts({ verification: 'machine_unreachable' })}

                onRetry={() => {}}
            />,
        );

        expect(screen.findByTestId('setup-surface:blocked')).not.toBeNull();
        expect(screen.findByTestId('setup-surface:details')).toBeNull();
        expect(screen.findByTestId('system-task-progress-card')).toBeNull();
    });

    it('offers Details for a failure that never produced a run, using its own diagnostic', async () => {
        const screen = await renderScreen(
            <SetupSurface
                run={null}
                facts={facts({ startFailure: { code: 'cli_below_setup_floor', message: 'newest on stable is 0.2.12' } })}

                onRetry={() => {}}
            />,
        );

        expect(textOf(screen.findByTestId('setup-surface:status'))).toBe('setupSurface.blockedCliOutdatedStatus');
        await screen.pressByTestIdAsync('setup-surface:details');
        expect(textOf(screen.findByTestId('setup-surface:diagnostic'))).toBe('newest on stable is 0.2.12');
    });
});

describe('SetupSurface focus (accessibility)', () => {
    it('never takes keyboard focus, even when blocked: the app around it is in use (R11)', async () => {
        // A blocked panel is one calm sentence beside whatever the person is doing. Snatching the
        // caret to its Retry would pull them out of a session, a search field or Settings.
        const { focused, createNodeMock } = focusTrackingNodeMocks();
        const screen = await renderScreen(
            <SetupSurface run={FAILED} facts={facts()} onRetry={() => {}} />,
            { createNodeMock },
        );
        expect(focused).toEqual([]);

        await screen.pressByTestIdAsync('setup-surface:details');
        await act(async () => {
            screen.tree.update(<SetupSurface run={FAILED} facts={facts()} />);
        });
        expect(focused).toEqual([]);
        // The recovery actions are still there for the keyboard to reach.
        expect(screen.findByTestId('setup-surface:details')).not.toBeNull();
    });
});

describe('SetupSurface under accessibility preferences', () => {
    async function collectFacts() {
        const screen = await renderScreen(
            <SetupSurface
                run={runState({ events: [progress('setup.thisComputer.installService', 240)] })}
                facts={facts()}
            />,
        );
        const arc = screen.findByTestId('setup-surface:mark:arc');
        return {
            title: textOf(screen.findByTestId('setup-surface:title')),
            status: textOf(screen.findByTestId('setup-surface:status')),
            markLabel: screen.findByTestId('setup-surface:mark')?.props.accessibilityLabel,
            arcOffset: arc?.props.strokeDashoffset,
            highlightPresent: screen.findByTestId('setup-surface:mark:highlight') != null,
            phaseNode: screen.findByTestId('setup-surface:working') != null,
        };
    }

    it('preserves every fact under reduced motion and only removes the travelling highlight', async () => {
        const full = await collectFacts();
        reducedMotionState.enabled = true;
        const reduced = await collectFacts();

        expect(full.highlightPresent).toBe(true);
        expect(reduced.highlightPresent).toBe(false);
        expect(reduced.title).toBe(full.title);
        expect(reduced.status).toBe(full.status);
        expect(reduced.markLabel).toBe(full.markLabel);
        expect(reduced.arcOffset).toBe(full.arcOffset);
        expect(reduced.phaseNode).toBe(true);
    });

    it('re-announces the status sentence when the stage changes', async () => {
        const first = runState({ events: [progress('setup.thisComputer.configureRelay', 120)] });
        const screen = await renderScreen(<SetupSurface run={first} facts={facts()} />);
        expect(textOf(screen.findByTestId('setup-surface:status'))).toContain('stageConnectStatus');

        reducedMotionState.enabled = true;
        await act(async () => {
            screen.tree.update(
                <SetupSurface
                    run={runState({ events: [...first.events, progress('setup.thisComputer.installService', 240)] })}
                    facts={facts()}

                />,
            );
        });
        expect(textOf(screen.findByTestId('setup-surface:status'))).toContain('stageServiceStatus');
    });
});

describe('SetupSurface departure (reveal)', () => {
    it('hands usability back immediately and reports the end of its one exit beat', async () => {
        const onExited = vi.fn();
        const screen = await renderScreen(
            <SetupSurface run={SUCCEEDED} facts={facts()} exiting onExited={onExited} />,
        );

        // The Home is live throughout: the beat is the panel leaving, never a delay in front of it.
        expect(screen.findByTestId('setup-surface:veil')?.props.pointerEvents).toBe('none');
        expect(onExited).not.toHaveBeenCalled();

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, SETUP_SURFACE_EXIT_MS + 40));
        });
        expect(onExited).toHaveBeenCalledTimes(1);
    });

    it('leaves at once under reduced motion', async () => {
        reducedMotionState.enabled = true;
        const onExited = vi.fn();
        await renderScreen(
            <SetupSurface run={SUCCEEDED} facts={facts()} exiting onExited={onExited} />,
        );

        expect(onExited).toHaveBeenCalledTimes(1);
    });

    it('stays put while it is not leaving', async () => {
        const onExited = vi.fn();
        const screen = await renderScreen(
            <SetupSurface run={SUCCEEDED} facts={facts()} onExited={onExited} />,
        );

        expect(screen.findByTestId('setup-surface:veil')?.props.pointerEvents).not.toBe('none');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, SETUP_SURFACE_EXIT_MS + 40));
        });
        expect(onExited).not.toHaveBeenCalled();
    });
    it('comes back from an interrupted departure instead of staying invisible', async () => {
        const onExited = vi.fn();
        const screen = await renderScreen(
            <SetupSurface run={SUCCEEDED} facts={facts()} exiting onExited={onExited} />,
        );

        // The facts flipped back mid-beat — maintenance is needed again. The panel must return
        // from wherever the departure got to, and must not report an exit that never happened.
        await act(async () => {
            screen.tree.update(
                <SetupSurface run={SUCCEEDED} facts={facts()} onExited={onExited} />,
            );
        });
        // Reanimated drives the real surface from the UI thread; under the node stub the style is
        // resolved at render time, so one more commit is what makes the restored value observable.
        await act(async () => {
            screen.tree.update(
                <SetupSurface run={SUCCEEDED} facts={facts()} onExited={onExited} />,
            );
        });

        const panel = screen.findByTestId('setup-surface:veil');
        const style = Object.assign({}, ...[panel?.props.style].flat().filter(Boolean));
        expect(style.opacity).toBe(1);
        expect(panel?.props.pointerEvents).not.toBe('none');

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, SETUP_SURFACE_EXIT_MS + 40));
        });
        expect(onExited).not.toHaveBeenCalled();
    });
});
