import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { logger } from '@/ui/logger';
import { createBackoff } from '@/utils/time';

export type AcpRequestOperation =
  | 'Initialize'
  | 'Authenticate'
  | 'NewSession'
  | 'StartSession'
  | 'LoadSession'
  | 'ForkSession';

export type AcpRequestFailureKind = 'transport' | 'timeout' | 'provider_rejection' | 'unknown';

export function classifyAcpRequestFailureForLog(error: unknown): AcpRequestFailureKind {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  if (
    normalized.includes('fetch failed')
    || normalized.includes('econnrefused')
    || normalized.includes('econnreset')
    || normalized.includes('socket hang up')
    || normalized.includes('connect_error')
    || normalized.includes('networkerror')
    || normalized.includes('other side closed')
  ) {
    return 'transport';
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) return 'timeout';
  if (error && typeof error === 'object' && 'code' in error) return 'provider_rejection';
  return 'unknown';
}

export function createAcpRequestFailureLogRecord(params: Readonly<{
  operation: AcpRequestOperation;
  error: unknown;
}>): Readonly<{
  operation: AcpRequestOperation;
  failureKind: AcpRequestFailureKind;
}> {
  return Object.freeze({
    operation: params.operation,
    failureKind: classifyAcpRequestFailureForLog(params.error),
  });
}

/**
 * Helper to run an async operation with retry logic.
 *
 * Delegates to the shared `createBackoff` utility while preserving
 * ACP-specific defaults: operation-name logging, non-Error wrapping,
 * and the `onRetry` callback.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: {
    operationName: AcpRequestOperation;
    maxAttempts: number;
    baseDelayMs: number;
    maxDelayMs: number;
    onRetry?: (attempt: number, error: Error) => void;
  },
): Promise<T> {
  let failuresSoFar = 0;

  const backoff = createBackoff({
    minDelay: options.baseDelayMs,
    maxDelay: options.maxDelayMs,
    maxFailureCount: options.maxAttempts,
    onError: (e: unknown, failuresCount: number) => {
      failuresSoFar = failuresCount;
      const error =
        e instanceof Error
          ? e
          : new Error(formatErrorForUi(e, { maxChars: 10_000 }), { cause: e });

      const attempt = failuresCount;
      logger.debug('[AcpBackend] Retrying ACP request after failure', {
        ...createAcpRequestFailureLogRecord({ operation: options.operationName, error }),
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts: options.maxAttempts,
      });
      options.onRetry?.(attempt, error);
    },
  });

  try {
    return await backoff(operation);
  } catch (rawError: unknown) {
    // Ensure the final thrown error is an Error instance, matching
    // the original withRetry contract that wraps non-Error values.
    if (rawError instanceof Error) {
      throw rawError;
    }
    throw new Error(formatErrorForUi(rawError, { maxChars: 10_000 }), { cause: rawError });
  }
}
