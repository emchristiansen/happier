export type ExecutionRunTimeoutError = Error & Readonly<{
  executionRunErrorCode: string;
  livenessProbe?: unknown;
}>;

export type ExecutionRunInteractionUnavailableError = Error & Readonly<{
  executionRunErrorCode: 'execution_run_interaction_unavailable';
}>;

export const EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_CODE = 'execution_run_send_outcome_unknown' as const;
export const EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_MESSAGE =
  'The input may have been accepted before the provider request failed';

export type ExecutionRunSendOutcomeUnknownError = Error & Readonly<{
  executionRunErrorCode: typeof EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_CODE;
}>;

export function createExecutionRunSendOutcomeUnknownError(): ExecutionRunSendOutcomeUnknownError {
  const error = new Error(EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_MESSAGE) as ExecutionRunSendOutcomeUnknownError;
  Object.assign(error, {
    executionRunErrorCode: EXECUTION_RUN_SEND_OUTCOME_UNKNOWN_CODE,
  });
  return error;
}

export function createExecutionRunInteractionUnavailableError(): ExecutionRunInteractionUnavailableError {
  const error = new Error(
    'Execution run permission approval is required, but no response route is available',
  ) as ExecutionRunInteractionUnavailableError;
  Object.assign(error, {
    executionRunErrorCode: 'execution_run_interaction_unavailable' as const,
  });
  return error;
}

export function createExecutionRunTimeoutError(params: Readonly<{
  timeoutMs: number;
  errorCode: string;
  livenessProbe: unknown;
}>): ExecutionRunTimeoutError {
  const error = new Error(`Timed out after ${params.timeoutMs}ms`) as ExecutionRunTimeoutError;
  Object.assign(error, {
    executionRunErrorCode: params.errorCode,
    livenessProbe: params.livenessProbe,
  });
  return error;
}

export function readExecutionRunErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { executionRunErrorCode?: unknown }).executionRunErrorCode;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

export function isExecutionRunTimeoutError(error: unknown): error is ExecutionRunTimeoutError {
  return readExecutionRunErrorCode(error) === 'provider_inactivity_timeout';
}
