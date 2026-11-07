import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SystemTaskRunState } from '@/components/systemTasks/types';
import { renderScreen, standardCleanup } from '@/dev/testkit';

/**
 * The runtime → panel composition: what the lifecycle publishes and what the Home shows of it. The
 * lifecycle's own decisions are proven with the real gate in `useDesktopLocalSetupGate.test.tsx`;
 * here the gate's answer is the input, so each case can name one presentation contract.
 */
const state = vi.hoisted(() => ({
    inspection: { status: 'pending' } as unknown,
    snapshotPresentation: 'panel' as 'panel' | 'hidden',
    snapshotState: 'checking' as 'checking' | 'setup' | 'ready' | 'blocked',
    activeTaskSnapshot: null as SystemTaskRunState | null,
    serverUrl: 'https://relay.example.test',
    cliUpdateErrorMessage: null as string | null,
}));

const retrySpy = vi.hoisted(() => vi.fn());

vi.mock('./SetupSurface', () => ({
    SetupSurface: (props: Record<string, unknown>) => React.createElement('SetupSurface', props),
}));

vi.mock('./useDesktopLocalSetupGate', () => ({
    useDesktopLocalSetupGate: () => ({
        snapshot: { state: state.snapshotState, presentation: state.snapshotPresentation, reason: null },
        inspection: state.inspection,
        inspectionTaskId: null,
        verification: { status: 'idle' },
        setupTask: { activeTaskSnapshot: state.activeTaskSnapshot, startError: null },
        retry: retrySpy,
        continueWithoutThisComputer: () => {},
    }),
}));

vi.mock('@/components/settings/machines/localControl/useCliUpdateTask', () => ({
    useCliUpdateTask: () => ({
        start: async () => {},
        snapshot: null,
        running: false,
        errorMessage: state.cliUpdateErrorMessage,
    }),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'custom-2', serverUrl: state.serverUrl, generation: 1 }),
}));

/** Only the fact the runtime reads from resolved facts for the panel: the CLI's channel. */
const RESOLVED_INSPECTION = { status: 'resolved', facts: { acquisition: { channel: null }, cliChoice: { mode: null, otherCli: null } } } as const;

const FAILED_RUN: SystemTaskRunState = {
    taskId: 'task_1',
    status: 'failed',
    currentStepId: null,
    latestMessage: null,
    awaitingInput: false,
    cancelRequested: false,
    events: [],
    result: {
        protocolVersion: 1,
        taskId: 'task_1',
        ok: false,
        error: { code: 'service_install_blocked', message: 'systemd user bus unavailable' },
    },
} as unknown as SystemTaskRunState;

async function renderShell() {
    const { DesktopLocalSetupRuntime } = await import('./DesktopLocalSetupRuntime');
    const { DesktopLocalSetupPanel } = await import('./DesktopLocalSetupPanel');
    const element = () => React.createElement(
        React.Fragment,
        null,
        React.createElement(DesktopLocalSetupRuntime),
        React.createElement(DesktopLocalSetupPanel),
    );
    const screen = await renderScreen(element());
    return {
        screen,
        rerender: async () => {
            await act(async () => {
                screen.tree.update(element());
            });
        },
    };
}

describe('DesktopLocalSetupPanel', () => {
    beforeEach(() => {
        state.snapshotPresentation = 'panel';
        state.snapshotState = 'checking';
        state.inspection = { status: 'pending' };
        state.activeTaskSnapshot = null;
        state.serverUrl = 'https://relay.example.test';
        state.cliUpdateErrorMessage = null;
        retrySpy.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('presents the lifecycle while it has something to say, and nothing when it does not', async () => {
        const { screen } = await renderShell();
        expect(screen.findByType('SetupSurface' as never).props.facts.entry).toBe('checking');

        standardCleanup();
        state.snapshotPresentation = 'hidden';
        const quiet = await renderShell();
        expect(quiet.screen.findAllByType('SetupSurface' as never)).toHaveLength(0);
    });

    it('gives the panel one exit beat instead of cutting it, and nothing waits on it', async () => {
        state.snapshotState = 'setup';
        const { screen, rerender } = await renderShell();
        expect(screen.findByType('SetupSurface' as never).props.exiting).toBeFalsy();

        state.snapshotPresentation = 'hidden';
        state.snapshotState = 'ready';
        await rerender();
        const departing = screen.findByType('SetupSurface' as never);
        expect(departing.props.exiting).toBe(true);

        await act(async () => {
            (departing.props.onExited as () => void)();
        });
        expect(screen.findAllByType('SetupSurface' as never)).toHaveLength(0);
    });

    it('acknowledges Retry at once: a pending inspection reads as checking, not as the run that already failed', async () => {
        state.snapshotState = 'blocked';
        state.activeTaskSnapshot = FAILED_RUN;
        state.inspection = { status: 'pending' };
        const { screen } = await renderShell();

        const surface = screen.findByType('SetupSurface' as never);
        expect(surface.props.run).toBeNull();
        expect(surface.props.facts.entry).toBe('checking');
    });

    it('reads as checking while a setup start is in flight and no task has been reported yet', async () => {
        state.snapshotState = 'setup';
        state.inspection = RESOLVED_INSPECTION;
        const { screen } = await renderShell();

        expect(screen.findByType('SetupSurface' as never).props.facts.entry).toBe('checking');
    });

    it('names the relay the way the welcome footer does — one host, no scheme', async () => {
        state.serverUrl = 'https://relay.example.test:8443/';
        const { screen } = await renderShell();

        expect(screen.findByType('SetupSurface' as never).props.facts.relayDisplayName)
            .toBe('relay.example.test:8443');
    });

    it('carries a failed Update into the panel sentence, from the one update owner (RV-7)', async () => {
        state.snapshotState = 'blocked';
        state.inspection = RESOLVED_INSPECTION;
        state.cliUpdateErrorMessage = 'The update installed, but the background service is still on the old version.';
        const { screen } = await renderShell();

        expect(screen.findByType('SetupSurface' as never).props.facts.cliUpdateFailure)
            .toBe('The update installed, but the background service is still on the old version.');
    });

    it('reports the panel as showing only while the Home has it on screen (R11)', async () => {
        // The Home guidance defers "this computer" to the panel only when the panel is really there:
        // /new, Automations, or the sidebar beside Settings still offer their own entry.
        const { useDesktopLocalSetupPanelShowing, DesktopLocalSetupRuntime } = await import('./DesktopLocalSetupRuntime');
        const { DesktopLocalSetupPanel } = await import('./DesktopLocalSetupPanel');
        let showing: boolean | null = null;
        function Probe() {
            showing = useDesktopLocalSetupPanelShowing();
            return null;
        }
        const element = (home: boolean) => React.createElement(
            React.Fragment,
            null,
            React.createElement(DesktopLocalSetupRuntime),
            home ? React.createElement(DesktopLocalSetupPanel) : null,
            React.createElement(Probe),
        );
        const screen = await renderScreen(element(false));
        expect(showing).toBe(false);

        await act(async () => {
            screen.tree.update(element(true));
        });
        expect(showing).toBe(true);

        state.snapshotPresentation = 'hidden';
        await act(async () => {
            screen.tree.update(element(true));
        });
        expect(showing).toBe(false);
    });
});
