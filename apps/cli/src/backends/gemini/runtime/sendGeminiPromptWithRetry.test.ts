import { describe, expect, it, vi } from 'vitest';

import {
  AcpPromptSubmissionPhaseError,
  type AcpPromptSubmissionEvidence,
} from '@/agent/acp/AcpBackend';
import {
  sendGeminiPromptWithRetry,
  type GeminiPromptBackend,
} from './sendGeminiPromptWithRetry';

function exactPromptResponseEvidence(): AcpPromptSubmissionEvidence {
  return {
    kind: 'exact_final_response',
    response: { stopReason: 'end_turn' },
  };
}

describe('sendGeminiPromptWithRetry', () => {
  it('sends prompt once when backend succeeds immediately', async () => {
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
    });

    expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
    expect(backend.waitForResponseComplete).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).not.toHaveBeenCalled();
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('notifies provider prompt acceptance after exact final response evidence before response completion', async () => {
    let resolveResponseComplete!: () => void;
    const responseComplete = new Promise<void>((resolve) => {
      resolveResponseComplete = resolve;
    });
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn(async () => await responseComplete),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();
    const onProviderPromptAccepted = vi.fn();

    let settled = false;
    const promptPromise = sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      onProviderPromptAccepted,
    }).finally(() => {
      settled = true;
    });

    try {
      await vi.waitFor(() => {
        expect(backend.waitForResponseComplete).toHaveBeenCalledTimes(1);
      });
      await Promise.resolve();

      expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
      expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
    } finally {
      resolveResponseComplete();
      await promptPromise;
    }
  });

  it('publishes uncertainty without retry when first-update evidence precedes a failed exact prompt response', async () => {
    const promptError = new AcpPromptSubmissionPhaseError(
      'effect_may_have_occurred',
      new Error('Gemini prompt response was lost'),
    );
    const finalResponseEvidence = Promise.reject(promptError);
    void finalResponseEvidence.catch(() => {});
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue({
        kind: 'effect_may_have_occurred',
        finalResponseEvidence,
      }),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } satisfies GeminiPromptBackend;
    const onProviderPromptAccepted = vi.fn();
    const onProviderPromptAttemptStarted = vi.fn();
    const onProviderPromptEffectMayHaveOccurred = vi.fn();

    await expect(sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer: { addMessage: vi.fn() } as any,
      session: { sendAgentMessage: vi.fn() } as any,
      onDebug: vi.fn(),
      maxRetries: 2,
      retryDelayMs: 1,
      onProviderPromptAccepted,
      onProviderPromptAttemptStarted,
      onProviderPromptEffectMayHaveOccurred,
    })).rejects.toBe(promptError);

    expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
    expect(onProviderPromptAttemptStarted).toHaveBeenCalledTimes(1);
    expect(onProviderPromptEffectMayHaveOccurred).toHaveBeenCalledTimes(1);
    expect(onProviderPromptAccepted).not.toHaveBeenCalled();
  });

  it('preserves exact pre-effect rejection without publishing ambiguous provider effect', async () => {
    const promptError = new AcpPromptSubmissionPhaseError(
      'rejected_before_effect',
      new Error('Gemini session is not ready'),
    );
    const backend = {
      sendPromptWithEvidence: vi.fn().mockRejectedValue(promptError),
      waitForResponseComplete: vi.fn(),
    } satisfies GeminiPromptBackend;
    const onProviderPromptAccepted = vi.fn();
    const onProviderPromptAttemptStarted = vi.fn();
    const onProviderPromptEffectMayHaveOccurred = vi.fn();

    await expect(sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer: { addMessage: vi.fn() } as any,
      session: { sendAgentMessage: vi.fn() } as any,
      onDebug: vi.fn(),
      maxRetries: 2,
      retryDelayMs: 1,
      onProviderPromptAccepted,
      onProviderPromptAttemptStarted,
      onProviderPromptEffectMayHaveOccurred,
    })).rejects.toBe(promptError);

    expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
    expect(backend.waitForResponseComplete).not.toHaveBeenCalled();
    expect(onProviderPromptAttemptStarted).not.toHaveBeenCalled();
    expect(onProviderPromptEffectMayHaveOccurred).not.toHaveBeenCalled();
    expect(onProviderPromptAccepted).not.toHaveBeenCalled();
  });

  it('does not pass a bounded response wait timeout by default', async () => {
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
    });

    expect(backend.waitForResponseComplete).toHaveBeenCalledWith(null);
  });

  it('passes an explicit response wait timeout when configured', async () => {
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      waitForResponseTimeoutMs: 1234,
    });

    expect(backend.waitForResponseComplete).toHaveBeenCalledWith(1234);
  });

  it('returns the ACP turn outcome from response completion', async () => {
    const outcome = { kind: 'completed' as const, stopReason: 'end_turn' as const };
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn().mockResolvedValue(outcome),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    const result = await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
    });

    expect(result).toEqual(outcome);
  });

  it('does not retry timed-out ACP turn outcomes after provider acceptance', async () => {
    const outcome = { kind: 'timed_out' as const, capMs: 120_000 };
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn().mockResolvedValue(outcome),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();
    const onProviderPromptAccepted = vi.fn();

    const result = await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      onProviderPromptAccepted,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    expect(result).toEqual(outcome);
    expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
    expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      expect.anything(),
    );
  });

  it('does not retry ACP max-turn stop outcomes after provider acceptance', async () => {
    const outcome = { kind: 'completed' as const, stopReason: 'max_turn_requests' as const };
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn().mockResolvedValue(outcome),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();
    const onProviderPromptAccepted = vi.fn();

    const result = await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      onProviderPromptAccepted,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    expect(result).toEqual(outcome);
    expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
    expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      expect.anything(),
    );
  });

  it('does not retry stall timeout failures after provider acceptance', async () => {
    const stallError = new Error('Timeout waiting for response to complete');
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn().mockRejectedValue(stallError),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();
    const onProviderPromptAccepted = vi.fn();

    await expect(
      sendGeminiPromptWithRetry({
        backend,
        acpSessionId: 'session-1',
        prompt: 'hello',
        messageBuffer,
        session,
        onDebug,
        onProviderPromptAccepted,
        maxRetries: 2,
        retryDelayMs: 1,
      }),
    ).rejects.toBe(stallError);

    expect(onProviderPromptAccepted).toHaveBeenCalledTimes(1);
    expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      expect.anything(),
    );
  });

  it('does not retry aborted ACP turn outcomes', async () => {
    const outcome = { kind: 'aborted' as const, stopReason: 'cancelled' as const };
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn().mockResolvedValue(outcome),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    const result = await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer,
      session,
      onDebug,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    expect(result).toEqual(outcome);
    expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
  });

  it('does not retry an empty-response failure after provider invocation', async () => {
    const promptError = new AcpPromptSubmissionPhaseError(
      'effect_may_have_occurred',
      new Error('Model stream ended unexpectedly'),
    );
    const backend = {
      sendPromptWithEvidence: vi.fn().mockRejectedValue(promptError),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();
    const onProviderPromptEffectMayHaveOccurred = vi.fn();

    await expect(sendGeminiPromptWithRetry({
        backend,
        acpSessionId: 'session-1',
        prompt: 'hello',
        messageBuffer,
        session,
        onDebug,
        maxRetries: 2,
        retryDelayMs: 1,
        onProviderPromptEffectMayHaveOccurred,
      }))
      .rejects.toBe(promptError);

    expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
    expect(onProviderPromptEffectMayHaveOccurred).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('retrying'),
      expect.anything(),
    );
    expect(session.sendAgentMessage).not.toHaveBeenCalled();
  });

  it('rechecks provider admission before retrying a deterministic pre-invocation failure', async () => {
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } satisfies GeminiPromptBackend;
    const beforeProviderPromptAttempt = vi.fn()
      .mockRejectedValueOnce(new Error('empty response'))
      .mockResolvedValueOnce(undefined);

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer: { addMessage: vi.fn() } as any,
      session: { sendAgentMessage: vi.fn() } as any,
      onDebug: vi.fn(),
      maxRetries: 2,
      retryDelayMs: 1,
      beforeProviderPromptAttempt,
    });

    expect(beforeProviderPromptAttempt).toHaveBeenCalledTimes(2);
    expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
  });

  it('logs bounded retry metadata without provider error contents', async () => {
    const secret = 'Bearer must-not-appear-in-gemini-retry-log';
    const backend = {
      sendPromptWithEvidence: vi.fn().mockResolvedValue(exactPromptResponseEvidence()),
      waitForResponseComplete: vi.fn().mockResolvedValue(undefined),
    } satisfies GeminiPromptBackend;
    const beforeProviderPromptAttempt = vi.fn()
      .mockRejectedValueOnce(new Error(`Model stream ended: ${secret}`))
      .mockResolvedValueOnce(undefined);
    const onDebug = vi.fn();

    await sendGeminiPromptWithRetry({
      backend,
      acpSessionId: 'session-1',
      prompt: 'hello',
      messageBuffer: { addMessage: vi.fn() } as any,
      session: { sendAgentMessage: vi.fn() } as any,
      onDebug,
      maxRetries: 2,
      retryDelayMs: 1,
      beforeProviderPromptAttempt,
    });

    expect(onDebug).toHaveBeenCalledWith(
      '[gemini] Retrying provider prompt admission',
      {
        failedAttempt: 1,
        nextAttempt: 2,
        maxAttempts: 2,
        failureKind: 'empty_response',
      },
    );
    expect(JSON.stringify(onDebug.mock.calls)).not.toContain(secret);
  });

  it('does not retry quota errors and forwards quota message to session', async () => {
    const promptError = new AcpPromptSubmissionPhaseError(
      'effect_may_have_occurred',
      new Error('quota exhausted reset after 1h2m'),
    );
    const backend = {
      sendPromptWithEvidence: vi.fn().mockRejectedValue(promptError),
      waitForResponseComplete: vi.fn(),
    } satisfies GeminiPromptBackend;
    const messageBuffer = { addMessage: vi.fn() } as any;
    const session = { sendAgentMessage: vi.fn() } as any;
    const onDebug = vi.fn();

    await expect(
      sendGeminiPromptWithRetry({
        backend,
        acpSessionId: 'session-1',
        prompt: 'hello',
        messageBuffer,
        session,
        onDebug,
      }),
    ).rejects.toBeTruthy();

    expect(backend.sendPromptWithEvidence).toHaveBeenCalledTimes(1);
    expect(messageBuffer.addMessage).toHaveBeenCalledWith(
      expect.stringContaining('quota'),
      'status',
    );
    expect(session.sendAgentMessage).toHaveBeenCalledWith(
      'gemini',
      expect.objectContaining({ type: 'message' }),
    );
  });
});
