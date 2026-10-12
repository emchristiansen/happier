import type {
  ManagedConnectionSupervisor,
  ManagedProbeReportScope,
  ReadinessProbeResult,
} from '@happier-dev/connection-supervisor';

import { readAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { configuration } from '@/configuration';
import type { TranscriptLookupOutcome, TranscriptMessageLookupResult } from '../transcriptMessageLookup';
import {
  createKeyedBackoffTracker,
  createKeyedSingleFlightScheduler,
  type KeyedBackoffTracker,
  type KeyedSingleFlightScheduler,
} from '../../connection/scheduling';

export type TranscriptRecoveryDeferredReason =
  | 'supervisor_auth_failed'
  | 'supervisor_offline'
  | 'backoff';

export type TranscriptRecoveryErrorReason =
  | 'auth_failed'
  | 'unhealthy'
  | 'protocol_error';

export type TranscriptRecoveryResult<T> =
  | { type: 'success'; value: T }
  | { type: 'not_found' }
  | { type: 'deferred'; reason: TranscriptRecoveryDeferredReason }
  | { type: 'error'; reason: TranscriptRecoveryErrorReason; error: unknown };

export interface TranscriptRecoveryCoordinatorOptions {
  delayMs?: number;
  maxConcurrent?: number;
  errorBackoffBaseMs?: number;
  errorBackoffMaxMs?: number;
}

export interface TranscriptRecoveryRequest {
  sessionId: string;
  localId: string;
  supervisor: ManagedConnectionSupervisor;
  runRequest: () => Promise<TranscriptLookupOutcome>;
}

function normalizeDelayMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizePositiveMs(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.trunc(value));
}

function recoveryKey(sessionId: string, localId: string): string {
  return JSON.stringify([sessionId, localId]);
}

function readErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return undefined;
}

export class TranscriptRecoveryCoordinator {
  private static instancesByServerUrl = new Map<string, TranscriptRecoveryCoordinator>();

  private readonly scheduler: KeyedSingleFlightScheduler;
  private readonly backoff: KeyedBackoffTracker;

  private constructor(options: TranscriptRecoveryCoordinatorOptions = {}) {
    this.scheduler = createKeyedSingleFlightScheduler({
      delayMs: normalizeDelayMs(options.delayMs ?? configuration.transcriptRecoveryDelayMs),
      maxConcurrent: options.maxConcurrent ?? configuration.transcriptRecoveryMaxConcurrent,
    });
    const errorBackoffBaseMs = normalizePositiveMs(options.errorBackoffBaseMs ?? configuration.transcriptLookupErrorBackoffBaseMs);
    const errorBackoffMaxMs = Math.max(
      errorBackoffBaseMs,
      normalizePositiveMs(options.errorBackoffMaxMs ?? configuration.transcriptLookupErrorBackoffMaxMs),
    );
    this.backoff = createKeyedBackoffTracker({
      baseDelayMs: errorBackoffBaseMs,
      maxDelayMs: errorBackoffMaxMs,
    });
  }

  public static forServer(serverUrl: string, options?: TranscriptRecoveryCoordinatorOptions): TranscriptRecoveryCoordinator {
    const existing = this.instancesByServerUrl.get(serverUrl);
    if (existing) return existing;
    const instance = new TranscriptRecoveryCoordinator(options);
    this.instancesByServerUrl.set(serverUrl, instance);
    return instance;
  }

  public static __resetForTesting(): void {
    this.instancesByServerUrl.clear();
  }

  public scheduleByLocalId(
    params: TranscriptRecoveryRequest,
  ): Promise<TranscriptRecoveryResult<TranscriptMessageLookupResult>> {
    const key = recoveryKey(params.sessionId, params.localId);
    const supervisorDeferral = this.readSupervisorDeferral(params.supervisor);
    if (supervisorDeferral) return Promise.resolve(supervisorDeferral);
    const backoffDeferral = this.readBackoffDeferral(key);
    if (backoffDeferral) return Promise.resolve(backoffDeferral);

    return this.scheduler.scheduleResult(key, async () => {
      const currentSupervisorDeferral = this.readSupervisorDeferral(params.supervisor);
      if (currentSupervisorDeferral) return currentSupervisorDeferral;
      const currentBackoffDeferral = this.readBackoffDeferral(key);
      if (currentBackoffDeferral) return currentBackoffDeferral;
      const probeReportScope = params.supervisor.captureProbeReportScope?.();

      try {
        return this.mapLookupOutcome(key, params.supervisor, probeReportScope, await params.runRequest());
      } catch (error) {
        return this.mapThrownError(key, params.supervisor, probeReportScope, error);
      }
    });
  }

  private readSupervisorDeferral(supervisor: ManagedConnectionSupervisor): TranscriptRecoveryResult<never> | null {
    const state = supervisor.getState();
    if (state.phase === 'auth_failed') return { type: 'deferred', reason: 'supervisor_auth_failed' };
    if (state.phase !== 'online') return { type: 'deferred', reason: 'supervisor_offline' };
    return null;
  }

  private readBackoffDeferral(key: string): TranscriptRecoveryResult<never> | null {
    return this.backoff.getDelayMs(key) > 0 ? { type: 'deferred', reason: 'backoff' } : null;
  }

  private mapLookupOutcome(
    key: string,
    supervisor: ManagedConnectionSupervisor,
    probeReportScope: ManagedProbeReportScope | undefined,
    outcome: TranscriptLookupOutcome,
  ): TranscriptRecoveryResult<TranscriptMessageLookupResult> {
    switch (outcome.type) {
      case 'found':
        this.clearBackoff(key);
        return { type: 'success', value: outcome.message };
      case 'not_found':
        this.clearBackoff(key);
        return { type: 'not_found' };
      case 'auth_failed':
        this.reportAuthenticationFailure(supervisor, probeReportScope, {
          status: 'auth_failed',
          statusCode: outcome.statusCode,
          errorMessage: readErrorMessage(outcome.error),
        });
        return { type: 'error', reason: 'auth_failed', error: outcome.error };
      case 'unhealthy':
        this.applyBackoff(key);
        return { type: 'error', reason: 'unhealthy', error: outcome.error };
      case 'protocol_error':
        this.applyBackoff(key);
        return { type: 'error', reason: 'protocol_error', error: outcome.error };
    }
  }

  private mapThrownError(
    key: string,
    supervisor: ManagedConnectionSupervisor,
    probeReportScope: ManagedProbeReportScope | undefined,
    error: unknown,
  ): TranscriptRecoveryResult<TranscriptMessageLookupResult> {
    const authStatus = readAuthenticationStatus(error);
    if (authStatus !== null) {
      this.reportAuthenticationFailure(supervisor, probeReportScope, {
        status: 'auth_failed',
        statusCode: authStatus,
        errorMessage: readErrorMessage(error),
      });
      return { type: 'error', reason: 'auth_failed', error };
    }

    const statusCode = readHttpStatus(error);
    if (typeof statusCode === 'number' && statusCode >= 500) {
      this.applyBackoff(key);
      return { type: 'error', reason: 'unhealthy', error };
    }

    this.applyBackoff(key);
    return { type: 'error', reason: 'protocol_error', error };
  }

  private reportAuthenticationFailure(
    supervisor: ManagedConnectionSupervisor,
    probeReportScope: ManagedProbeReportScope | undefined,
    probe: Extract<ReadinessProbeResult, { status: 'auth_failed' }>,
  ): void {
    if (probeReportScope === undefined) {
      supervisor.reportProbeResult?.(probe);
      return;
    }
    supervisor.reportProbeResult?.(probe, probeReportScope);
  }

  private clearBackoff(key: string): void {
    this.backoff.reset(key);
  }

  private applyBackoff(key: string): void {
    this.backoff.recordFailure(key);
  }
}
