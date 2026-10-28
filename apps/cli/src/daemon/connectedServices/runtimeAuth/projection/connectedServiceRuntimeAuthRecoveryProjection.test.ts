import { describe, expect, it } from 'vitest';

import {
  buildRuntimeAuthRecoveryScheduledResult,
  buildRuntimeAuthRecoveryTerminalResult,
  normalizeConnectedServiceRuntimeAuthRecoveryProjection,
} from './connectedServiceRuntimeAuthRecoveryProjection';
import type { ConnectedServiceRuntimeFailureClassification } from '../types';

const classification: ConnectedServiceRuntimeFailureClassification = {
  kind: 'auth_expired',
  serviceId: 'openai-codex',
  profileId: 'backup',
  groupId: 'codex-main',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'stable_provider_message',
};

describe('normalizeConnectedServiceRuntimeAuthRecoveryProjection', () => {
  it('distinguishes terminal policy decisions from explicit recovery cancellation', () => {
    for (const reason of ['switch_reason_disabled', 'auto_switch_disabled', 'selection_mismatch']) {
      expect(buildRuntimeAuthRecoveryTerminalResult({
        classification,
        recovery: { status: 'cancelled', terminalReason: reason },
      }).status).toBe('recovery_terminal');
    }
    expect(buildRuntimeAuthRecoveryTerminalResult({
      classification,
      recovery: { status: 'cancelled', terminalReason: 'usage_limit_recovery_cancelled' },
    }).status).toBe('recovery_cancelled');
    expect(buildRuntimeAuthRecoveryTerminalResult({
      classification,
      recovery: { status: 'cancelled', terminalReason: null },
    }).status).toBe('recovery_cancelled');
  });
  it('keeps valid typed runtime-auth transcript events', () => {
    const result = buildRuntimeAuthRecoveryScheduledResult({
      classification,
      recovery: { status: 'scheduled', attemptCount: 2, nextRetryAtMs: 1_900_000_000_000 },
    });

    const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
      report: { ok: true, result },
      statusNote: null,
    });

    expect(projection.handled).toBe(true);
    expect(projection.transcriptEvent).toMatchObject({
      type: 'connected-service-runtime-auth-recovery',
      status: 'retry_scheduled',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'codex-main',
      attempt: 2,
    });
  });

  it('rejects malformed typed runtime-auth transcript events before projecting them', () => {
    const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
      report: {
        ok: true,
        result: {
          status: 'recovery_retry_scheduled',
          transcriptEvent: {
            type: 'connected-service-runtime-auth-recovery',
            status: 'retry_scheduled',
            serviceId: 'openai-codex',
          },
        },
      },
      statusNote: null,
    });

    expect(projection.handled).toBe(false);
    expect(projection.transcriptEvent).toBeUndefined();
  });

  it('projects terminal recovery results as handled terminal output without re-emitting transcript events', () => {
    const result = buildRuntimeAuthRecoveryTerminalResult({
      classification,
      recovery: {
        status: 'exhausted',
        retryable: false,
        attemptCount: 5,
        lastError: 'max_attempts_exhausted',
      },
    });

    const projection = normalizeConnectedServiceRuntimeAuthRecoveryProjection({
      report: { ok: true, result },
      statusNote: null,
    });

    expect(projection.handled).toBe(true);
    expect(projection.terminal).toBe(true);
    expect(projection.uxDiagnostic).toMatchObject({
      code: 'recovery_dead_lettered',
      serviceId: 'openai-codex',
      profileId: 'backup',
      groupId: 'codex-main',
    });
    expect(projection.transcriptEvent).toBeUndefined();
  });
});
