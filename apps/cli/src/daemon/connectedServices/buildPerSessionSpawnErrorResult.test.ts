import { describe, expect, it } from 'vitest';

import { SPAWN_SESSION_ERROR_CODES, SPAWN_SESSION_ERROR_DETAIL_KINDS, isSpawnSessionErrorDetail } from '@happier-dev/protocol';

import { ConnectedServicePerSessionSpawnError } from './accountGroups/perSession/resolvePerSessionGroupMemberForSpawn';
import { buildPerSessionSpawnErrorResult } from './buildPerSessionSpawnErrorResult';

describe('per-session spawn refusal as the daemon spawn response (HPI-27, spec A.4)', () => {
  it('keeps the validation classification, the exact reason and the known retry time', () => {
    const result = buildPerSessionSpawnErrorResult(
      new ConnectedServicePerSessionSpawnError('no_eligible_member', 'no eligible member for a per-session assignment in claude-subscription/pool', 1_600_000),
      'claude',
    );
    expect(result.errorCode).toBe(SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED);
    expect(result.errorMessage).toContain('no_eligible_member (retryAtMs=1600000)');
    expect(result.errorDetail).toMatchObject({
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
      uxDiagnostic: { retryable: true, diagnostics: { perSessionReason: 'no_eligible_member', retryAtMs: 1_600_000 } },
    });
    // The detail survives the protocol's own wire validation.
    expect(isSpawnSessionErrorDetail(JSON.parse(JSON.stringify(result.errorDetail)))).toBe(true);
  });

  it.each([
    ['initial_profile_disabled', false],
    ['per_session_launch_unsettled', true],
    ['per_session_target_revalidation_unavailable', true],
  ] as const)('maps %s with its own reason', (code, retryable) => {
    const result = buildPerSessionSpawnErrorResult(new ConnectedServicePerSessionSpawnError(code, 'refused'), 'claude');
    expect(result.errorMessage.startsWith(`${code}: `)).toBe(true);
    expect(result.errorDetail).toMatchObject({ uxDiagnostic: { retryable, diagnostics: { perSessionReason: code, retryAtMs: null } } });
  });
});
