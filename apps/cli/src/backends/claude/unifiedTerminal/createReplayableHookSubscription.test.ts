import { describe, expect, it, vi } from 'vitest';

import type { SessionHookData } from '../utils/startHookServer';
import { createReplayableHookSubscription } from './createReplayableHookSubscription';
import { createClaudeProviderActivityLedger, readClaudeSessionHookProviderTaskActivity } from '../providerActivity/createClaudeProviderActivityLedger';

function createHarness(): Readonly<{
  emit: (data: SessionHookData) => void;
  subscription: ReturnType<typeof createReplayableHookSubscription>;
  unsubscribeUpstream: ReturnType<typeof vi.fn>;
}> {
  let upstreamCallback: ((data: SessionHookData) => void) | undefined;
  const unsubscribeUpstream = vi.fn();
  const subscription = createReplayableHookSubscription((callback) => {
    upstreamCallback = callback;
    return unsubscribeUpstream;
  });
  if (!upstreamCallback) {
    throw new Error('upstream hook subscription was not registered');
  }
  return {
    emit: upstreamCallback,
    subscription,
    unsubscribeUpstream,
  };
}

describe('createReplayableHookSubscription', () => {
  it('delegates deferred startup SubagentStart admission to the workflow owner, but admits a fresh start', () => {
    const { emit, subscription } = createHarness();
    const start: SessionHookData = { hook_event_name: 'SubagentStart', session_id: 'sess', agent_id: 'native-a' };
    emit(start);
    const ledger = createClaudeProviderActivityLedger();
    ledger.apply({ type: 'started', taskId: 'native-a', sessionId: 'sess', source: 'hook-agent-launch' });
    ledger.apply({ type: 'terminal', taskId: 'native-a', sessionId: 'sess', terminalStatus: 'completed' });
    subscription.subscribe?.((data, observation) => {
      if (observation?.startupReplay && data.hook_event_name === 'SubagentStart') return;
      const activity = readClaudeSessionHookProviderTaskActivity(data);
      if (activity) ledger.apply(activity);
    });
    expect(ledger.getActiveProviderTaskCount()).toBe(0);
    subscription.finishStartup();
    expect(ledger.getActiveProviderTaskCount()).toBe(0);
    emit(start);
    expect(ledger.getActiveProviderTaskCount()).toBe(1);
    subscription.dispose();
  });
  it('replays an early SessionStart to the first late startup subscriber', () => {
    const { emit, subscription } = createHarness();
    const earlySessionStart: SessionHookData = {
      hook_event_name: 'SessionStart',
      session_id: 'sess_early',
      transcript_path: '/tmp/sess_early.jsonl',
    };
    emit(earlySessionStart);

    const received: SessionHookData[] = [];
    subscription.subscribe?.((data) => {
      received.push(data);
    });

    expect(received).toEqual([earlySessionStart]);
    subscription.dispose();
  });

  it('drains startup replay before later high-volume PostToolUse hooks can be replayed', async () => {
    const { emit, subscription } = createHarness();
    const earlySessionStart: SessionHookData = {
      hook_event_name: 'SessionStart',
      session_id: 'sess_early',
      transcript_path: '/tmp/sess_early.jsonl',
    };
    emit(earlySessionStart);

    const startupSubscriberReceived: SessionHookData[] = [];
    subscription.subscribe?.((data) => {
      startupSubscriberReceived.push(data);
    });
    expect(startupSubscriberReceived).toEqual([earlySessionStart]);

    await Promise.resolve();

    for (let index = 0; index < 100; index += 1) {
      emit({
        hook_event_name: 'PostToolUse',
        session_id: 'sess_early',
        tool_use_id: `toolu_${index}`,
        tool_input: { index },
      });
    }

    expect(startupSubscriberReceived).toHaveLength(101);

    const lateSubscriberReceived: SessionHookData[] = [];
    subscription.subscribe?.((data) => {
      lateSubscriberReceived.push(data);
    });

    expect(lateSubscriberReceived).toEqual([]);
    subscription.dispose();
  });

  it('disposes the single upstream subscription', () => {
    const { subscription, unsubscribeUpstream } = createHarness();

    subscription.dispose();

    expect(unsubscribeUpstream).toHaveBeenCalledTimes(1);
  });

  it('disposes idempotently', () => {
    const { subscription, unsubscribeUpstream } = createHarness();

    subscription.dispose();
    subscription.dispose();

    expect(unsubscribeUpstream).toHaveBeenCalledTimes(1);
  });
});
