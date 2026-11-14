import {
  CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES,
  SPAWN_SESSION_ERROR_CODES,
  SPAWN_SESSION_ERROR_DETAIL_KINDS,
  type SpawnSessionResult,
} from '@happier-dev/protocol';

import type { ConnectedServicePerSessionSpawnError } from './accountGroups/perSession/resolvePerSessionGroupMemberForSpawn';
import { buildConnectedServiceUxDiagnostic } from './diagnostics/connectedServiceUxDiagnostics';

/** Refusals a later attempt can clear on its own (a member recovers, a launch settles, state re-reads). */
const RETRYABLE_CODES: ReadonlySet<ConnectedServicePerSessionSpawnError['code']> = new Set([
  'no_eligible_member',
  'per_session_launch_unsettled',
  'per_session_target_revalidation_unavailable',
]);

/**
 * A per-session assignment refusal as the daemon's spawn response (spec A.4): the existing
 * `SPAWN_VALIDATION_FAILED` classification, with the exact per-session reason and, when known, the
 * earliest retry time, in both the message and the structured diagnostic.
 */
export function buildPerSessionSpawnErrorResult(
  error: ConnectedServicePerSessionSpawnError,
  agentId: string,
): Extract<SpawnSessionResult, { type: 'error' }> {
  const retryable = RETRYABLE_CODES.has(error.code);
  return {
    type: 'error',
    errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
    errorMessage: `${error.code}${error.retryAtMs === null ? '' : ` (retryAtMs=${error.retryAtMs})`}: ${error.message}`,
    errorDetail: {
      kind: SPAWN_SESSION_ERROR_DETAIL_KINDS.CONNECTED_SERVICE_UX_DIAGNOSTIC,
      uxDiagnostic: buildConnectedServiceUxDiagnostic({
        code: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.noEligibleGroupMember,
        failurePhase: 'materialization',
        source: 'new_session',
        agentId,
        retryable,
        diagnostics: {
          perSessionReason: error.code,
          retryAtMs: error.retryAtMs,
        },
      }),
    },
  };
}
