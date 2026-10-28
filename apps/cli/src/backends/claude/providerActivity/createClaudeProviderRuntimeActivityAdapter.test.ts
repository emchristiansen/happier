import { describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import type { SessionRuntimeActivityContribution } from '@/session/runtimeActivity/types';
import { createSessionRuntimeActivity } from '@/session/runtimeActivity/createSessionRuntimeActivity';
import { createClaudeProviderActivityLedger, readClaudeProviderTaskActivity } from './createClaudeProviderActivityLedger';
import {
    createClaudeProviderRuntimeActivityAdapter,
    createClaudeProviderRuntimeActivityBindingOwner,
} from './createClaudeProviderRuntimeActivityAdapter';

function harness() {
    const reports: SessionRuntimeActivityContribution[] = [];
    const markUnknown = vi.fn(async (_reason: string) => {});
    const ledger = createClaudeProviderActivityLedger();
    const adapter = createClaudeProviderRuntimeActivityAdapter({
        providerActivityLedger: ledger,
        contributionHandle: {
            report: vi.fn(async (value) => { reports.push(value); }),
            markUnknown,
            dispose: vi.fn(async () => {}),
        },
    });
    return { adapter, ledger, reports, markUnknown };
}

describe('createClaudeProviderRuntimeActivityAdapter', () => {
    it('publishes settled inventory from the native stopped-child response while preserving another active child', async () => {
        const { adapter, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');
        for (const taskId of ['stopped-child', 'sibling']) {
            await adapter.observeActivity({ activity: { type: 'started', sessionId: 's1', taskId }, evidence: 'live' });
        }
        const response = { success: false, message: "Agent stopped-child was stopped by the user and won't be resumed. Treat its work as cancelled; only launch a new agent if the user explicitly asks." };
        const activity = readClaudeProviderTaskActivity({ type: 'user', sessionId: 's1', toolUseResult: response,
            message: { content: [{ type: 'tool_result', tool_use_id: 'send', content: JSON.stringify(response) }] } });
        expect(activity?.type).toBe('terminal');
        if (!activity) throw new Error('Expected native cancellation activity');
        await adapter.observeActivity({ activity, evidence: 'live' });
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
        await adapter.observeActivity({ activity: { type: 'terminal', sessionId: 's1', taskId: 'sibling' }, evidence: 'live' });
        expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
        expect(markUnknown).not.toHaveBeenCalled();
    });

    it('publishes prelaunch inventory without installing the provider observer', async () => {
        const { adapter, reports } = harness();

        await adapter.publishBeforeRuntimeStart('provider-not-started');
        expect(reports).toEqual([{ state: 'idle', activeCount: 0 }]);
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'installation-task' },
            evidence: 'live',
        });
        expect(reports).toEqual([{ state: 'idle', activeCount: 0 }]);
        await adapter.activateObservation('observer-installed');
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
    });

    it('preserves observed tasks when publishing prelaunch inventory', async () => {
        const { adapter, reports } = harness();
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'existing-task' },
            evidence: 'live',
        });
        await adapter.publishBeforeRuntimeStart('provider-not-started');
        expect(reports).toEqual([{ state: 'active', activeCount: 1 }]);
    });

    it('does not claim prelaunch idle while a lost observer leaves unresolved task evidence', async () => {
        const { adapter, reports, markUnknown } = harness();
        await adapter.activateObservation('local-observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'existing-task' }, evidence: 'live',
        });
        await adapter.handleRuntimeLoss('claude_process_exit');
        const reportsBefore = [...reports];

        await adapter.publishBeforeRuntimeStart('remote-provider-not-started');
        expect(reports).toEqual(reportsBefore);
        expect(markUnknown).toHaveBeenCalledOnce();
    });

    it('does not clear observation loss before an observer was installed', async () => {
        const { adapter, reports, markUnknown } = harness();
        await adapter.handleRuntimeLoss('observer-lost');
        const reportsBefore = [...reports];
        const unknownOffersBefore = markUnknown.mock.calls.length;
        await adapter.publishBeforeRuntimeStart('replacement-provider-not-started');
        expect(reports).toEqual(reportsBefore);
        expect(markUnknown.mock.calls).toHaveLength(unknownOffersBefore);
    });

    it('publishes idle before restarting an owned provider after the stopped local observer lost activity', async () => {
        const { adapter, reports, markUnknown } = harness();
        await adapter.activateObservation('local-observer-installed');
        await adapter.handleRuntimeLoss('claude_process_exit');
        expect(markUnknown).toHaveBeenCalledOnce();
        expect(reports).toHaveLength(1);

        await adapter.publishBeforeRuntimeStart('remote-provider-not-started');
        expect(reports).toEqual([
            { state: 'idle', activeCount: 0 },
            { state: 'idle', activeCount: 0 },
        ]);
        await adapter.activateObservation('remote-observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'remote-task' }, evidence: 'live',
        });
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
    });

    it('does not revive tasks orphaned by a stopped provider when the relaunched runtime settles a turn', async () => {
        const { adapter, ledger, reports, markUnknown } = harness();
        await adapter.activateObservation('claude-agent-sdk-provider-observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'background-agent' }, evidence: 'live',
        });
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });

        // A model/mode change relaunches the provider; Claude Code reports the previous process's
        // background agents as orphaned, so no terminal event for them can ever arrive.
        await adapter.handleRuntimeLoss('claude_agent_sdk_stream_finalized', { providerStopped: true });
        expect(markUnknown).not.toHaveBeenCalled();
        expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
        await adapter.publishBeforeRuntimeStart('claude-remote-provider-not-started');
        await adapter.activateObservation('claude-agent-sdk-provider-observer-installed');
        await adapter.publishCurrent('claude_agent_sdk_foreground_result');

        expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
        expect(ledger.hasActiveProviderTasks()).toBe(false);

        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'relaunched-agent' }, evidence: 'live',
        });
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
    });

    it('does not publish prelaunch inventory through an obsolete runtime binding', async () => {
        const reports: SessionRuntimeActivityContribution[] = [];
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            providerActivityLedger: createClaudeProviderActivityLedger(),
            contributionHandle: {
                report: async (snapshot) => { reports.push(snapshot); },
                markUnknown: async () => {},
                dispose: async () => {},
            },
            isCurrentRuntime: () => false,
        });
        await adapter.publishBeforeRuntimeStart('obsolete-provider');
        expect(reports).toEqual([]);
    });

    it('fences the prior production binding without publishing before its observer is installed', async () => {
        const contributionHandle = {
            report: vi.fn(async () => {}),
            markUnknown: vi.fn(async () => {}),
            dispose: vi.fn(async () => {}),
        };
        const owner = createClaudeProviderRuntimeActivityBindingOwner(contributionHandle);

        const first = await owner.activate();
        expect(first.isCurrentRuntime()).toBe(true);
        expect(contributionHandle.report).not.toHaveBeenCalled();
        const replacement = await owner.activate();

        expect(first.isCurrentRuntime()).toBe(false);
        expect(replacement.isCurrentRuntime()).toBe(true);
        expect(contributionHandle.report).not.toHaveBeenCalled();
        expect(contributionHandle.markUnknown).not.toHaveBeenCalled();
        owner.invalidate();
        expect(replacement.isCurrentRuntime()).toBe(false);
    });

    it('offers the latest complete initial state only after observer installation', async () => {
        const { adapter, reports } = harness();

        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'installation-window-task' },
            evidence: 'live',
        });

        expect(reports).toEqual([]);
        await adapter.activateObservation('claude-provider-observer-installed');
        expect(reports).toEqual([{ state: 'active', activeCount: 1 }]);
    });

    it('does not replace an installation-window observation loss with blind idle', async () => {
        const { adapter, reports, markUnknown } = harness();

        await adapter.handleRuntimeLoss('scanner-lost-during-install');
        expect(reports).toEqual([]);
        expect(markUnknown).not.toHaveBeenCalled();

        await adapter.activateObservation('observer-installed');
        expect(reports).toEqual([]);
        expect(markUnknown).toHaveBeenCalledWith('observer-installed');
    });

    it('reconciles evidence arriving while the initial observer offer is pending', async () => {
        let releaseInitial = (): void => {};
        const initialPending = new Promise<void>((resolve) => { releaseInitial = resolve; });
        const reports: SessionRuntimeActivityContribution[] = [];
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            providerActivityLedger: createClaudeProviderActivityLedger(),
            contributionHandle: {
                report: vi.fn(async (value) => {
                    reports.push(value);
                    if (reports.length === 1) await initialPending;
                }),
                markUnknown: vi.fn(async () => {}),
                dispose: vi.fn(async () => {}),
            },
        });

        const activation = adapter.activateObservation('observer-installed');
        await vi.waitFor(() => expect(reports).toEqual([{ state: 'idle', activeCount: 0 }]));
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'during-install' }, evidence: 'live',
        });
        releaseInitial();
        await activation;

        expect(reports).toEqual([
            { state: 'idle', activeCount: 0 },
            { state: 'active', activeCount: 1 },
        ]);
    });

    it('never publishes again after the initial observer offer rejects', async () => {
        const report = vi.fn(async () => { throw new Error('offer rejected'); });
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            providerActivityLedger: createClaudeProviderActivityLedger(),
            contributionHandle: {
                report,
                markUnknown: vi.fn(async () => {}),
                dispose: vi.fn(async () => {}),
            },
        });

        await expect(adapter.activateObservation('observer-installed')).rejects.toThrow('offer rejected');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'after-failure' }, evidence: 'live',
        });
        await adapter.publishCurrent('after-failure');

        expect(report).toHaveBeenCalledTimes(1);
    });

    it('projects the current-runtime inventory and returns to idle after the last exact terminal', async () => {
        const { adapter, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'same' }, evidence: 'live',
        });
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's2', taskId: 'same' }, evidence: 'live',
        });
        await adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 's1', taskId: 'same' }, evidence: 'live',
        });
        await adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 's2', taskId: 'same' }, evidence: 'live',
        });

        expect(reports.map((value) => value.activeCount)).toEqual([0, 1, 2, 1, 0]);
        expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
        expect(markUnknown).not.toHaveBeenCalled();
    });

    it('uses unknown for same-runtime observation loss and keeps affirmative truth for live evidence', async () => {
        const { adapter, ledger, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 't1' }, evidence: 'historical-replay',
        });
        expect(ledger.hasActiveProviderTasks()).toBe(false);
        await adapter.handleRuntimeLoss('unavailable');
        expect(markUnknown).toHaveBeenLastCalledWith('unavailable');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 't1' }, evidence: 'live',
        });
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
        expect(ledger.hasActiveProviderTasks()).toBe(true);
    });

    it('preserves positive stop against delayed observer loss and task rows until a new launch begins', async () => {
        const runtimeActivity = createSessionRuntimeActivity('supported');
        const reports: SessionRuntimeActivityContribution[] = [];
        await runtimeActivity.bindPublisher({ publish: async snapshot => { reports.push(snapshot); }, close: async () => {} });
        const contributionHandle = runtimeActivity.agentRuntimeContributionHandle;
        if (!contributionHandle) throw new Error('Expected supported runtime Activity handle');
        const ledger = createClaudeProviderActivityLedger();
        const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger, contributionHandle });
        try {
            await adapter.activateObservation('observer-installed');
            await adapter.observeActivity({
                activity: { type: 'started', sessionId: 's1', taskId: 'orphaned' }, evidence: 'live',
            });
            await adapter.handleRuntimeLoss('claude_process_exited', { providerStopped: true });
            expect(ledger.hasActiveProviderTasks()).toBe(false);
            expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
            const stoppedReports = [...reports];
            await adapter.handleRuntimeLoss('delayed-session-end');
            expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
            expect(reports).toEqual(stoppedReports);
            await adapter.publishCurrent('later-inventory-refresh');
            await adapter.observeActivity({
                activity: { type: 'started', sessionId: 's1', taskId: 'delayed-old-task' }, evidence: 'live',
            });
            expect(ledger.hasActiveProviderTasks()).toBe(false);
            expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
            expect(reports).toEqual(stoppedReports);
            await adapter.publishBeforeRuntimeStart('replacement-provider-not-started');
            await adapter.activateObservation('replacement-observer-installed');
            await adapter.observeActivity({
                activity: { type: 'started', sessionId: 's1', taskId: 'replacement' }, evidence: 'live',
            });
            expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
            // After a new launch, payloads without launch provenance cannot be dismissed as stale.
            await adapter.handleRuntimeLoss('unattributed-session-end-after-relaunch');
            expect(reports.at(-1)).toEqual({ state: 'unknown', activeCount: 0 });
            await adapter.observeActivity({
                activity: { type: 'terminal', sessionId: 's1', taskId: 'replacement' }, evidence: 'live',
            });
            expect(ledger.hasActiveProviderTasks()).toBe(false);
            expect(reports.at(-1)).toEqual({ state: 'unknown', activeCount: 0 });
        } finally { await runtimeActivity.dispose(); }
    });

    it('does not reactivate a stopped provider when observer activation publication completes late', async () => {
        let releaseInitial!: () => void;
        const pending = new Promise<void>(resolve => { releaseInitial = resolve; });
        const reports: SessionRuntimeActivityContribution[] = [];
        const runtimeActivity = createSessionRuntimeActivity('supported');
        let holdInitial = true;
        await runtimeActivity.bindPublisher({ publish: async snapshot => {
            reports.push(snapshot);
            if (holdInitial && snapshot.state === 'idle') { holdInitial = false; await pending; }
        }, close: async () => {} });
        const contributionHandle = runtimeActivity.agentRuntimeContributionHandle;
        if (!contributionHandle) throw new Error('Expected supported runtime Activity handle');
        const ledger = createClaudeProviderActivityLedger();
        const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger, contributionHandle });
        try {
            const activation = adapter.activateObservation('observer-installed');
            await vi.waitFor(() => expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 }));
            const stopped = adapter.handleRuntimeLoss('provider-exited-during-activation', { providerStopped: true });
            releaseInitial();
            await Promise.all([activation, stopped]);
            await adapter.observeActivity({ activity: { type: 'started', sessionId: 's1', taskId: 'late-installation-row' }, evidence: 'live' });
            await adapter.handleRuntimeLoss('late-observer-loss');
            expect(ledger.hasActiveProviderTasks()).toBe(false);
            expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
        } finally { releaseInitial(); await runtimeActivity.dispose(); }
    });

    it('reoffers confirmed idle after a stopped-provider publication rejects without weakening the stop fact', async () => {
        const runtimeActivity = createSessionRuntimeActivity('supported');
        const published: SessionRuntimeActivityContribution[] = [];
        let rejectNextIdle = false;
        await runtimeActivity.bindPublisher({ publish: async snapshot => {
            if (rejectNextIdle && snapshot.state === 'idle') { rejectNextIdle = false; throw new Error('stop publication rejected'); }
            published.push(snapshot);
        }, close: async () => {} });
        const contributionHandle = runtimeActivity.agentRuntimeContributionHandle;
        if (!contributionHandle) throw new Error('Expected supported runtime Activity handle');
        const ledger = createClaudeProviderActivityLedger();
        const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger, contributionHandle });
        try {
            await adapter.activateObservation('observer-installed');
            await adapter.observeActivity({ activity: { type: 'started', sessionId: 's1', taskId: 'orphaned' }, evidence: 'live' });
            rejectNextIdle = true;
            await expect(adapter.handleRuntimeLoss('provider-exited', { providerStopped: true })).rejects.toThrow('stop publication rejected');
            expect(ledger.hasActiveProviderTasks()).toBe(false);
            await adapter.handleRuntimeLoss('delayed-session-end');
            expect(published.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
        } finally { await runtimeActivity.dispose(); }
    });

    it('keeps provider tasks when only observation is lost and the provider may still run them', async () => {
        const { adapter, ledger, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'workflow-1' }, evidence: 'live',
        });
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'subagent-1' }, evidence: 'live',
        });
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 2 });

        await adapter.handleRuntimeLoss('claude_agent_sdk_stream_finalized');

        // The query that owned those tasks is gone: a non-empty ledger is evidence of ignorance,
        // not of liveness, so the session must project unknown rather than stay active forever.
        expect(markUnknown).toHaveBeenLastCalledWith('claude_agent_sdk_stream_finalized');
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 2 });
        // Inventory evidence is preserved for blocker diagnostics; only the projection changes.
        expect(ledger.hasActiveProviderTasks()).toBe(true);
        const reportsAfterLoss = [...reports];
        await adapter.publishCurrent('later-inventory-refresh');
        expect(reports).toEqual(reportsAfterLoss);

        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'workflow-1' }, evidence: 'historical-replay',
        });
        expect(reports).toEqual(reportsAfterLoss);
        const handback = readClaudeProviderTaskActivity({
            type: 'user', sessionId: 's1',
            origin: { kind: 'peer', from: 'workflow-1', senderTaskId: 'workflow-1', handback: true },
        });
        if (!handback) throw new Error('expected native handback report delivery');
        await adapter.observeActivity({ activity: handback, evidence: 'live' });
        expect(reports).toEqual(reportsAfterLoss);
        await adapter.observeActivity({
            activity: { type: 'progress', sessionId: 's1', taskId: 'workflow-1' }, evidence: 'live',
        });
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
        await adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 's1', taskId: 'workflow-1' }, evidence: 'live',
        });
        expect(markUnknown).toHaveBeenCalledTimes(2);
        expect(ledger.hasActiveProviderTask({ sessionId: 's1', taskId: 'subagent-1' })).toBe(true);

        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'subagent-1' }, evidence: 'live',
        });
        expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 });
    });

    it('does not republish a projection after an in-flight observation loss already marked unknown', async () => {
        const { adapter, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');
        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 't1' }, evidence: 'live',
        });
        await adapter.handleRuntimeLoss('claude_process_exit');
        expect(markUnknown).toHaveBeenCalledTimes(1);

        await adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 's1', taskId: 't1' }, evidence: 'live',
        });

        expect(markUnknown).toHaveBeenCalledTimes(1);
    });

    it('does not republish an unchanged tuple inventory for progress aliases', async () => {
        const { adapter, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');

        await adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'workflow-1' }, evidence: 'live',
        });
        await adapter.observeActivity({
            activity: { type: 'progress', sessionId: 's1', taskId: 'workflow-1' }, evidence: 'live',
        });

        expect(reports.map((value) => value.activeCount)).toEqual([0, 1]);
        expect(markUnknown).not.toHaveBeenCalled();
    });

    it('keeps an untracked terminal inert instead of publishing synthetic unknown', async () => {
        const { adapter, reports, markUnknown } = harness();
        await adapter.activateObservation('observer-installed');

        await adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 'wrong-session', taskId: 'missing' },
            evidence: 'live',
        });

        expect(reports).toEqual([{ state: 'idle', activeCount: 0 }]);
        expect(markUnknown).not.toHaveBeenCalled();
    });

    it('serializes projection writes and fences queued callbacks from a stale runtime', async () => {
        let current = true;
        let releaseFirstReport = (): void => {
            throw new Error('first report was not armed');
        };
        const firstReportPending = new Promise<void>((resolve) => {
            releaseFirstReport = resolve;
        });
        const ledger = createClaudeProviderActivityLedger();
        const report = vi.fn(async () => {
            await firstReportPending;
        });
        const markUnknown = vi.fn(async () => {});
        const adapter = createClaudeProviderRuntimeActivityAdapter({
            providerActivityLedger: ledger,
            contributionHandle: {
                report,
                markUnknown,
                dispose: vi.fn(async () => {}),
            },
            isCurrentRuntime: () => current,
        });

        const activation = adapter.activateObservation('observer-installed');
        await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
        releaseFirstReport();
        await activation;

        let releaseActiveReport = (): void => {
            throw new Error('active report was not armed');
        };
        const activeReportPending = new Promise<void>((resolve) => {
            releaseActiveReport = resolve;
        });
        report.mockImplementationOnce(async () => {
            await activeReportPending;
        });

        const started = adapter.observeActivity({
            activity: { type: 'started', sessionId: 's1', taskId: 'task-1' }, evidence: 'live',
        });
        await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
        const terminal = adapter.observeActivity({
            activity: { type: 'terminal', sessionId: 's1', taskId: 'task-1' }, evidence: 'live',
        });

        expect(markUnknown).not.toHaveBeenCalled();
        current = false;
        releaseActiveReport();
        await Promise.all([started, terminal]);

        expect(report).toHaveBeenCalledTimes(2);
        expect(markUnknown).not.toHaveBeenCalled();
        expect(ledger.hasActiveProviderTasks()).toBe(false);
    });

    it('keeps an uncertain admitted invocation unknown without hiding a fresh sibling or unconfirming it', async () => {
        const ledger = createClaudeProviderActivityLedger();
        const states: Array<{ state: string; activeCount: number }> = [];
        const adapter = createClaudeProviderRuntimeActivityAdapter({ providerActivityLedger: ledger,
            contributionHandle: {
                report: async (value) => { states.push(value); },
                markUnknown: async () => { states.push({ state: 'unknown', activeCount: 0 }); },
                dispose: async () => {},
            },
        });
        await adapter.activateObservation('test');
        await adapter.observeActivity({ activity: { type: 'started', source: 'hook-agent-resume',
            confirmsActivity: false, sessionId: 's1', taskId: 'uncertain' }, evidence: 'live' });
        expect(states.at(-1)).toEqual({ state: 'unknown', activeCount: 0 });
        await adapter.observeActivity({ activity: { type: 'started', sessionId: 's1', taskId: 'fresh' }, evidence: 'live' });
        await adapter.observeActivity({ activity: { type: 'started', source: 'hook-agent-resume',
            confirmsActivity: false, sessionId: 's1', taskId: 'fresh' }, evidence: 'live' });
        expect(states.at(-1)).toEqual({ state: 'active', activeCount: 1 });
        await adapter.observeActivity({ activity: { type: 'terminal', sessionId: 's1', taskId: 'uncertain' }, evidence: 'live' });
        expect(states.at(-1)).toEqual({ state: 'active', activeCount: 1 });
        await adapter.observeActivity({ activity: { type: 'terminal', sessionId: 's1', taskId: 'fresh' }, evidence: 'live' });
        expect(states.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
    });

    it('keeps inventory truth when projection publication rejects', async () => {
        const fileLog = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        try {
            const ledger = createClaudeProviderActivityLedger();
            const report = vi.fn(async () => {
                if (report.mock.calls.length === 2) throw new Error('publish failed');
            });
            const adapter = createClaudeProviderRuntimeActivityAdapter({
                providerActivityLedger: ledger,
                contributionHandle: {
                    report,
                    markUnknown: vi.fn(async () => {}),
                    dispose: vi.fn(async () => {}),
                },
            });
            await adapter.activateObservation('observer-installed');
            await expect(adapter.observeActivity({
                activity: { type: 'started', sessionId: 's1', taskId: 't1' }, evidence: 'live',
            })).rejects.toThrow('publish failed');
            expect(fileLog).toHaveBeenCalledWith(expect.any(String), { state: 'active' });
            expect(JSON.stringify(fileLog.mock.calls)).not.toContain('publish failed');
            expect(ledger.hasActiveProviderTasks()).toBe(true);
            await expect(adapter.observeActivity({
                activity: { type: 'progress', sessionId: 's1', taskId: 't1' }, evidence: 'live',
            })).resolves.toBeUndefined();
            expect(report).toHaveBeenCalledTimes(3);
        } finally {
            fileLog.mockRestore();
        }
    });
});
