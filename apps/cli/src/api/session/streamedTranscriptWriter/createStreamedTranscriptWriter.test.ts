import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import type { ACPMessageData, ACPProvider } from '../sessionMessageTypes';
import { createStreamedTranscriptWriter } from './createStreamedTranscriptWriter';
import type { StreamedTranscriptEnqueueOptions, StreamedTranscriptWriterSession } from './types';

async function settleCommittedSnapshot(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('createStreamedTranscriptWriter', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('treats locally persisted queued commits as durable even when delivery is deferred', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));

    const enqueueAgentMessageCommitted = vi.fn(
      async (
        _provider: ACPProvider,
        _body: ACPMessageData,
        _opts: StreamedTranscriptEnqueueOptions,
      ) => ({ persisted: true as const, delivered: false }),
    );
    const session: StreamedTranscriptWriterSession = { enqueueAgentMessageCommitted };

    const writer = createStreamedTranscriptWriter({
      provider: 'codex',
      session,
      makeLocalId: () => 'segment-1',
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.setCommitProvenance({ kind: 'non_dependent', source: 'external' });
    writer.appendAssistantDelta('Queued durable snapshot');
    const summary = await writer.flushAll({ reason: 'turn-end' });
    await settleCommittedSnapshot();

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: 'Queued durable snapshot' },
      expect.objectContaining({ localId: 'segment-1' }),
    );
    expect(summary.assistantRoot.didDurablyFlush).toBe(true);
    expect(summary.segments[0]).toMatchObject({
      didDurablyFlush: true,
      lastCommittedState: 'complete',
    });
  });

  it('freezes producer-supplied causal provenance onto each durable segment', async () => {
    const enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true as const, delivered: false }));
    const writer = createStreamedTranscriptWriter({
      provider: 'gemini',
      session: { enqueueAgentMessageCommitted },
      makeLocalId: () => 'assistant-segment-1',
    });

    writer.setCommitProvenance({ kind: 'non_dependent', source: 'external' });
    writer.appendAssistantDelta('causal output');
    await writer.flushAll({ reason: 'turn-end' });

    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'gemini',
      expect.any(Object),
      expect.objectContaining({
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    );
  });

  it('uses exactly one commit owner: legacy direct without provenance and causal outbox with provenance', async () => {
    let localId = 0;
    const sendAgentMessageCommitted = vi.fn(async () => undefined);
    const enqueueAgentMessageCommitted = vi.fn(async () => ({ persisted: true as const, delivered: false }));
    const writer = createStreamedTranscriptWriter({
      provider: 'gemini',
      session: { sendAgentMessageCommitted, enqueueAgentMessageCommitted },
      makeLocalId: () => `segment-${++localId}`,
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });

    writer.appendAssistantDelta('unmigrated compatibility output');
    await writer.flushAll({ reason: 'turn-end' });

    expect(sendAgentMessageCommitted.mock.calls.length).toBeGreaterThan(0);
    expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();
    const directCommitCount = sendAgentMessageCommitted.mock.calls.length;

    writer.setCommitProvenance({ kind: 'non_dependent', source: 'external' });
    writer.appendAssistantDelta('causally classified Gemini output');
    await writer.flushAll({ reason: 'turn-end' });

    expect(sendAgentMessageCommitted).toHaveBeenCalledTimes(directCommitCount);
    expect(enqueueAgentMessageCommitted.mock.calls.length).toBeGreaterThan(0);
    expect(enqueueAgentMessageCommitted).toHaveBeenCalledWith(
      'gemini',
      expect.any(Object),
      expect.objectContaining({
        provenance: { kind: 'non_dependent', source: 'external' },
      }),
    );
  });

  it('awaits a caller-identified exact segment commit and surfaces an idempotent duplicate', async () => {
    const exactCommit = (() => {
      let resolve!: (value: { localId: string; messageId: string; seq: number; didWrite: boolean }) => void;
      const promise = new Promise<{ localId: string; messageId: string; seq: number; didWrite: boolean }>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    })();
    const sendAgentMessageCommitted = vi.fn(async () => {
      throw new Error('compatibility commit must not own an exact segment');
    });
    const sendAgentMessageCommittedExact = vi.fn(() => exactCommit.promise);
    const writer = createStreamedTranscriptWriter({
      provider: 'codex',
      session: {
        sendAgentMessageCommitted,
        sendAgentMessageCommittedExact,
        sendAgentMessageEphemeral: () => ({ accepted: true, epoch: 0 }),
      } as StreamedTranscriptWriterSession,
      makeLocalId: () => {
        throw new Error('exact segment must not generate a localId');
      },
      initialCheckpointDelayMs: 10_000,
      checkpointIntervalMs: 10_000,
      checkpointMinChars: 999,
    });
    const exactWriter = writer as typeof writer & {
      appendAssistantDeltaExact: (deltaText: string, opts: { localId: string; sidechainId?: string | null }) => void;
    };

    exactWriter.appendAssistantDeltaExact('durable assistant text', { localId: 'rollout-assistant-1' });
    let flushResolved = false;
    const flushPromise = writer.flushAll({ reason: 'turn-end' }).then((summary) => {
      flushResolved = true;
      return summary;
    });
    await expect.poll(() => sendAgentMessageCommittedExact.mock.calls.length).toBe(1);

    expect(flushResolved).toBe(false);
    expect(sendAgentMessageCommitted).not.toHaveBeenCalled();
    expect(sendAgentMessageCommittedExact).toHaveBeenCalledWith(
      'codex',
      { type: 'message', message: 'durable assistant text' },
      expect.objectContaining({ localId: 'rollout-assistant-1' }),
    );

    exactCommit.resolve({
      localId: 'rollout-assistant-1',
      messageId: 'message-1',
      seq: 61,
      didWrite: false,
    });
    await expect(flushPromise).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: true },
      segments: [expect.objectContaining({
        localId: 'rollout-assistant-1',
        commitResult: {
          localId: 'rollout-assistant-1',
          messageId: 'message-1',
          seq: 61,
          didWrite: false,
        },
      })],
    });
  });

  it('rejects an exact flush when durable acknowledgement fails', async () => {
    const writer = createStreamedTranscriptWriter({
      provider: 'codex',
      session: {
        sendAgentMessageCommittedExact: async () => {
          throw new Error('durable ACK unavailable');
        },
      },
    });

    writer.appendAssistantDeltaExact('must be durable', { localId: 'rollout-assistant-failed-1' });

    await expect(writer.flushAll({ reason: 'turn-end' })).rejects.toThrow(
      'Exact transcript segment commit failed for rollout-assistant-failed-1: durable ACK unavailable',
    );
  });

  it('coalesces fast durable failures into the latest segment snapshot and one failure incident', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const sendAgentMessageCommitted = vi.fn()
      .mockRejectedValueOnce(new Error('Socket not connected'))
      .mockRejectedValueOnce(new Error('Socket not connected'))
      .mockResolvedValue(undefined);
    const writer = createStreamedTranscriptWriter({
      provider: 'codex',
      session: { sendAgentMessageCommitted },
      makeLocalId: () => 'offline-segment-1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 0,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('a');
    await settleCommittedSnapshot();
    writer.appendAssistantDelta('b');
    await settleCommittedSnapshot();
    writer.appendAssistantDelta('c');
    await settleCommittedSnapshot();

    expect(sendAgentMessageCommitted).toHaveBeenCalledOnce();
    expect(debugSpy.mock.calls.filter(([message]) =>
      message === '[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)'
    )).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_000);
    await settleCommittedSnapshot();
    expect(sendAgentMessageCommitted).toHaveBeenCalledTimes(2);
    expect(sendAgentMessageCommitted.mock.calls[1]?.[1]).toEqual({ type: 'message', message: 'abc' });

    await vi.advanceTimersByTimeAsync(2_000);
    await settleCommittedSnapshot();
    expect(sendAgentMessageCommitted).toHaveBeenCalledTimes(3);
    expect(debugSpy.mock.calls.filter(([message]) =>
      message === '[StreamedTranscriptWriter] Durable snapshot commit failed (non-fatal)'
    )).toHaveLength(1);
    expect(debugSpy).toHaveBeenCalledWith(
      '[StreamedTranscriptWriter] Durable snapshot commit recovered',
      expect.objectContaining({ failureCount: 2, suppressedFailureCount: 1 }),
    );
  });

  it('does not delay a terminal durable snapshot behind streaming failure backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const sendAgentMessageCommitted = vi.fn()
      .mockRejectedValueOnce(new Error('Socket not connected'))
      .mockResolvedValue(undefined);
    const writer = createStreamedTranscriptWriter({
      provider: 'codex',
      session: { sendAgentMessageCommitted },
      makeLocalId: () => 'terminal-offline-segment-1',
      initialCheckpointDelayMs: 0,
      checkpointIntervalMs: 0,
      checkpointMinChars: 1,
    });

    writer.appendAssistantDelta('partial');
    await settleCommittedSnapshot();
    writer.appendAssistantDelta(' complete');

    await expect(writer.flushAll({ reason: 'turn-end' })).resolves.toMatchObject({
      assistantRoot: { sawText: true, didDurablyFlush: true },
    });
    expect(sendAgentMessageCommitted).toHaveBeenCalledTimes(2);
    expect(sendAgentMessageCommitted.mock.calls[1]?.[1]).toEqual({
      type: 'message',
      message: 'partial complete',
    });
    expect(sendAgentMessageCommitted.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      meta: expect.objectContaining({
        happierStreamSegmentV1: expect.objectContaining({ segmentState: 'complete' }),
      }),
    }));
  });
});
