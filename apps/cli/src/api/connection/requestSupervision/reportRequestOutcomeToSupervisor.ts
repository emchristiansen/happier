import type { ManagedConnectionSupervisor, ReadinessProbeResult } from '@happier-dev/connection-supervisor';

import { isAuthenticationStatus, readAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { isNetworkError, readNormalizedErrorCode } from '@/api/offline/serverConnectionErrors';

function readErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function toProbeResult(params: Readonly<{
  statusCode: number | null;
  error?: unknown;
  hadAuth: boolean;
  scope: 'connection_health' | 'authentication_only';
}>): Exclude<ReadinessProbeResult, Readonly<{ status: 'ready' }>> | null {
  if (params.hadAuth && isAuthenticationStatus(params.statusCode)) {
    return {
      status: 'auth_failed',
      ...(typeof params.statusCode === 'number' ? { statusCode: params.statusCode } : {}),
      errorMessage: readErrorMessage(params.error, `HTTP ${params.statusCode}`),
    };
  }

  if (params.scope === 'authentication_only') {
    return null;
  }

  if (typeof params.statusCode === 'number' && params.statusCode >= 500) {
    return {
      status: 'retry_later',
      errorMessage: readErrorMessage(params.error, `HTTP ${params.statusCode}`),
    };
  }

  const networkErrorCode = readNormalizedErrorCode(params.error);
  if (networkErrorCode && isNetworkError(networkErrorCode)) {
    return {
      status: 'server_unreachable',
      errorMessage: readErrorMessage(params.error, `Request failed (${networkErrorCode})`),
    };
  }

  return null;
}

export function reportRequestOutcomeToSupervisor(params: Readonly<{
  supervisor: ManagedConnectionSupervisor;
  statusCode?: number | null;
  error?: unknown;
  hadAuth: boolean;
  probeReportScope: ReturnType<NonNullable<ManagedConnectionSupervisor['captureProbeReportScope']>> | undefined;
  outcomeSupervision?: 'connection_health' | 'authentication_only';
}>): void {
  const probe = toProbeResult({
    statusCode: params.statusCode ?? readHttpStatus(params.error),
    error: params.error,
    hadAuth: params.hadAuth,
    scope: params.outcomeSupervision ?? 'connection_health',
  });
  if (!probe) {
    return;
  }
  const scope = params.probeReportScope;
  if (scope === undefined) {
    params.supervisor.reportProbeResult?.(probe);
    return;
  }
  params.supervisor.reportProbeResult?.(probe, scope);
}

export function handleRequestAuthenticationFailure(params: Readonly<{
  supervisor?: ManagedConnectionSupervisor | null;
  error: unknown;
  hadAuth: boolean;
  probeReportScope: ReturnType<NonNullable<ManagedConnectionSupervisor['captureProbeReportScope']>> | undefined;
}>): boolean {
  if (!params.hadAuth || !readAuthenticationStatus(params.error)) {
    return false;
  }

  if (!params.supervisor) {
    throw params.error;
  }

  reportRequestOutcomeToSupervisor({
    supervisor: params.supervisor,
    error: params.error,
    hadAuth: params.hadAuth,
    probeReportScope: params.probeReportScope,
  });
  return true;
}
