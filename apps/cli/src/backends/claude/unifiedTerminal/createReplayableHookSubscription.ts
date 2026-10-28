import type { SessionHookData } from '../utils/startHookServer';
import type { ClaudeUnifiedSessionHookSubscription } from './createClaudeUnifiedHookLifecycleBridge';

export function createReplayableHookSubscription(
  subscribe: ClaudeUnifiedSessionHookSubscription | undefined,
): Readonly<{
  subscribe: ClaudeUnifiedSessionHookSubscription | undefined;
  finishStartup: () => void;
  dispose: () => void;
}> {
  if (!subscribe) {
    return {
      subscribe: undefined,
      finishStartup: () => {},
      dispose: () => {},
    };
  }

  let bufferedEvents: Array<Readonly<{ data: SessionHookData; observedAt: number }>> = [];
  const subscribers = new Set<Parameters<ClaudeUnifiedSessionHookSubscription>[0]>();
  let startupFinished = false;
  const isSubagentStart = (data: SessionHookData): boolean =>
    (data.hook_event_name ?? data.hookEventName ?? data.eventName) === 'SubagentStart';
  let replayWindowOpen = true;
  let drainReplayWindowScheduled = false;
  let disposed = false;
  const drainReplayWindow = (): void => {
    bufferedEvents = startupFinished ? [] : bufferedEvents.filter(event => isSubagentStart(event.data));
    replayWindowOpen = false;
    drainReplayWindowScheduled = false;
  };
  const scheduleReplayWindowDrain = (): void => {
    if (!replayWindowOpen || drainReplayWindowScheduled) return;
    drainReplayWindowScheduled = true;
    // Startup bridges subscribe together during controller startup; keep the replay window
    // through the current turn, then stop retaining hook payloads for the rest of the session.
    queueMicrotask(() => {
      if (disposed) return;
      drainReplayWindow();
    });
  };
  const unsubscribeUpstream = subscribe((data) => {
    const observedAt = Date.now();
    if (!startupFinished && isSubagentStart(data)) {
      bufferedEvents.push({ data, observedAt });
      return;
    }
    if (replayWindowOpen) {
      bufferedEvents.push({ data, observedAt });
    }
    for (const subscriber of [...subscribers]) {
      subscriber(data, { observedAt });
    }
  });

  return {
    subscribe: (callback) => {
      subscribers.add(callback);
      if (replayWindowOpen) {
        for (const event of bufferedEvents) {
          if (!isSubagentStart(event.data)) callback(event.data, { observedAt: event.observedAt, startupReplay: true });
        }
        scheduleReplayWindowDrain();
      }
      return () => {
        subscribers.delete(callback);
      };
    },
    finishStartup: () => {
      if (disposed || startupFinished) return;
      startupFinished = true;
      const startupEvents = bufferedEvents.filter(event => isSubagentStart(event.data));
      drainReplayWindow();
      for (const event of startupEvents) {
        for (const subscriber of [...subscribers]) {
          subscriber(event.data, { observedAt: event.observedAt, startupReplay: true });
        }
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      startupFinished = true;
      drainReplayWindow();
      subscribers.clear();
      unsubscribeUpstream?.();
    },
  };
}
