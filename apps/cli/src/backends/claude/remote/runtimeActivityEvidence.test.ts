import { describe, expect, it, vi } from 'vitest';

import { createClaudeProviderRuntimeActivityAdapter } from '@/backends/claude/providerActivity/createClaudeProviderRuntimeActivityAdapter';
import type { SessionRuntimeActivityContribution } from '@/session/runtimeActivity/types';
import {
  createClaudeRuntimeActivityEvidence,
  handleClaudeRuntimeActivityLoss,
  observeClaudeProviderTaskRuntimeActivityHook,
  observeClaudeProviderTaskRuntimeActivityRow,
  reconcileClaudeRuntimeActivity,
} from './runtimeActivityEvidence';

describe('Claude runtime Activity evidence', () => {
  it('settles the provider task inventory on process exit even without a runtime contribution binding', () => {
    const evidence = createClaudeRuntimeActivityEvidence();
    evidence.providerActivityLedger.apply({ type: 'started', sessionId: 's1', taskId: 'background-task' });
    const params = { evidence, logger: { debug: vi.fn() }, logPrefix: '[unbound-runtime]' };

    handleClaudeRuntimeActivityLoss({ ...params, reason: 'observer-lost' });
    expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(true);

    handleClaudeRuntimeActivityLoss({ ...params, reason: 'process-exited', providerStopped: true });
    expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(false);
  });

  it('keeps a native SDK background child active after its launcher completes without requiring a launch hook', async () => {
    const reports: SessionRuntimeActivityContribution[] = [];
    const evidence = createClaudeRuntimeActivityEvidence();
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
      providerActivityLedger: evidence.providerActivityLedger,
      contributionHandle: { report: async value => { reports.push(value); }, markUnknown: async () => {}, dispose: async () => {} },
    });
    await runtimeActivityAdapter.activateObservation('sdk-installed');
    const params = { evidence, runtimeActivityAdapter, logger: { debug: vi.fn() }, logPrefix: '[nested-sdk]' };
    const hookStart = (taskId: string) => observeClaudeProviderTaskRuntimeActivityHook({ ...params, hook: {
      hook_event_name: 'PostToolUse', session_id: 'provider-session', tool_name: 'Agent',
      tool_response: { status: 'async_launched', agentId: taskId },
    } });
    hookStart('launcher');
    for (const isBackgrounded of [undefined, false]) {
      observeClaudeProviderTaskRuntimeActivityRow({ ...params, row: {
        type: 'system', subtype: 'task_started', session_id: 'provider-session', task_id: `foreground-${isBackgrounded}`,
        task_type: 'local_agent', ...(isBackgrounded === undefined ? {} : { is_backgrounded: isBackgrounded }), spawn_depth: 2,
      } });
    }
    observeClaudeProviderTaskRuntimeActivityRow({ ...params, row: {
      type: 'system', subtype: 'task_started', session_id: 'provider-session', task_id: 'nested-background',
      task_type: 'local_agent', is_backgrounded: true, spawn_depth: 2, tool_use_id: 'nested-tool',
    } });
    observeClaudeProviderTaskRuntimeActivityRow({ ...params, row: {
      type: 'system', subtype: 'task_notification', session_id: 'provider-session', task_id: 'launcher', status: 'completed',
    } });
    await vi.waitFor(() => expect(reports.at(-1)).toEqual({ state: 'active', activeCount: 1 }));
    expect(evidence.providerActivityLedger.getActiveProviderTaskCount()).toBe(1);
    hookStart('nested-background');
    await runtimeActivityAdapter.publishCurrent('duplicate-hook');
    expect(evidence.providerActivityLedger.getActiveProviderTaskCount()).toBe(1);
    observeClaudeProviderTaskRuntimeActivityRow({ ...params, row: {
      type: 'system', subtype: 'task_notification', session_id: 'provider-session', task_id: 'nested-background', status: 'completed',
    } });
    await vi.waitFor(() => expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 }));
  });

  it('routes exact authenticated legacy hook facts through the shared ledger', async () => {
    const reports: SessionRuntimeActivityContribution[] = [];
    const evidence = createClaudeRuntimeActivityEvidence();
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
      providerActivityLedger: evidence.providerActivityLedger,
      contributionHandle: {
        report: vi.fn(async (value) => { reports.push(value); }),
        markUnknown: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      },
    });
    await runtimeActivityAdapter.activateObservation('test-observer-installed');
    reports.splice(0);
    const params = {
      evidence,
      runtimeActivityAdapter,
      logger: { debug: vi.fn() },
      logPrefix: '[legacy-hook-test]',
    };

    expect(observeClaudeProviderTaskRuntimeActivityHook({
      ...params,
      hook: {
        hook_event_name: 'PostToolUse',
        session_id: 'provider-session',
        tool_name: 'Agent',
        tool_response: { status: 'async_launched', agentId: 'agent-1' },
      },
    })).toBe(true);
    await vi.waitFor(() => expect(reports).toEqual([{ state: 'active', activeCount: 1 }]));

    expect(observeClaudeProviderTaskRuntimeActivityHook({
      ...params,
      hook: {
        hook_event_name: 'StopFailure',
        session_id: 'provider-session',
        agent_id: 'agent-1',
        error: 'authentication_failed',
      },
    })).toBe(true);
    await vi.waitFor(() => expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 }));
  });

  it('reconciles from the canonical provider ledger without a second live-task membership map', async () => {
    const reports: SessionRuntimeActivityContribution[] = [];
    const evidence = createClaudeRuntimeActivityEvidence();
    evidence.providerActivityLedger.apply({
      type: 'started',
      sessionId: 'provider-session',
      taskId: 'task-from-sdk',
    });
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
      providerActivityLedger: evidence.providerActivityLedger,
      contributionHandle: {
        report: vi.fn(async (snapshot) => { reports.push(snapshot); }),
        markUnknown: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      },
    });
    await runtimeActivityAdapter.activateObservation('test-observer-installed');

    await reconcileClaudeRuntimeActivity({
      evidence,
      runtimeActivityAdapter,
      logger: { debug: vi.fn() },
      logPrefix: '[test]',
      reason: 'test-reconcile',
    });

    expect(reports.at(-1)).toEqual({
      state: 'active',
      activeCount: 1,
    });
  });

  it('routes exact live legacy stream rows into the shared tuple inventory without replay inference', async () => {
    const reports: SessionRuntimeActivityContribution[] = [];
    const markUnknown = vi.fn(async () => {});
    const evidence = createClaudeRuntimeActivityEvidence();
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
      providerActivityLedger: evidence.providerActivityLedger,
      contributionHandle: {
        report: vi.fn(async (snapshot) => { reports.push(snapshot); }),
        markUnknown,
        dispose: vi.fn(async () => {}),
      },
    });
    await runtimeActivityAdapter.activateObservation('test-observer-installed');
    reports.splice(0);
    const params = {
      evidence,
      runtimeActivityAdapter,
      logger: { debug: vi.fn() },
      logPrefix: '[legacy-test]',
    };

    expect(observeClaudeProviderTaskRuntimeActivityRow({
      ...params,
      row: {
        type: 'system',
        subtype: 'task_started',
        session_id: 'provider-session',
        task_id: 'legacy-task',
        task_type: 'local_bash',
      },
    })).toBe(true);
    await vi.waitFor(() => expect(reports).toHaveLength(1));

    expect(observeClaudeProviderTaskRuntimeActivityRow({
      ...params,
      row: {
        type: 'system',
        subtype: 'task_progress',
        session_id: 'provider-session',
        task_id: 'legacy-task',
        isReplay: true,
      },
    })).toBe(false);
    expect(reports).toHaveLength(1);

    expect(observeClaudeProviderTaskRuntimeActivityRow({
      ...params,
      row: {
        type: 'system',
        subtype: 'task_updated',
        session_id: 'provider-session',
        task_id: 'legacy-task',
        patch: { status: 'killed' },
      },
    })).toBe(true);
    await vi.waitFor(() => expect(reports).toHaveLength(2));
    expect(reports.at(-1)).toEqual({ state: 'idle', activeCount: 0 });
    expect(markUnknown).not.toHaveBeenCalled();
    expect(observeClaudeProviderTaskRuntimeActivityRow({
      ...params,
      row: {
        type: 'system',
        subtype: 'task_notification',
        session_id: 'provider-session',
        task_id: 'legacy-task',
        status: 'stopped',
      },
    })).toBe(true);
    await Promise.resolve();
    expect(reports).toHaveLength(2);
    expect(markUnknown).not.toHaveBeenCalled();
    expect(evidence.providerActivityLedger.hasActiveProviderTasks()).toBe(false);
  });
});
